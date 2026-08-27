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
const match = vendorSrc.match(/exports?\.version=void 0,\s*t\.version="([0-9.]+)"/) || vendorSrc.match(/t\.version="([0-9.]+)"/);
if (!match) {
  console.error("Could not find the @supabase/supabase-js version marker in vendor/supabase.js - the bundle's minification pattern may have changed; update this script's regex.");
  process.exit(1);
}
const vendored = match[1];

if (vendored !== declared) {
  console.error(`Mismatch: package.json declares @supabase/supabase-js@${declared}, but vendor/supabase.js was built from ${vendored}. Re-vendor the client or update package.json.`);
  process.exit(1);
}
console.log(`OK: vendor/supabase.js matches the declared @supabase/supabase-js@${declared}.`);
