// UX finding, deferred from the earlier audit-fixes batch: tapping
// "השוואה" on a feed post rendered the comparison result at the top of
// the whole feed, not under the post that triggered it - scrolled far
// down, the result appeared somewhere the viewer had to scroll back up
// to find, with no visual link to which post it was for. Now tracked
// per-post (state.comparisonForPostId) and rendered inline inside that
// post's own card; a second tap on the same post's button closes it.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

test("the standalone top-of-feed comparison section is gone", () => {
  assert.doesNotMatch(cloudJs, /const feedTab = [^;]*\bcomparison\b[^;]*;/);
  // COMM-115 added the club strip above the announcements, COMM-155 the
  // pinned strip above that, and COMM-222 the onboarding step card above
  // that. The assertion that matters here is unchanged: `comparison` is
  // not one of the parts the Feed sub-tab is built from.
  assert.match(cloudJs, /const feedTab = renderPinnedStrip\(\) \+ renderOnboardingStep\(\) \+ clubTopHtml \+ announcementsHtml \+ feedHtml;/);
});

test("compare() tracks which post it's for, and a second tap on the same post closes it instead of re-fetching", () => {
  const start = cloudJs.indexOf("async function compare(comparisonKey, postId)");
  const end = cloudJs.indexOf("\n  }", start);
  const body = cloudJs.slice(start, end);
  assert.match(body, /if \(state\.comparisonForPostId === postId\) \{ state\.comparisonForPostId = null; state\.comparison = \[\]; return rerender\(\); \}/);
  assert.match(body, /state\.comparisonForPostId = postId;/);
});

test("the compare button passes the post id, and the result renders inside that post's own card", () => {
  assert.match(cloudJs, /data-community-action="compare" data-key="\$\{safeText\(post\.comparison_key\)\}" data-id="\$\{safeText\(post\.id\)\}"/);
  assert.match(cloudJs, /action === "compare"\) compare\(el\.dataset\.key, el\.dataset\.id\);/);
  assert.match(cloudJs, /\$\{state\.comparisonForPostId === post\.id \? `<div class="log-list"/);
});
