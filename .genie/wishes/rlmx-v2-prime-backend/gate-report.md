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
