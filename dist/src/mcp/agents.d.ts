/**
 * Microagent discovery for `rlmx mcp`.
 *
 * A "microagent" is an existing `agent.yaml` folder (see
 * `docs/agent-yaml-schema.md`). This module finds them on disk and turns each
 * into a description an MCP client can render as a callable tool, so a host
 * like Claude Code sees `rlmx_test_writer` rather than one opaque escape
 * hatch.
 *
 * Discovery roots, lowest precedence first — a later root wins on name
 * collision, so a project can shadow a global agent:
 *
 *   1. ~/.rlmx/agents/<name>/agent.yaml     (global)
 *   2. <cwd>/.agents/<name>/agent.yaml      (project, the documented convention)
 *   3. <cwd>/.rlmx/agents/<name>/agent.yaml (project)
 *
 * `RLMX_AGENTS_DIR` (colon-separated) replaces the defaults entirely.
 */
import { type AgentSpec } from "../sdk/agent-spec.js";
/** A discovered microagent, ready to be exposed as one MCP tool. */
export interface Microagent {
    /** Directory name on disk — the human identity. */
    readonly name: string;
    /** MCP tool name: `rlmx_<sanitized name>`. */
    readonly toolName: string;
    /** Absolute path to the agent directory. */
    readonly dir: string;
    readonly spec: AgentSpec;
    /** Contents of the agent's system prompt, if `system:` pointed at a file. */
    readonly system?: string;
    /** First non-empty line of the system prompt — used as the tool description. */
    readonly summary: string;
}
/**
 * MCP tool names must match `^[a-zA-Z0-9_-]{1,128}$`. Directory names are
 * looser than that, so fold anything else to `_`.
 */
export declare function toToolName(agentName: string): string;
/** Discovery roots in precedence order (later wins). */
export declare function agentRoots(cwd: string): string[];
/**
 * Scan every root and return the discovered microagents, de-duplicated by
 * agent name with later roots winning.
 */
export declare function discoverAgents(cwd: string): Promise<Microagent[]>;
/**
 * Split an `agent.yaml` model string (`"<provider>/<model>"`) into its parts.
 * Returns null when the string has no provider prefix, in which case the
 * caller should keep the ambient configured provider.
 */
export declare function splitModel(value: string): {
    provider: string;
    model: string;
} | null;
//# sourceMappingURL=agents.d.ts.map