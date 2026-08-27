#!/usr/bin/env node
// Opt-in, one time per clone: `npm run setup-hooks`. Points git at
// .githooks/ instead of .git/hooks/ (git config core.hooksPath is a
// local, per-clone setting - never committed, never applied silently),
// so the pre-commit check in .githooks/pre-commit actually runs.
import { execFileSync } from "node:child_process";
execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "inherit" });
console.log("Pre-commit hook enabled (git config core.hooksPath .githooks) - it checks APP_VERSION/SW_VERSION and vendor/supabase.js before every commit.");
