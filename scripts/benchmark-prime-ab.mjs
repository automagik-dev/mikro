#!/usr/bin/env node

import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../dist/src/config.js";
import { loadContext } from "../dist/src/context.js";
import { LegacyRlmxBackend } from "../dist/src/mcp/backends/legacy.js";
import { PrimeBackend } from "../dist/src/mcp/backends/prime.js";

const DEFAULT_MODELS = [
  "openrouter/~deepseek/deepseek-v4-flash-latest",
  "openrouter/qwen/qwen3.7-flash",
  "openrouter/z-ai/glm-5.3-flash",
  "openrouter/xiaomi/mimo-v2.5",
];
const RECIPES = {
  neutral: "Use the attached evidence only. Return the requested five marker values, one per line, as KEY=VALUE. Do not guess.",
  legacy_native: "Use programmatic inspection and recursive sub-calls when useful. Return exactly the requested five KEY=VALUE lines.",
  prime_native: "Use Prime's agent tools and RLM workflow when useful. Return exactly the requested five KEY=VALUE lines.",
};
const EXPECTED = [
  "OWNER=ada",
  "SEVERITY=critical",
  "PORT=4821",
  "POLICY=deny-by-default",
  "INCIDENT=INC-731",
];

function parseArgs(argv) {
  const args = {
    models: DEFAULT_MODELS,
    repetitions: 2,
    output: null,
    recipes: Object.keys(RECIPES),
    backends: ["legacy", "prime"],
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--models") args.models = argv[++i].split(",").filter(Boolean);
    else if (argv[i] === "--repetitions") args.repetitions = Number(argv[++i]);
    else if (argv[i] === "--output") args.output = resolve(argv[++i]);
    else if (argv[i] === "--recipes") args.recipes = argv[++i].split(",").filter(Boolean);
    else if (argv[i] === "--backends") args.backends = argv[++i].split(",").filter(Boolean);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(args.repetitions) || args.repetitions < 1) {
    throw new Error("--repetitions must be a positive integer");
  }
  for (const recipe of args.recipes) {
    if (!(recipe in RECIPES)) throw new Error(`unknown recipe: ${recipe}`);
  }
  for (const backend of args.backends) {
    if (!new Set(["legacy", "prime"]).has(backend)) {
      throw new Error(`unknown backend: ${backend}`);
    }
  }
  return args;
}

function score(answer) {
  const normalized = new Set(answer.split(/\r?\n/).map((line) => line.trim()));
  const matched = EXPECTED.filter((marker) => normalized.has(marker));
  return { matched: matched.length, possible: EXPECTED.length, markers: matched };
}

function parseModelRef(ref) {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`model must be a full provider/model ref, got: ${ref}`);
  }
  return { ref, provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

function requireCredentials(models) {
  const providers = new Set(models.map((entry) => entry.provider));
  const missing = [];
  if (providers.has("openrouter") && !process.env.OPENROUTER_API_KEY) {
    missing.push("OPENROUTER_API_KEY");
  }
  if (
    providers.has("google") &&
    !process.env.GEMINI_API_KEY &&
    !process.env.GOOGLE_API_KEY
  ) {
    missing.push("GEMINI_API_KEY or GOOGLE_API_KEY");
  }
  if (providers.has("anthropic") && !process.env.ANTHROPIC_API_KEY) {
    missing.push("ANTHROPIC_API_KEY");
  }
  if (
    providers.has("khal") &&
    !process.env.KHAL_API_KEY &&
    !process.env.RLMX_KHAL_API_KEY
  ) {
    missing.push("KHAL_API_KEY or RLMX_KHAL_API_KEY");
  }
  if (missing.length > 0) {
    throw new Error(
      `missing benchmark credentials: ${missing.join(", ")}; the benchmark never falls back to another provider`
    );
  }
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "rlmx-prime-ab-"));
  await mkdir(join(root, ".rlmx"), { mode: 0o700 });
  await writeFile(join(root, ".rlmx", "rlmx.yaml"), [
    "tools-level: core",
    "storage:",
    "  enabled: never",
    "budget:",
    "  max-cost: 0.05",
    "  max-tokens: 30000",
    "",
  ].join("\n"));
  await writeFile(join(root, "router.ts"), "export const owner = 'ada';\nexport const port = 4821;\n");
  await writeFile(join(root, "policy.md"), "Production policy: deny-by-default. Severity: critical.\n");
  await writeFile(join(root, "incident.log"), "Active incident identifier: INC-731\n");
  return root;
}

async function configurePrimeCustomProviders(root, models) {
  const khalModels = models.filter((entry) => entry.provider === "khal");
  if (khalModels.length === 0) return null;

  const agentDir = join(root, "prime-agent-config");
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify(
      {
        providers: {
          khal: {
            name: "Khal",
            baseUrl: process.env.KHAL_BASE_URL ?? "https://llm.khal.ai/v1",
            apiKey: process.env.KHAL_API_KEY
              ? "KHAL_API_KEY"
              : "RLMX_KHAL_API_KEY",
            api: "openai-completions",
            models: khalModels.map((entry) => ({
              id: entry.model,
              name: `Khal ${entry.model}`,
              reasoning: true,
              input: ["text"],
              contextWindow: 131072,
              maxTokens: 16384,
            })),
          },
        },
      },
      null,
      2
    ) + "\n",
    { mode: 0o600 }
  );
  return agentDir;
}

async function writeReport(output, results, complete) {
  const report =
    JSON.stringify(
      { generatedAt: new Date().toISOString(), complete, results },
      null,
      2
    ) + "\n";
  if (!output) {
    if (complete) process.stdout.write(report);
    return;
  }
  const pending = `${output}.tmp`;
  await writeFile(pending, report, { mode: 0o600 });
  await rename(pending, output);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const models = args.models.map(parseModelRef);
  requireCredentials(models);
  const root = await makeFixture();
  const previousPrimeAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
  const results = [];
  try {
    const primeAgentDir = await configurePrimeCustomProviders(root, models);
    if (primeAgentDir) process.env.PRIME_AGENT_CODING_AGENT_DIR = primeAgentDir;
    const base = await loadConfig(root);
    const context = await loadContext(root, { extensions: [".ts", ".md", ".log"], exclude: [] });
    const allBackends = [
      ["legacy", new LegacyRlmxBackend()],
      ["prime", new PrimeBackend()],
    ];
    const backends = allBackends.filter(([name]) => args.backends.includes(name));
    for (const modelRef of models) {
      const config = {
        ...base,
        model: { provider: modelRef.provider, model: modelRef.model },
      };
      for (const [backendName, backend] of backends) {
        for (const recipe of args.recipes) {
          const instruction = RECIPES[recipe];
          for (let repetition = 1; repetition <= args.repetitions; repetition += 1) {
            const started = performance.now();
            const record = {
              model: modelRef.ref,
              provider: modelRef.provider,
              backend: backendName,
              recipe,
              repetition,
            };
            try {
              const result = await backend.run(undefined, {
                query: `${instruction}\n\nRequired markers:\n${EXPECTED.map((x) => x.split("=")[0]).join("\n")}`,
                context,
                contextRoot: root,
                config,
                maxIterations: 8,
                cwd: root,
              }, () => {});
              Object.assign(record, {
                ok: true,
                wallMs: Math.round(performance.now() - started),
                score: score(result.answer),
                iterations: result.iterations,
                budgetHit: result.budgetHit ?? null,
                usage: result.usage,
                answer: result.answer,
              });
            } catch (error) {
              Object.assign(record, {
                ok: false,
                wallMs: Math.round(performance.now() - started),
                error: error instanceof Error ? error.message : String(error),
              });
            }
            results.push(record);
            await writeReport(args.output, results, false);
            process.stderr.write(`${backendName} ${modelRef.ref} ${recipe} #${repetition}: ${record.ok ? `${record.score.matched}/${record.score.possible}` : "ERROR"}\n`);
          }
        }
      }
    }
    await writeReport(args.output, results, true);
    if (results.some((result) => !result.ok)) process.exitCode = 1;
  } finally {
    if (previousPrimeAgentDir === undefined) {
      delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
    } else {
      process.env.PRIME_AGENT_CODING_AGENT_DIR = previousPrimeAgentDir;
    }
    await rm(root, { recursive: true, force: true });
  }
}

await main();
