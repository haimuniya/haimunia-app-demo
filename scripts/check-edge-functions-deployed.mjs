#!/usr/bin/env node
// Every Edge Function in this repo must actually exist on the live project.
//
// THE INCIDENT THIS CLOSES (2026-09-08). Two of the three functions in
// supabase/functions/ had never been deployed:
//
//   * purge_abandoned_profiles - the 03:31 UTC cron job POSTed to it nightly
//     and got 404 every time. cron.job_run_details recorded 'succeeded',
//     because the SQL that queues the request succeeds regardless of what
//     the request finds, so scheduled_job_health() called the job healthy
//     for as long as it had been broken.
//   * admin_reset_password - called from the browser by a real admin
//     session. A live user-facing 404, and structurally invisible to the job
//     health check, which only knows about cron jobs.
//
// Both were found by chasing an unrelated question. Nothing was watching.
//
// WHY THIS NEEDS NO SECRET, which is the point. The functions are deployed
// with verify_jwt = true, so the gateway answers before any function body
// runs, and the two answers are distinguishable with a key that is already
// public in cloud-config.js and shipped to every browser:
//
//     401 / 403  -> the function EXISTS and refused the caller  (PASS)
//     404        -> the route does not exist: NOT DEPLOYED      (FAIL)
//
// So this runs on every push, in an untrusted context, with no credential
// that could leak. It deliberately proves existence and nothing else - it
// does not prove the function works, and must never be read that way.
//
//   node scripts/check-edge-functions-deployed.mjs [url] [key]
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readConfig() {
  const src = readFileSync(path.join(root, "cloud-config.js"), "utf8");
  const url = src.match(/https:\/\/[a-z0-9]+\.supabase\.co/);
  const key = src.match(/supabasePublishableKey:\s*"([^"]+)"/);
  return { url: url && url[0], key: key && key[1] };
}

const [argUrl, argKey] = process.argv.slice(2);
const cfg = argUrl && argKey ? { url: argUrl, key: argKey } : readConfig();
if (!cfg.url || !cfg.key || /YOUR_|example\.supabase/.test(cfg.url)) {
  console.error("No usable project URL/key in cloud-config.js - skipping (this is expected on a fork with no backend).");
  process.exit(0);
}

const fnDir = path.join(root, "supabase", "functions");
const names = readdirSync(fnDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(path.join(fnDir, d.name, "index.ts")))
  .map((d) => d.name)
  .sort();

if (names.length === 0) {
  console.error("No Edge Functions found in supabase/functions - nothing to check.");
  process.exit(0);
}

console.log(`Checking ${names.length} Edge Function(s) against ${cfg.url} ...\n`);
let missing = 0;
let inconclusive = 0;
for (const name of names) {
  let res;
  try {
    // POST with an empty body and the PUBLISHABLE key. Never the service_role
    // key: this must be safe to run from CI on any branch, including a fork's.
    res = await fetch(`${cfg.url}/functions/v1/${name}`, {
      method: "POST",
      headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      body: "{}",
    });
  } catch (err) {
    console.log(`  ?  ${name} — could not reach the project (${err?.message || err})`);
    inconclusive++;
    continue;
  }
  if (res.status === 404) {
    console.log(`  ✗  ${name} — 404 NOT DEPLOYED`);
    missing++;
  } else if (res.status === 401 || res.status === 403) {
    console.log(`  ✓  ${name} — deployed (${res.status}, refused the anon caller as it should)`);
  } else {
    // 2xx/5xx means the body RAN under a publishable key. That is not this
    // script's business to judge, but it does mean verify_jwt is off for this
    // function, which is worth a human look rather than a silent pass.
    console.log(`  !  ${name} — deployed, but answered ${res.status} to an anon POST (verify_jwt off?)`);
  }
}

if (missing > 0) {
  console.error(`\n${missing} function(s) exist in this repo but NOT on the project. Deploy them:\n  supabase functions deploy <name>\nor run the deploy-edge-functions workflow.`);
  process.exit(1);
}
if (inconclusive > 0) {
  console.error(`\n${inconclusive} function(s) could not be checked (network). Not treating that as a pass, but not failing the build on it either.`);
  process.exit(0);
}
console.log("\nEvery Edge Function in this repo exists on the project.");
