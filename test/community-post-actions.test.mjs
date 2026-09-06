// COMM-108. The per-post action menu. Own post: edit caption, change
// visibility, delete. Other member's post: save, hide, report, block. Save
// and hide are direct own-row RLS writes; caption, visibility and delete go
// through post_edit_caption / post_set_visibility / post_delete.
//
// Launch-readiness audit, finding 8: until 202609060007 neither
// post_edit_caption nor post_set_visibility EXISTED. Everything below passed
// the whole time, because mock.onRpc() answers any name it is given - which
// is exactly how two dead buttons stayed green in CI while answering PGRST202
// in production. The two assertions at the bottom of this file are what
// closes that: they read the shipped SQL and check that the function really
// exists with the argument NAMES these tests send, since PostgREST resolves
// an RPC by argument name and a right function with wrong parameter names is
// still unreachable.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
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
  // COMM-331: feed data now loads lazily behind ensureCommunityDataLoaded(),
  // so a plain ".post-card" count briefly matches the loading skeleton
  // (also .post-card, no data-post-id) before the real posts replace it -
  // wait for real, identified post cards instead.
  await waitFor(() => window.document.querySelectorAll(".post-card[data-post-id]").length >= 2, 3000);
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

// The two functions the six tests above mock actually exist, with the
// argument names those tests send. Behaviour is asserted in pgTAP
// (supabase/tests/0073_post_edit_rpcs_test.sql); this is the existence check
// a mock can never make, and the one that was missing for as long as the
// buttons were dead.
test("the three menu RPCs exist in the migrations with the argument names cloud.js sends", () => {
  const edits = fs.readFileSync(new URL("../supabase/migrations/202609060007_post_edit_rpcs.sql", import.meta.url), "utf8");
  assert.match(edits, /create or replace function public\.post_edit_caption\(post_id uuid, body text\) returns void/);
  assert.match(edits, /create or replace function public\.post_set_visibility\(post_id uuid, visibility public\.post_visibility\) returns void/);
  assert.match(edits, /revoke all on function public\.post_edit_caption\(uuid, text\) from public, anon;/);
  assert.match(edits, /grant execute on function public\.post_edit_caption\(uuid, text\) to authenticated;/);
  assert.match(edits, /revoke all on function public\.post_set_visibility\(uuid, public\.post_visibility\) from public, anon;/);
  assert.match(edits, /grant execute on function public\.post_set_visibility\(uuid, public\.post_visibility\) to authenticated;/);

  const mod = fs.readFileSync(new URL("../supabase/migrations/202608280025_moderation_reshape.sql", import.meta.url), "utf8");
  assert.match(mod, /create or replace function public\.post_delete\(post_id uuid\) returns void/);
});

test("both new RPCs gate on the author and neither carries a moderator branch", () => {
  const edits = fs.readFileSync(new URL("../supabase/migrations/202609060007_post_edit_rpcs.sql", import.meta.url), "utf8");
  const caption = edits.slice(edits.indexOf("function public.post_edit_caption"), edits.indexOf("revoke all on function public.post_edit_caption"));
  assert.match(caption, /v_row\.author_id is distinct from v_uid then raise exception 'not authorized'/);
  assert.ok(!/has_perm|is_admin/.test(caption), "author only - a moderator removes a post, they do not rewrite it");
  assert.match(caption, /is_community_member\(\)/, "an edit is a community write and carries the recovery gate");
  assert.match(caption, /is_posting_restricted\(v_uid\)/, "and the COMM-153 restriction, so an old post cannot be rewritten into new content");

  const vis = edits.slice(edits.indexOf("function public.post_set_visibility"), edits.indexOf("revoke all on function public.post_set_visibility"));
  assert.match(vis, /v_row\.author_id is distinct from v_uid then raise exception 'not authorized'/);
  assert.ok(!/has_perm|is_admin/.test(vis), "author only here too");
  assert.match(vis, /v_new_rank > v_old_rank and public\.is_posting_restricted/, "the restriction applies to a WIDENING only - narrowing your own post must always work");
});
