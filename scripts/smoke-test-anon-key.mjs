#!/usr/bin/env node
// The committed publishable key (cloud-config.js) is only safe to ship
// if RLS genuinely locks down every table it can reach - and that
// invariant has already been wrong on first attempt three separate
// times this project's history (the anon default-grant leak, missing
// photo-path ownership, missing admin visibility into reports). Nothing
// automated checked it; this does, querying every app table as a real
// unauthenticated anon request (no session, exactly what a stranger
// with only the public key can do) and asserting each one returns
// nothing.
//
// Deliberately NOT part of `npm test` - this hits the live Supabase
// project over the network, unlike the rest of the suite, which is
// intentionally offline/hermetic. Run by hand or from a separate CI job:
//   node scripts/smoke-test-anon-key.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const configSrc = readFileSync(path.join(root, "cloud-config.js"), "utf8");
const urlMatch = configSrc.match(/supabaseUrl:\s*"([^"]+)"/);
const keyMatch = configSrc.match(/supabasePublishableKey:\s*"([^"]+)"/);
if (!urlMatch || !keyMatch) {
  console.error("Could not read supabaseUrl/supabasePublishableKey from cloud-config.js");
  process.exit(1);
}
const SUPABASE_URL = urlMatch[1];
const ANON_KEY = keyMatch[1];

// Every table this app defines. A table missing from this list because
// a future migration added one is exactly the gap this script exists to
// catch - keep it in sync with supabase/migrations/.
const TABLES = [
  "profiles", "private_records", "follows", "blocks", "workout_posts",
  "reactions", "reports", "account_deletion_requests", "invite_codes",
  "invite_redemptions", "invite_attempts", "announcements",
  "weekly_challenges", "activity_pings", "post_comments", "rate_limits",
];
// Views are separate: community_feed is DELIBERATELY public-readable by
// any authenticated session (that's the point of a feed) so it's not
// checked here; admin_user_directory has no grants at all, same
// standard as the tables above.
const VIEWS_NO_ANON_ACCESS = ["admin_user_directory"];

async function checkTable(name) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${name}?select=*&limit=1`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
  });
  if (res.status === 401 || res.status === 403) return { name, ok: true, detail: `HTTP ${res.status} (no grant)` };
  if (res.ok) {
    const body = await res.json();
    if (Array.isArray(body) && body.length === 0) return { name, ok: true, detail: "200, zero rows (RLS filtered)" };
    return { name, ok: false, detail: `200 with ${Array.isArray(body) ? body.length : "?"} row(s) returned to anon` };
  }
  return { name, ok: false, detail: `unexpected HTTP ${res.status}: ${await res.text()}` };
}

let failed = false;
for (const name of [...TABLES, ...VIEWS_NO_ANON_ACCESS]) {
  const result = await checkTable(name);
  console.log(`${result.ok ? "PASS" : "FAIL"}  ${name.padEnd(28)} ${result.detail}`);
  if (!result.ok) failed = true;
}
if (failed) {
  console.error("\nAt least one table/view returned real rows to an anonymous, unauthenticated request. Fix the RLS policy before shipping.");
  process.exit(1);
}
console.log("\nAll tables/views are safe from the public anon key with no session.");
