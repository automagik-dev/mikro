#!/usr/bin/env node
/**
 * Live-proof driver for wish acp-station-viability, Group 3 (C2 + C2b).
 *
 * Minimal ACP stdio client. Drives the PATCHED cli.js as an agent against a
 * direct-mode project config, on the station arm, under the BARE 300s default
 * deadline (every RLMX_ACP_* tuning knob is deleted from the child env before
 * spawn, and asserted absent).
 *
 * Emits one JSON blob on stdout with per-sample latency, verbatim answers,
 * session ids and pre/post gateway liveness records.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const CLI = process.env.PROOF_CLI;
const PROJECT = process.env.PROOF_PROJECT;
const STORE = process.env.PROOF_STORE;
const OUT = process.env.PROOF_OUT;
const SPACING_MS = Number(process.env.PROOF_SPACING_MS ?? 20000);
const GATEWAY = "http://localhost:13305/api/v1/models";
/** Client-side guard: the agent's own bare deadline is 300s; allow slack. */
const PROMPT_GUARD_MS = 320_000;

/** Every knob that could weaken the "bare 300s default" claim. */
const STRIPPED = [
  "RLMX_ACP_LOOP",
  "RLMX_ACP_RUN_TIMEOUT_MS",
  "RLMX_ACP_MAX_ITERATIONS",
  "RLMX_REPL_TIMEOUT_MS",
  "RLMX_MCP_RUN_TIMEOUT_MS",
  "RLMX_BENCH_DIRECT_TIMEOUT_MS",
  "STATION_BASE_URL",
  "LEMONADE_BASE_URL",
];

function bareEnv() {
  const env = { ...process.env };
  for (const k of STRIPPED) delete env[k];
  // Not a tuning knob: keeps the durable store out of the live campaign's
  // ~/.rlmx. Irrelevant to the deadline.
  env.RLMX_ACP_SESSIONS_DIR = STORE;
  return env;
}

async function liveness(label) {
  const t = new Date().toISOString();
  const started = Date.now();
  try {
    const res = await fetch(GATEWAY, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json();
    const ids = (body?.data ?? []).map((m) => m.id);
    return {
      label,
      at: t,
      status: res.status,
      ms: Date.now() - started,
      modelCount: ids.length,
      hasTargetModel: ids.includes("qwen3.6-moe-35b-a3b-FLM"),
      alive: res.status === 200 && ids.includes("qwen3.6-moe-35b-a3b-FLM"),
    };
  } catch (err) {
    return { label, at: t, status: null, ms: Date.now() - started, error: String(err), alive: false };
  }
}

function startAgent() {
  const child = spawn(process.execPath, [CLI, "acp"], {
    cwd: PROJECT,
    stdio: ["pipe", "pipe", "pipe"],
    env: bareEnv(),
  });
  const h = {
    child,
    nextId: 1,
    pending: new Map(),
    notifications: [],
    stderr: "",
    buf: "",
    exited: null,
  };
  h.exited = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => {
    h.stderr += c;
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    h.buf += chunk;
    let i;
    while ((i = h.buf.indexOf("\n")) !== -1) {
      const line = h.buf.slice(0, i).trim();
      h.buf = h.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        h.notifications.push({ __unparsed: line });
        continue;
      }
      if (msg.id !== undefined && msg.id !== null && ("result" in msg || "error" in msg)) {
        const p = h.pending.get(msg.id);
        if (p) {
          h.pending.delete(msg.id);
          p(msg);
        }
        continue;
      }
      if (typeof msg.method === "string") h.notifications.push(msg);
    }
  });
  h.send = (method, params) => {
    const id = h.nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ id, __clientTimeout: true, method }),
        PROMPT_GUARD_MS,
      );
      h.pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  };
  h.chunksFor = (fromIdx, sessionId) =>
    h.notifications
      .slice(fromIdx)
      .filter((n) => n.method === "session/update" && n.params?.sessionId === sessionId)
      .map((n) => n.params.update)
      .filter((u) => u?.sessionUpdate === "agent_message_chunk")
      .map((u) => ({ messageId: u.messageId, text: u.content?.text ?? "" }));
  return h;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSample(agent, { id, kind, sessionId, prompt }) {
  const pre = await liveness("pre");
  const fromIdx = agent.notifications.length;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const msg = await agent.send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: prompt }],
  });
  const latencyMs = Date.now() - t0;
  const post = await liveness("post");
  const chunks = agent.chunksFor(fromIdx, sessionId);
  const answer = chunks
    .filter((c) => c.messageId === `answer:${sessionId}`)
    .map((c) => c.text)
    .join("");
  return {
    id,
    kind,
    sessionId,
    prompt,
    startedAt,
    latencyMs,
    latencyS: +(latencyMs / 1000).toFixed(2),
    stopReason: msg?.result?.stopReason ?? null,
    error: msg?.error ?? (msg?.__clientTimeout ? { clientTimeout: PROMPT_GUARD_MS } : null),
    chunkCount: chunks.length,
    chunkMessageIds: [...new Set(chunks.map((c) => c.messageId))],
    answer,
    answerNonEmpty: answer.trim().length > 0,
    liveness: { pre, post },
    voided: !(pre.alive && post.alive),
  };
}

const report = {
  startedAt: new Date().toISOString(),
  cli: CLI,
  project: PROJECT,
  strippedEnv: STRIPPED,
  strippedEnvVerified: Object.fromEntries(STRIPPED.map((k) => [k, bareEnv()[k] ?? null])),
  spacingMs: SPACING_MS,
  samples: [],
  c2b: null,
  agentStderr: "",
};

const agent = startAgent();
const init = await agent.send("initialize", {
  protocolVersion: 1,
  clientCapabilities: {},
  clientInfo: { name: "acp-g3-live-proof", version: "1.0.0" },
});
report.initialize = init.result ?? init;

const C2_PROMPTS = [
  "In one short sentence: what is the capital of France?",
  "In one short sentence: what does the Unix command `df -h` report?",
  "In one short sentence: what does the acronym HTTP stand for?",
];

// ── C2: n>=3 one-line prompts, each on its own fresh session ─────────────
for (let i = 0; i < C2_PROMPTS.length; i++) {
  if (i > 0) await sleep(SPACING_MS);
  const ns = await agent.send("session/new", { cwd: PROJECT, mcpServers: [] });
  const sessionId = ns.result?.sessionId;
  if (!sessionId) {
    report.samples.push({ id: `C2-${i + 1}`, fatal: "session/new failed", raw: ns });
    continue;
  }
  const s = await runSample(agent, {
    id: `C2-${i + 1}`,
    kind: "C2",
    sessionId,
    prompt: C2_PROMPTS[i],
  });
  report.samples.push(s);
  process.stderr.write(
    `# ${s.id} ${s.latencyS}s stop=${s.stopReason} nonEmpty=${s.answerNonEmpty} voided=${s.voided}\n`,
  );
  writeFileSync(OUT, JSON.stringify(report, null, 2));
}

// ── C2b: one two-turn exchange on ONE session ────────────────────────────
await sleep(SPACING_MS);
const nsB = await agent.send("session/new", { cwd: PROJECT, mcpServers: [] });
const sidB = nsB.result?.sessionId;
const turn1 = await runSample(agent, {
  id: "C2b-turn1",
  kind: "C2b",
  sessionId: sidB,
  prompt: "Remember this for later: my project codeword is TANGERINE-91. Reply with just: ok.",
});
process.stderr.write(`# C2b-turn1 ${turn1.latencyS}s stop=${turn1.stopReason}\n`);
await sleep(SPACING_MS);
const turn2 = await runSample(agent, {
  id: "C2b-turn2",
  kind: "C2b",
  sessionId: sidB,
  prompt: "What is my project codeword? Reply with only the codeword.",
});
process.stderr.write(`# C2b-turn2 ${turn2.latencyS}s stop=${turn2.stopReason}\n`);
report.c2b = {
  sessionId: sidB,
  turn1,
  turn2,
  referencesTurn1: /TANGERINE-?91/i.test(turn2.answer),
};

agent.child.stdin.end();
await Promise.race([agent.exited, sleep(5000)]);
try {
  agent.child.kill();
} catch {}
report.agentStderr = agent.stderr;
report.finishedAt = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(report, null, 2));
process.stdout.write(`WROTE ${OUT}\n`);
