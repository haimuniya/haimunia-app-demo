// COMM-019 - one boundary assertion per new Phase 0 table.
//
// WHAT THIS FILE VERIFIES
// The policy, grant, trigger, and constraint DEFINITIONS in the Phase 0
// migration SQL (202608280001..202608280013). Each test pins the exact
// clause that makes a table's boundary hold, so a later migration or a
// hand-edit that widens exposure fails CI. That is precisely COMM-019's
// stated user outcome: "a later policy change that widens exposure fails
// CI".
//
// WHAT THIS FILE DOES NOT VERIFY
// That Postgres enforces any of it at runtime, for two real users, with
// RLS actually on. It cannot. test/helpers/mockSupabase.mjs is an
// in-memory JS object store: no policy engine, no roles, no auth.uid(),
// no triggers, no CHECK constraints, no partial unique indexes. A test
// that made the mock "reject" a cross-tenant read would be asserting a
// predicate re-implemented in the test file itself, not the one in the
// migration - the exact thing COMM-019's rules forbid ("No test that
// asserts a mock behavior and calls it RLS coverage").
//
// True per-role enforcement needs a real Postgres with two auth roles.
// The repo has no harness for that today. The recommendation is a pgTAP
// suite under supabase/tests/ run by the existing `migration-check` CI
// job (which already runs `supabase start`). See the skipped marker at
// the end of this file and the COMM-019 report.
//
// Coverage status per table is tracked in the COMM-019 report:
//   faithful    - the boundary is a static fact about the SQL and this
//                 file pins it completely.
//   partial     - the structural half is pinned here; the runtime half
//                 (a trigger firing, a policy denying) needs pgTAP.
//   needs-infra - only a real two-role Postgres can assert it.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

function migration(n) {
  return fs.readFileSync(new URL(`../supabase/migrations/${n}.sql`, import.meta.url), "utf8");
}

const m1 = migration("202608280001_clubs_and_rbac");
const m2 = migration("202608280002_admin_actions");
const m3 = migration("202608280003_profile_privacy_and_recovery");
const m4 = migration("202608280004_post_types_and_columns");
const m5 = migration("202608280005_post_visibility_and_media");
const m6 = migration("202608280006_feed_telemetry");
const m7 = migration("202608280007_achievements");
const m8 = migration("202608280008_notifications");
const m9 = migration("202608280009_challenges");
const m10 = migration("202608280010_events");
const m11 = migration("202608280011_coach_engagement_flags");
const m12 = migration("202608280012_analytics_events");
const m13 = migration("202608280013_invite_actor_throttle");

// Return every `create policy <name> on public.<table> <body>;` block in `sql`.
function policiesFor(sql, table) {
  const out = [];
  const re = new RegExp(`create policy \\w+ on public\\.${table} for [\\s\\S]*?;`, "g");
  let match;
  while ((match = re.exec(sql))) out.push(match[0]);
  return out;
}

// ---------------------------------------------------------------------------
// 202608280001 - clubs and RBAC
// ---------------------------------------------------------------------------

test("clubs [faithful]: RLS on, any authenticated reads the one row, only owner writes, anon revoked", () => {
  assert.match(m1, /alter table public\.clubs enable row level security/);
  assert.match(m1, /revoke all on public\.clubs[^;]*from public, anon/);
  assert.match(m1, /create policy clubs_read on public\.clubs for select to authenticated using \(true\)/);
  for (const verb of ["insert", "update", "delete"]) {
    const [p] = policiesFor(m1, "clubs").filter((x) => x.includes(`for ${verb} `));
    assert.ok(p, `clubs must have a ${verb} policy`);
    assert.match(p, /public\.my_role_code\(\) = 'owner'/, `clubs ${verb} must be owner-only`);
  }
});

test("roles [faithful]: world-readable to a member, every write path owner-only so a member cannot grant themselves a higher rank", () => {
  assert.match(m1, /alter table public\.roles enable row level security/);
  assert.match(m1, /create policy roles_read on public\.roles for select to authenticated using \(true\)/);
  const writes = policiesFor(m1, "roles").filter((p) => /for (insert|update|delete) /.test(p));
  assert.equal(writes.length, 3, "roles needs exactly insert/update/delete write policies");
  for (const p of writes) assert.match(p, /public\.my_role_code\(\) = 'owner'/);
});

test("permissions [faithful]: world-readable to a member, writes owner-only", () => {
  assert.match(m1, /alter table public\.permissions enable row level security/);
  assert.match(m1, /create policy permissions_read on public\.permissions for select to authenticated using \(true\)/);
  const writes = policiesFor(m1, "permissions").filter((p) => /for (insert|update|delete) /.test(p));
  assert.equal(writes.length, 3);
  for (const p of writes) assert.match(p, /public\.my_role_code\(\) = 'owner'/);
});

test("role_permissions [faithful]: readable to a member, writes owner-only so a member cannot attach a permission to their own role", () => {
  assert.match(m1, /alter table public\.role_permissions enable row level security/);
  assert.match(m1, /create policy role_permissions_read on public\.role_permissions for select to authenticated using \(true\)/);
  const writes = policiesFor(m1, "role_permissions").filter((p) => /for (insert|update|delete) /.test(p));
  assert.equal(writes.length, 3);
  for (const p of writes) assert.match(p, /public\.my_role_code\(\) = 'owner'/);
});

test("RBAC helpers [faithful]: has_perm/is_staff/is_admin resolve off my_role_code() and deny a null caller", () => {
  assert.match(m1, /create or replace function public\.has_perm\(p_permission text\) returns boolean/);
  assert.match(m1, /if auth\.uid\(\) is null then return false; end if;\s*\n\s*v_code := public\.my_role_code\(\);/);
  assert.match(m1, /if v_code = 'owner' then return true; end if;/);
  assert.match(m1, /create or replace function public\.is_staff\(\) returns boolean[\s\S]*?role_rank\(public\.my_role_code\(\)\) >= 20/);
  assert.match(m1, /create or replace function public\.is_admin\(\) returns boolean[\s\S]*?role_rank\(public\.my_role_code\(\)\) >= 50/);
  // my_role_code() returns null (not a member) when there is no profile.
  assert.match(m1, /if not exists \(select 1 from public\.profiles p where p\.id = v_uid and p\.deleted_at is null\) then\s*\n\s*return null;/);
});

// ---------------------------------------------------------------------------
// 202608280002 - admin_actions
// ---------------------------------------------------------------------------

test("admin_actions [faithful]: read only for a community.analytics.view holder, NO insert/update/delete policy or grant for anyone, log_admin_action not callable by authenticated", () => {
  assert.match(m2, /alter table public\.admin_actions enable row level security/);
  assert.match(m2, /revoke all on public\.admin_actions from public, anon/);
  assert.match(m2, /grant select on public\.admin_actions to authenticated;/);
  assert.doesNotMatch(m2, /grant (insert|update|delete)[^;]*public\.admin_actions/);
  assert.doesNotMatch(m2, /grant [^;]*insert[^;]*on public\.admin_actions/);
  const policies = policiesFor(m2, "admin_actions");
  assert.equal(policies.length, 1, "admin_actions must have exactly one policy");
  assert.match(policies[0], /for select to authenticated\s*\n?\s*using \(public\.has_perm\('community\.analytics\.view'\)\)/);
  assert.doesNotMatch(m2, /create policy[^;]*on public\.admin_actions for (insert|update|delete)/);
  assert.match(m2, /revoke all on function public\.log_admin_action\(text, text, uuid, jsonb, jsonb\) from public, anon, authenticated;/);
});

// ---------------------------------------------------------------------------
// 202608280003 - profiles privacy and recovery columns
// ---------------------------------------------------------------------------

test("profiles privacy columns [partial]: an authenticated own-row write cannot move is_admin, club_id, or recovery_verified_at (trigger pins them)", () => {
  const fn = m3.slice(m3.indexOf("create or replace function public.protect_is_admin()"), m3.indexOf("$$;", m3.indexOf("protect_is_admin")) + 3);
  assert.match(fn, /if auth\.role\(\) = 'authenticated' then/);
  assert.match(fn, /new\.is_admin = old\.is_admin;/);
  assert.match(fn, /new\.club_id = old\.club_id;/);
  assert.match(fn, /new\.recovery_verified_at = old\.recovery_verified_at;/);
  assert.match(fn, /current_setting\('app\.allow_recovery_stamp', true\)/);
  // The trigger binding itself lives in 202608270003 and is not re-created here.
  assert.match(migration("202608270003_invite_gate"), /create trigger profiles_protect_is_admin before update on public\.profiles/);
});

test("profiles privacy columns [faithful]: recovery_verified_at cannot be set on INSERT either (insert policy forces it null)", () => {
  assert.match(m3, /create policy profiles_insert_self on public\.profiles for insert to authenticated with check \([\s\S]*?recovery_verified_at is null[\s\S]*?\);/);
});

test("profiles privacy columns [partial]: visible_to_club=false hides the row from another member's select but never from self or a real admin", () => {
  const p = m3.slice(m3.indexOf("create policy profiles_read_authenticated"), m3.indexOf(";", m3.indexOf("create policy profiles_read_authenticated")) + 1);
  assert.match(p, /\(id = auth\.uid\(\) or visible_to_club or public\.is_admin\(\)\)/);
});

test("profiles privacy columns [partial]: a follow targeting allow_follows=false is rejected by the policy, not left to the client", () => {
  const p = m3.slice(m3.indexOf("create policy follows_insert_self"), m3.indexOf(");", m3.indexOf("create policy follows_insert_self")) + 2);
  assert.match(p, /p\.id = followed_id and p\.deleted_at is null and p\.allow_follows/);
  assert.match(p, /not exists \(\s*select 1 from public\.blocks b/);
});

test("can_view_profile_field [partial]: self is always true, a block edge returns false before any toggle is read, an unknown field raises", () => {
  const fn = m3.slice(m3.indexOf("create or replace function public.can_view_profile_field"));
  assert.match(fn, /p_field not in \(\s*'visible_to_club'[\s\S]*?\) then\s*\n\s*raise exception 'unknown profile field %', p_field;/);
  assert.match(fn, /if p_target = v_uid then return true; end if;/);
  const blockIdx = fn.indexOf("from public.blocks b");
  const toggleIdx = fn.indexOf("v_row.visible_to_club then return false");
  assert.ok(blockIdx > -1 && toggleIdx > -1 && blockIdx < toggleIdx, "the block-edge check must come before any toggle is consulted");
  assert.match(fn, /if public\.is_admin\(\) then return true; end if;/);
});

// ---------------------------------------------------------------------------
// 202608280004 / 202608280005 - workout_posts columns and post_media
// ---------------------------------------------------------------------------

test("workout_posts columns [partial]: only_me is invisible to every non-author, friends needs a mutual edge, a one-way follower is the wider legacy scope", () => {
  const p = m5.slice(m5.indexOf("create policy posts_feed_select"), m5.indexOf(");", m5.indexOf("create policy posts_feed_select")) + 2);
  assert.doesNotMatch(p, /only_me/, "only_me must never appear as a grantable visibility in the feed select policy");
  assert.match(p, /author_id = auth\.uid\(\)/);
  assert.match(p, /status = 'active'/);
  assert.match(p, /visibility in \('public', 'club'\)/);
  assert.match(p, /visibility = 'friends' and public\.are_friends\(author_id\)/);
  assert.match(p, /visibility = 'followers' and exists \(\s*select 1 from public\.follows f\s*where f\.follower_id = auth\.uid\(\) and f\.followed_id = author_id\)/);
});

test("workout_posts columns [partial]: a hidden or removed post is visible only to its author here; the admin-review read is a separate explicit policy", () => {
  const p = m5.slice(m5.indexOf("create policy posts_feed_select"), m5.indexOf(");", m5.indexOf("create policy posts_feed_select")) + 2);
  // Non-author branch is gated on status = 'active', so hidden/removed only
  // reach the author through `author_id = auth.uid()`.
  assert.match(p, /author_id = auth\.uid\(\)\s*\n\s*or \(\s*\n?\s*status = 'active'/);
  assert.match(migration("202608270009_admin_moderation_visibility"), /create policy posts_select_admin_review on public\.workout_posts for select to authenticated/);
});

test("workout_posts columns [faithful]: a member with no recovery_verified_at cannot insert a post at all", () => {
  const p = m5.slice(m5.indexOf("create policy posts_insert_self"), m5.indexOf(");", m5.indexOf("create policy posts_insert_self")) + 2);
  assert.match(p, /author_id = auth\.uid\(\)/);
  assert.match(p, /public\.is_community_member\(\)/);
  assert.match(p, /public\.has_perm\('community\.post\.create'\)/);
  assert.match(m3, /recovery_verified_at is not null/); // is_community_member() keys on it
});

test("workout_posts columns [partial]: add_post_comment and toggle_reaction raise without recovery, but removing a reaction you already left still works", () => {
  const comment = m5.slice(m5.indexOf("create or replace function public.add_post_comment"), m5.indexOf("$$;", m5.indexOf("add_post_comment")));
  assert.match(comment, /if not public\.is_community_member\(\) then raise exception 'recovery method required'; end if;/);
  const react = m5.slice(m5.indexOf("create or replace function public.toggle_reaction"), m5.indexOf("$$;", m5.indexOf("toggle_reaction")));
  const removeIdx = react.indexOf("delete from public.reactions");
  const gateIdx = react.indexOf("if not public.is_community_member()");
  assert.ok(removeIdx > -1 && gateIdx > -1 && removeIdx < gateIdx, "the reaction-remove path must return before the recovery gate");
});

test("post_media [faithful]: a fifth row on one post has no legal slot - position is bounded 0..3 and (post_id, position) is unique", () => {
  assert.match(m5, /"position" smallint not null check \("position" between 0 and 3\)/);
  assert.match(m5, /unique \(post_id, "position"\)/);
});

test("post_media [partial]: read follows the parent post exactly; insert/update only by the author and only while the post is not removed", () => {
  assert.match(m5, /alter table public\.post_media enable row level security/);
  assert.match(m5, /create policy post_media_visible on public\.post_media for select to authenticated\s*\n?\s*using \(public\.post_visible_to_viewer\(post_id\)\)/);
  const ins = m5.slice(m5.indexOf("create policy post_media_insert_author"), m5.indexOf(");", m5.indexOf("create policy post_media_insert_author")) + 2);
  assert.match(ins, /public\.is_community_member\(\)/);
  assert.match(ins, /p\.author_id = auth\.uid\(\)/);
  assert.match(ins, /p\.status <> 'removed'/);
});

test("post_media [partial]: a storage path whose first segment is not the author's uid is rejected by the ownership trigger", () => {
  const fn = m5.slice(m5.indexOf("create or replace function public.enforce_post_media_ownership"), m5.indexOf("$$;", m5.indexOf("enforce_post_media_ownership")));
  assert.match(fn, /split_part\(new\.storage_path, '\/', 1\) <> v_author::text/);
  assert.match(fn, /raise exception 'media path must belong to the post author'/);
  assert.match(m5, /create trigger post_media_owner before insert or update of storage_path, post_id\s*\n\s*on public\.post_media/);
});

// ---------------------------------------------------------------------------
// 202608280006 - feed telemetry
// ---------------------------------------------------------------------------

test("feed_impressions [faithful]: strictly own-row read and insert, and NO update grant or policy so opened/engaged cannot be rewritten", () => {
  assert.match(m6, /alter table public\.feed_impressions enable row level security/);
  assert.match(m6, /revoke all on public\.feed_impressions[^;]*from public, anon/);
  assert.match(m6, /grant select, insert on public\.feed_impressions to authenticated;/);
  assert.doesNotMatch(m6, /grant [^;]*update[^;]*public\.feed_impressions/);
  assert.match(m6, /create policy feed_impressions_self_select on public\.feed_impressions for select to authenticated\s*\n?\s*using \(user_id = auth\.uid\(\)\)/);
  assert.match(m6, /create policy feed_impressions_self_insert on public\.feed_impressions for insert to authenticated\s*\n?\s*with check \(user_id = auth\.uid\(\)\)/);
  assert.doesNotMatch(m6, /create policy[^;]*on public\.feed_impressions for update/);
  // The only writer of opened/engaged is the definer function.
  assert.match(m6, /create or replace function public\.feed_record_interaction[\s\S]*?update public\.feed_impressions/);
});

test("feed_impressions [partial]: feed_record_impressions caps a batch at 50 (20 ok, 51 raises) and de-dupes a repeated batch", () => {
  const fn = m6.slice(m6.indexOf("create or replace function public.feed_record_impressions"), m6.indexOf("$$;", m6.indexOf("feed_record_impressions")));
  assert.match(fn, /if jsonb_array_length\(p_rows\) > 50 then\s*\n\s*raise exception 'at most 50 impressions per call';/);
  assert.match(fn, /on conflict \(user_id, feed_session_id, post_id\) do nothing/);
  assert.match(m6, /unique \(user_id, feed_session_id, post_id\)/);
});

test("feed_interactions [faithful]: strictly own-row read and insert", () => {
  assert.match(m6, /alter table public\.feed_interactions enable row level security/);
  assert.match(m6, /grant select, insert on public\.feed_interactions to authenticated;/);
  assert.doesNotMatch(m6, /grant [^;]*(update|delete)[^;]*public\.feed_interactions/);
  assert.match(m6, /create policy feed_interactions_self_select on public\.feed_interactions for select to authenticated\s*\n?\s*using \(user_id = auth\.uid\(\)\)/);
  assert.match(m6, /create policy feed_interactions_self_insert on public\.feed_interactions for insert to authenticated\s*\n?\s*with check \(user_id = auth\.uid\(\)\)/);
});

// ---------------------------------------------------------------------------
// 202608280007 - achievements
// ---------------------------------------------------------------------------

test("achievement_definitions [faithful]: any member reads, only a real admin writes, the four attendance seeds ship with enabled=false", () => {
  assert.match(m7, /alter table public\.achievement_definitions enable row level security/);
  assert.match(m7, /create policy achievement_definitions_read on public\.achievement_definitions for select to authenticated\s*\n?\s*using \(true\)/);
  for (const verb of ["insert", "update", "delete"]) {
    const [p] = policiesFor(m7, "achievement_definitions").filter((x) => x.includes(`for ${verb} `));
    assert.ok(p, `achievement_definitions needs a ${verb} policy`);
    assert.match(p, /public\.is_admin\(\)/);
  }
  const seed = m7.slice(m7.indexOf("insert into public.achievement_definitions"), m7.indexOf("on conflict (code) do nothing"));
  for (const code of ["attendance_first_class", "attendance_25_classes", "attendance_100_classes", "attendance_weekly_streak"]) {
    assert.ok(seed.includes(`'${code}'`), `${code} must be seeded`);
  }
  // Every seeded row ends `<repeatable>, false)` - enabled is the last column and is false.
  assert.doesNotMatch(seed, /,\s*(true|false),\s*true\)/, "no seeded attendance definition may ship enabled");
});

test("member_achievements [faithful]: no client insert/update/delete (a member cannot award themselves), and a second non-repeatable row hits the partial unique index", () => {
  assert.match(m7, /alter table public\.member_achievements enable row level security/);
  assert.match(m7, /grant select on public\.member_achievements to authenticated;/);
  assert.doesNotMatch(m7, /grant [^;]*(insert|update|delete)[^;]*public\.member_achievements/);
  assert.doesNotMatch(m7, /create policy[^;]*on public\.member_achievements for (insert|update|delete)/);
  assert.match(m7, /create unique index member_achievements_once_idx\s*\n\s*on public\.member_achievements\(user_id, achievement_id\) where not repeatable;/);
});

test("member_achievements [partial]: another member reads a club-visible unlock only when show_achievements is on and no block edge sits between them", () => {
  const p = m7.slice(m7.indexOf("create policy member_achievements_read"), m7.indexOf(");", m7.indexOf("create policy member_achievements_read")) + 2);
  assert.match(p, /user_id = auth\.uid\(\)/);
  assert.match(p, /visibility = 'club'\s*\n\s*and public\.can_view_profile_field\(user_id, 'show_achievements'\)/);
  assert.match(p, /visibility = 'friends'\s*\n\s*and public\.are_friends\(user_id\)\s*\n\s*and public\.can_view_profile_field\(user_id, 'show_achievements'\)/);
});

// ---------------------------------------------------------------------------
// 202608280008 - notifications
// ---------------------------------------------------------------------------

test("notifications [faithful]: own-row read only, NO insert policy or grant (a member cannot plant one in another stream)", () => {
  assert.match(m8, /alter table public\.notifications enable row level security/);
  assert.match(m8, /grant select, update on public\.notifications to authenticated;/);
  assert.doesNotMatch(m8, /grant [^;]*insert[^;]*public\.notifications/);
  assert.doesNotMatch(m8, /create policy[^;]*on public\.notifications for insert/);
  assert.match(m8, /create policy notifications_self_select on public\.notifications for select to authenticated\s*\n?\s*using \(user_id = auth\.uid\(\)\)/);
});

test("notifications [partial]: the own-row UPDATE reaches read_at only - a content trigger pins title, body, deep_link and the rest on an authenticated write", () => {
  assert.match(m8, /create policy notifications_self_update on public\.notifications for update to authenticated\s*\n?\s*using \(user_id = auth\.uid\(\)\) with check \(user_id = auth\.uid\(\)\)/);
  const fn = m8.slice(m8.indexOf("create or replace function public.protect_notification_content"), m8.indexOf("$$;", m8.indexOf("protect_notification_content")));
  assert.match(fn, /if auth\.role\(\) = 'authenticated' then/);
  for (const col of ["title", "body", "deep_link", "type", "category", "source_type", "source_id", "created_at"]) {
    assert.match(fn, new RegExp(`new\\.${col} = old\\.${col};`), `${col} must be pinned`);
  }
  assert.match(m8, /create trigger notifications_protect_content before update on public\.notifications/);
});

test("notification_preferences [faithful]: own-row read and write on every verb; a missing row is a valid state (channel enum, composite PK, no backfill)", () => {
  assert.match(m8, /alter table public\.notification_preferences enable row level security/);
  const policies = policiesFor(m8, "notification_preferences");
  assert.equal(policies.length, 4, "select/insert/update/delete, all self");
  for (const p of policies) assert.match(p, /user_id = auth\.uid\(\)/);
  assert.match(m8, /channel text not null check \(channel in \('push', 'in_app', 'off'\)\)/);
  assert.match(m8, /primary key \(user_id, type\)/);
  // "missing row means in_app" is a consumer contract; assert there is no
  // backfill that would contradict it.
  assert.doesNotMatch(m8, /insert into public\.notification_preferences/);
});

test("push_subscriptions [faithful]: own-row read and write, so a member cannot read another member's endpoint or keys", () => {
  assert.match(m8, /alter table public\.push_subscriptions enable row level security/);
  const policies = policiesFor(m8, "push_subscriptions");
  assert.equal(policies.length, 4);
  for (const p of policies) assert.match(p, /user_id = auth\.uid\(\)/);
});

// ---------------------------------------------------------------------------
// 202608280009 - challenges set
// ---------------------------------------------------------------------------

test("challenges [faithful]: a draft is readable only by its creator or a community.challenge.create holder; create/edit/delete require that permission", () => {
  assert.match(m9, /alter table public\.challenges enable row level security/);
  const read = m9.slice(m9.indexOf("create policy challenges_read"), m9.indexOf(");", m9.indexOf("create policy challenges_read")) + 2);
  assert.match(read, /status <> 'draft'\s*\n\s*or created_by = auth\.uid\(\)\s*\n\s*or public\.has_perm\('community\.challenge\.create'\)/);
  for (const verb of ["insert", "update", "delete"]) {
    const [p] = policiesFor(m9, "challenges").filter((x) => x.includes(`for ${verb} `));
    assert.match(p, /public\.has_perm\('community\.challenge\.create'\)/);
  }
});

test("challenge_teams [faithful]: readable with the parent challenge, written only by a community.challenge.create holder", () => {
  assert.match(m9, /alter table public\.challenge_teams enable row level security/);
  assert.match(m9, /create policy challenge_teams_read on public\.challenge_teams for select to authenticated\s*\n?\s*using \(exists \(select 1 from public\.challenges c where c\.id = challenge_id\)\)/);
  for (const verb of ["insert", "update", "delete"]) {
    const [p] = policiesFor(m9, "challenge_teams").filter((x) => x.includes(`for ${verb} `));
    assert.match(p, /public\.has_perm\('community\.challenge\.create'\)/);
  }
});

test("challenge_participants [faithful]: a member inserts only their own row, only on an active challenge, only with recovery set - and cannot edit another participant's row", () => {
  assert.match(m9, /alter table public\.challenge_participants enable row level security/);
  const join = m9.slice(m9.indexOf("create policy challenge_participants_join_self"), m9.indexOf(");", m9.indexOf("create policy challenge_participants_join_self")) + 2);
  assert.match(join, /user_id = auth\.uid\(\)/);
  assert.match(join, /public\.is_community_member\(\)/);
  assert.match(join, /c\.id = challenge_id and c\.status = 'active'/);
  const upd = m9.slice(m9.indexOf("create policy challenge_participants_update_self"), m9.indexOf(");", m9.indexOf("create policy challenge_participants_update_self")) + 2);
  assert.match(upd, /user_id = auth\.uid\(\) or public\.has_perm\('community\.challenge\.create'\)/);
});

test("challenge_progress [faithful]: append only - select+insert grant, no update or delete policy or grant, own active-participant rows only", () => {
  assert.match(m9, /alter table public\.challenge_progress enable row level security/);
  assert.match(m9, /grant select, insert on public\.challenge_progress to authenticated;/);
  assert.doesNotMatch(m9, /grant [^;]*(update|delete)[^;]*public\.challenge_progress/);
  assert.doesNotMatch(m9, /create policy[^;]*on public\.challenge_progress for (update|delete)/);
  const ins = m9.slice(m9.indexOf("create policy challenge_progress_insert_self"), m9.indexOf(");", m9.indexOf("create policy challenge_progress_insert_self")) + 2);
  assert.match(ins, /user_id = auth\.uid\(\)/);
  assert.match(ins, /public\.is_community_member\(\)/);
  assert.match(ins, /cp\.challenge_id = challenge_id and cp\.user_id = auth\.uid\(\) and cp\.status = 'active'/);
});

// ---------------------------------------------------------------------------
// 202608280010 - events set
// ---------------------------------------------------------------------------

test("events [faithful]: a draft is readable only by its creator or a community.event.manage holder; create/edit/delete require that permission", () => {
  assert.match(m10, /alter table public\.events enable row level security/);
  const read = m10.slice(m10.indexOf("create policy events_read"), m10.indexOf(");", m10.indexOf("create policy events_read")) + 2);
  assert.match(read, /status <> 'draft'\s*\n\s*or created_by = auth\.uid\(\)\s*\n\s*or public\.has_perm\('community\.event\.manage'\)/);
  for (const verb of ["insert", "update", "delete"]) {
    const [p] = policiesFor(m10, "events").filter((x) => x.includes(`for ${verb} `));
    assert.match(p, /public\.has_perm\('community\.event\.manage'\)/);
  }
});

test("event_attendees [partial]: RSVP only for yourself on a published event with recovery set; an opted-out attendee is hidden from members but not from self or an event manager", () => {
  assert.match(m10, /alter table public\.event_attendees enable row level security/);
  const rsvp = m10.slice(m10.indexOf("create policy event_attendees_rsvp_self"), m10.indexOf(");", m10.indexOf("create policy event_attendees_rsvp_self")) + 2);
  assert.match(rsvp, /user_id = auth\.uid\(\)/);
  assert.match(rsvp, /public\.is_community_member\(\)/);
  assert.match(rsvp, /e\.id = event_id and e\.status = 'published'/);
  const read = m10.slice(m10.indexOf("create policy event_attendees_read"), m10.indexOf(");", m10.indexOf("create policy event_attendees_read")) + 2);
  assert.match(read, /user_id = auth\.uid\(\)/);
  assert.match(read, /public\.has_perm\('community\.event\.manage'\)/);
  assert.match(read, /public\.can_view_profile_field\(user_id, 'show_in_attendee_lists'\)/);
});

test("event_attendees [partial]: capacity and deadline are enforced by a trigger (so a direct RLS upsert hits them too), and a going->going update on a full event still succeeds", () => {
  const fn = m10.slice(m10.indexOf("create or replace function public.enforce_event_capacity"), m10.indexOf("$$;", m10.indexOf("enforce_event_capacity")));
  assert.match(fn, /raise exception 'registration_closed'/);
  assert.match(fn, /raise exception 'event_full'/);
  assert.match(fn, /a\.response = 'going' and a\.user_id <> new\.user_id/, "the count must exclude the row being written so going->going is idempotent");
  assert.match(m10, /create trigger event_attendees_capacity before insert or update of response\s*\n\s*on public\.event_attendees/);
});

// ---------------------------------------------------------------------------
// 202608280011 - coach_engagement_flags
// ---------------------------------------------------------------------------

test("coach_engagement_flags [faithful]: EVERY policy carries user_id <> auth.uid() so a flagged member can never read their own row, even as coach or admin; table ships empty", () => {
  assert.match(m11, /alter table public\.coach_engagement_flags enable row level security/);
  assert.match(m11, /revoke all on public\.coach_engagement_flags from public, anon/);
  const policies = policiesFor(m11, "coach_engagement_flags");
  assert.equal(policies.length, 4, "select/insert/update/delete");
  for (const p of policies) {
    assert.match(p, /user_id <> auth\.uid\(\)/, `every coach_engagement_flags policy must exclude the subject: ${p.slice(0, 60)}`);
    assert.match(p, /public\.has_perm\('community\.member\.restrict'\) or public\.is_staff\(\)/);
  }
  // An UPDATE policy has both USING and WITH CHECK - the self-exclusion must be in both.
  const upd = policies.find((p) => p.includes("for update "));
  assert.equal((upd.match(/user_id <> auth\.uid\(\)/g) || []).length, 2, "update policy needs the exclusion in USING and WITH CHECK");
  assert.doesNotMatch(m11, /insert into public\.coach_engagement_flags/, "the table must ship empty");
});

// ---------------------------------------------------------------------------
// 202608280012 - analytics_events
// ---------------------------------------------------------------------------

test("analytics_events [faithful]: insert own-row or null user_id, read ONLY by a community.analytics.view holder and specifically not by the member who wrote the row", () => {
  assert.match(m12, /alter table public\.analytics_events enable row level security/);
  assert.match(m12, /revoke all on public\.analytics_events from public, anon/);
  assert.match(m12, /grant select, insert on public\.analytics_events to authenticated;/);
  assert.doesNotMatch(m12, /grant [^;]*(update|delete)[^;]*public\.analytics_events/);
  assert.match(m12, /create policy analytics_events_insert_self on public\.analytics_events for insert to authenticated\s*\n?\s*with check \(user_id = auth\.uid\(\) or user_id is null\)/);
  const read = m12.slice(m12.indexOf("create policy analytics_events_read_analytics"), m12.indexOf(";", m12.indexOf("create policy analytics_events_read_analytics")) + 1);
  assert.match(read, /using \(public\.has_perm\('community\.analytics\.view'\)\)/);
  assert.doesNotMatch(read, /user_id = auth\.uid\(\)/, "the read policy must NOT let a member read back their own analytics rows");
});

test("analytics_events [partial]: a props payload over 4 KB is rejected by the trigger on every write path", () => {
  const fn = m12.slice(m12.indexOf("create or replace function public.enforce_analytics_props_size"), m12.indexOf("$$;", m12.indexOf("enforce_analytics_props_size")));
  assert.match(fn, /if pg_column_size\(new\.props\) > 4096 then\s*\n\s*raise exception 'props exceeds 4 KB';/);
  assert.match(m12, /create trigger analytics_events_props_size before insert or update of props\s*\n\s*on public\.analytics_events/);
});

// ---------------------------------------------------------------------------
// 202608280013 - invite_attempts actor throttle
// ---------------------------------------------------------------------------

test("invite_attempts [faithful]: still unreachable by any client - no grant and no policy for anon or authenticated, RLS still on", () => {
  assert.match(migration("202608270006_security_hardening"), /alter table public\.invite_attempts enable row level security/);
  assert.doesNotMatch(m13, /grant [^;]*on (function )?public\.invite_attempts to (anon|authenticated)/);
  assert.doesNotMatch(m13, /create policy[^;]*on public\.invite_attempts/);
  assert.match(m13, /revoke all on function public\.bump_invite_attempt\(text, uuid\) from public, anon, authenticated;/);
});

test("invite_attempts [partial]: the throttle keys on a session-independent actor_key hash, so a fresh anonymous session with the same actor_key stays rate limited", () => {
  // The key column is the primary key and no longer requires user_id, so a
  // new session (new uid) with the same actor key lands on the same row.
  assert.match(m13, /alter table public\.invite_attempts alter column user_id drop not null;/);
  assert.match(m13, /alter table public\.invite_attempts add constraint invite_attempts_pkey primary key \(actor_key_hash\);/);
  const fn = m13.slice(m13.indexOf("create or replace function public.redeem_invite_code(p_code text, p_actor_key text)"), m13.indexOf("$$;", m13.indexOf("redeem_invite_code(p_code text, p_actor_key text)")));
  assert.match(fn, /v_actor_key := 'ak:' \|\| encode\(extensions\.digest\(p_actor_key, 'sha256'\), 'hex'\);/);
  assert.match(fn, /v_attempts := public\.bump_invite_attempt\(v_uid_key, v_uid\);/);
  assert.match(fn, /v_attempts := greatest\(v_attempts, public\.bump_invite_attempt\(v_actor_key, v_uid\)\);/);
  assert.match(fn, /if v_attempts > 5 then return 'rate_limited'; end if;/);
  // Sliding 15-minute window, not a per-session counter.
  const bump = m13.slice(m13.indexOf("create or replace function public.bump_invite_attempt"), m13.indexOf("$$;", m13.indexOf("bump_invite_attempt")));
  assert.match(bump, /window_started_at < now\(\) - interval '15 minutes'/);
});

test("invite_attempts [partial]: the answer and the increment are identical whether the actor is new or has been guessing - nothing branches on recognition", () => {
  const fn = m13.slice(m13.indexOf("create or replace function public.redeem_invite_code(p_code text, p_actor_key text)"), m13.indexOf("$$;", m13.indexOf("redeem_invite_code(p_code text, p_actor_key text)")));
  // Only three return values, none of them conditional on whether the key
  // existed (the wrapper's `return v_existing_role` is a distinct early exit
  // for an already-redeemed caller, not a throttle signal).
  const body = fn.slice(fn.indexOf("v_uid_key :="));
  const returns = [...body.matchAll(/return '([a-z_]+)'/g)].map((x) => x[1]);
  assert.deepEqual([...new Set(returns)].sort(), ["invalid", "member", "rate_limited"]);
  // The rate-limit decision is a single unconditional threshold on the
  // higher of the two counters - there is no branch on key novelty.
  assert.match(body, /if v_attempts > 5 then return 'rate_limited'; end if;/);
});

// ---------------------------------------------------------------------------
// The gap COMM-019 named - now closed, so the placeholder skip is replaced by
// a real assertion.
// ---------------------------------------------------------------------------
//
// This file used to end with a permanently-skipped placeholder test whose
// reason read "infra not yet in repo - see COMM-019 report; est. ~1 day to
// add supabase/tests/ + one CI step". That infra HAS since landed and the
// reason is now false: supabase/tests/ holds a full pgTAP suite that
// impersonates real auth users and asserts allow/deny against live RLS, and
// .github/workflows/test.yml's migration-check job runs it with
// `supabase test db` as a hard gate. Verified 2026-09-06 against a real
// PostgreSQL 17 via `supabase db reset && supabase test db`:
// Files=79, Tests=2747, Result: PASS.
//
// A skip that describes work already done is worse than no test - it reads as
// a known gap forever. Replaced with an assertion that pins the two things
// that must stay true for the gap to STAY closed, both checkable from here.
test("TRUE RLS enforcement for two auth roles is covered by the pgTAP suite, which CI runs as a hard gate", () => {
  const testsDir = new URL("../supabase/tests/", import.meta.url);
  const files = fs.readdirSync(testsDir).filter((f) => f.endsWith("_test.sql"));
  assert.ok(
    files.length >= 70,
    `expected the pgTAP suite to still be present and substantial, found ${files.length} *_test.sql files`,
  );
  // rls_helpers.sql is what makes these tests REAL RLS tests rather than
  // static assertions: set_auth() swaps request.jwt.claims and the session
  // role, so a policy is evaluated against an actual impersonated auth user.
  const helpers = fs.readFileSync(new URL("rls_helpers.sql", testsDir), "utf8");
  assert.match(helpers, /set_config\(\s*'request\.jwt\.claims'/);
  assert.match(helpers, /set_config\('role', 'authenticated', true\)/);
  // And the CI gate that runs them, with no continue-on-error escape hatch.
  const wf = fs.readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8");
  assert.match(wf, /supabase test db/, "migration-check must still run the pgTAP suite");
  assert.doesNotMatch(wf, /continue-on-error/, "no CI job may opt out of failing the build");
});
