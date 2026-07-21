/**
 * ACP (Agent Client Protocol) stdio agent — wish rlmx-acp-adapter, Group 1.
 *
 * Exposes `rlmx acp`: a stdio JSON-RPC agent (per the Agent Client Protocol,
 * https://agentclientprotocol.com) that completes the handshake and drives the
 * REAL instrumented `rlmLoop` in-process for a prompt round-trip.
 *
 * Scope boundaries (see WISH.md):
 *   • Group 1 (this file): lifecycle skeleton — initialize / authenticate /
 *     session/new / session/load (clean-error stub) / session/prompt. On
 *     prompt it runs the real `rlmLoop` and streams a single end-of-run
 *     `agent_message_chunk` with the answer. Single active prompt turn,
 *     SERIALIZED: a concurrent `session/prompt` is REJECTED with a clear
 *     JSON-RPC error (documented choice — not queued).
 *   • Group 2: full AgentEvent → session/update translation (tool calls,
 *     thoughts, plans). The event drain loop below is the seam it hooks.
 *   • Group 3: durable session/load + persistence (Tidewave). This file
 *     advertises `loadSession: false` honestly until then.
 *
 * SDK: @agentclientprotocol/sdk ^0.26.0 (same family pi-acp pins). Method
 * names map to the SDK's `Agent` interface members: initialize,
 * authenticate, newSession (session/new), loadSession (session/load),
 * prompt (session/prompt), cancel (session/cancel).
 *
 * stdout discipline: an ACP stdio agent owns stdout for framed JSON-RPC.
 * `runAcp()` reroutes console.* to stderr so no stray human/logging output
 * corrupts the protocol stream; the SDK writes frames via process.stdout
 * directly (unaffected). rlmLoop is driven with `output: "json"` so its
 * stream-mode stdout path is never taken.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, RequestError, } from "@agentclientprotocol/sdk";
import { loadConfig } from "../config.js";
import { rlmLoop } from "../rlm.js";
import { createEmitter } from "../sdk/emitter.js";
import { createTranslationContext, translateEvent } from "./session.js";
/** Resolve the package version for `agentInfo`, best-effort. */
function resolveVersion() {
    try {
        const require = createRequire(import.meta.url);
        // dist/src/acp/agent.js → ../../../package.json (repo/package root)
        const pkg = require("../../../package.json");
        return pkg.version ?? "0.0.0";
    }
    catch {
        return "0.0.0";
    }
}
/** Extract the plain-text prompt from a list of ACP content blocks. */
function extractPromptText(blocks) {
    const parts = [];
    for (const block of blocks) {
        if (block.type === "text")
            parts.push(block.text);
    }
    return parts.join("\n").trim();
}
/**
 * The rlmx ACP agent. One instance per stdio connection.
 *
 * Single active session, serialized: `promptInFlight` guards the one-at-a-time
 * invariant. A second `session/prompt` that arrives while a run is in flight is
 * rejected with `RequestError.invalidRequest` (JSON-RPC -32600) — a clear,
 * documented rejection rather than a silent queue.
 */
export class RlmxAcpAgent {
    conn;
    sessions = new Map();
    version = resolveVersion();
    /** True while a `session/prompt` turn is executing. Serializes prompt turns. */
    promptInFlight = false;
    /** Cancellation handle for the in-flight prompt turn, if any. */
    activePrompt = null;
    constructor(conn) {
        this.conn = conn;
    }
    async initialize(_params) {
        return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: {
                // Honest advertisement: session/load is a clean-error stub in Group 1.
                // Group 3 makes it durable and flips this to true.
                loadSession: false,
                promptCapabilities: {
                    image: false,
                    audio: false,
                    embeddedContext: false,
                },
            },
            // No authentication required: the local station provider needs no keys.
            authMethods: [],
            agentInfo: { name: "rlmx", version: this.version },
        };
    }
    async authenticate(_params) {
        // No auth methods advertised; nothing to do. Present so clients that call
        // it unconditionally get a clean success.
        return {};
    }
    async newSession(params) {
        const cwd = params.cwd;
        if (typeof cwd !== "string" || cwd.length === 0) {
            throw RequestError.invalidParams(undefined, "newSession requires an absolute cwd");
        }
        const sessionId = randomUUID();
        this.sessions.set(sessionId, { cwd });
        return { sessionId };
    }
    async loadSession(_params) {
        // Group 1 stub: the method exists so clients can probe it, but session
        // durability lands in Group 3. Fail cleanly as a JSON-RPC error rather
        // than pretending to restore state. `loadSession` is advertised as false
        // in initialize, so a spec-compliant client will not call this.
        throw RequestError.methodNotFound("session/load");
    }
    async prompt(params) {
        const session = this.sessions.get(params.sessionId);
        if (!session) {
            throw RequestError.invalidParams(undefined, `unknown sessionId: ${params.sessionId}`);
        }
        // Single active session, serialized. Reject a concurrent prompt turn with
        // a clear JSON-RPC error (documented choice: reject, do not queue).
        if (this.promptInFlight) {
            throw RequestError.invalidRequest(undefined, "a prompt is already in flight; rlmx acp serializes prompt turns (single active session)");
        }
        const query = extractPromptText(params.prompt);
        if (query.length === 0) {
            throw RequestError.invalidParams(undefined, "prompt contained no text content");
        }
        this.promptInFlight = true;
        const abort = new AbortController();
        this.activePrompt = { sessionId: params.sessionId, abort };
        try {
            // Load the project config from the session cwd, exactly as the CLI does.
            const config = await loadConfig(session.cwd);
            // The instrumented rlmLoop seam: subscribe a caller-created emitter
            // BEFORE the run starts, then drive the REAL loop in-process. Group 2
            // translates each AgentEvent into session/update notifications LIVE, as
            // it arrives — the drain loop below is the translation site. A translator
            // throw or a client-side send failure never kills the run.
            const emitter = createEmitter();
            const ctx = createTranslationContext(params.sessionId);
            let messageChunksSent = 0;
            const drain = (async () => {
                for await (const ev of emitter) {
                    // Cooperative cancel: once aborted, stop forwarding updates. The
                    // rlmLoop keeps running in-process (it exposes no abort option;
                    // see cancel()), but the client sees no further output.
                    if (abort.signal.aborted)
                        break;
                    let updates;
                    try {
                        updates = translateEvent(ev, ctx);
                    }
                    catch (translateErr) {
                        // Forward-compat: a translator fault must not crash the drain.
                        const m = translateErr instanceof Error
                            ? translateErr.message
                            : String(translateErr);
                        process.stderr.write(`rlmx acp: translate error: ${m}\n`);
                        continue;
                    }
                    for (const update of updates) {
                        if (abort.signal.aborted)
                            break;
                        // Only a genuine ANSWER chunk (shared answer messageId) suppresses
                        // the end-of-run backstop. A root/unknown Error surfaced by
                        // translateError is also an agent_message_chunk but carries an
                        // `error:` messageId — counting it would let an error-then-empty-
                        // answer turn skip the backstop and yield no actual answer chunk.
                        if (update.sessionUpdate === "agent_message_chunk" &&
                            update.messageId === `answer:${params.sessionId}`)
                            messageChunksSent++;
                        try {
                            await this.conn.sessionUpdate({
                                sessionId: params.sessionId,
                                update,
                            });
                        }
                        catch {
                            // Client stream gone — stop draining; the run still completes.
                            return;
                        }
                    }
                }
            })();
            // Wrap the run so a failing run fails only THIS prompt, never the agent
            // process. output: "json" keeps rlmLoop off its stream-mode stdout path.
            //
            // A recursive turn (parent iterations + a child spawn that itself takes
            // tens of seconds) can exceed rlmLoop's 300s default wall-clock cap. The
            // client owns turn duration (it can session/cancel), so an ACP-hosted run
            // honors an optional RLMX_ACP_RUN_TIMEOUT_MS override for the loop's
            // internal timeout. Unset → rlmLoop's own default applies (unchanged for
            // the fast non-recursive path). Additive; rlm.ts untouched.
            const runTimeoutMs = Number(process.env.RLMX_ACP_RUN_TIMEOUT_MS);
            const result = await rlmLoop(query, null, config, {
                emitter,
                output: "json",
                ...(Number.isFinite(runTimeoutMs) && runTimeoutMs > 0
                    ? { timeout: runTimeoutMs }
                    : {}),
            });
            await drain; // emitter is closed by rlmLoop when the run finishes.
            // Invariant backstop: some rlmLoop exit paths (e.g. the consecutive-empty
            // abort) return an answer WITHOUT emitting EmitDone, so no answer chunk
            // was streamed. If nothing reached the client as a message chunk, send
            // the final answer once so a prompt turn always yields an answer.
            if (!abort.signal.aborted && messageChunksSent === 0) {
                const answer = result.answer ?? "";
                if (answer.length > 0) {
                    await this.conn.sessionUpdate({
                        sessionId: params.sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            content: { type: "text", text: answer },
                            messageId: `answer:${params.sessionId}`,
                        },
                    });
                }
            }
            // A cancelled turn reports `cancelled`; a normal turn reports `end_turn`.
            return { stopReason: abort.signal.aborted ? "cancelled" : "end_turn" };
        }
        catch (err) {
            // A RequestError propagates as a structured JSON-RPC error; any other
            // failure is surfaced as an internal error scoped to this prompt turn.
            if (err instanceof RequestError)
                throw err;
            const message = err instanceof Error ? err.message : String(err);
            throw RequestError.internalError(undefined, `rlmLoop failed: ${message}`);
        }
        finally {
            this.promptInFlight = false;
            this.activePrompt = null;
        }
    }
    async cancel(params) {
        // Cooperative cancellation. rlmLoop exposes no AbortSignal option in
        // RLMOptions (src/rlm.ts) and this file is forbidden from refactoring it,
        // so the minimal correct hook is to abort at the ACP boundary: the drain
        // loop stops forwarding session/update notifications and the prompt turn
        // resolves with stopReason "cancelled". LIMITATION: the underlying rlmLoop
        // continues to completion in-process (its work is not interrupted); only
        // the client-visible update stream is cut. Threading a real AbortSignal
        // into rlmLoop is a documented follow-up (a tiny additive RLMOptions.signal
        // that llmComplete's existing abortController would honor).
        const active = this.activePrompt;
        if (active && active.sessionId === params.sessionId) {
            active.abort.abort();
        }
    }
}
/**
 * Bootstrap the stdio ACP connection and run until stdin closes.
 *
 * Reroutes console.* to stderr up front so the JSON-RPC frames the SDK writes
 * to stdout are never interleaved with stray logging.
 */
export async function runAcp() {
    // ── stdout discipline ────────────────────────────────────────────────
    // Any human/diagnostic logging (ours or a dependency's) must go to stderr;
    // stdout is reserved for framed JSON-RPC written by the SDK.
    const toStderr = (...args) => {
        process.stderr.write(`${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
    };
    console.log = toStderr;
    console.info = toStderr;
    console.debug = toStderr;
    console.warn = toStderr;
    // ── stdio streams (newline-delimited JSON over stdin/stdout) ─────────
    const output = new WritableStream({
        write(chunk) {
            return new Promise((resolve) => {
                if (!process.stdout.writable)
                    return resolve();
                process.stdout.write(chunk, () => resolve());
            });
        },
    });
    const input = new ReadableStream({
        start(controller) {
            process.stdin.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
            process.stdin.on("end", () => {
                try {
                    controller.close();
                }
                catch {
                    // already closed
                }
            });
            process.stdin.on("error", (err) => controller.error(err));
        },
    });
    const stream = ndJsonStream(output, input);
    // Hold a reference so the connection is not GC'd while stdin is open.
    const _conn = new AgentSideConnection((conn) => new RlmxAcpAgent(conn), stream);
    void _conn;
    const shutdown = () => {
        process.exit(0);
    };
    process.stdin.on("end", shutdown);
    process.stdin.on("close", shutdown);
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    // Do not crash if the client closes stdout early.
    process.stdout.on("error", shutdown);
    process.stdin.resume();
    // Keep the event loop alive until stdin ends (shutdown() exits the process).
    await new Promise(() => { });
}
//# sourceMappingURL=agent.js.map