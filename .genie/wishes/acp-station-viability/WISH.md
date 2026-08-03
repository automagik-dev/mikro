# Wish: ACP station viability — direct mode + honest failure surfaces

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `acp-station-viability` |
| **Date** | 2026-08-03 |
| **Author** | Genie (design SHIP r3, 3 review rounds, digest-stamped) |
| **Appetite** | medium |
| **Branch** | worktree currently on `wish/rlmx-proof` (live campaign) — this wish's changes stay UNCOMMITTED in the shared worktree until coordinated landing per the design's Landing plan; the orchestrator owns all git state |
| **Repos touched** | rlmx (src/acp, src/config, src/rlm surface, docs, tests) + one-line metal-river consumer edit + meri-mascot ledger update in Group 4 |
| **Design** | [DESIGN.md](../../brainstorms/acp-station-viability/DESIGN.md) |

## Summary

Make station arms usable through `rlmx acp`: trace the trivial-prompt empty-answer anomaly first, then add an opt-in **direct mode** (one bounded chat completion at the existing prompt seam — no REPL loop), convert every failure (inner-cap expiry, EmptyResponses, direct deadline expiry, empty/whitespace completion) into structured ACP errors that never masquerade as answers and never enter the session store, add `RLMX_ACP_MAX_ITERATIONS`, and prove it cross-repo with a real MERI broadcast row. Origin: metal-river meri-mascot's transferred criteria (user decision 2026-08-03).

## Scope

### IN
- Trace group (root-cause the G1 anomaly; may re-scope the wish — orchestrator checkpoint after it).
- `loop: direct` project-config key + env override; direct branch with its own AbortController deadline (`RLMX_ACP_RUN_TIMEOUT_MS`, `agent.ts:353` guard semantics — non-finite or ≤0 → default 300_000, otherwise honored, no clamping; resolves to 600s under metal-river's existing env), minimal direct system prompt (NOT the rlm scaffold) + bounded `PREAMBLE_TURNS` transcript + query.
- Per-mode structured failure surfaces; failed turns never appended to the session store (both modes).
- `RLMX_ACP_MAX_ITERATIONS` (same guard semantics, default 30, loop-only; sufficiency on station unmeasured — shipped as a knob).
- Docs: README ACP (coordinate ordering with rlmx-release-hygiene), config schema, worker-models note.
- Live proofs (bare env): n≥3 one-line direct prompts + one two-turn continuity exchange on `station/qwen3.6-moe-35b-a3b-FLM`, gateway liveness pre+post each.
- Cross-repo final group: `loop: direct` line in `metal-river/insights/.rlmx/rlmx.yaml` (sanctioned + acknowledged), `river-insights --tick` lands a real broadcast row, meri-mascot ledger updated per the design's transferred-criteria table.

### OUT
- FLM/Lemonade fixes; rlmLoop protocol re-engineering; recursion; benchmark harness.
- The four campaign-dirty files (`src/station-provider.ts`, `scripts/smoke-acp.mjs`, `tests/khal-provider.test.ts`, `tests/station-provider.test.ts`) and their dist mirrors — any new smoke coverage goes in a NEW script.
- Loop-mode default changes, khal behavior, SDK `runAgent` shapes, MERI features beyond the one config line.
- Committing anything in rlmx during execution (landing is a separate coordinated step).

## Decisions

Carried verbatim from the SHIPped design (Decisions 1–8): trace-first with re-scope authority; additive config key (loader ignores unknown keys — forward/backward safe); per-mode structured errors; direct-branch-owned deadline; iteration knob with guard semantics; live-proof acceptance with n≥3 + continuity pair; campaign coordination with untracked-until-landing; failed turns barred from the store. Plus one wish-level addition:

| # | Decision | Rationale |
|---|----------|-----------|
| W1 | **Scratch-build protocol (out-of-tree):** the shared `dist/` is NEVER written by this wish. All compilation goes to a stable scratch tree, `$HOME/.cache/acp-station-viability-build/`, rebuilt in EXACTLY this order (nothing after the wipe survives it): `rm -rf "$SCRATCH"` → `npx tsc --outDir "$SCRATCH/dist"` → `cp src/benchmark-data.json "$SCRATCH/dist/src/"` → `rm -rf "$SCRATCH/dist/src/templates" && cp -r src/templates "$SCRATCH/dist/src/templates"` → `printf '{"type":"module"}' > "$SCRATCH/package.json"` → `ln -sfn /home/namastex/prod/rlmx/node_modules "$SCRATCH/node_modules"` → `ln -sfn /home/namastex/prod/rlmx/python "$SCRATCH/python"` → `ln -sfn /home/namastex/prod/rlmx/examples "$SCRATCH/examples"` → `ln -sfn /home/namastex/prod/rlmx/src "$SCRATCH/src"`. The package.json and node_modules symlink are LOAD-BEARING (ESM walk-up: without them every scratch file is misparsed as CJS / throws ERR_MODULE_NOT_FOUND). The `dist/` NESTING and the three repo symlinks are equally load-bearing (**W1 amendment, 2026-08-03, orchestrator decision after a Group 2 env-tool-failure diagnosis**): the suite is written for `dist/tests/` depth — tests resolve repo assets via `join(__dirname, "..", "..")` — so a flat scratch tree strands them one level shallow (16 identical failures on a clean HEAD baseline under the FLAT tree; depth-corrected: clean HEAD = 711/711 green, with Group 2's work = 741/741 green — the +30 are Group 2's new tests, none went missing). Diagnosis evidence: engineer baseline diff (failing-set identical with Group 2's changes reverted) + green probe tree. The full suite runs as `node --test "$SCRATCH"/dist/tests/*.test.js`; Groups 3–4 run the patched CLI via `RLMX_CLI="$SCRATCH/dist/src/cli.js"`. **A green scratch build + suite is a hard precondition for dispatching Waves 3 and 4** — without it those groups would exercise stale code and produce proofs of nothing; there is no deferral path. Everyday incremental gate remains `npm run check` (writes nothing). **Rejected on record:** building the shared `dist/` under a compilability pre-check — the campaign EXECUTES `dist/` while scoring cells, so a rebuild would publish the sibling's half-finished src into a live benchmark's binary (its own incident record: 29 poisoned cells); compilability was the wrong property to check. The real `npm run build` happens once, at coordinated landing, by the orchestrator. | `package.json`: `test = node --test dist/tests/*.test.js`, `build = tsc && …` — the suite cannot run without a compiled tree, and the shared one belongs to a live campaign; an out-of-tree compile gives the full suite and both live groups with zero collision surface. |

## Simplicity Case

Carried from the design (verified there through three review rounds): one key, one branch with its own deadline, one error mapping, one env var, docs, live proof. Added machinery = the trace group (real unexplained datum) and the direct deadline (recorded 2.5h hang). Deferred: loop tuning for station (ledger row 3 trigger), partial-answer streaming, token-budget guards. The wish adds only W1 (the scratch-build protocol), paid for by the measured shape of rlmx's own test script colliding with a live campaign's executing dist.

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

Carried 1:1 from the design's criteria, with the review NIT wording fixes applied here: C5 asserts the `agent.ts:353` guard semantics (non-finite or ≤0 → default 30); 300s is the direct-mode default deadline (not "the tick budget").

- [ ] C1 trace report committed with the wish, theory confirmed or scope amended
- [ ] C2 bare direct-mode live: n≥3, all non-empty, median ≤120s, each <300s, gateway liveness pre+post
- [ ] C2b bare two-turn continuity: turn 2 demonstrably references turn 1
- [ ] C3 loop default unchanged (hermetic)
- [ ] C4 four failure surfaces → structured errors, none end_turn, none appended to store (hermetic)
- [ ] C5 `RLMX_ACP_MAX_ITERATIONS` honored (guard semantics, hermetic)
- [ ] C6 `npm run check` clean throughout; full suite green from the W1 scratch tree (hard precondition for Waves 3–4); the four campaign files untouched by hand AND the shared `dist/` never written by this wish (the never-touch rule binds hand edits and shared-dist writes; the scratch tree is where compilation happens — no contradiction)
- [ ] C7 docs updated (README ACP / config schema / worker-models)
- [ ] C8 cross-repo: real `kind:"broadcast"` row via `river-insights --tick` (600s resolved deadline noted); meri-mascot ledger updated per the design table (row 2 citing C2b + the Group 4 consumer-path continuity check)

## Execution Strategy

### Wave 1 (sequential — gates everything)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 3 (+2 stateful live-system investigation against a shared gateway; +1 no deterministic test — evidence artifact is the output) | engineer-standard / high | Trace: root-cause the trivial-prompt empty answer; orchestrator checkpoint may re-scope |

### Wave 2 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 2 | engineer | 5 (+2 stateful: session store, deadlines, per-mode error contracts; +2 routing/lifecycle: mode branch at the ACP seam; +1 shared-worktree discipline with a live sibling) | engineer-complex / high | Direct mode + failure surfaces + iteration knob + hermetic tests |

### Wave 3 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 3 | engineer | 2 (+1 live-measurement discipline; +1 doc-ordering coordination with release-hygiene) | engineer-standard / medium | Docs + bare live proofs (C2, C2b) with liveness protocol |

### Wave 4 (sequential, final)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 4 | engineer | 2 (+1 cross-repo edit + ledger bookkeeping; +1 live end-to-end run) | engineer-standard / medium | metal-river consumer line + MERI broadcast proof + meri ledger update |

Routing basis: totals map per the standard bands (0–1 trivial/low, 2–3 standard, 4–6 complex/high). Within the 2–3 band, Group 1 takes high effort (its output re-scopes the wish); Groups 3–4 take medium (mechanical work with live-run checklists).

## Execution Groups

### Group 1: Trace — root-cause the empty answer

**Goal:** Explain, with instrumented evidence, why a trivial no-REPL prompt through `rlmx acp` on the station arm returned empty after ~5 minutes (G1 anomaly, ACP sessions 75b16ca5-… / d5e65f47-…), and state whether the direct-mode working theory (loop scaffold prompt × NPU prefill × FLM behavior) holds.

**Deliverables:**
1. Reproduction attempts with gateway liveness pre+post each probe (models endpoint), recorded regardless of outcome; instrumentation at the seam (exact messages leaving rlmx for the provider; what returns; iteration count; per-iteration timing) via env/logging/untracked scratch scripts only — no tracked-source edits in this group.
2. Trace report at `.genie/wishes/acp-station-viability/trace-report.md`: causal chain, evidence refs (session files, probe logs), verdict on the working theory, any scope amendment the findings force.
3. If the theory is falsified (e.g. the provider corrupts prompts, or single completions also fail), STOP and report — the orchestrator re-scopes before Group 2 dispatches.

**Acceptance Criteria:**
- [ ] Report exists with a causal explanation backed by captured evidence (not inference alone).
- [ ] Gateway liveness recorded around every probe; dead-gateway samples voided and re-run, never counted.
- [ ] Explicit verdict line: theory HELD / AMENDED (with the amendment).

**Validation:**
```bash
cd /home/namastex/prod/rlmx && test -f .genie/wishes/acp-station-viability/trace-report.md && npm run check
```
Scope fits: the group produces an evidence artifact, not code — report existence plus `npm run check` (proves the shared worktree still compiles; writes nothing). The orchestrator snapshots the four campaign files' hashes before dispatch and compares after, asserting this group added no tracked-source change. A heavier gate would be theater for a read-only group.

**depends-on:** none

---

### Group 2: Direct mode + honest failure surfaces + knob

**Goal:** The code deliverables land in the shared worktree (uncommitted): direct branch with owned deadline, per-mode structured errors, store-append bar, iteration knob — all hermetically tested.

**Deliverables:**
1. `loop: direct` config key (parser + type, unknown-key tolerance preserved) + env override; direct branch at the ACP prompt seam (`acp/agent.ts` ~:354): minimal system prompt + bounded preamble + query → one completion; own AbortController deadline per the design.
2. Failure surfaces: loop inner-cap expiry and EmptyResponses → structured ACP errors (no prose in `answer`); direct deadline expiry and empty/whitespace completion → structured errors; NO failed turn appended via `appendTurn` in either mode.
3. `RLMX_ACP_MAX_ITERATIONS` with the `agent.ts:353` guard semantics (default 30).
4. Hermetic tests (fake provider; NEW test files only — never the two campaign-dirty test files): C3, C4 (all four surfaces + store-unchanged assertions), C5, plus the direct-mode happy path (whole answer, preamble carried).

**Acceptance Criteria:**
- [ ] C3, C4, C5 test-proven; direct happy path proven — all via the W1 scratch tree.
- [ ] `npm run check` clean; no campaign-dirty file modified by hand; shared `dist/` never written.
- [ ] Scratch build + full suite green at group end (W1) — this is the hard precondition Waves 3–4 dispatch on; a red scratch build halts the wish here.

**Validation:**
```bash
cd /home/namastex/prod/rlmx && npm run check && SCRATCH="$HOME/.cache/acp-station-viability-build" && rm -rf "$SCRATCH" && npx tsc --outDir "$SCRATCH/dist" && cp src/benchmark-data.json "$SCRATCH/dist/src/" && rm -rf "$SCRATCH/dist/src/templates" && cp -r src/templates "$SCRATCH/dist/src/templates" && printf '{"type":"module"}' > "$SCRATCH/package.json" && ln -sfn /home/namastex/prod/rlmx/node_modules "$SCRATCH/node_modules" && ln -sfn /home/namastex/prod/rlmx/python "$SCRATCH/python" && ln -sfn /home/namastex/prod/rlmx/examples "$SCRATCH/examples" && ln -sfn /home/namastex/prod/rlmx/src "$SCRATCH/src" && node --test "$SCRATCH"/dist/tests/*.test.js
```
Scope fits: the out-of-tree compile gives the FULL suite (including this group's new tests) with zero writes to the campaign's shared `dist/`; `check` stays as the fast incremental gate.

**depends-on:** group-1

---

### Group 3: Docs + bare live proofs

**Goal:** Documentation lands and the station arm demonstrably answers through direct mode under the bare 300s deadline.

**Deliverables:**
1. README ACP section (direct mode, both env knobs, failure semantics) — ordering coordinated with rlmx-release-hygiene's experimental-labeling ownership (note in the diff, no duplicated claims); config-schema doc; worker-models.md station note.
2. Live proof runs — **through the W1 scratch tree** (`node "$HOME/.cache/acp-station-viability-build/dist/src/cli.js" acp`; a green scratch build is this group's dispatch precondition, so the patched code is what runs) — bare env, gateway liveness pre+post each sample: C2 (n≥3 one-line prompts) and C2b (two-turn continuity), latencies + percentiles recorded into `.genie/wishes/acp-station-viability/live-proof.md`; dead-gateway samples voided and re-run per the design's Risk 2 policy.
3. Config-schema doc: `docs/agent-yaml-schema.md` covers AGENT yaml, not project yaml — no project-config schema doc exists today, so CREATE the section (a "project `.rlmx/rlmx.yaml`" section in that doc or a new `docs/project-config.md`; do not hunt for a file that isn't there).

**Acceptance Criteria:**
- [ ] C2 met (all non-empty, median ≤120s, each <300s) — or the recorded data plus a STOP for orchestrator decision if the envelope fails (no silent retry loops).
- [ ] C2b met: turn 2 references turn 1, evidence quoted in live-proof.md.
- [ ] C7 docs complete; `npm run check` clean.

**Validation:**
```bash
cd /home/namastex/prod/rlmx && npm run check && test -f .genie/wishes/acp-station-viability/live-proof.md
```
Scope fits: a docs + measurement group; the live criteria ARE the group's product and are judged from the recorded artifact, not a CI assertion.

**depends-on:** group-2

---

### Group 4: Cross-repo proof + ledgers

**Goal:** MERI broadcasts for real, and both wish ledgers tell the truth.

**Deliverables:**
1. `loop: direct` line added to `/home/namastex/prod/metal-river/insights/.rlmx/rlmx.yaml` (prod repo — committed by the orchestrator in prod, unlike the rlmx-side work).
2. Live: `river-insights --tick` with `RLMX_CLI="$HOME/.cache/acp-station-viability-build/dist/src/cli.js"` (the W1 scratch tree — the patched code, not the campaign's shared dist) lands a `kind:"broadcast"` JSONL row on the station arm; 600s resolved deadline noted; gateway liveness protocol as before; row + session id quoted in live-proof.md.
3. **MERI-drawer continuity check (promoted from QA per plan review):** with the scratch RLMX_CLI, a live two-turn chat through `river-insights --chat` (the consumer path — metal-river's seed + preamble both in play) where turn 2 references turn 1; evidence quoted in live-proof.md. This is what the meri ledger row 2 citation actually rests on for the consumer side.
4. meri-mascot ledger update in `/home/namastex/prod/.genie/wishes/meri-mascot/WISH.md` exactly per the design's transferred-criteria table (row 1 closed; row 2 closed-degraded citing C2b + the consumer-path check above; criterion-5 unreachable-by-design with trigger; criterion-6 enablement).

**Acceptance Criteria:**
- [ ] C8 met with quoted evidence; the broadcast row passes metal-river's `[INFO]/[WARN]/[CRIT]` contract guard.
- [ ] Consumer-path two-turn continuity proven via `river-insights --chat` (deliverable 3), evidence quoted.
- [ ] metal-river core suite still green after the template edit (`cargo test`); the hash-based re-seed picks up the new key in the runtime project (proven by a refresh).
- [ ] meri ledger updated; no other metal-river file touched. **(Reconciled at review exec-g4-r1: the sanctioned fix loop additionally touched `metal-river/ui/src-tauri/core/src/insights.rs` (+tests) and `insights/.rlmx/SYSTEM.md` — the mode-agnostic tick-prompt fix, chosen over weakening the severity guard; justified expansion, recorded here so the landing diff does not read as scope creep.)**

**Validation:**
```bash
cd /home/namastex/prod && cargo test --manifest-path metal-river/ui/src-tauri/core/Cargo.toml && grep -q "loop: direct" metal-river/insights/.rlmx/rlmx.yaml && grep -c '"kind":"broadcast"' ~/.local/state/metal-river/insights/$(date +%F).jsonl
```
Scope fits: the cross-repo group is judged by the consumer's own gate (cargo suite + the live row's existence + the config line); rlmx-side state was validated in Groups 2–3.

**depends-on:** group-3

---

## QA Criteria

- [ ] With cadence enabled in MERI's settings, a broadcast bubble appears on the live board within one cadence period on the station arm.
- [ ] A two-turn chat in MERI's drawer shows same-day continuity on station (degraded-honest: no tooled answers).
- [ ] Killing the gateway mid-turn yields a structured error in the drawer (never a silent empty answer) and no store pollution.
- [ ] rlmx landing (post-campaign coordination) leaves the campaign branch history intact.

## Assumptions / Risks

Carried from the design (Risks 1–5: trace may re-scope; gateway death — liveness protocol with void-and-rerun; latency envelope Medium with recorded-data stop; sibling conflicts — untracked-until-landing; program sequencing — INDEX entry at landing). Wish-level addition: the W1 scratch tree must be rebuilt fresh (`rm -rf` first) whenever src changes, or Groups 3–4 could run stale code — mitigated by making a green fresh scratch build the dispatch precondition for those waves; the real `npm run build` of the shared dist happens exactly once, at coordinated landing, by the orchestrator (landing cannot proceed without that final green gate).

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan review — SHIP (2026-08-03T11:18:09Z, round 3)

- **Verdict:** SHIP (r1 FIX-FIRST: 2 HIGH — W1's deferral path stranded Groups 3–4 on stale dist; C6/OUT forbade the build W1 mandated — + 3 MEDIUM incl. the out-of-tree alternative, + 2 LOW. r2 FIX-FIRST: 1 HIGH — the adopted scratch protocol was not executable without `{"type":"module"}` + node_modules symlink (ESM walk-up) — + 1 LOW + 2 NIT. r3 SHIP: all four changes verified, nothing else moved.)
- **Reviewer:** genie:reviewer/acp-station-viability-plan-r1..r3 (same agent as the design's 3 SHIP rounds).
- **Design fidelity:** all 8 design decisions, 5 risks, and criteria (incl. C2b) carried 1:1; design-review NIT wording fixes applied at wish level as instructed.
- **Key plan-level outcome:** W1 scratch-build protocol (shared `dist/` never written; rejected shared-dist alternative on record with the mid-cell campaign hazard); consumer-path continuity check promoted into Group 4's gate.

### Execution review — Group 1 (trace) — SHIP (2026-08-03T11:57:45Z, round 2)

- **Verdict:** SHIP (r1 FIX-FIRST: report corrections only — 1 HIGH: the model WAS protocol-compliant in the control run, rlmx dropped 10 `FINAL_VAR` termination attempts via an unquoted-arg overload with an exec-discarded diagnostic; +3 MED (omitted interval, proxy-buffering disclosure + retracted abort reading, configSnapshot error) + LOWs. r2: all corrections landed accurately; the engineer also falsified a bad citation the orchestrator supplied and downgraded confidence accordingly.)
- **THEORY: AMENDED — direct mode confirmed viable.** iteration-0 correct answer in 9.7s discarded by the loop; empty-at-timeout root cause = `forceFinalAnswer` called with a pre-aborted signal (`rlm.ts:877`), proven by llmCalls/token arithmetic; no built-in scaffold — a custom SYSTEM.md silently drops the protocol; direct completions: 4.7s (41-tok prompt) / 14.1s (2028-tok), prefill ~94-156 tps at scale, decode ~11-14 tps.
- **Three rlmLoop defects recorded:** (1) pre-aborted-signal empty (→ Group 2's inner-cap error deliverable, same code path — sanctioned amendment a); (2) silent protocol drop with custom SYSTEM.md (→ Group 2 warning, corrected predicate: loop mode only, structured-output excluded, fires when system prompt contains neither `FINAL(` nor `FINAL_VAR(` — sanctioned amendment b); (3) `FINAL_VAR` unquoted-arg overload dropping compliant terminations (protocol design — OUT of scope, follow-up ledger row; carry the repl_server.py `:97`/`:111-115` citations and the decode-range nit into that row).
- **Structured errors do NOT recover discarded answers** — recorded so no one reads Group 2 as "fixes the empty answer". C2 remains Group 3's (n=2 diagnostic runs do not pre-satisfy it). Campaign-file hashes byte-identical pre/post (orchestrator-verified both rounds).

### Execution review — Group 4 — SHIP after orchestrator ledger corrections (2026-08-03)

- **Verdict:** SHIP (exec-g4-r1 returned FIX-FIRST resting on F1 alone — the meri ledger's closing paragraph contradicted its own CLOSED verdict; the orchestrator rewrote it (with F2's precision: "2/2 passed the severity guard; 1/1 clean after the naming fix") and reconciled F5 (the Group 4 acceptance line vs the sanctioned fix-loop file expansion). Reviewer's judgment: no re-run of any live evidence required.)
- **Independently verified by the reviewer:** every number in both broadcast rows matches Prometheus TO THE DECIMAL at write-time-minus-duration (which corroborates the 18s/20s latencies); `broadcast_severity` and `today_seed_lines` byte-identical to HEAD; FERROVIA-77 continuity structurally seed-excluded; 91/0 reproduced; rlmx tracked set provably untouched by mtime; the anti-naming rule HELD under a contaminated seed (attempt 2 was seeded with the fabricated row and still complied) — stronger than a clean-room retry.
- **History:** original G4 blocked honestly (3/3 deterministic refusals — tick prompt demanded REPL tooling direct mode lacks; guard NOT weakened; ledger recorded STILL OPEN). Fix loop: host-side TICK_FACTS pushed into the prompt (drop-unreadable-never-zero; dead-Prometheus → honest [WARN]), REPL demoted to optional, SYSTEM.md conditional, anti-fabrication naming rule after catching a hallucinated container name by reading the output; 2/2 guard-conforming live rows; 3 phrasing-contract tests (91 total).
- **Residuals recorded:** durable fabricated row in today's JSONL (generated data, human-only removal; seeds later turns today; naming-rule resistance n=1); instant-gauge transients (avg_over_time candidate at cadence-enable); F6 landing-gate check that the 3 dirty dist mirrors are the campaign's expected state; live-display QA still genuinely open (no rendered surface was put before a human in this wish).
- **Wish-level:** C1–C8 all MET (C8 met-with-defect → defect fixed). Remaining: coordinated rlmx LANDING (real dist build + commit + INDEX entry, post-campaign, orchestrator-owned; record scratch-CLI sha at landing) and meri live-display QA.

### Execution review — Group 3 — SHIP (2026-08-03T12:52:48Z)

- **Verdict:** SHIP. **Reviewer:** exec-g3-r1 — all six live-proof sub-claims falsification-tested and held; the reviewer REPRODUCED the live proof with an independently written driver (6.392s, end_turn, one answer chunk, liveness 200 pre+post); every doc claim traced to code (bubble string byte-accurate to session.ts:566; env-legend semantics exact; Experimental block untouched); all five carried items closed — the real-loop timeout test endorsed as STRONGER than a fake-seam test (34/34 on the wish test files, reconciling exactly to 745).
- **Live proof:** C2 3/3 non-empty, median 5.60s (4.7% of the 120s bar), max 6.43s (2.1% of the 300s deadline); C2b TANGERINE-91 verbatim on one session; bareness by construction (verified: no dotenv anywhere; station default URL = the probed gateway); settings.json stale pin proven unreachable on the acp path (source + configSnapshot).
- **Routed:** [LOW] record a sha256 of the scratch CLI in the proof at LANDING (the proving tree was rebuilt 112s later; contained — sources unchanged and the result is self-authenticating); [NIT→Group 4 ledger] pi/ai empty-on-abort behavior gets a durable ledger row (dependency property, already produced one shipped defect, load-bearing for the deadlineFired-before-direct_empty ordering) alongside defect #3; [NIT] release-hygiene coordination note = bookkeeping only; [NIT] strippedEnvVerified verifies the constructor not the child (closed by inspection + independent run).

### Execution review — Group 2 — SHIP (2026-08-03T12:41Z)

- **Verdict:** SHIP. **Reviewer:** exec-g2-r1 (rebuilt scratch + clean-HEAD trees independently: 741/741 vs 711/711, delta exactly +1 file/+8 suites/+30 tests; C3/C4/C5 + direct happy path all falsification-tested; amendment (a) side effect verified as an improvement — timed-out benchmark cells were previously classified "ok", now "run_timeout", `empty_responses` untouched; `RlmxConfig.loop` required-field fallout contained, yaml-less defaults verified empirically incl. metal-river's live template; W1 block resolved by orchestrator amendment after the engineer's env-tool-failure diagnosis).
- **Carried into Group 3 (review items, sanctioned):** [MEDIUM] hermetic test for the REAL rlm.ts timeout exit (tiny timeout + provider that outlives it) — must close before landing; [LOW] export `LoopMode`/`RLMFailure`/`DEFAULT_LOOP_MODE` from src/index.ts + note the required-field change in docs; [LOW] cancel-outranks-failure test; [NIT] modes.ts:259 cite symbols not line numbers; [LOW] restate or revert the polyglot-fixture edit's rationale (falsified: it was not required-field fallout; kept as fixture fidelity). [Handoff note] full-mode timeout also emits a translateError bubble ("rlmx error [timeout] …", distinct messageId, pre-existing contract) before the structured error — Group 3 docs must state it; Group 4 drawer QA will see bubble + error.

---

## Files to Create/Modify

```
rlmx src:   src/acp/agent.ts, src/config.ts, (possibly src/acp/session-store.ts, src/rlm.ts error mapping)
rlmx tests: NEW tests/acp-direct-mode.test.ts (indicative name)
rlmx docs:  README.md, a NEW project-config schema section (in docs/agent-yaml-schema.md or new docs/project-config.md — created, not hunted; per Group 3 D3), docs/worker-models.md
rlmx .genie: wishes/acp-station-viability/{WISH.md,trace-report.md,live-proof.md}; INDEX.md entry AT LANDING only
prod:       metal-river/insights/.rlmx/rlmx.yaml (one line), .genie/wishes/meri-mascot/WISH.md (ledger)
NEVER:      src/station-provider.ts, scripts/smoke-acp.mjs, tests/khal-provider.test.ts, tests/station-provider.test.ts, dist mirrors
```
