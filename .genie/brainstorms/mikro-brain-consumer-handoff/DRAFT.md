# Draft: brain consumer handoff decomposition (2026-09-03)

| Field | Value |
|-------|-------|
| **Slug** | `mikro-brain-consumer-handoff` |
| **Date** | 2026-09-03 |
| **Status** | NON-EXECUTABLE decomposition record — never pass to `wish` |
| **Source** | `/home/genie/workspace/repos/mikro/.genie/HANDOFF-brain-consumer-2026-09-03.md` (brain-side agent, mikro 1.260903.1 @ `14bf5e8`) |

## Why this is a decomposition, not a design

The handoff lists ten items across at least seven independent subsystems
(MCP backend, SDK tool loaders/driver, agent discovery, provider transport,
REPL answer parsing, batch runner, stats store, citations, SDK budget,
release/compat docs). Assumptions for one do not hold for another, and each
could ship or be staffed independently. Per the brainstorm scope-size rule
the umbrella is split; every child below gets its own brainstorm and its own
wish.

## Code-verified findings (worktree @ `14bf5e8`)

- `src/mcp/backends/legacy.ts:29-33` — `LegacyMikroBackend.run(_agent, …)` ignores the agent entirely; `agent.spec.tools` is never read. Confirms M1.
- `src/mcp/backends/prime-sdk.ts:675-731` — only the `prime-sdk` backend calls `loadPluginTools`/`loadPythonPlugins`, and it throws at *run* time (not at `tools/list`) on unresolved names. Confirms M1 cause.
- `src/sdk/tool-loader.ts:162`, `src/sdk/python-plugin.ts:318`, `src/sdk/rtk-plugin.ts:132` — all three `registry.register(name, handler)` with no schema. `src/sdk/rlm-driver.ts:287-290` — `rlmDriver` picks the tool-dispatch branch only when `listSchemas().length > 0`, otherwise silently builds the one-shot driver. Confirms M2.
- `src/mcp/agents.ts:104-119` — five fixed roots, later wins; `MIKRO_AGENTS_DIR` replaces all. `discoverAgents`/`agentRoots` are exported from `src/mcp/agents.ts` but not from `src/index.ts` or `src/sdk/index.ts`. No origin on `Microagent`. Confirms M3.
- Existing precedent to reuse: `validateAgentModels` → `Microagent.modelProblem` → `describeAgent` renders `UNAVAILABLE — …` and `tools/call` refuses (`src/mcp/server.ts:186-190, 919-921, 989-992`).
- Existing bridge to reuse: the REPL already round-trips `llm_request`/`llm_response` between Python and Node (`python/repl_server.py:18`, `python/llm_bridge.py:22-50`, `src/repl.ts:443-466`). Legacy-engine tools are Python code strings injected via `REPL.execute` (`src/repl.ts:170-174`) and listed in the system prompt by `buildCustomToolsSection` (`src/rlm.ts:189-205`).

## Children (ordered by how hard each blocks brain's cutover)

| # | Child slug | Handoff items | Purpose | Depends on |
|---|------------|---------------|---------|------------|
| 1 | `mikro-declared-tools-truth` | M1, M2 | Declared `tools:` actually run on the default backend, carry schemas, and a tool that cannot be resolved is advertised `UNAVAILABLE` instead of silently dropped. | — |
| 2 | `mikro-host-agent-roots` | M3 | Additive host-shipped agent root with documented precedence, SDK export for discovery/registration, visible origin and shadow warning in `tools/list`. | — (shares `src/mcp/agents.ts` with child 1's `unavailable` field, which replaces `modelProblem`; sequence after 1 to avoid merge churn) |
| 3 | `mikro-provider-error-truth` | M4 | Transport/provider failures surfaced (status + body) in `--verbose`, `--log`, and the `Error` step; never counted toward the empty-response budget. | — |
| 4 | `mikro-final-answer-hygiene` | M5 | `FINAL(<expr>)` evaluated in the REPL or rejected with a retry hint; forced-final path never leaks the `FINAL(` wrapper into `answer`. | — |
| 5 | `mikro-batch-per-question-isolation` | M6 | One REPL timeout fails one question, not the file; aggregate reports answered/failed. Check overlap with the Ready design `mikro-orchestration-cli-truth` before brainstorming. | — |
| 6 | `mikro-stats-file-store` | M7 | `mikro stats` reads `~/.mikro/sessions/*` when pgserve is absent. | — |
| 7 | `mikro-structured-references` | M8 | Structured `references` from the loop (chunk/file ids read via REPL) or a documented `VALIDATE.md` pattern that forces the array. | 4 (shares the FINAL/answer path) |
| 8 | `mikro-runagent-budget-enforcement` | M9 | `AgentConfig.budget` decremented and enforced in `runAgent`, or a documented hook point. | — |
| 9 | `mikro-sdk-compat-contract` | M10 | `docs/sdk-compat.md` per-tag export-level breaking changes plus a consumer smoke fixture (`runAgent` + `rlmDriver` + registry loop). | 1, 8 (fixture must exercise their exports) |

Small confirmations from the handoff (no child): `mikro migrate` scope is brain's job; `checkModelConfig` on `gemini-3.1-flash-lite-preview` — fold into child 3 as a question; `docs/sdk-overview.md:112-135` stale `mikro-bridge.ts` path — one-line doc fix, can ride with child 9.

## First brainstorm started

Child 1 — see `.genie/brainstorms/mikro-declared-tools-truth/DRAFT.md`.
