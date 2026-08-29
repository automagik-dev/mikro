import type { ThinkingLevel } from "./gemini.js";
import { type CustomProviderConfig } from "./custom-providers.js";
/** Parsed tool: name → Python code */
export interface ToolDef {
    name: string;
    code: string;
}
/** Model configuration */
export interface ModelConfig {
    provider: string;
    model: string;
    subCallModel?: string;
    /**
     * Config-declared providers (see src/custom-providers.ts). Carried on the
     * model config — not just on `RlmxConfig` — so every resolution site that
     * receives a `ModelConfig` (llmComplete, the SDK driver, recursive children)
     * can register them before lookup without threading a second argument
     * through the call graph. `applyModelRef` spreads it forward untouched.
     */
    providers?: CustomProviderConfig[];
}
/** Budget limits (all optional — null means unlimited) */
export interface BudgetConfig {
    maxCost: number | null;
    maxTokens: number | null;
    maxDepth: number | null;
}
/** Cache configuration for CAG mode */
export interface CacheConfig {
    enabled: boolean;
    strategy: "full";
    sessionPrefix?: string;
    retention: "short" | "long";
    ttl?: number;
    expireTime?: string;
}
/** Context loading configuration */
export interface ContextConfig {
    extensions: string[];
    exclude: string[];
}
/** Media resolution configuration per content type */
export interface MediaResolutionConfig {
    images?: string;
    pdfs?: string;
    video?: string;
}
/** Gemini-specific configuration */
export interface GeminiConfig {
    thinkingLevel: ThinkingLevel | null;
    googleSearch: boolean;
    urlContext: boolean;
    codeExecution: boolean;
    mediaResolution: MediaResolutionConfig | null;
    computerUse: boolean;
    mapsGrounding: boolean;
    fileSearch: boolean;
}
/** Structured output schema configuration */
export interface OutputConfig {
    schema: Record<string, unknown> | null;
}
/** Storage configuration for pgserve-backed large context handling */
export interface StorageConfig {
    enabled: "auto" | "always" | "never";
    mode: "persistent" | "memory";
    dataDir: string;
    port: number;
    chunkSize: number | null;
    chunkUtilization: number;
    charsPerToken: number;
}
/** RTK (Rust Token Killer) integration config */
export interface RtkConfig {
    /**
     * auto   — use RTK when `which rtk` succeeds; fall through otherwise.
     * always — require RTK; throw at REPL startup if absent.
     * never  — disable the run_cli auto-prefix entirely.
     */
    enabled: "auto" | "always" | "never";
}
/** Tool level — controls which functions are available in the REPL */
export type ToolsLevel = "core" | "standard" | "full";
/** Full rlmx config */
export interface RlmxConfig {
    system: string | null;
    tools: ToolDef[];
    criteria: string | null;
    model: ModelConfig;
    /** Directory the config was loaded from */
    configDir: string;
    /** Budget limits */
    budget: BudgetConfig;
    /** Context loading settings */
    contextConfig: ContextConfig;
    /** Tool level */
    toolsLevel: ToolsLevel;
    /** Cache configuration for CAG mode */
    cache: CacheConfig;
    /** Gemini-specific configuration */
    gemini: GeminiConfig;
    /** Structured output configuration */
    output: OutputConfig;
    /** Storage configuration for pgserve */
    storage: StorageConfig;
    /** RTK (Rust Token Killer) integration */
    rtk: RtkConfig;
    /**
     * Providers declared in config (settings.json merged with rlmx.yaml; the
     * yaml wins per id). Also mirrored on `model.providers`.
     */
    providers: CustomProviderConfig[];
    /** Config source: "yaml" | "defaults" */
    configSource: "yaml" | "defaults";
}
export declare const DEFAULT_STORAGE_CONFIG: StorageConfig;
export declare const DEFAULT_RTK_CONFIG: RtkConfig;
/**
 * Split a `"<provider>/<model>"` reference into its parts.
 *
 * Returns null when the string carries no usable provider prefix, in which
 * case the caller should keep the ambient configured provider and treat the
 * whole string as a model id.
 */
export declare function parseModelRef(value: string): {
    provider: string;
    model: string;
} | null;
/**
 * Apply a model reference onto a `ModelConfig`, returning a new config.
 *
 * The sub-call model is re-pinned to the referenced model id as well. Without
 * that, a caller that switches provider (an agent's `model:`, or `--model`)
 * keeps the *previous* provider's `sub-call-model`, and the first bare
 * `llm_query()` dies with `Unknown model "<inherited>" for provider "<new>"`.
 */
export declare function applyModelRef(model: ModelConfig, ref: string): ModelConfig;
/**
 * Parse TOOLS.md format:
 *   ## tool_name
 *   ```python
 *   def tool_name(...):
 *       ...
 *   ```
 */
export declare function parseToolsMd(content: string): ToolDef[];
/**
 * Providers declared globally in ~/.rlmx/settings.json under `"providers"`.
 * Read on every load (the file is small) so a `rlmx config` edit takes effect
 * on the next run. A malformed block is an error, not a silent skip — the
 * operator wrote it expecting it to work.
 */
export declare function loadGlobalProviders(): Promise<CustomProviderConfig[]>;
/**
 * Load rlmx config from .rlmx/ directory:
 *   1. .rlmx/rlmx.yaml (required for yaml source)
 *   2. .rlmx/SYSTEM.md (auto-loaded when present)
 *   3. .rlmx/CRITERIA.md (auto-loaded when present)
 *   4. .rlmx/TOOLS.md (auto-loaded and parsed when present)
 *   5. Defaults if no .rlmx/rlmx.yaml
 *
 * Config-declared providers come from ~/.rlmx/settings.json (`"providers"`)
 * overlaid by rlmx.yaml (`providers:`), in both the yaml and the defaults
 * branch — a project with no rlmx.yaml can still run on a globally declared
 * provider.
 */
export declare function loadConfig(dir: string): Promise<RlmxConfig>;
/**
 * Check if any config exists in a directory.
 * Only checks .rlmx/rlmx.yaml.
 */
export declare function hasConfig(dir: string): Promise<boolean>;
//# sourceMappingURL=config.d.ts.map