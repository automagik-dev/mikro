/**
 * The REAL `rlmLoop` wall-clock timeout exit — wish acp-station-viability,
 * Group 3 (review-carried item).
 *
 * Everything else in this wish asserts the timeout CONTRACT against a fake
 * loop: `tests/acp-direct-mode.test.ts` hands the ACP adapter a canned
 * `RLMResult` carrying `failure: { kind: "timeout" }` and checks it becomes a
 * structured ACP error. That proves the adapter, and proves nothing at all
 * about `src/rlm.ts` — the file the trace report found lying.
 *
 * The defect (trace report §2.5, `.genie/wishes/acp-station-viability/
 * trace-report.md`): on the wall-clock timeout the loop broke out with its
 * shared `AbortController` ALREADY aborted and then called `forceFinalAnswer`
 * with that dead signal. pi/ai short-circuits an already-aborted request by
 * RETURNING empty text rather than throwing, so the catch that would have
 * produced "Error: RLM query timed out" never ran, and the run reported SUCCESS
 * with `answer: ""`. A timed-out run was indistinguishable from a successful
 * silent one.
 *
 * These two tests drive the real `rlmLoop` — real REPL, real timer, real exit
 * paths — over the two orderings a timeout can take, and pin BOTH halves of the
 * fix: the historical prose in `answer`, and the structural `failure.kind`.
 *
 * Hermetic: no gateway, no API key, no network egress. The station provider is
 * keyless and reads `STATION_BASE_URL` at import time, so the env is redirected
 * at a loopback server owned by this file BEFORE `src/rlm.ts` is imported (hence
 * the dynamic imports). The server accepts the completion request and never
 * answers it — the "provider that outlives the deadline". `node --test` runs
 * each test file in its own process, so the redirect never escapes this file.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// TYPE-only imports: they erase at compile time, so nothing here loads the
// station provider before the env redirect below.
import type { RlmxConfig } from "../src/config.js";
import type { RLMResult } from "../src/output.js";
import type { rlmLoop as RlmLoopFn } from "../src/rlm.js";

/** The prose `rlmLoop` has always reported on a timeout; part of the contract. */
const TIMEOUT_ANSWER = "Error: RLM query timed out";

/** A station baseline model id — resolves offline, from the static catalog. */
const MODEL = "qwen3.6-moe-35b-a3b-FLM";

let server: Server;
let dir: string;
let rlmLoop: typeof RlmLoopFn;
let baseConfig: RlmxConfig;
/** Sockets the fake gateway is deliberately holding open, so `after` can free them. */
const held: ServerResponse[] = [];
/** Set when the fake gateway actually received a chat completion request. */
let completionRequests = 0;
const prevBaseUrl = process.env.STATION_BASE_URL;
const prevLegacyBaseUrl = process.env.LEMONADE_BASE_URL;

before(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if ((req.url ?? "").endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    // The completion the loop is waiting on: accepted, never answered. Only the
    // loop's own abort can end it — which is exactly the situation the timeout
    // exit exists for.
    completionRequests++;
    req.resume();
    held.push(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  // MUST precede the first import of the station provider (via llm.ts via rlm.ts).
  process.env.STATION_BASE_URL = `http://127.0.0.1:${port}/api/v1`;
  delete process.env.LEMONADE_BASE_URL;

  ({ rlmLoop } = await import("../src/rlm.js"));
  const { loadConfig } = await import("../src/config.js");

  dir = await mkdtemp(join(tmpdir(), "rlmx-timeout-exit-"));
  // Defaults from a directory with no `.rlmx/`: no storage, no cache, no tools.
  const defaults = await loadConfig(dir);
  baseConfig = {
    ...defaults,
    model: { provider: "station", model: MODEL },
    system: "Answer in one line.",
  };
});

after(async () => {
  for (const res of held) res.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
  if (prevBaseUrl === undefined) delete process.env.STATION_BASE_URL;
  else process.env.STATION_BASE_URL = prevBaseUrl;
  if (prevLegacyBaseUrl !== undefined) process.env.LEMONADE_BASE_URL = prevLegacyBaseUrl;
});

/** Both halves of the contract, asserted the same way for both orderings. */
function assertHonestTimeout(result: RLMResult, label: string): void {
  assert.equal(
    result.answer,
    TIMEOUT_ANSWER,
    `${label}: the historical prose must survive for the CLI and the benchmark classifier`,
  );
  assert.ok(result.failure, `${label}: a timed-out run must NOT report success (this is the defect)`);
  assert.equal(result.failure?.kind, "timeout", `${label}: the structural exit reason`);
  assert.equal(
    result.failure?.message,
    TIMEOUT_ANSWER,
    `${label}: failure.message mirrors the prose in answer`,
  );
  assert.equal(result.model, `station/${MODEL}`, `${label}: the result is still a real result`);
}

describe("rlmLoop — the wall-clock timeout exit is honest", () => {
  it("times out against a provider that outlives the deadline", async () => {
    // The deadline fires while the loop is INSIDE `llmComplete`, on a real
    // request to a real socket. Observed shape: pi/ai does NOT raise on the
    // abort — it RESOLVES with empty text (the loop logs its "LLM returned
    // empty response" warning), so control returns to the top of the iteration
    // loop, which breaks on the aborted signal. That is the precise defect
    // shape: an aborted request that returns instead of throwing is why the old
    // code reported success with `answer: ""`. Either exit — this one or the
    // outer AbortError catch — must land on the same honest result.
    const before = completionRequests;
    const result = await rlmLoop("who are you?", null, baseConfig, {
      timeout: 1_500,
      maxIterations: 30,
      output: "json",
    });
    assert.ok(
      completionRequests > before,
      "the fake gateway must actually have been called — otherwise this asserts nothing about the in-flight path",
    );
    assertHonestTimeout(result, "in-flight");
  });

  it("times out when the deadline beats the first iteration", async () => {
    // The other ordering: the budget is already spent by the time the iteration
    // loop makes its first check, so the loop breaks at the top with no LLM call
    // at all. Pre-fix this was the path that called `forceFinalAnswer` with a
    // dead signal and returned `answer: ""` while reporting success.
    const before = completionRequests;
    const result = await rlmLoop("who are you?", null, baseConfig, {
      timeout: 1,
      maxIterations: 30,
      output: "json",
    });
    assert.equal(
      completionRequests,
      before,
      "no completion should be attempted once the budget is already spent",
    );
    assert.equal(result.iterations, 0, "the loop never ran an iteration");
    assertHonestTimeout(result, "pre-spent");
  });
});
