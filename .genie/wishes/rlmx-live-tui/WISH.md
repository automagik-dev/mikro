# Wish: rlmx pi-ai upgrade + recursion observability

| Field | Value |
|-------|-------|
| **Status** | APPROVED (amended + re-reviewed 2026-07-20) |
| **Slug** | `rlmx-live-tui` |
| **Date** | 2026-07-20 |
| **Author** | felipehowit@gmail.com |
| **Appetite** | medium |
| **Branch** | `wish/rlmx-live-tui` |
| **Repos touched** | `~/prod/rlmx` |
| **Design** | [DESIGN.md](../../brainstorms/rlmx-live-tui/DESIGN.md) |

> **Scope amendment 2026-07-20:** the custom pi-tui recursion view (former Group 3) is **removed**
> per user decision ("use pi native TUI + don't reinvent the wheel"). The recursion view is now
> provided by the **`rlmx-acp` adapter** (ACP → existing web client) + **pi's native TUI**. This wish
> now delivers only the pi-ai bump + the event instrumentation that both those consumers subscribe to.

## Summary

Make rlmx's recursive multi-agent execution **observable**. Bump pi-ai `0.77.0`→latest (Models
runtime), then **instrument the recursion path to emit a real event stream** (today `RecurseEvent`
has no producer and `rlmLoop` never touches the emitter). The event stream is the shared substrate
consumed downstream by the `rlmx-acp` adapter (web client) and pi's native TUI — this wish builds
the substrate, not a renderer. The pi-ai bump also unblocks `extract-200-percent`'s `station`
provider, so this lands first.

## Scope

### IN

- **pi-ai bump → Models runtime**: move the two runtime imports (`completeSimple`, `getModel`) off
  the root — 0.80.0 relocated them to `/compat` — by migrating `src/llm.ts:8` and
  `src/sdk/rlm-driver.ts:62-65` to `builtinModels()`/`createModels()`. All `import type` unchanged.
- **Recursion instrumentation**: add the `RecurseEvent` producer at the `rlmQuery` spawn site; wire
  `rlm.ts::rlmLoop` to a `createEmitter()` bus; bridge child-process outcomes to the parent stream.
- **Adoptions**: `uuidv7()` (replace `randomUUID()` at `llm.ts:478`), `contentText()`, and surface
  `Usage.reasoning`/`AssistantMessage.responseModel` into metrics.
- **Headless subscriber** (`scripts/watch-headless.mjs`) — the reference consumer that proves the
  stream and is the terminal validation gate (no renderer in this wish).

### OUT

- **Any renderer / TUI / web UI** — the custom pi-tui view is dropped; viewing is the `rlmx-acp`
  adapter's + pi native TUI's job. This wish ships events, not pixels. Don't reinvent the wheel.
- **Level-2 child-internal live streaming** (child's own iterations animated live via `src/ipc.ts`) — enhancement.
- **Rewriting the recursion mechanism** — instrument the child-process model, don't replace it.
- **The `station` provider / metric microagents** — that's `extract-200-percent`.
- **Replacing `rlmLoop` with `runAgent`** — instrument the existing loop in place.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Bump via **Models runtime** migration, not `/compat` band-aid | `/compat` is slated for removal; Models exposes `createProvider` the sibling wish needs. |
| 2 | **Instrument the recursion path** (RecurseEvent producer + rlmLoop→emitter) is the whole deliverable | The event types exist but have no producers; consumers can't render what isn't emitted. |
| 3 | Child nodes carry **final** usage via `onChildEnd`/`RlmChildResult.usage`; parent iterations via `IterationOutputEvent.metrics` | Children run in separate processes; two distinct channels. |
| 4 | Event ancestry keys on **`correlationId`/`RLMX_PARENT_RUN_ID`**, not `depth` | Depth can't disambiguate sibling branches; downstream consumers build the tree from this. |
| 5 | **No renderer in this wish** — a headless subscriber is the consumer proof | Viewing is `rlmx-acp` + pi native TUI; don't reinvent the wheel (user decision). |

## Dependencies

**depends-on:** none
**blocks:** extract-200-percent, rlmx-acp-adapter

## Success Criteria

- [ ] pi-ai pin is latest; `npm run check` + `npm run build` + `npm test` pass; a **recursive `rlmx` run still completes** (regression).
- [ ] A real recursive run **emits `RecurseEvent`** and drives the emitter — the **headless subscriber** logs one node per spawn.
- [ ] Event ancestry is correct across sibling branches — the subscriber reconstructs the tree by `correlationId` (not depth), with per-node tokens/cost/latency/toolCalls (parent from `IterationOutputEvent.metrics`, child from bridged `RlmChildResult.usage`).
- [ ] `uuidv7` ancestry IDs in use; `contentText` adopted; `responseModel`/`reasoning` present on the emitted events.
- [ ] `npm test` incl. `tests/sdk-events.test.ts` (event-contract gate) passes with the new producer.
- [ ] Docs: the event schema + how a consumer subscribes; note `rlmx-acp` + pi native TUI as the renderers.

## Execution Strategy

### Wave 1 (sequential) — pi-ai bump, independent and unblocking

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 3 (multi-site provider/auth migration +2, no deterministic test +1) | engineer-standard / high | pi-ai → Models runtime; migrate the 2 imports; adopt contentText/responseModel/reasoning |

### Wave 2 (sequential) — instrumentation, gated by the headless subscriber

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 2 | engineer | 6 (stateful hot-path +2, agent-lifecycle/recursion +2, no deterministic test +1, prior-effort alignment +1) | engineer-complex / high | RecurseEvent producer + rlmLoop→emitter + child-result bridge + uuidv7 + headless subscriber |

## Execution Groups

### Group 1: pi-ai bump → Models runtime

**Goal:** rlmx runs on latest pi-ai via the durable Models API, with `createProvider` available.

**Deliverables:**
1. Bump `@earendil-works/pi-ai` to latest in `package.json`; `npm ci`.
2. Migrate `src/llm.ts:8` and `src/sdk/rlm-driver.ts:62-65` from root `completeSimple`/`getModel`
   to `builtinModels()`/`createModels()` (types unchanged).
3. Adopt `contentText()` for message-text joins; surface `Usage.reasoning`/`AssistantMessage.responseModel` in `UsageStats`/metrics.

**Acceptance Criteria:**
- [ ] `npm run check` (`tsc --noEmit`), `npm run build`, and **`npm test`** all pass (incl.
      `tests/sdk-events.test.ts`, the event-contract gate).
- [ ] A recursive `rlmx` query completes end-to-end (no behavior regression).

**Validation:**
```bash
cd ~/prod/rlmx && npm ci && npm run check && npm run build && npm test
```

**depends-on:** none

---

### Group 2: recursion instrumentation (emit the events)

**Goal:** a real recursive run emits an observable event stream over `createEmitter()`, proven headlessly.

**Deliverables:**
1. A **`RecurseEvent` producer** at the `llm.ts::rlmQuery` spawn site (currently zero producers).
2. Wire `rlm.ts::rlmLoop` to a `createEmitter()` bus so the parent's own iterations
   (`IterationStart/Output`, `ToolCallBefore/After`, `Session*`) are emitted live. **Expose the seam
   as opts injection** — `rlmLoop(query, context, config, { emitter })` accepts a caller-created
   emitter (so a caller can subscribe *before* the run); the headless subscriber and the `rlmx-acp`
   adapter both consume this exact signature. Default to an internal emitter when none is passed.
3. **Child-result bridge:** on `onChildEnd`, emit a child-completion event carrying `RlmChildResult.usage`
   plus `isError`/`durationMs` from the callback wrapper; tag events with `correlationId`/`RLMX_PARENT_RUN_ID`.
4. Replace `randomUUID()` (`llm.ts:478`) with `uuidv7()` for sortable ancestry IDs.
5. A **headless subscriber** (`scripts/watch-headless.mjs`) that logs the event stream, **one compact
   JSON line per event** (so the `type` field is greppable), and can reconstruct the tree by `correlationId`.

**Acceptance Criteria:**
- [ ] Reusing the existing `events.ts` types/`makeEvent` (no schema fork), a ≥2-level recursive run
      emits one `RecurseEvent` per spawn; **`npm test` (incl. `sdk-events.test.ts`) still passes**.
- [ ] The headless subscriber prints a node per spawn and reconstructs correct `correlationId` ancestry across sibling branches.
- [ ] Group 1's recursive-run regression still passes (control flow unchanged; emits are additive).

**Validation:**
```bash
cd ~/prod/rlmx && npm run build && npm test && \
node scripts/watch-headless.mjs -- '<a-recursive-prompt>' | grep -c '"type":"Recurse"'
```

**depends-on:** 1

---

## QA Criteria

_What must be verified on dev after merge._

- [ ] Functional: the headless subscriber shows a correct event stream for a real recursive run.
- [ ] Integration: pi-ai bump + instrumentation compose; a normal `rlmx` run is unchanged; the stream is subscribable by an external consumer (proves the `rlmx-acp` seam).
- [ ] Regression: existing rlmx CLI subcommands, CAG mode, and Langfuse spans still work.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Instrumentation touches the hot recursion path (`rlm.ts`/`llm.ts`) | High | Emits are synchronous/in-memory and additive; gate each step with the Group 1 recursive-run regression; never change control flow. |
| Cross-wish: `extract-200-percent` Group 1 needs 0.80's `createProvider` | High | This wish's Group 1 lands the bump first; `blocks: extract-200-percent`. |
| Completes the dormant SDK-events effort ("Wish B" per `emitter.ts`) — schema could diverge | Medium | Reuse `events.ts` types/`makeEvent` verbatim; only add the missing producer + wiring. |
| Child nodes carry only final usage (internal iterations run in the child process) | Medium | Bridge `onChildEnd`/`RlmChildResult.usage`; Level 2 (live child-internal via IPC) documented as next. |
| `IterationOutputEvent.metrics`/`costUsd`/`tokens` are optional (MetricsRecorder-gated) | Medium | Wire the recorder on the recursion path; criteria assert metrics populated. |
| Downstream consumers (`rlmx-acp`, pi TUI) not built here — risk of an unexercised event schema | Medium | The headless subscriber exercises the full schema (tree reconstruction) as the acceptance gate. |

---

## Review Results

### Plan review — 2026-07-20 — **SHIP** → Status APPROVED (superseded by amendment)

- **Reviewer:** reviewer (independent plan gate, Opus 4.8). SHIP after one FIX-FIRST round (pi-tui
  dependency + `npm test` gate + polish). Design provenance: design review BLOCKED the original
  "TUI is a free rendering layer" thesis → rewritten so instrumentation is the load-bearing scope → SHIP.

### Scope amendment — 2026-07-20 — Group 3 removed, **re-review pending**

- **Change:** dropped the custom pi-tui recursion view (former Group 3) and its `@earendil-works/pi-tui`
  dependency per user decision ("use pi native TUI + don't reinvent the wheel"). Viewing moves to the
  `rlmx-acp` adapter (web client) + pi native TUI. Wish now = bump + instrumentation only; the headless
  subscriber becomes the terminal acceptance gate. `blocks` now includes `rlmx-acp-adapter`. Appetite
  reduced large→medium.
- **Re-review — 2026-07-20 — SHIP → Status re-APPROVED.** Independent reviewer confirmed the reduction
  is a clean, coherent, executable scope cut: Groups 1-2 unchanged from their approved form; Group 2
  re-anchored on the headless subscriber (tree reconstruction by `correlationId`); pi-tui/`src/tui`
  fully removed (no dangling refs); `blocks` edges correct; validation realistic. Non-blocking nit:
  DESIGN.md still lists the TUI (left as-is — it's digest-stamped; editing invalidates its review
  evidence, and "wish narrows below design" is legitimate).
- **Coordination clarification — 2026-07-20.** During `rlmx-acp-adapter` plan review, the emitter seam
  was pinned to **opts injection** (`rlmLoop(..., { emitter })`) in both wishes (was "opts or returned
  stream"). Group 2 deliverable #2 now specifies this caller-facing signature so the ACP adapter and the
  headless subscriber consume the same API. Implementation-detail narrowing within the approved scope; no re-review needed.

_Execution and PR review evidence appended below as they occur._

---

## Files to Create/Modify

```
~/prod/rlmx/package.json                 (pi-ai bump to latest)
~/prod/rlmx/src/llm.ts                    (Models migration; uuidv7; RecurseEvent emit at rlmQuery; child-end bridge)
~/prod/rlmx/src/sdk/rlm-driver.ts         (Models migration)
~/prod/rlmx/src/rlm.ts                    (rlmLoop → createEmitter wiring)
~/prod/rlmx/src/sdk/events.ts             (reuse types; add RecurseEvent producer helper if needed — no schema fork)
~/prod/rlmx/scripts/watch-headless.mjs    (new: headless event subscriber — the consumer proof / acceptance gate)
~/prod/rlmx/README.md                     (event schema + how a consumer subscribes; rlmx-acp + pi TUI as renderers)
```
