// Live bug hunt (2026-09-11): every "מעקב" button in the app (directory,
// welcome post, classmates card, member row, profile dialog) rendered
// unconditionally as "מעקב" regardless of whether the viewer already
// followed that person, and follow() had no in-flight guard - a member's
// second, well-intentioned tap on a button that never visibly changed
// silently unfollowed them (the insert's 23505 conflict is deliberately
// turned into a delete), with an identical toast either way.
//
// Fixed with a followingIds cache (loaded once, alongside blockedIds,
// updated optimistically by follow() itself) and a followBusy in-flight
// guard, both read through the one shared followButtonHtml() every
// follow-button call site now renders through - see cloud.js.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

function member(id, name, extra) {
  return Object.assign({ id, handle: id, display_name: name, is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true }, extra || {});
}
function applyFollowsUnique(mock) {
  const realFrom = mock.client.from.bind(mock.client);
  mock.client.from = (table) => {
    const c = realFrom(table);
    if (table === "follows") {
      const realInsert = c.insert.bind(c);
      c.insert = (payload) => {
        const exists = mock.db.follows.some((f) => f.follower_id === payload.follower_id && f.followed_id === payload.followed_id);
        if (exists) return { then: (onOk) => Promise.resolve(onOk({ error: { code: "23505" } })) };
        return realInsert(payload);
      };
    }
    return c;
  };
}
function seeded(extra) {
  const mock = createMockSupabase(Object.assign({
    profiles: [member("u1", "דנה"), member("u2", "נועם")],
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: "u2", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
    ],
    follows: [], blocks: [], reactions: [], post_comments: [],
    feed_page_rows: [], feed_impressions: [], feed_interactions: [], hidden_posts: [],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  applyFollowsUnique(mock);
  return mock;
}
async function openDirectory(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 4000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="directory"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="follow"][data-id="u2"]'), 4000);
}
const followBtn = (window) => window.document.querySelector('[data-community-action="follow"][data-id="u2"]');

test("a member the viewer does not yet follow shows 'מעקב'; one already followed shows a distinct 'עוקבים' state, not the same unconditional label", async () => {
  const notFollowing = seeded();
  const w1 = await bootCommunity(notFollowing, { syncEnabled: false });
  await openDirectory(w1);
  assert.equal(followBtn(w1).textContent, "מעקב");
  assert.equal(followBtn(w1).classList.contains("selected"), false);

  const alreadyFollowing = seeded({ follows: [{ follower_id: "u1", followed_id: "u2", created_at: VERIFIED }] });
  const w2 = await bootCommunity(alreadyFollowing, { syncEnabled: false });
  await openDirectory(w2);
  assert.equal(followBtn(w2).textContent, "עוקבים", "must visibly differ from the not-following state, not render the same 'מעקב' regardless");
  assert.equal(followBtn(w2).classList.contains("selected"), true);
});

test("tapping follow updates the button's own state immediately, with a toast that says which direction just happened", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openDirectory(window);

  followBtn(window).click();
  await waitFor(() => mock.db.follows.some((f) => f.follower_id === "u1" && f.followed_id === "u2"), 4000);
  assert.equal(followBtn(window).textContent, "עוקבים", "the SAME button must now reflect the new state, not require a reload/re-navigation");
  assert.match(window.document.body.textContent, /התחלתם לעקוב/);

  followBtn(window).click();
  await waitFor(() => !mock.db.follows.some((f) => f.follower_id === "u1" && f.followed_id === "u2"), 4000);
  assert.equal(followBtn(window).textContent, "מעקב");
  assert.match(window.document.body.textContent, /הפסקתם לעקוב/, "unfollowing must say so, not repeat the exact same wording a follow just used");
});

test("a rapid double-tap on follow (no in-flight guard, before) results in exactly one net follow, not a silent follow-then-unfollow", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openDirectory(window);

  // Two click events dispatched back to back, before the first one's own
  // network round trip has resolved - exactly the shape a fast double-tap
  // takes, and the busy guard's actual job is to make the second one a
  // no-op rather than a second, conflicting write.
  followBtn(window).click();
  followBtn(window).click();
  await waitFor(() => mock.db.follows.some((f) => f.follower_id === "u1" && f.followed_id === "u2"), 4000);
  await new Promise((r) => setTimeout(r, 20)); // let a would-be second write (the bug) land, if the guard failed

  assert.equal(mock.db.follows.filter((f) => f.follower_id === "u1" && f.followed_id === "u2").length, 1, "exactly one follow edge, not zero (a silent double-toggle) and not two");
});

test("the button disables itself while a follow/unfollow is in flight", async () => {
  const mock = seeded();
  let release;
  const gate = new Promise((r) => { release = r; });
  const realFrom = mock.client.from.bind(mock.client);
  mock.client.from = (table) => {
    const c = realFrom(table);
    if (table === "follows") {
      const realInsert = c.insert.bind(c);
      c.insert = (payload) => ({ then: (onOk, onErr) => gate.then(() => realInsert(payload)).then(onOk, onErr) });
    }
    return c;
  };
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openDirectory(window);

  followBtn(window).click();
  await waitFor(() => !!followBtn(window) && followBtn(window).disabled, 2000);
  assert.equal(followBtn(window).textContent, "…");
  release();
  await waitFor(() => !followBtn(window).disabled, 4000);
});
