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

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents, splitModel, toToolName } from "../src/mcp/agents.js";

const MCP_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

function writeAgent(
  root: string,
  name: string,
  yamlBody: string,
  system?: string
): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.yaml"), yamlBody, "utf-8");
  if (system !== undefined) {
    writeFileSync(join(dir, "SYSTEM.md"), system, "utf-8");
  }
}

describe("toToolName", () => {
  it("produces MCP-legal names for hostile directory names", () => {
    const hostile = [
      "test writer",
      "Triage/Agent",
      "brain.l1-triage",
      "über-agent",
      "___",
      "a".repeat(200),
    ];

    for (const name of hostile) {
      const tool = toToolName(name);
      assert.match(
        tool,
        MCP_TOOL_NAME,
        `${JSON.stringify(name)} produced illegal tool name ${JSON.stringify(tool)}`
      );
      assert.ok(tool.startsWith("rlmx_"), `${tool} lost its prefix`);
    }
  });

  it("never collapses to a bare prefix", () => {
    // "___" sanitizes to empty; it must still yield a usable tool name.
    assert.equal(toToolName("___"), "rlmx_agent");
  });
});

describe("splitModel", () => {
  it("splits provider/model on the first slash", () => {
    assert.deepEqual(splitModel("station/Brain-35B"), {
      provider: "station",
      model: "Brain-35B",
    });
    // Model ids may themselves contain slashes.
    assert.deepEqual(splitModel("openai/org/model-v1"), {
      provider: "openai",
      model: "org/model-v1",
    });
  });

  it("returns null when there is no usable provider prefix", () => {
    for (const bad of ["gemini-2.5-flash", "/leading", "trailing/", ""]) {
      assert.equal(splitModel(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe("discoverAgents", () => {
  let tmp: string;
  let globalRoot: string;
  let projectRoot: string;
  const prevEnv = process.env.RLMX_AGENTS_DIR;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "rlmx-mcp-agents-"));
    globalRoot = join(tmp, "global");
    projectRoot = join(tmp, "project");
    mkdirSync(globalRoot, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });

    // Same name in both roots — project must win.
    writeAgent(
      globalRoot,
      "triage",
      "schema_version: 1\nshape: single-step\nmodel: google/gemini-2.5-flash\n",
      "Global triage agent.\n"
    );
    writeAgent(
      projectRoot,
      "triage",
      "schema_version: 1\nshape: loop\nmodel: station/Brain-35B\nsystem: SYSTEM.md\n",
      "# triage\n\nProject triage agent that classifies inbound issues.\n"
    );

    writeAgent(
      projectRoot,
      "test writer",
      "schema_version: 1\nshape: recurse\ndescription: Writes unit tests for a module.\n"
    );

    // Malformed YAML must not abort discovery of its siblings.
    const brokenDir = join(projectRoot, "broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "agent.yaml"), "shape: [unclosed\n", "utf-8");

    // A directory with no agent.yaml at all is simply not an agent.
    mkdirSync(join(projectRoot, "not-an-agent"), { recursive: true });

    process.env.RLMX_AGENTS_DIR = `${globalRoot}:${projectRoot}`;
  });

  after(() => {
    if (prevEnv === undefined) delete process.env.RLMX_AGENTS_DIR;
    else process.env.RLMX_AGENTS_DIR = prevEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("skips broken and non-agent directories without failing", async () => {
    const agents = await discoverAgents(tmp);
    const names = agents.map((a) => a.name);
    assert.ok(!names.includes("broken"), "broken agent.yaml should be skipped");
    assert.ok(!names.includes("not-an-agent"), "dir without agent.yaml is not an agent");
    assert.deepEqual(names, ["test writer", "triage"], "expected stable sorted order");
  });

  it("lets a project agent shadow a global agent of the same name", async () => {
    const agents = await discoverAgents(tmp);
    const triage = agents.find((a) => a.name === "triage");
    assert.ok(triage, "triage agent missing");
    assert.equal(triage.spec.model, "station/Brain-35B", "project agent should win");
    assert.equal(triage.spec.shape, "loop");
  });

  it("gives every agent a legal tool name and a non-empty description", async () => {
    const agents = await discoverAgents(tmp);
    assert.ok(agents.length > 0);

    for (const agent of agents) {
      assert.match(agent.toolName, MCP_TOOL_NAME, `${agent.name} -> ${agent.toolName}`);
      assert.ok(
        agent.summary.trim().length > 0,
        `${agent.name} has an empty summary and would be invisible to the host model`
      );
    }

    const tools = agents.map((a) => a.toolName);
    assert.equal(new Set(tools).size, tools.length, "tool names must be unique");
  });

  it("prefers an explicit description over the system prompt", async () => {
    const agents = await discoverAgents(tmp);
    const writer = agents.find((a) => a.name === "test writer");
    assert.ok(writer);
    assert.equal(writer.summary, "Writes unit tests for a module.");
    assert.equal(writer.toolName, "rlmx_test_writer");
  });

  it("falls back to the system prompt, skipping a heading that repeats the name", async () => {
    const agents = await discoverAgents(tmp);
    const triage = agents.find((a) => a.name === "triage");
    assert.ok(triage);
    assert.equal(
      triage.summary,
      "Project triage agent that classifies inbound issues."
    );
  });
});
