/**
 * Runtime backend seam — Wish rlmx-v2-prime-backend Group 1.
 *
 * The MCP server used to call `rlmLoop` directly; it now calls a backend.
 * That inversion is the whole point of this module: the server owns the
 * MCP contract (tools, sessions, result shape, progress presentation) and a
 * backend owns "what actually executes the turn", so a second engine can
 * slot in behind the same host-visible surface.
 *
 * The request carries the MCP request's AbortSignal. Backends that own a
 * killable execution boundary (Prime's subprocess) must honor it; legacy's
 * in-process rlmLoop cannot yet consume it and remains deadline-bounded.
 */

import type { RlmxConfig } from "../config.js";
import type { LoadedContext } from "../context.js";
import type { Microagent } from "./agents.js";

/** Everything one backend needs to execute one delegated turn. */
export interface BackendRequest {
  /** The resume-folded prompt — the full text to run. */
  readonly query: string;
  /** Context loaded from the caller's `context:` argument, if any. */
  readonly context: LoadedContext | null;
  /** Config resolved for this run (`applyAgent` / model override applied). */
  readonly config: RlmxConfig;
  /** Iteration cap implied by the agent's spec (`shape`/`budget`), if any. */
  readonly maxIterations?: number;
  /**
   * Server working directory the turn runs against (`--dir` / the server's
   * cwd). The legacy backend has no use for it — context is already loaded
   * and rlmLoop runs in-process — but a subprocess backend must know where
   * the agent works: the prime backend maps it to prime-agent's `--cwd`.
   */
  readonly cwd: string;
  /**
   * Absolute path the caller's `context:` argument resolved to, when one was
   * passed. Used only to retain the logical basename when a backend
   * materializes the already-loaded context into a private snapshot.
   */
  readonly contextRoot?: string;
  /** Caller cancellation, forwarded by the MCP SDK. */
  readonly signal?: AbortSignal;
}

/**
 * The result of one backend run — exactly the fields the MCP layer consumes.
 *
 * Enumerated deliberately: `formatFooter` and `isFailedRun`
 * (`src/mcp/server.ts`) read `answer`, `iterations`, `budgetHit`, and
 * `usage.inputTokens` / `usage.outputTokens` / `usage.totalCost`, and nothing
 * else. A field beyond these would be dead weight a backend must manufacture
 * for nobody to read.
 */
export interface MicroagentResult {
  readonly answer: string;
  readonly iterations: number;
  /** Matches `RLMResult.budgetHit`: `null` (or absent) when no budget fired. */
  readonly budgetHit?: string | null;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalCost: number;
  };
}

/**
 * One execution backend: runs a single delegated turn to completion.
 *
 * `agent` is the resolved microagent — `undefined` for the generic
 * `rlmx_query` tool, which has no agent spec. `request` carries the resolved
 * config and query; `emit` reports progress messages (without the tool label —
 * the server prefixes it) while the run executes. A throw is a *failed run*
 * the server reports as a tool error. Backend-owned deadline and budget exits
 * return normally so the server's `isFailedRun` classification can preserve
 * the public footer contract; malformed/empty provider completions throw.
 */
export interface RuntimeBackend {
  run(
    agent: Microagent | undefined,
    request: BackendRequest,
    emit: (message: string) => void
  ): Promise<MicroagentResult>;
}
