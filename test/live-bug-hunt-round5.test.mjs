// Live bug hunt, round 5 (2026-09-11, the final round): three fresh agents
// found 6 confirmed bugs across theme/visual regression, onboarding/
// account-recovery depth, and resilience under stress (see CHANGES.md for
// the full report). This file covers the one finding without a more
// specific existing test-file home (ensureCommunityDataLoaded()'s missing
// error handling); the invite-code case-sensitivity/busy-guard fixes have
// their own regression tests in test/community-invite-code-draft.test.mjs,
// the clobbered-message fix in test/community-recovery-method.test.mjs, and
// the two CSS/visual fixes (modal-sheet tablet width, print background) in
// scripts/browser-check/tablet-modal-width-and-print.mjs (jsdom cannot see
// real geometry or a print render).
//
// Source-text assertions, not a live throw-inside-a-loader reproduction:
// an early attempt at driving this live (making an RPC handler throw
// synchronously mid-Promise.all) hung the jsdom test harness outright
// rather than producing a clean failure or an observable unhandled
// rejection - a real Node/jsdom interaction hazard in its own right, not
// something worth fighting to reproduce live for a fix this mechanical and
// this easy to verify by shape instead. Same convention
// test/community-invite-code-draft.test.mjs already uses for exactly this
// reason (see its own file-level comment).
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cloudJs = fs.readFileSync(path.join(root, "cloud.js"), "utf8");

function ensureCommunityDataLoadedBody() {
  const start = cloudJs.indexOf("async function ensureCommunityDataLoaded()");
  assert.ok(start > -1, "ensureCommunityDataLoaded() must still exist");
  // Brace-counted, not a naive "\n  }" search - this function's own body
  // now contains a try/catch/finally with several nested blocks at the
  // same indent depth as a naive search could stop at prematurely.
  let depth = 0, i = cloudJs.indexOf("{", start);
  const bodyStart = i;
  for (; i < cloudJs.length; i++) {
    if (cloudJs[i] === "{") depth++;
    else if (cloudJs[i] === "}") { depth--; if (depth === 0) break; }
  }
  return cloudJs.slice(start, i + 1);
}

// Live bug hunt round 5 (2026-09-11), resilience-under-stress agent: no
// top-level error handling existed here at all. Every individual loader
// already normalizes a real Supabase network failure into a resolved
// {data:null,error} object (confirmed by reading vendor/supabase.js's
// PostgrestBuilder), so this was not reachable through an ordinary network
// hiccup - but if some OTHER bug ever threw inside one of the ~17 parallel
// loaders, the old finally-only version still marked
// communityDataLoaded = true (permanently blocking any retry for the rest
// of the session, since the guard at the top of this function checks
// exactly that flag) while the exception itself propagated past
// afterRenderCommunity()'s un-awaited call as an unhandled rejection.
test("a throw inside the batch is caught, logged, and does not mark the batch permanently loaded - only a genuine success does", () => {
  const body = ensureCommunityDataLoadedBody();
  assert.match(body, /\} catch \(e\) \{/, "the Promise.all batch must have a real catch, not just a finally");
  assert.match(body, /console\.error\("ensureCommunityDataLoaded failed", e\);/, "a failure must be surfaced, not silently swallowed");

  // communityDataLoaded = true must appear ONLY inside the try block (the
  // success path), never inside catch or finally - otherwise a failed
  // batch is indistinguishable from a completed one and next call's guard
  // (`... || state.communityDataLoaded || ...`) silently no-ops forever.
  const catchStart = body.indexOf("} catch (e) {");
  const finallyStart = body.indexOf("} finally {");
  assert.ok(catchStart > -1 && finallyStart > catchStart, "catch must precede finally");
  const trySection = body.slice(0, catchStart);
  const catchAndFinallySection = body.slice(catchStart);
  assert.match(trySection, /state\.communityDataLoaded = true;/, "success still marks the batch loaded");
  assert.doesNotMatch(catchAndFinallySection, /state\.communityDataLoaded = true;/,
    "a failed batch must NOT be marked loaded - that permanently blocks every future retry for the session");

  // communityDataLoading = false must still run on every exit path
  // (success or failure) so a later call isn't blocked by the OTHER guard
  // condition forever either.
  assert.match(body, /\} finally \{\s*state\.communityDataLoading = false;\s*\}/, "the in-flight flag must clear on every exit path, success or failure");
});
