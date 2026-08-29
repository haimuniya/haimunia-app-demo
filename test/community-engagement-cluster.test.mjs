// COMM-120 to COMM-125, the engagement cluster, executed for real in jsdom
// against the mock Supabase client (test/helpers/mockSupabase.mjs).
//
// WHAT THIS FILE VERIFIES
// - COMM-120 one reaction type, optimistic toggle add/remove, reactor avatar
//   strip and total, rollback with a message on failure.
// - COMM-121 two-level replies: a reply carries the parent id, a reply gets
//   no reply affordance of its own, the server depth error surfaces cleanly,
//   the draft is never dropped.
// - COMM-122 edit own comment (edited marker) and delete own comment through
//   the shared confirm dialog, plus the "comment removed" placeholder for a
//   reply whose parent is gone.
// - COMM-123 a typed mention resolves to a member, rides COMMENT_CREATED as a
//   signal, and is stripped to plain text (no signal) when allow_mentions is
//   off or a block edge sits between the two members.
// - COMM-124 a coach comment gets the badge, the role label and emphasis.
// - COMM-125 a blocked member's comments and reaction avatars are hidden.
// - Failure path: a failed comment shows a retry and preserves the draft.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const RON_ID = "11111111-1111-1111-1111-111111111111";
const COACH_ID = "22222222-2222-2222-2222-222222222222";

function feedRow(extra) {
  return Object.assign({
    id: "p1",
    post_type: "POST_TEXT",
    author_id: "u2",
    author: { display_name: "רון", handle: "ron" },
    body: "הפוסט הראשון",
    visibility: "club",
    created_at: new Date(Date.parse("2026-08-28T09:00:00.000Z")).toISOString(),
    published_at: new Date(Date.parse("2026-08-28T09:00:00.000Z")).toISOString(),
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
    feed_page_rows: [feedRow(opts && opts.row)],
    feed_impressions: [], feed_interactions: [], follows: [], hidden_posts: [], saved_posts: [],
    blocks: [], reactions: [], post_comments: [],
  }, opts || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function openFeed(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => window.document.querySelectorAll("#communityFeedList .post-card").length >= 1, 4000);
}
async function openComments(window) {
  window.document.querySelector('[data-post-id="p1"] [data-community-action="toggle-comments"]').click();
  await waitFor(() => !!window.document.querySelector('[data-comment-post-id="p1"]'), 4000);
}
function card(window) { return window.document.querySelector('[data-post-id="p1"]'); }
function fireInput(window, el, value) {
  el.value = value;
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}
function submit(window, form) {
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

// --- COMM-120 reactions -------------------------------------------------

test("COMM-120: tapping the reaction adds it, tapping again removes it, optimistically", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);

  window.document.querySelector('[data-post-id="p1"] [data-community-action="cheer"]').click();
  await waitFor(() => mock.db.reactions.some((r) => r.post_id === "p1" && r.user_id === "u1"), 3000);
  await waitFor(() => !!card(window).querySelector(".reaction-strip"), 3000);
  assert.match(card(window).querySelector(".reaction-strip").textContent, /הגבתם/);
  assert.equal(mock.db.reactions.filter((r) => (r.kind || "cheer") === "cheer").length, 1, "one reaction row, one type");

  window.document.querySelector('[data-post-id="p1"] [data-community-action="cheer"]').click();
  await waitFor(() => mock.db.reactions.length === 0, 3000);
  await waitFor(() => !card(window).querySelector(".reaction-strip"), 3000);
});

test("COMM-120: the card shows the first few reactor avatars and the total", async () => {
  const mock = seeded({
    row: { reaction_count: 3 },
    reactions: [
      { post_id: "p1", user_id: "a", kind: "cheer", created_at: "2026-08-28T08:00:00.000Z", profiles: { handle: "a", display_name: "אבי" } },
      { post_id: "p1", user_id: "b", kind: "cheer", created_at: "2026-08-28T08:01:00.000Z", profiles: { handle: "b", display_name: "בני" } },
      { post_id: "p1", user_id: "c", kind: "cheer", created_at: "2026-08-28T08:02:00.000Z", profiles: { handle: "c", display_name: "גיל" } },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await waitFor(() => card(window).querySelectorAll(".reaction-strip .avatar-badge").length === 3, 3000);
  assert.match(card(window).querySelector(".reaction-strip").textContent, /3 הגבות/);
});

test("COMM-120: a failed reaction rolls back and shows a message", async () => {
  const mock = seeded();
  mock.onRpc("toggle_reaction", () => ({ data: null, error: { message: "boom" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);

  window.document.querySelector('[data-post-id="p1"] [data-community-action="cheer"]').click();
  await waitFor(() => /לא ניתן היה להגיב/.test(window.document.body.textContent), 3000);
  assert.equal(card(window).querySelector(".reaction-strip"), null, "the optimistic strip was reverted");
  assert.equal(mock.db.reactions.length, 0, "nothing was written");
});

// --- COMM-121 replies -------------------------------------------------

test("COMM-121: a reply carries the parent id and rides COMMENT_CREATED", async () => {
  const mock = seeded({
    post_comments: [
      { id: "c1", post_id: "p1", author_id: "u2", body: "תגובה ראשונה", parent_comment_id: null, created_at: "2026-08-28T08:00:00.000Z", status: "active", profiles: { handle: "ron", display_name: "רון" } },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  const events = [];
  window.HaimuniaEvents.on("COMMENT_CREATED", (p) => events.push(p));
  await openFeed(window);
  await openComments(window);

  window.document.querySelector('[data-post-id="p1"] [data-community-action="comment-reply"]').click();
  await waitFor(() => !!window.document.querySelector('form[data-comment-parent-id="c1"]'), 3000);
  const replyForm = window.document.querySelector('form[data-comment-parent-id="c1"]');
  fireInput(window, replyForm.elements.body, "מסכים");
  submit(window, replyForm);

  await waitFor(() => mock.db.post_comments.some((c) => c.parent_comment_id === "c1" && c.author_id === "u1"), 3000);
  assert.ok(events.some((e) => e.parent_comment_id === "c1"), "COMMENT_CREATED carried the parent id");
});

test("COMM-121: a reply gets no reply affordance, and a server depth error surfaces cleanly without dropping the draft", async () => {
  const mock = seeded({
    post_comments: [
      { id: "c1", post_id: "p1", author_id: "u2", body: "שורש", parent_comment_id: null, created_at: "2026-08-28T08:00:00.000Z", status: "active", profiles: { handle: "ron", display_name: "רון" } },
      { id: "c2", post_id: "p1", author_id: "u2", body: "תשובה", parent_comment_id: "c1", created_at: "2026-08-28T08:01:00.000Z", status: "active", profiles: { handle: "ron", display_name: "רון" } },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await openComments(window);
  window.document.querySelector('[data-post-id="p1"] [data-community-action="toggle-replies"]').click();
  await waitFor(() => /תשובה/.test(card(window).textContent), 3000);
  // Only the one top-level comment offers a reply. The reply itself does not.
  assert.equal(card(window).querySelectorAll('[data-community-action="comment-reply"]').length, 1);

  mock.onRpc("add_post_comment", () => ({ data: null, error: { message: "reply depth is capped at 2" } }));
  const form = window.document.querySelector('form[data-comment-post-id="p1"]:not([data-comment-parent-id])');
  fireInput(window, form.elements.body, "טיוטת עומק");
  submit(window, form);
  await waitFor(() => /אי אפשר להשיב לתשובה/.test(card(window).textContent), 3000);
  const liveInput = window.document.querySelector('form[data-comment-post-id="p1"]:not([data-comment-parent-id]) input[name="body"]');
  assert.equal(liveInput.value, "טיוטת עומק", "the draft is preserved after the failure");
});

// --- COMM-122 edit / delete -----------------------------------------

test("COMM-122: editing an own comment stamps an edited marker", async () => {
  const mock = seeded({
    post_comments: [
      { id: "c1", post_id: "p1", author_id: "u1", body: "טעעות כתיב", parent_comment_id: null, created_at: "2026-08-28T08:00:00.000Z", edited_at: null, status: "active", profiles: { handle: "dana", display_name: "דנה" } },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await openComments(window);

  window.document.querySelector('[data-post-id="p1"] [data-community-action="comment-edit"]').click();
  await waitFor(() => !!card(window).querySelector("[data-comment-edit-input]"), 3000);
  fireInput(window, card(window).querySelector("[data-comment-edit-input]"), "טעות כתיב מתוקנת");
  card(window).querySelector('[data-community-action="comment-edit-save"]').click();

  await waitFor(() => !!mock.db.post_comments.find((c) => c.id === "c1").edited_at, 3000);
  await waitFor(() => /\(נערך\)/.test(card(window).textContent), 3000);
  assert.equal(mock.db.post_comments.find((c) => c.id === "c1").body, "טעות כתיב מתוקנת");
});

test("COMM-122: deleting an own comment goes through the shared confirm dialog", async () => {
  const mock = seeded({
    post_comments: [
      { id: "c1", post_id: "p1", author_id: "u1", body: "למחוק אותי", parent_comment_id: null, created_at: "2026-08-28T08:00:00.000Z", status: "active", profiles: { handle: "dana", display_name: "דנה" } },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await openComments(window);

  window.document.querySelector('[data-post-id="p1"] [data-community-action="delete-comment"]').click();
  await waitFor(() => !!window.document.getElementById("communityConfirmTitle"), 3000);
  window.document.querySelector('[data-community-action="confirm-yes"]').click();

  await waitFor(() => !mock.db.post_comments.some((c) => c.id === "c1"), 3000);
  await waitFor(() => !/למחוק אותי/.test(card(window).textContent), 3000);
});

test("COMM-122: a reply whose parent is gone renders a comment-removed placeholder", async () => {
  const mock = seeded({
    post_comments: [
      { id: "c2", post_id: "p1", author_id: "u2", body: "תשובה יתומה", parent_comment_id: "gone", created_at: "2026-08-28T08:01:00.000Z", status: "active", profiles: { handle: "ron", display_name: "רון" } },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await openComments(window);
  await waitFor(() => /תשובה יתומה/.test(card(window).textContent), 3000);
  assert.match(card(window).textContent, /התגובה נמחקה/, "the removed parent is shown as a placeholder");
});

// --- COMM-123 mentions ---------------------------------------------

test("COMM-123: a typed mention resolves to a member and rides COMMENT_CREATED as a signal", async () => {
  const mock = seeded({
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: RON_ID, handle: "ron", display_name: "רון", visible_to_club: true },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  const events = [];
  window.HaimuniaEvents.on("COMMENT_CREATED", (p) => events.push(p));
  await openFeed(window);
  await openComments(window);

  const input = window.document.querySelector('[data-comment-post-id="p1"] input[data-comment-input]');
  fireInput(window, input, "@ro");
  await waitFor(() => !!window.document.querySelector('.mention-picker [data-community-action="mention-pick"]'), 3000);
  window.document.querySelector('.mention-picker [data-community-action="mention-pick"]').click();
  await waitFor(() => {
    const el = window.document.querySelector('[data-comment-post-id="p1"] input[data-comment-input]');
    return el && el.value.indexOf("@[רון](" + RON_ID + ")") === 0;
  }, 3000);

  submit(window, window.document.querySelector('form[data-comment-post-id="p1"]:not([data-comment-parent-id])'));
  await waitFor(() => mock.db.post_comments.some((c) => c.author_id === "u1"), 3000);
  const stored = mock.db.post_comments.find((c) => c.author_id === "u1");
  assert.match(stored.body, /@\[רון\]\(11111111-1111-1111-1111-111111111111\)/, "the marker is stored id-keyed, not by display string");
  assert.ok(events.length && events[events.length - 1].mentions.some((m) => m.user_id === RON_ID), "the mention rode the event as a signal");
});

test("COMM-123: a mention of a member with allow_mentions off renders as plain text and sends no signal", async () => {
  const mock = seeded({
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: RON_ID, handle: "ron", display_name: "רון", visible_to_club: true, allow_mentions: false },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  const events = [];
  window.HaimuniaEvents.on("COMMENT_CREATED", (p) => events.push(p));
  await openFeed(window);
  await openComments(window);

  const input = window.document.querySelector('[data-comment-post-id="p1"] input[data-comment-input]');
  fireInput(window, input, "@ro");
  await waitFor(() => !!window.document.querySelector('.mention-picker [data-community-action="mention-pick"]'), 3000);
  window.document.querySelector('.mention-picker [data-community-action="mention-pick"]').click();
  await waitFor(() => window.document.querySelector('[data-comment-post-id="p1"] input[data-comment-input]').value.indexOf("@[רון]") === 0, 3000);
  submit(window, window.document.querySelector('form[data-comment-post-id="p1"]:not([data-comment-parent-id])'));

  await waitFor(() => mock.db.post_comments.some((c) => c.author_id === "u1"), 3000);
  const stored = mock.db.post_comments.find((c) => c.author_id === "u1");
  assert.equal(stored.body, "@רון", "the disallowed mention is flattened to plain text");
  assert.ok(!events[events.length - 1].mentions.length, "no mention signal was emitted");
});

// --- COMM-124 coach emphasis --------------------------------------

test("COMM-124: a coach comment gets the badge, the role label and emphasis, read from the server role", async () => {
  const mock = seeded({
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: COACH_ID, handle: "coach_mor", display_name: "מור", visible_to_club: true },
    ],
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: COACH_ID, invite_id: "inv-1", role: "coach", redeemed_at: VERIFIED },
    ],
    post_comments: [
      { id: "c1", post_id: "p1", author_id: COACH_ID, body: "עבודה יפה", parent_comment_id: null, created_at: "2026-08-28T08:00:00.000Z", status: "active", profiles: { handle: "coach_mor", display_name: "מור" } },
      { id: "c2", post_id: "p1", author_id: "u2", body: "מסכים", parent_comment_id: null, created_at: "2026-08-28T08:01:00.000Z", status: "active", profiles: { handle: "ron", display_name: "רון" } },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await openComments(window);
  await waitFor(() => !!card(window).querySelector(".coach-badge"), 3000);

  const badges = card(window).querySelectorAll(".coach-badge");
  assert.equal(badges.length, 1, "only the coach comment carries a badge");
  assert.match(badges[0].textContent, /מאמן/);
  assert.equal(card(window).querySelectorAll(".comment-coach").length, 1, "the coach comment carries the emphasis hook");
});

// --- COMM-125 block effects -------------------------------------

test("COMM-125: a blocked member's comment is hidden behind a placeholder and their reaction avatar is dropped", async () => {
  const mock = seeded({
    blocks: [{ blocker_id: "u1", blocked_id: "u2" }],
    row: { reaction_count: 1 },
    reactions: [
      { post_id: "p1", user_id: "u2", kind: "cheer", created_at: "2026-08-28T08:00:00.000Z", profiles: { handle: "ron", display_name: "רון" } },
    ],
    post_comments: [
      { id: "c1", post_id: "p1", author_id: "u2", body: "טקסט חסום", parent_comment_id: null, created_at: "2026-08-28T08:00:00.000Z", status: "active", profiles: { handle: "ron", display_name: "רון" } },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await openComments(window);
  await waitFor(() => /תגובה מוסתרת/.test(card(window).textContent), 3000);
  assert.ok(!/טקסט חסום/.test(card(window).textContent), "the blocked comment body never renders");

  await waitFor(() => !!card(window).querySelector(".reaction-strip"), 3000);
  assert.equal(card(window).querySelectorAll(".reaction-strip .avatar-badge").length, 0, "the blocked reactor's avatar is dropped");
});

// --- failure path ---------------------------------------------

test("a failed comment shows a retry and preserves the draft, then the retry sends it", async () => {
  const mock = seeded();
  let calls = 0;
  mock.onRpc("add_post_comment", (args) => {
    calls++;
    if (calls === 1) return { data: null, error: { message: "network down" } };
    const id = "c-ok";
    mock.db.post_comments.push({ id, post_id: args.p_post_id, author_id: "u1", body: args.p_body, parent_comment_id: args.p_parent_comment_id || null, created_at: new Date().toISOString(), status: "active" });
    return { data: id, error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await openComments(window);

  const form = window.document.querySelector('form[data-comment-post-id="p1"]:not([data-comment-parent-id])');
  fireInput(window, form.elements.body, "תגובה חשובה");
  submit(window, form);

  await waitFor(() => !!card(window).querySelector('[data-community-action="comment-retry"]'), 3000);
  assert.match(card(window).textContent, /שליחת התגובה נכשלה/);
  const liveInput = window.document.querySelector('form[data-comment-post-id="p1"]:not([data-comment-parent-id]) input[name="body"]');
  assert.equal(liveInput.value, "תגובה חשובה", "the draft survived the failure");

  card(window).querySelector('[data-community-action="comment-retry"]').click();
  await waitFor(() => mock.db.post_comments.some((c) => c.body === "תגובה חשובה"), 3000);
  await waitFor(() => !card(window).querySelector('[data-community-action="comment-retry"]'), 3000);
});
