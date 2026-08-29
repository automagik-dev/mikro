# Prime 0.8.1 A/B decision — 2026-08-29

## Decision

Use Prime Agent 0.8.1 as the primary execution lane for new compatible,
text-only microagents. Keep the legacy RLΜX engine available in the same MCP
server as the compatibility lane. Do not issue automatic shadow calls: they
double cost and create racing answers without improving the host contract.

Model policy for the tested cheap OpenRouter set:

1. `openrouter/~deepseek/deepseek-v4-flash-latest` — default text worker.
2. `openrouter/z-ai/glm-5.3-flash` — alternate reviewer/persona and fallback.
3. Gemini — reserve for tasks that actually require its multimodal input.
4. Qwen 3.7 Flash and MiMo 2.5 — configured model references remain valid,
   but the benchmark account returned “no endpoints matching account policy”;
   do not select them until an account-policy probe passes.

## Fair same-model result

The fixture required five exact markers from three attached files. Both engines
received the same provider/model, context, prompt recipe, iteration ceiling,
token ceiling, and cost ceiling.

| Model | Engine | Exact score | Wall | Cost | Outcome |
|---|---:|---:|---:|---:|---|
| DeepSeek V4 Flash | legacy RLΜX | 0/5 | 60.1s | $0.000301 | exhausted 8 iterations with an empty final answer |
| DeepSeek V4 Flash | Prime | 5/5 | 5.7s | $0.000139 | exact answer in 2 turns |
| GLM 5.3 Flash | legacy RLΜX | 0/5 | <1s | $0 | three empty provider responses |
| GLM 5.3 Flash | Prime | 5/5 | 13–15s | ~$0.0081 | exact answer |

## Repeated finalist result

Each finalist ran three prompt recipes (`neutral`, `legacy_native`, and
`prime_native`) three times through Prime: nine runs per model.

| Model | Exact | Median | P95 | Mean successful cost | Notable tail |
|---|---:|---:|---:|---:|---|
| DeepSeek V4 Flash | 8/9 | 6.7s | 300.1s | $0.000260 | one 300s 0/5 timeout outlier |
| GLM 5.3 Flash | 8/9 | 11.3s | 124.8s | $0.004303 | one provider PII-redaction block |

The equal 8/9 exact rate makes cost and median latency the deciding metrics:
DeepSeek was about 16.5× cheaper and 1.7× faster at the median. GLM remains
useful as a genuinely different second opinion rather than a hidden duplicate.

## Compatibility boundary

Prime stays opt-in per `agent.yaml` (`backend: prime`). Agents remain on
`backend: rlmx` when they need custom RLΜX REPL tools, station providers,
structured output schemas, recursive-depth enforcement, dictionary context,
or Gemini-specific request features. The adapter rejects these cases before
spawn, preserving behavior instead of degrading silently.

## Verification

- Prime stable manifest resolved to 0.8.1 on 2026-08-29; the adapter pins that
  exact version.
- Full hermetic RLΜX suite: 605 passed, 0 failed.
- TypeScript check and build: passed.
- `npm audit --omit=dev`: 0 vulnerabilities.
- MCP dogfood: two bare `rlmx mcp` processes launched from different working
  directories exposed only their own workspace agents; live create/delete
  refresh and tool isolation passed.
