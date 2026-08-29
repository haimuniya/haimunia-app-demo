// COMM-160, coach identity across the community, executed for real in jsdom
// against the mock Supabase client (test/helpers/mockSupabase.mjs).
//
// WHAT THIS FILE VERIFIES
// - A coach or head_coach shows the same badge the comments already carry
//   (COMM-124) on: the feed post author, the profile overlay header, the
//   people search results, and the admin member directory rows.
// - The badge text carries the meaning, not colour alone.
// - The role is read from the server role set (invite_redemptions.role, or
//   the role community_profile / admin_search_members return), never guessed
//   from the client.
// - A member author gets no badge, and removing the coach role drops the
//   badge on the next load.
// - The comment path and the feed author read one shared, cached role map:
//   a coach who both posts and comments is badged in both places from a
//   single lookup.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const BASE = Date.parse("2026-08-28T09:00:00.000Z");
const COACH_ID = "22222222-2222-2222-2222-222222222222";
const HEAD_ID = "33333333-3333-3333-3333-333333333333";
const MEMBER_ID = "44444444-4444-4444-4444-444444444444";

function feedRow(extra) {
  return Object.assign({
    id: "p1",
    post_type: "POST_TEXT",
    author_id: MEMBER_ID,
    author: { display_name: "רון", handle: "ron" },
    body: "הפוסט",
    visibility: "club",
    created_at: new Date(BASE).toISOString(),
    published_at: new Date(BASE).toISOString(),
    reaction_count: 0,
    comment_count: 0,
    media: [],
    metadata: {},
  }, extra || {});
}

function seeded(opts) {
  const mock = createMockSupabase(Object.assign({
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    ],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    feed_page_rows: [],
    feed_impressions: [], feed_interactions: [], follows: [], hidden_posts: [], saved_posts: [],
    blocks: [], reactions: [], post_comments: [],
  }, opts || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function openCommunity(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
}
async function openFeed(window, atLeast = 1) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => window.document.querySelectorAll("#communityFeedList .post-card").length >= atLeast, 4000);
}
function feedCard(window, id) {
  return window.document.querySelector(`#communityFeedList [data-post-id="${id}"]`);
}
function openProfile(window, userId) {
  const el = window.document.createElement("button");
  el.dataset.communityAction = "view-profile";
  el.dataset.id = userId;
  window.document.body.appendChild(el);
  el.click();
}

// --- feed post author -------------------------------------------------

test("COMM-160: the feed post author carries the coach badge, a member author does not", async () => {
  const mock = seeded({
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: COACH_ID, invite_id: "inv-2", role: "coach", redeemed_at: VERIFIED },
      { user_id: MEMBER_ID, invite_id: "inv-3", role: "member", redeemed_at: VERIFIED },
    ],
    feed_page_rows: [
      feedRow({ id: "pc", author_id: COACH_ID, author: { display_name: "מור", handle: "mor" } }),
      feedRow({ id: "pm", author_id: MEMBER_ID, author: { display_name: "רון", handle: "ron" } }),
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, 2);

  await waitFor(() => !!feedCard(window, "pc").querySelector(".post-head .coach-badge"), 3000);
  const badge = feedCard(window, "pc").querySelector(".post-head .coach-badge");
  assert.match(badge.textContent, /מאמן/, "the badge carries text, not colour alone");
  assert.equal(feedCard(window, "pm").querySelector(".coach-badge"), null, "a member author gets no badge");
});

test("COMM-160: a head_coach feed author gets the head coach label", async () => {
  const mock = seeded({
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: HEAD_ID, invite_id: "inv-2", role: "head_coach", redeemed_at: VERIFIED },
    ],
    feed_page_rows: [feedRow({ id: "ph", author_id: HEAD_ID, author: { display_name: "יעל", handle: "yael" } })],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, 1);
  await waitFor(() => !!feedCard(window, "ph").querySelector(".coach-badge"), 3000);
  assert.match(feedCard(window, "ph").querySelector(".coach-badge").textContent, /ראשי/);
});

test("COMM-160: removing the coach role drops the badge on the next load", async () => {
  const rows = () => [feedRow({ id: "pc", author_id: COACH_ID, author: { display_name: "מור", handle: "mor" } })];

  const asCoach = seeded({
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: COACH_ID, invite_id: "inv-2", role: "coach", redeemed_at: VERIFIED },
    ],
    feed_page_rows: rows(),
  });
  const w1 = await bootCommunity(asCoach, { syncEnabled: false });
  await openFeed(w1, 1);
  await waitFor(() => !!feedCard(w1, "pc").querySelector(".coach-badge"), 3000);

  const demoted = seeded({
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: COACH_ID, invite_id: "inv-2", role: "member", redeemed_at: VERIFIED },
    ],
    feed_page_rows: rows(),
  });
  const w2 = await bootCommunity(demoted, { syncEnabled: false });
  await openFeed(w2, 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(feedCard(w2, "pc").querySelector(".coach-badge"), null, "no badge once the role is gone");
});

// --- profile overlay header -----------------------------------------

test("COMM-160: the profile overlay header shows the coach badge from the community_profile role", async () => {
  const mock = seeded();
  mock.onRpc("community_profile", () => ({
    data: { display_name: "מור", role: "coach", member_since: "2024-01-01" },
    error: null,
  }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  openProfile(window, "u2");
  await waitFor(() => !!window.document.getElementById("profileViewTitle"), 3000);
  await waitFor(() => !!window.document.getElementById("profileViewTitle").querySelector(".coach-badge"), 3000);
  assert.match(window.document.getElementById("profileViewTitle").querySelector(".coach-badge").textContent, /מאמן/);
});

test("COMM-160: a member profile overlay header shows no coach badge", async () => {
  const mock = seeded();
  mock.onRpc("community_profile", () => ({
    data: { display_name: "רון", role: "member", member_since: "2024-01-01" },
    error: null,
  }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  openProfile(window, "u2");
  await waitFor(() => !!window.document.getElementById("profileViewTitle"), 3000);
  await waitFor(() => !/טוען פרופיל/.test(window.document.getElementById("profileViewTitle").closest(".modal-sheet").textContent), 3000);
  assert.equal(window.document.getElementById("profileViewTitle").querySelector(".coach-badge"), null);
});

// --- people search results -----------------------------------------

test("COMM-160: a coach in the people search results carries the badge", async () => {
  const mock = seeded({
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: COACH_ID, handle: "coach_mor", display_name: "מור המאמנת", visible_to_club: true },
      { id: MEMBER_ID, handle: "mor_ron", display_name: "מור רון", visible_to_club: true },
    ],
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: COACH_ID, invite_id: "inv-2", role: "coach", redeemed_at: VERIFIED },
      { user_id: MEMBER_ID, invite_id: "inv-3", role: "member", redeemed_at: VERIFIED },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => !!window.document.getElementById("communityPeopleSearch"), 3000);
  const input = window.document.getElementById("communityPeopleSearch");
  input.value = "מור";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));

  await waitFor(() => !!window.document.querySelector(`[data-community-action="view-profile"][data-id="${COACH_ID}"]`), 3000);
  await waitFor(() => {
    const rows = [...window.document.querySelectorAll("#communityPeopleSearch")].length
      ? [...window.document.querySelectorAll(".ach-section .log-row")] : [];
    return rows.some((r) => r.querySelector(".coach-badge"));
  }, 3000);
  const coachRow = window.document.querySelector(`[data-community-action="view-profile"][data-id="${COACH_ID}"]`).closest(".log-row");
  const memberRow = window.document.querySelector(`[data-community-action="view-profile"][data-id="${MEMBER_ID}"]`).closest(".log-row");
  assert.match(coachRow.querySelector(".coach-badge").textContent, /מאמן/);
  assert.equal(memberRow.querySelector(".coach-badge"), null);
});

// --- admin member directory rows ----------------------------------

test("COMM-160: the admin member directory row shows the coach badge for a coach", async () => {
  const mock = seeded({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: true, recovery_verified_at: VERIFIED, visible_to_club: true }],
  });
  mock.onRpc("admin_search_members", () => ({
    data: [
      { id: COACH_ID, handle: "coach_mor", display_name: "מור", role: "coach", is_admin: false, redeemed_at: VERIFIED, last_activity_on: null },
      { id: MEMBER_ID, handle: "ron", display_name: "רון", role: "member", is_admin: false, redeemed_at: VERIFIED, last_activity_on: null },
    ],
    error: null,
  }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => !!window.document.getElementById("adminMemberSearch"), 3000);
  const search = window.document.getElementById("adminMemberSearch");
  search.value = "mor";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));

  await waitFor(() => !!window.document.querySelector(`[data-community-action="admin-revoke-coach"][data-id="${COACH_ID}"]`), 3000);
  const coachRow = window.document.querySelector(`[data-community-action="admin-revoke-coach"][data-id="${COACH_ID}"]`).closest(".log-row");
  const memberRow = window.document.querySelector(`[data-community-action="admin-grant-coach"][data-id="${MEMBER_ID}"]`).closest(".log-row");
  assert.match(coachRow.querySelector(".coach-badge").textContent, /מאמן/);
  assert.equal(memberRow.querySelector(".coach-badge"), null);
});

// --- shared role map ---------------------------------------------

test("COMM-160: one cached role map feeds both the post author badge and the comment badge", async () => {
  const mock = seeded({
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: COACH_ID, invite_id: "inv-2", role: "coach", redeemed_at: VERIFIED },
    ],
    feed_page_rows: [feedRow({ id: "p1", author_id: COACH_ID, author: { display_name: "מור", handle: "mor" } })],
    post_comments: [
      { id: "c1", post_id: "p1", author_id: COACH_ID, body: "כל הכבוד", parent_comment_id: null, created_at: new Date(BASE + 1000).toISOString(), status: "active", profiles: { handle: "mor", display_name: "מור" } },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window, 1);
  await waitFor(() => !!feedCard(window, "p1").querySelector(".post-head .coach-badge"), 3000);

  feedCard(window, "p1").querySelector('[data-community-action="toggle-comments"]').click();
  await waitFor(() => !!feedCard(window, "p1").querySelector(".comment-coach .coach-badge"), 3000);

  assert.ok(feedCard(window, "p1").querySelector(".post-head .coach-badge"), "author badge present");
  assert.ok(feedCard(window, "p1").querySelector(".comment-coach .coach-badge"), "comment badge present from the same map");
});
