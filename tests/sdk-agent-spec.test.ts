import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { THINKING_LEVELS } from "../src/gemini.js";
import { loadAgentSpec, parseAgentSpec } from "../src/sdk/index.js";

describe("parseAgentSpec — agent.yaml parser (G3a)", () => {
	const DIR = "/tmp/fake-agent";

	it("parses the minimal wish-A shape (triage example)", () => {
		const text = `
schema_version: 1
tools_api: 1
shape: single-step
model: gemini-3.1-flash-lite-preview
tools:
  - read
  - emit_done
scope:
  reads:
    - Conversas/*
budget:
  max_cost: 0.01
  max_iterations: 5
`;
		const spec = parseAgentSpec(text, DIR);
		assert.equal(spec.dir, DIR);
		assert.equal(spec.schemaVersion, 1);
		assert.equal(spec.toolsApi, 1);
		assert.equal(spec.shape, "single-step");
		assert.equal(spec.model, "gemini-3.1-flash-lite-preview");
		assert.deepEqual([...spec.tools], ["read", "emit_done"]);
		assert.deepEqual([...(spec.scope?.reads ?? [])], ["Conversas/*"]);
		assert.equal(spec.budget?.maxCost, 0.01);
		assert.equal(spec.budget?.maxIterations, 5);
	});

	it("defaults schema_version / tools_api / shape when absent", () => {
		const text = `model: gemini-2.5-flash\n`;
		const spec = parseAgentSpec(text, DIR);
		assert.equal(spec.schemaVersion, 1);
		assert.equal(spec.toolsApi, 1);
		assert.equal(spec.shape, "single-step");
	});

	it("rejects invalid shape", () => {
		const text = `shape: multi-step\n`;
		assert.throws(() => parseAgentSpec(text, DIR), /shape must be one of/);
	});

	it("rejects non-mapping YAML", () => {
		assert.throws(
			() => parseAgentSpec("just a string\n", DIR),
			/mapping at the top level/,
		);
		assert.throws(() => parseAgentSpec("- a\n- b\n", DIR), /mapping at the top level/);
	});

	it("ignores empty tool names in the list", () => {
		const text = `tools:\n  - ok\n  - ""\n  - also-ok\n`;
		const spec = parseAgentSpec(text, DIR);
		assert.deepEqual([...spec.tools], ["ok", "also-ok"]);
	});

	it("preserves unrecognised keys in extras", () => {
		const text = `model: x\ncustom_flag: true\nnested:\n  a: 1\n`;
		const spec = parseAgentSpec(text, DIR);
		assert.equal(spec.extras.custom_flag, true);
		assert.deepEqual(spec.extras.nested, { a: 1 });
	});

	it("handles camelCase + snake_case equivalently for schema fields", () => {
		const a = parseAgentSpec(
			"schema_version: 2\ntools_api: 3\n",
			DIR,
		);
		const b = parseAgentSpec(
			"schemaVersion: 2\ntoolsApi: 3\n",
			DIR,
		);
		assert.equal(a.schemaVersion, 2);
		assert.equal(a.toolsApi, 3);
		assert.equal(b.schemaVersion, 2);
		assert.equal(b.toolsApi, 3);
	});

	it("returns undefined scope/budget when the sections are empty", () => {
		const spec = parseAgentSpec("tools: []\n", DIR);
		assert.equal(spec.scope, undefined);
		assert.equal(spec.budget, undefined);
	});
});

/**
 * `thinking:` — per-agent reasoning effort, the agent.yaml twin of
 * `rlmx --thinking`.
 *
 * Validated rather than passed through because a bad level has no safe
 * fallback: pi-ai clamps an unrecognised value to *some* level the model
 * supports instead of rejecting it, so `thinking: hgih` would quietly run at
 * whatever effort that model floors at and look like it worked. The parser runs
 * at discovery time for `rlmx mcp`, so failing here is what surfaces the typo.
 */
describe("parseAgentSpec — thinking:", () => {
	const DIR = "/tmp/fake-agent";

	it("accepts every valid ThinkingLevel", () => {
		for (const level of THINKING_LEVELS) {
			const spec = parseAgentSpec(`thinking: ${level}\n`, DIR);
			assert.equal(spec.thinking, level, `expected ${level} to parse`);
		}
	});

	it("leaves thinking undefined when the key is absent", () => {
		const spec = parseAgentSpec("shape: loop\n", DIR);
		assert.equal(spec.thinking, undefined);
	});

	it("rejects an invalid level and names the allowed set", () => {
		assert.throws(
			() => parseAgentSpec("thinking: hgih\n", DIR),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.match(err.message, /agent\.yaml: thinking must be one of/);
				// The message has to name the alternatives — "invalid" alone leaves
				// the author guessing at the spelling.
				for (const level of THINKING_LEVELS) {
					assert.match(err.message, new RegExp(level));
				}
				assert.match(err.message, /got "hgih"/);
				return true;
			},
		);
	});

	it("rejects levels pi-ai knows but rlmx does not expose", () => {
		// pi-ai's own ThinkingLevel adds "xhigh" and "max", reachable only on
		// models that declare an explicit map entry for them. rlmx's type is
		// narrower, so agent.yaml must not accept them either.
		for (const level of ["xhigh", "max", "off", "none"]) {
			assert.throws(
				() => parseAgentSpec(`thinking: ${level}\n`, DIR),
				/thinking must be one of/,
				`expected "${level}" to be rejected`,
			);
		}
	});

	it("does not leave thinking in the extras bag", () => {
		// Regression guard: before this field existed `thinking:` parsed fine,
		// landed on extras, and was read by nobody — an agent could declare a
		// level and silently not get it.
		const spec = parseAgentSpec("thinking: high\n", DIR);
		assert.equal(spec.extras.thinking, undefined);
		assert.deepEqual(Object.keys(spec.extras), []);
	});

	it("ignores a non-string thinking value rather than throwing", () => {
		// Type drift defaults silently everywhere else in this parser; only a
		// *string* that is not a level is a typo worth rejecting.
		assert.equal(parseAgentSpec("thinking: 3\n", DIR).thinking, undefined);
		assert.equal(parseAgentSpec("thinking: null\n", DIR).thinking, undefined);
	});
});

describe("loadAgentSpec — filesystem wrapper (G3a)", () => {
	let dir = "";
	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "agent-spec-"));
	});
	after(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("reads agent.yaml from the given dir + resolves to absolute", async () => {
		await writeFile(
			join(dir, "agent.yaml"),
			"model: gemini-2.5-flash\ntools: [a, b]\n",
			"utf8",
		);
		const spec = await loadAgentSpec(dir);
		assert.equal(spec.dir, dir);
		assert.equal(spec.model, "gemini-2.5-flash");
		assert.deepEqual([...spec.tools], ["a", "b"]);
	});

	it("throws a useful error when agent.yaml is missing", async () => {
		const missing = join(dir, "no-such-sub");
		await assert.rejects(loadAgentSpec(missing));
	});
});
