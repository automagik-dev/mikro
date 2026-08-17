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
import { createEmitter } from "../../sdk/emitter.js";
import { rlmLoop } from "../../rlm.js";
export class LegacyRlmxBackend {
    loop;
    constructor(options = {}) {
        this.loop = options.loop ?? rlmLoop;
    }
    async run(_agent, request, emit) {
        // Subscribe BEFORE the run so no early event is missed; rlmLoop closes the
        // emitter when it finishes, which ends this loop.
        const emitter = createEmitter();
        const stream = emitter;
        void (async () => {
            let iterations = 0;
            let spawns = 0;
            try {
                for await (const ev of stream) {
                    switch (ev.type) {
                        case "IterationStart":
                            iterations += 1;
                            emit(`iteration ${iterations}`);
                            break;
                        case "Recurse":
                            spawns += 1;
                            emit(`iteration ${iterations} · ${spawns} recursive spawn${spawns === 1 ? "" : "s"}`);
                            break;
                        default:
                            break;
                    }
                }
            }
            catch {
                // A broken progress stream must never fail the run itself.
            }
        })();
        // output: "json" keeps rlmLoop off its stream-mode stdout path, which the
        // MCP transport owns — the same contract `src/acp/agent.ts` follows.
        const result = await this.loop(request.query, request.context, request.config, {
            output: "json",
            emitter,
            ...(request.maxIterations !== undefined ? { maxIterations: request.maxIterations } : {}),
            ...runTimeout(),
        });
        return {
            answer: result.answer,
            iterations: result.iterations,
            budgetHit: result.budgetHit ?? null,
            usage: {
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
                totalCost: result.usage.totalCost,
            },
        };
    }
}
/**
 * Resolve the run timeout. A delegated task can be long — especially a
 * recursive one — and the host owns cancellation, so allow lifting rlmLoop's
 * default wall-clock cap without touching rlm.ts.
 */
function runTimeout() {
    const ms = Number(process.env.RLMX_MCP_RUN_TIMEOUT_MS);
    return Number.isFinite(ms) && ms > 0 ? { timeout: ms } : {};
}
//# sourceMappingURL=legacy.js.map