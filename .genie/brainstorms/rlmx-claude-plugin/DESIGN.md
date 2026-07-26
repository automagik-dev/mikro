# Design: rlmx Claude Code Plugin — Workspace Microagents That Offload Premium Quota

| Field | Value |
|-------|-------|
| **Slug** | `rlmx-claude-plugin` |
| **Date** | 2026-07-26 (rev 5: isomorphism amendment corrected per rcp-04 — resume is conversation replay, not REPL state; post rcp-01…04) |
| **WRS** | 100/100 |

## Problem

Claude Code burns premium-model quota on repeatable, spec-driven delegation.
Measured on this host over 7 days (58 transcripts): 3.09B input+cacheRead
tokens across 13,105 turns, of which 12,988 (99%) ran on Fable/Opus tier;
245 subagent spawns — genie:reviewer x121, engineers x60, fixer x33,
general-purpose x15, Explore x9, final-gate x7. In a 48h sample window,
inline exploration Bash (grep/sed/cat/ls/tail dumps) produced 28% of all
tool-result bytes. rlmx already has the offload primitive (microagents as MCP
tools via `rlmx mcp`, workspace-first discovery) but no workload-derived
agents, no live tool refresh, no host-side guidance telling Claude *when* to
delegate, and no evidence for *which* cheap model to delegate to.

## Program shape: two wishes

Design review rcp-01 (M9) confirmed the scope exceeds one wish. This design
covers the program; it pours as two sequenced wishes:

- **Wish A — `rlmx-explore-offload`**: khal provider, MCP live refresh
  (list *and* call path), the `explore` microagent, the explore parity loop.
  Ships when the parity gate passes.
- **Wish B — `rlmx-microagent-plugin`**: Claude Code plugin packaging,
  offload-guidance skill + routing criterion, `/microagent-create`
  (propose-only), the khal model shootout, legacy-agent archival.
  Depends on Wish A.

## Scope

### IN (Wish A)
- **`khal` provider** in rlmx: LiteLLM gateway at `https://llm.khal.ai/v1`
  (OpenAI-compatible), key from env (`KHAL_API_KEY`, fallback
  `RLMX_KHAL_API_KEY`); never written to any repo file.
  - Model discovery *and cost*: the overlay fetches LiteLLM's `/model/info`
    (not just `/v1/models`) and populates each model's `cost` block from
    `input_cost_per_token` / `output_cost_per_token` / cache fields
    **multiplied by 1e6** — LiteLLM prices per single token while pi-ai's
    `Model.cost` is dollars per million tokens
    (`pi-ai/dist/models.js:384` divides by 1,000,000 at usage time). The
    conversion is covered by a fixture test asserting a known gateway
    payload yields the expected `$/Mtok` (deepseek-v4-flash `1e-7`/token →
    `0.10`), so `result.usage.totalCost` in the MCP footer
    (`src/mcp/server.ts:194`) and `budget.max_cost` guards are real. If
    `/model/info` is unreachable, models still resolve from `/v1/models`
    with `cost` zeroed and a one-line stderr warning.
  - **No-key behavior diverges from station deliberately** (station is local
    and keyless; khal is remote and authenticated): with no key in env the
    provider's auth `resolve()` reports unconfigured, there is no static
    baseline, and resolving `khal/<model>` fails fast with
    `khal provider requires KHAL_API_KEY` — never station's silent fallback.
    The guard lives at the resolution sites: the pre-resolution overlay hook
    (`ensureKhalModels`, mirroring `ensureStationModels` at `src/llm.ts` and
    `src/sdk/rlm-driver.ts`) throws the named error when
    `provider === "khal"` and no key is in env, *before* model lookup —
    otherwise the empty catalog would surface as a misleading
    "unknown model".
- **MCP live refresh — list and call path**: `discoverAgents` re-scans the
  roots on every `tools/list` *and* every `tools/call`; both the advertised
  list and the call-time lookup (`byToolName`, today built once at
  `src/mcp/server.ts:329` and consulted at `:385`) rebuild from the same
  scan, so a newly created agent is listed *and callable* without reconnect.
  When a re-scan detects a changed agent set, the server emits
  `notifications/tools/list_changed`; the `tools.listChanged` capability is
  declared because the server actually emits it (today: `{ tools: {} }`,
  `src/mcp/server.ts:338`). No fs-watcher in this wish — re-scan-on-request
  plus emit-on-change is the whole mechanism, and a readdir over ≤3 roots
  per request is negligible.
- **Agent-tool isomorphism** (user decision 2026-07-26): the MCP surface
  mirrors Claude Code's native Agent tool so the host model needs no new
  interaction pattern — the offload must feel like the delegation it
  already does. Per-agent tools are the `subagent_type` analogue; tool
  descriptions read like subagent spawns ("Spawn the <name> microagent …
  returns its final report").
  - **Input schema:** `prompt` is the primary param, `query` a deprecated
    alias (the shipped server uses it). Expressed as both properties
    optional in the schema (`required: []`) with runtime validation
    demanding exactly one — not `anyOf`, which MCP clients surface to
    models inconsistently, defeating the ergonomic point. Error messages
    name `prompt`. The existing smoke assertion that every tool requires
    `query` (`scripts/smoke-mcp.mjs:95-99`) is replaced by assertions of
    the new shape (prompt accepted, query accepted, both/neither
    rejected).
  - **Resume = conversation replay, not live REPL state.** Every result
    carries `session_id` (in `structuredContent`, echoed in the prose
    footer); a follow-up call passing `session_id` continues the agent by
    folding the bounded prior-turn history into the new query — the exact
    mechanism proven in `src/acp/agent.ts:298` (`buildConversationalQuery`,
    `PREAMBLE_TURNS`-bounded). Each call still runs a fresh `rlmLoop` with
    a fresh REPL (`src/rlm.ts:362` owns the subprocess end-to-end); REPL
    state is deliberately **not** preserved — explore-class context lives
    in files the agent re-reads on demand, and holding Python subprocesses
    across MCP calls would add subprocess-lifetime machinery to `rlm.ts`
    for no observable benefit at this layer. What *is* new here: the
    in-process session map itself (id → turn history) with TTL + size cap
    — the ACP store is durable-on-disk with count/mtime pruning, so the
    TTL map is this wish's own, unit-tested.
  - **Session rules:** an expired or unknown `session_id` returns a clear
    error, never a silent fresh start. Concurrent calls sharing a
    `session_id` are rejected with a "session busy" error (inheriting
    ACP's serialize-and-reject rule, `src/acp/agent.ts:269-274`), since
    MCP `tools/call` gives no serialization guarantee. Interaction with
    live refresh: if the agent was deleted mid-session, the tool-level
    "Unknown tool" error wins and the orphaned session is evicted; if the
    agent was modified mid-session, the resumed call uses the *current*
    spec (re-scan wins — sessions carry conversation, never spec pins).
  - **Deliberate divergence:** the native Agent tool has no session param —
    continuation there is a separate tool (SendMessage by agent id). MCP
    tools are a flat namespace, so same-tool `session_id` resume is the
    chosen adaptation, named here so "isomorphic" doesn't overclaim.
    Background execution (the `run_in_background` analogue) is likewise
    explicitly OUT — MCP is request/response and progress + heartbeat
    covers long calls; revisit if MCP grows a first-class task primitive.
- **`rlmx mcp --dir <dir>`** (reusing the CLI's existing `--dir <path>`
  directory flag, `src/cli.ts:76` — no second directory-flag convention):
  the server chdirs to the given directory at startup, making workspace
  discovery, `loadConfig(cwd)` (`src/mcp/server.ts:377`), relative `context`
  resolution (`:223`), and the REPL's inherited working directory all agree.
  This removes the "does the host spawn us in the project dir?" assumption
  instead of mitigating it: the plugin (Wish B) always passes the project
  dir; bare `claude mcp add rlmx -- rlmx mcp` relies on the host's cwd —
  **verified on Claude Code 2026-07-26**: both live `rlmx mcp` processes on
  this host show `/proc/<pid>/cwd` = the session's project directory, so
  bare registration works there; `--dir` is the contract for other hosts.
- **Extended `scripts/smoke-mcp.mjs`** (in this wish — it is the live-refresh
  proof): exercises the real workspace root (`<cwd>/.rlmx/agents/` via a
  temp cwd, no `RLMX_AGENTS_DIR` override — today the smoke sets the
  override, `scripts/smoke-mcp.mjs:66`, bypassing the precedence path),
  covers create-then-list-then-call mid-session plus the `list_changed`
  notification, and drops the now-wrong "tool count unchanged across lists"
  assertion (`scripts/smoke-mcp.mjs:113`).
- **The `explore` microagent** (workspace convention `<cwd>/.rlmx/agents/explore/`):
  answers a codebase question by searching/reading inside the REPL and returns
  the answer with `file:line` citations — never raw dumps. Shape `loop` with
  explicit `budget.max_iterations` (single-step + externalized context answers
  without reading — dogfood finding, PR #118). `<cwd>/.agents/` remains a
  supported alias root (it stays in `agentRoots`); docs promote
  `.rlmx/agents/` as the primary convention.
- **Explore parity loop**: mine the past-24h Claude session transcripts for
  real explore-class tasks. The first significant one seeds the improvement
  loop (iterate SYSTEM.md / budget / prompt until it passes); the suite then
  grows to **≥5 mined tasks** and the gate is scored on the full suite. The
  parity loop runs on the dogfood default models (D9:
  `khal/deepseek-v4-flash`, `station/<local>`); the suite is then frozen as
  the regression + shootout input for Wish B.
  - **Rubric (per task, fixed before scoring):** (1) required-facts
    checklist mined from what native Explore actually found — rlmx must find
    ≥90% of them; (2) every citation must resolve to a real `file:line`
    (checked mechanically); (3) zero fabricated paths/symbols — any
    fabrication fails the task. **Known asymmetry, deliberately
    conservative:** native defines the ground truth, so it scores 100% by
    construction and cannot be penalized for its own misses — the bias makes
    the gate *harder* for rlmx and can never manufacture a false pass.
  - **Gate:** `rlmx_explore` passes the suite when it passes ≥4 of 5 tasks
    (≥80% for larger suites). Quality parity is the gate.
  - **Failure branch:** if a task still fails after 3 prompt/budget tuning
    rounds on the current model, escalate the worker model one tier
    (flash → mimo-v2.5 → kimi-code → claude-haiku) and continue; if the
    suite cannot pass even on claude-haiku, stop, report the parity result
    honestly, and Wish B does not start — the thesis is falsified for the
    explore class rather than shipped anyway.
  - **Token accounting (reported, not gated):** premium-tokens-per-task =
    native arm: total input+cacheRead+output of the Explore subagent's
    turns from its transcript; rlmx arm: the main session's delta for the
    tool call (request + result bytes ÷ 4 estimate). Expected ≥80%
    reduction; the number is recorded per task in the parity report with
    this method stated. It is not the pass/fail bar because it is
    near-automatic — the discriminating bar is quality.

### IN (Wish B)
- **Claude Code plugin** in-repo (`plugins/claude-code/`): registers the MCP
  server (passing `--dir` with the project dir), ships the offload-guidance
  skill (when to route explore-class work to `rlmx_*`, when to escalate back
  to premium: "if the rlmx answer lacks citations or confidence, re-run
  natively"), and `/microagent-create` — propose-only: reads last-24h
  transcripts + token-optimizer session data, writes a draft `agent.yaml` +
  `SYSTEM.md` + an evidence file (token burn that motivates the agent), and
  stops for user approval. Creates nothing unapproved.
- **khal model shootout** on the frozen mined suite extended to **≥10 real
  tasks** (the ≥5 parity tasks plus additional mined explore/triage-class
  tasks): 6 khal arms (deepseek-v4-flash, mimo-v2.5, minimax-m3, kimi-code,
  glm-5.2, claude-haiku as quality reference) + station local as arm 0.
  Score correctness (same rubric), wall-time, and cost per task. The winner
  becomes the plugin's default worker model. **If the winner differs from
  the parity model, the parity suite is re-run once on the winner before it
  becomes default** (resolves the tune-vs-choose circularity, M9); if the
  winner fails that re-run, the parity-proven model stays default and the
  result is recorded in the shootout table.
- **Legacy agent archival (unconditional):** all three ad-hoc globals move
  out of `~/.rlmx/agents/` — `codebase-qa` is directly replaced by
  `explore`; `changelog` and `log-triage` are preserved as documented
  recipes under `examples/agents/` (their learnings are the recipe docs).
- Plugin-specific smoke additions only (the live-refresh smoke extension is
  Wish A's deliverable): plugin install + MCP registration round-trip.

### OUT
- npm publishing (access lost; SDK channel already decoupled — PR #117).
- ACP hosts beyond Claude Code / Codex / Hermes / CLI (settled 2026-07-25).
- **Aider polyglot stays owned by `rlmx-proof` (wish 2)** exactly as
  `.genie/INDEX.md` records; `rlmx-launch` (wish 3) remains blocked on
  proof's numbers. This program only reshapes proof's *arms* (khal models
  replace "cheap cloud") and contributes the shootout method. The shootout
  here is a separate lightweight bench whose only output is the plugin's
  default worker model.
- review-lite / git-historian microagents — first `/microagent-create`
  proposal candidates *after* explore reaches parity, not built here.
- Replacing genie: the plugin offloads worker lanes; genie stays orchestrator.
- LiteLLM management-API integration (virtual keys, team routing) — later.
- fs-watcher-based agent discovery — re-scan-on-request suffices.

## Approach

**Plugin-in-repo, explore-first, parity-gated, two wishes.** Wish A builds the
thinnest vertical slice that proves the offload thesis end to end: khal
provider → live refresh (list + call) → one excellent workspace microagent →
measured parity against native Explore on real mined tasks. Wish B packages
it for adoption: plugin, routing guidance (with its own measured criterion),
propose-only self-reflection, model shootout, archival. Every later
microagent inherits the conventions explore proves (loop shape, citation
contract, iteration budget, rubric method).

Alternatives considered:
- *Separate plugin repo* — cleaner boundaries, but version skew against the
  CLI and one more repo; rejected (D5): dogfooding wants one clone.
- *Genie-ecosystem plugin* — tightest fit with existing lanes but couples
  rlmx adoption to genie; kills viral spread to non-genie users; rejected.
- *Polyglot benchmark first* — market-comparable numbers but multi-day, needs
  checkpoint/resume, and doesn't answer "which worker model powers the
  plugin"; stays in rlmx-proof (D6/M10).
- *Auto-creating microagents* — fastest loop but reproduces exactly the agent
  sprawl the user rejected; propose-only (D7).
- *fs-watch for live refresh* — more machinery for the same observable
  behavior; re-scan per request + emit-on-change is simpler and sufficient.

Isolation: the provider touches only model resolution; live refresh touches
only the MCP server; the explore agent is data (`agent.yaml` + `SYSTEM.md`),
not code; the plugin consumes the public `rlmx mcp` surface; the bench
harness consumes the MCP tool surface. Each is independently testable.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Workspace-first microagents (`<cwd>/.rlmx/agents/` shadows global) as the plugin convention; `<cwd>/.agents/` stays a supported alias | Precedence already implemented (`src/mcp/agents.ts:56`); repos own their agents; global stays fallback; no breaking change for `.agents/` users |
| 2 | khal key via env only; recommend rotation after setup | Key transited chat; secrets never enter the repo |
| 3 | Microagents default to `loop` shape with explicit `max_iterations` | Dogfood-proven: single-step + externalized context answers without reading (241-token tell, PR #118) |
| 4 | First microagent = `explore`; quality parity with native Explore on ≥5 mined real tasks is the gate; token reduction is reported, not gated | Biggest context-growth class; user-selected; head-to-head is measurable; the token win is near-automatic so it cannot be the discriminator |
| 5 | Plugin lives in rlmx repo at `plugins/claude-code/` | One clone = CLI + plugin; versions move together; dogfood is a symlink |
| 6 | Bench = real microagent tasks now (default-model pick); Aider polyglot stays in rlmx-proof | Picks the worker model in hours; polyglot keeps its README role and its owner (INDEX wish 2) |
| 7 | `/microagent-create` is propose-only | Evidence-backed draft + user approval; prevents agent sprawl |
| 8 | Parity + shootout tasks mined from real past-24h transcripts, never synthetic | User-directed; real workloads are the only fair comparison and become the regression suite |
| 9 | Dogfood default = `khal/deepseek-v4-flash` + station until the shootout; winner replaces it only after a parity re-run on the winner | Flash is the cost outlier ($0.10/$0.20 per M, 1M ctx); station is $0; re-run closes the tune-vs-choose loop |
| 10 | `--dir` flag on `rlmx mcp` (existing CLI directory-flag convention, `src/cli.ts:76`); plugin always passes it | Converts the host-cwd assumption into an explicit contract; fixes discovery, config, context, and REPL cwd together; no duplicate flag name |
| 11 | Live refresh = re-scan on every tools/list and tools/call, rebuild list + lookup together, emit `list_changed` on set change | Listed-but-uncallable is the failure mode to design out; emit makes the declared capability honest |
| 12 | MCP surface is isomorphic to Claude Code's native Agent tool: `prompt` param (runtime-validated `query` alias), spawn-style descriptions, `session_id` in every result, same-tool `session_id` resume via conversation replay (fresh REPL per call; serialize-and-reject on concurrency). Named divergences: session resume is same-tool (native uses a separate continuation tool), background mode OUT | User decision 2026-07-26: don't teach the host model a new interaction pattern — delegation that pattern-matches the Agent tool gets used; a new idiom gets ignored. REPL-state persistence rejected: no precedent seam in `rlm.ts`, no observable benefit for explore-class follow-ups |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Quality floor: a cheap model's wrong answer costs more than it saves | High | Parity gate with fixed rubric + fabrication auto-fail; citation contract makes answers mechanically checkable; escalation rule in the guidance skill has its own acceptance criterion (Wish B C3) |
| 2 | Host-cwd assumption for bare (non-plugin) registration | Low | `--dir` removes it for the plugin path (D10); probe already done (2026-07-26): live `rlmx mcp` processes on this host confirm Claude Code spawns stdio servers in the project dir; other hosts get `--dir` |
| 3 | khal key security: key appeared in chat transit | Medium | Env-only handling; rotation recommended once wired; LiteLLM virtual keys later |
| 4 | Parity subjectivity | Medium | Rubric fixed per task *before* scoring, from native Explore's actual findings; mechanical citation check; identical rubric both arms |
| 5 | Live refresh changes MCP behavior for existing users | Low | Additive; extended smoke covers workspace root + create-then-list-then-call; stale assertions removed |
| 6 | khal gateway pricing/model list drifts | Low | Overlay reads `/model/info` at runtime; bench table records date + per-arm pricing at run time; `/model/info` outage degrades to zero-cost with a warning, never blocks resolution |
| 7 | `/model/info` payload shape is LiteLLM-internal and may change | Low | Parser tolerant (missing fields → cost 0 + warning); covered by a fixture test |

## Success Criteria

**Wish A — rlmx-explore-offload**
- [ ] A1: From a workspace containing `.rlmx/agents/explore/`, a Claude Code
  session lists `rlmx_explore` and a delegated question returns a correct
  answer whose `file:line` citations all resolve.
- [ ] A2: An agent directory created mid-session is **listed and callable**
  without reconnect, and the server emits `notifications/tools/list_changed`
  when the set changes (extended smoke-mcp proves list + call + notification).
- [ ] A3: `khal/<model>` resolves with the key present, with real per-token
  cost in the MCP footer sourced from `/model/info`; without the key,
  resolution fails fast with a message naming `KHAL_API_KEY`. Station
  behavior unchanged.
- [ ] A4: Parity gate passed: on the ≥5-task mined suite, `rlmx_explore`
  passes ≥4 tasks under the fixed rubric (≥90% required facts, all citations
  resolve, zero fabrications). Parity report committed with per-task rubric,
  scores, and premium-token accounting (method as specified; expected ≥80%
  reduction, reported not gated).
- [ ] A5: `rlmx mcp --dir <dir>` makes discovery, config, context, and REPL
  cwd agree on `<dir>` (test proves an agent + config in `<dir>` load while
  the process was spawned elsewhere).
- [ ] A6: Agent-tool isomorphism holds: tools accept `prompt` (and the
  `query` alias; both/neither rejected at runtime with a message naming
  `prompt`); every result carries `session_id` in `structuredContent`; a
  second call passing `session_id` continues the conversation — a follow-up
  that only makes sense given the first answer resolves correctly via turn
  replay (live REPL state is explicitly not promised and not tested);
  expired/unknown `session_id` and concurrent same-session calls each
  return their specified clear errors, never a silent fresh start.

**Wish B — rlmx-microagent-plugin**
- [ ] B1: Plugin installs from the rlmx repo in one documented command;
  a fresh Claude Code session in the dogfood workspace sees `rlmx_explore`
  via the plugin's own MCP registration (which passes `--dir`).
- [ ] B2: Shootout table committed to docs: 7 arms × ≥10 real mined tasks
  with correctness / wall-time / cost per arm, run date, and per-arm pricing;
  default worker model chosen from it; if winner ≠ parity model, parity
  re-run on the winner is included.
- [ ] B3: Routing criterion: on a scripted eval of 5 exploration prompts
  drawn from the mined suite, a session with the plugin routes ≥4 of 5 to
  `rlmx_explore` instead of inline grep/Explore, and the escalation rule
  triggers on a planted low-confidence case (rlmx answer without citations →
  session re-runs natively).
- [ ] B4: `/microagent-create` reads last-24h transcripts and produces a
  draft agent.yaml + SYSTEM.md + evidence file for ≥1 new candidate
  (expected: review-lite or git-historian class), and creates nothing
  without approval.
- [ ] B5: The three legacy global agents are archived: `~/.rlmx/agents/` no
  longer contains them; `changelog` + `log-triage` live on as documented
  recipes under `examples/agents/`; `explore` covers `codebase-qa`'s role.

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish` (Wish A first).

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `94b73f45d8791ea55f9206a194011d2eed16a96e9a86981f9c43adeb43dae3c2`
- **Reviewer:** genie:reviewer/rcp-05
- **Reviewed at:** 2026-07-26T18:41:08.000Z
<!-- genie-design-review:end -->
