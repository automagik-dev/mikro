# Trace report — Group 1: why `rlmx acp` on station/qwen3.6-moe-35b-a3b-FLM returns EMPTY

**Date:** 2026-08-03 · **Worker:** acp-g1-opus · **Task:** t_msd4o3m0847b8cdb
**Repo:** /home/namastex/prod/rlmx (branch `wish/rlmx-proof`, campaign session live — untouched)
**Evidence:** `.genie/wishes/acp-station-viability/evidence/`
**Revision:** rev2, after independent review returned FIX-FIRST (5 corrections, all applied from the
already-captured evidence; no new probes were run).

---

## VERDICT

**THEORY: AMENDED — the station provider path is healthy and the model is capable and (under the canonical
scaffold) protocol-COMPLIANT; the empty answer is a configuration + exit-path defect in rlmLoop, compounded by
a REPL argument-handling bug that silently discards the model's termination calls.**

The direct-mode design is **NOT void**. It is supported by this trace — see §5 for the scope limit.

The working theory said: *"protocol scaffold × NPU prefill speed × FLM behavior → the model never produces
protocol-compliant output."*

| Claim in the theory | Verdict | Evidence |
|---|---|---|
| The model never produces protocol-compliant output | **AMENDED** | True in P2 (no protocol taught). **False in P3**: the model emitted `FINAL_VAR(...)` **10 times**; rlmx discarded every one (§3) |
| The *large* protocol scaffold caused it | **FALSIFIED — inverted** | The failing run had **no protocol scaffold at all**; the project SYSTEM.md replaced it |
| NPU prefill speed is a driver | **AMENDED** | Prefill is fine (94-154 tps at scale). **Decode** (~12-14 tps) is the bottleneck |
| The station provider corrupts/fails long prompts | **FALSIFIED** | 2028-token prompt → correct answer in 14.1 s (P4) |
| Single completions also fail through rlmx's llm layer | **FALSIFIED** | rlmx's own iteration 0 returned the correct answer in 9.7 s (P2) |

---

## 1. The headline finding

**In the failing run, the model produced the correct answer on iteration 0, in 9.7 seconds.**

`evidence/P2-iter0-response.sse` reassembles to exactly:

```
[INFO] arm check ok.
```

rlmx did not recognize it as an answer, because it was not wrapped in `FINAL(...)` — and the model was never
told to wrap it. The loop continued for 4 more iterations and timed out, discarding that answer.

## 2. Causal chain (P2, the reproduction of the reported anomaly)

1. **The project's `SYSTEM.md` silently replaces rlmx's entire protocol scaffold.**
   `src/rlm.ts:102 buildSystemPrompt()` is `config.system ?? ""` plus optional TOOLS/CRITERIA/storage
   sections. There is **no built-in protocol text**. The RLM protocol (`FINAL()`/`FINAL_VAR()`, REPL contract)
   lives only in the *scaffold template* `rlmx init` writes.

   | file | chars | bytes | `FINAL(` | `REPL` |
   |---|---|---|---|---|
   | canonical scaffold `rlmx/.rlmx/SYSTEM.md` | 8 548 | 9 120 | **2** | 27 |
   | run config `insights-project/.rlmx/SYSTEM.md` (MERI) | 2 103 | 2 113 | **0** | 2 |

   Verified on the wire: the system message rlmx actually sent is 2 102 chars and contains `FINAL(` **zero
   times** (`evidence/P2-iter0-request.json`).

2. **With no termination protocol, the loop cannot terminate early.** The model has no way to signal "done".

3. **rlmx's injected user message pushes the model into the REPL** — against the prompt's own instruction.
   The 87-char query is wrapped to 397 chars, opening with: *"You have not interacted with the REPL
   environment or seen your prompt / context yet. Your next action should be to lo[ok]..."* — despite the
   query saying "Do not use the REPL."

4. **Iterations 1-3 emit large Python blocks; context balloons and decode dominates wall-clock.**

   | iter | request chars | response chars (rlmx) | upstream wall |
   |---|---|---|---|
   | 0 | 2 499 | 20 (`[INFO] arm check ok.`) | 9.7 s |
   | 1 | 2 682 | 4 974 (```python block) | 101.2 s |
   | 2 | 7 819 | 3 186 (```python block) | 75.1 s |
   | 3 | 11 168 | 3 745 (```python block) | 85.3 s |
   | 4 | 15 076 | **0 — see measurement caveat below** | 87.4 s upstream (completed) |

   At ~12-14 tps decode, a ~1 400-token response costs 100 s+. Four iterations exhaust the 300 s budget.

   > **Measurement caveat (iteration 4).** rlmx logged `LLM responded (0 chars, 0+0 tokens)`, but the upstream
   > call **completed successfully**: `evidence/P2-iter4-response.sse` ends with `finish_reason: stop`,
   > `prompt_tokens: 1099`, `completion_tokens: 1057`, 1 058 SSE chunks. rlmx saw nothing because **my proxy
   > buffers** (§Method) and had not flushed when rlmx's 300 s abort fired. This row is therefore an artifact
   > of the instrument, not evidence about production streaming behavior. It does not affect any other
   > finding: rlmx does not act on partial deltas, and iteration 4 was in any case incomplete and
   > non-terminating at the 300 s mark either way.

5. **The 300 s timer fires → and this is where the answer becomes EMPTY.**
   `src/rlm.ts:365` aborts the shared `AbortController`. The loop breaks at `:533`, then `:877` calls
   `forceFinalAnswer(..., abortController.signal, ...)` — passing the **already-aborted** signal.
   `forceFinalAnswer` (`:918-962`) does not catch; it awaits `llmComplete`.

   **Proof that the forced call returned rather than threw** (`evidence/P2.stdout`):

   - `llmCalls: 6`, but only **5** `chat/completions` requests appear in the P2 window (proxy ids 4-8).
     The 6th call never reached the wire — consistent with a pre-aborted signal short-circuiting the fetch.
   - `inputTokens: 3104` = `678 + 50 + 1441 + 935` **exactly** (iterations 0-3; iteration 4 and the forced
     call each contributed 0).
   - Usage is carried in `llmComplete`'s **return value** (`src/llm.ts:388-400`, `llmCalls: 1`) and merged by
     the caller. A throw contributes nothing. `llmCalls` reaching 6 therefore proves the 6th `llmComplete`
     **returned** — with empty text and zero usage.

   Had it thrown `AbortError`, the catch at `:885` would have produced `"Error: RLM query timed out"`.
   It did not. Hence `answer: ""` — the run reports success while returning nothing.

## 3. The control run — and the second, independent defect

Same query, same model, same gateway — only `SYSTEM.md` swapped for the canonical scaffold:

| | P2 (MERI SYSTEM.md) | P3 (canonical scaffold) |
|---|---|---|
| answer | `""` | `"[INFO] arm check ok."` |
| iterations | 5 | 30 (max) |
| wall | 300 s (timeout) | 211 s |
| exit path | **timeout** → `forceFinalAnswer` pre-aborted → `""` | **max iterations** → `forceFinalAnswer` live → real answer |
| response sizes | 3 000-5 000 chars | 20-200 chars |
| termination calls emitted | 0 | **10 × `FINAL_VAR(...)`, all silently discarded** |

**Correction to rev1: in P3 the model WAS protocol-compliant.** `evidence/proxy-P2.jsonl` request id 40 (the
63-message P3 transcript) shows `FINAL_VAR(...)` in assistant messages **6, 12, 18, 24, 30, 36, 42, 48, 54,
60** — the model obeying the canonical scaffold's own two-step compute-then-finalize instruction. Not one
terminated the loop. Why:

The model wrote `FINAL_VAR(output)` **unquoted**. In `exec`, `output` resolves to its *value*, so
`python/repl_server.py:95 _final_var` receives the string `"[INFO] arm check ok."`:

- `if not isinstance(variable_name, str)` (`:96`) — the "direct value passed" branch that would have set
  `_last_final` — **does not fire**, because the value *is* a `str`.
- The value is then treated as a **name**: `if variable_name in self._locals` (`:104`) misses, since the key
  is `output`, not `[INFO] arm check ok.`.
- Control falls to the error-return at `:112-116`. That error string is the value of a **bare expression**
  under `exec` (`:174`), which discards expression values — so the diagnostic surfaces **nowhere**.

Confirmed on the wire: message[7] (the REPL echo following the first `FINAL_VAR`) shows an **empty** REPL
output section — only `Variables: output`. `execResult.final` stays undefined and the loop continues.

`FINAL_VAR("output")` — quoted — would have taken the name-lookup branch and terminated the run at
iteration 5, in roughly 30 s.

So the honest reading of the control is stronger and worse than rev1 claimed: **rlmx received ten
well-formed termination attempts and dropped all ten**, then recovered the right answer only by accident of
hitting the max-iterations exit instead of the timeout exit. The difference between P2's `""` and P3's
correct answer is *purely which exit path fires first* — short outputs let 30 iterations finish inside 300 s.

**The latent bug worth naming: `forceFinalAnswer` is unusable on the exact exit path that most needs it.**
A timeout can never produce an answer, by construction.

## 4. Matching the recorded anomaly

Turn records store *completion* timestamps, so each interval is **run duration + inter-turn idle**, not a
direct measurement of run duration. The first value in each row is `createdAt` → turn 0.

| session | intervals (s) | budget |
|---|---|---|
| `75b16ca5` | 300.027 | 300 s default |
| `d5e65f47` (5 turns) | 300.026 / **431.561** / 300.605 / 300.650 / 300.474 | 300 s default |
| `9bdde5b4` (3 turns) | 600.019 / 600.465 / 600.459 | doubled (`RLMX_ACP_RUN_TIMEOUT_MS`) |

The repeated 300.0xx and 600.0xx values are strong evidence of back-to-back budget-capped ticks with
negligible idle. The 431.561 s interval is the one exception and is consistent with ~131 s of caller idle
between ticks, not a longer run. Doubling the budget did not help — it bought more long-output iterations
before the same timeout path. `src/acp/agent.ts:370` (`result.answer ?? ""`) faithfully relays the empty; the
ACP layer is not at fault.

## 5. Direct-mode viability (the question that gates the wish)

The station path was probed directly, bypassing rlmLoop entirely. Both probes returned the **exact** expected
answer with `finish_reason: "stop"`:

| probe | system prompt | prompt tokens | ttft | prefill tps | decode tps | total |
|---|---|---|---|---|---|---|
| P1 | "You are a helpful assistant." | 41 | 3.78 s | 10.8 (overhead-bound) | 11.9 | **4.7 s** |
| P4 | canonical scaffold (8 548 chars) | 2 028 | 13.20 s | **153.7** | 11.6 | **14.1 s** |

Interpretation:
- **Prefill is not the problem** — 94-154 tps at scale. A 2 000-token system prompt costs ~13 s.
- **Decode is the constraint** — ~12-14 tps. Budget ≈ 1 s per 12-14 output tokens; a 45-word answer ≈ 5-6 s.

> **Scope limit.** These are **n = 2** direct completions, run for diagnosis, not acceptance. They do **not**
> pre-satisfy C2 (n ≥ 3); establishing that remains **Group 3's** job. What this trace supports is the
> narrower claim that nothing in the provider, the model, or long prompts blocks the direct-mode design.

The brief's supporting datum — 73 successful one-shot ≤45-word completions that morning (p50 15 s, p90 40 s)
via the retired metal-river advisor — is **carried forward from the task brief and not independently verified
here**. `prod/.genie/wishes/meri-mascot/latency-report.md` does *not* contain that record (its "73" is a
git-describe suffix, `v0.260725.1-73-gba9df95`), so the number should be sourced before it is relied on.

## 6. rlmLoop defects surfaced

| # | defect | site | in scope for this wish? |
|---|---|---|---|
| 1 | `forceFinalAnswer` receives an already-aborted signal on the timeout path, so a timeout can never yield an answer; the empty is reported as success | `src/rlm.ts:877` | Honesty fix belongs to Group 2 (see note) |
| 2 | A custom `SYSTEM.md` silently drops the RLM protocol with no warning | `src/rlm.ts:102` | Config/doc issue; affects any hand-written SYSTEM.md |
| 3 | `FINAL_VAR(x)` **unquoted** is swallowed: str-value overload misses the direct-value branch, name lookup fails, and the error is discarded by exec-mode — 10 compliant termination attempts lost | `python/repl_server.py:95,104,112-116,174` | **OUT of scope — protocol design; follow-up ledger row** |

> **Clarifying note requested by review.** A structured error in Group 2 does **not** recover the
> iteration-0 answer. It converts a dishonest empty-but-successful result into an honest error. *Rescuing*
> the answer — whether by fixing `FINAL_VAR` argument handling, giving the timeout path a live signal, or
> reworking the termination protocol — is protocol work and is **out of this wish's scope**.

## 7. Incidental findings

1. `~/.rlmx/settings.json` (mode 600, mtime 2026-07-20) pins `model.model: qwen3.5-2b-FLM`, a model **absent
   from the gateway catalog**, and it overrides the project `rlmx.yaml`. A run without an explicit `--model`
   dies with `Unknown model "qwen3.5-2b-FLM" for provider "station"`. All reported probes pass `--model`
   explicitly.
2. **This does not affect the recorded sessions.** Every session file carries
   `configSnapshot: {"provider":"station","model":"qwen3.6-moe-35b-a3b-FLM"}` — verified for `75b16ca5`,
   `d5e65f47` and `9bdde5b4`. (There is no *top-level* `model` key — that is what misled rev1 — but the model
   **is** recorded.) All three anomaly sessions ran on qwen3.6; the stale pin was not a factor.

---

## Probe log with liveness records

Liveness = `GET http://localhost:13305/api/v1/models`. **No probe was voided** — all pre/post checks returned
HTTP 200. The gateway was responsive throughout (p50 <1 ms on the models endpoint) and showed no sign of the
recorded process-death or loader-wedge failure modes.

| probe | pre-liveness | window | post-liveness | result |
|---|---|---|---|---|
| P1 direct, small system prompt | 08:21:47 → 200 | 4.7 s | 08:21:52 → 200 | correct answer |
| P2 rlmLoop via proxy, MERI SYSTEM.md | 08:23:49 → 200 | 08:23:49-08:28:49 | 08:28:49 → 200 | `answer:""`, 5 iters, 300 s |
| P3 rlmLoop via proxy, canonical scaffold | 08:30:51 → 200 | 08:30:51-08:34:22 | 08:34:22 → 200 | correct answer, 30 iters |
| P4 direct, 2 028-token system prompt | 08:35:07 → 200 | 14.1 s | 08:35:21 → 200 | correct answer |

A first attempt at P2 (08:23:02) aborted in <1 s on the `qwen3.5-2b-FLM` config error before reaching the
gateway; it consumed no inference and is reported in §7 rather than counted as a probe.

## Method — instrumentation without touching tracked sources

`src/station-provider.ts:38` honors `STATION_BASE_URL`. A logging reverse proxy (`evidence/proxy.mjs`, run
from the session scratchpad) was interposed on :13399 → :13305, capturing every request/response verbatim at
the provider seam. rlmx was driven via `node dist/src/cli.js` (the campaign's existing build — never rebuilt)
with `--verbose` for iteration timing.

**Instrument limitations (disclosed):**

- **The proxy fully buffers upstream responses** (`await upstream.text()` before `res.end`). rlmx therefore
  **never saw streaming deltas through it**, and received each response only on completion. This is what
  produced the spurious iteration-4 reading retracted in §2.4. Two rev1 claims are **withdrawn**: that
  iteration 4's stream was "cut by abort", and the extrapolation from it to the separately-reported
  `EmptyResponses` abort at `rlm.ts:841`. **This trace says nothing about that abort's cause.** The
  pre-aborted swallow is instead proved by the `llmCalls`/`inputTokens` arithmetic in §2.5, which does not
  depend on streaming behavior at all.
- `PROXY_LOG` is read once at proxy start, so **P2 and P3 traffic share one log**, `evidence/proxy-P2.jsonl`
  (P2 = ids 4-8; P3 = ids 9-40; id 41 is a trailing `/models` liveness call). The filename is kept for
  continuity with the evidence bundle. "Last request in the P2 window" in §2.5 means ids 4-8; the log
  continues past it.

**Footprint:** `git status --porcelain` after all probes is byte-identical to the campaign's dirty set
(`src/station-provider.ts`, `scripts/smoke-acp.mjs`, `tests/khal-provider.test.ts`,
`tests/station-provider.test.ts`, `dist/**`) plus the two untracked `.genie/` wish dirs. No tracked file was
modified, no build was run, no git state was changed. The proxy was stopped and port 13399 is closed.

## Recommendation to the wish (scope input, not a decision)

1. **Direct mode is supported by this trace — proceed.** Provider, model and long prompts are all healthy.
   Acceptance evidence (C2, n ≥ 3) is still owed by Group 3.
2. Group 2 should make the timeout path **honest** (defect #1) — not attempt to rescue the answer.
3. Defects #2 and #3 are real but out of scope; carry them as follow-up ledger rows.
4. If any REPL-mode path is retained, MERI's `SYSTEM.md` must re-include the `FINAL()`/`FINAL_VAR()` protocol
   — and defect #3 must be fixed, or compliant models will keep being silently ignored.

**THEORY: AMENDED — protocol non-compliance is NOT the root cause it appeared to be: under the canonical
scaffold the model complied 10 times and rlmx discarded every attempt (`FINAL_VAR` unquoted-arg swallow). The
empty answer is the timeout exit path calling `forceFinalAnswer` with a pre-aborted signal; the bottleneck is
decode, not prefill; and MERI's scaffold-less SYSTEM.md (not scaffold size) is what pushed the run onto that
path. The station provider path is healthy; direct mode is NOT void.**

---

# Follow-up ledger

Appended 2026-08-03 by Group 4 (`acp-g4-opus`, task `t_msd4o3ubb8f36e0c`). These rows are **carried
work, not this wish's deliverables** — recorded here so they survive the wish closing. Neither row
was fixed by this wish; both were routed here explicitly (WISH.md review-routing lines 223 and 230).

## FU-1 — `FINAL_VAR(x)` unquoted-arg overload swallows compliant terminations

**Site:** `python/repl_server.py` — `_final_var` at `:97` (the `if not isinstance(variable_name, str)`
direct-value branch), the name-lookup miss, and the error-return at `:111-115`; the discard happens at
the `exec` bare-expression site (`:174`). **Status:** OPEN, out of scope for acp-station-viability
(protocol design, not the ACP seam). **Origin:** trace-report §3 and §6 row 3.

**Behavior.** Under `exec`, `FINAL_VAR(output)` — unquoted — passes the variable's *value*, not its
name. Because that value is itself a `str`, the "a direct value was passed" branch that would set
`_last_final` does not fire; the value is then looked up as a *name*, which misses; control reaches the
error-return, and that error string is the value of a bare expression under `exec`, which discards
expression values. The diagnostic therefore surfaces **nowhere** — not to the model, not to the loop,
not to stderr. `execResult.final` stays undefined and the loop keeps iterating.

**Measured impact (P3, trace-report §3).** The model was protocol-**compliant**: `evidence/proxy-P2.jsonl`
request id 40 shows `FINAL_VAR(...)` in assistant messages 6, 12, 18, 24, 30, 36, 42, 48, 54, 60.
**rlmx received ten well-formed termination attempts and dropped all ten**, then recovered the right
answer only by accident of hitting the max-iterations exit rather than the timeout exit.
`FINAL_VAR("output")` — quoted — would have terminated at iteration 5, in roughly 30 s.

**Why this is worth a durable row.** A silent swallow of the termination protocol makes every
compliant model look non-compliant. It is also the reason the original theory of this wish
("protocol non-compliance") was wrong, and it will keep manufacturing that same wrong diagnosis for
the next investigator until it is fixed.

**Folded-in nit (routed here from the Group 2 review).** The decode-rate figure is quoted at two
different ranges across the wish documents — `~11-14 tps` (WISH.md:222) and `~12-14 tps`
(trace-report.md:176, §5 interpretation). The **measured** values are the only defensible ones and
they are n = 2, taken for diagnosis rather than acceptance: **P1 = 11.9 tps decode** (41-token prompt,
4.7 s total) and **P4 = 11.6 tps decode** (2 028-token prompt, 14.1 s total). Any future document
should cite `11.6-11.9 tps (n = 2, diagnostic)` or re-measure; the wider ranges were rounded envelopes,
not data. Prefill is not in dispute and is not the constraint (94-154 tps at scale).

## FU-2 — `pi`/`ai` empty-on-abort is a *dependency property* this repo now depends on

**Status:** OPEN as a watch item — nothing to fix in rlmx today, but the behavior is load-bearing and
undocumented upstream. **Origin:** routed as a NIT to this ledger (WISH.md:230), alongside FU-1.

**The property.** When the underlying `pi`/`ai` completion call is aborted, it does not throw an
abort-shaped error — it **resolves with empty text**. An abort and a model that legitimately produced
nothing are therefore indistinguishable at the call site, by return value alone.

**It has already produced one shipped defect.** This is exactly the mechanism behind
`forceFinalAnswer` on the timeout path (`src/rlm.ts:877`): the signal is already aborted when
`forceFinalAnswer` is called, the completion comes back empty rather than raising, and the loop reports
`stopReason: end_turn` with `answer: ""` — an empty result presented as a **success**. Every station
tick failing was that one behavior, misread for weeks as the model's fault.

**It is load-bearing in the new code.** `src/acp/modes.ts` orders its two failure classifications
deliberately: `deadlineFired` is checked **before** `direct_empty` (`runDirectCompletion`, both the
catch path and the post-await path — see `directTimeoutError` and the `direct_empty` construction).
That ordering is not stylistic. Because an aborted completion resolves empty, checking `direct_empty`
first would classify **every** direct-mode timeout as "the model returned nothing", re-creating the
exact dishonesty this wish was opened to remove. The `deadlineFired` flag is the only signal that
distinguishes the two, and it must be consulted first.

**Already defended — verified, not assumed.** The ordering carries an `ORDER MATTERS` comment in
`runDirectCompletion` naming this exact dependency, *and* it is pinned by a hermetic test:
`tests/acp-direct-mode.test.ts:504` — *"a provider that RETURNS empty on a fired deadline is still
`direct_timeout`"* — with the cancel-outranks case pinned alongside it at `:630`. So the cheap defense
is already in place; this row exists to record **why** those two tests must never be "simplified away",
which is the one thing neither the comment nor the assertion can carry on its own.

**Carry condition.** If `pi`/`ai` ever changes to reject on abort, the ordering becomes redundant but
stays harmless — do not remove it opportunistically, because the empty-on-abort shape would then be
untested rather than impossible. Re-check this row if the provider layer is swapped.

## FU-3 — scratch-build provenance (carried review item, closed here)

The Groups 2-4 live proofs all ran the W1 out-of-tree build, never a repo `dist/**`. Recorded so the
artifact is identifiable after the scratch tree is gone:

```
sha256  c5e4904b9ebdef164d3b0b8dd9d79f3287233e00aa133b4b91835711e174ccd4
file    $HOME/.cache/acp-station-viability-build/dist/src/cli.js  (48.9 KB)
```

Landing build (added at landing — the binary this PR ships, compiled from the same delta on top of
`origin/main` 4a4bc4a rather than the campaign branch, so it necessarily differs from the scratch hash):

```
sha256  c5039b9bcdf409c685aad5a52bf903c4853eafd29ecfa8debefcaa7945893ba2
file    dist/src/cli.js  (38.9 KB)
```
