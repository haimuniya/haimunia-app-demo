// Three findings carried on the open list across two branches, all in cloud.js.
//
//  1. A restricted member had no way to find out why, or for how long. The
//     only channel telling them anything was an error on a failed write.
//     RLS already granted them SELECT on their own posting_restrictions row
//     (202608280015) - the data was there and nothing rendered it.
//  2. The four <input type="datetime-local"> controls had the same
//     browser-locale defect the six type="date" controls were fixed for in
//     d540a34, and were deliberately left because a datetime echo raises a
//     timezone question a date-only echo does not.
//  3. Two coach-dashboard empty states the four-slot pass missed.
//
// Driven through the real render path (bootCommunity + the mock Supabase
// client) wherever the finding is about what a person SEES; source-text
// assertions only for invariants about the shape of the code itself.
//
// THE RLS HALF OF FINDING 1 IS NOT MOCKABLE and was verified against the
// real local stack rather than asserted here. Signed in over REST as two
// seeded members restricted through the real mod_restrict_member() RPC:
//
//   maya_t (temporary, reason recorded) reads back her own row with every
//     field this panel renders - restriction_type, expires_at, reason,
//     created_at, lifted_at.
//   itai_r (permanent, no reason) reads back expires_at: null and
//     reason: "" - the two edge cases the panel's copy forks on, arriving
//     from the database exactly as the schema's defaults promise.
//   noa_s (unrestricted) reads back [].
//   maya_t selecting the whole table gets ONE row, her own - the select
//     policy's `user_id = auth.uid()` branch holds, so this panel cannot
//     become an "is member X in trouble" oracle.
//   maya_t's post_create refuses with 'posting_restricted' while feed_page
//     still returns rows - so the panel's "you can still read the feed"
//     line is a promise the app keeps.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const src = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const VERIFIED = "2026-08-01T00:00:00.000Z";
const NOW = Date.now();
const daysAgoIso = (days) => new Date(NOW - days * 86400000).toISOString();
const daysAheadIso = (days) => new Date(NOW + days * 86400000).toISOString();

function memberMock(extra, opts) {
  const o = opts || {};
  const mock = createMockSupabase(Object.assign({
    profiles: [{ id: "m-1", handle: "maya_t", display_name: "מאיה", is_admin: !!o.admin, recovery_verified_at: VERIFIED, visible_to_club: true, created_at: daysAgoIso(400) }],
    invite_redemptions: [{ user_id: "m-1", invite_id: "inv-1", role: o.admin ? "admin" : "member", redeemed_at: daysAgoIso(400) }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    posting_restrictions: [],
    community_streaks: [], workout_posts: [], feed_page_rows: [], member_contact_log: [],
    coach_engagement_flags: [], analytics_events: [], notifications: [], notification_preferences: [],
    monthly_club_recaps: [], reports: [], challenges: [], weekly_challenges: [], onboarding_step_content: [],
  }, extra || {}));
  mock.setUser({ id: "m-1", is_anonymous: false, email: "maya_t@members.haimuniya.invalid" });
  return mock;
}
// The shape mod_restrict_member() actually writes, confirmed field-for-field
// against the rows the real RPC produced on the local stack.
function restrictionRow(over) {
  return Object.assign({
    id: "pr-1", club_id: "club-1", user_id: "m-1",
    restriction_type: "temporary", expires_at: daysAheadIso(9),
    reason: "פרסום חוזר של אותו תוכן בפיד", moderator_id: "admin-1",
    source_report_id: null, created_at: daysAgoIso(1),
    lifted_at: null, lifted_by: null, lift_reason: "",
  }, over || {});
}
async function openAccount(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]'), 4000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => !!window.document.getElementById("communityProfile"), 4000);
}
async function openBoards(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="set-tab"][data-tab="boards"]'), 4000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="boards"]').click();
  await waitFor(() => !!window.document.querySelector(".ach-section"), 3000);
}
const panelOf = (window) => window.document.querySelector("[data-my-restriction-panel]");

// ===========================================================================
// FINDING 1 - the restricted member's own surface
// ===========================================================================

test("THE DEFECT: a restricted member can now read the reason and the end date, instead of learning only that a write failed", async () => {
  const mock = memberMock({ posting_restrictions: [restrictionRow()] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  await waitFor(() => !!panelOf(window), 4000);
  const text = panelOf(window).textContent.replace(/\s+/g, " ").trim();

  // What happened, named plainly rather than implied.
  assert.match(text, /הגביל את הפרסום/, "the panel says a restriction was applied");
  // WHY - the half that no channel carried before, because an error string
  // has no row behind it.
  assert.match(text, /פרסום חוזר של אותו תוכן בפיד/, "the recorded reason is shown verbatim");
  // FOR HOW LONG - the other half. The migration's own justification for the
  // select policy is the sentence "you cannot post until 3 March, reason X",
  // so a date is the point of the exercise.
  assert.match(text, /ההגבלה מסתיימת ב-/, "and the end date is stated");
  assert.match(text, /בשעה \d\d:\d\d/, "to the hour, not just the day");
  // The blast radius, which is most of the reassurance - and true: feed_page
  // and toggle_reaction both answer 200 for a restricted member.
  assert.match(text, /לקרוא את הפיד/, "and bounds the sanction rather than implying the app is gone");
  // A route to a human, since only a moderator can lift it.
  assert.match(text, /לפנות למאמן\/ת/);
});

test("a permanent restriction says it will not lapse, and never invents an end date it does not have", async () => {
  const mock = memberMock({ posting_restrictions: [restrictionRow({ restriction_type: "permanent", expires_at: null })] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  await waitFor(() => !!panelOf(window), 4000);
  const text = panelOf(window).textContent.replace(/\s+/g, " ").trim();
  assert.match(text, /לא נקבע מועד סיום/, "the permanent case is stated as plainly as the temporary one");
  assert.equal(/ההגבלה מסתיימת ב-/.test(text), false, "and no end date is fabricated for a row that has none");
  // The schema constrains the pair together, so this must not soften into
  // "for now" - the member is owed the fact that waiting will not help.
  assert.match(text, /רק צוות המועדון יכול להסיר אותה/);
});

test("a restriction recorded with no reason says so, rather than leaving a silent gap where the reason goes", async () => {
  // reason is `not null default ''`, so "nothing was written down" arrives as
  // an empty string. Verified on the real stack: mod_restrict_member() with
  // p_reason '' stores '' and hands '' back to the member.
  const mock = memberMock({ posting_restrictions: [restrictionRow({ reason: "" })] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  await waitFor(() => !!panelOf(window), 4000);
  const text = panelOf(window).textContent.replace(/\s+/g, " ").trim();
  assert.match(text, /לא נרשמה סיבה/, "the absence of a reason is itself stated - staying quiet about it is the evasive failure mode");
  assert.match(text, /אפשר לבקש אותה מצוות המועדון/, "and the member is told who to ask for it");
});

test("a member who is not restricted sees no panel at all", async () => {
  const window = await bootCommunity(memberMock(), { syncEnabled: false });
  await openAccount(window);
  // The profile form is the marker that the tab finished rendering, so a
  // missing panel here is a real absence rather than an unfinished render.
  assert.ok(window.document.getElementById("communityProfile"), "the Account tab rendered");
  assert.equal(panelOf(window), null, "an unrestricted member must never see a card about restrictions");
});

test("a lapsed or lifted restriction renders nothing, matching the server predicate rather than merely 'a row exists'", async () => {
  // is_posting_restricted() is `lifted_at is null and (expires_at is null or
  // expires_at > now())`. A row failing either half is not in force, and a
  // panel keyed on row-existence alone would tell a member they are still
  // sanctioned when the database says they are not.
  const lapsed = restrictionRow({ id: "pr-old", expires_at: daysAgoIso(2) });
  const lifted = restrictionRow({ id: "pr-lifted", lifted_at: daysAgoIso(1), lifted_by: "admin-1" });
  for (const rows of [[lapsed], [lifted], [lapsed, lifted]]) {
    const window = await bootCommunity(memberMock({ posting_restrictions: rows }), { syncEnabled: false });
    await openAccount(window);
    assert.equal(panelOf(window), null, `an inactive restriction must not render: ${rows.map((r) => r.id).join(",")}`);
  }
});

test("with several unlifted rows, the panel shows the one actually in force, not merely the newest", async () => {
  // Overlapping unlifted rows are possible - a permanent one added over a
  // temporary one nobody lifted - and ordering by created_at alone would pick
  // whichever was written last regardless of whether it still applies.
  const stillActive = restrictionRow({ id: "pr-live", restriction_type: "permanent", expires_at: null, reason: "החלטת ועדת משמעת", created_at: daysAgoIso(30) });
  const lapsedNewer = restrictionRow({ id: "pr-lapsed", expires_at: daysAgoIso(1), reason: "סיבה ישנה", created_at: daysAgoIso(2) });
  const mock = memberMock({ posting_restrictions: [lapsedNewer, stillActive] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  await waitFor(() => !!panelOf(window), 4000);
  const text = panelOf(window).textContent;
  assert.match(text, /החלטת ועדת משמעת/, "the row still in force is the one rendered");
  assert.equal(/סיבה ישנה/.test(text), false, "the newer but lapsed row is not");
});

test("the panel is the FIRST thing on the Account tab, above the profile form", async () => {
  // A member may have come to this screen specifically to read this. Burying
  // it under the avatar picker would repeat the original defect more quietly.
  const mock = memberMock({ posting_restrictions: [restrictionRow()] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  await waitFor(() => !!panelOf(window), 4000);
  const panel = panelOf(window);
  const profile = window.document.getElementById("communityProfile");
  assert.ok(panel.compareDocumentPosition(profile) & window.Node.DOCUMENT_POSITION_FOLLOWING,
    "the restriction panel precedes the profile form in document order");
});

test("the reason is bidi-isolated and escaped, since it is moderator-authored text landing beside Hebrew, dates and digits", async () => {
  // A restriction expiry beside Hebrew is exactly the mixed-script hazard
  // bidiText exists for, and the reason is free text somebody else typed.
  const mock = memberMock({ posting_restrictions: [restrictionRow({ reason: '<img src=x onerror=alert(1)> spam 3 פוסטים' })] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccount(window);
  await waitFor(() => !!panelOf(window), 4000);
  const panel = panelOf(window);
  assert.ok(panel.querySelector("bdi"), "the panel's lines are bidi-isolated");
  assert.equal(panel.querySelector("img"), null, "moderator text is never parsed as markup - cloud.js keeps zero innerHTML sinks");
  assert.match(panel.textContent, /<img src=x onerror=alert\(1\)>/, "and survives as the literal text it was");
});

test("the panel never renders on a failed load, and never lets the client decide a member is NOT restricted", async () => {
  // Two separate properties. An errored load renders nothing (the write path
  // still refuses with the mapped error, so nobody is left with no channel);
  // and nothing in cloud.js branches on this row except the panel's own
  // markup, so a stale or skewed client can never grant itself posting rights.
  const loader = src.slice(src.indexOf("async function loadMyRestriction"), src.indexOf("async function loadMyRestriction") + 1800);
  assert.match(loader, /s\.row = error \? null : activeRestrictionRow\(data\);/,
    "an errored load clears the row rather than stranding a stale one");
  const uses = [...src.matchAll(/state\.myRestriction/g)].length;
  assert.ok(uses >= 3, "the state slot is read by the panel, the loader and the lazy-load gate");
  assert.equal(/if \([^)]*state\.myRestriction\.row[^)]*\)\s*return[^;]*;\s*\n\s*(await )?client\.rpc/.test(src), false,
    "no write path short-circuits on this row - the server is the enforcer");
});

test("the query asks only for the member's own unlifted rows, and never for a boolean the panel could not render", async () => {
  // Security hunt round 10 (202609120012): this used to be a direct
  // client.from("posting_restrictions") read with the scoping/filters
  // expressed as query builder calls - RLS's self-read branch was the
  // only thing stopping a direct read from also returning
  // moderator_id/lifted_by/source_report_id/lift_reason, which RLS
  // (row-level, not column-level) could never actually hide from a
  // client asking for them directly. The scoping moved server-side, into
  // my_posting_restrictions() itself (own-uid, unlifted-only, newest 5) -
  // this now checks the loader calls THAT function and nothing broader.
  const loader = src.slice(src.indexOf("async function loadMyRestriction"), src.indexOf("async function loadMyRestriction") + 1400);
  assert.match(loader, /client\.rpc\("my_posting_restrictions"\)/,
    "the loader calls the safe-column RPC, not a direct table read");
  // Code only: the loader's own comment explains why this is no longer a
  // direct table read, and matching that prose would defeat the check.
  const code = loader.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.equal(/from\("posting_restrictions"\)/.test(code), false,
    "no direct table read remains in the loader - a direct read exposes staff-internal columns RLS cannot hide");
  assert.equal(/is_posting_restricted/.test(code), false,
    "not the boolean RPC - a bare yes/no is exactly the shape that left the member uninformed");
});

test("the 'posting_restricted' error now names the surface, while keeping the route to a human", async () => {
  // The finding asked for this to be revisited once a real surface existed.
  // The message was written to carry a route to a human BECAUSE it was the
  // member's only channel; it is not that any more, so it hands off the two
  // facts it structurally cannot state - an error string has no row and can
  // never print a date.
  const entry = src.slice(src.indexOf("posting_restricted: \""), src.indexOf("posting_restricted: \"") + 400);
  assert.match(entry, /בטאב/, "the error points at the tab where the reason and the end date live");
  assert.match(entry, /לפנות למאמן\/ת/, "and still ends at a person, because it is often the first news");
  // Every channel that mentions the restriction agrees on where the detail is,
  // rather than each carrying its own partial account.
  const mentions = [...src.matchAll(/מוגבל כרגע מ[^"]*/g)].map((m) => m[0]);
  assert.ok(mentions.length >= 2, "the inline comment-create and comment-edit errors both exist");
  for (const m of mentions) assert.match(m, /בטאב/, `an inline restriction error does not point at the surface: ${m}`);
});

// ===========================================================================
// FINDING 2 - datetime-local has the same locale defect as date
// ===========================================================================

test("every datetime-local input in cloud.js goes through dateTimeField, so none can ship without the echo", () => {
  const dtInputs = [...src.matchAll(/[a-zA-Z]+\((\s*)?"[^"]+", "[^"]+", "[^"]+", `<input[^`]*type="datetime-local"/g)];
  assert.ok(dtInputs.length >= 4, `expected the four known datetime-local fields, found ${dtInputs.length}`);
  for (const m of dtInputs) {
    assert.ok(m[0].startsWith("dateTimeField("), `a type="datetime-local" input is still on plain field(): ${m[0].slice(0, 90)}`);
  }
});

test("the echo resolves BOTH ambiguities a datetime-local control has: the date order and the 12-hour clock", async () => {
  const mock = memberMock({}, { admin: true });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="open-event-form"]'), 4000);
  window.document.querySelector('[data-community-action="open-event-form"]').click();
  await waitFor(() => !!window.document.querySelector('#communityEventForm [name="startAt"]'), 4000);
  const input = window.document.querySelector('#communityEventForm [name="startAt"]');
  const echo = window.document.getElementById(input.dataset.dateEcho);
  assert.ok(echo, "the input names its own echo element");
  assert.match(echo.textContent, /אחרי הבחירה/, "before anything is picked the slot says the echo is coming");

  // en-US paints this value as `06/01/2026, 06:00 PM`.
  input.value = "2026-06-01T18:00";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.match(echo.textContent, /ביוני/, "1 June is echoed as June");
  assert.equal(/בינואר/.test(echo.textContent), false, "never as 6 January");
  assert.match(echo.textContent, /18:00/, "and 18:00 as 18:00 - the half the date fields never had to resolve");
  assert.equal(/PM|AM/.test(echo.textContent), false, "no 12-hour form survives into the echo");
});

test("an early-morning time is echoed as 06:00, which is the exact value a 12-hour control invites a member to confuse", async () => {
  const mock = memberMock({}, { admin: true });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="open-event-form"]'), 4000);
  window.document.querySelector('[data-community-action="open-event-form"]').click();
  await waitFor(() => !!window.document.querySelector('#communityEventForm [name="startAt"]'), 4000);
  const input = window.document.querySelector('#communityEventForm [name="startAt"]');
  const echo = window.document.getElementById(input.dataset.dateEcho);
  input.value = "2026-06-01T06:00";
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.match(echo.textContent, /06:00/, "zero-padded 24-hour, so 6am and 6pm can never read alike");
});

test("THE TIMEZONE ANSWER: the echo names the clock the app actually resolves the value against, and refuses to claim Israel time", async () => {
  // This is the question that got the finding deferred. datetime-local is
  // zone-less; an event at 18:00 means 18:00 at the box; and naming the wrong
  // zone would be a new false statement rather than a fix.
  //
  // The resolution is that the echo does not have to know where the box is.
  // It states which clock THIS CODE reads the number against, which is true
  // at both ends: submitEventForm does `new Date(startAt).toISOString()` and
  // submitAnnouncement does `new Date(expiresAtRaw)` - a date-time string
  // with no offset parses in the runtime's LOCAL zone - while eventLocalParts
  // paints stored instants back through local getters.
  const mock = memberMock({}, { admin: true });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="open-event-form"]'), 4000);
  window.document.querySelector('[data-community-action="open-event-form"]').click();
  await waitFor(() => !!window.document.querySelector('#communityEventForm [name="startAt"]'), 4000);
  const input = window.document.querySelector('#communityEventForm [name="startAt"]');
  const echo = window.document.getElementById(input.dataset.dateEcho);
  input.value = "2026-06-01T18:00";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.match(echo.textContent, /לפי שעון המכשיר/, "the echo names the device clock, which is a fact about this code");
  assert.equal(/שעון ישראל|ישראל|UTC|GMT/.test(echo.textContent), false,
    "and never asserts a geographic zone it cannot read back - the same refusal the date pass made about segment order");
});

test("the echo is derived by regex off the value and never through new Date(), so it cannot itself shift under a device timezone", () => {
  const fn = src.slice(src.indexOf("function hebrewDateTimeEchoText"), src.indexOf("const DATETIME_ECHO_PENDING_TEXT") >= 0
    ? src.indexOf("function dateField") : src.length);
  const body = fn.slice(0, fn.indexOf("\n  }") + 4);
  assert.match(body, /\/\^\(\\d\{4\}\)-\(\\d\{2\}\)-\(\\d\{2\}\)T/, "parsed off the ISO-shaped string");
  assert.equal(/new Date\(/.test(body), false,
    "no Date object in the echo path - the line whose whole job is to be unambiguous must not be a function of the device clock");
});

test("an incomplete or cleared datetime falls back to the pending line rather than echoing half a moment", async () => {
  const mock = memberMock({}, { admin: true });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="open-event-form"]'), 4000);
  window.document.querySelector('[data-community-action="open-event-form"]').click();
  await waitFor(() => !!window.document.querySelector('#communityEventForm [name="endAt"]'), 4000);
  const input = window.document.querySelector('#communityEventForm [name="endAt"]');
  const echo = window.document.getElementById(input.dataset.dateEcho);
  input.value = "2026-06-01T18:00";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.match(echo.textContent, /ביוני/);
  // A date with no time is exactly the half-entered state a member passes
  // through, and echoing it as a moment would assert a midnight nobody chose.
  input.value = "2026-06-01";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.match(echo.textContent, /אחרי הבחירה/, "a date with no time is not a moment and is not echoed as one");
  input.value = "";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.match(echo.textContent, /אחרי הבחירה/, "clearing the field clears the echo");
});

test("the datetime echo reuses dateField's mechanism: one <bdi>, patched by textContent, no rerender", async () => {
  const mock = memberMock({}, { admin: true });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="open-event-form"]'), 4000);
  window.document.querySelector('[data-community-action="open-event-form"]').click();
  await waitFor(() => !!window.document.querySelector('#communityEventForm [name="startAt"]'), 4000);
  const input = window.document.querySelector('#communityEventForm [name="startAt"]');
  const echo = window.document.getElementById(input.dataset.dateEcho);
  assert.equal(echo.tagName.toLowerCase(), "bdi", "the echo target is the <bdi> itself");
  input.value = "2026-12-31T23:59";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  // The element identity survives, which is what proves nothing re-rendered
  // the focused control out from under the caret.
  assert.strictEqual(window.document.getElementById(input.dataset.dateEcho), echo, "the same node was patched, not replaced");
  assert.equal(echo.querySelector("*"), null, "textContent, never markup");
  assert.match(echo.textContent, /בדצמבר/);
  assert.match(echo.textContent, /23:59/);
});

test("the datetime value itself is untouched: the event form still stores the same instant it did before the echo", async () => {
  const mock = memberMock({}, { admin: true });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="open-event-form"]'), 4000);
  window.document.querySelector('[data-community-action="open-event-form"]').click();
  await waitFor(() => !!window.document.getElementById("communityEventForm"), 4000);
  const form = window.document.getElementById("communityEventForm");
  form.elements.title.value = "אירוע בדיקה";
  form.elements.startAt.value = "2026-06-01T18:00";
  form.elements.startAt.dispatchEvent(new window.Event("input", { bubbles: true }));
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => mock.db.events && mock.db.events.length > 0, 3000);
  // The stored instant is still the typed wall-clock resolved against the
  // running device's zone - unchanged by the echo, which is read-only and
  // never in the write path.
  assert.equal(mock.db.events[0].start_at, new Date("2026-06-01T18:00").toISOString());
});

// ===========================================================================
// FINDING 3 - the two bare one-liners the empty-state pass missed
// ===========================================================================

test("the empty challenges list is on the four-slot pattern, and is written for the member who cannot act", async () => {
  // Left out of the original eleven because it is a SHARED member-facing
  // surface, not coach-only: it renders on the Boards sub-tab every member
  // has. That was the right thing to pause on - copy aimed at a coach is
  // wrong for the member reading it - so the headline and explanation are
  // written for the member and only slot 4 forks.
  const window = await bootCommunity(memberMock(), { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-empty-state="challenges-active"]'), 4000);
  const el = window.document.querySelector('[data-empty-state="challenges-active"]');
  const text = el.textContent.replace(/\s+/g, " ").trim();
  assert.ok(el.querySelector("svg"), "slot 1, an icon");
  assert.match(text, /אתגרי המועדון יופיעו כאן/, "slot 2, a forward-looking headline");
  assert.match(text, /יעד משותף/, "slot 3, what the space is built from");
  // Slot 4 for a member is a when-line, not a button: only staff can open a
  // challenge, so a button here would be a door that goes nowhere.
  assert.match(text, /כשצוות המועדון יפתח אתגר חדש/, "slot 4, a when-line addressed to the member");
  assert.equal(el.querySelector("button"), null, "and no button a member cannot honour");
});

test("staff get a when-line pointing at the create button already on screen, not a second door onto it", async () => {
  const window = await bootCommunity(memberMock({}, { admin: true }), { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-empty-state="challenges-active"]'), 4000);
  const el = window.document.querySelector('[data-empty-state="challenges-active"]');
  assert.match(el.textContent, /אתגר חדש/, "staff copy names the control that fills this space");
  assert.equal(el.querySelector("button"), null,
    "the real action is rendered directly above and is not duplicated inside the empty state");
  assert.ok(window.document.querySelector('[data-community-action="open-challenge-form"]'), "and that control is genuinely on screen");
});

test("the monthly recap empty state is a when-line, because a scheduled job fills it and no coach can press anything", () => {
  // recap_monthly_generate() runs on cron ('41 4 1 * *'), so the only honest
  // fourth slot is the schedule. Source-level: reaching this state at runtime
  // needs the coach dashboard, which the existing follow-up suite already
  // drives.
  const site = src.slice(src.indexOf('key: "coach-monthly-recap"'), src.indexOf('key: "coach-monthly-recap"') + 1200);
  assert.match(site, /headline: "התקציר החודשי של המועדון ייבנה מעצמו"/, "a forward-looking headline");
  assert.match(site, /when: "משימה מתוזמנת מייצרת אותו ב-1 בכל חודש/, "a when-line naming the real schedule");
  assert.equal(/action:/.test(site), false, "and no button, because nothing a coach can press generates the row");
  // Must not promise the publish button to a coach who will not get one: it
  // is gated on analytics-view-or-admin, narrower than preview access.
  assert.equal(/אפשר לפרסם|תוכל לפרסם/.test(site), false, "and does not promise a publish control this coach may not have");
});

test("neither new empty state opens with a word the spec's tone rules ban", () => {
  for (const key of ["challenges-active", "coach-monthly-recap"]) {
    const site = src.slice(src.indexOf(`key: "${key}"`), src.indexOf(`key: "${key}"`) + 1200);
    const headline = /headline: "([^"]+)"/.exec(site);
    assert.ok(headline, `${key} declares a headline`);
    assert.ok(!/^(אין|עדיין לא|מעולם לא)\b/.test(headline[1]), `${key} headline opens with a banned word: ${headline[1]}`);
  }
});

test("no bare one-liner empty state is left in the two places this finding named", () => {
  // The regression form: a future edit reverting either to a bare `.empty`
  // div beside its now-consistent siblings.
  assert.equal(src.includes("אין אתגרים פעילים כרגע"), false, "the challenges one-liner is gone");
  assert.equal(src.includes("עדיין לא נוצר תקציר חודשי"), false, "the monthly recap one-liner is gone");
});
