#!/usr/bin/env node
/**
 * smoke-mcp.mjs — end-to-end gate for `rlmx mcp`.
 *
 * Spawns the real server as a subprocess and drives it with the MCP SDK's own
 * client, so this proves genuine protocol compatibility rather than our own
 * framing of it. No mocks, no stubs.
 *
 * Verifies:
 *   1. initialize handshake completes and reports serverInfo.name === "rlmx".
 *   2. tools/list exposes the always-present rlmx_query tool.
 *   3. Each discovered agent.yaml becomes its own tool, with an MCP-legal name,
 *      a non-empty description, and a schema requiring `query`.
 *   4. A call with an empty query fails as a tool error, not a transport error
 *      — one bad call must never take down the server.
 *   5. The server survives that failure and still answers tools/list.
 *
 * With --call it additionally performs one real rlmx_query round-trip, which
 * needs a working provider; without it the gate is credential-free.
 *
 *   node scripts/smoke-mcp.mjs
 *   node scripts/smoke-mcp.mjs --call
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const cli = join(root, "dist", "src", "cli.js");
const doCall = process.argv.includes("--call");

const MCP_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

const log = (msg) => process.stdout.write(`# smoke-mcp: ${msg}\n`);
function assert(cond, msg) {
  if (!cond) {
    process.stdout.write(`\nSMOKE FAIL: ${msg}\n`);
    process.exit(1);
  }
}

// ── Fixture: a project with one microagent ────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), "rlmx-mcp-smoke-"));
const agentsRoot = join(tmp, "agents");
const agentDir = join(agentsRoot, "smoke-echo");
mkdirSync(agentDir, { recursive: true });
writeFileSync(
  join(agentDir, "agent.yaml"),
  "schema_version: 1\nshape: single-step\ndescription: Smoke fixture agent.\n",
  "utf-8"
);

let client;
let exitCode = 0;

try {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp"],
    cwd: tmp,
    env: { ...process.env, RLMX_AGENTS_DIR: agentsRoot },
    stderr: "inherit",
  });

  client = new Client({ name: "smoke-mcp", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const info = client.getServerVersion();
  assert(info?.name === "rlmx", `expected serverInfo.name "rlmx", got ${info?.name}`);
  log(`✓ handshake complete — server ${info.name} ${info.version}`);

  // ── tools/list ──────────────────────────────────────────────────────────
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  log(`✓ tools/list returned ${tools.length}: ${names.join(", ")}`);

  assert(names.includes("rlmx_query"), "rlmx_query must always be present");
  assert(
    names.includes("rlmx_smoke-echo"),
    `discovered agent missing from tools; got ${names.join(", ")}`
  );
  log("✓ agent.yaml became its own tool (rlmx_smoke-echo)");

  for (const tool of tools) {
    assert(MCP_TOOL_NAME.test(tool.name), `illegal MCP tool name: ${tool.name}`);
    assert(
      typeof tool.description === "string" && tool.description.trim().length > 0,
      `tool ${tool.name} has an empty description and would be invisible to the host model`
    );
    assert(
      Array.isArray(tool.inputSchema?.required) &&
        tool.inputSchema.required.includes("query"),
      `tool ${tool.name} must require "query"`
    );
  }
  log("✓ every tool has a legal name, a description, and requires query");

  // ── error path: one bad call must not kill the server ───────────────────
  const bad = await client.callTool({ name: "rlmx_query", arguments: { query: "   " } });
  assert(bad.isError === true, "empty query should return a tool error");
  log(`✓ empty query rejected as a tool error: "${bad.content[0]?.text?.slice(0, 60)}"`);

  const unknown = await client.callTool({ name: "rlmx_nope", arguments: { query: "hi" } });
  assert(unknown.isError === true, "unknown tool should return a tool error");
  log("✓ unknown tool rejected as a tool error");

  const after = await client.listTools();
  assert(after.tools.length === tools.length, "server must survive failed calls");
  log("✓ server still healthy after failed calls");

  // ── optional live round-trip ────────────────────────────────────────────
  if (doCall) {
    log("running a real rlmx_query round-trip (needs a provider)…");
    const res = await client.callTool({
      name: "rlmx_query",
      arguments: { query: "Reply with exactly: ok" },
    });
    assert(!res.isError, `live call failed: ${res.content[0]?.text}`);
    const text = res.content[0]?.text ?? "";
    assert(text.includes("rlmx ·"), "result must carry the cost footer");
    const footer = text.slice(text.lastIndexOf("rlmx ·"));
    log(`✓ live call returned an answer with a cost footer`);
    log(`  ${footer.trim()}`);
  } else {
    log("• skipped live call (pass --call to run one against a real provider)");
  }

  process.stdout.write(
    "\nSMOKE PASS: handshake + tools/list + per-agent tools + error isolation all verified.\n"
  );
} catch (err) {
  process.stdout.write(`\nSMOKE FAIL: ${err?.stack || err}\n`);
  exitCode = 1;
} finally {
  try {
    await client?.close();
  } catch {
    // Closing a already-dead transport is not a failure.
  }
  rmSync(tmp, { recursive: true, force: true });
}

process.exit(exitCode);
