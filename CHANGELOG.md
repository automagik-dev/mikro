# Changelog

All notable changes to rlmx are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

rlmx uses **calendar versioning**, not semantic versioning. Versions are
`0.YYMMDD.N` — a fixed `0` prefix, the UTC date of the build, and a 1-based
daily build counter (see `scripts/version.mjs`). A version number therefore
tells you *when* a build was cut, not what compatibility it promises. Breaking
changes are called out under a `### Changed` or `### Removed` heading in the
entry for the release that contains them.

Note that npm is an **SDK-only** distribution channel; the canonical CLI
release is the git commit on `main`. See `docs/release-contract.md`.

## [Unreleased]

### Added

- **`rlmx mcp` — stdio MCP server.** The native way to drive rlmx from Claude
  Code, Codex, or Hermes: `claude mcp add rlmx -- rlmx mcp`. Exposes an
  `rlmx_query` tool plus **one tool per `agent.yaml` microagent** discovered
  under `~/.rlmx/agents/`, `<project>/.agents/`, or `<project>/.rlmx/agents/`
  (project shadows global; `RLMX_AGENTS_DIR` overrides). Each agent runs on the
  model its `agent.yaml` names, which is how repeatable work moves off an
  expensive host model.
  - Every result carries a token/cost footer, so the offload is visible in the
    transcript rather than taken on faith.
  - Emits `notifications/progress` per iteration. This is load-bearing: MCP
    clients time requests out (the reference client defaults to 60s) and a
    delegated recursive run on a local model routinely exceeds that.
  - `RLMX_MCP_RUN_TIMEOUT_MS` lifts rlmx's own wall-clock cap.
  - A failing tool call fails only that call, never the server process.
  - Gate: `scripts/smoke-mcp.mjs` drives the real server with the MCP SDK's own
    client — handshake, `tools/list`, per-agent tools, and error isolation.

### Security

- Adding `@modelcontextprotocol/sdk` pulled in `@hono/node-server` 1.x, which
  carries a moderate advisory (path traversal in `serve-static` on Windows via
  encoded backslash, GHSA-frvp-7c67-39w9). Pinned to `^2.0.11` via a
  `package.json` `overrides` entry; `npm audit --omit=dev` reports zero
  vulnerabilities again. rlmx uses only the SDK's **stdio** transport, so the
  affected `serve-static` path is never loaded.
  **Caveat:** npm `overrides` apply to this repo's install, not to consumers of
  the published SDK package — a downstream tree may still resolve the
  vulnerable transitive version until the upstream SDK bumps its own range.

### khal provider

- **`khal/<model>` — the khal LiteLLM gateway as a first-class provider.**
  Every model the gateway serves (`llm.khal.ai`, override `KHAL_BASE_URL`)
  resolves on both the CLI and SDK paths, the same seam `station/<model>` uses.
  The key is env-only: `KHAL_API_KEY`, falling back to `RLMX_KHAL_API_KEY`.
  - The catalog is built from LiteLLM's `/model/info`, which quotes prices
    **per token** where pi-ai's `Model.cost` is **per million** — so prices are
    converted ×1e6 on the way in. Without that conversion every khal run would
    report `$0.0000`; a fixture test pins it (`deepseek-v4-flash` at
    `1e-7`/token → `$0.10`/Mtok).
  - Aliases that front several gateway deployments fold into one model, taking
    the highest quoted price, so reported cost never depends on `/model/info`
    ordering and never under-reports against `--max-cost`. **Reported cost is
    therefore an upper bound for multi-deployment aliases**: on the live
    gateway `khal/kimi-k2.6` fronts deployments at 7.5e-7 / 9.5e-7 / 1.2e-6
    per input token, so a run billed at the cheapest deployment reports up to
    ~60% high. Single-deployment and uniformly-priced aliases — including the
    `deepseek-v4-flash` default — are exact.
  - `/model/info` being down does not block resolution: models come from
    `/v1/models` with cost 0, plus one warning on stderr — emitted only once
    that fallback has actually answered, so the warning never promises a
    resolution that did not happen. If neither endpoint answers, the warning
    names both failures instead.
  - Every khal-specific failure is named at the resolution hook, because
    `resolveModel` downstream has one error for all of them ("unknown model"),
    which is true of none of them: no key → `khal provider requires
    KHAL_API_KEY`; key rejected (401/403) → `khal gateway rejected
    KHAL_API_KEY (HTTP 401) …`, naming whichever env var supplied it; gateway
    up but serving no catalog → `khal catalog unavailable (/model/info: …;
    /models: …)`. A rejected key is never retried against the fallback
    endpoint — it answers the same 401 — and never degrades into an empty
    catalog.

### MCP

- **The `rlmx mcp` tool set is now live.** Every `tools/list` *and* every
  `tools/call` re-scans the agent roots, and the advertised list plus the call
  lookup are rebuilt from that one scan — so an `agent.yaml` folder authored
  mid-session is listed **and callable** without reconnecting, and one deleted
  mid-session stops dispatching even while a client's cached list still shows
  it. `notifications/tools/list_changed` fires when the set actually changes
  (never for an edited spec, which is not a set change), and
  `tools.listChanged` is declared only because it is genuinely emitted.
- **The tool surface now mirrors the host's native Agent tool**, so delegating
  to rlmx needs no new interaction pattern:
  - `prompt` is the primary input; `query` remains as a deprecated alias. Both
    are optional in the schema (`required: []`) with the exactly-one rule
    enforced at runtime and every error naming `prompt` — deliberately not
    `anyOf`, which MCP hosts surface to models inconsistently.
  - Descriptions read as spawn instructions (what it is, that it runs to
    completion and cannot ask follow-up questions, what comes back).
  - Every result carries `session_id` in `structuredContent` — backed by a
    declared `{session_id: string}` `outputSchema` so it is a contract rather
    than an undocumented extra — and echoes it in the prose footer for hosts
    that render only text.
  - Passing that `session_id` back **continues the conversation**: the
    session's bounded turn history is replayed into the new prompt, the same
    mechanism `rlmx acp` uses. Each call still runs a fresh `rlmLoop` with a
    fresh Python REPL, so **live REPL state is explicitly not preserved across
    a resume** — conversation is, interpreter variables are not.
  - Sessions live in-process with a TTL, a size cap with LRU eviction, and a
    per-session turn cap; they are advisory, so losing one costs a fresh start
    and never correctness. An unknown or expired `session_id` is a clear error,
    never a silent fresh start; a concurrent call on the same session is
    rejected as "session busy"; a `session_id` is bound to the tool that
    created it and is not portable to another; and an agent deleted mid-session
    answers "Unknown tool" while its orphaned sessions are evicted.
  - `rlmx_query` participates fully (prompt, session_id, resume) and keeps its
    `model` override.
- **`.proposed` is now a reserved agent-directory suffix, and discovery skips
  it silently.** `discoverAgents` ignores any directory under an agent root
  whose name ends `.proposed`, matched **case-insensitively** (`X.Proposed` is
  skipped like `x.proposed`). This changes discovery for **every** `rlmx mcp`
  user, not only plugin users.
  - The skip is applied before the spec is parsed and before the tool list is
    built, and `tools/call` dispatches from that same scan, so a draft is
    **neither listed nor callable** — calling it by its would-be name answers
    `Unknown tool: rlmx_<name>_proposed`. Renaming the directory publishes it
    on the next request, live, with no reconnect; renaming it back withdraws
    it just as fast.
  - It exists so `/rlmx:microagent-create` can write a draft agent to disk
    without that agent becoming callable. The rename is the approval step, and
    it only means something if an un-renamed draft can do nothing at all.
  - **The cost, stated because the error surface is silence:** an agent you
    legitimately wanted to name `foo.proposed` loads fine on its own and simply
    never appears — no warning, no log line. If an agent you wrote is missing
    from `tools/list`, check its directory name for the suffix first. Reserved
    in every casing. Documented in `docs/agent-yaml-schema.md`,
    `plugins/claude-code/README.md`, and the skill.
- **`rlmx mcp --dir <path>`** chdirs to a validated directory before starting,
  making agent discovery, `loadConfig`, relative `context` paths, and the REPL's
  working directory agree on one root instead of on wherever the host happened
  to spawn the server. Reuses the existing `--dir` flag — no second
  directory-flag convention.
- Gate: `scripts/smoke-mcp.mjs` now drives a **real workspace root** through the
  ordinary discovery precedence (temp cwd, no `RLMX_AGENTS_DIR` override) with
  the server spawned from a different directory and pointed at it by `--dir`.
  It proves create-then-list-then-call mid-session, the `list_changed`
  notification (and its absence while the set is static), the new input schema,
  a resume round-trip, and the unknown-session / session-busy / cross-tool
  errors. Live turns run against the local station gateway — keyless, same
  convention as `smoke-acp.mjs`; `--no-live` gates the protocol surface alone.

### explore microagent

- **`examples/agents/explore/`** — the reference microagent, and the first
  recipe in what becomes the canonical `examples/agents/` subtree. It answers a
  question about the repository it runs in and returns the answer with
  `file:line` citations that resolve. Install it as
  `<project>/.rlmx/agents/explore/` and a host sees `rlmx_explore`.
  - `shape: loop` with `budget.max_iterations`, never `single-step`: the tree
    is on the filesystem, not in the prompt, so a single pass answers from
    memory before opening a file. The system prompt is built around that —
    print-or-see-nothing REPL discipline, search-for-literals, and a citation
    contract (line numbers come from executed code, never a dump, "not found"
    over a guess).
  - Default model `khal/deepseek-v4-flash`; any `station/<model>` works too.
- **`scripts/smoke-explore.mjs`** — the recipe's own gate, distinct from
  `smoke-mcp.mjs`'s synthetic fixture: it installs the shipped agent into this
  checkout, drives `rlmx mcp --dir <checkout>` over MCP, asks a fixed question
  about this repo, and mechanically resolves the citations that come back
  against the same tree. Station arm by default (keyless, `RLMX_SMOKE_MODEL`
  overrides); the khal arm runs the shipped model when `KHAL_API_KEY` is set.
- **`docs/parity-explore.md`** — the parity gate, run and reported. Six mined
  tasks driven through `rlmx_explore` over the real MCP path and scored against
  native Explore by a fixed rubric, across the full escalation ladder
  (`deepseek-v4-flash` → `mimo-v2.5` → `kimi-code` → `claude-haiku`): 15 rounds,
  90 runs, every tuning change logged. **Verdict `Gate: FAIL`** — 0 of 6 tasks
  passed on any tier, against a bar of 5 of 6. Citation hygiene was not the
  problem (the final flash round fabricates nothing across all six tasks); fact
  coverage was, at best 7 of 10 required facts where 9 were needed. The token
  side is reported and unambiguous — 366×–2,110× less premium context per task,
  $0.14 of gateway spend for the suite — and was never allowed to be the gate.
  Wish B (`rlmx-microagent-plugin`) does not start.
- **`examples/agents/explore/` tuning** from the gate, kept because each fixed
  something measurable: the answer is returned as `FINAL("""…""")` written out
  inline rather than through a variable name (`FINAL(answer)` submits the
  literal word and silently discards the run); a last-iteration override that
  answers in plain prose, which is what `src/rlm.ts` actually asks for; a
  verification block that re-opens every line before citing it; and
  `budget.max_cost` 0.25 → 2.00, because 0.25 was one model's price and it
  truncated every run on a pricier one.
- **`scripts/mine-explore-tasks.mjs`** — builds the explore parity suite out of
  real work rather than invented questions: it reads this host's Claude Code
  transcripts, lifts out read-only question→search→answer segments, and
  verifies each claim against the repository the session ran in. Verification
  is content-anchored, so a claim whose code moved is re-anchored to where it
  lives today and one whose symbols are gone is excluded from scoring. Every
  verbatim excerpt is redacted for credentials on the way out.

### plugin

- **`plugins/claude-code/`** — rlmx as a Claude Code plugin. One copy-paste
  installs it from a clone, with no npm in the path:

  ```bash
  claude plugin marketplace add ~/.rlmx/rlmx && claude plugin install rlmx@rlmx
  ```

  The clone is the marketplace (`.claude-plugin/marketplace.json` at the
  repository root, plugin entry `./plugins/claude-code`), which is why no
  second repository and no registry is involved.
  - The bundled MCP registration is `rlmx mcp --dir ${CLAUDE_PROJECT_DIR}`, so
    the server's working directory is the project you have open rather than
    whatever directory the host spawned it from. Agent discovery, `loadConfig`,
    relative `context` arguments and the REPL cwd then all agree on one root
    (`src/cli.ts:1039-1054`). A workspace with `.rlmx/agents/explore-r/` gets
    `rlmx_explore-r` without a per-project `claude mcp add`.
  - Plugin tools are namespaced `mcp__plugin_rlmx_rlmx__<tool>`, distinct from
    a bare `claude mcp add rlmx` registration's `mcp__rlmx__<tool>`. Both can
    coexist.
  - `rlmx` must be on `PATH`: installed plugins are copied into
    `~/.claude/plugins/cache` and cannot reference files outside their own
    directory, so the plugin cannot point at a `dist/` inside the clone it
    shipped from. `scripts/install.sh` linking `~/.local/bin/rlmx` is what
    makes it resolve.
  - **Two bundled skills, both with content.** Neither loads until its trigger
    fires, so an idle session pays only for their two description lines.
    - **`/rlmx:offload-guidance`** — a routing rule. An explore-class question
      about a repository not already in context goes to `rlmx_explore-r`
      *before* Grep/Glob/Read and before an Explore subagent; its citations are
      leads to verify, not findings. Carries the three escalation triggers
      taken from measured failure modes rather than invented heuristics —
      citations that do not resolve, an errored or timed-out run, and work
      where completeness outranks cost — plus the call shape and `session_id`
      resume.
    - **`/rlmx:microagent-create`** — propose-only. Streams this host's
      last-24h Claude Code transcripts through a bundled scanner
      (`scan-transcripts.mjs`, which labels MEASURED usage-block counts apart
      from ~ESTIMATED character-derived ones and never blurs them), ranks
      recurring work into offload families by the context each returns, picks
      at most one candidate against five stated rules — proposing nothing when
      none clears them — and writes a draft `agent.yaml` + `SYSTEM.md` +
      `EVIDENCE.md` into `.rlmx/agents/<name>.proposed/`. Then it stops and
      hands the user the `mv`. It cannot activate anything; see the
      `.proposed` reserved suffix under **MCP**.
  - Positioning is unchanged by this entry: the explore parity gate's
    `Gate: FAIL` stands. The plugin ships `explore-r` as a **first-pass**
    explorer under the design's Amendment 2026-07-27, and
    `plugins/claude-code/README.md` carries the report's own scoping —
    out-of-sample coverage 0.714 against 0.853–0.912 in-sample, zero fabricated
    citations **in the frozen configuration only** (earlier rounds fabricated),
    and 1,077× aggregate premium-token reduction for $0.22 in that same frozen
    configuration — not round 1's 921×/$0.14, which is a different, non-shipping
    configuration. No parity claim is made anywhere in the plugin.

### docs

- **`docs/worker-models.md`** — which model to run a microagent on, with the
  round-2 evidence consolidated into one table and each number's scope attached
  to it. The default stays **`khal/deepseek-v4-flash`**, and the page says why
  in the only terms the evidence supports: it is 8.7×–18.8× cheaper per round
  than every arm measured and it finished every run, **not** that it was
  measured as the most accurate — flash's published 32/34 failed to reproduce
  (three live task-4 replicates scored 3/6, 5/6, 4/6 against 6/6) and the arm is
  corrected to **29–31/34**, which puts its margin over `qwen3.7-max` at +1..+3,
  inside the ±3-fact run-to-run spread measured on flash itself. Carries per-arm
  catalog pricing, UTC run dates, the n=1 noise caveat, and the standing
  scoping: out-of-sample coverage **0.714** against **0.853–0.912** in-sample,
  zero fabricated citations **in the frozen configuration only** (earlier rounds
  fabricated), **1,077×** premium-token reduction for **$0.22** in that same
  configuration, four generations evaluated and a fifth rejected, and the
  recursion product fixes at commit **`6ec4822`**.
- **A `station/<model>` arm on the training suite, n = 2, marked
  not-rank-comparable.** Records under
  `parity/round2/optimizer/station-arm/`, run with the same recipe, suite and
  scorer as the four khal arms, `--concurrency 1` because one local gateway
  cannot host two tasks' worth of streams. Two replicates buy feasibility, a $0
  cost figure and a replicate spread on one model — **not** a rank against the
  n=1 cloud arms, and the row says so. It ran on `station/qwen3.5-2b-FLM`
  because that was **the only station model that would serve on this host that
  day**: five larger candidates were tried first and every one failed to load,
  one of them wedging the gateway's loader for ~31 minutes. A 2 B model is
  below the capability floor this recipe was written for, so the arm's coverage
  number is a floor for the station provider and not an estimate of it — the
  arm's README and the docs page both say so, and the run is re-runnable
  against a larger model with one flag.
- **`examples/agents/` is now the single microagent recipe tree.** The flat
  `examples/hello-world/`, `examples/research-agent/` and
  `examples/brain-triage/` entries moved under it (their tests moved with
  them), so one tree holds every `agent.yaml` recipe and `examples/` holds only
  `rlmx.yaml` configuration examples. New
  [`examples/agents/README.md`](examples/agents/README.md) indexes them with
  what gates each one — including the three that nothing gates.
- **Three legacy agents archived as recipes** — `changelog`, `codebase-qa` and
  `log-triage`, copied byte-for-byte out of this host's `~/.rlmx/agents/`
  (sha256 in each README) and verified to load through `loadAgentSpec` by
  `tests/examples-agents-recipes.test.ts`, which also pins every recipe in the
  tree to load. **`codebase-qa` is kept deliberately**: "`explore-r` replaces
  it" is positioning, not a result — the explore gate scored 0 of 6 tasks
  against a bar of 5 of 6 in both rounds, and no run anywhere in this
  repository compares the two. The **host-side removal is a documented user
  step and this change never performs it**; nothing in rlmx deletes a file from
  your home directory.

## [0.260725.1] — 2026-07-25

First release since `0.260528.2`. Lands the ACP agent, the recursion event
stream, the pi-ai 0.80 Models runtime, and the local `station` provider, and
clears the production dependency tree of known advisories.

### Added

- **`rlmx acp` — stdio ACP agent (experimental).** Exposes rlmx over the
  [Agent Client Protocol](https://agentclientprotocol.com). The intended use is
  driving rlmx as a sub-agent from Claude Code, Codex, Hermes, or the CLI via a
  headless ACP client such as `acpx`; ACP editor clients (Zed) can spawn it
  directly. Translates the instrumented
  `rlmLoop` event stream into live ACP session updates, mapping recursion into
  tool-call nodes. Includes durable multi-turn sessions, MCP advertisement, and
  disconnect handling. **Experimental:** the protocol surface may change, and
  v1 serializes prompt turns within a single active session. (#112)
- **Recursion event stream.** `rlmLoop({ emitter })` is now a contractual seam
  emitting `RecurseEvent`s with per-node tokens, cost, latency, and
  `correlationId` ancestry — making a recursive run observable rather than
  opaque. Documented in `docs/events.md`. (#107)
- **`station` provider.** First-class local Lemonade gateway registered at both
  resolution sites, addressable as `station/<model>`, for running agents
  against local models over an OpenAI-compatible endpoint. (#110)
- **CLI schema exposure** and hardened model routes. (#101)
- `run_cli` Python REPL battery (auto-prefixes `rtk` when available, for 60-90%
  token savings on tool output)
- `rlmx doctor` reports RTK install status + config mode
- `rtk.enabled: auto | always | never` in `rlmx.yaml`
- Scaffold templates (default + code) now include RTK-aware examples

### Changed

- **pi-ai upgraded to 0.80.10 (Models runtime).** Multi-provider support
  (Anthropic / OpenAI / Google and others) via the Models API, bringing
  `uuidv7` identifiers, `contentText`, and `Usage.reasoning` /
  `responseModel`. (#107)

### Fixed

- Bound the station `fetchModels` discovery request with a 5s abort timeout so
  model discovery cannot hang. (#111)
- Event-stream QA follow-ups from the `rlmx-live-tui` final gate. (#109, #108)
- Emit Langfuse generations for root RLM calls, closing a gap where only child
  runs were traced. (#99)
- Keep GitHub releases tied to the package version, and enforce the release
  channel contract in CI. (#102, #103, #104)
- Harden the rolling PR workflow and its token handling. (#105, #106)

### Security

- Resolved a **high-severity `js-yaml` advisory** (quadratic-complexity DoS via
  repeated merge-key aliases — GHSA-h67p-54hq-rp68, GHSA-52cp-r559-cp3m) and a
  moderate `protobufjs` advisory, both present in the production dependency
  tree. rlmx parses user-authored `agent.yaml` / `rlmx.yaml`, so the js-yaml
  issue was directly in scope. `npm audit --omit=dev` now reports zero
  vulnerabilities.
- ACP hardening shipped with #112: redaction input is length-bounded to
  eliminate a ReDoS path in `sanitizeText`, tool-call payloads are bounded and
  redacted at the translator boundary, and non-UUID `sessionId`s are rejected
  to close a session-store path-traversal vector.
