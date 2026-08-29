#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../dist/src/config.js";
import { loadContext } from "../dist/src/context.js";
import { LegacyRlmxBackend } from "../dist/src/mcp/backends/legacy.js";
import { PrimeBackend } from "../dist/src/mcp/backends/prime.js";

const DEFAULT_MODELS = [
  "~deepseek/deepseek-v4-flash-latest",
  "qwen/qwen3.7-flash",
  "z-ai/glm-5.3-flash",
  "xiaomi/mimo-v2.5",
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
  const args = { models: DEFAULT_MODELS, repetitions: 2, output: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--models") args.models = argv[++i].split(",").filter(Boolean);
    else if (argv[i] === "--repetitions") args.repetitions = Number(argv[++i]);
    else if (argv[i] === "--output") args.output = resolve(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(args.repetitions) || args.repetitions < 1) {
    throw new Error("--repetitions must be a positive integer");
  }
  return args;
}

function score(answer) {
  const normalized = new Set(answer.split(/\r?\n/).map((line) => line.trim()));
  const matched = EXPECTED.filter((marker) => normalized.has(marker));
  return { matched: matched.length, possible: EXPECTED.length, markers: matched };
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

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is required; the benchmark never falls back to another provider");
  }
  const args = parseArgs(process.argv.slice(2));
  const root = await makeFixture();
  const results = [];
  try {
    const base = await loadConfig(root);
    const context = await loadContext(root, { extensions: [".ts", ".md", ".log"], exclude: [] });
    const backends = [
      ["legacy", new LegacyRlmxBackend()],
      ["prime", new PrimeBackend()],
    ];
    for (const model of args.models) {
      const config = { ...base, model: { provider: "openrouter", model } };
      for (const [backendName, backend] of backends) {
        for (const [recipe, instruction] of Object.entries(RECIPES)) {
          for (let repetition = 1; repetition <= args.repetitions; repetition += 1) {
            const started = performance.now();
            const record = { model, backend: backendName, recipe, repetition };
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
            process.stderr.write(`${backendName} ${model} ${recipe} #${repetition}: ${record.ok ? `${record.score.matched}/${record.score.possible}` : "ERROR"}\n`);
          }
        }
      }
    }
    const report = JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2) + "\n";
    if (args.output) await writeFile(args.output, report, { mode: 0o600 });
    else process.stdout.write(report);
    if (results.some((result) => !result.ok)) process.exitCode = 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
