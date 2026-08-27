#!/usr/bin/env node
// Runs every check in sequence, stops at the first failure. See the header
// comment in each script for what it covers and why it exists.
//
// The script list is discovered from disk, not hand-maintained — a
// hardcoded list here silently stopped covering new checks (roadmap.mjs,
// text-scale.mjs, benchmarks.mjs all existed but were never run by this
// file). Any *.mjs file in this directory except this one and files
// under lib/ is treated as a check.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = readdirSync(here)
  .filter((f) => f.endsWith(".mjs") && f !== "run-all.mjs")
  .sort();

for (const script of scripts) {
  console.log(`\n${"=".repeat(60)}\n${script}\n${"=".repeat(60)}`);
  const result = spawnSync(process.execPath, [path.join(here, script)], { stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    console.log(`\nrun-all: stopped — ${script} failed`);
    process.exit(result.status ?? 1);
  }
}
console.log("\nrun-all: everything passed");
