// Launch-readiness audit, TESTING_GAPS.md TEST-2 / TEST-3.
//
// WHY THIS FILE EXISTS. The code-quality pass found three P1 client bugs,
// and all three were in the only two client surfaces with ZERO test
// coverage of any kind:
//
//   * member_roles      -> CQ-003 (the coach-badge cache poisoned by one
//                          transient RPC error, for the rest of the session)
//   * report_profile_target -> CQ-001 (a reported PROFILE labelled "פוסט"
//                          in two admin screens) and CQ-002 (a "remove
//                          content" button the server always rejects)
//
// That is not a coincidence worth leaving in place. These are the
// regression tests for the fixes, written against the shipped source so a
// future edit that reintroduces any of the three fails here.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cloudJs = fs.readFileSync(path.join(root, "cloud.js"), "utf8");

function fnBody(name) {
  const start = cloudJs.indexOf(name);
  assert.ok(start > -1, `${name} must still exist`);
  return cloudJs.slice(start, cloudJs.indexOf("\n  }", start) + 4);
}

// ---------------------------------------------------------------------
// member_roles (CQ-003)
// ---------------------------------------------------------------------

test("CQ-003: loadMemberRoles destructures the RPC error instead of dropping it", () => {
  const body = fnBody("async function loadMemberRoles(ids)");
  assert.match(body, /const \{ data, error \} = await client\.rpc\("member_roles"/,
    "the error must be destructured - this was the ONLY .rpc() call in the reviewed set that ignored it");
});

test("CQ-003: a failed member_roles lookup is evicted, not left cached as 'no role'", () => {
  const body = fnBody("async function loadMemberRoles(ids)");
  // The pre-seed is what made the dropped error worse than a plain silent
  // failure: every requested id was set to null up front, and the
  // `id in state.members.roles` guard then treated "present and null" as
  // "checked, has no role" for the rest of the session.
  assert.match(body, /for \(const id of need\) state\.members\.roles\[id\] = null;/,
    "the optimistic pre-seed is still there (it is what makes the eviction below necessary)");
  assert.match(body, /if \(error\) \{ for \(const id of need\) delete state\.members\.roles\[id\]; return; \}/,
    "on error every pre-seeded id must be DELETED so the next render retries - leaving them null strips the coach badge from that whole batch until a full reload");
  // Order matters: the eviction must come before the success loop, or a
  // partial response would overwrite it.
  assert.ok(body.indexOf("if (error)") < body.indexOf("for (const r of (data || []))"),
    "the error branch must return before the success loop runs");
});

test("CQ-003: the retry path matches the convention resolveAvatarUrl already set", () => {
  // resolveAvatarUrl deliberately leaves a failed lookup uncached and says
  // why. loadMemberRoles now does the same thing; this pins that the two
  // have not drifted back apart.
  const avatar = fnBody("async function resolveAvatarUrl(storedUrl)");
  assert.match(avatar, /signedCacheGet\(avatarUrlCache, storedUrl\)/,
    "resolveAvatarUrl still treats an absent/expired entry as a miss rather than caching a failure");
});

// ---------------------------------------------------------------------
// report_profile_target (CQ-001, CQ-002)
// ---------------------------------------------------------------------

test("CQ-001: a reported profile is labelled 'profile', not 'post', in both admin surfaces", () => {
  // 202609050002 widened reports.target_type to ('post','comment','profile')
  // and taught mod_queue() to return profile rows. The client rendered the
  // kind with a two-way ternary that predated the widening, so a profile
  // fell into the else branch and a moderator was shown the member's own
  // bio captioned as a "post excerpt".
  assert.match(cloudJs, /const MOD_TARGET_LABEL = \{ post: "פוסט", comment: "תגובה", profile: "פרופיל" \};/,
    "a full three-way label map must exist");
  const uses = (cloudJs.match(/MOD_TARGET_LABEL\[[a-z]\.target_type\]/g) || []).length;
  assert.equal(uses, 2, "both the queue row and the context sheet must use the map (found " + uses + ")");
  // And the old two-way ternary must be gone from both.
  assert.doesNotMatch(cloudJs, /target_type === "comment" \? "תגובה" : "פוסט"/,
    "the two-way ternary that mislabelled every profile report must not survive anywhere");
});

test("CQ-002: 'remove content' is not offered on a profile report, because the server always rejects it", () => {
  // mod_review() raises 'a profile report has no content to remove'
  // unconditionally for a profile target, so rendering the button made the
  // most prominent, destructive-styled action a guaranteed failure - and
  // runModAction reported it as "try again", which could never succeed.
  assert.match(cloudJs, /MOD_DECISIONS\.filter\(\(d\) => d\.id !== "remove" \|\| r\.target_type !== "profile"\)/,
    "the decision list must be filtered by target type in the queue row renderer");
});

test("CQ-002: the server's refusal is also mapped to a real message as a second layer", () => {
  const body = fnBody("function modActionErrorText(error)");
  assert.match(body, /"a profile report has no content to remove": "אין תוכן להסרה בדיווח על פרופיל\."/,
    "the named server error must map to an explanation, not the generic retry copy");
  const run = fnBody("async function runModAction()");
  assert.match(run, /a\.error = modActionErrorText\(error\);/,
    "runModAction must use the map rather than a hardcoded 'try again' string");
  assert.doesNotMatch(run, /a\.error = "לא ניתן היה להשלים את הפעולה\. נסו שוב\.";/,
    "the unconditional retry message must be gone from runModAction");
});

test("the profile-report path still exists end to end in the client", () => {
  // Guard against 'fixing' CQ-001/002 by quietly removing the feature.
  assert.match(cloudJs, /function reportProfile\(userId\) \{ openReportSheet\("profile", userId\); \}/,
    "a member must still be able to report a profile");
  assert.match(cloudJs, /openReportSheet\("profile"/, "the report sheet must still accept the profile target type");
});
