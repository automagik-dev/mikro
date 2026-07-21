/**
 * "station" provider — runs any agent against the local Lemonade gateway
 * (OpenAI-compatible) as a first-class pi-ai provider.
 *
 * Registered at BOTH model-resolution sites (src/llm.ts and
 * src/sdk/rlm-driver.ts) via {@link registerStationProvider} so `station/<id>`
 * resolves identically on the CLI and SDK paths — no copy-paste duplication.
 *
 * Gateway paths are `/api/v1/models` and `/api/v1/chat/completions`
 * (the base URL therefore ends in `/api/v1`, NOT `/v1`).
 *
 * Compat intel (live QA, 2026-07-20, this machine):
 *   - FastFlowLM / NPU models (recipe "flm") stream real `content` with a
 *     minimal entry — no thinking format needed.
 *   - llama.cpp GGUF Qwen MTP models emit `preserve_thinking` reasoning. In
 *     STREAMING mode the 35B (Qwen3.6-35B-A3B-MTP-GGUF) dumps everything into
 *     `reasoning_content` and never emits a `content` delta within a normal
 *     token budget, so it parses as EMPTY. Setting `reasoning: true` +
 *     `thinkingFormat: "qwen-chat-template"` makes pi-ai send
 *     `chat_template_kwargs.enable_thinking = false` (because no reasoning
 *     effort is requested by default), which forces the model to answer
 *     directly. Verified: all three baseline models return non-empty content.
 */

import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ApiKeyAuth, Model, MutableModels, Provider } from "@earendil-works/pi-ai";

/** Provider id used everywhere: `station/<model>`. */
export const STATION_PROVIDER_ID = "station";

/**
 * Base URL of the local Lemonade gateway. The real endpoints are
 * `/api/v1/models` and `/api/v1/chat/completions`. Override with
 * `STATION_BASE_URL` (or the legacy `LEMONADE_BASE_URL`) for a non-default
 * host/port.
 */
export const STATION_BASE_URL =
  process.env.STATION_BASE_URL ??
  process.env.LEMONADE_BASE_URL ??
  "http://localhost:13305/api/v1";

/**
 * Keyless auth for a local server. pi-ai's `ProviderAuth` contract requires an
 * `apiKey` auth even for keyless local servers — its `resolve()` reports
 * whether the provider is configured. We always report configured with a
 * placeholder key (the gateway ignores Authorization on localhost).
 */
const keylessAuth: ApiKeyAuth = {
  name: "Lemonade (local, keyless)",
  resolve: async () => ({
    auth: { apiKey: "local" },
    source: "local keyless server",
  }),
};

type StationModel = Model<"openai-completions">;

/**
 * How a gateway model should be driven. `flm` (FastFlowLM / NPU) answers
 * directly with a minimal entry; `qwen-gguf` (llama.cpp Qwen MTP) needs the
 * `qwen-chat-template` thinking format so streaming produces `content` instead
 * of an unterminated `reasoning_content` block.
 */
type StationEngine = "flm" | "qwen-gguf";

function stationModel(
  id: string,
  name: string,
  engine: StationEngine,
  contextWindow: number,
): StationModel {
  const base = {
    id,
    name,
    api: "openai-completions" as const,
    provider: STATION_PROVIDER_ID,
    baseUrl: STATION_BASE_URL,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 8192,
  };
  if (engine === "qwen-gguf") {
    return {
      ...base,
      reasoning: true,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        // Sends chat_template_kwargs.{enable_thinking,preserve_thinking};
        // enable_thinking stays false unless a reasoning effort is requested,
        // which forces direct content instead of an endless reasoning_content
        // stream (fixes the 35B "empty content" case).
        thinkingFormat: "qwen-chat-template",
      },
    };
  }
  // FastFlowLM / NPU: minimal, no thinking format.
  return {
    ...base,
    reasoning: false,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  };
}

/**
 * Static baseline models. The NPU gate model plus the two GGUF baselines the
 * wish requires. Dynamic discovery (see `fetchModels`) adds any further
 * chat-capable models the gateway advertises.
 */
export const STATION_BASELINE_MODELS: readonly StationModel[] = [
  stationModel("qwen3.5-2b-FLM", "Qwen3.5 2B (NPU / FastFlowLM)", "flm", 32768),
  stationModel(
    "Qwen3.6-35B-A3B-MTP-GGUF",
    "Qwen3.6 35B A3B MTP (iGPU / llama.cpp)",
    "qwen-gguf",
    32768,
  ),
  stationModel(
    "Qwen3.5-4B-MTP-GGUF",
    "Qwen3.5 4B MTP (Vulkan / llama.cpp)",
    "qwen-gguf",
    32768,
  ),
];

/** Model ids/recipes the gateway exposes but that are not chat completions. */
const NON_CHAT_LABELS = new Set([
  "embeddings",
  "reranking",
  "transcription",
  "realtime-transcription",
  "tts",
  "image",
  "edit",
]);

interface GatewayModel {
  id: string;
  recipe?: string;
  labels?: string[];
  checkpoint?: string;
  max_context_window?: number;
}

/**
 * Best-effort dynamic overlay: discover chat-capable models from the gateway's
 * `/models`. Never throws — resolution must not depend on network. Known
 * baseline ids re-emit their tuned compat (so the overlay never regresses the
 * 35B); unknown models are classified by recipe (`flm` → NPU-minimal, anything
 * else Qwen → `qwen-chat-template`).
 */
async function fetchStationModels(): Promise<readonly StationModel[]> {
  try {
    const res = await fetch(`${STATION_BASE_URL}/models`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return STATION_BASELINE_MODELS;
    const body = (await res.json()) as { data?: GatewayModel[] };
    const baselineIds = new Set(STATION_BASELINE_MODELS.map((m) => m.id));
    const discovered: StationModel[] = [];
    for (const gm of body.data ?? []) {
      if (!gm.id || baselineIds.has(gm.id)) continue;
      const labels = gm.labels ?? [];
      if (labels.some((l) => NON_CHAT_LABELS.has(l))) continue;
      const recipe = (gm.recipe ?? "").toLowerCase();
      // Only image/audio/embedding recipes are excluded; keep chat recipes.
      if (
        recipe.startsWith("sd-") ||
        recipe.startsWith("whisper") ||
        recipe.startsWith("kokoro") ||
        recipe.startsWith("collection")
      ) {
        continue;
      }
      const isFlm = recipe === "flm";
      const isQwen = /qwen/i.test(gm.id) || /qwen/i.test(gm.checkpoint ?? "");
      const engine: StationEngine = isFlm ? "flm" : isQwen ? "qwen-gguf" : "flm";
      const ctx = gm.max_context_window
        ? Math.min(gm.max_context_window, 32768)
        : 32768;
      discovered.push(stationModel(gm.id, gm.id, engine, ctx));
    }
    return [...STATION_BASELINE_MODELS, ...discovered];
  } catch {
    return STATION_BASELINE_MODELS;
  }
}

/** Build the station provider (pi-ai `createProvider`). */
export function stationProvider(): Provider<"openai-completions"> {
  return createProvider<"openai-completions">({
    id: STATION_PROVIDER_ID,
    name: "Station (local Lemonade gateway)",
    baseUrl: STATION_BASE_URL,
    auth: { apiKey: keylessAuth },
    models: STATION_BASELINE_MODELS,
    fetchModels: fetchStationModels,
    api: openAICompletionsApi(),
  });
}

/**
 * Register the station provider on a pi-ai `Models` runtime. Call once per
 * runtime, right after `builtinModels()`, at every resolution site.
 */
export function registerStationProvider(models: MutableModels): void {
  models.setProvider(stationProvider());
}
