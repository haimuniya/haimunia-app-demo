import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const sql = fs.readFileSync(new URL("../supabase/migrations/202608270001_community_growth.sql", import.meta.url), "utf8");

test("reactions policies now gate on post_visible_to_viewer, not just row existence", () => {
  assert.match(sql, /create policy reactions_visible on public\.reactions for select to authenticated using \(public\.post_visible_to_viewer\(post_id\)\)/i);
  assert.match(sql, /create policy reactions_insert_self on public\.reactions for insert to authenticated with check \(user_id = auth\.uid\(\) and public\.post_visible_to_viewer\(post_id\)\)/i);
  assert.match(sql, /and \(p\.author_id = auth\.uid\(\) or p\.visibility = 'public' or \(p\.visibility = 'followers'/i);
});

test("workout_posts accepts 'achievement' as a source_type", () => {
  assert.match(sql, /add constraint workout_posts_source_type_check check \(source_type in \('strength_entry', 'wod_entry', 'achievement'\)\)/i);
});

test("announcements are admin-write, all-member-read, and RLS is on", () => {
  assert.match(sql, /alter table public\.announcements enable row level security/i);
  assert.match(sql, /create policy announcements_read on public\.announcements for select to authenticated using \(deleted_at is null\)/i);
  assert.match(sql, /announcements_insert_admin[\s\S]*p\.is_admin/i);
  assert.match(sql, /announcements_update_admin[\s\S]*p\.is_admin/i);
});

test("activity_pings is RLS-enabled and self-scoped only, never widened to authenticated-at-large", () => {
  assert.match(sql, /alter table public\.activity_pings enable row level security/i);
  assert.match(sql, /create policy activity_pings_self_select on public\.activity_pings for select to authenticated using \(user_id = auth\.uid\(\)\)/i);
  assert.match(sql, /create policy activity_pings_self_insert on public\.activity_pings for insert to authenticated with check \(user_id = auth\.uid\(\)\)/i);
});

test("community_streaks is not security_invoker, so it can aggregate across everyone's private activity_pings rows", () => {
  const viewStart = sql.indexOf("create or replace view public.community_streaks");
  assert.ok(viewStart > -1);
  const viewBlock = sql.slice(viewStart, sql.indexOf("grant select on public.community_streaks"));
  assert.ok(!/security_invoker/i.test(viewBlock), "this view must run with definer rights to see every user's streak, not just the caller's own");
});

test("coach_inactive_members self-gates to admins and is locked away from anon", () => {
  assert.match(sql, /if not exists \(select 1 from public\.profiles where id = auth\.uid\(\) and is_admin and deleted_at is null\) then\s*raise exception/i);
  assert.match(sql, /revoke all on function public\.coach_inactive_members\(date\) from public, anon/i);
  assert.match(sql, /grant execute on function public\.coach_inactive_members\(date\) to authenticated/i);
});

test("weekly_challenges is admin-write, all-member-read, and its leaderboard view reuses post visibility rules", () => {
  assert.match(sql, /alter table public\.weekly_challenges enable row level security/i);
  assert.match(sql, /create policy weekly_challenges_read on public\.weekly_challenges for select to authenticated using \(true\)/i);
  assert.match(sql, /weekly_challenges_insert_admin[\s\S]*p\.is_admin/i);
  assert.match(sql, /create or replace view public\.weekly_challenge_leaderboard with \(security_invoker = true\)/i);
});
