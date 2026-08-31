import type { ThinkingLevel } from "./gemini.js";
import { type CustomProviderConfig } from "./custom-providers.js";
import { type ValidateSchema } from "./sdk/validate.js";
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
     * model config — not just on `MikroConfig` — so every resolution site that
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
/** Full mikro config */
export interface MikroConfig {
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
     * Providers declared in config (settings.json merged with mikro.yaml; the
     * yaml wins per id). Also mirrored on `model.providers`.
     */
    providers: CustomProviderConfig[];
    /** Config source: "yaml" | "defaults" */
    configSource: "yaml" | "defaults";
    /**
     * The pack's `VALIDATE.md` contract for `emit_done` payloads, or null when
     * the pack ships none. See `ValidateConfig` for why "ships none" and "ships
     * a broken one" are deliberately the same value.
     */
    validate: ValidateConfig | null;
}
/**
 * A pack's `VALIDATE.md`, loaded by convention rather than declared: the file
 * sits next to `mikro.yaml` (project) or next to `agent.yaml` (microagent) and
 * needs no key to switch it on.
 *
 * Only ever constructed when the markdown yielded a schema we could actually
 * parse, so `schema` and `rawBlock` are both non-null here. A missing file and
 * a malformed one collapse to the same `null` on `MikroConfig` on purpose: a
 * contract we could not read must not be enforced as if it were one, and it
 * must not stop the run from loading either. `rawBlock` rides along because
 * the retry hint quotes the schema back at the model verbatim
 * (`buildRetryHint`, src/sdk/validate.ts).
 */
export interface ValidateConfig {
    readonly schema: ValidateSchema;
    readonly rawBlock: string;
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
 * Load a `VALIDATE.md` sitting at `path`, by convention.
 *
 * Three inputs, two answers. No file → null. A file whose fenced block is
 * missing or is not valid JSON → also null, and never a throw: `parseValidateMd`
 * reports both as `schema: null`, and a pack that ships a broken schema has to
 * degrade to "unvalidated" rather than fail to load at all — the alternative is
 * a typo in a markdown file taking the whole agent off the air. Only a block we
 * parsed becomes a `ValidateConfig`.
 *
 * Shared by both load paths (project `.mikro/` and a microagent's own
 * directory) so "what counts as a usable schema" has exactly one definition.
 */
export declare function loadValidateMd(path: string): Promise<ValidateConfig | null>;
/**
 * Providers declared globally in ~/.mikro/settings.json under `"providers"`.
 * Read on every load (the file is small) so a `mikro config` edit takes effect
 * on the next run. A malformed block is an error, not a silent skip — the
 * operator wrote it expecting it to work.
 */
export declare function loadGlobalProviders(): Promise<CustomProviderConfig[]>;
/**
 * Load mikro config from .mikro/ directory:
 *   1. .mikro/mikro.yaml (required for yaml source)
 *   2. .mikro/SYSTEM.md (auto-loaded when present)
 *   3. .mikro/CRITERIA.md (auto-loaded when present)
 *   4. .mikro/TOOLS.md (auto-loaded and parsed when present)
 *   5. .mikro/VALIDATE.md (auto-loaded and parsed when present)
 *   6. Defaults if no .mikro/mikro.yaml
 *
 * The auto-loaded `.md` files belong to the yaml branch only. The defaults
 * branch reads no files at all today, and VALIDATE.md does not change that:
 * a directory with no mikro.yaml is not a pack.
 *
 * Config-declared providers come from ~/.mikro/settings.json (`"providers"`)
 * overlaid by mikro.yaml (`providers:`), in both the yaml and the defaults
 * branch — a project with no mikro.yaml can still run on a globally declared
 * provider.
 */
export declare function loadConfig(dir: string): Promise<MikroConfig>;
/**
 * Check if any config exists in a directory.
 * Checks .mikro/mikro.yaml, then the legacy .rlmx/rlmx.yaml.
 */
export declare function hasConfig(dir: string): Promise<boolean>;
//# sourceMappingURL=config.d.ts.map