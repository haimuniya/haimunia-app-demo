// COMM-300. The attendance source: the `attendance_log` table
// (202608310001), its trigger on `private_records`, the first
// ATTENDANCE_RECORDED producer since Phase 0, and the analytics bridge.
//
// Same "faithful" static-assertion style as
// test/community-rls-boundaries.test.mjs (COMM-019) and
// test/community-realtime-search-rls.test.mjs for the SQL half: this file
// pins the exact clause in the migration that makes each boundary hold, so a
// later edit that widens exposure fails CI. The client half is executed for
// real in jsdom against the mock Supabase client, because "does the emit
// actually fire from flushOutbox, exactly once per day, only after the write
// succeeded" is not a question source text can answer.
//
// WHAT THIS FILE VERIFIES
// - attendance_log has RLS on, a select grant and nothing else, and no
//   insert/update/delete policy for any role - the "no client write, the
//   function owns it" shape the ticket named.
// - The trigger is AFTER INSERT OR UPDATE on private_records, security
//   definer, filtered to non-deleted session-bearing rows, and upserts with
//   `on conflict (user_id, occurred_on) do nothing`.
// - The session-bearing set is exactly strength_entry + wod_entry, and it is
//   the same set on both sides of the wire (the migration's helper function
//   and cloud.js's own list).
// - The date the trigger reads is the one app.js actually sends: the shape
//   is cross-checked against src/sanitize.js rather than assumed.
// - flushOutbox() emits ATTENDANCE_RECORDED with {occurred_on} after a
//   successful write, once per calendar day, never for a bodyweight record,
//   never for a soft-delete, and never before the write lands.
// - attendance_recorded is bridged, prop-limited to occurred_on, and counts
//   for WCAM.
//
// WHAT THIS FILE DOES NOT VERIFY
// Runtime enforcement of the SQL for two real Postgres roles - the same
// limitation every file in this style has. That half is
// supabase/tests/0037_attendance_log_test.sql, which runs on every
// migration-check: one row for two session types on one day, two rows for
// two days, none for bodyweight/measurement, the append-only soft-delete
// case, the future-date refusal, and the member/admin write refusals.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const migration = fs.readFileSync(new URL("../supabase/migrations/202608310001_attendance_log.sql", import.meta.url), "utf8");
const cloudSrc = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const sanitizeSrc = fs.readFileSync(new URL("../src/sanitize.js", import.meta.url), "utf8");
// COMM-368 moved cleanISODate (and the rest of the low-level clean*/esc/uid
// set) out of src/sanitize.js into the shared, versioned safe-helpers module.
// The per-record sanitizers that CALL it still live in src/sanitize.js, so the
// assertions below read from whichever file now owns the thing they check.
const safeHelpersSrc = fs.readFileSync(new URL("../src/shared/safe-helpers.js", import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// The table and its RLS
// ---------------------------------------------------------------------------

test("attendance_log [faithful]: RLS is enabled and the table is revoked from public/anon", () => {
  assert.match(migration, /alter table public\.attendance_log enable row level security;/);
  assert.match(migration, /revoke all on public\.attendance_log from public, anon;/);
});

test("attendance_log [faithful]: authenticated gets select and nothing else - no client write grant of any kind", () => {
  const grants = [...migration.matchAll(/grant ([a-z, ]+) on public\.attendance_log to ([a-z_, ]+);/g)];
  assert.strictEqual(grants.length, 1, "exactly one grant statement on the table");
  assert.strictEqual(grants[0][1].trim(), "select");
  assert.strictEqual(grants[0][2].trim(), "authenticated");
  assert.doesNotMatch(migration, /grant [^;]*insert[^;]* on public\.attendance_log/);
  assert.doesNotMatch(migration, /grant [^;]*update[^;]* on public\.attendance_log/);
  assert.doesNotMatch(migration, /grant [^;]*delete[^;]* on public\.attendance_log/);
});

test("attendance_log [faithful]: every policy on the table is a SELECT policy - there is no insert/update/delete policy to widen later by accident", () => {
  const policies = [...migration.matchAll(/create policy (\w+) on public\.attendance_log for (\w+)/g)];
  assert.deepStrictEqual(
    policies.map((m) => [m[1], m[2]]),
    [["attendance_log_self_select", "select"], ["attendance_log_staff_select", "select"]],
  );
});

test("attendance_log [faithful]: own-row read is user_id = auth.uid(), cross-member read is analytics permission or real staff", () => {
  assert.match(migration, /create policy attendance_log_self_select on public\.attendance_log for select to authenticated\s*\n\s*using \(user_id = auth\.uid\(\)\);/);
  assert.match(migration, /create policy attendance_log_staff_select on public\.attendance_log for select to authenticated\s*\n\s*using \(public\.has_perm\('community\.analytics\.view'\) or public\.is_staff\(\)\);/);
});

test("attendance_log [faithful]: one row per member per calendar day is a unique constraint, not a convention", () => {
  assert.match(migration, /unique \(user_id, occurred_on\)/);
  assert.match(migration, /on conflict \(user_id, occurred_on\) do nothing/);
});

test("attendance_log [faithful]: user_id cascades from profiles, so a deleted account takes its attendance with it", () => {
  assert.match(migration, /user_id uuid not null references public\.profiles\(id\) on delete cascade/);
});

// ---------------------------------------------------------------------------
// The trigger
// ---------------------------------------------------------------------------

test("attendance trigger [faithful]: AFTER INSERT OR UPDATE on private_records, filtered to non-deleted session-bearing rows", () => {
  assert.match(
    migration,
    /create trigger private_records_attendance_log\s*\n\s*after insert or update on public\.private_records\s*\n\s*for each row\s*\n\s*when \(new\.deleted_at is null and new\.record_type = any \(public\.attendance_session_record_types\(\)\)\)\s*\n\s*execute function public\.attendance_log_from_record\(\);/,
  );
});

test("attendance trigger [faithful]: the writer is security definer with search_path pinned, and revoked from every client role", () => {
  assert.match(migration, /create or replace function public\.attendance_log_from_record\(\) returns trigger\s*\nlanguage plpgsql security definer set search_path = '' as/);
  assert.match(migration, /revoke all on function public\.attendance_log_from_record\(\) from public, anon, authenticated;/);
  assert.doesNotMatch(migration, /grant execute on function public\.attendance_log_from_record/);
});

test("attendance trigger [faithful]: the session-bearing set is exactly strength_entry and wod_entry, in one shared helper", () => {
  assert.match(migration, /create or replace function public\.attendance_session_record_types\(\) returns text\[\]/);
  assert.match(migration, /select array\['strength_entry', 'wod_entry'\]::text\[\];/);
  // The four other record_types that carry a `date` key of the same shape
  // must not be in the set - the filter is on record_type, not on having a
  // date, which is what keeps a bodyweight reading from counting as training.
  for (const type of ["bodyweight", "measurement", "measure_type", "session_note"]) {
    assert.doesNotMatch(migration, new RegExp(`array\\[[^\\]]*'${type}'`), `${type} must not be session-bearing`);
  }
});

test("attendance trigger [faithful]: occurred_on comes from payload->>'date', parsed by the null-on-anything-bad helper rather than a bare cast", () => {
  assert.match(migration, /v_day := public\.attendance_parse_day\(new\.payload ->> 'date'\);/);
  assert.match(migration, /if v_day is null then return new; end if;/);
  // A bare `(payload->>'date')::date` anywhere on this path would raise
  // 22008 on '2026-13-45' and wedge the member's outbox forever.
  assert.doesNotMatch(migration, /new\.payload ->> 'date'\)::date/);
});

test("attendance parse [faithful]: the accepted date shape is exactly the one cleanISODate guarantees, and the parser never raises", () => {
  // cleanISODate() is the client-side gate. If its regex ever changes, this
  // assertion fails and the server-side copy has to change with it.
  assert.match(safeHelpersSrc, /function cleanISODate\(v\) \{\s*\n\s*if \(typeof v !== "string" \|\| !\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(v\)\) return null;/);
  assert.match(migration, /if p_raw is null or p_raw !~ '\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$' then return null; end if;/);
  assert.match(migration, /exception when others then\s*\n\s*return null;/);
});

test("attendance parse [faithful]: the shape the trigger reads is the shape app.js actually sends - `date`, top level, on both session types", () => {
  // sanitizeEntry / sanitizeWodEntry are what queueSyncRecord() puts into
  // `payload` verbatim (payload: record), so their `date` field IS the
  // trigger's input. Both derive it through cleanISODate.
  assert.match(sanitizeSrc, /function sanitizeEntry\(e\) \{[\s\S]*?date = cleanISODate\(e\.date\)/);
  assert.match(sanitizeSrc, /function sanitizeWodEntry\(e\) \{[\s\S]*?date = cleanISODate\(e\.date\)/);
  assert.match(cloudSrc, /payload: row\.payload \|\| \{\}/);
});

test("attendance trigger [faithful]: the future-date rule refuses the row rather than clamping it, with one day of slack for the UTC/local calendar gap", () => {
  assert.match(migration, /if v_day > current_date \+ 1 then return new; end if;/);
  // Clamping would have invented a training day the member never claimed,
  // permanently, because the table is append-only.
  assert.doesNotMatch(migration, /least\(v_day, current_date\)/);
});

test("attendance trigger [faithful]: append-only - it inserts and does nothing else, ever", () => {
  const body = migration.slice(
    migration.indexOf("create or replace function public.attendance_log_from_record()"),
    migration.indexOf("revoke all on function public.attendance_log_from_record()"),
  );
  assert.match(body, /insert into public\.attendance_log/);
  assert.doesNotMatch(body, /delete from/);
  assert.doesNotMatch(body, /update public\.attendance_log/);
});

// ---------------------------------------------------------------------------
// The client emit
// ---------------------------------------------------------------------------

test("flushOutbox [faithful]: the client's session-type list matches the migration's helper exactly, so the two sides cannot drift", () => {
  const clientList = cloudSrc.match(/const ATTENDANCE_SESSION_TYPES = \[([^\]]+)\];/);
  assert.ok(clientList, "cloud.js declares the list");
  const clientTypes = clientList[1].split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
  const sqlTypes = migration.match(/select array\[([^\]]+)\]::text\[\];/)[1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
  assert.deepStrictEqual(clientTypes, sqlTypes);
});

const VERIFIED = new Date().toISOString();
function seededMock() {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function bootWithBus() {
  const mock = seededMock();
  const window = await bootCommunity(mock, { syncEnabled: true });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 5000);
  const seen = [];
  window.HaimuniaEvents.on(window.PRODUCT_EVENTS.ATTENDANCE_RECORDED, (p) => seen.push(p));
  return { mock, window, seen };
}

test("ATTENDANCE_RECORDED [executing]: gets its first producer since COMM-012 - a synced strength_entry emits {occurred_on} and nothing else", async () => {
  const { mock, window, seen } = await bootWithBus();
  await window.queueSyncRecord("strength_entry", { id: "e1", exerciseId: "back-squat", weight: 100, reps: 5, sets: 3, date: "2026-08-10", type: "reps" });
  await waitFor(() => !!mock.db.private_records && mock.db.private_records.some((r) => r.record_id === "e1"), 5000);
  await waitFor(() => seen.length === 1, 5000);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(seen[0])), { occurred_on: "2026-08-10" });
});

test("ATTENDANCE_RECORDED [executing]: one emit per calendar day, not one per logged set", async () => {
  const { mock, window, seen } = await bootWithBus();
  await window.queueSyncRecord("strength_entry", { id: "e1", exerciseId: "back-squat", weight: 100, reps: 5, sets: 3, date: "2026-08-10", type: "reps" });
  await window.queueSyncRecord("strength_entry", { id: "e2", exerciseId: "deadlift", weight: 140, reps: 3, sets: 3, date: "2026-08-10", type: "reps" });
  await window.queueSyncRecord("wod_entry", { id: "w1", wodId: "fran", date: "2026-08-10", scoreType: "time", timeSeconds: 240, rx: true, isPR: false });
  await window.queueSyncRecord("wod_entry", { id: "w2", wodId: "cindy", date: "2026-08-11", scoreType: "amrap", rounds: 20, reps: 5, rx: true, isPR: false });
  await waitFor(() => (mock.db.private_records || []).length === 4, 5000);
  await waitFor(() => seen.length === 2, 5000);
  assert.deepStrictEqual(seen.map((p) => p.occurred_on).sort(), ["2026-08-10", "2026-08-11"]);
});

test("ATTENDANCE_RECORDED [executing]: a bodyweight or measurement sync is not a training session, and a soft-delete is not one either", async () => {
  const { mock, window, seen } = await bootWithBus();
  await window.queueSyncRecord("bodyweight", { id: "bw1", date: "2026-08-12", weight: 78.4 });
  await window.queueSyncRecord("measurement", { id: "ms1", typeId: "waist", date: "2026-08-13", value: 81 });
  await window.queueSyncRecord("movement", { id: "mv1", name: "Split squat", date: "2026-08-14" });
  await window.queueSyncRecord("strength_entry", { id: "e-del", exerciseId: "press", weight: 50, reps: 5, sets: 3, date: "2026-08-15", type: "reps" }, true);
  await waitFor(() => (mock.db.private_records || []).length === 4, 5000);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(seen, []);
});

test("ATTENDANCE_RECORDED [executing]: nothing is emitted when the write fails - a failed sync is not a session", async () => {
  const { mock, window, seen } = await bootWithBus();
  mock.failNextUpsert = mock.failNextUpsert || null;
  // Force every private_records write to fail by pointing the table at a
  // rejecting stub, the same shape a network error produces.
  const realFrom = mock.client.from.bind(mock.client);
  mock.client.from = (table) => (table === "private_records"
    ? { upsert: async () => ({ data: null, error: { message: "network" } }) }
    : realFrom(table));
  await window.queueSyncRecord("strength_entry", { id: "e-fail", exerciseId: "back-squat", weight: 100, reps: 5, sets: 3, date: "2026-08-16", type: "reps" });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepStrictEqual(seen, [], "the emit is after the write, never before it");
  mock.client.from = realFrom;
});

test("ATTENDANCE_RECORDED [executing]: a malformed local date never reaches the bus, matching the server-side parser", async () => {
  const { mock, window, seen } = await bootWithBus();
  // queueSyncRecord does not sanitize, so this is exactly what a corrupted
  // local record or a hand-edited import would put in the outbox.
  await window.queueSyncRecord("strength_entry", { id: "e-bad", exerciseId: "row", date: "yesterday", type: "reps" });
  await window.queueSyncRecord("strength_entry", { id: "e-none", exerciseId: "row", type: "reps" });
  await waitFor(() => (mock.db.private_records || []).length === 2, 5000);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(seen, []);
});

// ---------------------------------------------------------------------------
// The analytics bridge
// ---------------------------------------------------------------------------

test("attendance_recorded [executing]: bridged off the same bus emit, carrying occurred_on and nothing else", async () => {
  const { mock, window } = await bootWithBus();
  const before = (mock.db.analytics_events || []).length;
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.ATTENDANCE_RECORDED, {
    occurred_on: "2026-08-10",
    // Everything a future producer might be tempted to attach. None of it
    // may reach the table: a workout title and a result are member-authored
    // text about a private training log.
    title: "Back squat 5x5",
    result_text: "100kg",
    record_id: "e1",
  });
  await waitFor(() => (mock.db.analytics_events || []).length > before, 5000);
  const row = mock.db.analytics_events[mock.db.analytics_events.length - 1];
  assert.strictEqual(row.event_name, "attendance_recorded");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(row.props)), { occurred_on: "2026-08-10" });
});

test("attendance_recorded [executing]: counts toward WCAM - training is the strongest participation the definition names", async () => {
  const { window } = await bootWithBus();
  const a = window.HaimuniaAnalytics;
  assert.strictEqual(a.EVENTS.ATTENDANCE_RECORDED, "attendance_recorded");
  assert.ok(a.isActiveMemberEvent("attendance_recorded"));
  assert.strictEqual(a.BUS_EVENT_MAP.ATTENDANCE_RECORDED, "attendance_recorded");
  // Array.from re-homes the jsdom-realm array so deepStrictEqual compares
  // contents rather than prototypes.
  assert.deepStrictEqual(Array.from(a.BUS_PROP_KEYS.ATTENDANCE_RECORDED), ["occurred_on"]);
});
