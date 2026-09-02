#!/usr/bin/env node
// Runs every check in sequence. See the header comment in each script for
// what it covers and why it exists.
//
// The script list is discovered from disk, not hand-maintained — a
// hardcoded list here silently stopped covering new checks (roadmap.mjs,
// text-scale.mjs, benchmarks.mjs all existed but were never run by this
// file). Any *.mjs file in this directory except this one and files
// under lib/ is treated as a check.
//
// COMM-333: this used to stop at the first failure, so one scenario
// failing (or a flaky console-error check) silently hid every scenario
// after it in the sort order from ever running that pass — a bad run and
// a partially-skipped run looked identical from the outside. It now runs
// every script regardless of earlier failures and reports the full set at
// the end; the exit code still reflects whether anything failed.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = readdirSync(here)
  .filter((f) => f.endsWith(".mjs") && f !== "run-all.mjs")
  .sort();

const results = [];
for (const script of scripts) {
  console.log(`\n${"=".repeat(60)}\n${script}\n${"=".repeat(60)}`);
  const result = spawnSync(process.execPath, [path.join(here, script)], { stdio: "inherit", env: process.env });
  const ok = result.status === 0;
  results.push({ script, ok, status: result.status });
  console.log(ok ? `\nrun-all: ${script} passed` : `\nrun-all: ${script} FAILED (exit ${result.status ?? 1})`);
}

const failedScripts = results.filter((r) => !r.ok);
console.log(`\n${"=".repeat(60)}\nrun-all summary: ${results.length - failedScripts.length}/${results.length} passed\n${"=".repeat(60)}`);
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.script}`);

if (failedScripts.length) {
  console.log(`\nrun-all: ${failedScripts.length} scenario(s) failed`);
  process.exit(1);
}
console.log("\nrun-all: everything passed");
