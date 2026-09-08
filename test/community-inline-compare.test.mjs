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
  // ONE RAIL. This pin used to read
  //   renderPinnedStrip() + renderOnboardingStep() + clubTopHtml
  //   + clubWodTodayHtml + announcementsHtml + feedHtml
  // and the shape of that line was the bug: SIX blocks concatenated above the
  // first post, each added by its own ticket (COMM-115 the club strip,
  // COMM-155 the pinned strip, COMM-222 the onboarding card, 202609080002
  // today's programming), each locally justified, with nothing anywhere
  // judging the total. A concatenation cannot say "no".
  //
  // It is now: the club header, then AT MOST TWO rail cards chosen by
  // priority (RAIL_ABOVE_FEED), then the feed, then the announcements
  // archive. The cards that lose the contest are interleaved into the feed a
  // few posts down by railInterleave() rather than dropped, and the
  // announcements section moved BELOW the feed because an archive is not what
  // a member opened the app to read.
  //
  // The assertion that matters here is unchanged: `comparison` is not one of
  // the parts the Feed sub-tab is built from.
  assert.match(cloudJs, /const feedTab = clubTopHtml \+ railAbove \+ feedHtml \+ announcementsHtml;/);
  // And the budget itself, which is the thing that must not quietly grow
  // back. Raising this number is a product decision, not a refactor.
  assert.match(cloudJs, /const RAIL_ABOVE_FEED = 2;/, "the cap on blocks above the feed must stay explicit and small");
});

test("compare() tracks which post it's for, and a second tap on the same post closes it instead of re-fetching", () => {
  const start = cloudJs.indexOf("async function compare(comparisonKey, postId)");
  const end = cloudJs.indexOf("\n  }", start);
  const body = cloudJs.slice(start, end);
  assert.match(body, /if \(state\.posts\.comparisonForPostId === postId\) \{ state\.posts\.comparisonForPostId = null; state\.posts\.comparison = \[\]; return rerender\(\); \}/);
  assert.match(body, /state\.posts\.comparisonForPostId = postId;/);
});

test("the compare button passes the post id, and the result renders inside that post's own card", () => {
  assert.match(cloudJs, /data-community-action="compare" data-key="\$\{esc\(post\.comparison_key\)\}" data-id="\$\{esc\(post\.id\)\}"/);
  assert.match(cloudJs, /action === "compare"\) compare\(el\.dataset\.key, el\.dataset\.id\);/);
  assert.match(cloudJs, /\$\{state\.posts\.comparisonForPostId === post\.id \? `<div class="log-list"/);
});
