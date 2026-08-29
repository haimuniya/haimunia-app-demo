// COMM-101 / COMM-104..107. Per-type post card render dispatch.
//
// renderPostCard(post) switches on post.post_type and renders a card shaped
// for that kind. These tests drive the real dispatch, both directly and
// through the live feed render, and lock in: every Phase 1 type has a card,
// user text is escaped, an unknown type degrades to a safe text card without
// throwing, and a renderer that throws produces an error card.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const NOW = Date.now();
const ago = (min) => new Date(NOW - min * 60000).toISOString();

const FEED_ROWS = [
  { id: "t1", post_type: "POST_TEXT", author_id: "u2", display_name: "רון", body: "בוקר טוב לכולם", published_at: ago(1) },
  { id: "ph1", post_type: "POST_PHOTO", author_id: "u2", display_name: "רון", body: "מהאימון", media: [{ url: "https://mock/x.webp", alt_text: "מרים מעל הראש", position: 0 }], published_at: ago(2) },
  { id: "w1", post_type: "POST_WORKOUT", author_id: "u2", display_name: "רון", published_at: ago(3), metadata: { workout_name: "Fran", workout_date: "2026-08-20", result_text: "3:21", score_type: "זמן", effort: "rx", is_pr: true, source_type: "wod_entry", source_id: "wp1" } },
  { id: "pr1", post_type: "POST_PR", author_id: "u2", display_name: "רון", published_at: ago(4), metadata: { movement: "Back Squat", new_result: '140 ק"ג', previous_result: '132 ק"ג', improvement: '+8 ק"ג', achieved_on: "2026-08-27" } },
  { id: "a1", post_type: "POST_ACHIEVEMENT", author_id: "u2", display_name: "רון", published_at: ago(5), metadata: { title: "100 אימונים", badge_icon: "🏅", earned_on: "2026-08-25", explanation: "השלמת 100 אימונים" } },
  { id: "mi1", post_type: "POST_ATTENDANCE_MILESTONE", author_id: "u2", published_at: ago(6), metadata: { milestone_label: "שנה במועדון", count: 1 } },
  { id: "c1", post_type: "POST_CHALLENGE", published_at: ago(7), metadata: { challenge_title: "אתגר אוגוסט", challenge_id: "ch1" } },
  { id: "e1", post_type: "POST_EVENT", published_at: ago(8), metadata: { event_title: "תחרות פנימית", event_id: "ev1", starts_at: "2026-09-01T18:00" } },
  { id: "an1", post_type: "POST_ANNOUNCEMENT", published_at: ago(9), body: "המועדון סגור בשבת", metadata: { title: "עדכון שעות" } },
  { id: "co1", post_type: "POST_COACH", author_id: "coach1", display_name: "יעל המאמנת", body: "כל הכבוד על השבוע", published_at: ago(10) },
  { id: "nm1", post_type: "POST_NEW_MEMBER", published_at: ago(11), metadata: { member_id: "u9", member_name: "נועה", joined_on: "2026-08-28" } },
  { id: "sy1", post_type: "POST_SYSTEM", published_at: ago(12), body: "עדכון מערכת מתוזמן" },
  { id: "mystery1", post_type: "POST_MImportSomethingElse", author_id: "u2", body: "טקסט לא מזוהה", published_at: ago(13) },
];

function seeded() {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    community_feed: FEED_ROWS.map((r) => ({ ...r })),
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function openFeed(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  await waitFor(() => window.document.querySelectorAll(".post-card").length >= FEED_ROWS.length, 3000);
}

test("the live feed renders one card per row, each tagged with its post_type", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  await openFeed(window);
  const types = [...window.document.querySelectorAll(".post-card")].map((el) => el.dataset.postType);
  for (const t of ["POST_TEXT", "POST_PHOTO", "POST_WORKOUT", "POST_PR", "POST_ACHIEVEMENT", "POST_ATTENDANCE_MILESTONE", "POST_CHALLENGE", "POST_EVENT", "POST_ANNOUNCEMENT", "POST_COACH", "POST_NEW_MEMBER", "POST_SYSTEM"]) {
    assert.ok(types.includes(t), `a ${t} card is rendered`);
  }
});

test("the workout card shows the training detail from the linked record, with a PR badge", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  await openFeed(window);
  const card = window.document.querySelector('[data-post-id="w1"]');
  assert.match(card.textContent, /Fran/);
  assert.match(card.textContent, /3:21/);
  assert.match(card.textContent, /Rx/);
  assert.ok(card.querySelector(".pr-badge"), "a PR badge is shown when the result is a record");
  assert.ok(card.querySelector('[data-community-action="open-source"]'), "an Open workout action links to source_type/source_id");
});

test("the PR card shows movement, new and previous result and improvement", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  await openFeed(window);
  const card = window.document.querySelector('[data-post-id="pr1"]');
  assert.match(card.textContent, /Back Squat/);
  assert.match(card.textContent, /140/);
  assert.match(card.textContent, /132/);
  assert.match(card.textContent, /\+8/);
});

test("the achievement card shows the badge, title and explanation", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  await openFeed(window);
  const card = window.document.querySelector('[data-post-id="a1"]');
  assert.match(card.textContent, /100 אימונים/);
  assert.match(card.textContent, /🏅/);
  assert.match(card.textContent, /השלמת 100 אימונים/);
});

test("new member card is authorless with Follow and Welcome, system card is muted with no menu and engagement disabled", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  await openFeed(window);
  const nm = window.document.querySelector('[data-post-id="nm1"]');
  assert.ok(nm.querySelector('[data-community-action="follow"][data-id="u9"]'), "Follow action for the new member");
  assert.ok(nm.querySelector('[data-community-action="welcome-member"]'), "Welcome action");
  const sys = window.document.querySelector('[data-post-id="sy1"]');
  assert.equal(sys.querySelector('[data-community-action="toggle-post-menu"]'), null, "system post has no More menu");
  assert.equal(sys.querySelector(".post-actions"), null, "system post has reactions and comments disabled");
  assert.equal(sys.querySelector('[data-community-action="view-profile"]'), null, "system post has no profile link");
});

test("POST_CHALLENGE and POST_EVENT render as a compact link card", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  await openFeed(window);
  assert.ok(window.document.querySelector('[data-post-id="c1"] [data-community-action="open-challenge"]'));
  assert.ok(window.document.querySelector('[data-post-id="e1"] [data-community-action="open-event"]'));
});

test("an unknown post_type degrades to a safe text card and never throws", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  await openFeed(window);
  const unknown = window.document.querySelector('.post-card[data-post-unknown="1"]');
  assert.ok(unknown, "unknown type still produced a card");
  assert.match(unknown.textContent, /טקסט לא מזוהה/, "the body still renders on the fallback card");
});

test("renderPostCard escapes user text and tolerates a null or throwing input", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  await openFeed(window);
  const html = window.renderPostCard({ id: "x1", post_type: "POST_TEXT", body: "<script>alert(1)</script>" });
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);

  assert.doesNotThrow(() => window.renderPostCard(null));
  assert.match(window.renderPostCard(null), /לא ניתן להציג את הפוסט/);

  const evil = { id: "boom", post_type: "POST_TEXT" };
  Object.defineProperty(evil, "body", { get() { throw new Error("kaboom"); } });
  let out;
  assert.doesNotThrow(() => { out = window.renderPostCard(evil); });
  assert.match(out, /לא ניתן להציג את הפוסט/);
});
