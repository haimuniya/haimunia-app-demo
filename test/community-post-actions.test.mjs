// COMM-108. The per-post action menu. Own post: edit caption, change
// visibility, delete. Other member's post: save, hide, report, block. Save
// and hide are direct own-row RLS writes; caption, visibility and delete go
// through post_edit_caption / post_set_visibility / post_delete.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

function seeded() {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    community_feed: [
      { id: "own1", post_type: "POST_TEXT", author_id: "u1", display_name: "דנה", body: "פוסט שלי", visibility: "club", published_at: new Date(Date.now() - 60000).toISOString() },
      { id: "other1", post_type: "POST_TEXT", author_id: "u2", display_name: "רון", body: "פוסט של רון", published_at: new Date(Date.now() - 120000).toISOString() },
    ],
    saved_posts: [],
    hidden_posts: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  mock.onRpc("post_edit_caption", (args, ctx) => { ctx.db.__editCaption = args; return { data: null, error: null }; });
  mock.onRpc("post_set_visibility", (args, ctx) => { ctx.db.__setVis = args; return { data: null, error: null }; });
  mock.onRpc("post_delete", (args, ctx) => { ctx.db.__deleted = args; return { data: null, error: null }; });
  return mock;
}

async function openFeed(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => window.document.querySelectorAll(".post-card").length >= 2, 3000);
}

function openMenu(window, postId) {
  window.document.querySelector(`[data-post-id="${postId}"] [data-community-action="toggle-post-menu"]`).click();
}

test("own post menu offers edit caption, change visibility and delete; others' does not", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  await openFeed(window);
  openMenu(window, "own1");
  await waitFor(() => !!window.document.querySelector('[data-post-id="own1"] .post-menu'), 3000);
  const own = window.document.querySelector('[data-post-id="own1"] .post-menu');
  assert.ok(own.querySelector('[data-community-action="post-edit-caption"]'));
  assert.ok(own.querySelector('[data-community-action="post-change-visibility"]'));
  assert.ok(own.querySelector('[data-community-action="post-delete"]'));
  assert.equal(own.querySelector('[data-community-action="post-save"]'), null);
});

test("other member's post menu offers save, hide, report and block", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  await openFeed(window);
  openMenu(window, "other1");
  await waitFor(() => !!window.document.querySelector('[data-post-id="other1"] .post-menu'), 3000);
  const menu = window.document.querySelector('[data-post-id="other1"] .post-menu');
  assert.ok(menu.querySelector('[data-community-action="post-save"]'));
  assert.ok(menu.querySelector('[data-community-action="post-hide"]'));
  assert.ok(menu.querySelector('[data-community-action="report"]'));
  assert.ok(menu.querySelector('[data-community-action="block"][data-id="u2"]'), "block targets the author, not the post");
});

test("save toggles a saved_posts row on then off", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  openMenu(window, "other1");
  await waitFor(() => !!window.document.querySelector('[data-post-id="other1"] .post-menu'), 3000);
  window.document.querySelector('[data-community-action="post-save"]').click();
  await waitFor(() => mock.db.saved_posts.length === 1, 3000);
  assert.deepEqual(mock.db.saved_posts[0], { user_id: "u1", post_id: "other1" });

  openMenu(window, "other1");
  await waitFor(() => !!window.document.querySelector('[data-post-id="other1"] .post-menu'), 3000);
  window.document.querySelector('[data-community-action="post-save"]').click();
  await waitFor(() => mock.db.saved_posts.length === 0, 3000);
});

test("hide writes a hidden_posts row and removes the card immediately", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  openMenu(window, "other1");
  await waitFor(() => !!window.document.querySelector('[data-post-id="other1"] .post-menu'), 3000);
  window.document.querySelector('[data-community-action="post-hide"]').click();
  await waitFor(() => window.document.querySelector('[data-post-id="other1"]') === null, 3000);
  assert.deepEqual(mock.db.hidden_posts[0], { user_id: "u1", post_id: "other1" });
});

test("edit caption updates only the body through post_edit_caption", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  openMenu(window, "own1");
  await waitFor(() => !!window.document.querySelector('[data-post-id="own1"] .post-menu'), 3000);
  window.document.querySelector('[data-community-action="post-edit-caption"]').click();
  await waitFor(() => !!window.document.querySelector("[data-caption-edit]"), 3000);
  const ta = window.document.querySelector("[data-caption-edit]");
  ta.value = "כיתוב מעודכן";
  ta.dispatchEvent(new window.Event("input", { bubbles: true }));
  window.document.querySelector('[data-community-action="caption-save"]').click();
  await waitFor(() => !!mock.db.__editCaption, 3000);
  assert.deepEqual(mock.db.__editCaption, { post_id: "own1", body: "כיתוב מעודכן" });
  await waitFor(() => /כיתוב מעודכן/.test(window.document.querySelector('[data-post-id="own1"]').textContent), 3000);
});

test("change visibility calls post_set_visibility with the picked label", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  openMenu(window, "own1");
  await waitFor(() => !!window.document.querySelector('[data-post-id="own1"] .post-menu'), 3000);
  window.document.querySelector('[data-community-action="post-change-visibility"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="visibility-pick"][data-value="friends"]'), 3000);
  window.document.querySelector('[data-community-action="visibility-pick"][data-value="friends"]').click();
  await waitFor(() => !!mock.db.__setVis, 3000);
  assert.deepEqual(mock.db.__setVis, { post_id: "own1", visibility: "friends" });
});

test("delete goes through the single confirm dialog then post_delete, and removes the card", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  openMenu(window, "own1");
  await waitFor(() => !!window.document.querySelector('[data-post-id="own1"] .post-menu'), 3000);
  window.document.querySelector('[data-community-action="post-delete"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="confirm-yes"]'), 3000);
  window.document.querySelector('[data-community-action="confirm-yes"]').click();
  await waitFor(() => !!mock.db.__deleted, 3000);
  assert.deepEqual(mock.db.__deleted, { post_id: "own1" });
  await waitFor(() => window.document.querySelector('[data-post-id="own1"]') === null, 3000);
});
