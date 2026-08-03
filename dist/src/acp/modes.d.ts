/**
 * Prompt-turn modes, knobs, and the per-mode failure taxonomy — wish
 * acp-station-viability, Group 2.
 *
 * `rlmx acp` answered every prompt turn by driving the full RLM loop. The
 * acp-station-viability trace (`.genie/wishes/acp-station-viability/
 * trace-report.md`) showed that this is the wrong engine for a small local
 * model: the model produced the correct answer on iteration 0 in 9.7 s, the
 * loop could not recognize it (the project's own SYSTEM.md had silently
 * replaced the FINAL()/FINAL_VAR() protocol), and the turn burned its whole
 * 300 s budget and returned EMPTY — reported as success.
 *
 * This module carries the three pieces that fix that, all additive:
 *
 *   1. MODE RESOLUTION — `loop: direct` in `.rlmx/rlmx.yaml`, overridable per
 *      process by RLMX_ACP_LOOP. Absent → `full`: byte-identical behavior.
 *   2. DIRECT MODE — `runDirectCompletion`: ONE chat completion (the project's
 *      `system` as-is + the caller's already-built query), under a deadline
 *      this module owns. No REPL, no scaffold, no iteration.
 *   3. THE FAILURE TAXONOMY — four `RequestError`s, one per way a turn can end
 *      without an answer. A prompt turn must never resolve `end_turn` with an
 *      empty answer, and must never relay a loop's error prose to the client as
 *      if the model had written it.
 *
 * ── ERROR SURFACE ────────────────────────────────────────────────────────────
 * ACP conveys a failed prompt turn as the JSON-RPC error result for
 * `session/prompt` (the agent throws; the SDK serializes `RequestError`). All
 * four failures use code -32603 with a machine-readable discriminant under
 * `data.rlmx.kind`, so a client can branch on the KIND instead of matching the
 * human message — the property the trace found missing.
 *
 * ── WHAT THIS MODULE DOES NOT DO ─────────────────────────────────────────────
 * A structured error does not RECOVER a discarded answer. Rescuing the
 * iteration-0 answer is protocol work (trace-report defect #3, `FINAL_VAR(x)`
 * unquoted) and is out of this wish's scope. Here, a failed turn is reported
 * honestly as a failure and nothing else.
 */
import { RequestError } from "@agentclientprotocol/sdk";
import type { LoopMode, RlmxConfig } from "../config.js";
import { llmComplete } from "../llm.js";
import type { RLMFailure } from "../output.js";
/**
 * Resolve the engine for a prompt turn: RLMX_ACP_LOOP wins over the project's
 * `loop:` key, which wins over the `full` default.
 *
 * An UNRECOGNIZED env value is ignored (falls through to the config) rather
 * than throwing: the env knob is an operator's per-process override, and a typo
 * in a shell export must not brick every session of a running agent. A bad
 * value in `rlmx.yaml` — the reviewed, committed surface — does throw, in
 * `parseYamlConfig`.
 */
export declare function resolveLoopMode(config: RlmxConfig, env?: NodeJS.ProcessEnv): LoopMode;
/**
 * The `agent.ts` run-timeout guard, extracted verbatim so both ACP knobs share
 * one semantics: a FINITE, POSITIVE number is honored as-is (no clamping);
 * anything else — unset, non-numeric, NaN, Infinity, zero, negative — falls
 * back. `Number(undefined)` is NaN and `Number("")` is 0, so both miss the
 * guard and take the fallback.
 */
export declare function resolveEnvPositive(raw: string | undefined, fallback: number): number;
/**
 * The four ways a prompt turn ends without an answer. Named after the mode that
 * produced them so a client (and a log reader) can tell which engine failed.
 *
 *   loop_timeout         — full mode: the loop's inner wall-clock cap expired.
 *   loop_empty_responses — full mode: aborted after 3 consecutive empty LLM
 *                          responses (rlm.ts's EmptyResponses abort).
 *   direct_timeout       — direct mode: the single completion did not settle
 *                          inside this turn's deadline.
 *   direct_empty         — direct mode: the completion settled but carried no
 *                          non-whitespace text.
 *
 * Plus one INVARIANT BACKSTOP, not a traced failure mode:
 *
 *   loop_empty_answer    — full mode: the loop reported success yet handed back
 *                          nothing to say. No known exit does this now that the
 *                          timeout path is honest, but the invariant a prompt
 *                          turn must never resolve `end_turn` empty is enforced
 *                          here rather than assumed.
 */
export type AcpFailureKind = "loop_timeout" | "loop_empty_responses" | "loop_empty_answer" | "direct_timeout" | "direct_empty";
/** Key the discriminant is published under in the JSON-RPC error `data`. */
export declare const ACP_FAILURE_DATA_KEY: "rlmx";
/** Shape published under `data.rlmx` on every failed prompt turn. */
export interface AcpFailureData {
    readonly kind: AcpFailureKind;
    readonly mode: LoopMode;
    /** Whichever budget bounded this turn, when the failure was a deadline. */
    readonly timeoutMs?: number;
}
/**
 * Build the structured JSON-RPC error for a failed prompt turn.
 *
 * -32603 (internal error) is the honest code: the request itself was valid, the
 * agent could not fulfil it. The discriminant lives in `data.rlmx.kind`; the
 * message stays human-readable and is never fed back to a model.
 */
export declare function acpFailure(data: AcpFailureData, message: string): RequestError;
/** Read the structured discriminant back off a thrown error (tests, clients). */
export declare function acpFailureData(err: unknown): AcpFailureData | null;
/**
 * Map a full-loop `RLMFailure` onto the ACP error surface.
 *
 * The loop's own prose (`result.answer`) is DELIBERATELY not relayed: that
 * prose was reaching ACP clients as the assistant's reply and being persisted
 * into consumer session stores as if the model had written it.
 */
export declare function loopFailureError(failure: RLMFailure, timeoutMs: number): RequestError;
/**
 * Invariant backstop: the loop reported success with nothing to say. Kept
 * separate from the two traced loop failures so a client is never told a run
 * timed out when it did not.
 */
export declare function loopEmptyAnswerError(): RequestError;
/** The single provider call direct mode makes. Injectable for hermetic tests. */
export type LlmCompleteFn = typeof llmComplete;
/** Everything `runDirectCompletion` needs; no ACP or Tauri types cross here. */
export interface DirectRunOptions {
    readonly config: RlmxConfig;
    /**
     * The query as the caller already built it — for a resumed ACP session this
     * is the bounded PREAMBLE_TURNS transcript plus the new request. Direct mode
     * adds NOTHING to it: no safeguard preamble, no REPL nudge, no protocol
     * scaffold. What the project wrote is what the model sees.
     */
    readonly query: string;
    /** Wall-clock budget for the completion, in ms. Owned here, not by the loop. */
    readonly timeoutMs: number;
    /** The ACP turn's cancel signal (`session/cancel` / disconnect). */
    readonly turnSignal: AbortSignal;
    /** Provider seam; defaults to the real `llmComplete`. */
    readonly complete?: LlmCompleteFn;
}
/**
 * Run direct mode: one completion, whole answer, own deadline.
 *
 * ── DEADLINE OWNERSHIP ───────────────────────────────────────────────────────
 * `llmComplete` takes a signal and owns NO timer, so without this controller a
 * stalled gateway hangs the turn forever (a 2.5 h hang is on the record). The
 * deadline controller is separate from the turn's cancel signal and forwards
 * from it, so a `session/cancel` still aborts the in-flight request.
 *
 * ── RETURN CONTRACT ──────────────────────────────────────────────────────────
 * Resolves with the completion text. Throws a structured `direct_timeout` /
 * `direct_empty` failure when the turn ended without an answer, and rethrows a
 * genuine provider fault unchanged (the caller's backstop reports it). When the
 * TURN was cancelled it resolves with whatever text existed — the caller
 * discards it and reports `cancelled`, which is the ACP contract for a cancel,
 * not a failure.
 */
export declare function runDirectCompletion(options: DirectRunOptions): Promise<string>;
/**
 * Full-loop diagnostic for trace-report defect #2.
 *
 * `buildSystemPrompt` is `config.system ?? ""` — rlmx ships NO built-in
 * protocol text. A project that writes its own `.rlmx/SYSTEM.md` therefore
 * replaces the entire FINAL()/FINAL_VAR() scaffold, and the loop then runs a
 * model that was never told how to terminate: it cannot finish early, and it
 * burns the whole budget. That is exactly what the traced station run did, with
 * no warning anywhere.
 *
 * Returns the warning text when the predicate holds, else `null`. PURE — the
 * caller owns the fire-once state and the write. Diagnostic only: nothing about
 * the run changes.
 *
 * Predicate (all three): NOT structured-output mode (those terminate on a
 * schema, not on FINAL()) AND `system` is non-empty (an empty system prompt is
 * a different problem, and the scaffold-less default is not this defect) AND
 * `system` mentions neither `FINAL(` nor `FINAL_VAR(`. Note `FINAL_VAR(` does
 * NOT contain the substring `FINAL(`, so both probes are required.
 */
export declare function missingFinalProtocolWarning(config: RlmxConfig): string | null;
//# sourceMappingURL=modes.d.ts.map