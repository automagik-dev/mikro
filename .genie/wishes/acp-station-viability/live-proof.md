# Live proof — Group 3: direct mode answers on the station arm under the bare 300s deadline

**Date:** 2026-08-03 · **Worker:** acp-g3-opus · **Task:** t_msd4o3rgde69a6d3
**Repo:** /home/namastex/prod/rlmx (branch `wish/rlmx-proof`; live campaign session — untouched)
**Arm:** `station/qwen3.6-moe-35b-a3b-FLM` via the local Lemonade gateway `http://localhost:13305/api/v1`
**Raw data:** [`evidence/g3-live-proof/run1.json`](evidence/g3-live-proof/run1.json)
**Driver:** [`evidence/g3-live-proof/drive-acp-proof.mjs`](evidence/g3-live-proof/drive-acp-proof.mjs)

---

## VERDICT

**PASS on both criteria, with a wide margin.**

| criterion | bar | measured |
|---|---|---|
| C2 — n ≥ 3 one-line prompts | all answers non-empty | **3 / 3 non-empty**, all `stopReason: end_turn` |
| C2 — median latency | ≤ 120 s | **5.60 s** (4.7 % of the bar) |
| C2 — every sample | < 300 s | **max 6.43 s** (2.1 % of the deadline) |
| C2 — gateway liveness | pre + post every sample | **10 / 10 checks HTTP 200**, target model present in all; **0 samples voided** |
| C2b — two turns, one session | turn 2 references turn 1's fact | **verbatim: `TANGERINE-91`** |

No sample was voided, so no sample was re-run. The whole campaign-facing window was
**12:40:12 → 12:42:02 UTC (110 s)** and consumed **5 completions** on the shared gateway.

---

## 1. Run conditions — why "bare" is a construction, not a claim

The requirement was that the **300 s default deadline is enforced by construction**, not
configured. The driver builds the agent's environment by **deleting** every knob that could
weaken that, then records the resulting values so the absence is evidence rather than assertion.
From `run1.json`:

```json
"strippedEnvVerified": {
  "RLMX_ACP_LOOP": null,
  "RLMX_ACP_RUN_TIMEOUT_MS": null,
  "RLMX_ACP_MAX_ITERATIONS": null,
  "RLMX_REPL_TIMEOUT_MS": null,
  "RLMX_MCP_RUN_TIMEOUT_MS": null,
  "RLMX_BENCH_DIRECT_TIMEOUT_MS": null,
  "STATION_BASE_URL": null,
  "LEMONADE_BASE_URL": null
}
```

With `RLMX_ACP_RUN_TIMEOUT_MS` unset, `resolveEnvPositive(undefined, RLM_DEFAULTS.timeout)`
returns `300_000` — `Number(undefined)` is `NaN`, misses the finite-and-positive guard, and takes
the fallback. **300 s is what bounded every turn below.** `STATION_BASE_URL` being unset likewise
means the runs went to the real default gateway, not a redirect.

> **One env var IS set:** `RLMX_ACP_SESSIONS_DIR`, pointed at a scratch directory so the durable
> session store stays out of the live campaign's `~/.rlmx`. It is not a tuning knob and has no
> bearing on any deadline. Disclosed rather than hidden.

**Direct mode came from the project config, not from an override.** The scratch project lives
**outside** the repo, at
`$SCRATCHPAD/direct-proof-project/` (archived at
[`evidence/g3-live-proof/project/`](evidence/g3-live-proof/project/)):

```yaml
# .rlmx/rlmx.yaml
model:
  provider: station
  model: qwen3.6-moe-35b-a3b-FLM
loop: direct
```

```
# .rlmx/SYSTEM.md
You are a terse assistant answering one question at a time.

Answer directly, in at most two short sentences. Do not use tools, do not use a
REPL, and do not explain your reasoning — give the answer itself.
```

That `SYSTEM.md` mentions neither `FINAL(` nor `FINAL_VAR(` — it is exactly the scaffold-less
shape that put the traced run on the timeout path in full mode. In direct mode it is simply the
system message.

**Binary:** `node "$HOME/.cache/acp-station-viability-build/dist/src/cli.js" acp`, the W1 scratch
build of the patched tree. `dist/` in the repo was never rebuilt or touched.

**Handshake** (from `run1.json`): `protocolVersion: 1`, `agentCapabilities.loadSession: true`.

---

## 2. C2 — three one-line prompts, three sessions

Each sample ran on its own fresh `session/new`, so each is a genuine one-shot turn with no
inherited preamble. Samples were spaced **20 s** apart to be polite to the live benchmark campaign
sharing this gateway.

| # | session id | prompt | latency | stopReason | chunks | answer non-empty | voided |
|---|---|---|---|---|---|---|---|
| C2-1 | `3884baba-024f-4877-970e-bb3b0ccaa94e` | In one short sentence: what is the capital of France? | **5.600 s** | `end_turn` | 1 | yes | no |
| C2-2 | `715b1f2c-6758-4218-b92a-b417c7ee04cf` | In one short sentence: what does the Unix command `df -h` report? | **6.430 s** | `end_turn` | 1 | yes | no |
| C2-3 | `cfcb32d8-ba7d-41b6-af70-fd5a24c5cfaa` | In one short sentence: what does the acronym HTTP stand for? | **5.449 s** | `end_turn` | 1 | yes | no |

Latency is measured client-side, from writing the `session/prompt` frame to reading its response —
so it **includes** ACP framing, config load and session persistence, not just the completion. It is
the number a client actually experiences.

### Verbatim answers

> **C2-1:** `The capital of France is Paris.`
>
> **C2-2:** `It reports the amount of available and used disk space on mounted filesystems in human-readable format.`
>
> **C2-3:** `HTTP stands for HyperText Transfer Protocol.`

All three are correct as well as non-empty. Correctness was not a criterion; it is recorded because
an answer that is merely non-empty would be weak evidence.

### Distribution

| statistic | value | vs. bar |
|---|---|---|
| min | 5.449 s | |
| **median (p50)** | **5.600 s** | ≤ 120 s → **PASS**, 21× margin |
| max | 6.430 s | < 300 s → **PASS**, 47× margin |
| spread (max − min) | 0.981 s | |

> **On percentiles at n = 3.** The median of three observations is simply the middle one; it is a
> legitimate p50 but a loose one. A **p90 is not computable** from three samples and none is
> claimed. What n = 3 establishes is that the envelope is not marginal: the *slowest* sample is
> 2.1 % of the 300 s deadline, so the PASS does not depend on where the true percentile sits. It
> does **not** establish a stable latency level or a tail — a wedged loader or a contended gateway
> could still produce a slow turn, and nothing here bounds that.

### Consistency with the trace report

The trace report's direct probes (n = 2, diagnostic) measured **4.7 s** (41-token system prompt) and
**14.1 s** (2 028-token system prompt) for the raw completion. These five ACP turns, with a
~40-token system prompt, land at 5.4-6.6 s end-to-end — consistent with the 4.7 s figure plus ACP
overhead, and consistent with the report's model of decode as the constraint (~12-14 tok/s: a
one-sentence answer is a few seconds of decode). Together the two sets are n = 7 direct completions
on this arm with zero empties.

---

## 3. C2b — two turns on one session, turn 2 referencing turn 1

Session `cf3bbefb-9d4b-4df1-8764-f5ba2a805b82`, both turns on the **same live agent process** — no
`session/load` was needed, and none was used.

| turn | prompt | latency | stopReason | answer |
|---|---|---|---|---|
| 1 | `Remember this for later: my project codeword is TANGERINE-91. Reply with just: ok.` | **5.407 s** | `end_turn` | `ok.` |
| 2 | `What is my project codeword? Reply with only the codeword.` | **6.584 s** | `end_turn` | **`TANGERINE-91`** |

**Turn 2 demonstrably references turn 1.** The codeword `TANGERINE-91` appears in no system prompt,
in no turn-2 prompt, and is not a token a model would emit by chance — turn 2's entire answer is the
fact planted in turn 1. The mechanism is direct mode carrying the bounded `PREAMBLE_TURNS`
transcript into the single completion; direct mode adds no scaffold, but it does not drop the
preamble the caller already built.

The durable store corroborates it independently of the model
([`evidence/g3-live-proof/session-c2b-store-record.json`](evidence/g3-live-proof/session-c2b-store-record.json)):

```json
{
  "configSnapshot": { "provider": "station", "model": "qwen3.6-moe-35b-a3b-FLM" },
  "turns": [
    { "query": "Remember this for later: my project codeword is TANGERINE-91. Reply with just: ok.", "answer": "ok." },
    { "query": "What is my project codeword? Reply with only the codeword.",                        "answer": "TANGERINE-91" }
  ]
}
```

The `configSnapshot` also confirms on disk that the turns ran on the intended arm.

---

## 4. Gateway liveness record — pre and post EVERY sample

Liveness = `GET http://localhost:13305/api/v1/models`, checked immediately before and immediately
after each sample. A sample counts as **alive** only if the response is HTTP 200 *and* the catalog
contains `qwen3.6-moe-35b-a3b-FLM` — a 200 with the target model missing would be a loader wedge,
one of this gateway's two recorded failure modes, and would void the sample.

| sample | pre (UTC) | pre | post (UTC) | post | models | target model | verdict |
|---|---|---|---|---|---|---|---|
| C2-1 | 12:40:13.115 | 200 (23 ms) | 12:40:18.738 | 200 (2 ms) | 21 | present | valid |
| C2-2 | 12:40:38.749 | 200 (3 ms) | 12:40:45.182 | 200 (2 ms) | 21 | present | valid |
| C2-3 | 12:41:05.188 | 200 (2 ms) | 12:41:10.639 | 200 (2 ms) | 21 | present | valid |
| C2b-1 | 12:41:30.651 | 200 (2 ms) | 12:41:36.060 | 200 (2 ms) | 21 | present | valid |
| C2b-2 | 12:41:56.072 | 200 (3 ms) | 12:42:02.659 | 200 (2 ms) | 21 | present | valid |

**10 of 10 checks HTTP 200; the catalog held steady at 21 models throughout; the target model was
present every time. No sample was voided, therefore none was re-run.** The gateway showed neither
recorded failure mode (process death, loader wedge) during the window. Response times of 2-3 ms on
the models endpoint indicate it was not saturated by the concurrent campaign.

---

## 5. Incidental observations

1. **Exactly one answer chunk per turn**, always under the `answer:<sessionId>` messageId — the
   whole-answer contract holding on live traffic, with no partial streaming and no stray
   `error:<sessionId>:<phase>` bubble (there is no loop in direct mode to emit one).
2. **The agent wrote nothing to stderr** across all five turns (`"agentStderr": ""`). In particular
   the missing-FINAL-protocol diagnostic did not fire, which is correct: the project's SYSTEM.md has
   no FINAL protocol, but the warning is loop-mode-only and this ran direct.
3. **`~/.rlmx/settings.json` was not a factor.** The trace report §7 recorded that it pins an absent
   model (`qwen3.5-2b-FLM`) and overrides project yaml. It does not reach this path:
   `applySettingsModelOverrides` is applied in `src/cli.ts` at the query/batch/benchmark commands,
   while the `acp` command goes straight to `runAcp()` and the agent calls `loadConfig(cwd)`
   directly. The stored `configSnapshot` above confirms empirically that the project's model won.

## 6. What this does and does not establish

**Does:** direct mode, selected purely from a project's `.rlmx/rlmx.yaml`, answers real prompts on
`station/qwen3.6-moe-35b-a3b-FLM` through `rlmx acp` under the unmodified 300 s deadline, with
non-empty whole answers, multi-turn context carried, and an envelope two orders of magnitude inside
the bar — against a gateway proven live around every single sample.

**Does not:** establish a latency *tail* (n = 3, no p90); establish anything about direct mode on
longer prompts, larger system prompts, or other station models; or say anything about full mode,
which these runs never exercised. It also does not claim direct mode makes the model better — only
that the engine, not the model, was what the traced failure turned on.

---

## Method — footprint

- Driver: a ~200-line stdio ACP client written to the session scratchpad (archived under
  `evidence/g3-live-proof/`). `scripts/smoke-acp.mjs` was **read for its handshake shape but never
  modified or run**.
- Agent binary: the W1 scratch build only. No `npm run build`, no bare `tsc` into the repo, no write
  to `dist/**`.
- Forbidden files untouched: `src/station-provider.ts`, `scripts/smoke-acp.mjs`,
  `tests/khal-provider.test.ts`, `tests/station-provider.test.ts`, `dist/**`.
- No git state was changed and nothing was committed.
- Gateway load added: 5 chat completions over 110 s, spaced 20 s apart, all short answers.

---

# Group 4 — cross-repo proof

**Date:** 2026-08-03 · **Worker:** acp-g4-opus · **Task:** `t_msd4o3ubb8f36e0c`
**Consumer:** metal-river (`/home/namastex/prod/metal-river`, prod repo) driving rlmx through
`river-insights` · **Arm:** `station/qwen3.6-moe-35b-a3b-FLM` via `http://localhost:13305/api/v1`
**Agent binary:** the W1 scratch build only — `$HOME/.cache/acp-station-viability-build/dist/src/cli.js`

```
sha256  c5e4904b9ebdef164d3b0b8dd9d79f3287233e00aa133b4b91835711e174ccd4   scratch CLI (W1 build — the tree that produced every live number above)
sha256  c5039b9bcdf409c685aad5a52bf903c4853eafd29ecfa8debefcaa7945893ba2   landing build (this PR's `dist/src/cli.js`, `npm run build` on wish/acp-station-viability)
```

The two hashes are EXPECTED to differ and a match would be the surprising result: the scratch
CLI was compiled from the wish's sources on top of the campaign branch (`wish/rlmx-proof`,
ba9df95), whereas the landing build compiles the same delta on top of `origin/main` (4a4bc4a) —
different surrounding tree, therefore a different binary. What the landing hash pins is the
artifact this PR actually ships; what the scratch hash pins is the artifact the live proofs
above were measured against.

(Carried review item [LOW] "record a sha256 of the scratch CLI in the proof at LANDING" — closed here
and mirrored in `trace-report.md` FU-3.)

## VERDICT — split

| deliverable | result |
|---|---|
| D1 `loop: direct` reaches the runtime project | **PASS** |
| D2 live `kind:"broadcast"` JSONL row (C8) | **BLOCKED — 0 of 3 ticks conformed**, deterministically, for a reason the wish did not model |
| D3 consumer-path two-turn continuity | **PASS** |
| D6 metal-river core suite green after the edit | **PASS** — 88 passed / 0 failed |

**The engine defect this wish set out to fix is fixed, and the proof of that is visible in D2's own
failure data.** Before `loop: direct`, a station tick burned the full inner deadline and returned an
EMPTY answer. Now the same tick returns a coherent, non-empty answer in **17-20 s**. What blocks C8
is a *second, independent* gap on the consumer side, described in §3.

## 1. D1 — the one-line consumer edit and the re-seed

Template `/home/namastex/prod/metal-river/insights/.rlmx/rlmx.yaml`, key added at **top level** (per
`docs/project-config.md`: `loop` is a top-level key, NOT nested under `model:`):

```yaml
model:
  provider: station
  model: qwen3.6-moe-35b-a3b-FLM
# The station model answers a one-shot question well but cannot drive the RLM
# loop's FINAL() termination protocol — every full-loop tick came back empty.
# See rlmx docs/project-config.md and .genie/wishes/acp-station-viability/.
loop: direct
```

Re-seed proven by refresh (`river-insights --project`), not assumed:

```
template = /home/namastex/prod/metal-river/insights
runtime  = /home/namastex/.local/state/metal-river/insights-project (Reseeded)
model    = station/qwen3.6-moe-35b-a3b-FLM          <- pin survived the re-seed
```

The runtime copy at `~/.local/state/metal-river/insights-project/.rlmx/rlmx.yaml` carries
`loop: direct` verbatim **and** the model pin — the content-hash re-seed picked up the new key and
`set_runtime_model`'s line-preserving rewrite did not drop it. A second `--project` returns
`Unchanged` (idempotent). New `.template-hash` = `fnv1a64:8dfb4b828cd913b7`.

## 2. Liveness — every live run, pre and post

Liveness = `GET http://localhost:13305/api/v1/models`, HTTP 200 **and** `qwen3.6-moe-35b-a3b-FLM`
present in the catalog. The gateway was under the same live-campaign load as Group 3.

| run | pre (local -03:00) | post | catalog | target | verdict |
|---|---|---|---|---|---|
| TICK-1 | 09:55:30 · 21 models, present | *(see note)* | 21 | present | valid |
| TICK-2 | 09:58:18 · UP | 09:58:36 · UP | 21 | present | valid |
| TICK-3 | 10:00:43 · UP | 10:01:03 · UP | 21 | present | valid |
| CHAT-1 | 10:02:13 · UP | 10:02:27 · UP | 21 | present | valid |
| CHAT-2 | 10:02:52 · UP | 10:03:07 · UP | 21 | present | valid |

> **Disclosed gap, TICK-1 only.** TICK-1 has a pre-check (09:55:30) but **no dedicated post-check** —
> the harness that takes both was written after it. It is bracketed instead by the next observed
> liveness at 09:58:18 (UP, 21 models, target present) with no run in between. That is weaker than the
> protocol asks for, and TICK-1 is therefore reported as **bracketed, not strictly post-verified**. It
> changes nothing: TICK-2 and TICK-3 are fully protocol-compliant and returned the same result.

No sample was voided; the gateway showed neither recorded failure mode. Ticks were spaced ≥60 s
(09:56, 09:58, 10:00); chat turns 25 s apart, matching Group 3's spacing.

**Disclosed concurrency:** the `cargo test` run of §5 overlapped the CHAT-1/CHAT-2 window. It is CPU
work and the turns are gateway-bound, but the 14 s / 15 s chat latencies below should be read as
*upper bounds taken under incidental host load*, not clean measurements. No acceptance claim rests on
them.

## 3. D2 — the broadcast: 0 of 3, and why it is not model noncompliance

Command, all three attempts identical:

```
RLMX_CLI="$HOME/.cache/acp-station-viability-build/dist/src/cli.js" river-insights --tick
```

| attempt | started | elapsed | outcome |
|---|---|---|---|
| TICK-1 | 09:56:05 | **17 s** | rejected by the severity guard |
| TICK-2 | 09:58:18 | **18 s** | rejected by the severity guard |
| TICK-3 | 10:00:43 | **20 s** | rejected by the severity guard |

All three produced the **same answer**, near-verbatim — this is deterministic, not a sampling miss:

```
ERROR: broadcast: no [INFO]/[WARN]/[CRIT] observation — agent said: I cannot execute live
queries or access the Prometheus endpoint at 10.10.10.34:9090 as I am an isolated AI model
without direct network connectivity to your local infrastructure. Consequently, I cannot
retrieve real-time metrics for CPU, RAM, temperature, or container usage. I can, however,
provide a template for the Python script you would use to fetch these values if you were
running this locally, or analyze historical data if you paste the JSON response here.
```

**No `kind:"broadcast"` row was written.** metal-river's contract guard
(`insights.rs:835`, `broadcast_severity`) rejects a non-conforming answer and does **not** store it —
working exactly as designed. The guard was **not** weakened, and no row was manufactured.

### Root cause — a real finding, not a flaky run

**Direct mode has no REPL, and the tick prompt requires one.**

- `runDirectCompletion` (`src/acp/modes.ts`) sends exactly `[system (SYSTEM.md verbatim), user (query)]`
  to one chat completion. **No tools, no REPL, no scaffold** — that is the entire point of the mode,
  and `docs/project-config.md` says so: *"No REPL, no protocol scaffold, no iteration."*
- metal-river's `broadcast_prompt` (`insights.rs:1084`) instructs: *"BUDGET: at most 3 queries, in ONE
  REPL cell, then answer… urllib GET {prom}/api/v1/query?query=…"* and demands *"at least one concrete
  number."*
- MERI's `SYSTEM.md` opens with *"You have a Python REPL."*

So the tick asks a tool-less completion to fetch live Prometheus values. **The model's refusal is the
correct answer to an impossible instruction.** It declined rather than inventing a plausible number —
which is the desirable behavior: a hallucinated `[INFO] CPU at 12%` would have *passed* the severity
guard and written a false observation into the durable stream. The guard cannot distinguish a measured
number from an invented one; only the refusal saved the JSONL from garbage.

**This is a consumer-side design gap, and it belongs to metal-river, not to rlmx.** The wish's Group-4
premise — that `loop: direct` alone would make MERI broadcast for real — was incomplete: it fixed the
engine (empty answers → real answers, 300 s+ → ~18 s) but the broadcast *contract* additionally
requires grounded metrics, which direct mode structurally cannot fetch.

**Scope discipline:** the fix is metal-river source work (pre-fetch the 3-5 catalog metrics host-side
and interpolate them into the tick prompt, so the model reduces given numbers instead of fetching
them; or run ticks in full mode while chat stays direct). Group 4's sanctioned prod footprint is
`insights/.rlmx/rlmx.yaml` plus the meri ledger note — editing `broadcast_prompt`, `SYSTEM.md`, or the
guard was **out of scope and was not done**.

## 4. D3 — consumer-path continuity: PASS

Two `river-insights --chat` turns, **same day, same session
`75b16ca5-834f-4618-8cad-8c0a1fe8ee33`**, model `station/qwen3.6-moe-35b-a3b-FLM`. Verbatim from
`~/.local/state/metal-river/insights/2026-08-03.jsonl`:

```json
{"role":"user","kind":"chat","text":"Do not query anything and do not use any tool. Just remember this for the rest of today: the maintenance codeword for this workstation is FERROVIA-77. Reply with exactly: ok.","session":"75b16ca5-834f-4618-8cad-8c0a1fe8ee33","model":"station/qwen3.6-moe-35b-a3b-FLM"}
{"role":"agent","kind":"chat","text":"ok.","session":"75b16ca5-834f-4618-8cad-8c0a1fe8ee33","model":"station/qwen3.6-moe-35b-a3b-FLM"}
{"role":"user","kind":"chat","text":"What is the maintenance codeword for this workstation? Reply with only the codeword and nothing else.","session":"75b16ca5-834f-4618-8cad-8c0a1fe8ee33","model":"station/qwen3.6-moe-35b-a3b-FLM"}
{"role":"agent","kind":"chat","text":"FERROVIA-77","session":"75b16ca5-834f-4618-8cad-8c0a1fe8ee33","model":"station/qwen3.6-moe-35b-a3b-FLM"}
```

Latencies **14.0 s** (turn 1) and **15.0 s** (turn 2), both wall-clock through the whole consumer
stack, both under incidental load (§2).

**This is strictly stronger than Group 3's C2b.** C2b carried context inside **one live agent
process**. Here each `river-insights --chat` is a **separate OS process**: turn 2's agent was spawned
fresh, with no in-memory history, and resumed by `session/load` on the id metal-river had persisted in
`session.json`. Corroborated independently of the model by rlmx's durable store,
`~/.rlmx/acp-sessions/75b16ca5-834f-4618-8cad-8c0a1fe8ee33.json`:

```json
{"configSnapshot": {"provider": "station", "model": "qwen3.6-moe-35b-a3b-FLM"},
 "turns": [ ...,
   {"query": "Do not query anything ... the maintenance codeword ... is FERROVIA-77 ...", "answer": "ok."},
   {"query": "What is the maintenance codeword for this workstation? ...",                "answer": "FERROVIA-77"}]}
```

`FERROVIA-77` appears in no system prompt and in no turn-2 prompt. Note also that metal-river's own
seed block could **not** have carried it: `today_seed_lines` keeps only `[INFO]`/`[WARN]`/`[CRIT]`
lines, and turn 1's answer was `ok.` — untagged, therefore never seeded. The fact travelled purely via
rlmx's durable session + bounded `PREAMBLE_TURNS` replay, across a process boundary.

## 5. D6 — metal-river core suite after the template edit

```
$ cargo test --manifest-path metal-river/ui/src-tauri/core/Cargo.toml
test result: ok. 88 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 3.81s
```

## 6. The 600 s resolved deadline (recorded as the wish asked)

metal-river sets `RLMX_ACP_RUN_TIMEOUT_MS` only when the operator has not
(`insights.rs:433`), to `inner_run_timeout_ms()` = `PROMPT_TIMEOUT (660 s) − INNER_TIMEOUT_SLACK (60 s)`
= **600 000 ms**. So under `river-insights` the direct-mode deadline resolves to **600 s**, not the
bare 300 s default Group 3 proved against — deliberately, so rlmx's own wall clock fires *first* and
the failure comes back as a structured `direct_timeout` rather than as metal-river's timeout.

**It was never approached.** Every run above settled in 14-20 s, i.e. **2.3-3.3 %** of the 600 s
budget. The deadline is recorded here for completeness, not because anything tested it.

## 7. What this section does and does not establish

**Does:** `loop: direct` set in a committed project file propagates through metal-river's content-hash
re-seed into the runtime project with the model pin intact; the station arm answers the consumer's
real prompts in 14-20 s instead of returning empty at the cap; consumer-path multi-turn continuity
holds **across process restarts** through `session/load` + preamble; metal-river's core suite is
unaffected; and metal-river's broadcast guard correctly refuses to store a non-conforming answer.

**Does not:** establish C8. No `kind:"broadcast"` row exists. It also does not establish a latency tail
(n = 3 ticks, n = 2 chats, no percentiles), and it says nothing about full mode, which Group 4 never ran.

## Method — footprint

- **rlmx repo:** no tracked file touched. Writes confined to the untracked
  `.genie/wishes/acp-station-viability/` (this file and `trace-report.md`). No build, no `dist/**`
  write, no git state change, nothing committed.
- **prod repo:** exactly two files — `metal-river/insights/.rlmx/rlmx.yaml` (the one-line key plus its
  rationale comment) and `.genie/wishes/meri-mascot/WISH.md` (the ledger note). Nothing committed;
  landing is the orchestrator's.
- Generated data was not hand-edited: every JSONL row quoted above was written by `river-insights`.
- Gateway load added: 3 tick completions + 2 chat completions over ~7 minutes, all short.

---

# Group 4 — fix loop: the transferred criterion-1 broadcast clause, CLOSED (2026-08-03)

Section 7 above says "Does not: establish C8. No `kind:"broadcast"` row exists." That is now
superseded — by fixing the cause Group 4 diagnosed, not by weakening the guard.

## 8. The fix

Root cause, exactly as Group 4 named it: direct mode is tool-less by construction, while the tick
prompt *demanded* tooling. `broadcast_prompt` required "at most 3 queries, in ONE REPL cell" plus
"at least one concrete number", and `SYSTEM.md` opened with "You have a Python REPL." The model's
refusal was correct behaviour, and the `[INFO]/[WARN]/[CRIT]` guard correctly rejected it.

Applied (prod repo, uncommitted):

- `metal-river/ui/src-tauri/core/src/insights.rs` — new `TICK_FACTS` (6 instant PromQL values:
  CPU busy %, RAM used GB, CPU package °C, iGPU busy %, busiest container CPU %, NVMe await ms) and
  `tick_facts()`, which reads them host-side via the existing `PromClient::scalar` (5 s timeout;
  a metric that does not answer is DROPPED, never reported as zero). `broadcast_prompt` now
  interpolates those numbers and says "Answer FROM THE DATA ABOVE"; the REPL became optional
  enrichment ("if a Python REPL is available you may verify…"). When zero metrics can be read, the
  prompt asks for exactly one `[WARN]` line about the collector being down — so even a dead
  Prometheus yields a conforming, honest row instead of a refusal.
- `analysis_prompt` — same conditional treatment ("When a Python REPL is available… / When no REPL
  is available: answer from the observations given below, and say plainly which claims you could not
  measure rather than inventing values").
- `metal-river/insights/.rlmx/SYSTEM.md` — the REPL sentence made conditional; the OUTPUT DISCIPLINE
  block scoped to "whenever a REPL is in play"; persona, thresholds, hardware context and the
  aggregate-don't-print rule all intact.

The guard (`broadcast_severity`) was **not touched**. No rlmx file was touched.

## 9. Hermetic tests (river-core)

Three added, all phrasing-contract-shaped rather than prose-exact:
`prompts_never_demand_a_repl_unconditionally` (every line mentioning a REPL, in all three prompt
shapes, must carry conditional phrasing), `broadcast_prompt_carries_the_pushed_metric_values`
(the numbers the model is told to cite are IN the prompt; the empty-facts prompt still routes to a
tagged `[WARN]`), and `tick_facts_are_empty_when_prometheus_is_unreachable`.

```
$ cargo test --manifest-path metal-river/ui/src-tauri/core/Cargo.toml
test result: ok. 91 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 3.81s
```

## 10. LIVE PROOF — 2/2 conforming ticks, the first real broadcast rows

Conditions: `RLMX_CLI=$HOME/.cache/acp-station-viability-build/dist/src/cli.js`;
`river-insights --project` → **Reseeded**, model pin `station/qwen3.6-moe-35b-a3b-FLM` survived the
template edit (the content-hash re-seed mechanism, proven again). `loop: direct` present in both the
committed template and the reseeded runtime project. Gateway `GET localhost:13305/api/v1/models`
verified before and after: target `qwen3.6-moe-35b-a3b-FLM` present both times. Prometheus at
10.10.10.34:9090 answering instant queries. Baseline `grep -c '"kind":"broadcast"'` on
`~/.local/state/metal-river/insights/2026-08-03.jsonl` = **0**.

**Attempt 1 — 18 s, CONFORMING.** Session `75b16ca5-834f-4618-8cad-8c0a1fe8ee33` (the same durable
session as the criterion-2 chat proof), model `station/qwen3.6-moe-35b-a3b-FLM`:

```json
{"ts":1785762657.0395656,"role":"agent","kind":"broadcast","text":"[INFO] Station is idle at 4.6% CPU and 62.0°C, with the langwatch container holding 17.7% of the load while NVMe await stays calm at 1.0 ms.","session":"75b16ca5-834f-4618-8cad-8c0a1fe8ee33","model":"station/qwen3.6-moe-35b-a3b-FLM"}
```

Passes the guard on the first try — but note "the **langwatch** container". 4.6 / 62.0 / 17.7 / 1.0
are all real pushed values; the *name* is not. `PromClient::scalar` reduces `max(...)` to a number,
so no container name is in the payload — the model borrowed the one from `SYSTEM.md`'s persona
example ("mostly the langwatch container"). A fabrication introduced by the fix, caught by reading
the row rather than by the guard, which cannot tell an invented name from a measured one.

**Correction applied before accepting the proof:** the fact is now labelled
`busiest container CPU (name unknown)`, and `SYSTEM.md`'s example line no longer names a container,
with an explicit rule — "Never name a container, process or device unless that name appears in the
data you were given — a plausible name is still a fabrication."

**Attempt 2 — 20 s, CONFORMING, after re-seed.** Same session:

```json
{"ts":1785762703.155256,"role":"agent","kind":"broadcast","text":"[INFO] Load is up slightly to 5.3% CPU and 48.4 GB RAM, with the top container at 19.7% while temps drop to 41.4°C and NVMe await holds at 1.1 ms.","session":"75b16ca5-834f-4618-8cad-8c0a1fe8ee33","model":"station/qwen3.6-moe-35b-a3b-FLM"}
```

No fabricated name ("the top container"). Every number traces to the pushed payload. It also carries
the day's thread forward unprompted — "up slightly", "drop to" are comparisons against attempt 1,
which is the continuity property criterion 1 wanted.

**Result: 2/2 attempts conforming, 18 s and 20 s** (vs. 0/3 before the fix, same arm, same box, same
gateway). `grep -c '"kind":"broadcast"'` = **2**, up from 0.

## 11. What this section does and does not establish

**Does:** C8 — a real `kind:"broadcast"` row, written by `river-insights` through the supervisor lane
into the durable JSONL, passing an unmodified severity guard, on the tool-less station arm. The
transferred criterion-1 live-broadcast clause is satisfied.

**Does not:** establish a latency tail (n = 2), full mode, or unattended cadence over hours — the
runs were hand-triggered with cadence OFF (`--tick` forces `TICKS_OFF`). It also does not prove the
model will never fabricate a label; it proves one such fabrication was found and closed. Numbers are
now pushed, so the remaining hallucination surface is *narration around* given values, not the values
themselves.

## Method — footprint (fix loop)

- **rlmx repo:** no tracked file touched; this untracked wish file only. No build, no `dist/**`
  write, no git state change.
- **prod repo:** `metal-river/ui/src-tauri/core/src/insights.rs` (+ its tests),
  `metal-river/insights/.rlmx/SYSTEM.md`, and the two ledger docs. The pre-existing sanctioned
  `rlmx.yaml` `loop: direct` edit was left as found. **Nothing committed.**
- Generated data was not hand-edited: both JSONL rows quoted above were written by `river-insights`.
- Gateway load added: 2 tick completions over ~2 minutes.
