// Coach signal honesty (202609060020).
//
// THE DEFECT. Measured live against a seeded, visibly active club - 41
// posts, reactions, comments, several members posting - the coach dashboard
// reported 8 of 8 members as never active, including the coach who had
// posted moments earlier, while the new-member list returned 4 of 12
// members who had all joined that same day.
//
// One input behind both: `activity_pings`, whose only writer anywhere in
// the system is pingActivity() in cloud.js - today only, from a live
// browser session. No trigger, no backfill, no server-side producer.
// 202609060002 states what a row in it means: "one row per day the member
// OPENED THE APP". Both functions were built on it and both were presented
// to coaches in training language.
//
// These assertions are the migration-contract half. The behavioural half
// runs for real against Postgres in
// supabase/tests/0083_coach_signal_honesty_test.sql, which exercises the
// actual RLS and the actual rows; a JS mock has no policy engine and could
// not tell the two apart.

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const migrationsDir = new URL("../supabase/migrations/", import.meta.url);
const MIGRATION = "202609060020_coach_signal_honesty.sql";
const sql = fs.readFileSync(new URL(MIGRATION, migrationsDir), "utf8");
const seed = fs.readFileSync(new URL("../scripts/seed-local-personas.sql", import.meta.url), "utf8");

const allMigrations = fs.readdirSync(new URL(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

/** The body of the last CREATE FUNCTION for `name` in this migration. */
function fnBody(name) {
  const start = sql.indexOf(`create function public.${name}`);
  assert.notEqual(start, -1, `expected ${MIGRATION} to create ${name}`);
  const end = sql.indexOf("revoke all on function", start);
  return sql.slice(start, end === -1 ? undefined : end);
}

/** Which migration files define `name`, in application order. */
function definers(name) {
  return allMigrations.filter((f) => {
    const body = fs.readFileSync(new URL(f, migrationsDir), "utf8");
    return new RegExp(`create (or replace )?function public\\.${name}\\b`).test(body);
  });
}

test("the fix is a NEW migration and edits no existing one - deploy ordering is by timestamp only", () => {
  assert.ok(allMigrations.includes(MIGRATION), "the migration must be present");
  // It has to sort after every migration that previously defined these two,
  // or the broken definitions would be applied last and win.
  for (const name of ["coach_inactive_members", "coach_new_members"]) {
    const defs = definers(name);
    assert.equal(
      defs[defs.length - 1], MIGRATION,
      `${MIGRATION} must be the LAST migration defining ${name}, otherwise an older, broken definition is applied after it`,
    );
  }
});

test("both functions are DROPped before being recreated - their return shape changes, which CREATE OR REPLACE cannot do", () => {
  // Postgres raises 42P13 ("cannot change return type of existing
  // function") on a replace that alters the `returns table(...)` column
  // list, so this is a correctness requirement rather than a style choice.
  assert.match(sql, /drop function if exists public\.coach_inactive_members\(date\);/);
  assert.match(sql, /drop function if exists public\.coach_new_members\(integer\);/);
  const inactiveDrop = sql.indexOf("drop function if exists public.coach_inactive_members");
  const inactiveCreate = sql.indexOf("create function public.coach_inactive_members");
  assert.ok(inactiveDrop < inactiveCreate, "the drop must precede the create");
});

// =====================================================================
// coach_inactive_members: "no data" is not "never trained"
// =====================================================================
test("coach_inactive_members returns an explicit state, so absence of data can never be rendered as a fact about a member", () => {
  const fn = fnBody("coach_inactive_members");
  assert.match(fn, /state text/, "the function must return a state column");
  assert.match(
    fn,
    /case when m\.last_seen is null then 'no_data' else 'lapsed' end/,
    "the two cases must be distinguished server-side, not left to the client to infer from a null",
  );
  // The exact shape of the bug: one HAVING clause that merged the two.
  assert.doesNotMatch(
    fn,
    /having[\s\S]*is null or/i,
    'the old form merged "we have no data" and "they stopped" into one list with `max(activity_date) is null or max(...) < p_since`',
  );
});

test("a no_data member carries a null date and a null gap, not a fabricated one", () => {
  const fn = fnBody("coach_inactive_members");
  assert.match(
    fn,
    /case when m\.last_seen is null then null else \(current_date - m\.last_seen\) end/,
    "days_since_activity must be null for a member with no data - 0 or a large number is something a client can render by accident",
  );
});

test("members who joined inside the window are excluded from the inactive list", () => {
  const fn = fnBody("coach_inactive_members");
  assert.match(
    fn,
    /where m\.joined_on <= p_since/,
    "a member who joined two days ago has not lapsed; without this they appear in the alarming list from the day they join",
  );
});

test("the inactive list sorts genuinely-lapsed members before no-data ones", () => {
  const fn = fnBody("coach_inactive_members");
  assert.match(
    fn,
    /order by \(m\.last_seen is null\), m\.last_seen asc/,
    "the actionable half of the list must come first; no_data members are context, not a queue",
  );
});

// =====================================================================
// coach_new_members: the join date, and the member who never came back
// =====================================================================
test("coach_new_members uses the real join date, not the first day the member happened to open the app", () => {
  const fn = fnBody("coach_new_members");
  assert.match(
    fn,
    /coalesce\(ir\.redeemed_at::date, pr\.created_at::date\) as joined_on/,
    "invite_redemptions.redeemed_at is when someone became a member; it is readable here because the function is SECURITY DEFINER",
  );
  assert.doesNotMatch(
    fn,
    /min\(ap\.activity_date\)/,
    "min(activity_date) is a first-app-open date - for every member predating the feature it reports the feature's own deploy date",
  );
});

test("coach_new_members LEFT JOINs app activity, so a member who registered and never opened the app still appears", () => {
  const fn = fnBody("coach_new_members");
  // This is the single most commercially important line in the migration.
  // The old INNER JOIN dropped exactly the member day-0 outreach exists
  // for: someone who signed up and vanished has no pings at all.
  assert.doesNotMatch(
    fn,
    /join public\.activity_pings/,
    "activity_pings must never be an inner join here - it excluded every member who never opened the app",
  );
  assert.match(
    fn,
    /exists \(select 1 from public\.activity_pings ap where ap\.user_id = m\.id\)/,
    "app activity is reported as a boolean flag, not used as a filter",
  );
  assert.match(fn, /has_opened_app boolean/);
});

test("coach_new_members reports contact status, so two coaches do not welcome the same member", () => {
  const fn = fnBody("coach_new_members");
  assert.match(fn, /contacted boolean/);
  assert.match(fn, /from public\.member_contact_log mcl where mcl\.user_id = m\.id/);
});

test("sessions_logged is an aggregate COUNT of attendance days, never a per-day log", () => {
  const fn = fnBody("coach_new_members");
  assert.match(
    fn,
    /\(select count\(\*\)\s*\n?\s*from public\.attendance_log al\s*\n?\s*where al\.user_id = m\.id\)::integer/,
    "a count discloses no session, date or result",
  );
  // The distinction PRIVACY.md turns on: a coach may have the number, not
  // the rows. Anything that returned a date from attendance_log here would
  // reopen what 202609060013 closed.
  assert.doesNotMatch(
    fn,
    /al\.occurred_on/,
    "no per-member attendance DATE may leave this function - PRIVACY.md promises members coaches see rates, 'not a detailed log'",
  );
});

// =====================================================================
// The privacy boundary that made the obvious fix the wrong one
// =====================================================================
test("the migration does not widen attendance_log's RLS back out to coach rank", () => {
  // 202609060013 deliberately narrowed attendance_log_staff_select from
  // `has_perm('community.analytics.view') or is_staff()` down to the
  // permission alone, as a product decision (SEC-009/PRIV-001). Fixing a UX
  // bug must not quietly undo it.
  assert.doesNotMatch(sql, /create policy attendance_log_staff_select/);
  assert.doesNotMatch(sql, /alter table public\.attendance_log/);
  assert.doesNotMatch(sql, /grant .* on public\.attendance_log/);

  const decision = fs.readFileSync(
    new URL("202609060013_product_decisions_attendance_and_announcements.sql", migrationsDir), "utf8");
  assert.match(
    decision,
    /using \(public\.has_perm\('community\.analytics\.view'\)\);/,
    "the narrowed policy must still be the last word on attendance_log reads",
  );
});

test("all three functions are staff-gated inline and locked away from anon", () => {
  for (const [name, args] of [
    ["coach_inactive_members", "date"],
    ["coach_new_members", "integer"],
    ["coach_activity_signal_status", ""],
  ]) {
    const body = sql.slice(sql.indexOf(`function public.${name}`));
    assert.match(body, /if not public\.is_staff\(\) then raise exception 'not authorized'; end if;/,
      `${name} must refuse a non-staff caller in the database, not merely in a hidden nav item`);
    assert.match(sql, new RegExp(`revoke all on function public\\.${name}\\(${args}\\) from public, anon`),
      `${name} must be revoked from anon`);
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\(${args}\\) to authenticated`));
  }
});

// =====================================================================
// The honest empty state
// =====================================================================
test("coach_activity_signal_status exists so the client can tell 'all clear' from 'no data at all'", () => {
  // An empty inactive list means either "everyone is active" or "this
  // section has never received a single data point". The client cannot tell
  // those apart from the list, and the old one asserted the first in both
  // cases ("כולם פעילים"). That needs a fact, not a heuristic.
  const fn = sql.slice(sql.indexOf("create or replace function public.coach_activity_signal_status"));
  assert.match(fn, /members_total integer/);
  assert.match(fn, /members_with_app_activity integer/);
  assert.match(fn, /members_with_logged_sessions integer/);
  // Counts only. This is a question about the dataset, not about people.
  assert.doesNotMatch(fn.slice(0, fn.indexOf("$$", fn.indexOf("$$") + 2)), /handle|display_name/);
});

test("app-open activity and logged training are counted as two separate signals, never merged", () => {
  const fn = sql.slice(sql.indexOf("create or replace function public.coach_activity_signal_status"));
  assert.match(fn, /from public\.activity_pings ap where ap\.user_id = pr\.id/);
  assert.match(fn, /from public\.attendance_log al where al\.user_id = pr\.id/);
});

// =====================================================================
// What the functions are documented to MEAN
// =====================================================================
// The label is the other half of this defect: the data was also being
// described to coaches as something it is not. The comments are where a
// future reader finds out what the signal actually measures, so they are
// asserted rather than left as prose that can drift.
test("coach_inactive_members documents that it is an APP signal and not a training or class-attendance one", () => {
  const comment = sql.slice(sql.indexOf("comment on function public.coach_inactive_members"));
  assert.match(comment, /NOT a training or class-attendance signal/i);
  assert.match(comment, /Arbox/, "the Arbox boundary must be explicit: class attendance is not something this product sees");
  assert.match(comment, /coach_engagement_flags/, "and it must point at the signal that IS about training");
});

test("coach_new_members documents the two bugs it fixes, so neither can be reintroduced as a simplification", () => {
  const comment = sql.slice(sql.indexOf("comment on function public.coach_new_members"));
  assert.match(comment, /INNER JOIN/i);
  assert.match(comment, /never opened the app/i);
});

// =====================================================================
// The fixture. A coach surface that cannot be seen working is not done.
// =====================================================================
test("the local seed gives personas tenure, training history and app-open history", () => {
  // Without this every seeded member joined seconds ago and has never
  // logged a workout or opened the app, which makes every coach signal
  // structurally unreachable: nobody can be lapsed, nobody has an
  // anniversary, and nothing can decline.
  assert.match(seed, /update public\.profiles\s*\n\s*set created_at = now\(\) - make_interval\(days => v_join_days\)/);
  assert.match(seed, /update public\.invite_redemptions\s*\n\s*set redeemed_at = now\(\) - make_interval\(days => v_join_days\)/);
});

test("seeded training days go through private_records, so the fixture exercises the real production trigger", () => {
  // attendance_log takes no client write by design (202608310001: "WHO CAN
  // WRITE IT - Nobody"); its one trigger derives a day from a synced
  // strength_entry. A fixture that inserted attendance_log directly would
  // be testing a shape only the seed can produce.
  assert.match(seed, /insert into public\.private_records \(user_id, record_type, record_id, payload, created_at, updated_at\)/);
  assert.match(seed, /'strength_entry'/);
  assert.doesNotMatch(seed, /insert into public\.attendance_log/);
});

test("the seed covers both inactive states and the never-opened-the-app member", () => {
  // Each of these three personas exists to make one branch of the fix
  // visible to a human opening the dashboard.
  assert.match(seed, /\['omer_l','300','3','0','16'\]/, "a genuinely lapsed member");
  assert.match(seed, /\['gil_quiet','60','0','0',null\]/, "a member we know nothing about - the no_data branch");
  assert.match(seed, /\['rina_member','2','0','0',null\]/, "a member who registered and has never opened the app");
  // Both must be real seeded accounts, not handles that silently no-op.
  // They were originally typed into the signup UI by hand, which meant a
  // fresh `supabase db reset` produced neither of them and the two most
  // important branches of the fix had no subject in the fixture at all.
  assert.match(seed, /v_handles text\[\] := array\['rina_member','gil_quiet'\]/,
    "the two quiet personas must be created by the seed itself");
  // Created after the post loop on purpose: a member we know nothing about
  // is only a faithful fixture if we genuinely know nothing about them.
  assert.ok(
    seed.indexOf("array['rina_member','gil_quiet']") > seed.indexOf("-- 3. Feed volume"),
    "they must be created after the random-author post loop, or they pick up a posting history",
  );
});

test("exercise names in the seed stay in English, the vernacular in an Israeli box", () => {
  assert.match(seed, /'Back Squat'/);
  assert.match(seed, /'Deadlift'/);
  assert.doesNotMatch(seed, /'סקוואט אחורי'|'הרמת מת'/, "movement names are not translated");
});

test("the seed populates all three of Celebrate's non-attendance sources", () => {
  assert.match(seed, /post_type = 'POST_PR'/, "PRs");
  assert.match(seed, /show_prs = true/, "and opts those authors in, since show_prs defaults false and gates the Celebrate branch");
  assert.match(seed, /\['yael_b','367'/, "an anniversary whose crossing falls inside the Celebrate window");
  assert.match(seed, /insert into public\.challenge_participants[\s\S]*completed_at/, "a challenge completion");
});

test("the seed runs the engagement-decline job rather than planting flags by hand", () => {
  assert.match(seed, /select public\.coach_detect_engagement_decline\(\)/);
  assert.doesNotMatch(seed, /insert into public\.coach_engagement_flags/,
    "planted flags would not prove the detector works, and COMM-304's no-baseline-no-flag rule is the part most worth exercising");
});
