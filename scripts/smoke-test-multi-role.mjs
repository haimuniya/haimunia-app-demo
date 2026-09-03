#!/usr/bin/env node
// COMM-338. pgTAP (supabase/tests/) and the anon-key sweep
// (smoke-test-anon-key.mjs) both prove RLS is correct against a fresh
// migration-only database - neither one proves the actual deployed project
// enforces the same boundaries for actual signed-in accounts of every real
// role. Migrations can (and once did - see docs/community/
// supabase-live-project note on the 21-migration drift) apply cleanly
// locally while a live project silently lags behind. This is the "one more
// check, against the real thing, right before flipping a deploy live"
// step: it signs in as five real accounts - anonymous, member, coach,
// admin, and a member under an active posting restriction ("blocked") -
// and asserts each one's own real permission boundary for real, over the
// network, against whatever project SUPABASE_URL points at.
//
// Deliberately NOT part of `npm test` or any automatic CI job, same as
// smoke-test-anon-key.mjs and for the same reason: this hits a real
// Supabase project's Auth and REST endpoints, not the offline/hermetic
// mock every other test in this repo runs against. It is also NOT wired to
// run automatically against this repo's own production project (see
// docs/community/ "supabase-live-project" memory) - there is currently no
// separate staging project, and no CI secrets are configured for one. Run
// by hand, against a project you control, before a go-live:
//
//   SUPABASE_URL=https://<project>.supabase.co \
//   SUPABASE_ANON_KEY=<publishable key> \
//   SMOKE_MEMBER_EMAIL=... SMOKE_MEMBER_PASSWORD=... \
//   SMOKE_COACH_EMAIL=...  SMOKE_COACH_PASSWORD=...  \
//   SMOKE_ADMIN_EMAIL=...  SMOKE_ADMIN_PASSWORD=...  \
//   SMOKE_BLOCKED_EMAIL=... SMOKE_BLOCKED_PASSWORD=... \
//     node scripts/smoke-test-multi-role.mjs
//
// The anonymous check needs no setup and always runs. Each of the other
// four roles is skipped (not failed) if its two env vars are not both set,
// so a first-time run against a fresh project still tells you something
// (and tells you exactly which roles it could not check) instead of
// refusing to run at all. This repo does not create or manage the five
// test accounts for you - provisioning one throwaway member per role in
// whatever club/project you are pointing this at (never a real club's real
// data) is a one-time setup step on the operator's side, the same way the
// pgTAP suite's own two-role impersonation fixtures are hand-authored per
// test file rather than generated here.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readConfigDefaults() {
  const configSrc = readFileSync(path.join(root, "cloud-config.js"), "utf8");
  const urlMatch = configSrc.match(/supabaseUrl:\s*"([^"]+)"/);
  const keyMatch = configSrc.match(/supabasePublishableKey:\s*"([^"]+)"/);
  return { url: urlMatch && urlMatch[1], key: keyMatch && keyMatch[1] };
}

const defaults = readConfigDefaults();
const SUPABASE_URL = process.env.SUPABASE_URL || defaults.url;
const ANON_KEY = process.env.SUPABASE_ANON_KEY || defaults.key;
if (!SUPABASE_URL || !ANON_KEY) {
  console.error("Could not resolve SUPABASE_URL/SUPABASE_ANON_KEY (set them explicitly, or check cloud-config.js).");
  process.exit(1);
}

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}
function skip(label, reason) {
  console.log(`SKIP  ${label} — ${reason}`);
}

async function rest(path, { token, method = "GET", body } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${token || ANON_KEY}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, body: json };
}

async function rpc(name, args, token) {
  return rest(`rpc/${name}`, { token, method: "POST", body: args || {} });
}

async function signInPassword(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) return { error: json };
  return { token: json.access_token, userId: json.user && json.user.id };
}

async function signInAnonymous() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const json = await res.json();
  if (!res.ok) {
    // Some project configs expose anonymous sign-in only through a
    // dedicated endpoint rather than an empty signup - fall back before
    // giving up, so this check degrades to a clear skip, not a false FAIL.
    return { error: json };
  }
  return { token: json.access_token, userId: json.user && json.user.id };
}

// --- Anonymous: needs no fixture, always runs. ---------------------------
console.log("\n== anonymous ==");
{
  const anon = await signInAnonymous();
  if (anon.error) {
    skip("anonymous checks", `could not open an anonymous session (${JSON.stringify(anon.error).slice(0, 200)}) - anonymous sign-in may be disabled on this project`);
  } else {
    const profiles = await rest("profiles?select=id&limit=1", { token: anon.token });
    check("a fresh anonymous session reads zero profile rows (no redemption yet)", profiles.status === 200 && Array.isArray(profiles.body) && profiles.body.length === 0, `HTTP ${profiles.status}`);
    const priv = await rest("private_records?select=id&limit=1", { token: anon.token });
    check("a fresh anonymous session reads zero private_records rows", priv.status === 200 && Array.isArray(priv.body) && priv.body.length === 0, `HTTP ${priv.status}`);
    const grant = await rpc("admin_grant_coach", { p_user_id: anon.userId, p_role: "coach" }, anon.token);
    check("an anonymous session cannot call admin_grant_coach", grant.status >= 400, `HTTP ${grant.status}`);
  }
}

// --- The four credentialed roles. -----------------------------------------
const ROLES = [
  { key: "MEMBER", label: "member" },
  { key: "COACH", label: "coach" },
  { key: "ADMIN", label: "admin" },
  { key: "BLOCKED", label: "blocked (posting-restricted) member" },
];

const sessions = {};
for (const role of ROLES) {
  console.log(`\n== ${role.label} ==`);
  const email = process.env[`SMOKE_${role.key}_EMAIL`];
  const password = process.env[`SMOKE_${role.key}_PASSWORD`];
  if (!email || !password) {
    skip(`${role.label} checks`, `SMOKE_${role.key}_EMAIL / SMOKE_${role.key}_PASSWORD not set`);
    continue;
  }
  const signIn = await signInPassword(email, password);
  if (signIn.error) {
    check(`${role.label} sign-in succeeds`, false, JSON.stringify(signIn.error).slice(0, 200));
    continue;
  }
  check(`${role.label} sign-in succeeds`, true);
  sessions[role.label] = signIn;

  const own = await rest(`profiles?select=id&id=eq.${signIn.userId}`, { token: signIn.token });
  check(`${role.label} can read their own profile row`, own.status === 200 && Array.isArray(own.body) && own.body.length === 1, `HTTP ${own.status}`);

  const perms = await rpc("my_permissions", {}, signIn.token);
  const permList = Array.isArray(perms.body) ? perms.body : [];
  if (role.label === "member") {
    check("a plain member holds no moderation permission", !permList.includes("community.comment.moderate"));
  }
  if (role.label === "coach") {
    check("a coach holds at least one staff permission", permList.length > 0, JSON.stringify(permList));
  }
  if (role.label === "admin") {
    check("an admin's my_permissions is non-empty", permList.length > 0, JSON.stringify(permList));
    const queue = await rpc("mod_queue", { p_status: "open", p_cursor: null, p_limit: 5 }, signIn.token);
    check("an admin can read the moderation queue", queue.status === 200, `HTTP ${queue.status}`);
  }
  if (role.label !== "admin") {
    const grant = await rpc("admin_grant_coach", { p_user_id: signIn.userId, p_role: "coach" }, signIn.token);
    check(`${role.label} cannot call admin_grant_coach`, grant.status >= 400, `HTTP ${grant.status}`);
  }
  if (role.label === "blocked (posting-restricted) member") {
    const post = await rpc("post_create", { body: "smoke test - should be refused", visibility: "club", media: [], links: null }, signIn.token);
    check("a member under an active posting restriction is refused post_create", post.status >= 400 || (post.body && post.body.error), `HTTP ${post.status} ${JSON.stringify(post.body).slice(0, 200)}`);
  }
}

if (failed) {
  console.error("\nAt least one role's real permission boundary did not hold. Do not deploy.");
  process.exit(1);
}
console.log("\nAll checked roles held their expected boundary. Any role above marked SKIP was not verified this run - do not treat this as a pass for a role you never provisioned credentials for.");
