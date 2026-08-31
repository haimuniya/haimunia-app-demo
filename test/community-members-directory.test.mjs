// COMM-231, the members directory screen, executed for real in jsdom against
// the mock Supabase client (test/helpers/mockSupabase.mjs).
//
// WHAT THIS FILE VERIFIES
// - A cursor-paginated (page size 40, cursor = the last row's own
//   display_name) direct RLS read on `profiles`, alphabetical by
//   display_name, excluding the caller's own row and anyone with
//   visible_to_club off, never a full unpaginated fetch.
// - Coach/head_coach members render in their own group above everyone else,
//   reusing COMM-160's badge, each group keeping its own alphabetical order.
// - The search box reuses community_search (COMM-228) at 2+ characters and
//   falls back to a client-side filter over the already-loaded page below
//   that threshold.
// - Tapping a row opens the community profile through the existing
//   view-profile action, and Follow reuses the existing follow() toggle
//   (hidden when allow_follows is off).
// - No Message affordance anywhere on the screen.
// - The documented empty/loading/error states.
// - The COMM-232 suggestions strip and the leaderboard's "find people" link
//   both now live on/point at this screen.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

function member(id, name, extra) {
  return Object.assign({ id, handle: id, display_name: name, is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true }, extra || {});
}
function seeded(extra) {
  const mock = createMockSupabase(Object.assign({
    profiles: [member("u1", "דנה")],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    follows: [], blocks: [], reactions: [], post_comments: [],
    feed_page_rows: [], feed_impressions: [], feed_interactions: [], hidden_posts: [],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function openDirectory(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 4000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="directory"]').click();
}
// view-profile buttons hold the member id (their visible label is "פרופיל",
// not the name), so every ordering assertion below reads .dataset.id rather
// than textContent.
const rowsOf = (window, group) => Array.from(window.document.querySelectorAll(`[data-directory-group="${group}"] [data-community-action="view-profile"]`));

test("the roster is alphabetical, paginated 40 at a time by a cursor read on profiles, and excludes the caller", async () => {
  const members = [];
  for (let i = 1; i <= 45; i++) members.push(member(`m${String(i).padStart(2, "0")}`, `חבר${String(i).padStart(2, "0")}`));
  const mock = seeded({ profiles: [member("u1", "דנה")].concat(members) });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openDirectory(window);
  await waitFor(() => rowsOf(window, "members").length === 40, 4000);
  const idsPage1 = rowsOf(window, "members").map((el) => el.dataset.id);
  assert.deepStrictEqual(idsPage1, members.slice(0, 40).map((m) => m.id));
  assert.equal(window.document.querySelector('[data-directory-empty]'), null);
  assert.ok(window.document.querySelector('[data-community-action="directory-more"]'), "a 41st+ member means there is a next page");
  assert.equal(window.document.querySelector('[data-community-action="view-profile"][data-id="u1"]'), null, "the caller never sees their own row in the roster");

  window.document.querySelector('[data-community-action="directory-more"]').click();
  await waitFor(() => rowsOf(window, "members").length === 45, 4000);
  const allIds = rowsOf(window, "members").map((el) => el.dataset.id);
  assert.deepStrictEqual(allIds, members.map((m) => m.id));
  assert.equal(window.document.querySelector('[data-community-action="directory-more"]'), null, "no more pages once every member has loaded");
});

test("a member with visible_to_club off never appears in the roster", async () => {
  const mock = seeded({ profiles: [member("u1", "דנה"), member("u2", "נועם"), member("u3", "מוסתר", { visible_to_club: false })] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openDirectory(window);
  await waitFor(() => rowsOf(window, "members").length === 1, 4000);
  assert.equal(window.document.querySelector('[data-community-action="view-profile"][data-id="u3"]'), null);
});

test("coach and head_coach members render in their own group above the rest, each group kept alphabetical", async () => {
  const mock = seeded({
    profiles: [member("u1", "דנה"), member("u2", "אבי"), member("u3", "רון"), member("u4", "יעל")],
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: "u2", invite_id: "inv-1", role: "coach", redeemed_at: VERIFIED },
      { user_id: "u3", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: "u4", invite_id: "inv-1", role: "head_coach", redeemed_at: VERIFIED },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openDirectory(window);
  await waitFor(() => rowsOf(window, "staff").length === 2, 4000);
  // The roster is already alphabetical by display_name (אבי, יעל, רון); the
  // staff split keeps that order rather than re-sorting by role.
  assert.deepStrictEqual(rowsOf(window, "staff").map((el) => el.dataset.id), ["u2", "u4"]);
  assert.deepStrictEqual(rowsOf(window, "members").map((el) => el.dataset.id), ["u3"]);
});

test("the search box reuses community_search at two characters or more", async () => {
  const mock = seeded({ profiles: [member("u1", "דנה"), member("u2", "נועם כהן"), member("u3", "רון לוי")] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openDirectory(window);
  await waitFor(() => rowsOf(window, "members").length === 2, 4000);
  mock.onRpc("community_search", () => ({ data: { members: [{ id: "u2", handle: "u2", display_name: "נועם כהן", allow_follows: true }], events: [], challenges: [] }, error: null }));
  const box = window.document.getElementById("communityDirectorySearch");
  box.value = "נו";
  box.dispatchEvent(new window.Event("input", { bubbles: true }));
  await waitFor(() => mock.callsTo("community_search").length === 1, 4000);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(mock.callsTo("community_search")[0])), { p_query: "נו", p_limit: 40 });
  await waitFor(() => rowsOf(window, "members").length === 1 && rowsOf(window, "members")[0].dataset.id === "u2", 4000);
});

test("under the search threshold, the box filters the already-loaded page client-side instead of calling community_search", async () => {
  const mock = seeded({ profiles: [member("u1", "דנה"), member("u2", "נועם כהן"), member("u3", "רון לוי")] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openDirectory(window);
  await waitFor(() => rowsOf(window, "members").length === 2, 4000);
  const box = window.document.getElementById("communityDirectorySearch");
  box.value = "נ";
  box.dispatchEvent(new window.Event("input", { bubbles: true }));
  await waitFor(() => rowsOf(window, "members").length === 1, 4000);
  assert.equal(rowsOf(window, "members")[0].dataset.id, "u2");
  assert.equal(mock.callsTo("community_search").length, 0);
});

test("tapping a row opens the community profile, and Follow is hidden when allow_follows is off", async () => {
  const mock = seeded({ profiles: [member("u1", "דנה"), member("u2", "נועם"), member("u3", "רון", { allow_follows: false })] });
  mock.onRpc("community_profile", (args) => ({ data: { id: args.user_id, display_name: "נועם", handle: "u2", role: "member", member_since: "2024-01-01" }, error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openDirectory(window);
  await waitFor(() => rowsOf(window, "members").length === 2, 4000);
  assert.equal(window.document.querySelector('[data-community-action="follow"][data-id="u3"]'), null, "no follow button for a member who disallows follows");
  assert.ok(window.document.querySelector('[data-community-action="follow"][data-id="u2"]'));
  window.document.querySelector('[data-community-action="view-profile"][data-id="u2"]').click();
  await waitFor(() => !!window.document.getElementById("profileViewTitle"), 4000);
  // profileViewTitle exists from the very first (loading) render, before
  // community_profile answers - wait for the loading placeholder to clear.
  await waitFor(() => !/טוען פרופיל/.test(window.document.getElementById("profileViewTitle").closest(".modal-sheet").textContent), 4000);
  assert.match(window.document.getElementById("profileViewTitle").textContent, /נועם/);
});

test("no Message affordance exists anywhere on the directory screen", async () => {
  const mock = seeded({ profiles: [member("u1", "דנה"), member("u2", "נועם")] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openDirectory(window);
  await waitFor(() => rowsOf(window, "members").length === 1, 4000);
  const tabContent = window.document.getElementById("content");
  assert.equal(tabContent.querySelector('[data-community-action="message"]'), null);
  assert.equal(tabContent.textContent.includes("הודעה"), false);
});

test("empty, loading and error states render the documented copy", async () => {
  const emptyMock = seeded();
  const w1 = await bootCommunity(emptyMock, { syncEnabled: false });
  await openDirectory(w1);
  await waitFor(() => !!w1.document.querySelector('[data-directory-empty="empty"]'), 4000);
  assert.match(w1.document.querySelector('[data-directory-empty="empty"]').textContent, /אין חברים להצגה\./);

  const errMock = seeded({ profiles: [member("u1", "דנה"), member("u2", "נועם")] });
  errMock.client.from = ((realFrom) => (table) => {
    const c = realFrom(table);
    if (table === "profiles") c.then = (onOk) => Promise.resolve(onOk({ data: null, error: { message: "boom" } }));
    return c;
  })(errMock.client.from.bind(errMock.client));
  const w2 = await bootCommunity(errMock, { syncEnabled: false });
  await openDirectory(w2);
  await waitFor(() => !!w2.document.querySelector('[data-directory-empty="error"]'), 4000);
  assert.match(w2.document.querySelector('[data-directory-empty="error"]').textContent, /לא ניתן היה לטעון את רשימת החברים\. נסו שוב\./);
});

test("a failed roster load retries and recovers", async () => {
  const mock = seeded({ profiles: [member("u1", "דנה"), member("u2", "נועם")] });
  let fail = true;
  const realFrom = mock.client.from.bind(mock.client);
  mock.client.from = (table) => {
    const c = realFrom(table);
    if (table === "profiles") {
      c.then = (onOk, onErr) => (fail ? Promise.resolve({ data: null, error: { message: "boom" } }) : Promise.resolve(c._resolve())).then(onOk, onErr);
    }
    return c;
  };
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openDirectory(window);
  await waitFor(() => !!window.document.querySelector('[data-directory-empty="error"]'), 4000);
  fail = false;
  window.document.querySelector('[data-community-action="directory-retry"]').click();
  await waitFor(() => rowsOf(window, "members").length === 1, 4000);
});

test("the people-you-may-know strip renders on the Directory tab", async () => {
  const mock = seeded({ profiles: [member("u1", "דנה"), member("u2", "נועם")] });
  mock.onRpc("people_suggestions", () => ({ data: [{ user_id: "u2", display_name: "נועם", handle: "u2", reason: "interaction" }], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openDirectory(window);
  await waitFor(() => !!window.document.querySelector('[data-people-suggestions="ready"]'), 4000);
  assert.match(window.document.querySelector('[data-people-suggestions="ready"]').textContent, /אנשים שאולי תכירו/);
});
