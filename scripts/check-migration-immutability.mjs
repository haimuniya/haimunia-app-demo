#!/usr/bin/env node
// Launch-readiness audit, DATABASE_AUDIT.md DB-M1.
//
// THE PROBLEM. Supabase tracks applied migrations by filename, not by
// content. Editing a migration file that has already run against a real
// project is therefore invisible: the local `supabase db reset` replays the
// EDITED file from empty and passes, while production still carries what
// the ORIGINAL file did. The two silently diverge, and nothing in CI can
// tell. The audit found four migrations that had been edited after being
// applied - one commit message for such an edit literally reads "broke a
// live migration run".
//
// THE RULE THIS ENFORCES. A migration file, once committed, is immutable.
// Corrections go in a NEW migration. This is the same rule the repo already
// follows by convention (see any of the `drop policy ... create policy`
// re-declarations); it just had nothing enforcing it.
//
// HOW. For every file in supabase/migrations/, compare the working-tree
// content against the content at the merge-base with the default branch.
// A file that existed there and differs now is a rewrite of applied
// history. A file that did not exist there is new, and is fine.
//
// Deliberately compares against the MERGE BASE, not against HEAD~1: a
// feature branch that legitimately adds several migrations over several
// commits must not trip this on its own additions.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MIGRATIONS = path.join(root, "supabase", "migrations");

function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}

function resolveBase() {
  // The base branch this work will merge into. Falls back through the
  // common names so this runs both in CI and on a laptop.
  const candidates = [
    process.env.GITHUB_BASE_REF && `origin/${process.env.GITHUB_BASE_REF}`,
    "origin/main",
    "origin/master",
    "main",
    "master",
  ].filter(Boolean);
  for (const ref of candidates) {
    try {
      git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return ref;
    } catch { /* try the next one */ }
  }
  return null;
}

const base = resolveBase();
if (!base) {
  console.log("check-migration-immutability: no base branch found (shallow clone or a fresh repo) - skipping.");
  process.exit(0);
}

let mergeBase;
try {
  mergeBase = git(["merge-base", "HEAD", base]);
} catch {
  console.log(`check-migration-immutability: no merge base with ${base} - skipping.`);
  process.exit(0);
}

const violations = [];
for (const name of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
  const rel = `supabase/migrations/${name}`;
  let committed;
  try {
    committed = execFileSync("git", ["show", `${mergeBase}:${rel}`], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    continue; // Not present at the merge base: a new migration. Fine.
  }
  const current = fs.readFileSync(path.join(MIGRATIONS, name), "utf8");
  if (current !== committed) violations.push(rel);
}

if (violations.length && process.env.ALLOW_MIGRATION_EDITS !== "1") {
  console.error("check-migration-immutability: FAILED\n");
  console.error("These migrations already existed at the merge base and have been edited:\n");
  for (const v of violations) console.error(`  - ${v}`);
  console.error(`
Supabase tracks applied migrations by FILENAME, not content. A project that
already ran the original version will never run the edited one, so the local
database and production diverge silently and no test can see it.

Put the correction in a NEW migration instead. If this edit is genuinely
safe (a comment-only change, or a file that has demonstrably never been
applied anywhere), say so explicitly in the PR and re-run with
ALLOW_MIGRATION_EDITS=1.`);
  process.exit(1);
}

console.log(`check-migration-immutability: OK (compared against ${base} at ${mergeBase.slice(0, 8)})`);
