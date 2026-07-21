#!/usr/bin/env node
/**
 * Automated ACP smoke test — wish rlmx-acp-adapter, Group 1.
 *
 * Spawns `node dist/src/cli.js acp` as a stdio JSON-RPC agent and drives a
 * full lifecycle against it as a minimal ACP client:
 *
 *   initialize → session/new → session/prompt (REAL rlmLoop round-trip)
 *
 * Assertions (all structural, not content-exact — the local LLM leg is slow
 * and its wording is non-deterministic):
 *   1. Every line the agent writes to stdout parses as a JSON-RPC 2.0 message
 *      (the classic stdio-agent stdout-discipline bug: stray logging on stdout
 *      corrupts the protocol). This is the load-bearing check.
 *   2. initialize returns a numeric protocolVersion + agentCapabilities.
 *   3. session/new returns a sessionId.
 *   4. session/prompt returns { stopReason } and the agent emits at least one
 *      agent_message_chunk session/update with non-empty text (the real answer).
 *   5. SINGLE-SESSION INVARIANT: a second session/prompt fired while the first
 *      is in flight is rejected cleanly with a JSON-RPC error (code -32600).
 *
 * Exits 0 on success; non-zero with a printed reason on any failure.
 *
 * Runs entirely against the local station/Lemonade provider — no cloud keys.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const cliPath = join(repoRoot, "dist", "src", "cli.js");

// The real-prompt leg drives rlmLoop against the local qwen3.5-2b station
// model. Left unbounded, that model ignores the "one short sentence" hint and
// flails to rlmLoop's default 30-iteration budget; on the verified environment
// a run non-deterministically takes ~125-200s OR overruns rlmLoop's 300s
// wall-clock timeout — and the wall-clock path forces the final answer on an
// already-aborted signal, so the answer chunk comes back EMPTY. Neither a real
// round-trip nor a stable gate.
//
// Fix (test-harness only, adapter untouched): the scratch rlmx.yaml below sets
// a tiny token budget, so rlmLoop exits via budget.isExceeded() (rlm.ts:538)
// after the FIRST real iteration and forces a genuine final answer on a
// NON-aborted signal — a real ~1-2 iteration round-trip through the instrumented
// loop that lands a non-empty answer in ~10-30s, deterministically. The timeout
// below is a generous backstop, not the mechanism that bounds the run.
const OVERALL_TIMEOUT_MS = 180_000; // generous backstop; the leg now lands in ~10-30s
const PROMPT_TEXT = "What is 2+2? Answer in one short sentence.";

function fail(reason, extra) {
  process.stderr.write(`\nSMOKE FAIL: ${reason}\n`);
  if (extra !== undefined) process.stderr.write(`${typeof extra === "string" ? extra : JSON.stringify(extra, null, 2)}\n`);
  process.exit(1);
}

function log(msg) {
  process.stderr.write(`# smoke-acp: ${msg}\n`);
}

// ── scratch project with a station-provider config ───────────────────────
const projectDir = mkdtempSync(join(tmpdir(), "rlmx-acp-smoke-"));
mkdirSync(join(projectDir, ".rlmx"), { recursive: true });
writeFileSync(
  join(projectDir, ".rlmx", "rlmx.yaml"),
  // A tiny token budget bounds the LLM leg deterministically: rlmLoop runs one
  // real iteration, trips budget.isExceeded(), and forces a genuine final answer
  // (non-aborted signal) instead of flailing to its 30-iteration / 300s caps.
  // Keeps the round-trip REAL while making the gate fast and non-flaky.
  "model:\n  provider: station\n  model: qwen3.5-2b-FLM\nbudget:\n  max-tokens: 100\n",
);
log(`scratch project: ${projectDir}`);

// ── spawn the agent ──────────────────────────────────────────────────────
const child = spawn(process.execPath, [cliPath, "acp"], {
  cwd: projectDir,
  stdio: ["pipe", "pipe", "inherit"], // stderr passes through for visibility
  env: { ...process.env },
});

const overallTimer = setTimeout(() => {
  fail(`overall timeout after ${OVERALL_TIMEOUT_MS}ms`);
}, OVERALL_TIMEOUT_MS);
overallTimer.unref?.();

child.on("error", (err) => fail(`failed to spawn agent: ${err.message}`));
child.on("exit", (code, signal) => {
  if (!finished) fail(`agent exited early (code=${code}, signal=${signal})`);
});

// ── JSON-RPC ndjson client plumbing ──────────────────────────────────────
let nextId = 1;
const pending = new Map(); // id -> { resolve, reject }
const notifications = []; // collected session/update etc.
let stdoutBuf = "";
let finished = false;

/** Every non-empty stdout line MUST be a JSON-RPC 2.0 message. */
function onStdoutLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    fail("stdout line is not valid JSON (stdout-discipline violation)", trimmed);
    return;
  }
  if (msg.jsonrpc !== "2.0") {
    fail("stdout line is not a JSON-RPC 2.0 message (stdout-discipline violation)", msg);
    return;
  }
  if (msg.id !== undefined && msg.id !== null && (("result" in msg) || ("error" in msg))) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      p.resolve(msg);
    }
    return;
  }
  if (typeof msg.method === "string") {
    // Request or notification FROM the agent. We only expect notifications
    // (session/update) in Group 1. If it's a request (has id), answer nothing
    // needed for this smoke — record it.
    notifications.push(msg);
  }
}

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk;
  let idx;
  while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
    const line = stdoutBuf.slice(0, idx);
    stdoutBuf = stdoutBuf.slice(idx + 1);
    onStdoutLine(line);
  }
});

function send(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: "2.0", id, method, params };
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return new Promise((resolveP, rejectP) => {
    pending.set(id, { resolve: resolveP, reject: rejectP });
  });
}

function expectResult(msg, what) {
  if ("error" in msg) fail(`${what} returned an error`, msg.error);
  if (!("result" in msg)) fail(`${what} returned no result`, msg);
  return msg.result;
}

// ── drive the lifecycle ──────────────────────────────────────────────────
try {
  // 1. initialize
  log("→ initialize");
  const initMsg = await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "smoke-acp", version: "0.0.0" },
  });
  const init = expectResult(initMsg, "initialize");
  if (typeof init.protocolVersion !== "number") {
    fail("initialize: protocolVersion missing/not a number", init);
  }
  if (!init.agentCapabilities || typeof init.agentCapabilities !== "object") {
    fail("initialize: agentCapabilities missing", init);
  }
  log(`✓ initialize protocolVersion=${init.protocolVersion} caps=${JSON.stringify(init.agentCapabilities)}`);

  // 2. session/new
  log("→ session/new");
  const newMsg = await send("session/new", {
    cwd: projectDir,
    mcpServers: [],
  });
  const created = expectResult(newMsg, "session/new");
  if (typeof created.sessionId !== "string" || created.sessionId.length === 0) {
    fail("session/new: sessionId missing", created);
  }
  const sessionId = created.sessionId;
  log(`✓ session/new sessionId=${sessionId}`);

  // 3 + 5. session/prompt (real) AND a concurrent second prompt.
  // Fire BOTH back-to-back without awaiting the first, so the second arrives
  // while the first is in flight. The agent must serialize: one runs, the
  // other is rejected with a clean JSON-RPC error.
  log("→ session/prompt (#1, real) + concurrent session/prompt (#2)");
  const promptParams = {
    sessionId,
    prompt: [{ type: "text", text: PROMPT_TEXT }],
  };
  const firstPromise = send("session/prompt", promptParams);
  // Give the first request a beat to enter the handler (set promptInFlight)
  // before the second lands. Not strictly required (dispatch is concurrent),
  // but removes any read-ordering flake.
  await new Promise((r) => setTimeout(r, 250));
  const secondPromise = send("session/prompt", promptParams);

  const [firstMsg, secondMsg] = await Promise.all([firstPromise, secondPromise]);

  // Exactly one must succeed and one must be a clean rejection.
  const outcomes = [firstMsg, secondMsg].map((m) => ("error" in m ? "error" : "result"));
  const successes = [firstMsg, secondMsg].filter((m) => "result" in m);
  const rejections = [firstMsg, secondMsg].filter((m) => "error" in m);

  if (successes.length !== 1 || rejections.length !== 1) {
    fail(
      `single-session invariant: expected exactly 1 success + 1 rejection, got ${JSON.stringify(outcomes)}`,
      { firstMsg, secondMsg },
    );
  }

  const okResult = successes[0].result;
  if (typeof okResult.stopReason !== "string") {
    fail("session/prompt: successful response missing stopReason", okResult);
  }
  log(`✓ session/prompt succeeded stopReason=${okResult.stopReason}`);

  const rejection = rejections[0].error;
  if (typeof rejection?.code !== "number") {
    fail("concurrent session/prompt: rejection has no numeric error code", rejection);
  }
  if (rejection.code !== -32600) {
    fail(`concurrent session/prompt: expected code -32600 (invalidRequest), got ${rejection.code}`, rejection);
  }
  log(`✓ concurrent session/prompt rejected cleanly: code=${rejection.code} message=${JSON.stringify(rejection.message)}`);

  // 4. the real answer arrived as an agent_message_chunk notification.
  const chunks = notifications.filter(
    (n) => n.method === "session/update" && n.params?.update?.sessionUpdate === "agent_message_chunk",
  );
  if (chunks.length === 0) {
    fail("no agent_message_chunk session/update received", notifications);
  }
  const answerText = chunks
    .map((c) => c.params.update.content?.text ?? "")
    .join("");
  if (answerText.trim().length === 0) {
    fail("agent_message_chunk had empty text", chunks);
  }
  log(`✓ real answer chunk received (${answerText.length} chars): ${JSON.stringify(answerText.slice(0, 120))}`);

  finished = true;
  clearTimeout(overallTimer);
  child.stdin.end();
  child.kill("SIGTERM");

  process.stderr.write("\nSMOKE PASS: handshake + real prompt round-trip + single-session invariant all verified.\n");
  process.exit(0);
} catch (err) {
  fail(`unexpected error: ${err?.stack ?? err}`);
}
