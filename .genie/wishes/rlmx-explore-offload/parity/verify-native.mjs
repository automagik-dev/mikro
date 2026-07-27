#!/usr/bin/env node
/**
 * verify-native.mjs — independent re-check of the ground truth the native arm
 * defines (decision 6).
 *
 * The task files record a native baseline computed at mining time. This
 * re-derives the checkable half of it now, against the trees as they stand:
 * every required fact's anchor `path:line` must exist under the task root, and
 * the line there must still carry the fact's recorded `verified:` text. A fact
 * that no longer anchors would mean the ground truth had drifted under the
 * gate, which is the one way a "conservative asymmetry" could become unfair in
 * the other direction.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const wishDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let allOk = true;
const rows = [];

for (let n = 1; n <= 6; n++) {
  const t = readFileSync(join(wishDir, "tasks", `${n}.md`), "utf-8");
  const root = /\| Task root \(the rlmx arm's `--dir`\) \| `([^`]+)` \|/.exec(t)[1];
  const factRe =
    /^- \[ \] \*\*(F\d+)\*\* \((exact|re-anchored)\) `([^`]+)`([^\n]*)\n((?:  [^\n]*\n)+)/gm;
  let m;
  let ok = 0;
  let bad = [];
  while ((m = factRe.exec(t))) {
    const [, id, , anchor, , body] = m;
    const verified = /verified: `([\s\S]*?)`\n/.exec(body)?.[1] ?? "";
    const [path, lineRaw] = [anchor.replace(/:\d+$/, ""), Number(/:(\d+)$/.exec(anchor)?.[1])];
    const abs = join(root, path);
    let verdict = "ok";
    try {
      if (!statSync(abs).isFile()) throw new Error("not a file");
      const lines = readFileSync(abs, "utf-8").split("\n");
      if (lineRaw < 1 || lineRaw > lines.length) verdict = "line-out-of-range";
      else if (verified && lines[lineRaw - 1].trim() !== verified.trim()) {
        verdict = `text-mismatch: got ${JSON.stringify(lines[lineRaw - 1].trim().slice(0, 80))}`;
      }
    } catch (e) {
      verdict = `missing (${e.message})`;
    }
    if (verdict === "ok") ok += 1;
    else bad.push(`${id} ${anchor} → ${verdict}`);
  }
  const total = ok + bad.length;
  if (bad.length) allOk = false;
  rows.push({ task: n, root, anchorsVerified: `${ok}/${total}`, failures: bad });
  console.log(`task ${n}: ${ok}/${total} fact anchors still resolve with their recorded text`);
  for (const b of bad) console.log(`  ✗ ${b}`);
}

console.log(allOk ? "\nNATIVE GROUND TRUTH VERIFIED" : "\nNATIVE GROUND TRUTH DRIFTED");
process.exit(allOk ? 0 : 1);
