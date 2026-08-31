// Found by an independent UX review: publishing a workout to the
// community feed (public, optionally with a photo) fired immediately
// with zero confirmation or preview, while comparatively low-stakes
// actions in the same file (block, sync history, delete account) went
// through native window.confirm() - three different destructive-action
// patterns for comparably serious actions, and the riskiest one (public
// broadcast) had none at all. Replaced all of it with one in-app confirm
// dialog (askConfirm/closeConfirm/runConfirm), reused for every
// destructive or broadcast action, plus a new delete-own-post action
// (there was previously no way to remove a single published post short
// of deleting the whole account).
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const src = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

const VERIFIED = new Date().toISOString();
const NOW = Date.now();
const iso = (deltaDays) => new Date(NOW + deltaDays * 86400000).toISOString();

test("no raw window.confirm() remains in cloud.js", () => {
  assert.doesNotMatch(src, /window\.confirm\(/);
});

test("askConfirm/closeConfirm/runConfirm exist, and the dispatcher wires confirm-yes/confirm-no", () => {
  assert.match(src, /function askConfirm\(opts\) \{ state\.confirmDialog = opts; rerender\(\); \}/);
  assert.match(src, /function closeConfirm\(\) \{ state\.confirmDialog = null; rerender\(\); \}/);
  assert.match(src, /function runConfirm\(\)/);
  assert.match(src, /action === "confirm-yes"\) runConfirm\(\)/);
  assert.match(src, /action === "confirm-no"\) closeConfirm\(\)/);
});

test("publishing asks for confirmation with a title/result preview before calling publishWorkout, instead of firing immediately", () => {
  const clickHandlerStart = src.indexOf('if (action === "publish") {');
  const clickHandlerEnd = src.indexOf("else if (action === \"follow\")", clickHandlerStart);
  const block = src.slice(clickHandlerStart, clickHandlerEnd);
  assert.match(block, /askConfirm\(\{ title: "פרסום תוצאה"/);
  assert.match(block, /action: "publish", payload: \{ type: el\.dataset\.type, id: el\.dataset\.id, visibility: el\.dataset\.visibility, file \}/);
  assert.doesNotMatch(block, /publishWorkout\(/, "publishWorkout must not be called directly from the click handler anymore - only from runConfirm()");
});

test("block, delete-account, and migrate all route through askConfirm with a destructive-appropriate label", () => {
  assert.match(src, /askConfirm\(\{ title: "חסימת משתמש".*action: "block", payload: \{ userId: el\.dataset\.id \} \}\)/);
  assert.match(src, /askConfirm\(\{ title: "מחיקת חשבון".*action: "delete-account" \}\)/);
  assert.match(src, /askConfirm\(\{ title: "סנכרון היסטוריה".*action: "migrate" \}\)/);
});

test("deletePost is scoped to the caller's own post, and only the author sees a delete action (report otherwise)", () => {
  assert.match(src, /async function deletePost\(postId\) \{\s*if \(!state\.user\) return;\s*const \{ error \} = await client\.from\("workout_posts"\)\.delete\(\)\.eq\("id", postId\)\.eq\("author_id", state\.user\.id\);/);
  assert.match(src, /post\.author_id === \(state\.user && state\.user\.id\) \? `<button class="chip-btn" data-community-action="delete-post"/);
  assert.match(src, /askConfirm\(\{ title: "הסרת שיתוף".*action: "delete-post", payload: \{ postId: el\.dataset\.id \} \}\)/);
});

test("COMM-234: renderConfirmSheet() is concatenated LAST in renderConfirmDialog(), so it stacks on top of every other .modal-overlay it can be nested inside", () => {
  // Found by a real-Chromium browser-check run (community-challenge-lifecycle.mjs
  // - leave-challenge's confirm fires while challengeView is still open):
  // every overlay this function returns shares the .modal-overlay class and
  // the same fixed z-index:50 (index.html), so two open at once stack by DOM
  // order, not by which one is logically "on top". askConfirm() is always a
  // modal-on-modal nested inside whatever triggered it (leave-challenge/
  // event-cancel/composer-discard all fire it with their own overlay still
  // open), so its markup has to be the last thing concatenated. jsdom's
  // programmatic .click() has no hit-testing, so this real bug was invisible
  // to every prior test that clicked confirm-yes directly - this source-order
  // assertion is the change-detector; the real-browser click-through proof
  // lives in scripts/browser-check/community-challenge-lifecycle.mjs.
  const fnStart = src.indexOf("function renderConfirmDialog()");
  const fnEnd = src.indexOf("\n  }", fnStart);
  const body = src.slice(fnStart, fnEnd);
  const confirmIdx = body.indexOf("renderConfirmSheet()");
  assert.ok(confirmIdx > -1, "renderConfirmSheet() must still be called from renderConfirmDialog()");
  for (const other of ["renderPostComposer()", "renderChallengeViewOverlay()", "renderEventViewOverlay()", "renderRecapViewOverlay()", "renderNotificationCenter()", "renderCommunityProfileOverlay()"]) {
    const otherIdx = body.indexOf(other);
    assert.ok(otherIdx > -1, `${other} must still be called from renderConfirmDialog()`);
    assert.ok(confirmIdx > otherIdx, `renderConfirmSheet() must be concatenated after ${other}, so it paints on top`);
  }
});

test("COMM-234: leaving a challenge through the real render path puts the confirm sheet's markup after the still-open challengeView overlay's markup in the DOM", async () => {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, allow_follows: true, in_leaderboards: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    challenges: [{ id: "c1", challenge_type: "individual_target", title: "12 אימונים החודש", description: "", metric_type: "session_count", target_value: 12, start_at: iso(-5), end_at: iso(20), status: "active", join_mode: "open", visibility: "club", created_by: "u1", config: {} }],
    challenge_participants: [{ challenge_id: "c1", user_id: "u1", club_id: "club-1", team_id: null, joined_at: iso(-1), status: "active", progress_value: 4, completed_at: null }],
    challenge_progress: [], workout_posts: [], feed_page_rows: [], analytics_events: [], notifications: [], notification_preferences: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="boards"]').click();
  await waitFor(() => !!window.document.querySelector('[data-challenge-id="c1"]'), 3000);
  window.document.querySelector('[data-challenge-id="c1"] [data-community-action="open-challenge"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="leave-challenge"]'), 3000);
  window.document.querySelector('[data-community-action="leave-challenge"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="confirm-yes"]'), 3000);

  const overlays = [...window.document.querySelectorAll(".modal-overlay.open")];
  const challengeOverlay = overlays.find((o) => o.getAttribute("data-cloud-dialog") === "challengeView");
  const confirmOverlay = overlays.find((o) => o.querySelector('[data-community-action="confirm-yes"]'));
  assert.ok(challengeOverlay && confirmOverlay, "both overlays must be open at once, matching the real nested-confirm flow");
  const position = challengeOverlay.compareDocumentPosition(confirmOverlay);
  assert.ok(position & window.Node.DOCUMENT_POSITION_FOLLOWING, "the confirm overlay must be a later DOM sibling than challengeView, so it paints on top under the shared z-index");
});

test("the confirm dialog is exposed globally (not just inside the Community tab's own output) and reset on sign-out", () => {
  // Sharing can now be triggered from the Calendar/Progress tabs (see
  // renderShareControl), so the confirm dialog can't only render as part
  // of renderCommunityApp()'s return value - app.js's own render() calls
  // window.renderCloudConfirmDialog() unconditionally after every tab's
  // content instead. See community-live-sync-and-auth.test.mjs for an
  // executing test of this actually working across a tab switch.
  assert.match(src, /function renderConfirmDialog\(\)/);
  assert.match(src, /window\.renderCloudConfirmDialog = renderConfirmDialog;/);
  assert.match(src, /state\.confirmDialog = null;\s*$/m);
});
