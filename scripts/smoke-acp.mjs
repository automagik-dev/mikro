#!/usr/bin/env node
/**
 * Automated ACP smoke test — wish rlmx-acp-adapter, Groups 1 + 2.
 *
 * Spawns `node dist/src/cli.js acp` as a stdio JSON-RPC agent and drives a
 * full lifecycle against it as a minimal ACP client:
 *
 *   initialize → session/new → session/prompt (REAL rlmLoop round-trip)
 *
 * Two modes:
 *
 *   DEFAULT (no flag) — Group 1 gate. Fast + deterministic. A tiny token
 *   budget bounds the single non-recursive prompt to ~1-2 real iterations, and
 *   the single-session invariant (concurrent prompt rejected -32600) is
 *   asserted. Unchanged from Group 1.
 *   Assertions:
 *     1. Every stdout line parses as a JSON-RPC 2.0 message (stdout discipline).
 *     2. initialize returns a numeric protocolVersion + agentCapabilities.
 *     3. session/new returns a sessionId.
 *     4. session/prompt returns { stopReason } and the agent emits at least one
 *        agent_message_chunk session/update with non-empty text.
 *     5. A concurrent second session/prompt is rejected cleanly (-32600).
 *
 *   --recursive — Group 2 integration proof. Drives a REAL recursive prompt
 *   that instructs the model to call rlm_query in the REPL, spawning a child
 *   rlmx run. Asserts the LIVE session/update stream contains the full
 *   translated shape: agent_message_chunk + >=1 tool_call + >=1
 *   tool_call_update AND >=1 Recurse-derived node (toolCallId `rlm:<childId>`)
 *   carrying per-node metrics. The 2B model can flake, so the prompt is
 *   retried once before failing. This mode is SLOW (children take ~20-40s each)
 *   and uses a generous budget + a long REPL timeout; it is NOT part of the
 *   fast default gate.
 *
 * Exits 0 on success; non-zero with a printed reason on any failure.
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

const RECURSIVE = process.argv.includes("--recursive");

// ── mode-specific tuning ──────────────────────────────────────────────────
// DEFAULT: a tiny token budget bounds the LLM leg deterministically — rlmLoop
// runs one real iteration, trips budget.isExceeded(), and forces a genuine
// final answer on a NON-aborted signal in ~10-30s. The timeout is a backstop.
//
// RECURSIVE: the run must complete >=6 iterations AND spawn a child, so the
// tight cap is replaced with a generous token budget; the child leg alone
// takes ~20-40s, so the overall timeout is ~10 min and the spawned agent's env
// carries a long RLMX_REPL_TIMEOUT_MS (inherited by the child process).
const OVERALL_TIMEOUT_MS = RECURSIVE ? 780_000 : 180_000;
const PROMPT_TEXT = RECURSIVE
  ? [
      "Use the REPL to delegate a sub-question to a recursive sub-agent, then report its result. /no_think",
      "",
      "Write exactly this repl block:",
      "```repl",
      'n = rlm_query("What is 17 times 23? Reply with only the number. /no_think")',
      "print(n)",
      "```",
      "After the REPL prints the result, finish with FINAL(n).",
    ].join("\n")
  : "What is 2+2? Answer in one short sentence.";
// DEFAULT keeps the fast station 2B + a tight cap that forces a deterministic
// one-iteration answer. RECURSIVE needs a model that reliably emits a ```repl
// block calling rlm_query (the 2B writes ```python and stalls at ~12 tok/s);
// the 35B-A3B MTP model (3B active → fast decode, strong tool/reasoning) does
// so consistently. Budget is generous so the loop + child spawn run to a real
// FINAL rather than being cut early.
// The child rlm_query inherits the PARENT's REMAINING token budget (rlm.ts
// buildRemainingChildBudget), so the parent budget is also the child's bound.
// Too large (e.g. 200k) lets the 35B child overthink 17*23 past the REPL cap;
// ~20k gives the parent room for its handful of delegate→FINAL iterations while
// bounding the child to ~1 iteration (~200s observed). Documented tradeoff.
const MODEL_ID = RECURSIVE ? "Qwen3.6-35B-A3B-MTP-GGUF" : "qwen3.5-2b-FLM";
const BUDGET_YAML = RECURSIVE
  ? "budget:\n  max-tokens: 13000\n"
  : "budget:\n  max-tokens: 100\n";

function fail(reason, extra) {
  process.stderr.write(`\nSMOKE FAIL: ${reason}\n`);
  if (extra !== undefined) process.stderr.write(`${typeof extra === "string" ? extra : JSON.stringify(extra, null, 2)}\n`);
  process.exit(1);
}

function log(msg) {
  process.stderr.write(`# smoke-acp${RECURSIVE ? " [recursive]" : ""}: ${msg}\n`);
}

// ── scratch project with a station-provider config ───────────────────────
const projectDir = mkdtempSync(join(tmpdir(), "rlmx-acp-smoke-"));
mkdirSync(join(projectDir, ".rlmx"), { recursive: true });
writeFileSync(
  join(projectDir, ".rlmx", "rlmx.yaml"),
  `model:\n  provider: station\n  model: ${MODEL_ID}\n${BUDGET_YAML}`,
);
log(`scratch project: ${projectDir}`);

// ── spawn the agent ──────────────────────────────────────────────────────
// RECURSIVE: give the agent (and thus every child it spawns, via buildChildEnv
// which spreads process.env) a long REPL timeout so a ~20-40s child is not cut.
const childEnv = { ...process.env };
if (RECURSIVE) {
  // The REPL cell that runs rlm_query must outlast the child's reasoning; the
  // child's token budget (above) bounds it, this cap is only a safety net.
  childEnv.RLMX_REPL_TIMEOUT_MS = "600000";
  // Lift the rlmLoop 300s wall-clock cap for this turn: a compliant delegation
  // (parent iterations + a child that itself reasons for tens-to-hundreds of
  // seconds) can exceed 300s. The ACP agent honors this override and passes it
  // through to the spawned child's --timeout too.
  childEnv.RLMX_ACP_RUN_TIMEOUT_MS = "660000";
}
const child = spawn(process.execPath, [cliPath, "acp"], {
  cwd: projectDir,
  stdio: ["pipe", "pipe", "inherit"], // stderr passes through for visibility
  env: childEnv,
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
    // (session/update). Record them.
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

/** Collect the translated update objects recorded since `fromIdx`. */
function updatesSince(fromIdx) {
  return notifications
    .slice(fromIdx)
    .filter((n) => n.method === "session/update" && n.params?.update)
    .map((n) => n.params.update);
}

// ── DEFAULT MODE: concurrent-invariant + single answer chunk ──────────────
async function runDefault(sessionId) {
  // Fire BOTH prompts back-to-back without awaiting the first, so the second
  // arrives while the first is in flight. The agent must serialize.
  log("→ session/prompt (#1, real) + concurrent session/prompt (#2)");
  const promptParams = { sessionId, prompt: [{ type: "text", text: PROMPT_TEXT }] };
  const firstPromise = send("session/prompt", promptParams);
  await new Promise((r) => setTimeout(r, 250));
  const secondPromise = send("session/prompt", promptParams);

  const [firstMsg, secondMsg] = await Promise.all([firstPromise, secondPromise]);
  const outcomes = [firstMsg, secondMsg].map((m) => ("error" in m ? "error" : "result"));
  const successes = [firstMsg, secondMsg].filter((m) => "result" in m);
  const rejections = [firstMsg, secondMsg].filter((m) => "error" in m);

  if (successes.length !== 1 || rejections.length !== 1) {
    fail(`single-session invariant: expected exactly 1 success + 1 rejection, got ${JSON.stringify(outcomes)}`, { firstMsg, secondMsg });
  }
  const okResult = successes[0].result;
  if (typeof okResult.stopReason !== "string") fail("session/prompt: successful response missing stopReason", okResult);
  log(`✓ session/prompt succeeded stopReason=${okResult.stopReason}`);

  const rejection = rejections[0].error;
  if (typeof rejection?.code !== "number") fail("concurrent session/prompt: rejection has no numeric error code", rejection);
  if (rejection.code !== -32600) fail(`concurrent session/prompt: expected code -32600 (invalidRequest), got ${rejection.code}`, rejection);
  log(`✓ concurrent session/prompt rejected cleanly: code=${rejection.code}`);

  const chunks = updatesSince(0).filter((u) => u.sessionUpdate === "agent_message_chunk");
  if (chunks.length === 0) fail("no agent_message_chunk session/update received", notifications);
  const answerText = chunks.map((c) => c.content?.text ?? "").join("");
  if (answerText.trim().length === 0) fail("agent_message_chunk had empty text", chunks);
  log(`✓ real answer chunk received (${answerText.length} chars): ${JSON.stringify(answerText.slice(0, 120))}`);
}

// ── RECURSIVE MODE: full translated stream incl. Recurse node + metrics ───
async function runRecursiveAttempt(sessionId) {
  const startIdx = notifications.length;
  log("→ session/prompt (recursive; child spawn expected, may take minutes)");
  const promptMsg = await send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: PROMPT_TEXT }],
  });
  if ("error" in promptMsg) return { ok: false, reason: `prompt errored: ${JSON.stringify(promptMsg.error)}` };
  const okResult = promptMsg.result;
  if (typeof okResult.stopReason !== "string") return { ok: false, reason: "missing stopReason" };

  const updates = updatesSince(startIdx);
  const byType = (t) => updates.filter((u) => u.sessionUpdate === t);
  const messageChunks = byType("agent_message_chunk").filter((u) => (u.content?.text ?? "").trim().length > 0);
  const toolCalls = byType("tool_call");
  const toolCallUpdates = byType("tool_call_update");
  const recurseNodes = toolCalls.filter((u) => typeof u.toolCallId === "string" && u.toolCallId.startsWith("rlm:"));
  const recurseCompletions = toolCallUpdates.filter(
    (u) => typeof u.toolCallId === "string" && u.toolCallId.startsWith("rlm:") && u._meta && u._meta["rlmx/node"],
  );

  const summary = {
    stopReason: okResult.stopReason,
    agent_message_chunk: messageChunks.length,
    tool_call: toolCalls.length,
    tool_call_update: toolCallUpdates.length,
    recurse_nodes: recurseNodes.length,
    recurse_completions_with_metrics: recurseCompletions.length,
  };

  if (messageChunks.length === 0) return { ok: false, reason: "no non-empty agent_message_chunk", summary };
  if (toolCalls.length === 0) return { ok: false, reason: "no tool_call updates", summary };
  if (toolCallUpdates.length === 0) return { ok: false, reason: "no tool_call_update updates", summary };
  if (recurseNodes.length === 0) return { ok: false, reason: "no Recurse-derived tool_call node (model did not delegate)", summary };
  if (recurseCompletions.length === 0) return { ok: false, reason: "no Recurse node carried per-node metrics", summary };

  // Validate the metric fields are actually populated on at least one node.
  const node = recurseCompletions[0];
  const nodeMeta = node._meta["rlmx/node"];
  if (nodeMeta.correlationId === undefined) return { ok: false, reason: "recurse node metrics missing correlationId", summary };
  if (nodeMeta.tokens === undefined && nodeMeta.costUsd === undefined) {
    return { ok: false, reason: "recurse node metrics missing tokens AND costUsd", summary };
  }

  return {
    ok: true,
    summary,
    evidence: {
      updateSequence: updates.map((u) => u.sessionUpdate),
      recurseNode: { toolCallId: recurseNodes[0].toolCallId, title: recurseNodes[0].title, kind: recurseNodes[0].kind },
      recurseCompletion: { toolCallId: node.toolCallId, status: node.status, metrics: nodeMeta },
      answerPreview: messageChunks.map((c) => c.content.text).join("").slice(0, 200),
    },
  };
}

async function runRecursive() {
  for (let attempt = 1; attempt <= 2; attempt++) {
    log(`recursive attempt ${attempt}/2`);
    const newMsg = await send("session/new", { cwd: projectDir, mcpServers: [] });
    const created = expectResult(newMsg, "session/new");
    const res = await runRecursiveAttempt(created.sessionId);
    if (res.ok) {
      process.stderr.write("\n=== RECURSIVE SMOKE EVIDENCE ===\n");
      process.stderr.write(`update sequence: ${JSON.stringify(res.evidence.updateSequence)}\n`);
      process.stderr.write(`recurse node:    ${JSON.stringify(res.evidence.recurseNode)}\n`);
      process.stderr.write(`recurse metrics: ${JSON.stringify(res.evidence.recurseCompletion)}\n`);
      process.stderr.write(`answer preview:  ${JSON.stringify(res.evidence.answerPreview)}\n`);
      process.stderr.write(`counts:          ${JSON.stringify(res.summary)}\n`);
      return;
    }
    log(`attempt ${attempt} did not satisfy assertions: ${res.reason} ${res.summary ? JSON.stringify(res.summary) : ""}`);
    if (attempt === 2) fail(`recursive assertions failed after 2 attempts: ${res.reason}`, res.summary);
  }
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
  if (typeof init.protocolVersion !== "number") fail("initialize: protocolVersion missing/not a number", init);
  if (!init.agentCapabilities || typeof init.agentCapabilities !== "object") fail("initialize: agentCapabilities missing", init);
  log(`✓ initialize protocolVersion=${init.protocolVersion} caps=${JSON.stringify(init.agentCapabilities)}`);

  if (RECURSIVE) {
    await runRecursive();
  } else {
    // 2. session/new
    log("→ session/new");
    const newMsg = await send("session/new", { cwd: projectDir, mcpServers: [] });
    const created = expectResult(newMsg, "session/new");
    if (typeof created.sessionId !== "string" || created.sessionId.length === 0) fail("session/new: sessionId missing", created);
    log(`✓ session/new sessionId=${created.sessionId}`);
    await runDefault(created.sessionId);
  }

  finished = true;
  clearTimeout(overallTimer);
  child.stdin.end();
  child.kill("SIGTERM");

  process.stderr.write(
    RECURSIVE
      ? "\nSMOKE PASS: recursive run streamed agent_message_chunk + tool_call/tool_call_update + Recurse node with metrics.\n"
      : "\nSMOKE PASS: handshake + real prompt round-trip + single-session invariant all verified.\n",
  );
  process.exit(0);
} catch (err) {
  fail(`unexpected error: ${err?.stack ?? err}`);
}
