// Reported directly: "שיתוף תוצאה takes too much [room] here, it need to
// be shared by click from the calendar or progress, not from community
// area." The old "share result" section was a standing list of the 8
// most recent shareable results sitting at the top of the Community
// tab's feed - the place you open to see *other* people's posts, not to
// decide what of your own to publish. Removed it; sharing is now
// triggered from wherever a result actually lives (Calendar day view,
// a movement/WOD's Progress card), collapsed to a single icon by
// default (renderShareControl), only expanding into the
// photo/visibility controls when tapped.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const appJs = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("the standing share-result list no longer exists in the Community feed tab", () => {
  assert.doesNotMatch(cloudJs, /שיתוף תוצאה/, "the dedicated community-tab share section should be gone");
  assert.doesNotMatch(cloudJs, /const sharing = candidates\.length/);
});

test("renderShareControl is collapsed to one icon by default, and only signed-in members see it", () => {
  assert.match(cloudJs, /window\.renderShareControl = function \(type, id\) \{/);
  assert.match(cloudJs, /if \(!window\.isCommunitySignedIn \|\| !window\.isCommunitySignedIn\(\)\) return "";/);
  assert.match(cloudJs, /data-community-action="toggle-share"/);
});

test("publishing looks up the entry by id regardless of age (communityShareCandidateFor), not just the most recent handful", () => {
  assert.match(appJs, /function communityShareCandidateFor\(type, id\)/);
  assert.match(cloudJs, /window\.communityShareCandidateFor\(type, id\)/);
  assert.match(cloudJs, /window\.communityShareCandidateFor\(el\.dataset\.type, el\.dataset\.id\)/);
  assert.doesNotMatch(cloudJs, /window\.communityShareCandidates\(\)\.find/, "publishing must not rely on the recency-limited list anymore");
});

test("the share control is wired into Calendar's day-detail entries (strength and WOD) and into Progress's detail cards", () => {
  const calDetailStart = appJs.indexOf("function renderCalDetail()");
  const calDetailEnd = appJs.indexOf("\nfunction ", calDetailStart + 10);
  const calBlock = appJs.slice(calDetailStart, calDetailEnd);
  assert.match(calBlock, /window\.renderShareControl\("strength_entry", e\.id\)/);
  assert.match(calBlock, /window\.renderShareControl\("wod_entry", e\.id\)/);

  assert.match(appJs, /window\.renderShareControl\("strength_entry", hEntries\[0\]\.id\)/);
  assert.match(appJs, /window\.renderShareControl\("strength_entry", durationEntries\[0\]\.id\)/);

  const wodDetailStart = appJs.indexOf("function renderWodDetailCard(w)");
  const wodDetailEnd = appJs.indexOf("\nfunction ", wodDetailStart + 10);
  assert.match(appJs.slice(wodDetailStart, wodDetailEnd), /window\.renderShareControl\("wod_entry", e\.id\)/);
});

test("a successful publish collapses that entry's share control back down", () => {
  const start = cloudJs.indexOf("async function publishWorkout(type, id, visibility, photoFile)");
  const end = cloudJs.indexOf("\n  }", start);
  assert.match(cloudJs.slice(start, end), /delete state\.openShare\[shareKey\(type, id\)\];/);
});
