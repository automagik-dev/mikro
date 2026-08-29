/**
 * Core RLM iteration loop.
 *
 * Faithful implementation of the RLM algorithm:
 * - Prompt externalization (context as REPL variable, only metadata in messages)
 * - Python REPL with persistent namespace
 * - Iterative code generation + execution loop
 * - FINAL/FINAL_VAR termination detection
 * - Recursive sub-calls via llm_query/rlm_query
 */
import type { MikroConfig } from "./config.js";
import type { LoadedContext } from "./context.js";
import { type RLMResult } from "./output.js";
import type { Logger } from "./logger.js";
import { type EmitterAndStream } from "./sdk/emitter.js";
/** `budgetHit` set by the consecutive-empty-response abort. */
export declare const EMPTY_RESPONSES_BUDGET_HIT = "empty_responses";
/** Exact `answer` returned by the wall-clock-timeout abort. */
export declare const TIMEOUT_ANSWER = "Error: RLM query timed out";
/** Options for the RLM loop. */
export interface RLMOptions {
    maxIterations: number;
    timeout: number;
    verbose: boolean;
    output: "text" | "json" | "stream";
    cache: boolean;
    /** When true, route context through pgserve storage instead of REPL variable. */
    storageMode?: boolean;
    logger?: Logger;
    /**
     * Live SDK event bus (Wish B live-tui G2). Optional — pass a
     * `createEmitter()` the caller has ALREADY subscribed to so the run's
     * events (AgentStart / Iteration* / ToolCall* / Recurse / child-completion
     * / Session*) stream live from the first emission. When omitted, rlmLoop
     * creates its own internal emitter. This is the contractual seam the
     * headless subscriber and the mikro-acp adapter both consume — the run
     * closes the emitter when it finishes.
     */
    emitter?: EmitterAndStream;
}
/**
 * Main RLM loop entry point.
 */
export declare function rlmLoop(query: string, context: LoadedContext | null, config: MikroConfig, options?: Partial<RLMOptions>): Promise<RLMResult>;
//# sourceMappingURL=rlm.d.ts.map