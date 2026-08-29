/**
 * Legacy backend — the current `rlmLoop` engine wrapped behind `RuntimeBackend`.
 *
 * This is the default backend: every behavior the MCP server has today comes
 * from here, byte for byte. The event-driven progress translation and the
 * `maxIterations`/`timeout` handling that used to live in `runTurn`
 * (`src/mcp/server.ts`) moved here because they are properties of *this*
 * engine, not of the MCP surface — a second backend translates its own
 * events and owns its own stopping semantics.
 */
import { rlmLoop } from "../../rlm.js";
import type { Microagent } from "../agents.js";
import type { BackendRequest, MicroagentResult, RuntimeBackend } from "../backend.js";
/** Test seam: alternate engine loop (the contract test injects a stub). */
export interface LegacyMikroBackendOptions {
    readonly loop?: typeof rlmLoop;
}
export declare class LegacyMikroBackend implements RuntimeBackend {
    private readonly loop;
    constructor(options?: LegacyMikroBackendOptions);
    run(_agent: Microagent | undefined, request: BackendRequest, emit: (message: string) => void): Promise<MicroagentResult>;
}
//# sourceMappingURL=legacy.d.ts.map