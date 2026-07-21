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
import { AgentSideConnection, type Agent, type AuthenticateRequest, type AuthenticateResponse, type CancelNotification, type InitializeRequest, type InitializeResponse, type LoadSessionRequest, type LoadSessionResponse, type NewSessionRequest, type NewSessionResponse, type PromptRequest, type PromptResponse } from "@agentclientprotocol/sdk";
/**
 * The rlmx ACP agent. One instance per stdio connection.
 *
 * Single active session, serialized: `promptInFlight` guards the one-at-a-time
 * invariant. A second `session/prompt` that arrives while a run is in flight is
 * rejected with `RequestError.invalidRequest` (JSON-RPC -32600) — a clear,
 * documented rejection rather than a silent queue.
 */
export declare class RlmxAcpAgent implements Agent {
    private readonly conn;
    private readonly sessions;
    private readonly version;
    /** True while a `session/prompt` turn is executing. Serializes prompt turns. */
    private promptInFlight;
    /** Cancellation handle for the in-flight prompt turn, if any. */
    private activePrompt;
    constructor(conn: AgentSideConnection);
    initialize(_params: InitializeRequest): Promise<InitializeResponse>;
    authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse>;
    newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
    loadSession(_params: LoadSessionRequest): Promise<LoadSessionResponse>;
    prompt(params: PromptRequest): Promise<PromptResponse>;
    cancel(params: CancelNotification): Promise<void>;
}
/**
 * Bootstrap the stdio ACP connection and run until stdin closes.
 *
 * Reroutes console.* to stderr up front so the JSON-RPC frames the SDK writes
 * to stdout are never interleaved with stray logging.
 */
export declare function runAcp(): Promise<void>;
//# sourceMappingURL=agent.d.ts.map