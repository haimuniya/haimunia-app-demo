// Launch-readiness audit, follow-up. THE REGRESSION GUARD FOR A BUG THIS
// AUDIT ITSELF SHIPPED AND ALMOST DEPLOYED.
//
// WHAT HAPPENED. communityRpc() attaches a p_idempotency_key to every action
// in OUTBOX_ACTIONS. 202609060014 added that parameter to four of the five
// SQL functions and missed event_rsvp, so every RSVP became:
//
//   PGRST202 "Could not find the function
//             public.event_rsvp(p_event_id, p_idempotency_key, p_response)"
//
// PostgREST resolves overloads by the EXACT set of named arguments - an
// extra one is not ignored, it fails to resolve. RSVP would have been
// completely dead on deploy.
//
// WHY ALL THREE SUITES WERE GREEN ON IT. pgTAP calls the functions directly
// in SQL, where the client's extra argument does not exist. The browser
// scenario goes through mockCloud.mjs, whose rpc() stand-in accepts any
// argument shape. The node tests assert source text. Nothing crossed the
// client's call shape against the server's real signature - which is the
// seam this file now covers.
//
// It was found by curling the real PostgREST endpoint. This test is the
// cheap, always-on version of that check.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cloudJs = fs.readFileSync(path.join(root, "cloud.js"), "utf8");
const migrationsDir = path.join(root, "supabase", "migrations");

// Every migration, newest last, so a later re-declaration wins - the same
// order Postgres applies them in.
const migrationSql = fs
  .readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => fs.readFileSync(path.join(migrationsDir, f), "utf8"))
  .join("\n");

function outboxActions() {
  const m = cloudJs.match(/const OUTBOX_ACTIONS = \[([^\]]+)\]/);
  assert.ok(m, "OUTBOX_ACTIONS must still be declared in cloud.js");
  return m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

test("communityRpc attaches p_idempotency_key to every queued action", () => {
  // This is the premise the rest of the file rests on. If the client stops
  // sending the key unconditionally, the contract below changes shape.
  assert.match(
    cloudJs,
    /const withKey = key \? Object\.assign\(\{\}, args, \{ p_idempotency_key: key \}\) : Object\.assign\(\{\}, args\);/,
    "communityRpc must still attach the key to every call it makes",
  );
});

test("every OUTBOX_ACTION has a SQL function that accepts p_idempotency_key", () => {
  const actions = outboxActions();
  assert.ok(actions.length >= 5, `expected the full queued-action set, found ${actions.length}`);

  const missing = [];
  for (const action of actions) {
    // Find the LAST declaration of this function across all migrations -
    // the one that is actually live after a full apply.
    const decl = new RegExp(
      `create or replace function public\\.${action}\\s*\\(([\\s\\S]*?)\\)\\s*returns`,
      "gi",
    );
    let last = null, m;
    while ((m = decl.exec(migrationSql)) !== null) last = m[1];
    if (!last) { missing.push(`${action}: no CREATE FUNCTION found at all`); continue; }
    if (!/p_idempotency_key/.test(last)) {
      missing.push(`${action}: live signature has no p_idempotency_key -> PostgREST returns PGRST202 for every call the client makes`);
    }
  }
  assert.deepEqual(missing, [],
    "client/server signature mismatch - the client sends p_idempotency_key to these, and PostgREST resolves by the exact named-argument set, so the call cannot resolve");
});

test("each queued action's key parameter has a default, so an un-keyed caller still resolves", () => {
  // The old call shapes must keep working: dropping the previous overload
  // is only safe because the new parameter defaults to null.
  for (const action of outboxActions()) {
    const decl = new RegExp(
      `create or replace function public\\.${action}\\s*\\(([\\s\\S]*?)\\)\\s*returns`,
      "gi",
    );
    let last = null, m;
    while ((m = decl.exec(migrationSql)) !== null) last = m[1];
    if (!last) continue;
    assert.match(last, /p_idempotency_key\s+uuid\s+default\s+null/i,
      `${action}: p_idempotency_key must default to null, or every existing un-keyed call site breaks`);
  }
});

test("the superseded overloads are dropped, so exactly one signature answers each name", () => {
  // Two overloads that differ only by the optional key would make a
  // named-argument call ambiguous, and would leave an un-guarded path alive.
  for (const [action, oldSig] of [
    ["post_create", "text, public.post_visibility, jsonb, jsonb"],
    ["add_post_comment", "uuid, text, uuid, uuid\\[\\]"],
    ["chal_record_progress", "uuid, uuid, numeric, text"],
    ["toggle_reaction", "uuid"],
    ["event_rsvp", "uuid, text"],
  ]) {
    const re = new RegExp(`drop function if exists public\\.${action}\\(${oldSig}\\)`, "i");
    assert.match(migrationSql, re,
      `${action}: the pre-idempotency overload must be dropped, or both signatures stay callable`);
  }
});
