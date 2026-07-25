/**
 * `rlmx mcp` — expose rlmx to MCP clients (Claude Code, Codex, …).
 *
 * Why this exists: ACP's *client* is an editor and its *agent* is the AI tool,
 * so `rlmx acp` is an Agent — and Claude Code and Codex are Agents too. Two
 * agents cannot drive each other over ACP. MCP is the protocol those harnesses
 * *do* speak as clients, which makes it the native way to hand rlmx work.
 *
 *   claude mcp add rlmx -- rlmx mcp
 *
 * Every discovered `agent.yaml` microagent becomes its own tool, so the host
 * model sees `rlmx_test_writer` / `rlmx_triage` as distinct capabilities it
 * can delegate to, rather than one opaque escape hatch it has to be told how
 * to use. Each tool runs on whatever model its `agent.yaml` names — a local
 * `station/<model>` or a cheap cloud model — which is how repeatable work gets
 * moved off an expensive host model.
 *
 * Every result carries its own token/cost footer, so the offload is visible in
 * the transcript as it happens instead of having to be taken on faith.
 *
 * stdout discipline: MCP stdio frames JSON-RPC on stdout, so all human/
 * diagnostic logging is redirected to stderr and `rlmLoop` is run with
 * `output: "json"` to keep it off its stream-mode stdout path — the same
 * contract `src/acp/agent.ts` follows.
 */
/**
 * Run the MCP server on stdio until the client disconnects.
 *
 * @param cwd Working directory used for agent discovery, config loading, and
 *            relative `context` arguments.
 */
export declare function runMcp(cwd?: string): Promise<void>;
//# sourceMappingURL=server.d.ts.map