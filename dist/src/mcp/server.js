/**
 * `rlmx mcp` — expose rlmx to MCP clients (Claude Code, Codex, …).
 *
 * Why this exists: ACP's *client* is an editor and its *agent* is the AI tool,
 * so `rlmx acp` is an Agent — and Claude Code and Codex are Agents too. Two
 * agents cannot drive each other over ACP. MCP is the protocol those harnesses
 * *do* speak as clients, which makes it the native way to hand rlmx work.
 *
 *   claude mcp add rlmx -- rlmx mcp
 *
 * Every discovered `agent.yaml` microagent becomes its own tool, so the host
 * model sees `rlmx_test_writer` / `rlmx_triage` as distinct capabilities it
 * can delegate to, rather than one opaque escape hatch it has to be told how
 * to use. Each tool runs on whatever model its `agent.yaml` names — a local
 * `station/<model>` or a cheap cloud model — which is how repeatable work gets
 * moved off an expensive host model.
 *
 * Every result carries its own token/cost footer, so the offload is visible in
 * the transcript as it happens instead of having to be taken on faith.
 *
 * stdout discipline: MCP stdio frames JSON-RPC on stdout, so all human/
 * diagnostic logging is redirected to stderr and `rlmLoop` is run with
 * `output: "json"` to keep it off its stream-mode stdout path — the same
 * contract `src/acp/agent.ts` follows.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { loadContext } from "../context.js";
import { rlmLoop } from "../rlm.js";
import { createEmitter } from "../sdk/emitter.js";
import { VERSION } from "../version.js";
import { discoverAgents, splitModel } from "./agents.js";
/** Tool always present, so the server is useful before any agent is authored. */
const GENERIC_TOOL = "rlmx_query";
const QUERY_PROPERTY = {
    type: "string",
    description: "The task or question to hand to rlmx.",
};
const CONTEXT_PROPERTY = {
    type: "string",
    description: "Optional path to a file or directory to load as context, relative to the " +
        "server's working directory. Equivalent to the CLI's --context.",
};
function agentToolSchema() {
    return {
        type: "object",
        properties: { query: QUERY_PROPERTY, context: CONTEXT_PROPERTY },
        required: ["query"],
    };
}
function genericToolSchema() {
    return {
        type: "object",
        properties: {
            query: QUERY_PROPERTY,
            context: CONTEXT_PROPERTY,
            model: {
                type: "string",
                description: 'Optional model override as "<provider>/<model>", e.g. ' +
                    '"station/Brain-35B" to run locally at no marginal cost.',
            },
        },
        required: ["query"],
    };
}
function describeAgent(agent) {
    const model = agent.spec.model ? ` Runs on ${agent.spec.model}.` : "";
    return `${agent.summary}${model} (rlmx microagent "${agent.name}", shape=${agent.spec.shape})`;
}
function buildToolList(agents) {
    const tools = [
        {
            name: GENERIC_TOOL,
            description: "Run an ad-hoc query through rlmx (RLM loop with a Python REPL and " +
                "recursion). Use this to offload self-contained work — analysis over " +
                "a large body of files, repeated extraction, anything you would " +
                "otherwise grind through inline. Returns the answer plus the tokens " +
                "and cost it used.",
            inputSchema: genericToolSchema(),
        },
    ];
    for (const agent of agents) {
        tools.push({
            name: agent.toolName,
            description: describeAgent(agent),
            inputSchema: agentToolSchema(),
        });
    }
    return tools;
}
/** Apply an agent's `agent.yaml` to the ambient config for one run. */
function applyAgent(config, agent) {
    const next = { ...config };
    if (agent.spec.model) {
        const parsed = splitModel(agent.spec.model);
        if (parsed) {
            next.model = { ...config.model, provider: parsed.provider, model: parsed.model };
        }
    }
    if (agent.system) {
        next.system = agent.system;
    }
    if (agent.spec.budget?.maxCost !== undefined) {
        next.budget = { ...config.budget, maxCost: agent.spec.budget.maxCost };
    }
    return next;
}
function applyModelOverride(config, model) {
    const parsed = splitModel(model);
    if (!parsed)
        return config;
    return {
        ...config,
        model: { ...config.model, provider: parsed.provider, model: parsed.model },
    };
}
function formatCost(cost) {
    if (cost <= 0)
        return "$0.00";
    if (cost < 0.01)
        return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
}
function formatFooter(label, config, result, elapsedMs) {
    const tokensIn = result.usage.inputTokens.toLocaleString("en-US");
    const tokensOut = result.usage.outputTokens.toLocaleString("en-US");
    const model = `${config.model.provider}/${config.model.model}`;
    const seconds = (elapsedMs / 1000).toFixed(1);
    const budget = result.budgetHit ? ` · budget hit: ${result.budgetHit}` : "";
    return (`rlmx · ${label} · ${model} · ${result.iterations} iteration` +
        `${result.iterations === 1 ? "" : "s"} · ${tokensIn} in / ${tokensOut} out ` +
        `· ${formatCost(result.usage.totalCost)} · ${seconds}s${budget}`);
}
function textResult(text, isError = false) {
    return { content: [{ type: "text", text }], isError };
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
async function runQuery(config, label, query, contextPath, cwd, progress) {
    let context = null;
    if (contextPath) {
        const resolved = resolve(cwd, contextPath);
        const contextOpts = config.contextConfig
            ? {
                extensions: config.contextConfig.extensions,
                exclude: config.contextConfig.exclude,
            }
            : undefined;
        context = await loadContext(resolved, contextOpts);
    }
    // Subscribe BEFORE the run so no early event is missed; rlmLoop closes the
    // emitter when it finishes, which ends this loop.
    let emitter;
    if (progress) {
        emitter = createEmitter();
        const stream = emitter;
        void (async () => {
            let iterations = 0;
            let spawns = 0;
            try {
                for await (const ev of stream) {
                    switch (ev.type) {
                        case "IterationStart":
                            iterations += 1;
                            progress(`${label} · iteration ${iterations}`);
                            break;
                        case "Recurse":
                            spawns += 1;
                            progress(`${label} · iteration ${iterations} · ${spawns} recursive spawn${spawns === 1 ? "" : "s"}`);
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
    }
    const started = Date.now();
    // output: "json" keeps rlmLoop off its stream-mode stdout path, which the
    // MCP transport owns.
    const result = await rlmLoop(query, context, config, {
        output: "json",
        ...(emitter ? { emitter } : {}),
        ...runTimeout(),
    });
    const footer = formatFooter(label, config, result, Date.now() - started);
    return textResult(`${result.answer}\n\n---\n${footer}`);
}
/**
 * Run the MCP server on stdio until the client disconnects.
 *
 * @param cwd Working directory used for agent discovery, config loading, and
 *            relative `context` arguments.
 */
export async function runMcp(cwd = process.cwd()) {
    // ── stdout discipline ──────────────────────────────────────────────────
    // stdout is reserved for framed JSON-RPC. Anything human-readable — ours or
    // a dependency's — goes to stderr.
    const toStderr = (...args) => {
        process.stderr.write(`${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
    };
    console.log = toStderr;
    console.info = toStderr;
    console.debug = toStderr;
    console.warn = toStderr;
    const agents = await discoverAgents(cwd);
    const byToolName = new Map(agents.map((a) => [a.toolName, a]));
    process.stderr.write(`rlmx mcp: ${agents.length} microagent${agents.length === 1 ? "" : "s"} discovered` +
        `${agents.length ? ` (${agents.map((a) => a.name).join(", ")})` : ""}\n`);
    const server = new Server({ name: "rlmx", version: VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: buildToolList(agents),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const { name, arguments: args } = request.params;
        // Only emit progress when the client asked for it by supplying a token.
        const progressToken = extra._meta?.progressToken;
        let step = 0;
        const progress = progressToken === undefined
            ? undefined
            : (message) => {
                step += 1;
                void extra
                    .sendNotification({
                    method: "notifications/progress",
                    params: { progressToken, progress: step, message },
                })
                    .catch(() => {
                    // Client vanished or stopped listening — never fail the run.
                });
            };
        const query = typeof args?.query === "string" ? args.query.trim() : "";
        const contextPath = typeof args?.context === "string" && args.context.trim()
            ? args.context.trim()
            : undefined;
        if (!query) {
            return textResult(`${name}: "query" is required and must be a non-empty string.`, true);
        }
        try {
            const baseConfig = await loadConfig(cwd);
            if (name === GENERIC_TOOL) {
                const override = typeof args?.model === "string" ? args.model.trim() : "";
                const config = override ? applyModelOverride(baseConfig, override) : baseConfig;
                return await runQuery(config, "query", query, contextPath, cwd, progress);
            }
            const agent = byToolName.get(name);
            if (!agent) {
                return textResult(`Unknown tool: ${name}`, true);
            }
            return await runQuery(applyAgent(baseConfig, agent), `agent=${agent.name}`, query, contextPath, cwd, progress);
        }
        catch (err) {
            // A failing run must fail only this tool call, never the server process.
            const message = err instanceof Error ? err.message : String(err);
            return textResult(`rlmx ${name} failed: ${message}`, true);
        }
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Do not crash if the client closes the pipe early.
    process.stdout.on("error", () => process.exit(0));
}
//# sourceMappingURL=server.js.map