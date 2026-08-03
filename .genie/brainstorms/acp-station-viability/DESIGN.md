# Design: ACP station viability — direct mode + honest failure surfaces

| Field | Value |
|-------|-------|
| **Slug** | `acp-station-viability` |
| **Date** | 2026-08-03 |
| **WRS** | 100/100 |
| **Revision** | r3 — r2 fixed round 1's fourteen findings; r3 fixes round 2's five: two-turn continuity test backs ledger row 2, failed turns barred from the session store (+ hermetic assertion), per-consumer deadline resolution stated (bare 300s / metal-river 600s), "saturation" replaced with the actual agent.ts:353 guard semantics, ledger row 3 hedged as unmeasured |
| **Origin** | metal-river `meri-mascot` transferred criteria (user decision 2026-08-03: fix rlmx/station before provisioning a khal key) |

## Problem

Station arms are unusable through `rlmx acp`: the rlmLoop protocol never
reaches `FINAL()` at NPU speeds (~25.4s/iteration; 0/8 measured ticks), the
inner 300s cap returns **empty answers as normal `end_turn`** instead of
errors (`agent.ts:370` `result.answer ?? ""`, `:400` end_turn), rlm's
`EmptyResponses` abort puts its error prose **inside the answer field**
(`rlm.ts:841-860`) which ACP then streams and persists as if it were a
reply, and `maxIterations` has no ACP-side control. (FastFlowLM's
truncation-as-`stop` is a separate latent hazard — the measurement
explicitly ruled it out as a cause of the 0/8: per-request input stayed
≤1,088 tokens; it is handled in OUT.)

Yet a single completion works where the loop does not, on the same arm:
**73 one-shot ≤45-word advisor completions over 6.5h on
`qwen3.6-moe-35b-a3b-FLM`** (2026-08-03 00:44→07:18, 5-min cadence,
p50 15s / p90 40s / 6.8% ≥60s / 2 of 73 censored at the advisor's own 90s
timeout), preceded by two weeks of the same one-shot shape on its 2B
predecessor. The loop protocol, not the model, is the blocker. Full record:
`prod/.genie/wishes/meri-mascot/latency-report.md` (§2 windows A/B with ACP
session refs, §3 rates, §4 shared-window probe, §7 leads).

Corroborating rlmx's own campaign record (different model —
`station/Brain-35B` — so latencies do NOT transfer, but the operational
lessons do): the rlmx-proof `station-direct` arm runs single completions at
22-35s/cell with `timeoutMs: 1_200_000`, has had a direct call **hang 2.5h**
(campaign incident-1; commit `61d9a7f` exists to bound direct attempts), a
gateway death that poisoned 29 cells, and a classifier gap where direct-arm
failures logged as `malformed_output` rather than an error class.

## Scope

### IN
1. **Root-cause trace first:** reproduce and instrument the G1 anomaly — a
   trivial no-REPL prompt returning empty after ~5 min (`EmptyResponses`,
   "context may exceed API limits") — before building. The fix work below
   is re-scoped by its findings if they contradict the working theory
   (oversized loop scaffold prompt × NPU prefill × FLM empty-on-overflow).
2. **Direct mode on the ACP path:** per-project opt-in (`.rlmx/rlmx.yaml`
   key `loop: direct`) plus env override, where a `session/prompt` becomes
   ONE chat completion and the answer arrives whole. Specified precisely:
   - **Prompt construction:** a minimal direct-mode system prompt (NOT the
     rlm loop scaffold — the working theory blames that scaffold, so the
     fix must actually drop it) + the existing bounded `PREAMBLE_TURNS`
     conversation transcript (built at `acp/agent.ts:~460`) + the query.
   - **Deadline (mandatory):** the direct branch constructs its own
     `AbortController` deadline honoring `RLMX_ACP_RUN_TIMEOUT_MS` with
     the SAME guard semantics as the existing loop override
     (`agent.ts:353`: non-finite or ≤0 → the default; otherwise honored as
     given — no clamping; "saturation" in earlier drafts meant exactly
     this and nothing more), default 300_000 — `llmComplete` accepts only
     a signal and owns no timeout, and the loop's `setTimeout` is bypassed
     by this branch, so without this the mode ships with NO wall clock on
     a gateway that has already hung a direct call for 2.5h.
     **Resolved deadline per consumer:** run bare (env unset) the default
     300s applies; under metal-river the supervisor sets the env to 600s
     (`insights.rs:34-52`, PROMPT_TIMEOUT−60s) so MERI's direct turns get
     600s — acceptable (still bounded, still inside metal-river's own
     660s), and stated per-criterion below.
   - **Empty result is an error:** a direct completion returning empty or
     whitespace-only text is a structured error, never an `end_turn`.
   - **Failed turns never enter the session store:** `appendTurn` currently
     persists every non-cancelled turn (`agent.ts:368-378`) — the exact
     path that put error prose into consumer stores. In BOTH modes, a turn
     that ends in a structured error is NOT appended, so the bounded
     preamble never replays failures into subsequent prompts (the
     continuity the ledger's criterion-2 row rests on).
   - Default remains the full loop — zero behavior change for existing
     consumers. Favorable compatibility fact: `config.ts` performs no
     unknown-key rejection, so `loop: direct` is silently ignored by older
     rlmx builds and by every non-ACP consumer.
3. **Honest failure surfaces, per mode:** loop mode — inner-cap expiry and
   `EmptyResponses` become structured ACP errors (never empty `end_turn`,
   never error prose in `answer`); direct mode — deadline expiry and
   empty/whitespace completions likewise.
4. **`RLMX_ACP_MAX_ITERATIONS`:** env override with the same guard
   semantics as `RLMX_ACP_RUN_TIMEOUT_MS` (non-finite or ≤0 → default 30;
   otherwise honored as given, no clamping). Loop mode only, by
   construction. Shipped as a knob; its sufficiency for tooled answers on
   station is unmeasured (see ledger row 3).
5. **Docs:** README ACP section (coordinate with `rlmx-release-hygiene`,
   which owns "ACP experimental labeling" — ordering note, not a conflict),
   config-schema doc for the new key, worker-models.md note tying direct
   mode to station arms.
6. **Cross-repo acceptance demo (final group):** with patched rlmx, a
   metal-river `river-insights --tick` on `station/qwen3.6-moe-35b-a3b-FLM`
   lands a real broadcast JSONL row. The one-line consumer edit
   (`loop: direct` in `metal-river/insights/.rlmx/rlmx.yaml`) is sanctioned
   here — acknowledged: it deliberately changes the "template untouched"
   end-state the meri latency report pinned (that pin recorded a G3
   outcome, not a permanent invariant), and the meri wish ledger is updated
   in the same breath.

### OUT
- Fixing FLM/Lemonade itself (truncation-as-stop stays theirs; direct mode
  bounds its own prompts and never trusts finish_reason).
- rlmLoop prompt/protocol re-engineering for small models (the GEPA
  campaign record shows that is a research program, not a fix).
- Recursion, the benchmark harness, and every file the live rlmx-proof
  campaign currently holds dirty: `src/station-provider.ts`,
  `scripts/smoke-acp.mjs` (the ACP smoke script — the file this wish would
  most plausibly want; any new smoke coverage goes in a NEW script),
  `tests/khal-provider.test.ts`, `tests/station-provider.test.ts`, plus
  dist mirrors.
- Changing loop-mode defaults, khal behavior, or SDK `runAgent` shapes.
- MERI-side features beyond the one-line template key.

## Transferred-criteria ledger (meri-mascot → this wish)

| meri item | This wish | How |
|---|---|---|
| Criterion 1, live-broadcast clause | **Closes** | Direct-mode tick → real JSONL broadcast row (Scope 6, criterion 8) |
| Criterion 2, same-day chat continuity | **Closes (degraded-honest), TEST-BACKED** | Direct-mode chat carries the bounded preamble + seed; closure rests on the live two-turn continuity test in criterion 2b (turn 2 must demonstrably reference turn 1), not on the structural argument alone |
| Criterion 5, 24h-history answers (needs live Prometheus queries) | **NOT closed — explicitly unreachable in direct mode** | No REPL/tools by design. Possibly reachable later via loop mode with a low `RLMX_ACP_MAX_ITERATIONS` — the knob ships in this wish but its sufficiency on station is itself UNMEASURED (the record is FINAL() never reached in ~24 iterations) — or via the khal arm; deferred behind the trigger "station chat provably needs tooled answers" |
| Criterion 6, durable timeout-marked JSONL | **Enables, does not close** | Structured errors (Scope 3) give metal-river an unambiguous signal to persist; the JSONL write itself is metal-river's follow-on edit |

## Approach

**Trace → additive direct mode → honest errors → knob parity → cross-repo
proof.** The ACP agent already owns the seam where a prompt becomes
`rlmLoop(effectiveQuery, null, config, {...})` (`acp/agent.ts:~354`);
direct mode branches there into one `complete()` with its own deadline,
minimal system prompt, and the existing preamble — returning one whole
answer, matching the ACP "answer arrives whole" contract (no downstream UI
change). Failure mapping is a pure translation at the ACP result boundary.
Alternatives lost: fixing only the timeout surface (station stays mute —
the loop still can't finish); teaching the loop partial answers (changes
rlmLoop semantics for every consumer); driving the SDK's single-step shape
through ACP (larger surface than a branch at the existing seam).

### Design for Isolation
- Direct mode = one branch + one config key; hermetic tests with a fake
  model provider (stall → deadline error; empty → structured error;
  normal → whole answer).
- Error mapping = boundary translation, testable without a model.
- No shared state with campaign files; landing is a coordination concern.

## Landing plan (repo-state reality)

`rlmx` is currently checked out on `wish/rlmx-proof` with the live campaign
committing to it. This brainstorm exists as **untracked files only** (its
round-1 staging into the campaign's index was reverted). It lands on
rlmx's mainline — as its own commit/branch per rlmx's wish-branch+PR
convention — only in coordination with the campaign session, after or
between its incremental commits. `.genie/INDEX.md` (the campaign's live
tracker) gets this wish's entry at landing time, not before. No HEAD moves
in this worktree except by whoever owns it at that moment.

## Simplicity Case

- **Simplest complete design:** one config key, one branch with its own
  deadline, one error mapping, one env var, docs, one live proof.
- **Added machinery:** the trace group — paid for by a real unexplained
  datum (trivial-prompt emptiness) that would void the branch design if,
  e.g., the provider corrupts long prompts; direct mode's own
  AbortController — paid for by the recorded 2.5h direct-call hang.
- **Deferred until measured:** loop-protocol tuning for small models
  (trigger: station chat provably needs tooled answers — this is also
  transferred criterion 5's path); partial-answer streaming (trigger: a
  consumer needs it); token-budget guards against the truncation lie
  (trigger: direct-mode prompts measured near the window).
- **Complexity removed:** no rlmLoop semantic changes, no new ACP methods,
  no FLM workarounds beyond bounded prompts.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Trace group runs first and can re-scope the wish | One datum is unexplained; building on an unverified theory is how meri round-1 failed. |
| 2 | Direct mode is per-project config + env, default unchanged | Additive; config loader ignores unknown keys, so the key is forward/backward safe everywhere. |
| 3 | Every failure becomes a structured ACP error, per-mode (loop: inner-cap, EmptyResponses; direct: deadline, empty/whitespace completion) | The measured failure mode was silence indistinguishable from success; both G1 defects came from error-prose-as-answer. |
| 4 | Direct branch owns an AbortController deadline (RLMX_ACP_RUN_TIMEOUT_MS, guard semantics of agent.ts:353, default 300_000; resolves to 600s under metal-river's existing env) | llmComplete has no timeout; the loop's clock is bypassed; the campaign recorded a 2.5h direct hang. |
| 5 | `RLMX_ACP_MAX_ITERATIONS` mirrors the timeout override's guard semantics | Symmetry; loop mode stays usable on slow arms with a low cap — a possible (unmeasured) path for transferred criterion 5. |
| 8 | Failed turns are never appended to the session store, both modes | appendTurn currently persists every non-cancelled turn — the leak that poisoned consumer stores; replaying failures through the preamble would undermine the continuity the ledger claims. |
| 6 | Cross-repo acceptance = a real MERI broadcast row, n≥3 latency samples | The wish exists because MERI is mute; only a live row closes a criterion whose failure was only visible live. |
| 7 | Land in coordination with the rlmx-proof campaign; wish files stay untracked until landing; never touch its four dirty files | Active sibling session on `wish/rlmx-proof`; staging into its index (round-1 mistake, reverted) is exactly the collision to avoid. |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Trace finds a deeper cause (e.g. provider mangles long prompts) | Medium | Decision 1: trace first; re-scope without burning fix loops. |
| 2 | Gateway is not merely slowed but KILLED/wedged under campaign load (recorded: process kill, 29 poisoned cells, 31-min loader wedge) | Medium | Live proof carries a gateway liveness precondition + post-check (models endpoint probe before/after, state recorded); a dead-gateway sample voids and reruns rather than counting as failure. |
| 3 | Direct-mode latency exceeds the tick budget: the 35B arm's one-shot record is p50 15s / p90 40s / 2.7% censored at 90s on a SMALLER prompt than direct mode's; the tail past 90s was never observed | Medium | Criterion 2 takes n≥3 samples with recorded percentiles; median ≤120s target, hard per-sample cap 300s (the tick budget); if the envelope fails, the recorded data drives the next decision instead of a silent retry loop. |
| 4 | Sibling session lands conflicting ACP changes | Low | Landing plan above; wish files untracked until coordinated landing; rebase at landing is orchestrator-side. |
| 5 | Program-sequencing friction: the stable-release program sequenced three wishes and did not pre-authorize this fourth; rlmx-release-hygiene owns the ACP-experimental README labeling | Low | ACP's Experimental status permits the change itself; INDEX entry at landing declares the wish; README edits coordinate with release-hygiene's ordering. |

## Success Criteria

- [ ] Trace report (committed with the wish) explains the trivial-prompt
  empty answer with instrumented evidence, and states whether the working
  theory held or the scope was amended.
- [ ] Direct mode live: n≥3 one-line prompts through `rlmx acp` on
  `station/qwen3.6-moe-35b-a3b-FLM`, run BARE (env unset → 300s default
  deadline enforced by construction), all non-empty, per-sample latency
  and gateway liveness (pre+post) recorded; median ≤120s, every sample
  <300s (the direct-mode default deadline; note `SUGGESTED_TICK_SECS` is
  coincidentally also 300 while the shipped cadence default is OFF).
- [ ] Continuity live (backs ledger row 2): a two-turn direct-mode
  exchange on the same session where turn 2's answer demonstrably
  references turn 1's content; run bare, latencies + gateway liveness
  recorded.
- [ ] Loop-mode default proven unchanged (hermetic: absent key → rlmLoop
  path taken).
- [ ] Hermetic failure-surface tests with a fake provider: loop inner-cap
  expiry → structured error; EmptyResponses → structured error with no
  prose in `answer`; direct deadline expiry (stalled provider) →
  structured error; direct empty/whitespace completion → structured error.
  None of the four produce an `end_turn`, and NONE of the four appends a
  turn to the session store (store asserted unchanged after each).
- [ ] `RLMX_ACP_MAX_ITERATIONS` honored with saturation semantics (test).
- [ ] Existing rlmx test suite passes; none of the four campaign-dirty
  files (nor dist mirrors) touched.
- [ ] Docs updated (README ACP — coordinated with release-hygiene, config
  schema, worker-models note).
- [ ] Cross-repo: `river-insights --tick` on patched rlmx lands a real
  `kind:"broadcast"` JSONL row on the station arm (one-line metal-river
  template edit sanctioned + acknowledged), and the meri-mascot ledger is
  updated: broadcast clause closed, criterion-2 clause closed-degraded
  (citing the two-turn continuity test evidence), criterion-5 recorded
  unreachable-by-design with its trigger, criterion-6 enablement noted.
  This cross-repo run executes under metal-river's env (deadline resolves
  to 600s per Scope 2) — a direct-mode failure surfaces within 600s there.

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `c12d7db5e4bcf859b3ee4ee67383c2f624c373e9cd2da5b6614f2b98cb166b5c`
- **Reviewer:** genie:reviewer/acp-station-viability-design-r3
- **Reviewed at:** 2026-08-03T11:05:54.000Z
<!-- genie-design-review:end -->
