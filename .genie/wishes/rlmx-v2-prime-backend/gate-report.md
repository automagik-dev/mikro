# Gate Report — rlmx v2 RuntimeBackend parity/compatibility gate

Wish: `rlmx-v2-prime-backend` · Branch: `wish/rlmx-v2-prime-backend` · Gate model: `deepseek/deepseek-v4-flash` (Decision 7, amended 2026-08-14)

**Status: gate setup recorded — measurements pending.**

## Gate-setup decisions (recorded BEFORE any run — per WISH.md Group 3 prerequisite 3)

These are the decisions the wish requires at gate setup, never after seeing scores.

### D1. Task-root re-pointing (prerequisite 3)
The frozen suite's recorded roots — `/home/namastex/prod/brain` and `/home/namastex/workspace/repos/genie` — are Linux-host paths not present on this machine and not creatable here (no root access). **Decision, approved by Felipe ("do it", 2026-08-16):** re-point the roots to local checkouts of the same repositories:

| Frozen root | Re-pointed root | Repo identity | HEAD at setup |
|---|---|---|---|
| `/home/namastex/prod/brain` | `/Users/feliperosa/workspace/repos/brain` | `git.namastex.io/khal/brain.git` (origin), rsynced from `genie-cegonha:/home/genie/prod/brain` — same tree, same commit | `1c6c9ca` chore(release): publish latest binaries 2.21.0 |
| `/home/namastex/workspace/repos/genie` | `/Users/feliperosa/workspace/repos/genie` | `github.com/automagik-dev/genie.git` (origin) | `3a7e9ce74` docs(wish): record the approved WAL-heal rescope |

Drift disclosure (carried from `docs/parity-explore.md:63`): the suite was mined against live checkouts that have moved since. The agent's own citations (rubric criterion 2) resolve against the tree each leg actually reads — recorded per run as `rootGit` — so both legs are scored against identical trees and the comparison stays fair. Absolute quality vs the native ground-truth arm may drift; the ≥5/6 bar is applied per the frozen doc's arithmetic regardless. The task files themselves are untouched.

### D2. Legacy-leg credential (prerequisite 2, amended)
`DEEPSEEK_API_KEY` was not in the environment. **Decision:** provision from the operator's macOS keychain (`deepseek-api-key`) — the user's own DeepSeek credential, already used by their bench harness. Verified live against `https://api.deepseek.com/v1/chat/completions` (model `deepseek-v4-flash` answered correctly) before any gate run. The key is exported to gate runs via a 0600 env file only; it is never written into this report, git, or any log. Prime leg: prime-agent's own credential store (live `--provider deepseek` spawns succeeded on this machine 2026-08-14/16).

### D3. Station/Lemonade gateway (prerequisite 1) — substitution
No station/Lemonade gateway is running on this host (checked 127.0.0.1:8080 and ollama). **Decision:** under the deepseek re-pin no scored leg touches a station-pinned model, so the gateway's scored-load requirement is met by elimination. The station-pinned shipped agents remain legacy-only and excluded from the quality comparison (Scope OUT), as planned. Consequence for the validation command: `scripts/smoke-explore.mjs`'s gating arm defaults to `station/Brain-35B`, so the gate runs it with `RLMX_SMOKE_MODEL=deepseek/deepseek-v4-flash` (+ `DEEPSEEK_API_KEY`) — the arm exercises the explore recipe through the legacy backend on the gate model, which is what this gate measures. The khal arm is skipped (no `KHAL_API_KEY`; reported-not-gated by the script's own design).

### D4. Binary and thresholds (as recorded in WISH.md, verified at setup)
- Prime leg binary: `prime-agent` pinned **`0.7.2`** — exact version recorded from `prime-agent --version` in the run section below. Version check enforced by the backend itself.
- Pooled-RPC trigger thresholds at gate setup: prime P50 wall-clock ≥ 1.5× legacy P50, or median spawn/cold-start overhead > 2s per turn (wall-clock limb fires only with cold-start corroboration). Retunable only by a decision recorded here before any numbers are read — this section is that record; it stands as written.
- Gate model pin: `deepseek/deepseek-v4-flash` on both legs; resolved-model pre-flight asserts this per leg before any scored task.

### D5. Hermeticity
Prime leg spawns with `-nc -ne -ns -np` (no host context files/extensions/skills/prompt templates) — reproducibility per the WISH AC. Legacy leg: `RLMX_AGENTS_DIR` pointed at the gate-only directory alone, replacing default discovery roots.

---

## Gate-execution decisions (recorded by the gate engineer BEFORE any scored task — 2026-08-16)

The setup section above (D1–D5, commit 66f08a2) is preserved byte-for-byte as
the record of pre-run decisions. The following decision was taken at gate
execution start, before any model call, and is recorded here rather than in
the setup section so that the setup section remains exactly as committed.

### D6. Task-root `.rlmx/` configs excluded via mirror cwds (both legs)

Discovered at execution time, before any run: all three trees involved in this
gate ship a `.rlmx/` config directory at their root — the two re-pointed task
roots (brain and genie each carry `rlmx.yaml` + `SYSTEM.md` + `CRITERIA.md` +
`TOOLS.md`) and this repo itself. Because `rlmx mcp --dir <root>` makes the
task root the server cwd, `loadConfig(cwd)` (`src/config.ts:594`) loads that
`.rlmx/`, and:

1. The genie and rlmx `TOOLS.md` files each parse one custom REPL tool
   (`run_cli_example (demonstrates RTK auto-prefix)` — verified with
   `parseToolsMd` at gate setup; the brain one parses none). Prime's landed
   Group 2 backend rejects `config.tools` loudly (`assertSupportedConfig`,
   `src/mcp/backends/prime.ts`), so the prime leg would throw before running
   any genie-rooted task (tasks 2, 5, 6).
2. The roots' ambient configs pin `google/gemini-3.1-flash-lite-preview` and
   carry per-root `CRITERIA.md` content — root-specific ambient state that
   differs between the two checkouts and muddles config parity between legs.

**Decision:** the gate runs **both legs** from a scratch **mirror cwd** per
root — a directory of symlinks to every top-level entry of the re-pointed
checkout **except `.rlmx`** (built by `gate-agents/run-gate.mjs mirror` under
`gate-agents/.work/mirrors/`, gitignored). Consequences, symmetric across
legs: `loadConfig` finds no config, so both legs run on identical default
config; the REPL reads the real tree through the mirror (same bytes, same
commits — `.git` is symlinked too, so each run's `rootGit` is recorded from
the checkout itself); citations are scored against the mirror tree (the tree
the leg actually read — recorded as `root`/`rootOverride` in each run and
score JSON). The frozen task files are untouched; nothing is written into the
re-pointed checkouts (one disclosed caveat: a mirror symlink is not a write
barrier — the frozen r1–r15 rounds ran against the live checkouts with the
same exposure). The exclusion list is exactly one entry: `.rlmx`.

### D7. Run-clock corrections, both legs (recorded before the re-run; first legacy pass preserved as evidence)

The first legacy pass over the frozen suite ran at harness defaults and
produced two environment artifacts, not recipe outcomes: (a) task 1 died on
rlmLoop's 30s REPL-execution watchdog (`RLMX_REPL_TIMEOUT_MS` default) while
the agent was fanning out recursive spawns at iteration 3 — the harness's own
header names this a caller-owned environment correction (`parity/run-task.mjs`
records `replTimeoutMs` per run for exactly this reason); (b) all six run
JSONs lost `rootGit.head` to a `git status` failure on symlinked checkout
paths (a harness `gitState` bug, fixed to isolate head from status). That pass
is preserved under `runs/gate-v2-legacy/first-attempt-defaults/` as evidence
and is not scored.

**Decision:** the scored legs run with `RLMX_REPL_TIMEOUT_MS=120000`
(legacy-only knob — prime has no REPL-execution cap; disclosed per run in
`provenance.replTimeoutMs`) and `RLMX_MCP_RUN_TIMEOUT_MS=600000` on **both**
legs (the harness's caller-owned wall-clock correction, recorded per run as
`provenance.runTimeoutMs`; a single long task — legacy task 2 completed at
301s wall, i.e. against the 300s default — must not turn the quality
comparison into a wall-clock rail test; the deadline behavior itself is
measured separately by the forced-abort exercise).

### D8. Mirror freshness per task (recorded before the re-runs; contaminated runs preserved as evidence)

The D6 mirror caught a real write: during the first legacy pass, the explore
agent scaffolded `.rlmx/` in its own cwd via `rlmx init` (the brain mirror's
`.rlmx/` carries mtime 15:32, mid-first-pass; the four files match the
default `rlmx init` template byte sizes). Two consequences, both environment
artifacts: (a) every later task on the brain mirror loaded that scaffolded
config — the legacy re-run's brain tasks ran with one ambient REPL tool and
template criteria appended, and the prime leg's brain tasks (1, 3, 4) failed
loudly at 0.9s on `assertSupportedConfig` (custom REPL tools); (b) the write
landed in the gitignored mirror, **not** in the user's checkout — both
checkouts were verified clean after the runs (git status; the genie checkout's
three pre-existing modified files predate the gate, Aug 13–14).

**Decision:** `run-gate.mjs` rebuilds each task's mirror fresh before the run
(delete + re-link, symlinks only), and each task is scored inline against the
exact mirror state it read, before the next rebuild. The contaminated records
are preserved under `runs/gate-v2-legacy/` (tasks 1, 3, 4 of the second pass,
which ran with the scaffolded config) and `runs/gate-v2-prime/` (tasks 1, 3,
4, which failed on it) as evidence; the scored set re-runs those six tasks
(legacy 1/3/4 + prime 1/3/4) with fresh mirrors, everything else identical.

---

## Measurements (to be filled by the gate run; each number carries the command that produced it)

| # | Metric | Legacy (`backend: rlmx`) | Prime (`backend: prime`) |
|---|---|---|---|
| 1 | Prime binary version (verbatim) | — | |
| 2 | Resolved model per leg (pre-flight) | | |
| 3 | Task 1–6 quality (pass/fail per task, rubric) | | |
| 4 | Suite pass count (≥5/6 = gate bar) | | |
| 5 | Cost per task + total | | |
| 6 | Tokens per task (in/out) | | |
| 7 | Wall-clock latency per task + P50 | | |
| 8 | Cold-start / spawn overhead (median) | | |
| 9 | Concurrency: parallel distinct-cwd runs, leakage | | |
| 10 | Forced aborts: deadline + ceiling, both legs | | |
| 11 | Pooled-RPC trigger evaluation | | |

## Verdict

(To be written — `Verdict: PASS` or `Verdict: FAIL` with the fallback decision.)
