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
 * Two properties make this usable rather than merely present:
 *
 *   Live tool set — every `tools/list` AND every `tools/call` re-scans the
 *   agent roots, and both the advertised list and the dispatch table are built
 *   from that one scan. An agent directory authored mid-session is therefore
 *   listed *and* callable without a reconnect, and the server emits
 *   `notifications/tools/list_changed` when the set actually changes.
 *
 *   Agent-tool isomorphism — the surface mirrors the host's own Agent tool:
 *   `prompt` in, one final report out, a `session_id` to continue with. A
 *   follow-up resumes by replaying the session's bounded turn history into the
 *   new prompt (the mechanism `src/acp/agent.ts` uses); the Python REPL is
 *   rebuilt per call and its state is deliberately not promised across turns.
 *
 * stdout discipline: MCP stdio frames JSON-RPC on stdout, so all human/
 * diagnostic logging is redirected to stderr and `rlmLoop` is run with
 * `output: "json"` to keep it off its stream-mode stdout path — the same
 * contract `src/acp/agent.ts` follows.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { applyModelRef, loadConfig } from "../config.js";
import { loadContext } from "../context.js";
import { rlmLoop } from "../rlm.js";
import { createEmitter } from "../sdk/emitter.js";
import { VERSION } from "../version.js";
import { discoverAgents, splitModel } from "./agents.js";
/** How often to tick when the run itself is emitting nothing. */
const HEARTBEAT_MS = 15_000;
/** Tool always present, so the server is useful before any agent is authored. */
const GENERIC_TOOL = "rlmx_query";
/**
 * Input surface, deliberately isomorphic to the host's native Agent tool:
 * `prompt` in, one final report out, `session_id` to continue. Delegation that
 * pattern-matches the tool a host model already knows gets used; a new idiom
 * gets ignored.
 *
 * `query` remains as a deprecated alias for `prompt`. Both are *optional* in
 * the schema and exactly one is demanded at runtime: JSON Schema can only say
 * "exactly one of" via `anyOf`/`oneOf`, which several MCP hosts flatten or
 * reject outright, so the constraint lives in code and the error names
 * `prompt`.
 */
const PROMPT_PROPERTY = {
    type: "string",
    description: "The task for rlmx to perform. Write it as a complete, standalone " +
        "instruction: the agent runs autonomously to completion and cannot ask " +
        "follow-up questions mid-run.",
};
const QUERY_PROPERTY = {
    type: "string",
    description: "Deprecated alias for `prompt`, kept for existing callers. Pass one or " +
        "the other, never both.",
};
const SESSION_ID_PROPERTY = {
    type: "string",
    description: "Continue an earlier call on this same tool: pass the `session_id` its " +
        "result returned. The prior turns are replayed into the new prompt, so " +
        "the follow-up can reference them. Omit to start a fresh session.",
};
const CONTEXT_PROPERTY = {
    type: "string",
    description: "Optional path to a file or directory to load as context, relative to the " +
        "server's working directory. Equivalent to the CLI's --context.",
};
/**
 * Output contract. Declaring it is what makes `structuredContent` a stated
 * promise rather than an undocumented extra a client may drop — but it cuts
 * the other way too: once an `outputSchema` exists, `structuredContent` is a
 * channel a conforming client may read *instead of* `content` (the reference
 * client outright rejects a non-error result that omits it). So the answer
 * itself has to be part of the promise. A schema naming only `session_id`
 * describes a result whose entire payload the host is free to discard —
 * offloaded work that ran, cost money, and returned nothing the model can see.
 */
export function toolOutputSchema() {
    return {
        type: "object",
        properties: {
            answer: {
                type: "string",
                description: "The agent's final report, identical to the text block — the answer " +
                    "followed by the token/cost footer. On a failed call this is the " +
                    "error message instead of a report.",
            },
            session_id: {
                type: "string",
                description: "Pass this back as `session_id` to continue this session.",
            },
        },
        required: ["answer", "session_id"],
    };
}
function agentToolSchema() {
    return {
        type: "object",
        properties: {
            prompt: PROMPT_PROPERTY,
            query: QUERY_PROPERTY,
            session_id: SESSION_ID_PROPERTY,
            context: CONTEXT_PROPERTY,
        },
        required: [],
    };
}
function genericToolSchema() {
    return {
        type: "object",
        properties: {
            prompt: PROMPT_PROPERTY,
            query: QUERY_PROPERTY,
            session_id: SESSION_ID_PROPERTY,
            context: CONTEXT_PROPERTY,
            model: {
                type: "string",
                description: 'Optional model override as "<provider>/<model>", e.g. ' +
                    '"station/Brain-35B" to run locally at no marginal cost.',
            },
        },
        required: [],
    };
}
/** Spawn-style description: what it is, how to prompt it, what comes back. */
function describeAgent(agent) {
    const model = agent.spec.model ? ` Runs on ${agent.spec.model}.` : "";
    return (`Launch the "${agent.name}" rlmx agent to handle a task autonomously. ` +
        `${agent.summary}${model} Give it a complete, standalone prompt — it runs ` +
        `to completion and returns a single final report, and cannot ask ` +
        `follow-up questions mid-run. The result carries the tokens and cost it ` +
        `used plus a session_id; pass that session_id back to this tool to ` +
        `continue the conversation. ` +
        `(rlmx microagent "${agent.name}", shape=${agent.spec.shape})`);
}
const GENERIC_DESCRIPTION = "Launch a general-purpose rlmx agent to handle a self-contained task " +
    "autonomously (RLM loop: Python REPL plus recursion). Use it to offload " +
    "work you would otherwise grind through inline — analysis over a large " +
    "body of files, repeated extraction, wide searches. Give it a complete, " +
    "standalone prompt: it runs to completion and returns a single final " +
    "report, and cannot ask follow-up questions mid-run. The result carries " +
    "the tokens and cost it used plus a session_id; pass that session_id back " +
    "to this tool to continue the conversation.";
export function buildToolList(agents) {
    const tools = [
        {
            name: GENERIC_TOOL,
            description: GENERIC_DESCRIPTION,
            inputSchema: genericToolSchema(),
            outputSchema: toolOutputSchema(),
        },
    ];
    for (const agent of agents) {
        tools.push({
            name: agent.toolName,
            description: describeAgent(agent),
            inputSchema: agentToolSchema(),
            outputSchema: toolOutputSchema(),
        });
    }
    return tools;
}
/**
 * Re-scan the agent roots and diff the resulting tool-name set.
 *
 * The failure mode this designs out is a tool that is listed but not callable
 * (or callable but not listed): `agents` and `byToolName` come from one
 * `discoverAgents` call, so the advertised list and the dispatch table cannot
 * drift apart. The first refresh only seeds the baseline — it never reports a
 * change, or every connect would emit a spurious `list_changed`.
 *
 * Refreshes are serialized through a promise chain: a refresh does not call
 * `scan` until every earlier refresh has finished updating the baseline. That
 * is the actual guarantee — not merely that the diff and the baseline update
 * share a synchronous step, but that scans cannot complete out of order. Two
 * concurrent requests observing one new agent therefore report the change
 * exactly once, and a scan that started earlier can never overwrite the
 * baseline with its older tool set (which would report a live agent as
 * `removed`, evict its sessions, and then re-announce it on the next refresh).
 */
export function createAgentRegistry(scan) {
    let previous;
    /** Tail of the serialization chain; never rejects, so one failure can't wedge it. */
    let queue = Promise.resolve();
    async function scanAndApply() {
        const agents = await scan();
        const byToolName = new Map(agents.map((a) => [a.toolName, a]));
        const current = new Set(byToolName.keys());
        const baseline = previous;
        previous = current;
        if (!baseline) {
            return { agents, byToolName, changed: false, removed: [] };
        }
        const removed = [...baseline].filter((name) => !current.has(name));
        const added = [...current].filter((name) => !baseline.has(name));
        return {
            agents,
            byToolName,
            changed: removed.length > 0 || added.length > 0,
            removed,
        };
    }
    return {
        refresh() {
            const next = queue.then(scanAndApply);
            queue = next.then(() => undefined, () => undefined);
            return next;
        },
    };
}
/** Sessions are advisory: losing one costs a fresh start, never correctness. */
const SESSION_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 64;
/** Turns retained per session; also the number replayed on a follow-up. */
const MAX_SESSION_TURNS = 8;
const REPLAY_PROMPT_CHARS = 2_000;
const REPLAY_ANSWER_CHARS = 4_000;
/**
 * In-process session map: `session_id` → bounded turn history.
 *
 * Bounded three ways, because an MCP server outlives any single conversation:
 * a TTL retires idle sessions, a size cap with LRU eviction bounds the map,
 * and a per-session turn cap bounds each entry. Nothing is persisted — a
 * server restart starts every conversation over, which is the honest contract
 * given the REPL is rebuilt per call anyway.
 */
export class McpSessionStore {
    sessions = new Map();
    ttlMs;
    maxSessions;
    maxTurns;
    now;
    newId;
    constructor(options = {}) {
        this.ttlMs = options.ttlMs ?? SESSION_TTL_MS;
        this.maxSessions = options.maxSessions ?? MAX_SESSIONS;
        this.maxTurns = options.maxTurns ?? MAX_SESSION_TURNS;
        this.now = options.now ?? Date.now;
        this.newId = options.newId ?? (() => `sess_${randomBytes(8).toString("hex")}`);
    }
    get size() {
        return this.sessions.size;
    }
    create(toolName) {
        this.sweep();
        this.evictToCap();
        const session = {
            id: this.newId(),
            toolName,
            turns: [],
            lastUsedAt: this.now(),
            busy: false,
        };
        this.sessions.set(session.id, session);
        return session;
    }
    /** Live session, or undefined when it is unknown or has expired. */
    get(id) {
        this.sweep();
        const session = this.sessions.get(id);
        if (session)
            session.lastUsedAt = this.now();
        return session;
    }
    /** Append a completed turn, dropping the oldest beyond the cap. */
    record(session, turn) {
        session.turns.push(turn);
        if (session.turns.length > this.maxTurns) {
            session.turns.splice(0, session.turns.length - this.maxTurns);
        }
        session.lastUsedAt = this.now();
    }
    delete(id) {
        return this.sessions.delete(id);
    }
    /**
     * Drop every session bound to a tool that no longer exists. An agent deleted
     * mid-session leaves its sessions unreachable — "Unknown tool" is the answer
     * a caller gets, so keeping the orphans would only hold memory.
     */
    evictTools(toolNames) {
        const doomed = new Set(toolNames);
        let evicted = 0;
        for (const [id, session] of this.sessions) {
            if (doomed.has(session.toolName)) {
                this.sessions.delete(id);
                evicted += 1;
            }
        }
        return evicted;
    }
    sweep() {
        const cutoff = this.now() - this.ttlMs;
        for (const [id, session] of this.sessions) {
            // An in-flight call keeps its session alive regardless of age.
            if (!session.busy && session.lastUsedAt <= cutoff)
                this.sessions.delete(id);
        }
    }
    /** Evict least-recently-used sessions until there is room for one more. */
    evictToCap() {
        if (this.sessions.size < this.maxSessions)
            return;
        const candidates = [...this.sessions.values()]
            .filter((s) => !s.busy)
            .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
        for (const victim of candidates) {
            if (this.sessions.size < this.maxSessions)
                break;
            this.sessions.delete(victim.id);
        }
        // If every session is busy the cap yields rather than killing a live call;
        // in-flight calls are bounded by the host's own concurrency.
    }
}
/**
 * Fold prior turns into a follow-up prompt.
 *
 * Same mechanism as ACP's `buildConversationalQuery` (`src/acp/agent.ts`) and
 * for the same reason: a fresh `rlmLoop` — and therefore a fresh Python REPL —
 * runs on every call, so conversation continuity is carried by replaying the
 * transcript, not by holding interpreter state. Live REPL variables are
 * explicitly *not* promised across a resume. Each field is char-capped so the
 * preamble cannot grow without bound.
 */
export function buildResumeQuery(turns, prompt) {
    if (turns.length === 0)
        return prompt;
    const lines = [
        "This is a continuing conversation. Earlier turns in this session (for context — do not repeat them unless the new request asks you to):",
        "",
    ];
    turns.forEach((turn, i) => {
        lines.push(`--- Turn ${i + 1} ---`);
        lines.push(`User: ${truncate(turn.prompt, REPLAY_PROMPT_CHARS)}`);
        lines.push(`Assistant: ${truncate(turn.answer, REPLAY_ANSWER_CHARS)}`);
        lines.push("");
    });
    lines.push("Now respond to this new request, drawing on the conversation above when relevant:");
    lines.push(prompt);
    return lines.join("\n");
}
function truncate(text, cap) {
    return text.length > cap ? `${text.slice(0, cap)}…` : text;
}
/**
 * Iteration cap implied by an agent's spec.
 *
 * `shape: single-step` means exactly one pass — without this the agent
 * inherits rlmLoop's 30-iteration default and loops long past the point of
 * usefulness (observed: a single-step triage agent burning 30 iterations and
 * 157s, and getting the answer wrong). An explicit `budget.max_iterations`
 * always wins over the shape default.
 */
export function agentMaxIterations(agent) {
    const explicit = agent.spec.budget?.maxIterations;
    if (explicit !== undefined)
        return explicit;
    return agent.spec.shape === "single-step" ? 1 : undefined;
}
/**
 * Apply an agent's `agent.yaml` to the ambient config for one run.
 *
 * An agent's `model:` re-pins the sub-call model too. Spreading `config.model`
 * alone kept the *ambient* `rlmx.yaml`'s `sub-call-model` while replacing
 * provider and model, so an agent declaring `khal/deepseek-v4-flash` under a
 * root whose yaml says `sub-call-model: gemini-3.1-flash-lite-preview`
 * composed `provider: khal` with a Google model id, and every bare
 * `llm_query(p)` came back `Unknown model "gemini-3.1-flash-lite-preview" for
 * provider "khal"`. `agent.yaml` has no sub-call-model key of its own, so the
 * agent's model is the only sensible default.
 */
export function applyAgent(config, agent) {
    const next = { ...config };
    // Unchanged from before: a model string with no provider prefix is ignored.
    if (agent.spec.model && splitModel(agent.spec.model)) {
        next.model = applyModelRef(config.model, agent.spec.model);
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
    if (!splitModel(model))
        return config;
    return { ...config, model: applyModelRef(config.model, model) };
}
function formatCost(cost) {
    if (cost <= 0)
        return "$0.00";
    if (cost < 0.01)
        return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
}
function formatFooter(label, config, result, elapsedMs, sessionId) {
    const tokensIn = result.usage.inputTokens.toLocaleString("en-US");
    const tokensOut = result.usage.outputTokens.toLocaleString("en-US");
    const model = `${config.model.provider}/${config.model.model}`;
    const seconds = (elapsedMs / 1000).toFixed(1);
    const budget = result.budgetHit ? ` · budget hit: ${result.budgetHit}` : "";
    // The session id is echoed in prose as well as structuredContent: a host
    // that renders only the text block still shows the model how to follow up.
    return (`rlmx · ${label} · ${model} · ${result.iterations} iteration` +
        `${result.iterations === 1 ? "" : "s"} · ${tokensIn} in / ${tokensOut} out ` +
        `· ${formatCost(result.usage.totalCost)} · ${seconds}s${budget}` +
        ` · session ${sessionId}`);
}
/**
 * Result of a call that never reached a session: bad arguments, unknown tool,
 * unusable `session_id`. No `structuredContent`, because there is no session id
 * to put in it and the declared schema requires one — legal precisely because
 * these are all `isError`, and the schema binds only non-error results.
 */
export function textResult(text, isError = false) {
    return { content: [{ type: "text", text }], isError };
}
/** Trimmed string argument; "" when absent, blank, or not a string. */
function readArg(value) {
    return typeof value === "string" ? value.trim() : "";
}
/**
 * Result of a call that reached a session, success or failure alike. Declaring
 * `outputSchema` obliges a non-error result to carry `structuredContent`; an
 * error carries it too, so a caller can retry on the same session.
 *
 * `answer` is the *same string* as the text block, byte for byte, rather than
 * the bare answer with the footer stripped. Two reasons: a host that reads the
 * structured channel and ignores `content` must still see the token/cost
 * footer, or the offload stops being visible in the transcript — the property
 * this server exists to preserve; and one string mirrored into both channels
 * cannot drift, where two derived strings eventually do.
 */
export function sessionResult(text, sessionId, isError = false) {
    return {
        content: [{ type: "text", text }],
        structuredContent: { answer: text, session_id: sessionId },
        isError,
    };
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
/**
 * Did `rlmLoop` hand back a failure instead of an answer?
 *
 * Only rlmLoop's `throw` path reaches the catch in the call handler. Its two
 * non-throwing failures — the consecutive-empty-response abort and the
 * wall-clock timeout — *return* normally with their reason as an `Error: …`
 * answer (`src/rlm.ts`). Reported as a success, the host model reads "Error:
 * aborted after 3 consecutive empty LLM responses" as the delegated agent's
 * report. `src/cli.ts` already treats that same shape as a failed run (exit 1
 * on `empty_responses`); this is the MCP equivalent.
 *
 * The answer prefix is the discriminator, deliberately not `budgetHit`, which
 * is wrong in both directions: a timeout that spent no budget leaves it null,
 * while a genuine `max-cost`/`max-tokens`/`max-depth` hit forces a real final
 * answer — a shorter report, not a failure — which must stay `isError: false`.
 */
export function isFailedAnswer(answer) {
    return answer.startsWith("Error: ");
}
/**
 * Run one turn. `query` is already the resume-folded prompt; `prompt` is the
 * caller's own text, which is what gets recorded as the turn (a preamble must
 * never be replayed inside the next preamble).
 */
async function runTurn(config, label, query, sessionId, contextPath, cwd, progress, maxIterations) {
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
    let lastProgressAt = Date.now();
    const emit = progress
        ? (message) => {
            lastProgressAt = Date.now();
            progress(message);
        }
        : undefined;
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
                            emit?.(`${label} · iteration ${iterations}`);
                            break;
                        case "Recurse":
                            spawns += 1;
                            emit?.(`${label} · iteration ${iterations} · ${spawns} recursive spawn${spawns === 1 ? "" : "s"}`);
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
    // Heartbeat. Event-driven progress alone is not enough: a `single-step`
    // agent emits exactly one IterationStart and then goes quiet for the whole
    // call, so a slow local model silently blows past the client's deadline —
    // observed as MCP -32001 on a 402-line log. Tick on a timer so liveness does
    // not depend on the agent's shape. `unref` so it can never hold the process
    // open.
    let heartbeat;
    if (progress) {
        heartbeat = setInterval(() => {
            const idleMs = Date.now() - lastProgressAt;
            if (idleMs < HEARTBEAT_MS)
                return; // real events already kept it alive
            emit?.(`${label} · working ${Math.round((Date.now() - started) / 1000)}s`);
        }, HEARTBEAT_MS);
        heartbeat.unref();
    }
    try {
        // output: "json" keeps rlmLoop off its stream-mode stdout path, which the
        // MCP transport owns.
        const result = await rlmLoop(query, context, config, {
            output: "json",
            ...(emitter ? { emitter } : {}),
            ...(maxIterations !== undefined ? { maxIterations } : {}),
            ...runTimeout(),
        });
        const footer = formatFooter(label, config, result, Date.now() - started, sessionId);
        return {
            answer: result.answer,
            text: `${result.answer}\n\n---\n${footer}`,
            failed: isFailedAnswer(result.answer),
        };
    }
    finally {
        if (heartbeat)
            clearInterval(heartbeat);
    }
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
    const registry = createAgentRegistry(() => discoverAgents(cwd));
    const sessions = new McpSessionStore();
    // Seed the baseline before connecting, so the first tools/list is not
    // reported as a change.
    const initial = await registry.refresh();
    process.stderr.write(`rlmx mcp: ${initial.agents.length} microagent${initial.agents.length === 1 ? "" : "s"} discovered` +
        `${initial.agents.length ? ` (${initial.agents.map((a) => a.name).join(", ")})` : ""}\n`);
    const server = new Server({ name: "rlmx", version: VERSION }, 
    // listChanged is declared because it is genuinely emitted — a capability
    // claimed and never honored is worse than none at all.
    { capabilities: { tools: { listChanged: true } } });
    /**
     * Re-scan on every request. Agents are directories an agent (human or model)
     * creates mid-session, so a tool set frozen at connect time is wrong within
     * seconds; the client is told about a change even when it learned of it by
     * asking, because the *call* path re-scans too.
     */
    const refresh = async () => {
        const scan = await registry.refresh();
        if (scan.changed) {
            if (scan.removed.length > 0)
                sessions.evictTools(scan.removed);
            try {
                await server.sendToolListChanged();
            }
            catch {
                // Not connected yet, or the client went away — never fail the request.
            }
        }
        return scan;
    };
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const scan = await refresh();
        return { tools: buildToolList(scan.agents) };
    });
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
        // Dispatch off the SAME scan that feeds tools/list: an agent authored a
        // moment ago is callable on its first appearance, and one deleted a moment
        // ago is not callable even though the client's cached list still shows it.
        const scan = await refresh();
        const agent = name === GENERIC_TOOL ? undefined : scan.byToolName.get(name);
        if (name !== GENERIC_TOOL && !agent) {
            // Agent deleted mid-session: "Unknown tool" wins over any session the
            // caller may hold, and the orphaned sessions go with it.
            sessions.evictTools([name]);
            return textResult(`Unknown tool: ${name}`, true);
        }
        const promptArg = readArg(args?.prompt);
        const queryArg = readArg(args?.query);
        if (promptArg && queryArg) {
            return textResult(`${name}: pass "prompt" on its own — "query" is a deprecated alias for ` +
                `"prompt", so supplying both is ambiguous.`, true);
        }
        const prompt = promptArg || queryArg;
        if (!prompt) {
            return textResult(`${name}: "prompt" is required and must be a non-empty string ` +
                `("query" is still accepted as a deprecated alias).`, true);
        }
        const contextPath = readArg(args?.context);
        // ── session resolution ────────────────────────────────────────────────
        const requestedSession = readArg(args?.session_id);
        let session;
        if (requestedSession) {
            const existing = sessions.get(requestedSession);
            if (!existing) {
                return textResult(`${name}: unknown or expired session_id "${requestedSession}". Sessions ` +
                    `are in-process and time-limited; omit session_id to start a new one.`, true);
            }
            if (existing.toolName !== name) {
                return textResult(`${name}: session_id "${requestedSession}" belongs to ${existing.toolName}. ` +
                    `A session cannot be moved between tools — omit session_id to start ` +
                    `one on ${name}.`, true);
            }
            if (existing.busy) {
                return textResult(`${name}: session ${requestedSession} is busy — a call on it is already ` +
                    `in flight. rlmx serializes calls per session; retry once it returns.`, true);
            }
            session = existing;
        }
        else {
            session = sessions.create(name);
        }
        session.busy = true;
        try {
            const baseConfig = await loadConfig(cwd);
            // Resume is conversation replay, not REPL state: every call builds a
            // fresh rlmLoop, and the prior turns ride in with the prompt.
            const query = buildResumeQuery(session.turns, prompt);
            let outcome;
            if (agent) {
                outcome = await runTurn(applyAgent(baseConfig, agent), `agent=${agent.name}`, query, session.id, contextPath, cwd, progress, agentMaxIterations(agent));
            }
            else {
                const override = readArg(args?.model);
                const config = override ? applyModelOverride(baseConfig, override) : baseConfig;
                outcome = await runTurn(config, "query", query, session.id, contextPath, cwd, progress);
            }
            // The turn is recorded either way: an aborted turn is still history the
            // follow-up may need to reference, and the caller was told it happened.
            sessions.record(session, { prompt, answer: outcome.answer });
            return sessionResult(outcome.text, session.id, outcome.failed);
        }
        catch (err) {
            // A failing run must fail only this tool call, never the server process.
            // The session survives so the caller can retry on it.
            const message = err instanceof Error ? err.message : String(err);
            return sessionResult(`rlmx ${name} failed: ${message}`, session.id, true);
        }
        finally {
            session.busy = false;
        }
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // Do not crash if the client closes the pipe early.
    process.stdout.on("error", () => process.exit(0));
}
//# sourceMappingURL=server.js.map