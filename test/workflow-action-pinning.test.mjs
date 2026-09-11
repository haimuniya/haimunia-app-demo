// Security hunt round 9: every `uses:` action in .github/workflows/ is
// meant to be pinned to a full 40-char commit SHA (with a `# vX.Y.Z`
// comment for a human to see what that SHA actually is), not a floating
// tag - a tag can be moved to point at different code with no commit in
// this repo to review, right underneath a CI job. An earlier launch-
// readiness audit found and fixed exactly this on test.yml's
// migration-check job (`supabase/setup-cli@v1` -> a pinned SHA), but the
// identical `@v1`/`version: latest` pattern was still live in
// deploy-edge-functions.yml - the higher-privilege of the two jobs, since
// it runs with a real SUPABASE_ACCESS_TOKEN against production Edge
// Functions rather than a throwaway local stack. Nothing caught that the
// fix never reached every workflow file, so this locks the convention in
// across all of them, not just the one job an earlier audit happened to
// look at.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workflowsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");
const workflowFiles = fs.readdirSync(workflowsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

test("sanity check: at least one workflow file exists to check", () => {
  assert.ok(workflowFiles.length > 0, "expected .github/workflows/*.yml to exist");
});

for (const file of workflowFiles) {
  test(`every action in ${file} is pinned to a full commit SHA, not a floating tag`, () => {
    const text = fs.readFileSync(path.join(workflowsDir, file), "utf8");
    const usesLines = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1]);
    assert.ok(usesLines.length > 0, `sanity check: ${file} should reference at least one action`);
    for (const ref of usesLines) {
      // A local/composite action (./path) has no remote SHA to pin - not
      // what this check is about.
      if (ref.startsWith("./") || ref.startsWith(".\\")) continue;
      assert.match(
        ref,
        /^[^@]+@[0-9a-f]{40}$/,
        `${file}: "${ref}" must be pinned to a full 40-char commit SHA (owner/repo@<sha>), not a floating tag or "latest"`,
      );
    }
  });
}
