#!/usr/bin/env node
// vendor/supabase.js is a hand-copied build artifact loaded directly by
// index.html - nothing previously checked that it actually matches the
// version package.json declares as the project's dependency, so the two
// could silently drift. The bundle embeds several sub-package versions
// (gotrue-js, postgrest-js, ...); the top-level @supabase/supabase-js
// package specifically exports its own version via a `version.ts` module
// compiled to `t.version="X.Y.Z"` in the minified bundle - distinct from
// the others because it's the only one assigned through an
// `exports.version` pattern rather than a bare local variable.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const declared = (pkg.dependencies && pkg.dependencies["@supabase/supabase-js"] || "").replace(/^[\^~]/, "");
if (!declared) {
  console.error("package.json has no @supabase/supabase-js dependency to compare against.");
  process.exit(1);
}

const vendorSrc = readFileSync(path.join(root, "vendor", "supabase.js"), "utf8");
// The 2.114.0 re-vendor changed the minifier: string literals are now
// backticks, and the top-level version is emitted as a BARE LOCAL
// (`let Vn=\`2.114.0\``) rather than through an `exports.version` pattern.
// The property this check used to lean on - that the top-level package was
// the only one assigned that way - no longer exists, because Supabase now
// versions the monorepo as a unit (realtime-js reports 2.114.0 too).
//
// So the version half of this check is deliberately weaker than it was: it
// asserts the declared version appears in the bundle as a version-shaped
// literal, not that a specific sub-package reported it. That is honest about
// what can still be distinguished. THE SHA256 PIN BELOW IS UNCHANGED and is
// the half that actually stops an unexplained edit - a version marker only
// ever proved what the bundle CLAIMS.
const match = vendorSrc.match(/exports?\.version=void 0,\s*t\.version="([0-9.]+)"/)
  || vendorSrc.match(/t\.version="([0-9.]+)"/)
  || vendorSrc.match(new RegExp("[=:]\\s*[`\"']" + declared.replace(/\./g, "\\.") + "[`\"']"))
  && [null, declared];
if (!match) {
  console.error("Could not find the @supabase/supabase-js version marker in vendor/supabase.js - the bundle's minification pattern may have changed; update this script's regex.");
  process.exit(1);
}
const vendored = match[1];

if (vendored !== declared) {
  console.error(`Mismatch: package.json declares @supabase/supabase-js@${declared}, but vendor/supabase.js was built from ${vendored}. Re-vendor the client or update package.json.`);
  process.exit(1);
}
// Launch-readiness audit, DEP-3. The version marker above proves the
// bundle CLAIMS a version; it does not prove the bytes are the ones that
// were reviewed. vendor/supabase.js is a 131 KB minified blob that ships
// to every browser and is the only path to the backend - exactly the shape
// of artefact a supply-chain edit hides in, and a one-character change to
// it would pass every other check in this repo.
//
// Regenerating this hash is a deliberate act: re-vendor the client, run
// `sha256sum vendor/supabase.js`, paste it here, and say in the PR why the
// bundle changed. That is the whole control - it makes an unexplained edit
// impossible to land quietly.
const EXPECTED_SHA256 = "c3754a5a4e8efcdc03c1c0028781eb7ec6043da0b952ebf85d530a21d5c91469";
const actualSha = createHash("sha256").update(readFileSync(path.join(root, "vendor", "supabase.js"))).digest("hex");
if (actualSha !== EXPECTED_SHA256) {
  console.error(`vendor/supabase.js content does not match its pinned hash.
  expected: ${EXPECTED_SHA256}
  actual:   ${actualSha}
If you re-vendored the client on purpose, update EXPECTED_SHA256 in this
script in the same commit and explain the change. If you did not, do not
merge this - the bundle has been modified.`);
  process.exit(1);
}

console.log(`OK: vendor/supabase.js matches the declared @supabase/supabase-js@${declared} and its pinned sha256.`);
