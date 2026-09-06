#!/usr/bin/env node
// Deploy preflight: does the TARGET Supabase project actually have the
// server side this client build needs?
//
// WHY THIS EXISTS. This app has no build step and no deploy pipeline - the
// client is static files and the database is migrated separately, so
// nothing structurally guarantees the two ship in the right order. Ship the
// client first and PostgREST answers every write with PGRST202 "Could not
// find the function", because it resolves overloads by the exact set of
// named arguments and this build sends p_idempotency_key. Posting,
// commenting, reactions, RSVP and coach progress entries all die at once.
//
// The client now degrades rather than breaking (communityRpc() retries
// un-keyed on PGRST202), so an ordering mistake is survivable. This script
// is the other half: it tells you BEFORE you ship, instead of leaving it to
// a paragraph in an audit document.
//
// USAGE
//   node scripts/check-deploy-readiness.mjs                  # reads cloud-config.js
//   node scripts/check-deploy-readiness.mjs <url> <anon-key> # or pass explicitly
//
// Exits 0 when the project is ready, 1 when it is not. Read-only: it calls
// each RPC with a deliberately invalid payload and only inspects the ERROR
// CODE, so it never writes anything to the project it probes.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The contract this build depends on: every action whose call shape changed.
// Kept in sync with cloud.js's OUTBOX_ACTIONS by
// test/community-outbox-rpc-contract.test.mjs.
const REQUIRED = [
  { fn: "post_create", args: { body: "", visibility: "club", media: [], links: {} } },
  { fn: "add_post_comment", args: { p_post_id: null, p_body: "", p_parent_comment_id: null, p_mentions: null } },
  { fn: "toggle_reaction", args: { p_post_id: null } },
  { fn: "chal_record_progress", args: { p_challenge_id: null, p_user_id: null, p_delta: 0, p_note: null } },
  { fn: "event_rsvp", args: { p_event_id: null, p_response: "going" } },
];
const PROBE_KEY = "00000000-0000-4000-8000-000000000000";

function readConfig() {
  const src = readFileSync(path.join(root, "cloud-config.js"), "utf8");
  const url = src.match(/supabaseUrl:\s*"([^"]+)"/);
  const key = src.match(/supabasePublishableKey:\s*"([^"]+)"/);
  return { url: url && url[1], key: key && key[1] };
}

const [argUrl, argKey] = process.argv.slice(2);
const cfg = argUrl && argKey ? { url: argUrl, key: argKey } : readConfig();

if (!cfg.url || !cfg.key || /YOUR_|example\.supabase/.test(cfg.url)) {
  console.log("check-deploy-readiness: no Supabase project configured in cloud-config.js - nothing to check.");
  process.exit(0);
}

console.log(`Probing ${cfg.url} for the RPC signatures this build calls...\n`);

let ready = true;
for (const { fn, args } of REQUIRED) {
  const body = JSON.stringify({ ...args, p_idempotency_key: PROBE_KEY });
  let res, json;
  try {
    res = await fetch(`${cfg.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      body,
    });
    json = await res.json().catch(() => ({}));
  } catch (e) {
    console.error(`  ?  ${fn} — could not reach the project: ${e.message}`);
    ready = false;
    continue;
  }

  // PGRST202 = the (name, argument-set) pair does not exist. Anything else -
  // including 42501 permission-denied, which is the EXPECTED answer for an
  // anonymous caller - means the signature resolved, which is all we are
  // asking. A permission error is a pass here, not a failure.
  if (json && json.code === "PGRST202") {
    console.error(`  ✗  ${fn} — MISSING the p_idempotency_key parameter`);
    console.error(`     ${String(json.hint || json.message || "").slice(0, 140)}`);
    ready = false;
  } else {
    console.log(`  ✓  ${fn} — signature resolves (${json?.code || res.status})`);
  }
}

console.log();
if (!ready) {
  console.error(`NOT READY. This project is missing migrations this client build requires.

Apply them first, then re-run this check:

    supabase link --project-ref <ref>
    supabase db push
    node scripts/check-deploy-readiness.mjs

The client will DEGRADE rather than break if you ship anyway - communityRpc()
retries without the idempotency key on PGRST202 - but degraded means retries
can duplicate a post, a comment or a challenge-progress delta, which is the
exact data-integrity problem the key was added to prevent.`);
  process.exit(1);
}

console.log("READY. Every RPC signature this build calls exists on the target project.");
