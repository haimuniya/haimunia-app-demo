// Found by an independent architecture review, not a user report:
// refreshSession() - the path that runs on every normal app open when a
// session already exists, the common case - pulled remote private
// records without first flushing the local outbox. A set logged offline
// seconds before reopening the app would get silently overwritten by the
// still-stale server copy: the outbox row survives and re-pushes later,
// but the UI visibly regresses in the meantime. The onAuthStateChange
// handler (fresh sign-in / token refresh only) already flushed before
// pulling; refreshSession() is the far more common path and was missing
// it. jsdom can't execute cloud.js (see community-invite-gate.test.mjs's
// own note on this), so this asserts the fix at the source-text level,
// same pattern as the other ordering-sensitive tests in this repo.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

test("refreshSession() flushes the outbox before pulling private records, same as onAuthStateChange", () => {
  const fnStart = src.indexOf("async function refreshSession()");
  const fnEnd = src.indexOf("\n  }", fnStart);
  assert.ok(fnStart > -1 && fnEnd > fnStart, "refreshSession() must exist");
  const body = src.slice(fnStart, fnEnd);

  const flushAt = body.indexOf("await flushOutbox()");
  const pullAt = body.indexOf("await pullPrivateRecords()");
  assert.ok(flushAt > -1, "refreshSession() must call flushOutbox()");
  assert.ok(pullAt > -1, "refreshSession() must call pullPrivateRecords()");
  assert.ok(flushAt < pullAt, "flushOutbox() must run before pullPrivateRecords(), or a pending local edit gets silently overwritten by the stale remote copy");
});

// COMM-331 restructured this handler: the deferred feed/streaks/etc.
// cascade moved into ensureCommunityDataLoaded() (see cloud.js's own
// comment on it and on afterRenderCommunity()), and flushOutbox() moved
// inside the Promise.all alongside loadProfile()/loadChallenges()/
// loadClubFeatures() (all three kept eager - see the same comment for
// why). The flush-before-pull invariant this test guards still has to
// hold on the sign-in path.
test("the onAuthStateChange path still flushes before pulling too (regression guard, not just refreshSession)", () => {
  assert.match(src, /Promise\.all\(\[loadProfile\(\), loadChallenges\(\), loadClubFeatures\(\), flushOutbox\(\)\]\)\)\s*\n\s*\.then\(pullPrivateRecords\)/);
});
