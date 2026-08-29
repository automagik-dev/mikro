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
export declare const OPENROUTER_PROVIDER_ID = "openrouter";
export declare const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
type OpenRouterModel = Model<"openai-completions">;
export declare function synthesizeOpenRouterModel(modelId: string): OpenRouterModel;
/** Prefer pi-ai's richer catalog entry; synthesize only for catalog misses. */
export declare function resolveOpenRouterModel(models: MutableModels, modelId: string): OpenRouterModel;
export {};
//# sourceMappingURL=openrouter-provider.d.ts.map