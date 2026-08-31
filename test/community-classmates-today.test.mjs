// COMM-307 - the client half of the post-class trained-with-you card,
// executed for real in jsdom against the mock Supabase client
// (test/helpers/mockSupabase.mjs), not regex-matched against cloud.js.
//
// WHAT THIS FILE VERIFIES
// - The card calls attendance_classmates_today({ p_limit: 6 }) once per feed
//   session, from the Feed sub-tab, and renders the rows in the order the
//   function returned them - name, handle and a profile link each, and never
//   re-sorted client-side.
// - THE OMISSION, which is the ticket's central behaviour and gets four tests
//   rather than one, because the four are different code paths that must all
//   arrive at the same nothing: an empty set, a caller who did not train
//   today, a caller whose own show_attendance is off, and a failed fetch. In
//   every one of them there is no card, no heading, no empty state and no
//   retry - and the first three are indistinguishable from outside, which is
//   the function's own privacy answer (202608310005) and not something the
//   client is allowed to unpick.
// - The Follow control is rendered on every row, including a member whose
//   allow_follows is off, and it goes through the same follow() insert path
//   the directory and the following lists use - no new follow mechanism, no
//   client-side pre-filter that would leak another member's setting.
// - No "Message" affordance anywhere on the card, per the phase's standing
//   no-messaging resolution.
// - classmates_card_viewed fires once per load of the card with { rows,
//   source }, never on a re-render, never when the card is absent, carries no
//   member identity, and is not in ACTIVE_MEMBER_EVENTS.
// - The card claims nothing the four returned keys cannot support: no count,
//   no streak, no "trained X hours ago".
//
// WHAT THIS FILE DOES NOT VERIFY
// The privacy gating, the block edges, the admin short-circuit, the
// self-join on current_date, the ordering and the p_limit clamp themselves -
// those are Postgres (202608310005) and are covered by 35 assertions in
// supabase/tests/0041_attendance_classmates_today_test.sql. The mock mirrors
// the shipped function's shape and the four behaviours the client actually
// depends on; a fuller JS re-implementation would only ever assert itself.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const NOW = Date.now();
const iso = (deltaDays) => new Date(NOW + deltaDays * 86400000).toISOString();
const TODAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(NOW - 86400000).toISOString().slice(0, 10);

// show_attendance is spelled out on every fixture profile on purpose: it
// defaults to FALSE server-side, so a fixture that leaves it off is a member
// who is not on this card, and a test that forgot it would pass for the wrong
// reason.
function baseProfiles() {
  return [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, show_attendance: true, created_at: iso(-100) },
    { id: "u2", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, show_attendance: true, created_at: iso(-90) },
    { id: "u3", handle: "tal", display_name: "טל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, show_attendance: true, created_at: iso(-80) },
    { id: "u4", handle: "amit", display_name: "עמית", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, show_attendance: true, created_at: iso(-70) },
  ];
}

function seeded(extra) {
  const mock = createMockSupabase(Object.assign({
    profiles: baseProfiles(),
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: iso(-100) },
      { user_id: "u2", invite_id: "inv-1", role: "member", redeemed_at: iso(-90) },
      { user_id: "u3", invite_id: "inv-1", role: "member", redeemed_at: iso(-80) },
      { user_id: "u4", invite_id: "inv-1", role: "member", redeemed_at: iso(-70) },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    attendance_log: [],
    analytics_events: [], community_streaks: [],
    challenges: [], challenge_participants: [], challenge_teams: [], challenge_progress: [],
    events: [], event_attendees: [], workout_posts: [], feed_page_rows: [],
    notifications: [], notification_preferences: [],
    follows: [], blocks: [], reactions: [], post_comments: [],
    feed_impressions: [], feed_interactions: [],
    onboarding_progress: [{ user_id: "u1", welcomed_at: VERIFIED, first_week_shown_at: VERIFIED, first_month_shown_at: VERIFIED }],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

// One attendance_log row. recorded_at is what the function orders by, so the
// fixtures set it explicitly rather than letting it default - a fixture where
// every row ties would never exercise the order at all.
const logged = (userId, day, recordedAt) => ({
  id: `al-${userId}-${day}`, user_id: userId, club_id: "club-1",
  occurred_on: day, recorded_at: recordedAt || new Date(NOW).toISOString(),
});

async function openFeed(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 4000);
}
const card = (window) => window.document.querySelector("[data-classmates-today]");
const rowsOf = (window) => Array.from(window.document.querySelectorAll("[data-classmate-user]"));
const analytics = (mock, name) => (mock.db.analytics_events || []).filter((r) => r.event_name === name);

// Every "no card" test waits on the same thing: the RPC has answered, so a
// missing card is a real omission and not a render that has not happened yet.
async function settled(mock) {
  await waitFor(() => mock.callsTo("attendance_classmates_today").length >= 1, 4000);
  await new Promise((r) => setTimeout(r, 60));
}

test("COMM-307: the card calls attendance_classmates_today(6) once and lists today's classmates in the order returned", async () => {
  const mock = seeded({
    attendance_log: [
      logged("u1", TODAY, iso(0)),
      // Deliberately NOT alphabetical by recorded_at: u4 logged last, so the
      // server's recency order is u4, u3, u2 while an alphabetical or an
      // id order would be u2, u3, u4. If the client re-sorted, this would
      // come back in the other order.
      logged("u2", TODAY, new Date(NOW - 30 * 60000).toISOString()),
      logged("u3", TODAY, new Date(NOW - 20 * 60000).toISOString()),
      logged("u4", TODAY, new Date(NOW - 10 * 60000).toISOString()),
    ],
  });
  const window = await bootCommunity(mock);
  await openFeed(window);
  await waitFor(() => !!card(window), 4000);

  assert.deepStrictEqual(JSON.parse(JSON.stringify(mock.callsTo("attendance_classmates_today"))), [{ p_limit: 6 }]);
  assert.deepStrictEqual(rowsOf(window).map((el) => el.dataset.classmateUser), ["u4", "u3", "u2"]);
  const text = card(window).textContent;
  for (const name of ["עמית", "טל", "נועם"]) assert.ok(text.includes(name), `expected ${name} on the card`);
  for (const handle of ["@amit", "@tal", "@noam"]) assert.ok(text.includes(handle), `expected ${handle} on the card`);
  // The caller is never their own classmate.
  assert.equal(window.document.querySelector('[data-classmate-user="u1"]'), null);
  // Each row links to that member's profile through the same navigation
  // every other member row in the app uses.
  for (const row of rowsOf(window)) {
    const link = row.querySelector('[data-community-action="view-profile"]');
    assert.ok(link, "every row has a profile link");
    assert.equal(link.dataset.id, row.dataset.classmateUser);
  }
});

test("COMM-307: the card sits in the feed top area, above the feed list, and claims nothing beyond the four returned keys", async () => {
  const mock = seeded({
    attendance_log: [logged("u1", TODAY), logged("u2", TODAY)],
    feed_page_rows: [
      { id: "p1", author_id: "u2", handle: "noam", display_name: "נועם", post_type: "POST_WORKOUT", title: "אימון", body: "אימון", result_text: "5x5", published_at: iso(0), created_at: iso(0), cheer_count: 0, comment_count: 0 },
    ],
  });
  const window = await bootCommunity(mock);
  await openFeed(window);
  await waitFor(() => !!card(window), 4000);

  const feedList = window.document.getElementById("communityFeedList");
  assert.ok(feedList, "the feed list rendered");
  // Node.DOCUMENT_POSITION_FOLLOWING === 4: the card comes before the list.
  assert.equal(card(window).compareDocumentPosition(feedList) & 4, 4);

  // No count, no streak, no date and no "trained X ago" - attendance_log
  // records a day, not a time, and the function returns four keys and no
  // fifth, so any of these would be the client inventing a claim.
  const text = card(window).textContent;
  assert.doesNotMatch(text, /לפני/);
  assert.doesNotMatch(text, /רצף/);
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}/);
});

test("COMM-307: an empty result renders no card at all - no heading, no empty state", async () => {
  // The caller trained today; nobody else did.
  const mock = seeded({ attendance_log: [logged("u1", TODAY)] });
  const window = await bootCommunity(mock);
  await openFeed(window);
  await settled(mock);

  assert.equal(card(window), null);
  assert.equal(rowsOf(window).length, 0);
  assert.doesNotMatch(window.document.body.textContent, /התאמנו היום גם/);
});

test("COMM-307: a caller who did not log a session today gets no card, however many members did", async () => {
  const mock = seeded({
    attendance_log: [
      logged("u1", YESTERDAY),
      logged("u2", TODAY), logged("u3", TODAY), logged("u4", TODAY),
    ],
  });
  const window = await bootCommunity(mock);
  await openFeed(window);
  await settled(mock);

  assert.equal(card(window), null);
  assert.doesNotMatch(window.document.body.textContent, /התאמנו היום גם/);
});

test("COMM-307: a caller whose own show_attendance is off gets the same nothing, indistinguishable from having trained alone", async () => {
  const profiles = baseProfiles();
  profiles[0].show_attendance = false;
  const mock = seeded({
    profiles,
    attendance_log: [logged("u1", TODAY), logged("u2", TODAY), logged("u3", TODAY)],
  });
  const window = await bootCommunity(mock);
  await openFeed(window);
  await settled(mock);

  // Same absence, same DOM, no error branch and no message telling the member
  // why. The client asked, the server answered with an empty set, and there
  // is nothing here that could tell that apart from "nobody else trained".
  assert.equal(card(window), null);
  assert.doesNotMatch(window.document.body.textContent, /התאמנו היום גם/);
  // Their attendance is still logged - the toggle governs the card, not the
  // row behind it.
  assert.equal(mock.db.attendance_log.filter((r) => r.user_id === "u1").length, 1);
});

test("COMM-307: a failed fetch omits the card entirely - no heading, no empty state, no retry", async () => {
  const mock = seeded({ attendance_log: [logged("u1", TODAY), logged("u2", TODAY)] });
  mock.onRpc("attendance_classmates_today", () => ({ data: null, error: { message: "boom" } }));
  const window = await bootCommunity(mock);
  await openFeed(window);
  await settled(mock);

  assert.equal(card(window), null);
  assert.doesNotMatch(window.document.body.textContent, /התאמנו היום גם/);
  // The distinguishing mark of this state: no retry affordance was invented
  // for it, the same choice people_suggestions makes for its own strip.
  assert.equal(window.document.querySelector('[data-community-action="classmates-retry"]'), null);
  // And nothing is counted for a card that never rendered.
  assert.equal(analytics(mock, "classmates_card_viewed").length, 0);
});

test("COMM-307: Follow on a classmate row writes the edge through the same follow() path, and the row stays", async () => {
  const mock = seeded({ attendance_log: [logged("u1", TODAY), logged("u2", TODAY)] });
  const window = await bootCommunity(mock);
  await openFeed(window);
  await waitFor(() => !!window.document.querySelector('[data-classmate-user="u2"]'), 4000);

  const btn = window.document.querySelector('[data-classmate-user="u2"] [data-community-action="follow"]');
  assert.ok(btn, "the row has a Follow control");
  btn.click();
  await waitFor(() => mock.db.follows.some((f) => f.follower_id === "u1" && f.followed_id === "u2"), 4000);

  // The same insert-or-delete path every other follow button uses, so the
  // same member_followed analytics row lands - no second write path.
  assert.equal(analytics(mock, "member_followed").length, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(analytics(mock, "member_followed")[0].props)), { user_id: "u2" });
  // Unlike a suggestion card, a classmate is not a recommendation that
  // disappears once acted on: they still trained with you today.
  assert.ok(window.document.querySelector('[data-classmate-user="u2"]'));
});

test("COMM-307: the Follow control is rendered even for a member with allow_follows off - the RPC has no such key to pre-filter on", async () => {
  const profiles = baseProfiles();
  profiles[1].allow_follows = false; // u2
  const mock = seeded({
    profiles,
    attendance_log: [logged("u1", TODAY), logged("u2", TODAY)],
  });
  const window = await bootCommunity(mock);
  await openFeed(window);
  await waitFor(() => !!window.document.querySelector('[data-classmate-user="u2"]'), 4000);

  // attendance_classmates_today returns four keys and allow_follows is not
  // one of them, deliberately: "this is not a follow strip, it is 'who
  // trained today'". So the control is shown and follows_insert_self is what
  // refuses the write, exactly as it would from any other surface.
  assert.ok(window.document.querySelector('[data-classmate-user="u2"] [data-community-action="follow"]'));
  const returned = mock.db.profiles.find((p) => p.id === "u2");
  assert.equal(returned.allow_follows, false, "the fixture really has the toggle off");
});

test("COMM-307: the card carries no Message affordance, per the standing no-messaging resolution", async () => {
  const mock = seeded({ attendance_log: [logged("u1", TODAY), logged("u2", TODAY), logged("u3", TODAY)] });
  const window = await bootCommunity(mock);
  await openFeed(window);
  await waitFor(() => !!card(window), 4000);

  assert.equal(card(window).querySelector('[data-community-action="message"]'), null);
  assert.doesNotMatch(card(window).textContent, /הודעה|צ׳אט|צ'אט/);
  // And not anywhere else on the surface either - the resolution is standing,
  // not card-local.
  assert.equal(window.document.querySelector('[data-community-action="message"]'), null);
});

test("COMM-307: classmates_card_viewed fires once per load with { rows, source } and never again on a re-render", async () => {
  const mock = seeded({
    attendance_log: [logged("u1", TODAY), logged("u2", TODAY), logged("u3", TODAY)],
  });
  const window = await bootCommunity(mock);
  await openFeed(window);
  await waitFor(() => analytics(mock, "classmates_card_viewed").length === 1, 4000);

  const row = analytics(mock, "classmates_card_viewed")[0];
  assert.deepStrictEqual(JSON.parse(JSON.stringify(row.props)), { rows: 2, source: "feed" });
  assert.equal(row.user_id, "u1");
  // No member identity travels with a card whose whole content is other
  // people's identities.
  const serialized = JSON.stringify(row.props);
  for (const leak of ["u2", "u3", "noam", "tal", "נועם", "טל"]) {
    assert.ok(!serialized.includes(leak), `props must not carry ${leak}`);
  }

  // Force several re-renders of the same card - the guard is per load, not
  // per render.
  for (let i = 0; i < 3; i++) {
    window.document.querySelector('[data-community-action="feed-notifications"]').click();
    await new Promise((r) => setTimeout(r, 20));
    const close = window.document.querySelector('[data-community-action="close-notifications"]');
    if (close) close.click();
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(analytics(mock, "classmates_card_viewed").length, 1);
});

test("COMM-307: classmates_card_viewed is not recorded when there is no card, and never counts for WCAM", async () => {
  const mock = seeded({ attendance_log: [logged("u1", TODAY)] });
  const window = await bootCommunity(mock);
  await openFeed(window);
  await settled(mock);

  assert.equal(card(window), null);
  assert.equal(analytics(mock, "classmates_card_viewed").length, 0);

  // The WCAM call, asserted against the shipped set rather than restated:
  // viewing a card is not participation, the same reading leaderboard_viewed
  // already has.
  const A = window.HaimuniaAnalytics;
  assert.equal(A.EVENTS.CLASSMATES_CARD_VIEWED, "classmates_card_viewed");
  assert.equal(A.isActiveMemberEvent("classmates_card_viewed"), false);
  assert.ok(!A.ACTIVE_MEMBER_EVENTS.includes("classmates_card_viewed"));
  assert.deepStrictEqual(Array.from(A.HAND_PROP_KEYS["classmates_card_viewed"]), ["rows", "source"]);
  // The allow-list is what enforces the no-identity rule, not the call site.
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(A.projectHandProps("classmates_card_viewed", { rows: 3, source: "feed", user_id: "u2", handle: "noam" }))),
    { rows: 3, source: "feed" },
  );
});
