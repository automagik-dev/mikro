# Plans Index

## Raw
- **rlmx-proof** (wish 2 of the stable-release program) — benchmark checkpoint/resume + model matrix + full Aider polyglot (225) across 4 arms (local `station/Brain-35B` ±rlmx, cheap cloud ±rlmx) + rlmx-scoped RTK savings → `docs/benchmarks.md`. Frontier baselines **cited** from the Aider leaderboard, never run. Brainstorm when wish 1 ships. See `brainstorms/rlmx-stable-release/DRAFT.md`.
- **rlmx-launch** (wish 3) — README from scratch around the three proven claims, microagent recipes, visible-recursion demo, `rtk-ai/rtk` reciprocity. **Blocked on rlmx-proof's numbers** — the README cannot be written before the benchmarks exist.

## Simmering
- [rlmx-stable-release](brainstorms/rlmx-stable-release/DRAFT.md) — **program record + roadmap** for the stable release. Decisions D1–D8 settled 2026-07-25: calendar versioning stays, `rlmx acp` experimental, positioning = three evidence-backed claims (cost · cheap/local capability unlock · context effectiveness), full Aider polyglot with 4 arms, three sequenced wishes. Stays Simmering until all three child wishes land.

## Ready
- [rlmx-release-hygiene](brainstorms/rlmx-release-hygiene/DESIGN.md) — wish 1 of 3: `js-yaml` (high) + `protobufjs` prod-tree advisories, stale release-contract correction (no `dev` branch, `drogo/*` obsolete), CHANGELOG backfill for the ACP/recursion/pi-ai-0.80/station era, ACP experimental labeling, dist-tag repoint, calendar release cut. **Unblocked — depends on no benchmark.** Design review pending.

## Poured
- [rlmx-acp-adapter](wishes/rlmx-acp-adapter/WISH.md) — `rlmx acp` stdio ACP agent (via @agentclientprotocol/sdk) driving the instrumented `rlmLoop` in-process, translating the recursion event stream → ACP session updates; consumed by Tidewave (web) + pi native TUI; pi-acp as reference. Design SHIP + plan APPROVED 2026-07-20. **depends-on rlmx-live-tui** (emitter seam).
- [rlmx-live-tui](wishes/rlmx-live-tui/WISH.md) — pi-ai 0.77→latest (Models runtime) + instrument the recursion path (RecurseEvent producer + rlmLoop→emitter + child-result bridge). **Amended + re-reviewed SHIP 2026-07-20: custom TUI dropped; viewing moves to rlmx-acp + pi native TUI.** `blocks` extract-200-percent + rlmx-acp-adapter.
