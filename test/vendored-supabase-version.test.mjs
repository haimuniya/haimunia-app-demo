// Architecture finding: package.json declares @supabase/supabase-js as
// a dependency, but the app actually loads vendor/supabase.js, a
// hand-copied build artifact - nothing checked the two actually match,
// so they could silently drift. This runs the real check script (fully
// offline - it only reads local files, no network) as a subprocess and
// asserts it currently passes; if a future version bump updates
// package.json without re-vendoring the client, this test starts
// failing exactly as intended.
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("vendor/supabase.js matches the @supabase/supabase-js version declared in package.json", () => {
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, [path.join(root, "scripts", "check-vendored-supabase-version.mjs")], { stdio: "pipe" });
  }, "the vendored client version must match package.json's declared dependency - run `npm run check-vendor-version` for the exact mismatch if this fails");
});
