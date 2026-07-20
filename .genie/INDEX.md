# Plans Index

## Raw

## Simmering

## Ready

## Poured
- [rlmx-acp-adapter](wishes/rlmx-acp-adapter/WISH.md) — `rlmx acp` stdio ACP agent (via @agentclientprotocol/sdk) driving the instrumented `rlmLoop` in-process, translating the recursion event stream → ACP session updates; consumed by Tidewave (web) + pi native TUI; pi-acp as reference. Design SHIP + plan APPROVED 2026-07-20. **depends-on rlmx-live-tui** (emitter seam).
- [rlmx-live-tui](wishes/rlmx-live-tui/WISH.md) — pi-ai 0.77→latest (Models runtime) + instrument the recursion path (RecurseEvent producer + rlmLoop→emitter + child-result bridge). **Amended + re-reviewed SHIP 2026-07-20: custom TUI dropped; viewing moves to rlmx-acp + pi native TUI.** `blocks` extract-200-percent + rlmx-acp-adapter.
