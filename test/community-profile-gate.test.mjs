// Two real bugs, both reported by the user actually trying this: member
// search only fired on blur (a "change" listener), which looks completely
// broken to anyone typing and expecting results as they go; and a
// freshly-redeemed code landed straight on the mostly-empty Feed tab with
// no visible cue that a profile still needed to be created, so "did this
// even save?" had no clear answer. Both fixed by matching the app's own
// existing patterns: historySearch already uses a live "input" listener,
// and the invite-code/signed-out states already use an unskippable
// single-purpose gate instead of a normal tabbed screen.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

test("member search responds to typing (input), not only on blur (change)", () => {
  assert.match(cloudJs, /input\.addEventListener\("input", \(\) => searchPeople\(input\.value\)\)/);
  assert.doesNotMatch(cloudJs, /input\.addEventListener\("change", \(\) => searchPeople/);
});

test("a signed-in, code-redeemed user with no profile yet sees an unskippable profile-completion gate, not the tabbed UI", () => {
  const gateAt = cloudJs.indexOf("if (!state.profile) return");
  const tabsAt = cloudJs.indexOf("const tabs = [");
  assert.ok(gateAt > -1, "the profile gate must exist");
  assert.ok(gateAt < tabsAt, "the gate must be checked before the tabbed UI is ever built");
  const gate = cloudJs.slice(gateAt, cloudJs.indexOf("const p = state.profile"));
  assert.match(gate, /id="communityProfile"/, "the gate's form must use the same id the existing submit dispatcher already handles");
  assert.match(gate, /name="handle"/);
});
