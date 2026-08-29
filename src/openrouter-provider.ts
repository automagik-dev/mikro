/**
 * Forward-compatible OpenRouter model descriptors.
 *
 * pi-ai's generated catalog is necessarily a snapshot, while OpenRouter model
 * ids and aliases move continuously. A valid `openrouter/<vendor>/<model>` ref
 * must not become unusable merely because the transport library has not cut a
 * release yet. We keep pi-ai's descriptor when it knows the id and synthesize
 * the same OpenAI-compatible transport contract when it does not.
 */

import type { Model, MutableModels } from "@earendil-works/pi-ai";

export const OPENROUTER_PROVIDER_ID = "openrouter";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

type OpenRouterModel = Model<"openai-completions">;

interface KnownModel {
  name: string;
  input: ("text" | "image")[];
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  contextWindow: number;
  maxTokens: number;
}

/** Prices are dollars per million tokens, matching pi-ai's Model contract. */
const KNOWN_MODELS: Readonly<Record<string, KnownModel>> = {
  "~deepseek/deepseek-v4-flash-latest": {
    name: "DeepSeek V4 Flash (latest alias)",
    input: ["text"],
    inputCost: 0.03,
    outputCost: 0.1,
    cacheReadCost: 0.007,
    contextWindow: 1_310_720,
    maxTokens: 131_072,
  },
  "deepseek/deepseek-v4-flash-0731": {
    name: "DeepSeek V4 Flash 0731",
    input: ["text"],
    inputCost: 0.045,
    outputCost: 0.09,
    cacheReadCost: 0.009,
    contextWindow: 1_310_720,
    maxTokens: 131_072,
  },
  "qwen/qwen3.7-flash": {
    name: "Qwen 3.7 Flash",
    input: ["text", "image"],
    inputCost: 0.03,
    outputCost: 0.13,
    cacheReadCost: 0.006,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  "z-ai/glm-5.3-flash": {
    name: "Z.AI GLM 5.3 Flash",
    input: ["text", "image"],
    inputCost: 0.075,
    outputCost: 0.25,
    cacheReadCost: 0.015,
    contextWindow: 1_310_720,
    maxTokens: 131_072,
  },
  "xiaomi/mimo-v2.5": {
    name: "Xiaomi MiMo v2.5",
    input: ["text", "image"],
    inputCost: 0.14,
    outputCost: 0.28,
    cacheReadCost: 0.0028,
    contextWindow: 1_050_000,
    maxTokens: 131_072,
  },
};

export function synthesizeOpenRouterModel(modelId: string): OpenRouterModel {
  const known = KNOWN_MODELS[modelId];
  return {
    id: modelId,
    name: known?.name ?? modelId,
    api: "openai-completions",
    provider: OPENROUTER_PROVIDER_ID,
    baseUrl: OPENROUTER_BASE_URL,
    reasoning: true,
    input: known?.input ?? ["text"],
    cost: {
      input: known?.inputCost ?? 0,
      output: known?.outputCost ?? 0,
      cacheRead: known?.cacheReadCost ?? 0,
      cacheWrite: 0,
    },
    contextWindow: known?.contextWindow ?? 128_000,
    maxTokens: known?.maxTokens ?? 16_384,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "openrouter",
    },
  };
}

/** Prefer pi-ai's richer catalog entry; synthesize only for catalog misses. */
export function resolveOpenRouterModel(
  models: MutableModels,
  modelId: string,
): OpenRouterModel {
  return (
    (models.getModel(OPENROUTER_PROVIDER_ID, modelId) as
      | OpenRouterModel
      | undefined) ?? synthesizeOpenRouterModel(modelId)
  );
}
