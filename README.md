# rlmx

RLM algorithm CLI for coding agents — prompt externalization, Python REPL with symbolic recursion, code-driven navigation.

Based on the [RLM paper](https://arxiv.org/abs/2501.12599) (REPL-based LLM Method). Uses [pi/ai](https://www.npmjs.com/package/@earendil-works/pi-ai) as the multi-provider LLM client, plus two native providers of its own (`station/`, `khal/`).

## Install

`scripts/install.sh` is the canonical installer — rlmx is git-installed, not
npm-installed (see [`docs/release-contract.md`](docs/release-contract.md)):

```bash
curl -fsSL https://raw.githubusercontent.com/automagik-dev/rlmx/main/scripts/install.sh | bash
```

It clones to `~/.rlmx/rlmx`, runs `npm ci --include=dev` and `npm run build`,
then symlinks `dist/src/cli.js` → `~/.local/bin/rlmx`. Re-running it against an
existing checkout refreshes it in place. From a clone you already have,
`bash scripts/install.sh` (or `npm run install:local`) does the same.

Four env vars override the defaults: `RLMX_REPO_URL`, `RLMX_BRANCH`,
`RLMX_INSTALL_DIR`, `RLMX_BIN_DIR`.

### Update

```bash
rlmx update            # fetch origin/main, rebuild in place
rlmx update --force    # same, discarding local changes in the checkout
```

`rlmx update` refuses to run over a dirty checkout without `--force`, then
resets to `origin/main`, reinstalls, rebuilds, and prints the before commit,
the target commit and the resulting version. Because `rlmx` is a symlink into
that clone's `dist/`, this is what makes a new `main` commit take effect.

### npm is SDK-only

```bash
npm install @automagik/rlmx     # library, for programmatic consumers
```

The npm package ships **no `bin`** — by contract, and CI asserts it
(`scripts/smoke-install-update.sh`). So `npx rlmx` cannot work and there is no
`npm install -g` path. npm gets you the SDK; `install.sh` gets you the CLI.

## Quick Start

```bash
# Scaffold .rlmx/ config in the current directory
rlmx init

# Run a query
rlmx "What is the meaning of life?"

# Query with context (directory of docs)
rlmx "How does IPC work?" --context ./docs/

# Query with a single file as context
rlmx "Summarize this paper" --context paper.md --output json

# Pipe data in
cat data.csv | rlmx "Analyze this dataset"
```

## Use rlmx from Claude Code / Codex (`rlmx mcp`)

Offload repeatable work to a cheap or local model instead of paying host-model
prices for it every time.

```bash
claude mcp add rlmx -- rlmx mcp
```

That's it. Claude Code now has an `rlmx_query` tool, plus **one tool per
microagent** you've defined — `rlmx_triage`, `rlmx_test_writer`, and so on — so
the model delegates to them by name.

**Claude Code users: there is a plugin.** It registers the same server with
`--dir` pointed at the project you have open, so agent discovery and the REPL
cwd agree with your project root instead of wherever the host spawned the
process:

```bash
claude plugin marketplace add ~/.rlmx/rlmx && claude plugin install rlmx@rlmx
```

The clone *is* the marketplace — `.claude-plugin/marketplace.json` sits at the
repository root — and `~/.rlmx/rlmx` is exactly where `install.sh` put it.
The plugin needs `rlmx` on `PATH`, which is what `install.sh` provides; if the
server shows as failed in `claude mcp list`, check `command -v rlmx` in the
shell that launched Claude Code. It ships that one server plus two skills
(`/rlmx:offload-guidance`, `/rlmx:microagent-create`). Details, limits and
honest positioning: [`plugins/claude-code/README.md`](plugins/claude-code/README.md).

### Tool contract

Every tool — `rlmx_query` and each microagent — takes the same input, chosen to
mirror the host's own Agent tool so the model uses it without being taught:

| field | required | meaning |
| --- | --- | --- |
| `prompt` | yes | The task. A complete, standalone instruction: the agent runs to completion and cannot ask follow-up questions mid-run. |
| `query` | — | Deprecated alias for `prompt`. Pass one or the other, never both. |
| `session_id` | — | Continue an earlier call **on this same tool** — pass the `session_id` its result returned. |
| `context` | — | Path to a file or directory to load as context, relative to the server's working directory. Same as the CLI's `--context`. |
| `model` | — | `rlmx_query` only: override the model as `"<provider>/<model>"`, e.g. `station/Brain-35B`. |

`prompt` and `query` are both schema-*optional* and exactly one is demanded at
runtime — JSON Schema can only say "exactly one of" via `anyOf`/`oneOf`, which
several MCP hosts flatten or reject, so the constraint lives in code and the
error names `prompt`.

Every result declares an `outputSchema` of `{answer: string, session_id: string}`
and returns both in `structuredContent`. `answer` is the text block byte for
byte, token/cost footer included — declaring an `outputSchema` also *permits* a
host to read `structuredContent` instead of `content`, so the answer has to be
in it or the whole delegated run is invisible to that host.

Pass `session_id` back to **the same tool** and the prior turns are replayed into
the new prompt. Sessions are in-process and time-limited: an expired id, an id
belonging to another tool, and an id with a call already in flight each get their
own named error. Resume is conversation replay, not REPL state — the Python REPL
is rebuilt per call and its state is deliberately not promised across turns.

A run that fails **without throwing** comes back as `isError` with the reason in
`answer`. rlmx's two designed aborts — three consecutive empty LLM responses and
the wall-clock timeout — return their reason as an `Error: …` answer rather than
raising, so without this a host model would read the abort reason as the agent's
report. A genuine `max-cost`/`max-tokens`/`max-depth` budget hit still forces a
real final answer and stays a success: shorter, not failed.

**The tool set is live.** Every `tools/list` *and* every `tools/call` re-scans
the agent roots from one shared scan, and `notifications/tools/list_changed`
fires when the set actually changes — so an agent you author mid-session is
listed and callable with no reconnect.

Long runs emit `notifications/progress` per iteration, which keeps conforming
clients from timing out mid-delegation. `RLMX_MCP_RUN_TIMEOUT_MS` lifts rlmx's
own wall-clock cap.

> Not to be confused with `rlmx acp` below. In ACP the *client* is an editor and
> the *agent* is the AI tool — Claude Code and Codex are agents themselves, so
> they can't drive rlmx over ACP. MCP is the protocol they speak as clients.

## Microagents (`agent.yaml`)

A microagent is an `agent.yaml` folder ([full schema](docs/agent-yaml-schema.md))
in any of:

```
~/.rlmx/agents/<name>/         # global
<project>/.agents/<name>/      # project — supported alias
<project>/.rlmx/agents/<name>/ # project — the convention
```

`<project>/.rlmx/agents/` is the convention: everything rlmx owns in a
repository lives under one `.rlmx/` directory next to `rlmx.yaml`. `.agents/`
is scanned too and stays supported — an agent folder is portable between the
two, and `.rlmx/agents/` wins when the same name exists in both. Project agents
shadow global ones with the same name, and `RLMX_AGENTS_DIR` (colon-separated)
replaces every root. Roots are listed above in precedence order, lowest first.

Directory name → tool name: lowercased, anything outside `[a-z0-9_-]` folded to
`_`, prefixed `rlmx_`. So `.rlmx/agents/explore-r/` becomes `rlmx_explore-r`.

```yaml
# ~/.rlmx/agents/triage/agent.yaml
schema_version: 1
tools_api: 1
shape: loop
model: station/Qwen3.6-35B-A3B-MTP-GGUF   # local — $0 marginal cost
description: Classifies inbound issues and proposes a label + owner.
system: SYSTEM.md
thinking: low                             # omit and reasoning is *off*, not default
budget:
  max_iterations: 6
  max_cost: 0.50
```

### Fields

Snake_case and camelCase are both accepted for every multi-word key. Unknown
keys are preserved on `AgentSpec.extras` rather than rejected, so you can layer
your own schema without forking the parser.

| field | default | what it does |
| --- | --- | --- |
| `schema_version` | `1` | Schema generation. Stable at 1; prior versions stay loadable. |
| `tools_api` | `1` | Tool-contract generation. Same guarantee. |
| `shape` | `single-step` | `single-step` \| `loop` \| `recurse`. An unknown value is a hard error. |
| `model` | ambient config | `"<provider>/<model>"` — `station/…`, `khal/…`, or any pi/ai provider. A bare model id keeps the configured provider. |
| `description` | — | One line the MCP client shows the host model. Falls back to the first meaningful line of the system prompt, then a generic string — an agent with neither is effectively invisible. |
| `system` | — | Path to the system prompt, relative to the agent directory. |
| `tools` | `[]` | Plugin tool names to load. Empty strings drop; duplicates collapse. |
| `budget.max_cost` | — | USD ceiling per run. |
| `budget.max_iterations` | — | Iteration ceiling. Threaded into `runAgent({ maxIterations })`. |
| `budget.max_depth` | — | Recursion depth ceiling, for `shape: recurse`. |
| `scope.reads` / `scope.writes` | — | Advisory glob hints. The SDK does **not** enforce them; individual tool handlers do. |
| `thinking` | ambient config | `minimal` \| `low` \| `medium` \| `high` — reasoning effort for this agent's own model calls. An unknown value is a hard error. |

> **`thinking` is not tuning — it is a default worth overriding.** Omitting it
> does **not** mean "provider default": pi/ai explicitly *disables* reasoning
> when no level is given, so an agent that needs its model to think has to say
> so. A declared level outranks the ambient `gemini.thinking-level` exactly the
> way `--thinking` does, because it writes that same field — there is no second
> per-agent channel to keep in sync. Despite the `gemini.` prefix the config key
> inherited, this is **not** Google-only: pi/ai maps it onto OpenAI
> (`reasoning.effort`), Google (`thinkingConfig.thinkingLevel`), and Anthropic
> (`thinking.budget_tokens`) alike. Treat the level as a request rather than a
> guarantee — pi/ai clamps it to what the resolved model declares, searching
> *upward* first, so `minimal` on a model with a higher floor comes back raised.
> Full detail in [`docs/agent-yaml-schema.md`](docs/agent-yaml-schema.md#reasoning-effort-thinking).

> **Choosing `shape`.** rlmx externalizes context into the Python REPL — the
> model has to *run code* to read it. So `shape: single-step` gives it one pass
> and it answers **before ever opening your file**. Use `single-step` only when
> the whole input fits in the prompt; use `loop` with a `budget.max_iterations`
> whenever the agent takes `context`. Symptom of getting this wrong: a
> confident answer and a suspiciously small input-token count in the footer.

### `.proposed` is a reserved suffix

A directory whose name ends `.proposed` (matched case-insensitively) is a draft
awaiting human approval. Discovery skips it **before the spec is parsed**, and
`tools/call` dispatches from that same scan, so a draft is neither listed nor
callable — calling it by its would-be name answers
`Unknown tool: rlmx_<name>_proposed`. Activation is a rename you perform:

```bash
mv .rlmx/agents/<name>.proposed .rlmx/agents/<name>
```

The tool appears on the next request. This is the propose-only boundary behind
`/rlmx:microagent-create`. **The skip is silent by design**, so do not name a
real agent `<something>.proposed`.

### Ready-made ones

Copy from **[`examples/agents/`](examples/agents/)** — the single recipe tree
([index](examples/agents/README.md)). Start with
[`explore/`](examples/agents/explore/): it answers a question about the repo it
runs in with `file:line` citations. Install it as
`<project>/.rlmx/agents/explore/` and Claude Code gets an `rlmx_explore` tool.
Also there: `codebase-qa`, `changelog` and `log-triage` (small, local-model,
ungated), and `explore-r` (recursive). Which worker model to run them on, and
what the evidence does and does not establish:
[`docs/worker-models.md`](docs/worker-models.md).

Each result ends with what it cost, so the offload is visible rather than
assumed:

```
rlmx · agent=triage · station/Qwen3.6-35B-A3B-MTP-GGUF · 3 iterations · 307 in / 36 out · $0.00 · 3.9s
```

Protocol and recipe smokes, run manually — CI does not:
`node scripts/smoke-mcp.mjs` (protocol) and `node scripts/smoke-explore.mjs`
(the `explore` recipe end to end, citations resolved against this checkout).

## SDK (`rlmx.sdk.*`)

rlmx also ships a programmatic SDK for consumers that need to drive
agents from code — with per-iteration observability, permission
hooks, validate-with-retry, session checkpointing, and a pluggable
tool registry. The CLI path above is untouched; the SDK is purely
additive.

```ts
import { readFile } from "node:fs/promises";
import { sdk } from "@automagik/rlmx";

const spec = await sdk.loadAgentSpec("./my-agent");
const registry = sdk.createToolRegistry();
await sdk.registerRtkTool(registry);
await sdk.loadPluginTools(spec, registry);

for await (const ev of sdk.runAgent({
	agentId: "my-agent",
	sessionId: "s-1",
	input: "what's new?",
	driver: sdk.rlmDriver({
		model: { provider: "google", model: "gemini-2.5-flash" },
		system: await readFile("./my-agent/SYSTEM.md", "utf8"),
	}),
	toolRegistry: registry,
})) {
	console.log(ev.type, ev.timestamp);
}
```

The package has no `exports` map, so there are no subpaths — everything comes
off the root, and the SDK surface is namespaced under `sdk`.

**Stability stamp:** `schema_version: 1` + `tools_api: 1` are the fields every
shipped bridge has run against. The SDK's first production consumer is
`khal-os/brain`, a multi-agent pipeline whose L1 triage and L2 preservation
bridges both run through `sdk.runAgent()`; its outer-`IterationDriver` bridge
pattern is a reusable template for migrating a working agent into the SDK
without rewriting its internals.

Deeper dives:

- [`docs/sdk-overview.md`](docs/sdk-overview.md) — layered architecture + design principles.
- [`docs/events.md`](docs/events.md) — the 13-event catalogue + emitter contract.
- [`docs/tool-authoring.md`](docs/tool-authoring.md) — TS/MJS + Python plugin recipes, RTK integration.
- [`docs/agent-yaml-schema.md`](docs/agent-yaml-schema.md) — `agent.yaml` field reference.
- [`examples/agents/`](examples/agents/README.md) — **the** microagent recipe tree: `explore`, `explore-r`, `codebase-qa`, `changelog`, `log-triage`, plus the three runnable SDK walk-throughs with tests (hello-world / research-agent / brain-triage).
- [`examples/`](examples/) — `rlmx.yaml` configuration examples (tauri-docs, paper-review, cag-*, gemini-*), which are not microagents.
- [`docs/worker-models.md`](docs/worker-models.md) — which model to run a microagent on: the round-2 evidence, per-arm price and run date, and what each arm's `n` does and does not establish.

## Live event stream (`rlmLoop({ emitter })`)

A real recursive `rlmLoop` run emits an observable, in-memory event
stream over the SDK's `createEmitter()` bus. This is the shared substrate
that the **rlmx-acp adapter** (web client) and **pi's native TUI** consume
as renderers — rlmx itself ships the events, not a UI.

### Subscribing (the contractual seam)

Pass a `createEmitter()` you have **already subscribed to** as
`rlmLoop`'s `emitter` option, so you receive events from the first
emission. Omit it and the run uses an internal emitter. The run closes
the emitter when it finishes (a `SessionClose` event, then the iterator
returns).

```ts
import { rlmLoop, sdk } from "@automagik/rlmx";

const emitter = sdk.createEmitter();

// Subscribe BEFORE the run starts.
(async () => {
	for await (const ev of emitter) {
		console.log(ev.type, ev.correlationId, ev.parentRunId);
	}
})();

await rlmLoop(query, context, config, { emitter }); // same signature the rlmx-acp adapter uses
```

### Event schema

Events reuse the existing SDK `AgentEvent` union (see
[`docs/events.md`](docs/events.md)) — **no schema fork**. On the recursion
path every event additionally carries two optional ancestry fields:

| field | meaning |
| --- | --- |
| `correlationId` | Stable id of the node the event belongs to. For a spawned child it is the sortable `uuidv7()` minted at the spawn site; for a run's own iterations it is that run's self-correlation id. |
| `parentRunId` | The `correlationId` of the parent node — the ancestry edge (maps to the child process's `RLMX_PARENT_RUN_ID`). Absent for the true root. |

**Build the recursion tree by keying on `correlationId` / `parentRunId`,
not `depth`** — `depth` cannot disambiguate sibling branches at the same
level, but two siblings of one parent always get distinct `correlationId`s.

Per-run producers and what they emit:

- `AgentStart`, `SessionOpen` — once at run start.
- `IterationStart`, `IterationOutput` — per parent iteration. `IterationOutput.metrics` carries per-node `latencyMs` / `toolCalls` / `costUsd` / `tokens` (incl. `reasoning`) from the wired `MetricsRecorder`, plus `responseModel` when the provider reports it.
- `ToolCallBefore` / `ToolCallAfter` — around each REPL execution.
- `Recurse` — **one per recursive `rlm_query` spawn**, carrying the child's `correlationId` and `parentRunId` (this run) — the ancestry edge.
- `IterationOutput` (child-completion) — bridged from `RlmChildResult.usage` when a child settles: the child node's cost / tokens / latency, keyed by its `correlationId`. A failed child additionally emits an `Error` (`phase: "recurse"`).
- `EmitDone`, `SessionClose` — once at run end.

### Headless subscriber (reference consumer)

[`scripts/watch-headless.mjs`](scripts/watch-headless.mjs) is the reference
consumer: it logs one compact JSON line per event (so `"type"` is
greppable) and reconstructs the recursion tree by `correlationId`.

```bash
# Deterministic proof (no credentials needed): a >=2-level recursive run
# with sibling branches at two levels.
node scripts/watch-headless.mjs -- "decompose and recurse on each part"
node scripts/watch-headless.mjs -- "…" | grep -c '"type":"Recurse"'   # one line per spawn

# Against a real run (needs a working model endpoint / provider key):
RLMX_HEADLESS_REAL=1 node scripts/watch-headless.mjs -- "your prompt"
```

### Scope note

Level-2 **live child-internal** streaming — a child's own iterations
surfaced to the parent bus over `src/ipc.ts` — is **not** included. A
recursive child is summarized as a single bridged completion node; the
root subscriber sees its direct spawns, and a collector aggregating the
process tree reconstructs deeper levels by `correlationId`. Streaming
child-internal events into the parent stream is the documented next step.

## ACP agent (`rlmx acp`) — wire rlmx into an ACP host

> **⚠️ Experimental.** `rlmx acp` works and is tested end-to-end, but its
> protocol surface may change without a deprecation cycle, and v1 **serializes
> prompt turns within a single active session** — a concurrent
> `session/prompt` is rejected with JSON-RPC `-32600` rather than queued. Every
> other part of rlmx documented here is stable.

`rlmx acp` is a stdio [Agent Client Protocol](https://agentclientprotocol.com)
agent: newline-delimited JSON-RPC over **stdin/stdout**, so any ACP client can
drive a real `rlmLoop` and render its live event stream. No port, no daemon —
the client spawns the process and owns its lifetime.

### One-time: find your absolute launch command

Every host entry needs the **absolute** path to the built CLI. Compute it once:

```bash
# From a clone of this repo:
npm ci && npm run build
node -e "console.log(require('path').resolve('dist/src/cli.js'))"
# → /ABS/PATH/TO/rlmx/dist/src/cli.js   ← use THIS everywhere below
```

The launch command is always: **`node /ABS/PATH/TO/rlmx/dist/src/cli.js acp`**
run **with `cwd` set to the project you want rlmx to operate in** (rlmx loads
`.rlmx/rlmx.yaml` from `cwd`, exactly like the CLI). Substitute your real
absolute path for `/ABS/PATH/TO/rlmx` in every snippet — nothing else changes.

> Sessions are durable. rlmx persists each ACP session (conversation history +
> cwd + config snapshot + any host MCP config) to `~/.rlmx/acp-sessions/<id>.json`,
> so `session/load` and a follow-up prompt keep working **after the host
> restarts the agent** — no "Invalid params". Override the store location with
> `RLMX_ACP_SESSIONS_DIR`.

### From Claude Code, Codex, or Hermes — via `acpx`

**This is the main path.** In ACP, the *client* is the editor and the *agent* is
the AI tool. Claude Code and Codex are themselves **agents**, so they cannot
consume `rlmx acp` directly — two agents don't speak to each other.

Bridge them with [`acpx`](https://github.com/openclaw/acpx), a headless ACP
client (verified with acpx 0.12.0). Any harness that can run a shell command
then drives rlmx:

```bash
# From /ABS/PATH/TO/your-project (this becomes the session cwd):
AGENT="node /ABS/PATH/TO/rlmx/dist/src/cli.js acp"

# One-time: register an acpx session for this cwd, driven by rlmx.
npx --yes acpx --agent "$AGENT" --cwd "$PWD" sessions new

# Then drive prompts by hand, repeating as you iterate (--approve-all skips
# permission prompts; drop it to answer them interactively):
npx --yes acpx --agent "$AGENT" --cwd "$PWD" --approve-all "What does this repo do?"

# Or the repo's own scripted end-to-end smoke (spawns + drives the agent):
node /ABS/PATH/TO/rlmx/scripts/smoke-acp.mjs              # fast handshake + prompt
node /ABS/PATH/TO/rlmx/scripts/smoke-acp.mjs --multiturn  # survives an agent restart
node /ABS/PATH/TO/rlmx/scripts/smoke-acp.mjs --recursive  # live translated recursion stream
```

### From an ACP editor client

Any editor that is a real ACP client can spawn rlmx directly — no `acpx` needed.
Zed is the reference implementation (Zed Industries authored ACP):

```jsonc
// Zed settings.json
{
  "agent_servers": {
    "rlmx": {
      "command": "node",
      "args": ["/ABS/PATH/TO/rlmx/dist/src/cli.js", "acp"],
      "cwd": "/ABS/PATH/TO/your-project",
      "env": { "RLMX_ACP_RUN_TIMEOUT_MS": "660000" }
    }
  }
}
```

Other ACP clients take the same three inputs — `command`, `args`, `cwd` — in
whatever shape their config uses.

### Remote (stdio over SSH) — first-class

Because the transport is pure stdio, a host on your laptop can drive rlmx on a
remote box with **no port, no tunnel, no `-t`** — SSH pipes stdin/stdout for
you. Point the host's `command` at `ssh` and pass the remote launch as args:

```jsonc
{
  "command": "ssh",
  "args": [
    "REMOTE_HOST",
    "/ABS/PATH/ON/REMOTE/node", "/ABS/PATH/ON/REMOTE/rlmx/dist/src/cli.js", "acp"
  ],
  "cwd": "/ABS/PATH/TO/local-placeholder"
}
```

- **Use the remote node's absolute path — not bare `node`.** A non-interactive
  SSH command (`ssh HOST node …`) does **not** source your login shell, so a
  `node` installed via a version manager (nvm, fnm, asdf, volta) or under
  `~/.local/bin` is **not on `PATH`** and you get `bash: node: command not
  found`. Find the absolute path once from an interactive session on the remote
  box — `ssh REMOTE_HOST` then `command -v node` (e.g. `/home/you/.nvm/versions/node/v20.11.0/bin/node`)
  — and hard-code it. (If node is installed system-wide at `/usr/bin/node`,
  bare `node` happens to work, but the absolute path is always safe.)
- Do **not** pass `ssh -t` — a PTY injects terminal control bytes that corrupt
  the JSON-RPC frame stream. Plain `ssh <host> /abs/node … acp` (no PTY) is
  correct.
- The session `cwd` that matters is the **remote** one; set it via the remote
  project dir where you launch, or by prefixing `cd /remote/project &&`.
- To pass env to the remote agent, set it in the remote command (SSH does not
  forward local env by default), e.g.
  `ssh REMOTE_HOST "RLMX_REPL_TIMEOUT_MS=600000 /ABS/PATH/ON/REMOTE/node /abs/…/cli.js acp"`.

### Env legend

| Env var | Effect |
| --- | --- |
| `RLMX_ACP_RUN_TIMEOUT_MS` | Override `rlmLoop`'s internal wall-clock cap for an ACP-hosted turn (default 300000). Raise it for recursive turns whose child spawns run long. |
| `RLMX_REPL_TIMEOUT_MS` | Max time a single REPL cell may run before it is killed. Raise it when a recursive `rlm_query` cell must outlast a slow child. |
| `RLMX_ACP_SESSIONS_DIR` | Override the durable session-store directory (default `~/.rlmx/acp-sessions`). Point it at scratch for hermetic tests. |
| `STATION_BASE_URL` / `LEMONADE_BASE_URL` | Local station/Lemonade gateway base URL (default `http://localhost:13305/api/v1`). |

Any provider API keys the chosen `.rlmx/rlmx.yaml` model needs are read from the
environment / `~/.rlmx/settings.json` exactly as for the CLI.

### MCP servers (store + advertise only)

`initialize` advertises `mcpCapabilities` (`http` + `sse`), and rlmx accepts and
**persists** the `mcpServers` a host passes on `session/new` / `session/load`.
rlmx does **not** yet execute tools against those servers — there is no MCP
client wired in — so the config is stored/advertised for continuity, and MCP
tool execution is a documented follow-on. A host is not misled: the advertised
capability carries `_meta["rlmx/mcp"] = "store-and-advertise-only; no MCP client
execution yet"`.

### Node-field legend — `rlm:` tool-call nodes

Each recursive `rlm_query` spawn surfaces as a flat ACP tool-call node with
`toolCallId = "rlm:<childCorrelationId>"`. Its completion `tool_call_update`
carries machine-readable per-node data under `_meta["rlmx/node"]`:

| `_meta["rlmx/node"]` field | meaning |
| --- | --- |
| `correlationId` | The child node's stable id (sortable `uuidv7()` minted at the spawn site). Join key for the recursion tree. |
| `parentRunId` | The spawning run's `correlationId` — the ancestry edge (absent for the root). |
| `depth` | Recursion depth of this child (`[d{depth}]` also appears in the node title). |
| `latencyMs` | Child wall-clock latency in ms. |
| `costUsd` | Child cost in USD (may be absent on keyless/local providers). |
| `tokens` | `{ input, output }` token counts for the child. |
| `error` | `{ name, message }` when the child failed (node status `failed`). |

A `tool_call_update` for an ordinary REPL execution instead carries
`_meta["rlmx/durationMs"]`. Client-facing payloads (args / output / titles) are
width-bounded and secret-redacted at the translator boundary before they cross
the web boundary.

## RTK Integration (token savings)

rlmx auto-detects [RTK](https://github.com/rtk-ai/rtk) and routes CLI subprocess calls through it when available, for 60-90% token savings on tool outputs.

### Install RTK (optional)

```bash
brew install rtk                                                                             # macOS
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh    # Linux/macOS
cargo install --git https://github.com/rtk-ai/rtk                                            # Rust
```

### How it works

- In your `.rlmx/TOOLS.md`, use `run_cli(cmd, *args)` instead of raw `subprocess.run(...)`
- When RTK is installed, `run_cli` transparently prefixes with `rtk` → filtered output
- When RTK is absent, `run_cli` passes through unchanged — no behavior break

### Configuration

```yaml
# .rlmx/rlmx.yaml
rtk:
  enabled: auto   # auto | always | never (default: auto)
```

- `auto` — use RTK when detected on PATH, otherwise pass through (fail-open)
- `always` — require RTK; `rlmx doctor` exits **2** if it is missing
- `never` — disable prefix even when RTK is installed

### Verify

```bash
rlmx doctor         # shows RTK status (installed version + mode)
rtk gain            # shows token savings from rlmx + other RTK integrations
```

> `rlmx doctor` exits **1** if **any** of the six provider keys it checks is
> unset, so a healthy single-provider install still exits non-zero. Read its
> output; don't script it as a pass/fail gate. Only exit 2 means a real config
> error (`rtk.enabled=always` with rtk absent).

### Before / after

```python
# Before — raw subprocess, full git output consumes tokens
import subprocess
out = subprocess.run(["git", "log", "-n", "10"], capture_output=True, text=True).stdout

# After — run_cli auto-routes through rtk when available
r = run_cli("git", "log", "-n", "10")
out = r["stdout"]   # filtered + compact; ~60-90% fewer tokens
```

## How It Works

rlmx implements the RLM (REPL-LM) algorithm:

1. **Prompt externalization** — Your context (files, directories) is loaded into a Python REPL as the `context` variable. Only metadata (type, size, chunk lengths) appears in the LLM message history. The LLM never sees the raw context in its messages.

2. **Iterative REPL loop** — The LLM writes Python code in ` ```repl``` ` blocks. rlmx executes each block in a persistent Python subprocess, feeds results back, and the LLM iterates until it calls `FINAL()` or `FINAL_VAR()`.

3. **Recursive sub-calls** — Inside REPL code, the LLM can call:
   - `llm_query(prompt)` — single LLM completion (fast, one-shot)
   - `llm_query_batched(prompts)` — concurrent LLM calls
   - `rlm_query(prompt)` — spawn a child RLM session (full iterative loop)
   - `rlm_query_batched(prompts)` — parallel child RLM sessions

4. **Termination** — The loop ends when the LLM calls `FINAL("answer")` or `FINAL_VAR("variable_name")`, or when max iterations (default 30) is reached.

## CAG Mode (Cache-Augmented Generation)

CAG mode bakes your full context into the system prompt and leverages provider-level caching so that subsequent queries against the same context are dramatically cheaper and faster.

### When to use `--cache` vs default RLM

| Mode | Best for | How it works |
|------|----------|-------------|
| **Default (RLM)** | Large corpora, exploratory analysis | Context loaded into REPL `context` variable; LLM navigates it programmatically |
| **`--cache`** | Repeated questions on same docs, study sessions, batch Q&A | Full context injected into system prompt and cached at the provider |

Use `--cache` when you plan to ask multiple questions about the same set of documents. Use default RLM when the context is too large for a single system prompt or you need programmatic navigation.

### Cost comparison

| Query | Cost |
|-------|------|
| First query (cache miss) | Full input token cost (context + prompt) |
| Subsequent queries (cache hit) | **50-90% cheaper** -- only cache-read tokens are billed |

The exact savings depend on your provider. Google and Anthropic both offer significant discounts on cached input tokens.

### Batch usage

Process a list of questions against cached context:

```bash
rlmx batch questions.txt --context ./docs/
rlmx batch questions.txt --context ./docs/ --output json
```

Each question in the file is run sequentially, reusing the cached context. The first question pays full cost; subsequent questions benefit from the cache. `--parallel <n>` runs them concurrently.

### Cache warmup and estimation

Warm the cache and estimate costs before running queries:

```bash
rlmx cache --context ./docs/ --estimate
```

This loads your context, calculates token counts, and shows estimated costs for cached vs uncached queries without making any LLM calls.

### YAML configuration

Enable cache in your `.rlmx/rlmx.yaml`:

```yaml
cache:
  enabled: true              # or use --cache flag per-invocation
  retention: long            # short|long -- maps to provider cache retention
  ttl: 3600                  # seconds -- provider-specific TTL
  expire-time: ""            # ISO 8601 -- for Google explicit caching
  session-prefix: "myproject" # prepended to content hash for sessionId
```

`session-prefix` is YAML-only — there is no `--session-prefix` flag.

For detailed provider-specific TTL behavior (Google, Anthropic, Bedrock, OpenAI), see [docs/TTL_CONTROL.md](docs/TTL_CONTROL.md).

## Gemini 3 Native

rlmx integrates Gemini 3 native features. All are opt-in, additive, and silently ignored on non-Google providers.

### Quick Start

```yaml
# .rlmx/rlmx.yaml
model:
  provider: google
  model: gemini-3.1-flash-lite-preview

gemini:
  thinking-level: medium      # Control thinking depth
  google-search: true          # Web search in REPL
  url-context: true            # Fetch URLs in REPL
  code-execution: true         # Server-side Python
  media-resolution:
    images: high               # ~1120 tokens/image
    pdfs: medium               # ~560 tokens/page
    video: low                 # ~70 tokens/frame
```

```bash
rlmx "Research latest AI developments" --context ./notes/ --tools standard --thinking high
```

### Features

| Feature | Config | CLI Flag | Description |
|---------|--------|----------|-------------|
| Thinking levels | `gemini.thinking-level` | `--thinking` | minimal/low/medium/high — controls reasoning depth |
| Thought signatures | automatic | — | Multi-turn quality via pi/ai signature circulation |
| Structured output | `output.schema` | — | JSON Schema enforcement via API (not text parsing) |
| Google Search | `gemini.google-search` | — | `web_search()` battery in REPL |
| URL Context | `gemini.url-context` | — | `fetch_url()` battery in REPL |
| Code Execution | `gemini.code-execution` | — | Server-side Python alongside local REPL |
| Image Generation | `gemini.image-gen` | — | `generate_image()` via Nano Banana |
| Media Resolution | `gemini.media-resolution` | — | Per-type token cost control |
| Batch API | — | `--batch-api` | 50% cost reduction for bulk operations |
| Context Caching | `cache.enabled` | `--cache` | 90% discount on cached tokens |
| Function + Tools | automatic | — | Custom functions + built-in tools in one API call |

Three keys are accepted, validated and then **warn instead of doing anything** —
`gemini.computer-use`, `gemini.maps-grounding`, `gemini.file-search`. Setting one
prints a "planned" warning; nothing is wired up behind it.

### Cost Comparison

| Mode | Cost (per 1M tokens) | Savings |
|------|---------------------|---------|
| Base (flash-lite) | $0.075 input / $0.30 output | — |
| + Context caching | ~$0.0075 input (cached) | 90% on input |
| + Batch API | ~$0.0375 input / $0.15 output | 50% on all |
| Cache + Batch | ~$0.00375 input (cached+batch) | 95% on cached input |

**100 queries over 500K context: < $2.00** with cache + batch stacking.

### Provider Compatibility

| Feature | Google | Anthropic | OpenAI | Others |
|---------|--------|-----------|--------|--------|
| Thinking levels | native | ignored | ignored | ignored |
| Thought signatures | native | ignored | ignored | ignored |
| Structured output | API-enforced | FINAL() fallback | FINAL() fallback | FINAL() fallback |
| Web search/URL | native | error msg | error msg | error msg |
| Code execution | native | local only | local only | local only |
| Media resolution | native | ignored | ignored | ignored |
| Batch API | native | standard batch | standard batch | standard batch |
| Context caching | native | native | native | provider-dependent |

### Gemini Batteries (REPL Functions)

Available with `--tools standard` or `--tools full` when provider is Google:

```python
# In REPL code:
result = web_search("latest nodejs version")
print(result)

page = fetch_url("https://example.com/docs")
print(page[:500])

img_path = generate_image("architecture diagram of microservices")
print(img_path)
```

Non-Google providers get clear error messages: `"web_search() requires provider: google"`.

### Examples

See `examples/` for complete configs:
- `gemini-research/` — Web search + URL context research agent
- `gemini-multimodal/` — Media resolution + image analysis
- `gemini-cheap-batch/` — Maximum cost stacking example

## Config Files

Config lives in a `.rlmx/` directory beside your project. `rlmx init` scaffolds
it with inline comments; `rlmx init --template code` uses the code-oriented
prompt set. **Only `.rlmx/` is read** — a `SYSTEM.md` at the repository root is
silently ignored.

| File | Purpose |
|------|---------|
| `.rlmx/rlmx.yaml` | Model, context, budget, cache, storage, rtk, gemini config. Its presence is what makes rlmx use the directory at all; without it you get built-in defaults. |
| `.rlmx/SYSTEM.md` | System prompt sent to the LLM. Default: the RLM paper prompt. |
| `.rlmx/CRITERIA.md` | Output format criteria appended to the system prompt. |
| `.rlmx/TOOLS.md` | Custom Python functions injected into the REPL namespace. |

Model selection is the `model:` block in `.rlmx/rlmx.yaml`, `--model <ref>` for
one run, or `rlmx config set model.provider …` globally. There is no
`MODEL.md` — nothing loads it.

### TOOLS.md Format

Define custom REPL tools as `## heading` + `python` code block:

```markdown
## search_docs
` ``python
def search_docs(keyword):
    """Search context for files matching keyword."""
    matches = [item for item in context if keyword.lower() in item['content'].lower()]
    return [m['path'] for m in matches]
` ``

## summarize_chunk
` ``python
def summarize_chunk(text, max_words=100):
    """Summarize a chunk of text."""
    return llm_query(f"Summarize in {max_words} words:\n{text}")
` ``
```

## CLI Reference

`rlmx --schema` prints the machine-readable flag/output/exit-code contract as
JSON — that is the generated source of truth; this table is the readable copy.

```
rlmx "query" [options]                              Run an RLM query
rlmx init [--template default|code] [--dir <path>]  Scaffold .rlmx/ config
rlmx cache [options]                                Pre-warm cache or estimate context size
rlmx batch <file> [options]                         Bulk interrogation from a questions file
rlmx benchmark <mode> [options]                     Run benchmarks (cost or oolong)
rlmx stats [options]                                Query run history and cost breakdowns
rlmx config <set|get|list|delete|path>              Manage ~/.rlmx/settings.json
rlmx doctor                                         Health check: providers, RTK, config
rlmx update [--force]                               Fetch latest main commit for a git install
rlmx acp                                            Run as a stdio ACP agent (EXPERIMENTAL)
rlmx mcp [--dir <path>]                             Run as a stdio MCP server (agents as tools)

Options:
  --context <path>        Path to context (directory or file)
  --output <mode>         Output mode: text (default), json, stream
  --verbose               Show iteration progress on stderr
  --max-iterations <n>    Maximum RLM iterations (default: 30)
  --timeout <ms>          Timeout in milliseconds (default: 300000)
  --dir <path>            Working directory for init and mcp (default: cwd)
  --help, -h              Show this help message
  --version, -v           Show version
  --schema                Output machine-readable CLI schema JSON

  --stats                 Emit JSON stats to stderr (or include in --output json)
  --log <path>            Write structured JSONL log to file
  --tools <level>         Tool level: core (default), standard, full
  --max-cost <n>          Maximum USD spend per run
  --max-tokens <n>        Maximum total tokens per run
  --max-depth <n>         Maximum recursive rlm_query depth
  --model <ref>           Model for this run: "provider/model" or a bare model id
  --ext <list>            File extensions for context dirs (comma-separated)
  --thinking <level>      Thinking level: minimal, low, medium, high (Gemini 3)
  --cache                 Enable cache mode (full context in system prompt)
  --no-session            Disable auto-save of session data
  --estimate              Show context size and cost estimate without caching (cache)
  --parallel <n>          Concurrent questions for batch command (default: 1)
  --batch-api             Use Gemini Batch API for 50% cost reduction (batch)
  --template <name>       Template for init: default or code
```

Sub-command shapes:

```bash
rlmx benchmark cost [--output json]                 # built-in dataset
rlmx benchmark oolong [--samples 5] [--idx 42]      # auto-installs HF datasets
rlmx stats [--run <id>] [--costs] [--tools] [--since 24h|7d|30m] [--output json]
```

Exit codes: `0` success · `1` general/validation error, missing query, missing
provider key, or empty-response abort · `2` `rtk.enabled=always` with rtk absent
· `130` SIGINT · `143` SIGTERM.

## Output Modes

### Text (default)

Prints the final answer to stdout.

### JSON

```bash
rlmx "query" --output json
```

Returns:

```json
{
  "answer": "The answer to your query...",
  "references": ["docs/start/create-project.md", "docs/concept/inter-process-communication.md"],
  "usage": {
    "inputTokens": 12500,
    "outputTokens": 3200,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0,
    "totalCost": 0.0041,
    "llmCalls": 5
  },
  "iterations": 3,
  "model": "google/gemini-3.1-flash-lite-preview"
}
```

`answer`, `references`, `usage`, `iterations` and `model` are always present,
and `usage` always carries all six fields above. Optional additions:
`reasoningTokens` inside `usage` when the provider reports it, plus
`usageBreakdown` (root/child/total split on recursive runs), `budgetHit`,
`geminiCounts`, `geminiBatteriesUsed`, and `stats` (with `--stats`).

### Stream

```bash
rlmx "query" --output stream
```

Emits JSONL events per iteration, then a final event.

## Context Loading

| Input | Behavior |
|-------|----------|
| `--context dir/` | Recursively reads `*.md` files as `list[{path, content}]` (extensions configurable via `context.extensions` / `--ext`) |
| `--context file.md` | Reads as single string |
| `--context file.json` | Parses JSON as dict or list |
| stdin pipe | Reads as single string |

## Settings and Environment Variables

Provider keys can live in the environment or in `~/.rlmx/settings.json`, which
`rlmx config set` writes. Priority is **CLI flags > settings.json >
`.rlmx/rlmx.yaml` > defaults** — settings.json outranks the project YAML on
purpose, so `rlmx config set model.provider openai` takes effect in a checkout
that has its own `model:` block.

```bash
rlmx config set GEMINI_API_KEY <key>     # persisted, chmod-restricted
rlmx config set model.provider google
rlmx config list                         # API keys masked
rlmx config path                         # ~/.rlmx/settings.json
```

Recognised provider keys, as env vars or settings keys: `GEMINI_API_KEY`,
`GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`,
`XAI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `KIMI_API_KEY`,
`MOONSHOT_API_KEY`, `MINIMAX_API_KEY`, `ZAI_API_KEY`, `GLM_API_KEY`. A
settings-file key is injected into the environment only when that env var is not
already set, so the ambient environment always wins.

Other environment variables rlmx reads:

| Env var | Effect |
| --- | --- |
| `RLMX_AGENTS_DIR` | Colon-separated list that **replaces** the default microagent roots. |
| `RLMX_MCP_RUN_TIMEOUT_MS` | Wall-clock cap for one `rlmx mcp` tool call. |
| `RLMX_ACP_RUN_TIMEOUT_MS`, `RLMX_ACP_SESSIONS_DIR`, `RLMX_REPL_TIMEOUT_MS` | See the ACP env legend above. |
| `STATION_BASE_URL` / `LEMONADE_BASE_URL` | Local `station/` gateway base URL (default `http://localhost:13305/api/v1`). |
| `KHAL_API_KEY` (or `RLMX_KHAL_API_KEY`) / `KHAL_BASE_URL` | Credentials and endpoint for the native `khal/` provider. |
| `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | Enable Langfuse trace export. |
| `RLMX_PARENT_RUN_ID`, `RLMX_CHILD_CORRELATION_ID`, `RLMX_RECURSION_DEPTH` | Set by rlmx on spawned recursive children — read, not authored by you. |

## Programmatic API

```typescript
import { rlmLoop, loadConfig, loadContext } from "@automagik/rlmx";

const config = await loadConfig("./");        // reads ./.rlmx/
const context = await loadContext("./docs/");

const result = await rlmLoop("How does IPC work?", context, config, {
  maxIterations: 10,
  timeout: 60000,
  verbose: false,
  output: "json",
});

console.log(result.answer);
console.log(result.references);
```

## Requirements

- Node.js >= 22.19.0
- Python 3.10+ (for the REPL subprocess)
- An LLM API key (Anthropic, OpenAI, Google, etc.) — or a local `station/` gateway, which needs none

## Versioning

rlmx uses **calendar versioning**: `0.YYMMDD.N`, where `YYMMDD` is the UTC build
date and `N` is a daily counter. A version records *when* a build was cut and
carries **no compatibility promise** — read `CHANGELOG.md`, not the version
delta, to learn about breaking changes. The release boundary is a PR merge into
`main`, and the bump is **automatic** — CI derives the next version on merge and
commits it, so do not hand-run `npm run bump-version` in a PR unless you intend
that reviewed version to be the released one. See
[`docs/release-contract.md`](docs/release-contract.md).

## License

MIT
