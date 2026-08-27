// Requested directly: "we need to manage the users, by ID + user name...
// currently its not working" - there was no in-app way to look up a
// member or change their role/remove them short of the Supabase SQL
// editor. Admin-only search by handle/name or an exact pasted user id,
// backed by a dedicated RPC (matching the same is_admin-only pattern as
// review_report/the moderation visibility policy, not the broader
// coach-inclusive is_staff()) since invite_redemptions and
// activity_pings aren't readable cross-user otherwise. Also asked for
// directly: "i also need user + id in the siupbase" - a dashboard-only
// view (admin_user_directory) for browsing id<->handle<->role directly
// in the Supabase SQL/Table editor, no grants to the app's own API roles.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const sql = fs.readFileSync(new URL("../supabase/migrations/202608270011_admin_member_management.sql", import.meta.url), "utf8");
const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

test("every admin member-management RPC checks real is_admin, not the broader is_staff()", () => {
  for (const fn of ["admin_search_members(p_query text)", "admin_grant_coach(p_user_id uuid)", "admin_revoke_coach(p_user_id uuid)", "admin_remove_member(p_user_id uuid)"]) {
    const start = sql.indexOf(`function public.${fn}`);
    assert.ok(start > -1, `${fn} must exist`);
    const end = sql.indexOf("$$;", start);
    const body = sql.slice(start, end);
    assert.match(body, /exists \(select 1 from public\.profiles where id = auth\.uid\(\) and is_admin and deleted_at is null\)/, `${fn} must check real is_admin`);
    assert.doesNotMatch(body, /public\.is_staff\(\)/, `${fn} must not accept the broader coach-inclusive is_staff()`);
  }
});

test("admin_search_members matches by exact user id OR partial handle/display-name, and only ever returns non-deleted profiles", () => {
  const start = sql.indexOf("function public.admin_search_members");
  const body = sql.slice(start, sql.indexOf("$$;", start));
  assert.match(body, /p\.id::text = p_query/);
  assert.match(body, /p\.handle ilike '%' \|\| p_query \|\| '%'/);
  assert.match(body, /p\.deleted_at is null/);
});

test("admin_remove_member mirrors request_account_deletion()'s own effect and can't be used to remove yourself", () => {
  const start = sql.indexOf("function public.admin_remove_member");
  const body = sql.slice(start, sql.indexOf("$$;", start));
  assert.match(body, /if p_user_id = auth\.uid\(\) then raise exception/);
  assert.match(body, /insert into public\.account_deletion_requests/);
  assert.match(body, /update public\.profiles set deleted_at = now\(\) where id = p_user_id/);
  assert.match(body, /update public\.workout_posts set deleted_at = now\(\) where author_id = p_user_id/);
});

test("admin_user_directory is a dashboard-only view with zero grants to any client-reachable role", () => {
  assert.match(sql, /create or replace view public\.admin_user_directory as/);
  assert.match(sql, /join auth\.users u on u\.id = p\.id/);
  assert.match(sql, /revoke all on public\.admin_user_directory from public, anon, authenticated;/);
});

test("cloud.js wires search, grant/revoke coach, and remove-member through the RPCs and the shared confirm dialog for the elevating/destructive ones", () => {
  assert.match(cloudJs, /client\.rpc\("admin_search_members", \{ p_query: q \}\)/);
  assert.match(cloudJs, /client\.rpc\("admin_grant_coach", \{ p_user_id: userId \}\)/);
  assert.match(cloudJs, /client\.rpc\("admin_revoke_coach", \{ p_user_id: userId \}\)/);
  assert.match(cloudJs, /client\.rpc\("admin_remove_member", \{ p_user_id: userId \}\)/);
  // Granting coach (elevates privilege) and removing a member
  // (destructive) both go through askConfirm; revoking (only ever
  // lowers privilege) doesn't need to.
  assert.match(cloudJs, /askConfirm\(\{ title: "הענקת הרשאת מאמן\/ת".*action: "admin-grant-coach"/);
  assert.match(cloudJs, /askConfirm\(\{ title: "הסרת חבר\/ה".*action: "admin-remove-member"/);
  assert.doesNotMatch(cloudJs, /action === "admin-revoke-coach"\) askConfirm/, "revoking coach only ever lowers privilege - it shouldn't need a confirm dialog");
});

test("removing a member is marked destructive in its confirm dialog", () => {
  assert.match(cloudJs, /action: "admin-remove-member", payload: \{ userId: el\.dataset\.id \} \}\)/);
  const start = cloudJs.indexOf('action === "admin-remove-member") askConfirm(');
  const end = cloudJs.indexOf(");", start);
  const block = cloudJs.slice(start, end);
  assert.match(block, /destructive: true/);
});

test("the admin member search input is wired with a live \"input\" listener, matching the fix already applied to the people search", () => {
  assert.match(cloudJs, /adminInput\.addEventListener\("input", \(\) => searchMembers\(adminInput\.value\)\)/);
});
