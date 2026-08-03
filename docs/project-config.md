# Project config — `.rlmx/rlmx.yaml`

A project's `.rlmx/` directory is what makes a directory an rlmx project.
`loadConfig(cwd)` reads it and returns an `RlmxConfig`; the CLI, the SDK and the
ACP agent all load it the same way, from the **cwd**.

```
<project>/.rlmx/
├── rlmx.yaml     # this file — model, budgets, tools level, engine
├── SYSTEM.md     # the system prompt → RlmxConfig.system
├── TOOLS.md      # optional custom tools
└── CRITERIA.md   # optional success criteria
```

> **Scope of this page.** This is the reference for the **`loop`** key — the
> engine selector added by the direct-mode work. It is not yet a complete
> `rlmx.yaml` field reference; the other keys are documented at their feature's
> own section in the [README](../README.md). `agent.yaml` is a different file
> for a different thing (microagent folders) — see
> [`agent-yaml-schema.md`](agent-yaml-schema.md).

## `loop` — which engine answers a prompt turn

```yaml
# .rlmx/rlmx.yaml
model:
  provider: station
  model: qwen3.6-moe-35b-a3b-FLM
loop: direct
```

| | |
| --- | --- |
| **Type** | enum — `full` \| `direct` |
| **Default** | `full` (absent key ⇒ byte-identical behavior to before the key existed) |
| **Honored by** | the ACP prompt seam (`rlmx acp`). The CLI always runs the full loop. |
| **Per-process override** | `RLMX_ACP_LOOP` (see below) |

**`full`** — the RLM iteration loop (`rlmLoop`): system scaffold, Python REPL,
`FINAL()` / `FINAL_VAR()` termination, iterating up to the iteration and
wall-clock caps.

**`direct`** — ONE chat completion: the project's `system` **verbatim** plus the
query the caller already built, under a deadline the ACP layer owns. No REPL, no
protocol scaffold, no iteration; the whole answer comes back in one piece.

Direct mode is for models that answer a one-shot question well but cannot drive
the loop's termination protocol. The motivating evidence is in
[`.genie/wishes/acp-station-viability/trace-report.md`](../.genie/wishes/acp-station-viability/trace-report.md);
the practical guidance is in
[`worker-models.md`](worker-models.md#direct-mode-and-the-station-arm).

### Unknown VALUE throws; unknown KEY is tolerated

These are deliberately different, and the asymmetry is the same one
`tools-level`, `cache.retention`, `storage.enabled` and `rtk.enabled` already
follow:

```yaml
loop: sideways        # ✗ throws: Invalid loop "sideways" in rlmx.yaml. Must be one of: full, direct.
not-a-real-key: 42    # ✓ tolerated — parsed and ignored
```

`rlmx.yaml` is a **reviewed, committed** surface, so a typo in a known enum key
is a config error worth failing on rather than silently running the wrong
engine. Unknown *keys* stay tolerated because the parser's raw-YAML interface is
a shape hint, never a whitelist — a project may carry keys a newer or older rlmx
does not know about, and forward/backward compatibility is worth more than
catching a stray key.

The env override takes the opposite stance on a bad value: `RLMX_ACP_LOOP` is an
operator's per-process knob, and an unrecognized value there is **ignored** (the
config's value stands) so a typo in a shell export cannot brick every session of
a long-running agent.

### For TypeScript consumers: `RlmxConfig.loop` is required

`loop` is a **required** field on `RlmxConfig`, not optional:

```ts
import type { RlmxConfig, LoopMode } from "@automagik/rlmx";
import { DEFAULT_LOOP_MODE } from "@automagik/rlmx";
```

A consumer that hand-builds an `RlmxConfig` literal (rather than getting one
from `loadConfig`) must now supply it, or the compiler will reject the object.
The intent is that a config object is either fully loaded or fully declared —
an optional field would let a `undefined` engine reach the prompt seam and get
resolved by an implicit default nobody wrote down. Use `DEFAULT_LOOP_MODE` (the
exported `"full"`) rather than re-typing the literal, so a future default change
reaches you.

Nothing changes for consumers that build their config via `loadConfig()`, which
is the overwhelmingly common path.
