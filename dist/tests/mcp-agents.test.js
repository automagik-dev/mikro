/**
 * Microagent discovery gate — `rlmx mcp`.
 *
 * Deterministic, no-LLM proofs for the discovery contract that a live MCP
 * smoke cannot pin down precisely:
 *   1. Tool names are MCP-legal (`^[a-zA-Z0-9_-]{1,128}$`) for hostile
 *      directory names — an illegal name would make the whole tools/list
 *      response invalid, not just that one agent.
 *   2. Root precedence: a project agent shadows a global agent of the same
 *      name, so a repo can override a machine-wide default.
 *   3. A broken agent.yaml is skipped rather than taking down the server.
 *   4. Descriptions are never empty — an empty description makes an agent
 *      effectively invisible to the host model.
 *   5. The live-refresh seam: a re-scan rebuilds the advertised list and the
 *      call lookup together, and reports a set change exactly once.
 *   6. The session seam: TTL expiry, LRU eviction, per-tool orphan eviction,
 *      turn-history bounding, and the resume fold — all the parts a live smoke
 *      cannot force deterministically.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents, splitModel, toToolName } from "../src/mcp/agents.js";
import { agentMaxIterations, buildResumeQuery, createAgentRegistry, McpSessionStore, } from "../src/mcp/server.js";
const MCP_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;
function writeAgent(root, name, yamlBody, system) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent.yaml"), yamlBody, "utf-8");
    if (system !== undefined) {
        writeFileSync(join(dir, "SYSTEM.md"), system, "utf-8");
    }
}
describe("toToolName", () => {
    it("produces MCP-legal names for hostile directory names", () => {
        const hostile = [
            "test writer",
            "Triage/Agent",
            "brain.l1-triage",
            "über-agent",
            "___",
            "a".repeat(200),
        ];
        for (const name of hostile) {
            const tool = toToolName(name);
            assert.match(tool, MCP_TOOL_NAME, `${JSON.stringify(name)} produced illegal tool name ${JSON.stringify(tool)}`);
            assert.ok(tool.startsWith("rlmx_"), `${tool} lost its prefix`);
        }
    });
    it("never collapses to a bare prefix", () => {
        // "___" sanitizes to empty; it must still yield a usable tool name.
        assert.equal(toToolName("___"), "rlmx_agent");
    });
});
describe("splitModel", () => {
    it("splits provider/model on the first slash", () => {
        assert.deepEqual(splitModel("station/Brain-35B"), {
            provider: "station",
            model: "Brain-35B",
        });
        // Model ids may themselves contain slashes.
        assert.deepEqual(splitModel("openai/org/model-v1"), {
            provider: "openai",
            model: "org/model-v1",
        });
    });
    it("returns null when there is no usable provider prefix", () => {
        for (const bad of ["gemini-2.5-flash", "/leading", "trailing/", ""]) {
            assert.equal(splitModel(bad), null, `expected null for ${JSON.stringify(bad)}`);
        }
    });
});
describe("discoverAgents", () => {
    let tmp;
    let globalRoot;
    let projectRoot;
    const prevEnv = process.env.RLMX_AGENTS_DIR;
    before(() => {
        tmp = mkdtempSync(join(tmpdir(), "rlmx-mcp-agents-"));
        globalRoot = join(tmp, "global");
        projectRoot = join(tmp, "project");
        mkdirSync(globalRoot, { recursive: true });
        mkdirSync(projectRoot, { recursive: true });
        // Same name in both roots — project must win.
        writeAgent(globalRoot, "triage", "schema_version: 1\nshape: single-step\nmodel: google/gemini-2.5-flash\n", "Global triage agent.\n");
        writeAgent(projectRoot, "triage", "schema_version: 1\nshape: loop\nmodel: station/Brain-35B\nsystem: SYSTEM.md\n", "# triage\n\nProject triage agent that classifies inbound issues.\n");
        writeAgent(projectRoot, "test writer", "schema_version: 1\nshape: recurse\ndescription: Writes unit tests for a module.\n");
        // Malformed YAML must not abort discovery of its siblings.
        const brokenDir = join(projectRoot, "broken");
        mkdirSync(brokenDir, { recursive: true });
        writeFileSync(join(brokenDir, "agent.yaml"), "shape: [unclosed\n", "utf-8");
        // A directory with no agent.yaml at all is simply not an agent.
        mkdirSync(join(projectRoot, "not-an-agent"), { recursive: true });
        process.env.RLMX_AGENTS_DIR = `${globalRoot}:${projectRoot}`;
    });
    after(() => {
        if (prevEnv === undefined)
            delete process.env.RLMX_AGENTS_DIR;
        else
            process.env.RLMX_AGENTS_DIR = prevEnv;
        rmSync(tmp, { recursive: true, force: true });
    });
    it("skips broken and non-agent directories without failing", async () => {
        const agents = await discoverAgents(tmp);
        const names = agents.map((a) => a.name);
        assert.ok(!names.includes("broken"), "broken agent.yaml should be skipped");
        assert.ok(!names.includes("not-an-agent"), "dir without agent.yaml is not an agent");
        assert.deepEqual(names, ["test writer", "triage"], "expected stable sorted order");
    });
    it("lets a project agent shadow a global agent of the same name", async () => {
        const agents = await discoverAgents(tmp);
        const triage = agents.find((a) => a.name === "triage");
        assert.ok(triage, "triage agent missing");
        assert.equal(triage.spec.model, "station/Brain-35B", "project agent should win");
        assert.equal(triage.spec.shape, "loop");
    });
    it("gives every agent a legal tool name and a non-empty description", async () => {
        const agents = await discoverAgents(tmp);
        assert.ok(agents.length > 0);
        for (const agent of agents) {
            assert.match(agent.toolName, MCP_TOOL_NAME, `${agent.name} -> ${agent.toolName}`);
            assert.ok(agent.summary.trim().length > 0, `${agent.name} has an empty summary and would be invisible to the host model`);
        }
        const tools = agents.map((a) => a.toolName);
        assert.equal(new Set(tools).size, tools.length, "tool names must be unique");
    });
    it("prefers an explicit description over the system prompt", async () => {
        const agents = await discoverAgents(tmp);
        const writer = agents.find((a) => a.name === "test writer");
        assert.ok(writer);
        assert.equal(writer.summary, "Writes unit tests for a module.");
        assert.equal(writer.toolName, "rlmx_test_writer");
    });
    it("falls back to the system prompt, skipping a heading that repeats the name", async () => {
        const agents = await discoverAgents(tmp);
        const triage = agents.find((a) => a.name === "triage");
        assert.ok(triage);
        assert.equal(triage.summary, "Project triage agent that classifies inbound issues.");
    });
});
/**
 * Iteration-cap regression. Two bugs found by dogfooding a real triage agent:
 *   1. `shape` was ignored entirely, so a single-step agent inherited
 *      rlmLoop's 30-iteration default — 30 iterations and 157s for one pass.
 *   2. An explicit `budget.max_iterations` must still win over the shape
 *      default, or a `loop` agent has no way to bound itself.
 */
describe("agentMaxIterations", () => {
    const asAgent = (shape, maxIterations) => ({
        name: "t",
        toolName: "rlmx_t",
        dir: "/tmp/t",
        summary: "t",
        spec: {
            dir: "/tmp/t",
            schemaVersion: 1,
            toolsApi: 1,
            shape,
            tools: [],
            extras: {},
            ...(maxIterations === undefined ? {} : { budget: { maxIterations } }),
        },
    });
    it("caps a single-step agent at one iteration", () => {
        assert.equal(agentMaxIterations(asAgent("single-step")), 1);
    });
    it("leaves loop and recurse agents uncapped by default", () => {
        assert.equal(agentMaxIterations(asAgent("loop")), undefined);
        assert.equal(agentMaxIterations(asAgent("recurse")), undefined);
    });
    it("lets an explicit budget.max_iterations win over the shape default", () => {
        assert.equal(agentMaxIterations(asAgent("single-step", 5)), 5);
        assert.equal(agentMaxIterations(asAgent("loop", 6)), 6);
    });
});
/** Minimal stand-in for a discovered agent — the registry only reads names. */
function fakeAgent(name, model = "station/Brain-35B") {
    return {
        name,
        toolName: toToolName(name),
        dir: `/tmp/${name}`,
        summary: `${name} agent`,
        spec: {
            dir: `/tmp/${name}`,
            schemaVersion: 1,
            toolsApi: 1,
            shape: "loop",
            tools: [],
            extras: {},
            model,
        },
    };
}
/**
 * Live-refresh seam. The failure this designs out is a tool that is listed but
 * not callable: `tools/list` and `tools/call` must be answered from the same
 * scan, and a set change must be reported once — not once per request.
 */
describe("createAgentRegistry", () => {
    it("seeds the baseline on the first scan without reporting a change", async () => {
        const registry = createAgentRegistry(async () => [fakeAgent("triage")]);
        const first = await registry.refresh();
        assert.equal(first.changed, false, "a fresh connect must not emit list_changed");
        assert.deepEqual(first.removed, []);
        assert.deepEqual(first.agents.map((a) => a.name), ["triage"]);
    });
    it("rebuilds the call lookup from the same scan that produced the list", async () => {
        let agents = [fakeAgent("triage")];
        const registry = createAgentRegistry(async () => agents);
        await registry.refresh();
        agents = [fakeAgent("triage"), fakeAgent("explore")];
        const scan = await registry.refresh();
        for (const agent of scan.agents) {
            assert.equal(scan.byToolName.get(agent.toolName), agent, `${agent.toolName} is advertised but missing from the call lookup`);
        }
        assert.equal(scan.byToolName.size, scan.agents.length);
        assert.ok(scan.byToolName.has("rlmx_explore"), "the new agent must be callable at once");
    });
    it("reports an added agent once, then goes quiet", async () => {
        let agents = [fakeAgent("triage")];
        const registry = createAgentRegistry(async () => agents);
        await registry.refresh();
        agents = [fakeAgent("triage"), fakeAgent("explore")];
        assert.equal((await registry.refresh()).changed, true);
        assert.equal((await registry.refresh()).changed, false, "a static set must not produce repeat notifications");
    });
    it("reports a removed agent and names it for orphan eviction", async () => {
        let agents = [fakeAgent("triage"), fakeAgent("explore")];
        const registry = createAgentRegistry(async () => agents);
        await registry.refresh();
        agents = [fakeAgent("triage")];
        const scan = await registry.refresh();
        assert.equal(scan.changed, true);
        assert.deepEqual(scan.removed, ["rlmx_explore"]);
        assert.equal(scan.byToolName.has("rlmx_explore"), false, "a deleted agent must stop dispatching");
    });
    it("treats a modified spec as unchanged — the set is the same", async () => {
        let agents = [fakeAgent("triage", "station/Brain-35B")];
        const registry = createAgentRegistry(async () => agents);
        await registry.refresh();
        agents = [fakeAgent("triage", "khal/deepseek-v4-flash")];
        const scan = await registry.refresh();
        assert.equal(scan.changed, false, "an edited agent.yaml is not a tool-set change");
        // …but the current spec is what gets dispatched.
        assert.equal(scan.byToolName.get("rlmx_triage")?.spec.model, "khal/deepseek-v4-flash");
    });
    it("reports a concurrent double-scan of the same change only once", async () => {
        let agents = [fakeAgent("triage")];
        const registry = createAgentRegistry(async () => agents);
        await registry.refresh();
        agents = [fakeAgent("triage"), fakeAgent("explore")];
        const [a, b] = await Promise.all([registry.refresh(), registry.refresh()]);
        assert.equal([a.changed, b.changed].filter(Boolean).length, 1, "two requests racing on one change must emit list_changed once");
    });
    /**
     * Out-of-order scan completion. Two refreshes race; the later-started scan's
     * continuation runs first. Unserialized, the earlier scan then overwrites the
     * baseline with its older tool set: a live agent is reported `removed` (its
     * sessions get evicted) and re-announced as added on the next refresh. Driven
     * deterministically here — `scan` hands out deferreds and the driver resolves
     * the newest pending one first, so nothing depends on timing.
     */
    it("never reports a false removal when scans complete out of order", async () => {
        const triage = fakeAgent("triage");
        const explore = fakeAgent("explore");
        // Per scan call, in call order: the seed, then a stale [triage] alongside
        // the fresh [triage, explore] that must win, then the settled set.
        const byCall = [[triage], [triage], [triage, explore], [triage, explore]];
        let calls = 0;
        const pending = [];
        const registry = createAgentRegistry(() => new Promise((resolve) => {
            const value = byCall[Math.min(calls++, byCall.length - 1)];
            pending.push(() => resolve(value));
        }));
        /** Settle `p`, releasing pending scans newest-first (i.e. out of order). */
        async function drive(p) {
            let done = false;
            const tracked = p.then((v) => {
                done = true;
                return v;
            }, (e) => {
                done = true;
                throw e;
            });
            for (let i = 0; !done; i++) {
                assert.ok(i < 100, "refresh never settled");
                await new Promise((r) => setImmediate(r));
                pending.pop()?.();
            }
            return tracked;
        }
        await drive(registry.refresh());
        const [a, b] = await drive(Promise.all([registry.refresh(), registry.refresh()]));
        const after = await drive(registry.refresh());
        for (const scan of [a, b, after]) {
            assert.deepEqual(scan.removed, [], "a live agent must never be reported removed");
        }
        assert.equal([a, b].filter((s) => s.changed).length, 1, "the added agent must be reported exactly once");
        assert.equal(after.changed, false, "no duplicate re-announcement on the next refresh");
        assert.ok(after.byToolName.has("rlmx_explore"), "the newest scan must win the baseline");
    });
});
/**
 * Session seam. Sessions are advisory — losing one costs a fresh start, never
 * correctness — but "advisory" is only safe if the map is genuinely bounded,
 * so TTL, LRU and turn caps are pinned here rather than trusted.
 */
describe("McpSessionStore", () => {
    it("binds a session to the tool that created it", () => {
        const store = new McpSessionStore();
        const session = store.create("rlmx_explore");
        assert.equal(session.toolName, "rlmx_explore");
        assert.equal(store.get(session.id)?.toolName, "rlmx_explore");
        assert.match(session.id, /^sess_[0-9a-f]{16}$/);
    });
    it("expires a session once its TTL has passed", () => {
        let now = 1_000;
        const store = new McpSessionStore({ ttlMs: 100, now: () => now });
        const session = store.create("rlmx_query");
        now = 1_099;
        assert.ok(store.get(session.id), "a session inside its TTL must survive");
        now = 1_300;
        assert.equal(store.get(session.id), undefined, "an idle session must expire");
        assert.equal(store.size, 0, "an expired session must be swept, not just hidden");
    });
    it("keeps a session alive while it is being used", () => {
        let now = 1_000;
        const store = new McpSessionStore({ ttlMs: 100, now: () => now });
        const session = store.create("rlmx_query");
        now = 1_050;
        store.get(session.id); // a use refreshes the clock
        now = 1_120;
        assert.ok(store.get(session.id), "a recently-used session must not expire");
    });
    it("evicts the least-recently-used session at the size cap", () => {
        let now = 0;
        const ids = [];
        const store = new McpSessionStore({ maxSessions: 3, now: () => ++now });
        for (let i = 0; i < 3; i++)
            ids.push(store.create("rlmx_query").id);
        store.get(ids[1]); // touch the middle one so the oldest is ids[0]
        const fresh = store.create("rlmx_query");
        assert.equal(store.size, 3, "the cap must hold");
        assert.equal(store.get(ids[0]), undefined, "the least-recently-used session goes first");
        assert.ok(store.get(ids[1]), "a recently-touched session survives");
        assert.ok(store.get(fresh.id));
    });
    it("never evicts a session with a call in flight", () => {
        let now = 0;
        const store = new McpSessionStore({ maxSessions: 2, now: () => ++now });
        const busy = store.create("rlmx_query");
        busy.busy = true;
        const idle = store.create("rlmx_query");
        store.create("rlmx_query");
        assert.ok(store.get(busy.id), "an in-flight session must not be evicted under it");
        assert.equal(store.get(idle.id), undefined, "the idle session is the eviction candidate");
    });
    it("does not expire a session while its call is in flight", () => {
        let now = 1_000;
        const store = new McpSessionStore({ ttlMs: 10, now: () => now });
        const session = store.create("rlmx_query");
        session.busy = true;
        now = 5_000;
        assert.ok(store.get(session.id), "a long call must not have its own session swept");
    });
    it("evicts orphans when their agent disappears", () => {
        const store = new McpSessionStore();
        const gone = store.create("rlmx_explore");
        const kept = store.create("rlmx_query");
        assert.equal(store.evictTools(["rlmx_explore"]), 1);
        assert.equal(store.get(gone.id), undefined, "a deleted agent's sessions are unreachable");
        assert.ok(store.get(kept.id), "sessions on surviving tools are untouched");
    });
    it("bounds the turn history it retains", () => {
        const store = new McpSessionStore({ maxTurns: 2 });
        const session = store.create("rlmx_query");
        for (const n of ["one", "two", "three"]) {
            store.record(session, { prompt: n, answer: `${n}!` });
        }
        assert.deepEqual(session.turns.map((t) => t.prompt), ["two", "three"], "the oldest turns drop out; the map cannot grow without bound");
    });
});
/** The resume mechanism: conversation replay, not live REPL state. */
describe("buildResumeQuery", () => {
    it("passes the first turn of a session through untouched", () => {
        assert.equal(buildResumeQuery([], "what does agents.ts do?"), "what does agents.ts do?");
    });
    it("folds prior turns in ahead of the new prompt", () => {
        const out = buildResumeQuery([{ prompt: "remember the codeword BANANA47", answer: "Noted: BANANA47." }], "what was the codeword?");
        assert.match(out, /continuing conversation/);
        assert.match(out, /BANANA47/);
        assert.ok(out.trimEnd().endsWith("what was the codeword?"), "the new prompt comes last");
    });
    it("char-caps each replayed field so the preamble cannot run away", () => {
        const out = buildResumeQuery([{ prompt: "p".repeat(10_000), answer: "a".repeat(10_000) }], "next");
        assert.ok(out.length < 8_000, `preamble grew to ${out.length} chars`);
        assert.match(out, /…/);
    });
});
//# sourceMappingURL=mcp-agents.test.js.map