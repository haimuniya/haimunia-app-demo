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

const src = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

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
