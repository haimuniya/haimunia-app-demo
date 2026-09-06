// Deploy-order safety.
//
// THE RISK. This app has no build step and no deploy pipeline: the client
// is static files, the database is migrated separately, and nothing
// structurally forces the two to ship in order. This release changed five
// RPC signatures, and PostgREST resolves overloads by the EXACT set of
// named arguments - so a client that ships ahead of its migrations gets
// PGRST202 "Could not find the function" on every write. Posting,
// commenting, reactions, RSVP and coach progress entries would all die at
// once.
//
// That was originally handled by writing "apply migrations first" in an
// audit document. A note in a document is not a control. Two real ones now
// exist, and this file pins both:
//
//   1. The client DEGRADES instead of breaking - it retries un-keyed on
//      PGRST202, so an ordering mistake costs idempotency, not the feature.
//   2. `npm run check-deploy-readiness` probes the target project and exits
//      non-zero before you ship. Verified against a real database in both
//      directions: rolled back it reports NOT READY (exit 1); migrated it
//      reports READY (exit 0).
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cloudJs = fs.readFileSync(path.join(root, "cloud.js"), "utf8");
const preflight = fs.readFileSync(path.join(root, "scripts", "check-deploy-readiness.mjs"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("the client detects an un-migrated server and retries without the key", () => {
  assert.match(cloudJs, /function isMissingFunctionError\(error\)/,
    "there must be an explicit detector for the un-migrated-server case");
  // Both halves of the condition matter. PGRST202 alone would also match a
  // genuinely mistyped RPC name, which must keep surfacing as an error
  // rather than being silently retried.
  assert.match(cloudJs, /error\.code === "PGRST202"/);
  assert.match(cloudJs, /p_idempotency_key/,
    "the detector must confirm the missing parameter is OURS before degrading");

  const fn = cloudJs.slice(cloudJs.indexOf("async function communityRpc"));
  const body = fn.slice(0, fn.indexOf("\n  }") + 4);
  assert.match(body, /if \(isMissingFunctionError\(error\)\) \{/);
  assert.match(body, /missingIdempotencyParam\[action\] = true;/,
    "the result must be latched per action, or every write pays a wasted round trip");
  assert.match(body, /\(\{ data, error \} = await client\.rpc\(action, bare\)\);/,
    "the retry must actually re-issue the call without the key");
});

test("the latch makes the fallback cost one round trip per action, not one per write", () => {
  const fn = cloudJs.slice(cloudJs.indexOf("async function communityRpc"));
  const body = fn.slice(0, fn.indexOf("\n  }") + 4);
  assert.match(body, /const key = missingIdempotencyParam\[action\] \? null : newIdempotencyKey\(\);/,
    "once an action is known un-migrated, later calls must skip the key entirely");
});

test("queued writes get the same fallback, or the outbox would bury them as permanent failures", () => {
  // src/outbox.js's PERMANENT_ERROR_RE matches "not found", so an
  // unhandled PGRST202 would mark every queued community write permanently
  // failed - dumping a member's offline posts into the failure banner and
  // breaking the queue's central "never lose a queued action" promise.
  const reg = cloudJs.slice(cloudJs.indexOf("function registerOutboxHandlers"));
  const body = reg.slice(0, reg.indexOf("\n  }") + 4);
  assert.match(body, /if \(isMissingFunctionError\(error\)\) \{/,
    "the outbox handler must degrade the same way communityRpc does");
  assert.match(body, /delete bare\.p_idempotency_key;/,
    "the stored key must be stripped from the queued args before the retry");

  const outbox = fs.readFileSync(path.join(root, "src", "outbox.js"), "utf8");
  assert.match(outbox, /PERMANENT_ERROR_RE[\s\S]{0,200}not found/,
    "this test's premise: 'not found' really is classified permanent, which is why the handler must catch PGRST202 first");
});

test("the preflight check exists, is runnable, and is read-only", () => {
  assert.equal(pkg.scripts["check-deploy-readiness"], "node scripts/check-deploy-readiness.mjs");
  // It must cover every action whose signature changed.
  for (const fn of ["post_create", "add_post_comment", "toggle_reaction", "chal_record_progress", "event_rsvp"]) {
    assert.ok(preflight.includes(`"${fn}"`), `preflight must probe ${fn}`);
  }
  assert.match(preflight, /process\.exit\(1\)/, "it must fail the shell, not just print");
  // Read-only: it asserts on the error CODE of a deliberately invalid
  // payload, so probing a production project cannot write to it.
  assert.match(preflight, /json\.code === "PGRST202"/);
  assert.match(preflight, /never writes anything/i,
    "the read-only guarantee should be stated where the next reader will see it");
});

test("a permission error counts as a PASS - the probe asks about resolution, not authorization", () => {
  // 42501 is the EXPECTED answer for an anonymous caller against these
  // definer functions. Treating it as a failure would make the check
  // useless against any correctly-secured project.
  assert.match(preflight, /42501 permission-denied, which is the EXPECTED answer/,
    "the reasoning for accepting 42501 must be recorded, or someone will 'fix' it into a failure");
});
