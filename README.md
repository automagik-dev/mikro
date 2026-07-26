# rlmx

RLM algorithm CLI for coding agents — prompt externalization, Python REPL with symbolic recursion, code-driven navigation.

Based on the [RLM paper](https://arxiv.org/abs/2501.12599) (REPL-based LLM Method). Uses [pi/ai](https://github.com/nickarora/pi-ai) as the multi-provider LLM client.

## Production validation (2026-04-22)

The SDK (`rlmx.sdk.*`) is production-validated via its first consumer,
`khal-os/brain`, a multi-agent pipeline over WhatsApp / long-form
archives. Three agent bridges run through `sdk.runAgent()`:

| bridge | role | slate | status |
|---|---|---|---|
| L1 triage | worth-processing filter | 30 windows | **SHIP 30/30** structural match vs legacy path |
| L2 preservation | multi-step extraction + brain mutation | 24 windows | **SHIP at variance ceiling** (baseline×baseline ≈ baseline×bridge) |
| L3 audit | sampled self-audit | slate in flight | pending verdict |

Evidence depth (metadata only — no content):

- Dogfood reports live in the brain repo under
  `brain-lab/rlmx-sdk-bridge-report/` (L1) and
  `brain-lab/rlmx-sdk-bridge-report-l2/` (L2). Each carries a
  `SHIP-decision.md` with the baseline-vs-bridge delta table + stop-
  reason distribution.
- Event streams, permission hooks, validate-with-retry, and session
  checkpoints are all exercised per-window. Cost and latency are
  captured per iteration.
- Brain's bridge pattern (an outer `IterationDriver` wrapping the
  legacy pi-agent loop) is a reusable template for consumers that
  want to migrate a working agent into the SDK without rewriting
  its internals. See `src/agent/rlmx-bridge.ts` in `khal-os/brain`
  for the reference implementation.

**Stability stamp:** `schema_version: 1` + `tools_api: 1` are the
fields every bridge has shipped against. See
[`docs/agent-yaml-schema.md`](docs/agent-yaml-schema.md) for the
schema itself.

## Install

```bash
npm install -g rlmx
```

## Quick Start

```bash
# Scaffold config files in current directory
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

A microagent is an `agent.yaml` folder ([schema](docs/agent-yaml-schema.md))
in any of:

```
~/.rlmx/agents/<name>/      # global
<project>/.agents/<name>/   # project
<project>/.rlmx/agents/<name>/
```

Project agents shadow global ones with the same name. `RLMX_AGENTS_DIR`
(colon-separated) replaces those roots.

```yaml
# ~/.rlmx/agents/triage/agent.yaml
schema_version: 1
shape: loop
model: station/Qwen3.6-35B-A3B-MTP-GGUF   # local — $0 marginal cost
description: Classifies inbound issues and proposes a label + owner.
system: SYSTEM.md
```

> **Choosing `shape`.** rlmx externalizes context into the Python REPL — the
> model has to *run code* to read it. So `shape: single-step` gives it one pass
> and it answers **before ever opening your file**. Use `single-step` only when
> the whole input fits in the prompt; use `loop` with a `budget.max_iterations`
> whenever the agent takes `context`. Symptom of getting this wrong: a
> confident answer and a suspiciously small input-token count in the footer.

Each result ends with what it cost, so the offload is visible rather than
assumed:

```
rlmx · agent=triage · station/Qwen3.6-35B-A3B-MTP-GGUF · 3 iterations · 307 in / 36 out · $0.00 · 3.9s
```

Long runs emit `notifications/progress` per iteration, which keeps conforming
clients from timing out mid-delegation. `RLMX_MCP_RUN_TIMEOUT_MS` lifts rlmx's
own wall-clock cap.

Gate: `node scripts/smoke-mcp.mjs`.

> Not to be confused with `rlmx acp` below. In ACP the *client* is an editor and
> the *agent* is the AI tool — Claude Code and Codex are agents themselves, so
> they can't drive rlmx over ACP. MCP is the protocol they speak as clients.

## SDK (`rlmx.sdk.*`)

rlmx also ships a programmatic SDK for consumers that need to drive
agents from code — with per-iteration observability, permission
hooks, validate-with-retry, session checkpointing, and a pluggable
tool registry. The CLI path above is untouched; the SDK is purely
additive.

```ts
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
		system: await Bun.file("./my-agent/SYSTEM.md").text(),
	}),
	toolRegistry: registry,
})) {
	console.log(ev.type, ev.timestamp);
}
```

Deeper dives:

- [`docs/sdk-overview.md`](docs/sdk-overview.md) — layered architecture + design principles.
- [`docs/events.md`](docs/events.md) — the 12-event catalogue + emitter contract.
- [`docs/tool-authoring.md`](docs/tool-authoring.md) — TS/MJS + Python plugin recipes, RTK integration.
- [`docs/agent-yaml-schema.md`](docs/agent-yaml-schema.md) — `agent.yaml` field reference.
- [`examples/`](examples/) — three runnable example agents (hello-world / research-agent / brain-triage) with smoke tests.

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
import { createEmitter } from "@automagik/rlmx/sdk";
import { rlmLoop } from "@automagik/rlmx";

const emitter = createEmitter();

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

- In your `TOOLS.md`, use `run_cli(cmd, *args)` instead of raw `subprocess.run(...)`
- When RTK is installed, `run_cli` transparently prefixes with `rtk` → filtered output
- When RTK is absent, `run_cli` passes through unchanged — no behavior break

### Configuration

```yaml
# rlmx.yaml
rtk:
  enabled: auto   # auto | always | never (default: auto)
```

- `auto` — use RTK when detected on PATH, otherwise pass through (fail-open)
- `always` — require RTK; `rlmx doctor` exits non-zero if missing
- `never` — disable prefix even when RTK is installed

### Verify

```bash
rlmx doctor         # shows RTK status (installed version + mode)
rtk gain            # shows token savings from rlmx + other RTK integrations
```

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

Each question in the file is run sequentially, reusing the cached context. The first question pays full cost; subsequent questions benefit from the cache.

### Cache warmup and estimation

Warm the cache and estimate costs before running queries:

```bash
rlmx cache --context ./docs/ --estimate
```

This loads your context, calculates token counts, and shows estimated costs for cached vs uncached queries without making any LLM calls.

### YAML configuration

Enable cache in your `rlmx.yaml`:

```yaml
cache:
  enabled: true              # or use --cache flag per-invocation
  retention: long            # short|long -- maps to provider cache retention
  ttl: 3600                  # seconds -- provider-specific TTL
  expire-time: ""            # ISO 8601 -- for Google explicit caching
  session-prefix: "myproject" # prepended to content hash for sessionId
```

For detailed provider-specific TTL behavior (Google, Anthropic, Bedrock, OpenAI), see [docs/TTL_CONTROL.md](docs/TTL_CONTROL.md).

## Gemini 3 Native (v0.4)

rlmx v0.4 integrates 14 Gemini 3 native features, making it the cheapest and most capable context agent available. All features are opt-in, additive, and silently ignored on non-Google providers.

### Quick Start

```yaml
# rlmx.yaml
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
| Computer Use | `gemini.computer-use` | — | Planned for v0.5 |
| Maps Grounding | `gemini.maps-grounding` | — | Planned for v0.5 |
| File Search | `gemini.file-search` | — | Planned for v0.5 |
| Function + Tools | automatic | — | Custom functions + built-in tools in one API call |

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

Drop `.md` files in your working directory to customize behavior. Run `rlmx init` to scaffold defaults with inline comments.

| File | Purpose |
|------|---------|
| `SYSTEM.md` | System prompt sent to the LLM. Default: exact RLM paper prompt. |
| `CONTEXT.md` | Context loading documentation (informational). |
| `TOOLS.md` | Custom Python functions injected into the REPL namespace. |
| `CRITERIA.md` | Output format criteria appended to the system prompt. |
| `MODEL.md` | LLM provider and model selection. |

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

### MODEL.md Format

```markdown
provider: google
model: gemini-3.1-flash-lite-preview
sub-call-model: gemini-3.1-flash-lite-preview
```

Supports any provider available in [pi/ai](https://github.com/nickarora/pi-ai): `anthropic`, `openai`, `google`, etc.

## CLI Reference

```
rlmx "query" [options]                Run an RLM query
rlmx init [--dir <path>]             Scaffold config files
rlmx batch <file> [options]           Run batch queries from a file
rlmx cache [options]                  Cache management (warmup, estimate)

Options:
  --context <path>        Path to context (directory or file)
  --cache                 Enable CAG mode (cache context in system prompt)
  --output <mode>         Output mode: text (default), json, stream
  --verbose               Show iteration progress on stderr
  --max-iterations <n>    Maximum RLM iterations (default: 30)
  --timeout <ms>          Timeout in milliseconds (default: 300000)
  --dir <path>            Directory for init command (default: cwd)
  --help, -h              Show this help message
  --version, -v           Show version

Gemini options:
  --thinking <level>      Thinking level: minimal, low, medium, high
  --batch-api             Use Gemini Batch API for 50% cost reduction

Cache options:
  --estimate              Estimate cache costs without making LLM calls
  --session-prefix <str>  Override session prefix for cache key
```

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
  "usage": { "inputTokens": 12500, "outputTokens": 3200, "llmCalls": 5 },
  "iterations": 3,
  "model": "google/gemini-3.1-flash-lite-preview"
}
```

### Stream

```bash
rlmx "query" --output stream
```

Emits JSONL events per iteration, then a final event.

## Context Loading

| Input | Behavior |
|-------|----------|
| `--context dir/` | Recursively reads `*.md` files as `list[{path, content}]` |
| `--context file.md` | Reads as single string |
| `--context file.json` | Parses JSON as dict or list |
| stdin pipe | Reads as single string |

## Environment Variables

rlmx uses pi/ai for LLM calls. Set the appropriate API key for your provider:

- `GEMINI_API_KEY` — for Google Gemini models (default provider)
- `ANTHROPIC_API_KEY` — for Anthropic models
- `OPENAI_API_KEY` — for OpenAI models

## Programmatic API

```typescript
import { rlmLoop, loadConfig, loadContext } from "rlmx";

const config = await loadConfig("./");
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
- An LLM API key (Anthropic, OpenAI, Google, etc.)

## License

MIT
