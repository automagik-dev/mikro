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

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadAgentSpec, resolveAgentPath, type AgentSpec } from "../sdk/agent-spec.js";

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
export function toToolName(agentName: string): string {
  const cleaned = agentName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  // `rlmx_` prefix + a non-empty remainder, capped well under the 128 limit.
  return `rlmx_${(cleaned || "agent").slice(0, 96)}`;
}

/** Discovery roots in precedence order (later wins). */
export function agentRoots(cwd: string): string[] {
  const override = process.env.RLMX_AGENTS_DIR?.trim();
  if (override) {
    return override
      .split(":")
      .map((p) => p.trim())
      .filter(Boolean);
  }
  return [
    join(homedir(), ".rlmx", "agents"),
    join(cwd, ".agents"),
    join(cwd, ".rlmx", "agents"),
  ];
}

/**
 * Derive a one-line tool description. Prefers the agent's own
 * `description:` extra, then the first meaningful line of its system prompt,
 * then a generic fallback — an MCP client shows this to the model, so an
 * empty description makes the agent effectively invisible.
 */
function deriveSummary(
  name: string,
  spec: AgentSpec,
  system: string | undefined
): string {
  const described = spec.extras.description;
  if (typeof described === "string" && described.trim()) {
    return described.trim();
  }

  if (system) {
    for (const rawLine of system.split("\n")) {
      const line = rawLine.replace(/^#+\s*/, "").trim();
      // Skip headings that are just the agent's own name, and empty lines.
      if (!line) continue;
      if (line.toLowerCase() === name.toLowerCase()) continue;
      return line.length > 300 ? `${line.slice(0, 297)}...` : line;
    }
  }

  return `rlmx microagent "${name}" (${spec.shape})`;
}

async function loadOne(dir: string, name: string): Promise<Microagent | null> {
  let spec: AgentSpec;
  try {
    spec = await loadAgentSpec(dir);
  } catch {
    // Not an agent folder, or an unreadable/invalid agent.yaml. Skipping is
    // correct here: one broken agent must not take down the whole server.
    return null;
  }

  let system: string | undefined;
  if (spec.systemPath) {
    try {
      system = await readFile(resolveAgentPath(spec, spec.systemPath), "utf-8");
    } catch {
      // A dangling system: pointer is not fatal — the agent still runs with
      // the ambient config's system prompt.
      system = undefined;
    }
  }

  return {
    name,
    toolName: toToolName(name),
    dir,
    spec,
    system,
    summary: deriveSummary(name, spec, system),
  };
}

/**
 * Scan every root and return the discovered microagents, de-duplicated by
 * agent name with later roots winning.
 */
export async function discoverAgents(cwd: string): Promise<Microagent[]> {
  const byName = new Map<string, Microagent>();

  for (const root of agentRoots(cwd)) {
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue; // Root does not exist — normal.
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const agent = await loadOne(join(root, entry.name), entry.name);
      if (agent) byName.set(agent.name, agent);
    }
  }

  // Stable ordering so the tool list does not shuffle between restarts.
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Split an `agent.yaml` model string (`"<provider>/<model>"`) into its parts.
 * Returns null when the string has no provider prefix, in which case the
 * caller should keep the ambient configured provider.
 */
export function splitModel(
  value: string
): { provider: string; model: string } | null {
  const idx = value.indexOf("/");
  if (idx <= 0 || idx === value.length - 1) return null;
  return { provider: value.slice(0, idx), model: value.slice(idx + 1) };
}
