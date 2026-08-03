/**
 * ACP direct mode, per-mode failure surfaces, and the turn knobs — wish
 * acp-station-viability, Group 2.
 *
 * Hermetic: every prompt turn below runs the REAL `RlmxAcpAgent.prompt` against
 * injected collaborators (`AgentDeps`) — a fake provider, a fake loop, a fake
 * config loader, a captured env and a recording session-update sink. Nothing
 * here touches a network, a REPL, a real `process.env` knob, or the user's home
 * (`RLMX_ACP_SESSIONS_DIR` points at a temp dir for the whole file).
 *
 * Proves the wish's hermetic criteria:
 *   C3  the `loop:` key absent → the rlmLoop path, with the loop's OWN defaults.
 *   C4  all four traced failure surfaces → structured ACP errors; none resolves
 *       `end_turn`; none appends a turn to the durable store.
 *   C5  RLMX_ACP_MAX_ITERATIONS honored, including the guard's negatives.
 *   +   the direct happy path: one completion, whole answer, preamble carried,
 *       turn appended; and the one-time missing-FINAL-protocol diagnostic.
 *
 * A structured error does NOT recover a discarded answer — see the trace
 * report's clarifying note. These tests assert honest reporting, nothing more.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import { RlmxAcpAgent } from "../src/acp/agent.js";
import { acpFailureData, missingFinalProtocolWarning, resolveEnvPositive, resolveLoopMode, } from "../src/acp/modes.js";
import { SessionStore } from "../src/acp/session-store.js";
import { loadConfig } from "../src/config.js";
import { createUsage } from "../src/llm.js";
import { DEFAULT_OPTIONS as RLM_DEFAULTS } from "../src/rlm.js";
// ─── Harness ─────────────────────────────────────────────
let scratch;
const prevSessionsDir = process.env.RLMX_ACP_SESSIONS_DIR;
before(() => {
    scratch = mkdtempSync(join(tmpdir(), "rlmx-acp-direct-"));
    process.env.RLMX_ACP_SESSIONS_DIR = scratch;
});
after(() => {
    if (prevSessionsDir === undefined)
        delete process.env.RLMX_ACP_SESSIONS_DIR;
    else
        process.env.RLMX_ACP_SESSIONS_DIR = prevSessionsDir;
    rmSync(scratch, { recursive: true, force: true });
});
/** Records everything the agent would have pushed to a client. */
class RecordingSink {
    updates = [];
    async sessionUpdate(params) {
        this.updates.push(params);
    }
    /** The turn's answer chunks (the shared `answer:<sessionId>` messageId). */
    answerChunks(sessionId) {
        const out = [];
        for (const n of this.updates) {
            const u = n.update;
            if (u.sessionUpdate !== "agent_message_chunk")
                continue;
            if (u.messageId !== `answer:${sessionId}`)
                continue;
            const content = u.content;
            if (content?.type === "text")
                out.push(content.text ?? "");
        }
        return out;
    }
}
/** A config built from rlmx's real defaults, then overridden per test. */
async function makeConfig(overrides = {}) {
    // A directory with no .rlmx/ — loadConfig returns the pure default config,
    // which is also the proof that the default for the new key is "full".
    const base = await loadConfig(join(scratch, "no-config-here"));
    return { ...base, ...overrides };
}
function makeResult(answer, failure) {
    return {
        answer,
        references: [],
        usage: createUsage(),
        iterations: 1,
        model: "fake/fake",
        budgetHit: null,
        ...(failure ? { failure } : {}),
    };
}
function spyLoop(result) {
    const spy = {
        calls: 0,
        lastOptions: undefined,
        lastQuery: undefined,
        fn: async (query, _context, _config, options) => {
            spy.calls++;
            spy.lastQuery = query;
            spy.lastOptions = options;
            // The real loop closes the emitter when the run finishes; the drain loop
            // in prompt() waits on exactly that.
            options?.emitter?.close();
            return result;
        },
    };
    return spy;
}
function spyComplete(text) {
    const spy = {
        calls: 0,
        lastMessages: undefined,
        fn: async (messages) => {
            spy.calls++;
            spy.lastMessages = messages.map((m) => ({ role: m.role, content: m.content }));
            return { text, usage: createUsage() };
        },
    };
    return spy;
}
/** Spin up an agent + session against injected deps. */
async function newAgentSession(deps) {
    const sink = new RecordingSink();
    const agent = new RlmxAcpAgent(sink, deps);
    const { sessionId } = await agent.newSession({ cwd: "/abs/project", mcpServers: [] });
    return { agent, sink, sessionId };
}
/** Turns currently persisted for a session (the store bar's observable). */
async function storedTurns(sessionId) {
    const record = await new SessionStore().load(sessionId);
    return record ? record.turns.map((t) => ({ query: t.query, answer: t.answer })) : [];
}
const ask = (text) => ({ type: "text", text });
// ─── The knob guard (C5 semantics, in isolation) ─────────
describe("acp knobs — the shared positive-number guard", () => {
    it("honors a finite positive value as-is, with no clamping", () => {
        assert.equal(resolveEnvPositive("7", 30), 7);
        assert.equal(resolveEnvPositive("1", 30), 1);
        assert.equal(resolveEnvPositive("100000", 30), 100000);
        assert.equal(resolveEnvPositive("7.5", 30), 7.5);
    });
    it("falls back on unset, non-numeric, non-finite, zero and negative", () => {
        assert.equal(resolveEnvPositive(undefined, 30), 30);
        assert.equal(resolveEnvPositive("", 30), 30);
        assert.equal(resolveEnvPositive("abc", 30), 30);
        assert.equal(resolveEnvPositive("NaN", 30), 30);
        assert.equal(resolveEnvPositive("Infinity", 30), 30);
        assert.equal(resolveEnvPositive("-Infinity", 30), 30);
        assert.equal(resolveEnvPositive("0", 30), 30);
        assert.equal(resolveEnvPositive("-1", 30), 30);
    });
});
// ─── The config key ──────────────────────────────────────
describe("loop mode — the `loop:` config key", () => {
    it("defaults to full when no rlmx.yaml exists", async () => {
        const config = await loadConfig(join(scratch, "absent"));
        assert.equal(config.loop, "full");
    });
    it("parses `loop: direct` and still tolerates unknown keys", async () => {
        const dir = join(scratch, "proj-direct");
        mkdirSync(join(dir, ".rlmx"), { recursive: true });
        writeFileSync(join(dir, ".rlmx", "rlmx.yaml"), "model:\n  provider: station\n  model: qwen\nloop: direct\nnot-a-real-key: 42\n");
        const config = await loadConfig(dir);
        assert.equal(config.loop, "direct");
        assert.equal(config.model.provider, "station");
    });
    it("rejects an unknown loop VALUE (a reviewed, committed surface)", async () => {
        const dir = join(scratch, "proj-bogus");
        mkdirSync(join(dir, ".rlmx"), { recursive: true });
        writeFileSync(join(dir, ".rlmx", "rlmx.yaml"), "loop: sideways\n");
        await assert.rejects(() => loadConfig(dir), /Invalid loop "sideways"/);
    });
    it("resolves env over config, and ignores an unrecognized env value", async () => {
        const full = await makeConfig({ loop: "full" });
        const direct = await makeConfig({ loop: "direct" });
        assert.equal(resolveLoopMode(full, {}), "full");
        assert.equal(resolveLoopMode(direct, {}), "direct");
        assert.equal(resolveLoopMode(full, { RLMX_ACP_LOOP: "direct" }), "direct");
        assert.equal(resolveLoopMode(direct, { RLMX_ACP_LOOP: "full" }), "full");
        // A typo in a shell export must not brick a running agent.
        assert.equal(resolveLoopMode(direct, { RLMX_ACP_LOOP: "dircet" }), "direct");
        assert.equal(resolveLoopMode(full, { RLMX_ACP_LOOP: "" }), "full");
    });
});
// ─── C3: the key absent → the loop path, unchanged ───────
describe("C3 — loop mode is the default and its defaults are untouched", () => {
    it("drives rlmLoop, never the direct provider, with the loop's own defaults", async () => {
        const loop = spyLoop(makeResult("loop answer"));
        const complete = spyComplete("direct answer");
        const config = await makeConfig(); // no `loop:` key at all
        const { agent, sink, sessionId } = await newAgentSession({
            loadConfig: async () => config,
            rlmLoop: loop.fn,
            complete: complete.fn,
            env: {},
        });
        const res = await agent.prompt({ sessionId, prompt: [ask("hello")] });
        assert.equal(res.stopReason, "end_turn");
        assert.equal(loop.calls, 1, "the loop must run");
        assert.equal(complete.calls, 0, "direct mode must not run");
        assert.equal(loop.lastOptions?.timeout, RLM_DEFAULTS.timeout, "an unset RLMX_ACP_RUN_TIMEOUT_MS must reproduce the loop's own timeout");
        assert.equal(loop.lastOptions?.maxIterations, RLM_DEFAULTS.maxIterations, "an unset RLMX_ACP_MAX_ITERATIONS must reproduce the loop's own cap");
        assert.equal(loop.lastOptions?.output, "json");
        assert.deepEqual(sink.answerChunks(sessionId), ["loop answer"]);
        assert.deepEqual(await storedTurns(sessionId), [
            { query: "hello", answer: "loop answer" },
        ]);
    });
    it("honors RLMX_ACP_RUN_TIMEOUT_MS with the same guard as the iteration knob", async () => {
        const loop = spyLoop(makeResult("ok"));
        const config = await makeConfig();
        const deps = { loadConfig: async () => config, rlmLoop: loop.fn };
        const honored = await newAgentSession({ ...deps, env: { RLMX_ACP_RUN_TIMEOUT_MS: "600000" } });
        await honored.agent.prompt({ sessionId: honored.sessionId, prompt: [ask("q")] });
        assert.equal(loop.lastOptions?.timeout, 600_000);
        const rejected = await newAgentSession({ ...deps, env: { RLMX_ACP_RUN_TIMEOUT_MS: "-1" } });
        await rejected.agent.prompt({ sessionId: rejected.sessionId, prompt: [ask("q")] });
        assert.equal(loop.lastOptions?.timeout, RLM_DEFAULTS.timeout);
    });
});
// ─── C5: the iteration knob ──────────────────────────────
describe("C5 — RLMX_ACP_MAX_ITERATIONS", () => {
    it("is plumbed into rlmLoop when finite and positive", async () => {
        const loop = spyLoop(makeResult("ok"));
        const config = await makeConfig();
        const { agent, sessionId } = await newAgentSession({
            loadConfig: async () => config,
            rlmLoop: loop.fn,
            env: { RLMX_ACP_MAX_ITERATIONS: "7" },
        });
        await agent.prompt({ sessionId, prompt: [ask("q")] });
        assert.equal(loop.lastOptions?.maxIterations, 7);
    });
    it("falls back to 30 on every rejected value (guard negatives)", async () => {
        const config = await makeConfig();
        for (const bad of ["0", "-1", "abc", "", "Infinity", "NaN"]) {
            const loop = spyLoop(makeResult("ok"));
            const { agent, sessionId } = await newAgentSession({
                loadConfig: async () => config,
                rlmLoop: loop.fn,
                env: { RLMX_ACP_MAX_ITERATIONS: bad },
            });
            await agent.prompt({ sessionId, prompt: [ask("q")] });
            assert.equal(loop.lastOptions?.maxIterations, 30, `RLMX_ACP_MAX_ITERATIONS=${JSON.stringify(bad)} must fall back to 30`);
            assert.equal(RLM_DEFAULTS.maxIterations, 30, "the documented default is the loop's own");
        }
    });
    it("is a loop-mode knob only — direct mode never reads it", async () => {
        const loop = spyLoop(makeResult("unused"));
        const complete = spyComplete("direct answer");
        const config = await makeConfig({ loop: "direct" });
        const { agent, sessionId } = await newAgentSession({
            loadConfig: async () => config,
            rlmLoop: loop.fn,
            complete: complete.fn,
            env: { RLMX_ACP_MAX_ITERATIONS: "3" },
        });
        const res = await agent.prompt({ sessionId, prompt: [ask("q")] });
        assert.equal(res.stopReason, "end_turn");
        assert.equal(loop.calls, 0);
        assert.equal(complete.calls, 1);
    });
});
// ─── Direct mode, happy path ─────────────────────────────
describe("direct mode — one completion, whole answer", () => {
    it("sends config.system verbatim + the query, and returns the answer whole", async () => {
        const loop = spyLoop(makeResult("never"));
        const complete = spyComplete("[INFO] arm check ok.");
        const config = await makeConfig({ loop: "direct", system: "You are MERI. Be terse." });
        const { agent, sink, sessionId } = await newAgentSession({
            loadConfig: async () => config,
            rlmLoop: loop.fn,
            complete: complete.fn,
            env: {},
        });
        const res = await agent.prompt({ sessionId, prompt: [ask("is the arm ok?")] });
        assert.equal(res.stopReason, "end_turn");
        assert.equal(loop.calls, 0, "direct mode must not drive the loop");
        assert.equal(complete.calls, 1, "direct mode is exactly ONE completion");
        assert.deepEqual(complete.lastMessages, [
            { role: "system", content: "You are MERI. Be terse." },
            { role: "user", content: "is the arm ok?" },
        ]);
        // Whole answer, one chunk — the existing agent_message_chunk contract.
        assert.deepEqual(sink.answerChunks(sessionId), ["[INFO] arm check ok."]);
        assert.deepEqual(await storedTurns(sessionId), [
            { query: "is the arm ok?", answer: "[INFO] arm check ok." },
        ]);
    });
    it("omits the system message when the project has no SYSTEM.md", async () => {
        const complete = spyComplete("bare");
        const config = await makeConfig({ loop: "direct", system: null });
        const { agent, sessionId } = await newAgentSession({
            loadConfig: async () => config,
            complete: complete.fn,
            env: {},
        });
        await agent.prompt({ sessionId, prompt: [ask("q")] });
        assert.deepEqual(complete.lastMessages, [{ role: "user", content: "q" }]);
    });
    it("carries the bounded multi-turn preamble into the completion", async () => {
        const complete = spyComplete("BANANA47");
        const config = await makeConfig({ loop: "direct", system: "sys" });
        const { agent, sessionId } = await newAgentSession({
            loadConfig: async () => config,
            complete: complete.fn,
            env: {},
        });
        await agent.prompt({ sessionId, prompt: [ask("the codeword is BANANA47")] });
        await agent.prompt({ sessionId, prompt: [ask("what was the codeword?")] });
        const user = complete.lastMessages?.find((m) => m.role === "user")?.content ?? "";
        assert.match(user, /continuing conversation/i, "turn 2 must carry a preamble");
        assert.match(user, /BANANA47/, "turn 1 must be replayed into turn 2's context");
        assert.match(user, /what was the codeword\?/);
        assert.equal((await storedTurns(sessionId)).length, 2);
    });
    it("takes the direct branch from RLMX_ACP_LOOP even when the config says full", async () => {
        const loop = spyLoop(makeResult("loop"));
        const complete = spyComplete("direct");
        const config = await makeConfig({ loop: "full" });
        const { agent, sessionId } = await newAgentSession({
            loadConfig: async () => config,
            rlmLoop: loop.fn,
            complete: complete.fn,
            env: { RLMX_ACP_LOOP: "direct" },
        });
        await agent.prompt({ sessionId, prompt: [ask("q")] });
        assert.equal(loop.calls, 0);
        assert.equal(complete.calls, 1);
    });
});
// ─── C4: the four failure surfaces ───────────────────────
/**
 * Every failure assertion shares one bar: the turn REJECTS with a structured
 * `RequestError` carrying the expected discriminant, it never resolves
 * `end_turn`, no answer chunk reaches the client, and the durable store is
 * byte-for-byte what it was before the turn.
 */
async function assertStructuredFailure(kind, run) {
    const { agent, sink, sessionId } = await run();
    const before = await storedTurns(sessionId);
    let settled = "DID-NOT-THROW";
    try {
        settled = await agent.prompt({ sessionId, prompt: [ask("q")] });
        assert.fail(`expected a structured ${kind} failure, got ${JSON.stringify(settled)}`);
    }
    catch (err) {
        if (err instanceof assert.AssertionError)
            throw err;
        assert.ok(err instanceof RequestError, `${kind}: must be an ACP RequestError`);
        assert.equal(err.code, -32603, `${kind}: JSON-RPC internal-error code`);
        const data = acpFailureData(err);
        assert.equal(data?.kind, kind, `${kind}: client-distinguishable discriminant`);
        // What the client actually receives on the wire carries the discriminant.
        const wire = err.toErrorResponse();
        assert.equal(wire.code, -32603, `${kind}: wire error code`);
        assert.ok(JSON.stringify(wire.data).includes(kind), `${kind}: discriminant on the wire`);
    }
    assert.deepEqual(sink.answerChunks(sessionId), [], `${kind}: a failed turn must not stream an answer`);
    assert.deepEqual(await storedTurns(sessionId), before, `${kind}: a failed turn must not be appended to the store`);
}
describe("C4 — the four failure surfaces are structured ACP errors", () => {
    it("loop inner-cap expiry → loop_timeout", async () => {
        const config = await makeConfig();
        await assertStructuredFailure("loop_timeout", () => newAgentSession({
            loadConfig: async () => config,
            // The shape rlm.ts now returns on the timeout exit: prose in `answer`
            // AND the structural reason. The prose must never reach the client.
            rlmLoop: spyLoop(makeResult("Error: RLM query timed out", {
                kind: "timeout",
                message: "Error: RLM query timed out",
            })).fn,
            env: {},
        }));
    });
    it("EmptyResponses abort → loop_empty_responses", async () => {
        const config = await makeConfig();
        await assertStructuredFailure("loop_empty_responses", () => newAgentSession({
            loadConfig: async () => config,
            rlmLoop: spyLoop(makeResult("Error: aborted after 3 consecutive empty LLM responses. Context may exceed API token limits.", {
                kind: "empty_responses",
                message: "Error: aborted after 3 consecutive empty LLM responses.",
            })).fn,
            env: {},
        }));
    });
    it("direct deadline against a stalled provider → direct_timeout", async () => {
        const config = await makeConfig({ loop: "direct" });
        // Never settles on its own; only the deadline's abort ends it.
        const stalled = (_messages, _model, options) => new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        });
        await assertStructuredFailure("direct_timeout", () => newAgentSession({
            loadConfig: async () => config,
            complete: stalled,
            env: { RLMX_ACP_RUN_TIMEOUT_MS: "25" },
        }));
    });
    it("a provider that RETURNS empty on a fired deadline is still direct_timeout", async () => {
        // The `rlmLoop`/`forceFinalAnswer` shape: an already-aborted request resolves
        // with "" instead of throwing. That is a timeout, not an empty completion —
        // order matters.
        const config = await makeConfig({ loop: "direct" });
        const returnsEmptyOnAbort = (_messages, _model, options) => new Promise((resolve) => {
            options?.signal?.addEventListener("abort", () => resolve({ text: "", usage: createUsage() }), { once: true });
        });
        await assertStructuredFailure("direct_timeout", () => newAgentSession({
            loadConfig: async () => config,
            complete: returnsEmptyOnAbort,
            env: { RLMX_ACP_RUN_TIMEOUT_MS: "25" },
        }));
    });
    it("direct whitespace-only completion → direct_empty", async () => {
        const config = await makeConfig({ loop: "direct" });
        await assertStructuredFailure("direct_empty", () => newAgentSession({
            loadConfig: async () => config,
            complete: spyComplete("   \n\t  ").fn,
            env: {},
        }));
    });
    it("direct empty completion → direct_empty", async () => {
        const config = await makeConfig({ loop: "direct" });
        await assertStructuredFailure("direct_empty", () => newAgentSession({
            loadConfig: async () => config,
            complete: spyComplete("").fn,
            env: {},
        }));
    });
    it("invariant backstop: a loop that succeeds with nothing to say → loop_empty_answer", async () => {
        const config = await makeConfig();
        await assertStructuredFailure("loop_empty_answer", () => newAgentSession({
            loadConfig: async () => config,
            rlmLoop: spyLoop(makeResult("")).fn,
            env: {},
        }));
    });
    it("a failed turn leaves the NEXT turn's preamble clean", async () => {
        const config = await makeConfig({ loop: "direct" });
        const empty = spyComplete("");
        const good = spyComplete("second answer");
        let complete = empty.fn;
        const { agent, sessionId } = await newAgentSession({
            loadConfig: async () => config,
            complete: (m, mc, o) => complete(m, mc, o),
            env: {},
        });
        await assert.rejects(() => agent.prompt({ sessionId, prompt: [ask("first")] }));
        complete = good.fn;
        await agent.prompt({ sessionId, prompt: [ask("second")] });
        const user = good.lastMessages?.find((m) => m.role === "user")?.content ?? "";
        assert.equal(user, "second", "the failed turn must not appear in the preamble");
        assert.deepEqual(await storedTurns(sessionId), [
            { query: "second", answer: "second answer" },
        ]);
    });
});
// ─── Cancel outranks failure ─────────────────────────────
/**
 * `session/cancel` is not a failure. A turn that was cancelled must report
 * stopReason "cancelled" — never a structured `RequestError` — even when the
 * cancel is what caused the in-flight completion to end without an answer, and
 * even when a deadline was armed and would have fired on its own.
 *
 * Both shapes a provider can take on abort are covered, because the two land on
 * DIFFERENT branches of `runDirectCompletion`: a throwing provider takes the
 * catch (which rethrows unchanged when the turn signal is aborted), and a
 * provider that resolves empty takes the `turnSignal.aborted` early return
 * ahead of both the deadline and the `direct_empty` check.
 */
describe("cancel outranks a racing deadline", () => {
    it("a provider that THROWS on the cancel → cancelled, no chunks, nothing stored", async () => {
        const config = await makeConfig({ loop: "direct" });
        let entered = () => { };
        const inFlight = new Promise((resolve) => {
            entered = resolve;
        });
        const stalled = (_messages, _model, options) => new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
            entered();
        });
        const { agent, sink, sessionId } = await newAgentSession({
            loadConfig: async () => config,
            complete: stalled,
            // A deadline IS armed and racing; the cancel below beats it.
            env: { RLMX_ACP_RUN_TIMEOUT_MS: "10000" },
        });
        const turn = agent.prompt({ sessionId, prompt: [ask("q")] });
        await inFlight;
        await agent.cancel({ sessionId });
        const res = await turn;
        assert.equal(res.stopReason, "cancelled", "a cancelled turn is cancelled, not a failure");
        assert.deepEqual(sink.answerChunks(sessionId), [], "no answer chunk on a cancelled turn");
        assert.deepEqual(await storedTurns(sessionId), [], "a cancelled turn is not persisted");
    });
    it("a provider that RESOLVES EMPTY on the cancel → cancelled, not direct_empty", async () => {
        const config = await makeConfig({ loop: "direct" });
        let entered = () => { };
        const inFlight = new Promise((resolve) => {
            entered = resolve;
        });
        const emptyOnAbort = (_messages, _model, options) => new Promise((resolve) => {
            options?.signal?.addEventListener("abort", () => resolve({ text: "", usage: createUsage() }), { once: true });
            entered();
        });
        const { agent, sink, sessionId } = await newAgentSession({
            loadConfig: async () => config,
            complete: emptyOnAbort,
            env: { RLMX_ACP_RUN_TIMEOUT_MS: "10000" },
        });
        const turn = agent.prompt({ sessionId, prompt: [ask("q")] });
        await inFlight;
        await agent.cancel({ sessionId });
        const res = await turn;
        assert.equal(res.stopReason, "cancelled");
        assert.deepEqual(sink.answerChunks(sessionId), []);
        assert.deepEqual(await storedTurns(sessionId), []);
    });
});
// ─── Amendment (b): the missing-FINAL-protocol diagnostic ─
describe("the silently-dropped FINAL protocol — predicate", () => {
    it("fires for a non-empty system prompt that teaches no termination call", async () => {
        const config = await makeConfig({ system: "You are MERI. Answer in one line." });
        assert.match(missingFinalProtocolWarning(config) ?? "", /FINAL/);
    });
    it("is silent when the scaffold is present in either form", async () => {
        assert.equal(missingFinalProtocolWarning(await makeConfig({ system: "…call FINAL(answer) when done" })), null);
        assert.equal(missingFinalProtocolWarning(await makeConfig({ system: "…call FINAL_VAR(\"out\") when done" })), null);
    });
    it("is silent for an empty or whitespace-only system prompt", async () => {
        assert.equal(missingFinalProtocolWarning(await makeConfig({ system: null })), null);
        assert.equal(missingFinalProtocolWarning(await makeConfig({ system: "   \n " })), null);
    });
    it("is silent in structured-output mode (a schema terminates the run)", async () => {
        const structured = await makeConfig({
            system: "You are MERI.",
            model: { provider: "google", model: "gemini-3.1-flash-lite-preview" },
            output: { schema: { type: "object" } },
        });
        assert.equal(missingFinalProtocolWarning(structured), null);
        // A schema on a NON-Google provider is not structured-output mode, so the
        // protocol really is missing and the diagnostic must still fire.
        const notStructured = await makeConfig({
            system: "You are MERI.",
            model: { provider: "station", model: "qwen" },
            output: { schema: { type: "object" } },
        });
        assert.match(missingFinalProtocolWarning(notStructured) ?? "", /FINAL/);
    });
});
describe("the silently-dropped FINAL protocol — fires once, loop mode only", () => {
    it("warns exactly once across repeated loop turns", async () => {
        const warnings = [];
        const config = await makeConfig({ system: "You are MERI. Answer in one line." });
        const { agent, sessionId } = await newAgentSession({
            loadConfig: async () => config,
            rlmLoop: spyLoop(makeResult("ok")).fn,
            env: {},
            warn: (m) => warnings.push(m),
        });
        await agent.prompt({ sessionId, prompt: [ask("one")] });
        await agent.prompt({ sessionId, prompt: [ask("two")] });
        await agent.prompt({ sessionId, prompt: [ask("three")] });
        assert.equal(warnings.length, 1, "a diagnostic must not be a per-turn tax");
        assert.match(warnings[0], /loop: direct|FINAL/);
    });
    it("never warns in direct mode — direct mode needs no FINAL protocol", async () => {
        const warnings = [];
        const config = await makeConfig({
            loop: "direct",
            system: "You are MERI. Answer in one line.",
        });
        const { agent, sessionId } = await newAgentSession({
            loadConfig: async () => config,
            complete: spyComplete("fine").fn,
            env: {},
            warn: (m) => warnings.push(m),
        });
        await agent.prompt({ sessionId, prompt: [ask("q")] });
        assert.deepEqual(warnings, []);
    });
    it("never warns when the project kept the FINAL protocol", async () => {
        const warnings = [];
        const config = await makeConfig({ system: "Use FINAL(answer) to finish." });
        const { agent, sessionId } = await newAgentSession({
            loadConfig: async () => config,
            rlmLoop: spyLoop(makeResult("ok")).fn,
            env: {},
            warn: (m) => warnings.push(m),
        });
        await agent.prompt({ sessionId, prompt: [ask("q")] });
        assert.deepEqual(warnings, []);
    });
});
//# sourceMappingURL=acp-direct-mode.test.js.map