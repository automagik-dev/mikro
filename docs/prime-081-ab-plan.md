# RLΜX legacy vs Prime 0.8.1 evaluation plan

## Decision being made

Choose the default execution engine independently from the model. Preserve both
engines behind the MCP backend seam so an agent can opt into `rlmx` or `prime`.
Do not confuse the package major version with the engine: RLΜX 0.260817.2 and
1.260817.1 contain the same Prime-backed implementation; the meaningful A/B is
the legacy recursive loop against Prime Agent 0.8.1.

## Fair comparison

`npm run benchmark:prime-ab` runs both engines with the same OpenRouter model,
loaded context snapshot, prompt, cost/token/turn ceilings, and marker-based
scoring. It exercises neutral, legacy-native, and Prime-native prompt recipes so
the result exposes both intrinsic capability and engine/prompt fit. The default
matrix covers DeepSeek V4 Flash Latest, Qwen 3.7 Flash, GLM 5.3 Flash, and MiMo
V2.5 twice per cell. Gemini is deliberately excluded from text-only evaluation.

The benchmark requires `OPENROUTER_API_KEY` and fails closed when it is absent;
it never silently changes provider. Keep raw reports private because model
answers can repeat attached context. Compare completion rate, marker score,
wall time, reported tokens, and transport-reported cost. A model/backend pair is
not eligible as a default if it has an execution error, hidden provider fallback,
or missing cost record.

## Release gates

1. `npm run check`, build, and the complete test suite pass with live-provider
   smoke tests disabled unless their explicit credential is supplied.
2. Prime is exactly 0.8.1; its child receives only the selected provider's
   credentials, telemetry is disabled, and cancellation kills the process tree.
3. Both backends pass the contract suite and a real OpenRouter smoke on the same
   model. Run the full matrix at least twice, then repeat any winner five times.
4. Brain exposes model and backend as independent per-agent overrides, keeps
   unknown price as unknown (never zero), and prefers provider-reported cost.
5. Deploy through a parallel canary without restarting the healthy personal
   service. Promote only after health, persistence, MCP, and microagent probes.

## Initial specialist hypothesis (to validate, not hard-code)

- DeepSeek V4 Flash Latest: general reasoning and coding analyst.
- Qwen 3.7 Flash: visual/UI and video observer.
- GLM 5.3 Flash: long-context architect and independent critic.
- MiMo V2.5: audio/image/video listener-observer.
- Gemini 3.5 Flash Lite: PDF/file and Google-native multimodal fallback only.

All assignments remain configurable. Routing must check actual modality and tool
capabilities and fall back explicitly; no model name is treated as a permanent
persona or silently substituted.
