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
import { llmComplete } from "../llm.js";
import { isStructuredOutputMode } from "../rlm.js";
// ─── Mode resolution ─────────────────────────────────────
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
export function resolveLoopMode(config, env = process.env) {
    const override = env.RLMX_ACP_LOOP;
    if (override === "direct" || override === "full")
        return override;
    return config.loop;
}
// ─── Env knobs ───────────────────────────────────────────
/**
 * The `agent.ts` run-timeout guard, extracted verbatim so both ACP knobs share
 * one semantics: a FINITE, POSITIVE number is honored as-is (no clamping);
 * anything else — unset, non-numeric, NaN, Infinity, zero, negative — falls
 * back. `Number(undefined)` is NaN and `Number("")` is 0, so both miss the
 * guard and take the fallback.
 */
export function resolveEnvPositive(raw, fallback) {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}
/** Key the discriminant is published under in the JSON-RPC error `data`. */
export const ACP_FAILURE_DATA_KEY = "rlmx";
/**
 * Build the structured JSON-RPC error for a failed prompt turn.
 *
 * -32603 (internal error) is the honest code: the request itself was valid, the
 * agent could not fulfil it. The discriminant lives in `data.rlmx.kind`; the
 * message stays human-readable and is never fed back to a model.
 */
export function acpFailure(data, message) {
    return RequestError.internalError({ [ACP_FAILURE_DATA_KEY]: data }, message);
}
/** Read the structured discriminant back off a thrown error (tests, clients). */
export function acpFailureData(err) {
    if (!(err instanceof RequestError))
        return null;
    const data = err.data;
    const payload = data?.[ACP_FAILURE_DATA_KEY];
    return payload && typeof payload.kind === "string" ? payload : null;
}
/**
 * Map a full-loop `RLMFailure` onto the ACP error surface.
 *
 * The loop's own prose (`result.answer`) is DELIBERATELY not relayed: that
 * prose was reaching ACP clients as the assistant's reply and being persisted
 * into consumer session stores as if the model had written it.
 */
export function loopFailureError(failure, timeoutMs) {
    if (failure.kind === "empty_responses") {
        return acpFailure({ kind: "loop_empty_responses", mode: "full" }, "rlmx loop aborted after 3 consecutive empty LLM responses; no answer was produced");
    }
    return acpFailure({ kind: "loop_timeout", mode: "full", timeoutMs }, `rlmx loop exceeded its ${timeoutMs}ms budget; no answer was produced`);
}
/**
 * Invariant backstop: the loop reported success with nothing to say. Kept
 * separate from the two traced loop failures so a client is never told a run
 * timed out when it did not.
 */
export function loopEmptyAnswerError() {
    return acpFailure({ kind: "loop_empty_answer", mode: "full" }, "rlmx loop completed without producing an answer");
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
export async function runDirectCompletion(options) {
    const complete = options.complete ?? llmComplete;
    const messages = [];
    // The project's system prompt VERBATIM. Direct mode exists precisely because
    // the loop's scaffold additions (custom-tools section, criteria, storage
    // instructions) describe a REPL protocol that direct mode does not run.
    const system = options.config.system ?? "";
    if (system.trim().length > 0)
        messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: options.query });
    const deadline = new AbortController();
    let deadlineFired = false;
    const timer = setTimeout(() => {
        deadlineFired = true;
        deadline.abort();
    }, options.timeoutMs);
    const forwardCancel = () => deadline.abort();
    options.turnSignal.addEventListener("abort", forwardCancel, { once: true });
    let text;
    try {
        const response = await complete(messages, options.config.model, {
            signal: deadline.signal,
        });
        text = response.text ?? "";
    }
    catch (err) {
        // Cancel outranks the deadline: a cancelled turn is not a failure.
        if (options.turnSignal.aborted)
            throw err;
        if (deadlineFired)
            throw directTimeoutError(options.timeoutMs);
        throw err;
    }
    finally {
        clearTimeout(timer);
        options.turnSignal.removeEventListener("abort", forwardCancel);
    }
    if (options.turnSignal.aborted)
        return text;
    // ORDER MATTERS. A pre-aborted signal makes the provider RETURN empty text
    // rather than throw — the same shape as the loop defect this wish fixed, where
    // `rlmLoop` handed its already-aborted `AbortController` to `forceFinalAnswer`
    // and got an empty string back instead of an `AbortError`. So an empty answer
    // under a fired deadline is a TIMEOUT, not an empty completion.
    if (deadlineFired)
        throw directTimeoutError(options.timeoutMs);
    if (text.trim().length === 0) {
        throw acpFailure({ kind: "direct_empty", mode: "direct" }, "direct-mode completion returned no text; no answer was produced");
    }
    return text;
}
/** The direct-mode deadline failure (built in two places; kept identical). */
function directTimeoutError(timeoutMs) {
    return acpFailure({ kind: "direct_timeout", mode: "direct", timeoutMs }, `direct-mode completion exceeded its ${timeoutMs}ms deadline; no answer was produced`);
}
// ─── Diagnostic: the silently-dropped FINAL protocol ──────
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
export function missingFinalProtocolWarning(config) {
    if (isStructuredOutputMode(config))
        return null;
    const system = config.system ?? "";
    if (system.trim().length === 0)
        return null;
    if (system.includes("FINAL(") || system.includes("FINAL_VAR("))
        return null;
    return ("rlmx acp: this project's SYSTEM.md replaces rlmx's protocol scaffold and " +
        "mentions neither FINAL() nor FINAL_VAR(). The loop has no way to terminate " +
        "early and will run to its iteration or time budget. Add the FINAL protocol " +
        "to SYSTEM.md, or set `loop: direct` in .rlmx/rlmx.yaml for a one-shot answer.\n");
}
//# sourceMappingURL=modes.js.map