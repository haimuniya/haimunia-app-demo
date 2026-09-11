// Live bug hunt, round 6 (2026-09-11): three fresh agents driving the real
// app found confirmed bugs across Hebrew grammar/RTL content, extreme
// content values, and units/dates/locale formatting (see CHANGES.md for the
// full report). This file covers the cloud.js findings; the multi-line
// session-note fix lives next to its sibling test in
// test/roadmap-features.test.mjs, and the onboarding-recap grammar fix's
// test is inline in test/community-onboarding.test.mjs (it already seeded
// exactly the count=1 boundary this fix targets).
//
// Forced to Asia/Jerusalem so the todayIso()-was-UTC bug (Israel is always
// ahead of UTC) reproduces deterministically regardless of the host
// machine's own timezone. Must be set before any Date is touched.
process.env.TZ = "Asia/Jerusalem";

import { test } from "node:test";
import assert from "node:assert";
import { bootApp } from "./helpers/boot.mjs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

function seeded(extra) {
  const mock = createMockSupabase(Object.assign({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: new Date().toISOString(), visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: new Date().toISOString() }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    onboarding_progress: [{ user_id: "u1", welcomed_at: new Date().toISOString(), first_week_shown_at: new Date().toISOString(), first_month_shown_at: new Date().toISOString(), first_class_shown_at: new Date().toISOString(), third_class_shown_at: new Date().toISOString() }],
    challenges: [], challenge_participants: [], weekly_recaps: [],
    notifications: [], notification_preferences: [],
    attendance_log: [], announcements: [], club_wod_sessions: [], workout_posts: [],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}
async function openFeed(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityClubTop"), 4000);
}
// Same trick test/live-bug-hunt-round3.test.mjs already uses for app.js:
// boot with the real clock, THEN swap window.Date so every subsequent
// `new Date()` call (todayIso() included - it is called fresh on every
// render, never memoized) resolves against the fixed instant.
function installFixedClock(window, iso) {
  const RealDate = window.Date;
  const fixedMs = new Date(iso).getTime();
  class FixedDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(fixedMs); else super(...args); }
    static now() { return fixedMs; }
  }
  window.Date = FixedDate;
  return () => { window.Date = RealDate; };
}

// ---------------------------------------------------------------------------
// todayIso() was UTC, not local - confirmed live 01:00 Asia/Jerusalem time
// (= 22:00 UTC the day before), where Israel's real calendar day has already
// advanced but the old UTC-based function still reported yesterday.
// ---------------------------------------------------------------------------
test("the feed's pinned-for-today note uses the LOCAL calendar day, not UTC - at 01:00 Asia/Jerusalem the local day has already turned over", async () => {
  // 2026-06-14T22:00:00Z = 2026-06-15T01:00:00+03:00 (DST) local - local
  // date is the 15th, UTC date is still the 14th.
  const LOCAL_TODAY = "2026-06-15";
  const UTC_TODAY = "2026-06-14";
  const mock = seeded({
    announcements: [
      { id: "a-today", author_id: "u1", title: "הערה של היום", body: "פתק אמיתי של היום", created_at: new Date().toISOString(), pinned_date: LOCAL_TODAY, priority: "normal", expires_at: null, profiles: { handle: "dana", display_name: "דנה" } },
      { id: "a-stale", author_id: "u1", title: "הערה ישנה", body: "פתק מאתמול (ישן)", created_at: new Date().toISOString(), pinned_date: UTC_TODAY, priority: "normal", expires_at: null, profiles: { handle: "dana", display_name: "דנה" } },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  const restore = installFixedClock(window, "2026-06-14T22:00:00.000Z");
  try {
    await openFeed(window);
    await waitFor(() => window.document.body.textContent.includes("הערת האימון להיום"), 4000);
    // Scoped to the pinned card specifically - the OTHER announcement is
    // still expected to render further down, in the ordinary archive list;
    // the bug is about which one wins the single "pinned for today" slot,
    // not about the stale one being invisible everywhere.
    const pinnedCard = window.document.querySelector('[data-announcement-id="a-today"]');
    assert.ok(pinnedCard, "the announcement pinned for the real local today must win the pinned-card slot (data-announcement-id=a-today)");
    assert.match(pinnedCard.textContent, /הערה של היום/);
    const staleAsPinned = window.document.querySelector('[data-announcement-id="a-stale"]')?.textContent.includes("הערת האימון להיום");
    assert.ok(!staleAsPinned, "the UTC-lagging note must not win the pinned-card slot");
  } finally { restore(); }
});

test("the Club WOD board date label reads today's own session as 'today', not 'tomorrow', at 01:00 local time", async () => {
  const LOCAL_TODAY = "2026-06-15";
  const mock = seeded({
    club_features: [{ club_id: "club-1", module_key: "club_wod", enabled: true, config: {} }],
  });
  // Minimal club_wod_boards response matching the real shape
  // (test/community-club-wod-board.test.mjs's own boardJson()) - only the
  // fields clubWodDateLabel()/the board card actually read.
  mock.onRpc("club_wod_boards", () => ({
    data: [{
      session_id: "sess-1", session_date: LOCAL_TODAY, note: "", post_id: null,
      published_at: new Date().toISOString(),
      published_by: { id: "u1", display_name: "דנה", handle: "dana", avatar_url: null },
      cancelled_at: null,
      wod: { id: "wod-1", name: "Test Chipper", category: "Custom", scoreType: "time", desc: "" },
      result_count: 0, results: [],
      viewer: { attached: false, result_text: null, score_type: null, rx: null, occurred_on: null, attached_at: null, can_attach: true, can_detach: false, closed_reason: null },
    }],
    error: null,
  }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  const restore = installFixedClock(window, "2026-06-14T22:00:00.000Z");
  try {
    await openFeed(window);
    await waitFor(() => /Test Chipper/.test(window.document.body.textContent), 4000);
    const text = window.document.body.textContent;
    assert.doesNotMatch(text, /מחר/, "today's own session must never be labeled 'tomorrow' just because UTC hasn't turned over yet");
  } finally { restore(); }
});

// ---------------------------------------------------------------------------
// Hebrew singular/plural grammar - relativeTime() and participantsLabel(),
// the two highest-traffic sites (feed timestamps; event/challenge RSVP
// counts).
// ---------------------------------------------------------------------------
test("relativeTime() says 'לפני יום' for a 1-day-old post, not 'לפני 1 ימים'", async () => {
  const oneDayAgo = new Date(Date.now() - 25 * 3600000).toISOString();
  const mock = seeded({
    feed_page_rows: [{
      id: "p1", post_type: "POST_TEXT", author_id: "u1", author: { display_name: "דנה", handle: "dana" },
      body: "אימון טוב", visibility: "club", created_at: oneDayAgo, published_at: oneDayAgo,
      reaction_count: 0, comment_count: 0, media: [], metadata: {},
    }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await waitFor(() => /אימון טוב/.test(window.document.body.textContent), 4000);
  const text = window.document.body.textContent;
  assert.match(text, /לפני יום(?!ים)/, "a 1-day-old post must read 'לפני יום', not 'לפני 1 ימים'");
  assert.doesNotMatch(text, /לפני 1 ימים/);
});

test("an event's first RSVP reads 'משתתף אחד', not '1 משתתפים'", async () => {
  const mock = seeded({
    events: [{ id: "e1", event_type: "class", title: "אימון קבוצתי", description: "", status: "published", start_at: new Date(Date.now() + 86400000).toISOString(), end_at: null, location: "", capacity: null, registration_deadline: null, created_by: "u1" }],
    event_attendees: [{ event_id: "e1", user_id: "u1", response: "going" }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 4000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="boards"]').click();
  await waitFor(() => !!window.document.querySelector('[data-event-id="e1"]'), 4000);
  const text = window.document.querySelector('[data-event-id="e1"]').textContent;
  assert.match(text, /משתתף אחד/, "the first RSVP must read 'משתתף אחד', the singular form");
  assert.doesNotMatch(text, /1 משתתפים/);
});

// ---------------------------------------------------------------------------
// Identity spoofing via bidi-override characters, and the zero-width-only
// "invisible name that still counts as set" gap - both closed at the
// shared cleanStr() layer (src/shared/safe-helpers.js), applied to
// cloud.js's saveProfile() for the first time this round.
// ---------------------------------------------------------------------------
test("a display name typed with an RTL-override character never reaches the DOM ordered against what was typed", async () => {
  const mock = seeded({});
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  const rlo = String.fromCodePoint(0x202e);
  const typed = "safe_photo" + rlo + "gnp.exe";

  const accountTabBtn = window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]');
  accountTabBtn.click();
  await waitFor(() => !!window.document.getElementById("communityProfile"), 4000);
  const form = window.document.getElementById("communityProfile");
  form.elements.handle.value = "dana_k";
  form.elements.displayName.value = typed;
  form.elements.bio.value = "";
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => !!mock.db.profiles.find((p) => p.id === "u1"), 4000);

  const stored = mock.db.profiles.find((p) => p.id === "u1").display_name;
  assert.equal(stored.includes(rlo), false, "the RTL-override character must never be written to storage");
  assert.equal(stored, "safe_photognp.exe", "the visible characters survive, only the override control character is stripped");
});

test("a zero-width-only display name is treated as not set, not as an invisible-but-present name", async () => {
  const mock = seeded({});
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  const zwsp = String.fromCodePoint(0x200b);

  const accountTabBtn = window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]');
  accountTabBtn.click();
  await waitFor(() => !!window.document.getElementById("communityProfile"), 4000);
  const form = window.document.getElementById("communityProfile");
  form.elements.handle.value = "dana_k";
  form.elements.displayName.value = zwsp.repeat(5);
  form.elements.bio.value = "";
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => !!mock.db.profiles.find((p) => p.id === "u1"), 4000);

  const stored = mock.db.profiles.find((p) => p.id === "u1").display_name;
  assert.equal(stored, "", "zero-width-only input must clean down to an actually-empty string, not an invisible non-empty one");
});

// ---------------------------------------------------------------------------
// daysSinceBoxStart() drifted a day around a DST spring-forward boundary
// (raw ms-division, not local-calendar-day counting).
// ---------------------------------------------------------------------------
test("daysSinceBoxStart() counts local calendar days correctly across a DST spring-forward boundary", async () => {
  const window = await bootApp();
  // 2026-03-24 (before Israel's spring-forward) to 2026-03-30 00:10 local
  // (after it) is exactly 6 calendar days - real elapsed ms is 6*86400000
  // MINUS the lost DST hour, which the old Math.floor(ms/86400000)
  // implementation reported as 5.
  window.saveBoxStartDate("2026-03-24");
  const RealDate = window.Date;
  const fixedMs = new RealDate("2026-03-29T21:10:00.000Z").getTime(); // = 2026-03-30T00:10 IDT local
  class FixedDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(fixedMs); else super(...args); }
    static now() { return fixedMs; }
  }
  window.Date = FixedDate;
  try {
    assert.equal(window.daysSinceBoxStart(), 6, "must count 6 full local calendar days, not 5 (the DST-drift bug)");
  } finally { window.Date = RealDate; }
});
