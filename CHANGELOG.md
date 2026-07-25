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

## [0.260725.1] — 2026-07-25

First release since `0.260528.2`. Lands the ACP agent, the recursion event
stream, the pi-ai 0.80 Models runtime, and the local `station` provider, and
clears the production dependency tree of known advisories.

### Added

- **`rlmx acp` — stdio ACP agent (experimental).** Exposes rlmx over the
  [Agent Client Protocol](https://agentclientprotocol.com) so it can be driven
  from ACP hosts (Zed, Tidewave, Newio, `acpx`). Translates the instrumented
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
