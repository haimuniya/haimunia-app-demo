// cloud.js isn't loaded in the jsdom boot (no window.HAIMUNIA_CONFIG /
// network), so — matching the precedent in
// test/community-invite-gate.test.mjs — this asserts the source shape of
// the new UI wiring rather than driving it through a real render. Visual
// behavior (sub-tabs, top-3-plus-your-rank, comments expand/collapse,
// pinned note) was verified with real screenshots against a mocked
// Supabase client during development; this locks in that the code paths
// those screenshots exercised still exist.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

test("Community tab is split into feed/boards/account sub-tabs, defaulting to feed", () => {
  assert.match(src, /communityTab: "feed"/);
  assert.match(src, /function setCommunityTab\(tab\)/);
  assert.match(src, /action === "set-tab"\) setCommunityTab\(el\.dataset\.tab\)/);
  assert.match(src, /id: "feed".*id: "boards".*id: "account"/s);
});

test("streaks and the weekly challenge use the top-3-plus-your-rank framing, not one long ranked list", () => {
  assert.match(src, /function renderRankedList\(items, selfKeyOf, formatValue\)/);
  assert.match(src, /renderRankedList\(state\.weeklyLeaderboard, \(it\) => it\.author_id/);
  assert.match(src, /renderRankedList\(state\.streaks, \(it\) => it\.user_id/);
});

test("comments expand/collapse per post and post through a per-post form, not a shared one", () => {
  assert.match(src, /function toggleComments\(postId\)/);
  assert.match(src, /async function addComment\(postId, form\)/);
  assert.match(src, /async function deleteComment\(commentId, postId\)/);
  assert.match(src, /data-comment-post-id="\$\{safeText\(post\.id\)\}"/);
  assert.match(src, /event\.target\.dataset\.commentPostId/);
});

test("a photo can be attached when sharing a result, uploaded to the private post-photos bucket under the user's own folder", () => {
  assert.match(src, /async function uploadPostPhoto\(file\)/);
  assert.match(src, /client\.storage\.from\("post-photos"\)\.upload\(path, file/);
  assert.match(src, /\$\{state\.user\.id\}\/\$\{Date\.now\(\)\}/);
  // The photo picker moved from a standing "share result" list in the
  // Community tab into renderShareControl(), triggered from wherever the
  // result actually lives (Calendar, Progress) - see
  // community-share-control.test.mjs.
  assert.match(src, /id="photo-\$\{safeText\(id\)\}"/);
});

test("who's-new and who's-inactive are both staff-only (admin or coach) and call the matching security-definer RPCs", () => {
  assert.match(src, /async function loadNewMembers\(\)/);
  assert.match(src, /client\.rpc\("coach_new_members"\)/);
  assert.match(src, /client\.rpc\("coach_inactive_members"\)/);
  assert.match(src, /if \(!state\.user \|\| !isStaff\(\)\) return;\s*\n\s*const \{ data, error \} = await client\.rpc\("coach_new_members"\)/);
});

test("an admin can pin an announcement as today's note, and it's excluded from the regular list once pinned", () => {
  assert.match(src, /name="pinToday"/);
  assert.match(src, /payload\.pinned_date = todayIso\(\)/);
  assert.match(src, /const pinnedToday = state\.announcements\.find\(\(a\) => a\.pinned_date === todayIso\(\)\)/);
  assert.match(src, /otherAnnouncements = state\.announcements\.filter\(\(a\) => a !== pinnedToday\)/);
});
