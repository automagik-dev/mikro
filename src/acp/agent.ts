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
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type ContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
} from "@agentclientprotocol/sdk";
import { loadConfig } from "../config.js";
import { rlmLoop } from "../rlm.js";
import { createEmitter } from "../sdk/emitter.js";
import type { AgentEvent } from "../sdk/events.js";

/** Per-session state. Group 3 makes this durable; Group 1 keeps it in memory. */
interface SessionState {
  /** Absolute working directory the session was created in. */
  cwd: string;
}

/** Resolve the package version for `agentInfo`, best-effort. */
function resolveVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    // dist/src/acp/agent.js → ../../../package.json (repo/package root)
    const pkg = require("../../../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Extract the plain-text prompt from a list of ACP content blocks. */
function extractPromptText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text);
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
export class RlmxAcpAgent implements Agent {
  private readonly conn: AgentSideConnection;
  private readonly sessions = new Map<string, SessionState>();
  private readonly version = resolveVersion();
  /** True while a `session/prompt` turn is executing. Serializes prompt turns. */
  private promptInFlight = false;

  constructor(conn: AgentSideConnection) {
    this.conn = conn;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
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

  async authenticate(
    _params: AuthenticateRequest,
  ): Promise<AuthenticateResponse> {
    // No auth methods advertised; nothing to do. Present so clients that call
    // it unconditionally get a clean success.
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const cwd = params.cwd;
    if (typeof cwd !== "string" || cwd.length === 0) {
      throw RequestError.invalidParams(undefined, "newSession requires an absolute cwd");
    }
    const sessionId = randomUUID();
    this.sessions.set(sessionId, { cwd });
    return { sessionId };
  }

  async loadSession(
    _params: LoadSessionRequest,
  ): Promise<LoadSessionResponse> {
    // Group 1 stub: the method exists so clients can probe it, but session
    // durability lands in Group 3. Fail cleanly as a JSON-RPC error rather
    // than pretending to restore state. `loadSession` is advertised as false
    // in initialize, so a spec-compliant client will not call this.
    throw RequestError.methodNotFound("session/load");
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `unknown sessionId: ${params.sessionId}`,
      );
    }

    // Single active session, serialized. Reject a concurrent prompt turn with
    // a clear JSON-RPC error (documented choice: reject, do not queue).
    if (this.promptInFlight) {
      throw RequestError.invalidRequest(
        undefined,
        "a prompt is already in flight; rlmx acp serializes prompt turns (single active session)",
      );
    }

    const query = extractPromptText(params.prompt);
    if (query.length === 0) {
      throw RequestError.invalidParams(undefined, "prompt contained no text content");
    }

    this.promptInFlight = true;
    try {
      // Load the project config from the session cwd, exactly as the CLI does.
      const config = await loadConfig(session.cwd);

      // The instrumented rlmLoop seam: subscribe a caller-created emitter
      // BEFORE the run starts, then drive the REAL loop in-process. Group 2
      // translates these AgentEvents into session/update notifications; Group 1
      // drains them (keeping the emitter from backing up) and sends a single
      // end-of-run agent_message_chunk with the final answer.
      const emitter = createEmitter();
      const drained: AgentEvent[] = [];
      const drain = (async () => {
        for await (const ev of emitter) drained.push(ev);
      })();

      // Wrap the run so a failing run fails only THIS prompt, never the agent
      // process. output: "json" keeps rlmLoop off its stream-mode stdout path.
      const result = await rlmLoop(query, null, config, {
        emitter,
        output: "json",
      });
      await drain; // emitter is closed by rlmLoop when the run finishes.
      void drained; // Group 2 consumes these; referenced to satisfy noUnused.

      const answer = result.answer ?? "";
      await this.conn.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: answer },
        },
      });

      return { stopReason: "end_turn" };
    } catch (err) {
      // A RequestError propagates as a structured JSON-RPC error; any other
      // failure is surfaced as an internal error scoped to this prompt turn.
      if (err instanceof RequestError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw RequestError.internalError(undefined, `rlmLoop failed: ${message}`);
    } finally {
      this.promptInFlight = false;
    }
  }

  async cancel(_params: CancelNotification): Promise<void> {
    // Group 1: no cooperative cancellation of an in-flight rlmLoop yet. The
    // notification is accepted so clients do not error; the run completes.
    // (Group 2/3 can thread an AbortSignal through the loop.)
  }
}

/**
 * Bootstrap the stdio ACP connection and run until stdin closes.
 *
 * Reroutes console.* to stderr up front so the JSON-RPC frames the SDK writes
 * to stdout are never interleaved with stray logging.
 */
export async function runAcp(): Promise<void> {
  // ── stdout discipline ────────────────────────────────────────────────
  // Any human/diagnostic logging (ours or a dependency's) must go to stderr;
  // stdout is reserved for framed JSON-RPC written by the SDK.
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(
      `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`,
    );
  };
  console.log = toStderr as typeof console.log;
  console.info = toStderr as typeof console.info;
  console.debug = toStderr as typeof console.debug;
  console.warn = toStderr as typeof console.warn;

  // ── stdio streams (newline-delimited JSON over stdin/stdout) ─────────
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve) => {
        if (!process.stdout.writable) return resolve();
        process.stdout.write(chunk, () => resolve());
      });
    },
  });
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      process.stdin.on("data", (chunk: Buffer) =>
        controller.enqueue(new Uint8Array(chunk)),
      );
      process.stdin.on("end", () => {
        try {
          controller.close();
        } catch {
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

  const shutdown = (): void => {
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
  await new Promise<void>(() => {});
}
