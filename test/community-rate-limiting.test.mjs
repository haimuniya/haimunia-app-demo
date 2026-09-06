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
  // COMM-121 wired the parent argument through; a later bug fix added
  // p_mentions so this resolves to the real 4-arg overload that actually
  // writes comment_mentions (the 3-arg form silently dropped every
  // mention's notification - see community-engagement-cluster.test.mjs's
  // own regression test for that). The two-argument wrapper still exists
  // in SQL for any older caller (asserted above), but the client uses the
  // 4-arg one.
  // Both of these now go through communityRpc() rather than client.rpc()
  // directly (launch-readiness audit, RELIABILITY): it attaches a
  // p_idempotency_key and, when the request cannot reach the network,
  // persists the write to the community outbox instead of dropping it.
  // communityRpc() itself calls client.rpc() with the same argument object,
  // so the property this test actually cares about - "the client goes
  // through the guarded RPC and never inserts into the table directly" - is
  // unchanged, and the doesNotMatch assertions below still pin it.
  assert.match(cloudJs, /communityRpc\("add_post_comment", \{ p_post_id: postId, p_body: resolved\.stored, p_parent_comment_id: parentCommentId \|\| null, p_mentions: resolved\.mentions\.map\(\(m\) => m\.user_id\) \}\)/);
  assert.match(cloudJs, /communityRpc\("toggle_reaction", \{ p_post_id: postId \}\)/);
  // And communityRpc really does reach client.rpc under the hood, so the
  // indirection above is not hiding a table write.
  assert.match(cloudJs, /async function communityRpc\([\s\S]{0,900}?await client\.rpc\(action, withKey\)/);
  // COMM-151 replaced submit_report with report(p_target_type, p_target_id,
  // p_reason, p_note), so a comment can be reported too. The two-argument
  // submit_report still exists in SQL (asserted above) for any older caller.
  assert.match(cloudJs, /client\.rpc\("report", \{\s*p_target_type: s\.targetType,/);
  assert.doesNotMatch(cloudJs, /\.from\("post_comments"\)\.insert\(/);
  assert.doesNotMatch(cloudJs, /\.from\("reactions"\)\.insert\(/);
  assert.doesNotMatch(cloudJs, /\.from\("reports"\)\.insert\(/);
  // comment (create), reaction, report, and COMM-122's comment_edit each
  // recognise the rate_limited exception and show a clear message.
  const rateLimitedMessages = (cloudJs.match(/=== "rate_limited"/g) || []).length;
  assert.ok(rateLimitedMessages >= 3, "comment, reaction and report each surface the rate_limited exception");
});
