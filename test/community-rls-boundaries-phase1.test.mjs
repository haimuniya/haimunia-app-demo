// COMM-191 coverage sweep finding. test/community-rls-boundaries.test.mjs
// (COMM-019) pins the Phase 0 migrations (202608280001..202608280013) only,
// by its own header. The "Phase 1 schema handoff for qa" section of
// docs/community/backlog.md lays out the same kind of boundary list for
// migrations 202608280014..202608280028 (schema follow-up runs 1-3), and
// nothing in the repo pins any of it yet: not a static assertion here, and
// not a pgTAP file under supabase/tests/, which only goes up to
// 0013_invite_actor_throttle_test.sql. Five new tables shipped with zero
// RLS test of either kind before this file: hidden_posts, saved_posts,
// posting_restrictions, pins, notification_batches.
//
// WHAT THIS FILE VERIFIES
// The same thing COMM-019 verified for Phase 0: policy, grant, and
// constraint DEFINITIONS in the migration SQL, so a later edit that widens
// exposure fails CI. It is deliberately narrower than the full backlog
// handoff table per migration - it covers every new table's RLS shape
// (RLS on, the exact grant list, the exact policies) plus the handful of
// function-grant assertions the backlog calls out as the ones that matter
// most (report/post_delete/comment_moderate/mod_queue/mod_review/
// admin_grant_coach, and notif_create being unreachable by any client role).
//
// WHAT THIS FILE DOES NOT VERIFY
// Runtime enforcement for two real Postgres roles - same limitation as
// COMM-019, same reason (test/helpers/mockSupabase.mjs has no policy
// engine). It also does not cover every behavioural assertion in the
// backlog's Phase 1 schema handoff section (rate limits, idempotency,
// trigger fan-out, dedupe windows, the pin-slot race, comment thread depth,
// ach_claim's code filtering...). Closing that gap needs a pgTAP suite for
// 202608280014..202608280028, the same shape as supabase/tests/0001..0013,
// which is a follow-up on the scale of COMM-020 and out of this sweep's
// budget - flagged in the COMM-191 report rather than attempted here.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

function migration(n) {
  return fs.readFileSync(new URL(`../supabase/migrations/${n}.sql`, import.meta.url), "utf8");
}

const m14 = migration("202608280014_hidden_and_saved_posts");
const m15 = migration("202608280015_posting_restrictions");
const m17 = migration("202608280017_pins");
const m18 = migration("202608280018_notification_batches");
const m25 = migration("202608280025_moderation_reshape");
const m26 = migration("202608280026_notif_create");

// ---------------------------------------------------------------------------
// 202608280014 - hidden_posts, saved_posts
// ---------------------------------------------------------------------------

test("hidden_posts [faithful]: RLS on, revoke-all then select+insert+delete only (no update grant anywhere), strictly own-row", () => {
  assert.match(m14, /alter table public\.hidden_posts enable row level security;/);
  assert.match(m14, /revoke all on public\.hidden_posts, public\.saved_posts from public, anon;/);
  assert.match(m14, /grant select, insert, delete on public\.hidden_posts to authenticated;/);
  assert.doesNotMatch(m14, /grant update on public\.hidden_posts/);
  assert.match(m14, /create policy hidden_posts_self_select on public\.hidden_posts for select to authenticated\s*\n\s*using \(user_id = auth\.uid\(\)\);/);
  assert.match(m14, /create policy hidden_posts_self_delete on public\.hidden_posts for delete to authenticated\s*\n\s*using \(user_id = auth\.uid\(\)\);/);
});

test("hidden_posts [faithful]: insert is gated on self, community membership, and viewer visibility of the target post - a hide can never be an existence oracle", () => {
  assert.match(
    m14,
    /create policy hidden_posts_self_insert on public\.hidden_posts for insert to authenticated\s*\n\s*with check \(\s*\n\s*user_id = auth\.uid\(\)\s*\n\s*and public\.is_community_member\(\)\s*\n\s*and public\.post_visible_to_viewer\(post_id\)\s*\n\s*\);/,
  );
});

test("saved_posts [faithful]: same shape as hidden_posts, plus a primary key that collapses a repeat save instead of a second row", () => {
  assert.match(m14, /alter table public\.saved_posts enable row level security;/);
  assert.match(m14, /grant select, insert, delete on public\.saved_posts to authenticated;/);
  assert.doesNotMatch(m14, /grant update on public\.saved_posts/);
  assert.match(m14, /create policy saved_posts_self_select on public\.saved_posts for select to authenticated\s*\n\s*using \(user_id = auth\.uid\(\)\);/);
  assert.match(
    m14,
    /create policy saved_posts_self_insert on public\.saved_posts for insert to authenticated\s*\n\s*with check \(\s*\n\s*user_id = auth\.uid\(\)\s*\n\s*and public\.is_community_member\(\)\s*\n\s*and public\.post_visible_to_viewer\(post_id\)\s*\n\s*\);/,
  );
  assert.match(m14, /primary key \(user_id, post_id\)/);
});

// ---------------------------------------------------------------------------
// 202608280015 - posting_restrictions
// ---------------------------------------------------------------------------

test("posting_restrictions [faithful]: RLS on, select is the ONLY grant - no insert/update/delete grant or policy for anyone, moderator included", () => {
  assert.match(m15, /alter table public\.posting_restrictions enable row level security;/);
  assert.match(m15, /revoke all on public\.posting_restrictions from public, anon;/);
  assert.match(m15, /grant select on public\.posting_restrictions to authenticated;/);
  assert.doesNotMatch(m15, /grant insert on public\.posting_restrictions/);
  assert.doesNotMatch(m15, /grant update on public\.posting_restrictions/);
  assert.doesNotMatch(m15, /grant delete on public\.posting_restrictions/);
  assert.doesNotMatch(m15, /for insert on public\.posting_restrictions/);
  assert.doesNotMatch(m15, /for update on public\.posting_restrictions/);
  assert.doesNotMatch(m15, /for delete on public\.posting_restrictions/);
});

test("posting_restrictions [faithful]: read policy is own row, or a member.restrict / comment.moderate holder", () => {
  assert.match(
    m15,
    /create policy posting_restrictions_read on public\.posting_restrictions for select to authenticated using \(\s*\n\s*user_id = auth\.uid\(\)\s*\n\s*or public\.has_perm\('community\.member\.restrict'\)\s*\n\s*or public\.has_perm\('community\.comment\.moderate'\)\s*\n\s*\);/,
  );
});

test("posting_restrictions [faithful]: the expiry/type CHECKs pin temporary<->has-expiry and permanent<->no-expiry together", () => {
  assert.match(
    m15,
    /constraint posting_restrictions_expiry_matches_type check \(\s*\n\s*\(restriction_type = 'temporary' and expires_at is not null\)\s*\n\s*or \(restriction_type = 'permanent' and expires_at is null\)\s*\n\s*\)/,
  );
});

test("posting_restrictions [faithful]: the only write path is mod_restrict_member/mod_lift_restriction, both revoked from anon and both check community.member.restrict", () => {
  assert.match(m15, /revoke all on function public\.mod_restrict_member\(uuid, text, timestamptz, text, uuid\) from public, anon;/);
  assert.match(m15, /grant execute on function public\.mod_restrict_member\(uuid, text, timestamptz, text, uuid\) to authenticated;/);
  assert.match(m15, /revoke all on function public\.mod_lift_restriction\(uuid, text\) from public, anon;/);
  assert.match(m15, /grant execute on function public\.mod_lift_restriction\(uuid, text\) to authenticated;/);
  assert.match(m15, /if not public\.has_perm\('community\.member\.restrict'\) then raise exception 'not authorized'; end if;/g);
  // Every restriction write calls log_admin_action - the whole reason the
  // table itself carries no write grant.
  const restrictFn = m15.slice(m15.indexOf("function public.mod_restrict_member"), m15.indexOf("function public.mod_lift_restriction"));
  assert.match(restrictFn, /perform public\.log_admin_action\(\s*\n\s*'member_restrict'/);
});

test("posting_restrictions [faithful]: is_posting_restricted is SECURITY DEFINER, raises for a plain member asking about someone else", () => {
  assert.match(m15, /create or replace function public\.is_posting_restricted\(p_user uuid default null\) returns boolean\s*\nlanguage plpgsql stable security definer/);
  assert.match(
    m15,
    /if v_target <> v_uid\s*\n\s*and not public\.has_perm\('community\.member\.restrict'\)\s*\n\s*and not public\.has_perm\('community\.comment\.moderate'\) then\s*\n\s*raise exception 'not authorized';/,
  );
});

test("posting_restrictions [faithful]: post insert is refused for a restricted member - posts_insert_self now carries is_posting_restricted", () => {
  assert.match(
    m15,
    /create policy posts_insert_self on public\.workout_posts for insert to authenticated with check \(\s*\n\s*author_id = auth\.uid\(\)\s*\n\s*and public\.is_community_member\(\)\s*\n\s*and public\.has_perm\('community\.post\.create'\)\s*\n\s*and not public\.is_posting_restricted\(auth\.uid\(\)\)\s*\n\s*\);/,
  );
});

// ---------------------------------------------------------------------------
// 202608280017 - pins
// ---------------------------------------------------------------------------

test("pins [faithful]: RLS on, select is the ONLY grant and the only policy - a community.content.pin holder still cannot write directly", () => {
  assert.match(m17, /alter table public\.pins enable row level security;/);
  assert.match(m17, /revoke all on public\.pins from public, anon;/);
  assert.match(m17, /grant select on public\.pins to authenticated;/);
  assert.match(m17, /create policy pins_read on public\.pins for select to authenticated using \(true\);/);
  assert.doesNotMatch(m17, /grant insert on public\.pins/);
  assert.doesNotMatch(m17, /grant update on public\.pins/);
  assert.doesNotMatch(m17, /grant delete on public\.pins/);
  assert.doesNotMatch(m17, /for insert on public\.pins/);
});

test("pins [faithful]: the hard 3-slot cap is a unique constraint, not a counting trigger - immune to a concurrent-insert race", () => {
  assert.match(m17, /slot smallint not null check \(slot between 0 and 2\)/);
  assert.match(m17, /unique \(club_id, slot\)/);
  assert.match(m17, /unique \(club_id, target_type, target_id\)/);
});

test("pin_set/pin_clear [faithful]: revoked from public/anon, granted to authenticated, and pin_set checks community.content.pin before touching a row", () => {
  assert.match(m17, /revoke all on function public\.pin_set\(text, uuid, text\) from public, anon;/);
  assert.match(m17, /grant execute on function public\.pin_set\(text, uuid, text\) to authenticated;/);
  assert.match(m17, /revoke all on function public\.pin_clear\(text, uuid\) from public, anon;/);
  assert.match(m17, /grant execute on function public\.pin_clear\(text, uuid\) to authenticated;/);
  assert.match(m17, /if not public\.has_perm\('community\.content\.pin'\) then raise exception 'not authorized'; end if;/);
  assert.match(m17, /if v_slot is null then raise exception 'pin_limit_reached'; end if;/);
});

// ---------------------------------------------------------------------------
// 202608280018 - notification_batches
// ---------------------------------------------------------------------------

test("notification_batches [faithful]: RLS on, select is the ONLY grant - a member cannot reach into their own batch and move next_flush_at up", () => {
  assert.match(m18, /alter table public\.notification_batches enable row level security;/);
  assert.match(m18, /revoke all on public\.notification_batches from public, anon;/);
  assert.match(m18, /grant select on public\.notification_batches to authenticated;/);
  assert.match(m18, /create policy notification_batches_self_select on public\.notification_batches for select to authenticated/);
  assert.doesNotMatch(m18, /grant insert on public\.notification_batches/);
  assert.doesNotMatch(m18, /grant update on public\.notification_batches/);
  assert.doesNotMatch(m18, /grant delete on public\.notification_batches/);
});

test("notif_queue_batched/notif_batch_flushed [faithful]: revoked from anon AND authenticated - server-side only, not just anon-gated", () => {
  assert.match(m18, /revoke all on function public\.notif_queue_batched\(uuid, text, text, uuid\) from public, anon, authenticated;/);
  assert.match(m18, /revoke all on function public\.notif_batch_flushed\(uuid, text\) from public, anon, authenticated;/);
});

test("notification_batch_window [faithful]: granted to authenticated (read-only helper), returns the documented 6-hour default", () => {
  assert.match(m18, /grant execute on function public\.notification_batch_window\(\) to authenticated;/);
  assert.match(m18, /select interval '6 hours';/);
});

// ---------------------------------------------------------------------------
// 202608280025 - moderation reshape (functions only, no new table)
// ---------------------------------------------------------------------------

test("report/post_delete/comment_moderate/mod_queue/mod_review/admin_grant_coach(uuid,text) [faithful]: every one is revoked from anon and granted to authenticated only", () => {
  assert.match(m25, /revoke all on function public\.report\(text, uuid, text, text\) from public, anon;/);
  assert.match(m25, /grant execute on function public\.report\(text, uuid, text, text\) to authenticated;/);
  assert.match(m25, /revoke all on function public\.post_delete\(uuid\) from public, anon;/);
  assert.match(m25, /grant execute on function public\.post_delete\(uuid\) to authenticated;/);
  assert.match(m25, /revoke all on function public\.comment_moderate\(uuid, text\) from public, anon;/);
  assert.match(m25, /grant execute on function public\.comment_moderate\(uuid, text\) to authenticated;/);
  assert.match(m25, /revoke all on function public\.mod_queue\(text, timestamptz, integer\) from public, anon;/);
  assert.match(m25, /grant execute on function public\.mod_queue\(text, timestamptz, integer\) to authenticated;/);
  assert.match(m25, /revoke all on function public\.mod_review\(uuid, text, text, timestamptz\) from public, anon;/);
  assert.match(m25, /grant execute on function public\.mod_review\(uuid, text, text, timestamptz\) to authenticated;/);
  assert.match(m25, /revoke all on function public\.admin_grant_coach\(uuid, text\) from public, anon;/);
  assert.match(m25, /grant execute on function public\.admin_grant_coach\(uuid, text\) to authenticated;/);
});

test("post_delete [faithful]: a non-author needs post.delete_any OR comment.moderate OR a real is_admin profile row", () => {
  const fn = m25.slice(m25.indexOf("function public.post_delete"), m25.indexOf("revoke all on function public.post_delete"));
  assert.match(
    fn,
    /public\.has_perm\('community\.post\.delete_any'\)\s*\n\s*or public\.has_perm\('community\.comment\.moderate'\)\s*\n\s*or exists \(select 1 from public\.profiles where id = v_uid and is_admin and deleted_at is null\)/,
  );
});

test("admin_grant_coach(uuid,text) [faithful]: p_role is constrained to coach or head_coach, anything else raises", () => {
  const fn = m25.slice(m25.indexOf("function public.admin_grant_coach(p_user_id uuid, p_role text)"), m25.indexOf("function public.admin_grant_coach(p_user_id uuid) returns void"));
  assert.match(fn, /if p_role not in \('coach', 'head_coach'\) then/);
});

// ---------------------------------------------------------------------------
// 202608280026 - notif_create (functions only, no new table)
// ---------------------------------------------------------------------------

test("notif_create [faithful]: revoked from public, anon, AND authenticated - no client role, staff included, can call it directly", () => {
  assert.match(
    m26,
    /revoke all on function public\.notif_create\(uuid, text, text, text, text, text, uuid, text\)\s*\n\s*from public, anon, authenticated;/,
  );
});
