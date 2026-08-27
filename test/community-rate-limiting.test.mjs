// Independent security review: no table beyond invite redemption had any
// rate limiting - reactions, post_comments, and reports all accepted
// inserts at whatever rate the client sent, bounded only by RLS
// ownership checks, never volume. Combined with anonymous sign-in
// costing an attacker nothing, a single leaked invite code was enough
// for unlimited spam. Moved all three behind a security definer RPC
// (same pattern redeem_invite_code already used) that checks a shared
// rate_limits table before writing, and revoked the client's direct
// INSERT grant on all three tables so the RPC can't be bypassed.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const sql = fs.readFileSync(new URL("../supabase/migrations/202608270010_rate_limiting.sql", import.meta.url), "utf8");
const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

test("rate_limits table exists, RLS-enabled, with no client grant at all - only reachable through check_rate_limit()", () => {
  assert.match(sql, /create table public\.rate_limits/);
  assert.match(sql, /alter table public\.rate_limits enable row level security/);
  assert.match(sql, /revoke all on public\.rate_limits from public, anon, authenticated/);
});

test("check_rate_limit() is not directly callable by any client role", () => {
  assert.match(sql, /revoke all on function public\.check_rate_limit\(text, integer, integer\) from public, anon, authenticated;/);
});

test("comments, reactions, and reports each move behind a security definer RPC that checks the rate limit before writing", () => {
  assert.match(sql, /create or replace function public\.add_post_comment\(p_post_id uuid, p_body text\) returns uuid/);
  assert.match(sql, /create or replace function public\.toggle_reaction\(p_post_id uuid\) returns boolean/);
  assert.match(sql, /create or replace function public\.submit_report\(p_post_id uuid, p_reason text default 'inappropriate'\) returns void/);
  for (const fn of ["add_post_comment", "toggle_reaction", "submit_report"]) {
    const fnStart = sql.indexOf(`function public.${fn}(`);
    const fnEnd = sql.indexOf("$$;", fnStart);
    const body = sql.slice(fnStart, fnEnd);
    assert.match(body, /if not public\.check_rate_limit\(/, `${fn} must check the rate limit before writing`);
  }
});

test("the direct INSERT grant is revoked on all three tables, so the RPC can't be bypassed by calling .insert() directly", () => {
  assert.match(sql, /revoke insert on public\.post_comments from authenticated;/);
  assert.match(sql, /revoke insert on public\.reactions from authenticated;/);
  assert.match(sql, /revoke insert on public\.reports from authenticated;/);
});

test("cloud.js calls the new RPCs instead of writing to the tables directly, and surfaces a rate-limited message", () => {
  assert.match(cloudJs, /client\.rpc\("add_post_comment", \{ p_post_id: postId, p_body: body \}\)/);
  assert.match(cloudJs, /client\.rpc\("toggle_reaction", \{ p_post_id: postId \}\)/);
  assert.match(cloudJs, /client\.rpc\("submit_report", \{ p_post_id: postId \}\)/);
  assert.doesNotMatch(cloudJs, /\.from\("post_comments"\)\.insert\(/);
  assert.doesNotMatch(cloudJs, /\.from\("reactions"\)\.insert\(/);
  assert.doesNotMatch(cloudJs, /\.from\("reports"\)\.insert\(/);
  const rateLimitedMessages = (cloudJs.match(/error\.message === "rate_limited"/g) || []).length;
  assert.equal(rateLimitedMessages, 3, "all three (comment, reaction, report) should check for the rate_limited exception");
});
