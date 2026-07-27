#!/usr/bin/env node
/**
 * run-task.mjs — drive one mined parity task through the real MCP path.
 *
 * Same shape as scripts/smoke-explore.mjs: an MCP SDK client over
 * `node dist/src/cli.js mcp --dir <task root>`, calling `rlmx_explore` with the
 * task's verbatim question. The difference is the install root — the recipe
 * goes into a scratch HOME's `~/.rlmx/agents/explore/` (discovery root #1,
 * src/mcp/agents.ts:56-68) rather than into the task repo, because the task
 * repos are the user's other checkouts and the gate must not write in them.
 * No `RLMX_AGENTS_DIR` override: the discovery path stays the real one.
 *
 *   node run-task.mjs <taskNumber> <model> <roundLabel> [--tasks-dir <dir>]
 *
 * Writes the verbatim result to parity/runs/<round>/task-<n>.json.
 *
 * `--tasks-dir` defaults to the frozen eval suite, `<wish>/tasks`. It exists
 * because round 2 has a second suite — `parity/round2/train-tasks/`, the
 * training input the optimizer selects on — and without an argument the runner
 * could only ever drive the frozen six. Two consequences worth stating:
 *
 *   - The round label is the only thing separating one suite's runs from
 *     another's under `parity/runs/`. Use a label that names the suite, and
 *     read `record.tasksDir` (recorded on every run) if you have to tell them
 *     apart after the fact.
 *   - **Pointing this at the frozen suite is the only way to produce a gate
 *     number.** A training-suite run is a training-suite run; nothing about
 *     this flag makes the two comparable, and the train tasks carry no native
 *     arm to compare against (see round2/train-tasks/README.md).
 *
 * The recipe under test is still hardcoded to `examples/agents/explore/`.
 * Driving `explore-r` is a separate change and has deliberately not been made
 * here.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const parityDir = __dirname;
const wishDir = resolve(parityDir, "..");
const repo = resolve(wishDir, "..", "..", "..");
const cli = join(repo, "dist", "src", "cli.js");
const recipe = join(repo, "examples", "agents", "explore");

const argv = process.argv.slice(2);
const flagAt = argv.indexOf("--tasks-dir");
const tasksDirArg = flagAt >= 0 ? argv[flagAt + 1] : null;
if (flagAt >= 0) {
  if (!tasksDirArg) {
    console.error("--tasks-dir requires a directory");
    process.exit(2);
  }
  argv.splice(flagAt, 2);
}
const [taskArg, model, round] = argv;
if (!taskArg || !model || !round) {
  console.error("usage: run-task.mjs <taskNumber> <model> <roundLabel> [--tasks-dir <dir>]");
  process.exit(2);
}

const tasksDir = tasksDirArg ? resolve(tasksDirArg) : join(wishDir, "tasks");
const taskFile = join(tasksDir, `${taskArg}.md`);
if (!existsSync(taskFile)) {
  console.error(`task ${taskArg}: no such file ${taskFile}`);
  process.exit(2);
}
const taskText = readFileSync(taskFile, "utf-8");
const root = /\| Task root \(the rlmx arm's `--dir`\) \| `([^`]+)` \|/.exec(taskText)?.[1];
/**
 * Both suites' question headings, and only those two.
 *
 * A mined task's heading says "verbatim from the transcript" because the
 * question is a line somebody actually typed; an authored training task says
 * "authored for the training suite" because it is not, and the file refuses to
 * borrow the mined suite's wording for something that was written. That is a
 * deliberate distinction (scripts/author-explore-tasks.mjs), so the runner
 * matches the two forms by name rather than accepting any `## Question (…)` —
 * a wildcard here would let a third, unaudited provenance through silently.
 */
const question =
  /## Question \((?:verbatim from the transcript|authored for the training suite)\)\n\n```text\n([\s\S]*?)\n```\n/.exec(
    taskText
  )?.[1];
if (!root || !question) {
  console.error(
    `task ${taskArg}: could not extract root/question from ${taskFile}\n` +
      `  root:     ${root ? "ok" : "missing `| Task root (the rlmx arm's \\`--dir\\`) | \\`…\\` |` row"}\n` +
      `  question: ${question ? "ok" : "missing a fenced `## Question (verbatim from the transcript|authored for the training suite)` section"}`
  );
  process.exit(2);
}

/** Scratch HOME per round+task: the recipe is installed at its global root. */
const home = join(tmpdir(), `rlmx-parity-${round}-t${taskArg}`);
const installed = join(home, ".rlmx", "agents", "explore");
mkdirSync(installed, { recursive: true });
cpSync(join(recipe, "SYSTEM.md"), join(installed, "SYSTEM.md"));
const yaml = readFileSync(join(recipe, "agent.yaml"), "utf-8");
const installedYaml = yaml.replace(/^model:.*$/m, `model: ${model}`);
writeFileSync(join(installed, "agent.yaml"), installedYaml, "utf-8");

/**
 * Provenance the run cannot be re-derived without (added after the gate; rounds
 * r1–r15 carry none of it — see the report's Method section).
 *
 *   prompt  — SHA-256 of the exact SYSTEM.md and agent.yaml this run ran under,
 *             so "what changed in round N" is checkable rather than prose. The
 *             SYSTEM.md body is also snapshotted under parity/prompts/<sha>.md.
 *   root    — the task tree's git HEAD, so a citation that resolved at run time
 *             can be re-resolved against the tree the model actually read. The
 *             task roots are live checkouts and they move.
 */
const sha = (s) => createHash("sha256").update(s).digest("hex");
const systemText = readFileSync(join(recipe, "SYSTEM.md"), "utf-8");
const promptDigest = sha(systemText);
const promptsDir = join(parityDir, "prompts");
mkdirSync(promptsDir, { recursive: true });
writeFileSync(join(promptsDir, `${promptDigest}.md`), systemText, "utf-8");

function gitState(dir) {
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8" }).trim();
  try {
    return { head: git("rev-parse", "HEAD"), branch: git("rev-parse", "--abbrev-ref", "HEAD"), dirty: git("status", "--porcelain").length > 0 };
  } catch (e) {
    return { head: null, error: e?.message ?? String(e) };
  }
}

const provenance = {
  promptSha256: promptDigest,
  promptChars: systemText.length,
  promptSnapshot: `parity/prompts/${promptDigest}.md`,
  // Digest of the installed (model-rewritten) agent.yaml — the file that ran.
  agentYamlSha256: sha(installedYaml),
  rootGit: gitState(root),
  rlmxGit: gitState(repo),
};

const outDir = join(parityDir, "runs", round);
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `task-${taskArg}.json`);

/**
 * A re-run into an existing round label silently replaced the run JSON while
 * the score JSON beside it kept describing the run that had already been
 * scored — the published matrix then mixed columns from two different runs
 * (seven rows of the first gate did exactly this). A re-run is a new round;
 * say so, or pass PARITY_OVERWRITE=1 deliberately.
 */
if (existsSync(outFile) && process.env.PARITY_OVERWRITE !== "1") {
  console.error(
    `refusing to overwrite ${outFile}\n` +
      `  that run is already recorded (and probably already scored).\n` +
      `  use a new round label, or set PARITY_OVERWRITE=1 and re-score the round.`
  );
  process.exit(3);
}

const progress = [];
const LIVE_OPTS = {
  timeout: 300_000,
  resetTimeoutOnProgress: true,
  maxTotalTimeout: 2_400_000,
  onprogress: (p) => {
    progress.push(p.message ?? `progress ${p.progress}`);
    process.stderr.write(`[t${taskArg}] ${p.message ?? p.progress}\n`);
  },
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, "mcp", "--dir", root],
  cwd: tmpdir(),
  env: { ...process.env, HOME: home, RLMX_AGENTS_DIR: "" },
  stderr: "pipe",
});

const client = new Client({ name: "rlmx-parity", version: "1.0.0" }, { capabilities: {} });
let record = {
  task: Number(taskArg),
  // Which suite this run came from. Without it, two suites sharing a round
  // label are indistinguishable in parity/runs/ — and one of them is the gate.
  tasksDir,
  taskFile,
  suite: tasksDir === join(wishDir, "tasks") ? "frozen-eval" : "other",
  root,
  model,
  round,
  startedAt: new Date().toISOString(),
  question,
  provenance,
};

const started = Date.now();
try {
  await client.connect(transport);
  let stderrBuf = "";
  transport.stderr?.on("data", (chunk) => {
    stderrBuf += chunk.toString();
  });

  const { tools } = await client.listTools();
  record.toolsListed = tools.map((t) => t.name);
  if (!tools.some((t) => t.name === "rlmx_explore")) {
    throw new Error(`rlmx_explore not listed; got ${record.toolsListed.join(", ")}`);
  }

  const args = { prompt: question };
  const res = await client.callTool({ name: "rlmx_explore", arguments: args }, undefined, LIVE_OPTS);
  const elapsed = Date.now() - started;
  const text = res?.content?.[0]?.text ?? "";
  const split = text.lastIndexOf("\n---\n");
  const answer = split >= 0 ? text.slice(0, split) : text;
  const footer = split >= 0 ? text.slice(split + 5).trim() : "";

  record = {
    ...record,
    ok: !res.isError,
    isError: Boolean(res.isError),
    wallSeconds: Number((elapsed / 1000).toFixed(1)),
    requestChars: JSON.stringify(args).length,
    resultChars: text.length,
    answer,
    footer,
    fullText: text,
    structuredContent: res.structuredContent ?? null,
    progress,
    stderr: stderrBuf.slice(-4000),
  };
} catch (err) {
  record = {
    ...record,
    ok: false,
    isError: true,
    wallSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    error: err?.message ?? String(err),
    progress,
  };
} finally {
  try {
    await client.close();
  } catch {
    /* already dead */
  }
}

writeFileSync(outFile, JSON.stringify(record, null, 2), "utf-8");
process.stdout.write(
  `task ${taskArg} ${record.ok ? "OK" : "ERR"} ${record.wallSeconds}s → ${outFile}\n${record.footer ?? record.error ?? ""}\n`
);
process.exit(record.ok ? 0 : 1);
