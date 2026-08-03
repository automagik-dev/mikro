# acp-station-viability — DRAFT

**Status:** Ready · WRS 100/100 — crystallized to DESIGN.md
**Date:** 2026-08-03
**Origin:** metal-river meri-mascot wish — user decision "fix rlmx/station first"
(over provisioning a khal key). Transferred criteria live in
`prod/.genie/wishes/meri-mascot/WISH.md`; evidence in that wish's
`latency-report.md`.

## Problem (evidence-backed, 2026-08-03)

ACP hosts cannot get answers from station arms. Measured on
`station/qwen3.6-moe-35b-a3b-FLM` (metal-river G3, 8/8 ticks failed):

1. rlmLoop's inner 300s cap (`rlm.ts:85`) expires and the ACP turn returns
   `answer: ""` with a normal `end_turn` — failure indistinguishable from
   silence. With the cap raised to 601s (env override), still zero answers:
   ~25s/iteration, ~14 tok/s, `FINAL()` never reached in ≤24 iterations.
2. Even a trivial "reply with one line, no REPL" prompt returned empty after
   5 minutes (G1, session 75b16ca5-…). rlmx's own abort exists
   (`rlm.ts:842`: 3 consecutive empty LLM responses — "Context may exceed
   API limits") and its error prose leaked into consumer stores as answers.
3. `maxIterations: 30` (`rlm.ts:84`) has no ACP-side override; the timeout
   does (`RLMX_ACP_RUN_TIMEOUT_MS`, `acp/agent.ts:353`). A one-line tick
   cannot cap its own loop.
4. FastFlowLM reports truncation as `finish_reason: "stop"` (32,768 window
   SHARED with generation, boundary-probed) — large REPL output is silently
   half-read.

Meanwhile the SAME model answered one-shot ≤45-word completions daily for
weeks (the retired metal-river advisor) — the model is not the blocker; the
loop protocol is.

## WRS: all five dimensions filled from evidence; the single user-level
decision (do this in rlmx, now, instead of the khal key) was made by the
user on 2026-08-03. No open questions remained → auto-crystallized.

## Context findings
- rlmx repo has an ACTIVE sibling session: rlmx-proof benchmark campaign
  mid-flight (dirty `src/station-provider.ts`, `scripts/smoke-acp.mjs`,
  dist files; recent campaign commits). Station gateway is under campaign
  load. Execution must not touch the campaign's files and should coordinate
  landing.
- rlmx project config (`config.ts`) has no mode/shape key; ACP always
  drives full `rlmLoop`. The SDK's `runAgent` has shapes but that is not
  the ACP path.
- `rlmx acp` is flagged Experimental — additive protocol/config changes are
  sanctioned by rlmx's own stable-release program (INDEX: rlmx-stable-release).
