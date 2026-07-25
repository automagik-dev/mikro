/**
 * Microagent discovery gate — `rlmx mcp`.
 *
 * Deterministic, no-LLM proofs for the discovery contract that a live MCP
 * smoke cannot pin down precisely:
 *   1. Tool names are MCP-legal (`^[a-zA-Z0-9_-]{1,128}$`) for hostile
 *      directory names — an illegal name would make the whole tools/list
 *      response invalid, not just that one agent.
 *   2. Root precedence: a project agent shadows a global agent of the same
 *      name, so a repo can override a machine-wide default.
 *   3. A broken agent.yaml is skipped rather than taking down the server.
 *   4. Descriptions are never empty — an empty description makes an agent
 *      effectively invisible to the host model.
 */
export {};
//# sourceMappingURL=mcp-agents.test.d.ts.map