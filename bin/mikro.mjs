#!/usr/bin/env node
/**
 * `mikro` launcher — the thing `~/.local/bin/mikro` points at.
 *
 * Dependency-free on purpose: it only uses Node built-ins, so it always
 * starts, even when the checkout's `node_modules` is missing or half-written.
 * That is the failure this file exists for — `mikro update` runs `npm ci`,
 * which deletes `node_modules` before reinstalling; a killed or failed install
 * used to leave no working `mikro` at all (`Cannot find package 'js-yaml'`),
 * and no way to repair it short of re-running scripts/install.sh by hand.
 *
 * What it does, in order:
 *   1. Checks the install is complete (`node_modules/.package-lock.json` is
 *      npm's own "install finished" marker; a sample runtime dep is checked
 *      too). If not, runs `npm ci --include=dev` once, with bounded network
 *      waits, and explains what it is doing on stderr.
 *   2. Loads `dist/src/cli.js`. If `dist/` is missing (fresh clone without a
 *      build), builds first.
 *
 * `MIKRO_NO_SELF_HEAL=1` disables step 1 (CI, or when you want the raw error).
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "src", "cli.js");

/** npm flags that keep a flaky registry from hanging the install forever. */
export const NPM_CI_ARGS = [
  "ci",
  "--include=dev",
  "--no-audit",
  "--no-fund",
  "--fetch-timeout=120000",
  "--fetch-retries=3",
];

function installComplete() {
  return (
    existsSync(join(root, "node_modules", ".package-lock.json")) &&
    existsSync(join(root, "node_modules", "js-yaml", "package.json")) &&
    existsSync(join(root, "node_modules", "@earendil-works", "pi-ai", "package.json"))
  );
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  return r.status ?? 1;
}

if (process.env.MIKRO_NO_SELF_HEAL !== "1") {
  if (!installComplete()) {
    process.stderr.write(`mikro: dependencies are missing or incomplete under ${root} — repairing with npm ci...\n`);
    // MIKRO_SKIP_PREPARE: scripts/prepare.mjs would build during npm ci; we
    // build explicitly below only when dist/ is absent, so skip the duplicate.
    const status = spawnSync("npm", NPM_CI_ARGS, {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, MIKRO_SKIP_PREPARE: "1" },
    }).status;
    if (status !== 0) {
      process.stderr.write(`mikro: npm ci failed (exit ${status}). Re-run \`mikro\` to retry, or scripts/install.sh to reinstall.\n`);
      process.exit(status ?? 1);
    }
  }
  if (!existsSync(cli)) {
    process.stderr.write("mikro: dist/ is missing — building...\n");
    const status = run("npm", ["run", "build"]);
    if (status !== 0) process.exit(status);
  }
}

await import(pathToFileURL(cli).href);
