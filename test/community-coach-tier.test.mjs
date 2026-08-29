import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const sql = fs.readFileSync(new URL("../supabase/migrations/202608270005_coach_tier.sql", import.meta.url), "utf8");
const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

test("cloud.js's isStaff() matches is_staff()'s server-side rule: admin OR a coach-rank redemption", () => {
  // COMM-156 exposed head_coach, which is coach rank or above server-side,
  // so isStaff() recognises it too.
  assert.match(cloudJs, /function isStaff\(\) \{ return !!\(state\.profile && \(state\.profile\.is_admin \|\| \(state\.redemption && \(state\.redemption\.role === "coach" \|\| state\.redemption\.role === "head_coach"\)\)\)\); \}/);
});

test("all four staff-only render gates (announcements composer, challenge setter, new/inactive members) use isStaff(), not a raw is_admin check", () => {
  const renderFn = cloudJs.slice(cloudJs.indexOf("window.renderCommunityApp = function"), cloudJs.indexOf("window.cloudStorageStatusText"));
  assert.doesNotMatch(renderFn, /state\.profile\.is_admin/, "the render function must not check is_admin directly anymore, only through isStaff()");
  assert.match(renderFn, /const staff = isStaff\(\);/);
  const staffGates = (renderFn.match(/\bstaff \?/g) || []).length;
  assert.equal(staffGates, 4, "expected exactly 4 staff-gated sections: announcements composer, challenge setter, new members, inactive members");
});

test("is_staff() checks the caller's own admin flag or coach redemption only, and is locked away from anon", () => {
  const fn = sql.slice(sql.indexOf("create or replace function public.is_staff"), sql.indexOf("drop policy announcements_insert_admin"));
  assert.match(fn, /exists \(select 1 from public\.profiles where id = p_uid and is_admin and deleted_at is null\)/i);
  assert.match(fn, /exists \(select 1 from public\.invite_redemptions where user_id = p_uid and role = 'coach'\)/i);
  assert.match(fn, /revoke all on function public\.is_staff\(uuid\) from public, anon/i);
  assert.match(fn, /grant execute on function public\.is_staff\(uuid\) to authenticated/i);
});

test("announcements and weekly_challenges insert/update policies now check is_staff(), not a raw is_admin exists()", () => {
  assert.match(sql, /create policy announcements_insert_admin on public\.announcements for insert to authenticated\s*\n\s*with check \(author_id = auth\.uid\(\) and public\.is_staff\(\)\)/i);
  assert.match(sql, /create policy announcements_update_admin on public\.announcements for update to authenticated\s*\n\s*using \(public\.is_staff\(\)\) with check \(public\.is_staff\(\)\)/i);
  assert.match(sql, /create policy weekly_challenges_insert_admin on public\.weekly_challenges for insert to authenticated\s*\n\s*with check \(created_by = auth\.uid\(\) and public\.is_staff\(\)\)/i);
});

test("coach_inactive_members and coach_new_members now self-gate on is_staff(), not a raw is_admin check", () => {
  const inactive = sql.slice(sql.indexOf("create or replace function public.coach_inactive_members"), sql.indexOf("create or replace function public.coach_new_members"));
  const newMembers = sql.slice(sql.indexOf("create or replace function public.coach_new_members"));
  assert.match(inactive, /if not public\.is_staff\(auth\.uid\(\)\) then\s*\n\s*raise exception/i);
  assert.match(newMembers, /if not public\.is_staff\(auth\.uid\(\)\) then\s*\n\s*raise exception/i);
});
