#!/usr/bin/env node
// Runs every check in sequence, stops at the first failure. See the header
// comment in each script for what it covers and why it exists.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = ["boot-smoke.mjs", "ladder.mjs", "update-flow.mjs", "duration.mjs", "wod-builder-duration.mjs", "superset.mjs", "emom.mjs", "wod-extras.mjs"];

for (const script of scripts) {
  console.log(`\n${"=".repeat(60)}\n${script}\n${"=".repeat(60)}`);
  const result = spawnSync(process.execPath, [path.join(here, script)], { stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    console.log(`\nrun-all: stopped — ${script} failed`);
    process.exit(result.status ?? 1);
  }
}
console.log("\nrun-all: everything passed");
