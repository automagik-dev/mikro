import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyModelRef, loadConfig, parseModelRef, parseToolsMd } from "../src/config.js";

/** Helper: create .mikro/ dir with mikro.yaml content */
async function makeConfig(dir: string, yamlContent: string): Promise<void> {
  const mikroDir = join(dir, ".mikro");
  await mkdir(mikroDir, { recursive: true });
  await writeFile(join(mikroDir, "mikro.yaml"), yamlContent);
}

describe("YAML config loading", () => {
  let dir: string;

  it("loads valid .mikro/mikro.yaml with all fields", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await makeConfig(dir, `model:
  provider: openai
  model: gpt-4
  sub-call-model: gpt-3.5-turbo
tools:
  greet: |
    def greet(name):
        return f"Hello {name}"
context:
  extensions: [.md, .txt]
  exclude: [node_modules, dist]
budget:
  max-cost: 1.5
  max-tokens: 50000
  max-depth: 3
tools-level: standard
`);
    const cfg = await loadConfig(dir);
    assert.equal(cfg.model.provider, "openai");
    assert.equal(cfg.model.model, "gpt-4");
    assert.equal(cfg.model.subCallModel, "gpt-3.5-turbo");
    assert.deepEqual(cfg.contextConfig.extensions, [".md", ".txt"]);
    assert.equal(cfg.budget.maxCost, 1.5);
    assert.equal(cfg.budget.maxTokens, 50000);
    assert.equal(cfg.budget.maxDepth, 3);
    assert.equal(cfg.toolsLevel, "standard");
    assert.equal(cfg.configSource, "yaml");
    await rm(dir, { recursive: true });
  });

  it("auto-loads SYSTEM.md and CRITERIA.md from .mikro/", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await makeConfig(dir, "model:\n  provider: google\n");
    await writeFile(join(dir, ".mikro", "SYSTEM.md"), "You are a helper.");
    await writeFile(join(dir, ".mikro", "CRITERIA.md"), "Be concise.");
    const cfg = await loadConfig(dir);
    assert.equal(cfg.system, "You are a helper.");
    assert.equal(cfg.criteria, "Be concise.");
    assert.equal(cfg.configSource, "yaml");
    await rm(dir, { recursive: true });
  });

  it("auto-loads TOOLS.md from .mikro/", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await makeConfig(dir, "model:\n  provider: google\n");
    await writeFile(join(dir, ".mikro", "TOOLS.md"), "## greet\n```python\ndef greet(name):\n    return f\"Hello {name}\"\n```\n");
    const cfg = await loadConfig(dir);
    assert.equal(cfg.tools.length, 1);
    assert.equal(cfg.tools[0].name, "greet");
    await rm(dir, { recursive: true });
  });

  it("loads minimal .mikro/mikro.yaml with defaults", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await makeConfig(dir, "model:\n  provider: anthropic\n");
    const cfg = await loadConfig(dir);
    assert.equal(cfg.model.provider, "anthropic");
    assert.equal(cfg.toolsLevel, "core");
    assert.equal(cfg.budget.maxCost, null);
    assert.equal(cfg.configSource, "yaml");
    await rm(dir, { recursive: true });
  });

  it("returns defaults when no .mikro/ exists", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    const cfg = await loadConfig(dir);
    assert.equal(cfg.model.provider, "google");
    assert.equal(cfg.configSource, "defaults");
    await rm(dir, { recursive: true });
  });

  it("ignores root mikro.yaml (only .mikro/ is checked)", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await writeFile(join(dir, "mikro.yaml"), "model:\n  provider: openai\n");
    const cfg = await loadConfig(dir);
    // Root mikro.yaml should be ignored — defaults returned
    assert.equal(cfg.model.provider, "google");
    assert.equal(cfg.configSource, "defaults");
    await rm(dir, { recursive: true });
  });

  it("throws on invalid YAML", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await makeConfig(dir, "model: [\ninvalid yaml");
    await assert.rejects(() => loadConfig(dir), /Invalid YAML/);
    await rm(dir, { recursive: true });
  });

  it("rejects invalid tools-level", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await makeConfig(dir, "tools-level: mega\n");
    await assert.rejects(() => loadConfig(dir), /Invalid tools-level/);
    await rm(dir, { recursive: true });
  });

  it("defaults rtk.enabled to auto when mikro.yaml omits it", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await makeConfig(dir, "model:\n  provider: anthropic\n");
    const cfg = await loadConfig(dir);
    assert.equal(cfg.rtk.enabled, "auto");
    await rm(dir, { recursive: true });
  });

  it("accepts rtk.enabled: never", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await makeConfig(dir, "rtk:\n  enabled: never\n");
    const cfg = await loadConfig(dir);
    assert.equal(cfg.rtk.enabled, "never");
    await rm(dir, { recursive: true });
  });

  it("rejects invalid rtk.enabled", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await makeConfig(dir, "rtk:\n  enabled: banana\n");
    await assert.rejects(() => loadConfig(dir), /Invalid rtk\.enabled/);
    await rm(dir, { recursive: true });
  });

  it("default config (no yaml) sets rtk.enabled to auto", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    const cfg = await loadConfig(dir);
    assert.equal(cfg.rtk.enabled, "auto");
    assert.equal(cfg.configSource, "defaults");
    await rm(dir, { recursive: true });
  });

  it("defaults prompt.append-stop-protocol to true when mikro.yaml omits it", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await makeConfig(dir, "model:\n  provider: anthropic\n");
    const cfg = await loadConfig(dir);
    assert.ok(cfg.prompt);
    assert.equal(cfg.prompt.appendStopProtocol, true);
    await rm(dir, { recursive: true });
  });

  it("accepts prompt.append-stop-protocol: false", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await makeConfig(dir, "prompt:\n  append-stop-protocol: false\n");
    const cfg = await loadConfig(dir);
    assert.ok(cfg.prompt);
    assert.equal(cfg.prompt.appendStopProtocol, false);
    await rm(dir, { recursive: true });
  });

  /**
   * A bare `append-stop-protocol:` key parses as YAML null. Null-as-unset is
   * the deliberate convention here — the agent.yaml parser (`parsePrompt` in
   * `src/sdk/agent-spec.ts`) and `rtk.enabled` treat null the same way — so
   * it falls back to the default rather than erroring.
   */
  it("treats a null prompt.append-stop-protocol as unset (default true)", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await makeConfig(dir, "prompt:\n  append-stop-protocol:\n");
    const cfg = await loadConfig(dir);
    assert.ok(cfg.prompt);
    assert.equal(cfg.prompt.appendStopProtocol, true);
    await rm(dir, { recursive: true });
  });

  it("rejects a non-boolean prompt.append-stop-protocol", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    await makeConfig(dir, "prompt:\n  append-stop-protocol: banana\n");
    await assert.rejects(
      () => loadConfig(dir),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(
          err.message,
          /Invalid prompt\.append-stop-protocol in mikro\.yaml: must be true or false, got "banana"\./
        );
        return true;
      }
    );
    await rm(dir, { recursive: true });
  });

  it("default config (no yaml) sets prompt.appendStopProtocol to true", async () => {
    dir = await mkdtemp(join(tmpdir(), "mikro-cfg-"));
    const cfg = await loadConfig(dir);
    assert.ok(cfg.prompt);
    assert.equal(cfg.prompt.appendStopProtocol, true);
    assert.equal(cfg.configSource, "defaults");
    await rm(dir, { recursive: true });
  });
});

describe("parseToolsMd", () => {
  it("extracts tools from markdown format", () => {
    const md = `## greet\n\`\`\`python\ndef greet(name):\n    return f"Hello {name}"\n\`\`\`\n\n## farewell\n\`\`\`python\ndef farewell():\n    return "Goodbye"\n\`\`\``;
    const tools = parseToolsMd(md);
    assert.equal(tools.length, 2);
    assert.equal(tools[0].name, "greet");
    assert.ok(tools[0].code.includes("def greet"));
    assert.equal(tools[1].name, "farewell");
  });
});

describe("parseModelRef", () => {
  it("splits on the first slash only", () => {
    assert.deepEqual(parseModelRef("khal/deepseek-v4-flash"), { provider: "khal", model: "deepseek-v4-flash" });
    assert.deepEqual(parseModelRef("openrouter/meta/llama-4"), { provider: "openrouter", model: "meta/llama-4" });
  });

  it("returns null when there is no usable provider prefix", () => {
    assert.equal(parseModelRef("deepseek-v4-flash"), null);
    assert.equal(parseModelRef("/leading"), null);
    assert.equal(parseModelRef("trailing/"), null);
    assert.equal(parseModelRef(""), null);
  });
});

/**
 * Every model switch re-pins the sub-call model. Keeping the previous
 * provider's `sub-call-model` is what made a bare `llm_query()` fail with
 * `Unknown model "<inherited>" for provider "<new>"`.
 */
describe("applyModelRef", () => {
  const base = { provider: "google", model: "gemini-3.1-flash-lite-preview", subCallModel: "gemini-3.1-flash-lite-preview" };

  it("switches provider, model and sub-call model together", () => {
    assert.deepEqual(applyModelRef(base, "khal/deepseek-v4-flash"), {
      provider: "khal",
      model: "deepseek-v4-flash",
      subCallModel: "deepseek-v4-flash",
    });
  });

  it("keeps the configured provider for a bare model id", () => {
    assert.deepEqual(applyModelRef(base, "gemini-3.1-pro"), {
      provider: "google",
      model: "gemini-3.1-pro",
      subCallModel: "gemini-3.1-pro",
    });
  });

  it("trims surrounding whitespace and ignores an empty reference", () => {
    assert.equal(applyModelRef(base, "  khal/deepseek-v4-flash  ").model, "deepseek-v4-flash");
    assert.deepEqual(applyModelRef(base, "   "), base);
  });

  it("returns a new object rather than mutating the input", () => {
    const input = { ...base };
    applyModelRef(input, "khal/deepseek-v4-flash");
    assert.deepEqual(input, base);
  });
});
