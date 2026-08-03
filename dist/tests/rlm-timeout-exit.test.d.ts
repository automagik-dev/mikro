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
export {};
//# sourceMappingURL=rlm-timeout-exit.test.d.ts.map