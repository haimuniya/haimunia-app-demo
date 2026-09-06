# Dependency Audit — supply chain, vulnerabilities, SBOM

Scope: root `package.json` / `package-lock.json` / `node_modules`, `scripts/browser-check/` (separate npm project), `vendor/supabase.js` (hand-vendored `@supabase/supabase-js` bundle loaded directly by `index.html`).

Audited 2026-09-06 against the installed trees in this checkout.

## Headline

**Zero known vulnerabilities in either project.** The dependency surface is unusually small for an app of this size, deliberately so: the app itself ships with no build step and no runtime npm dependency at all. npm exists here only for the test suite.

---

## 1. `npm audit` results

Both commands were actually executed. Raw `metadata.vulnerabilities` from `npm audit --json`:

### Root (`/`)

| Severity | Count |
| --- | --- |
| critical | 0 |
| high | 0 |
| moderate | 0 |
| low | 0 |
| info | 0 |
| **total** | **0** |

Dependency counts: 16 prod, 60 dev, 0 optional, 75 total.

### `scripts/browser-check/`

| Severity | Count |
| --- | --- |
| critical | 0 |
| high | 0 |
| moderate | 0 |
| low | 0 |
| info | 0 |
| **total** | **0** |

Dependency counts: 3 prod, 0 dev, 1 optional, 3 total.

Caveat: `npm audit` is only as current as the registry advisory database at the moment it ran, and it says nothing about `vendor/supabase.js` (§3) or about the Deno imports inside `supabase/functions/` (§6), neither of which npm can see.

---

## 2. Root `package.json` — declared dependencies

```json
"engines":         { "node": ">=22" },
"dependencies":    { "@supabase/supabase-js": "^2.57.4" },
"devDependencies": { "fake-indexeddb": "^6.0.0", "jsdom": "^25.0.0" }
```

Three direct declarations, all **caret ranges — none pinned exactly**.

| Package | Declared | Installed | Drift within range |
| --- | --- | --- | --- |
| `@supabase/supabase-js` | `^2.57.4` | 2.57.4 | none |
| `fake-indexeddb` | `^6.0.0` | 6.2.5 | 2 minors ahead |
| `jsdom` | `^25.0.0` | 25.0.1 | 1 patch ahead |

**Assessment: acceptable, because `package-lock.json` (lockfileVersion 3) is committed and CI runs `npm ci`, not `npm install`.** `npm ci` installs the lock exactly and errors if the lock disagrees with `package.json`, so the caret ranges never float in CI or in a fresh clone. The ranges only matter to a developer who runs bare `npm install` and regenerates the lock.

One thing the caret on `@supabase/supabase-js` *does* affect is §3: a developer's `npm install` can silently move the npm copy to 2.58.x while `vendor/supabase.js` — the copy production actually loads — stays at 2.57.4. That is the drift the pre-commit hook exists to catch (§5).

`"private": true` is set on both projects, so neither can be accidentally published to npm.

`scripts/browser-check/package.json` declares one dependency, `playwright: ^1.48.0`, installed at 1.62.1 (14 minors ahead of the floor). It also has a committed `package-lock.json` and CI runs `npm ci` there too.

---

## 3. Vendored Supabase client — `vendor/supabase.js`

`index.html` loads `vendor/supabase.js` directly. This is a hand-copied minified build of `@supabase/supabase-js`, checked in so that production can stay build-free on static hosting. It is therefore **the client that actually runs in every user's browser** — the npm copy under `node_modules` is only ever used by the Node test suite.

Two independent checks were run:

**(a) The repo's own checker** — `node scripts/check-vendored-supabase-version.mjs`:

```
OK: vendor/supabase.js matches the declared @supabase/supabase-js@2.57.4.
```

**(b) Independent grep of the embedded version string** in `vendor/supabase.js`:

```
version="2.57.4
```

against `package.json`'s `^2.57.4` and the installed `node_modules/@supabase/supabase-js/package.json` → `2.57.4`.

**All three agree. No drift. This is a genuine pass, and it is the single most important dependency check in the repo** — two client versions in play would mean the browser running a build with different security fixes than the one the tests exercise and the one `npm audit` scores.

Files: `vendor/supabase.js` (131,061 bytes), `vendor/supabase.LICENSE` (1,065 bytes, MIT — present and correct for redistribution).

### The residual risk that remains

The checker verifies the *version string*, not the *bytes*. It cannot tell you that `vendor/supabase.js` is an unmodified build of 2.57.4 rather than a tampered or locally patched one. Both files are dated Aug 26 and have not changed since.

Recommendation: add an integrity check to the same script — compute a SHA-256 of the vendored file and compare against a checksum recorded when it was vendored, or (stronger) regenerate the bundle from `node_modules` in CI and assert byte-equality. This closes the gap between "claims to be 2.57.4" and "is 2.57.4". Low effort, and it makes `vendor/supabase.js` auditable rather than trusted.

Second recommendation: `@supabase/supabase-js` 2.57.4 was vendored on 2026-08-26. There is **no automated signal** that tells anyone when a security release lands upstream — no Dependabot, no Renovate, no scheduled `npm audit` in CI (§7). The vendored copy will sit at 2.57.4 until a human happens to check. Given that this is the file every user's browser executes, that is the most consequential process gap in this document.

---

## 4. SBOM — installed dependencies

Read from `node_modules/*/package.json` and `node_modules/@*/*/package.json`. Name | version | license.

### Root project — 71 installed packages

| Package | Version | License |
| --- | --- | --- |
| @asamuzakjp/css-color | 3.2.0 | MIT |
| @csstools/color-helpers | 5.1.0 | MIT-0 |
| @csstools/css-calc | 2.1.4 | MIT |
| @csstools/css-color-parser | 3.1.0 | MIT |
| @csstools/css-parser-algorithms | 3.0.5 | MIT |
| @csstools/css-tokenizer | 3.0.4 | MIT |
| @supabase/auth-js | 2.71.1 | MIT |
| @supabase/functions-js | 2.4.6 | MIT |
| @supabase/node-fetch | 2.6.15 | MIT |
| @supabase/postgrest-js | 1.21.4 | MIT |
| @supabase/realtime-js | 2.15.5 | MIT |
| @supabase/storage-js | 2.12.1 | MIT |
| @supabase/supabase-js | 2.57.4 | MIT |
| @types/node | 26.3.0 | MIT |
| @types/phoenix | 1.6.7 | MIT |
| @types/ws | 8.18.1 | MIT |
| agent-base | 7.1.4 | MIT |
| asynckit | 0.4.0 | MIT |
| call-bind-apply-helpers | 1.0.2 | MIT |
| combined-stream | 1.0.8 | MIT |
| cssstyle | 4.6.0 | MIT |
| data-urls | 5.0.0 | MIT |
| debug | 4.4.3 | MIT |
| decimal.js | 10.6.0 | MIT |
| delayed-stream | 1.0.0 | MIT |
| dunder-proto | 1.0.1 | MIT |
| entities | 6.0.1 | BSD-2-Clause |
| es-define-property | 1.0.1 | MIT |
| es-errors | 1.3.0 | MIT |
| es-object-atoms | 1.1.2 | MIT |
| es-set-tostringtag | 2.1.0 | MIT |
| fake-indexeddb | 6.2.5 | Apache-2.0 |
| form-data | 4.0.6 | MIT |
| function-bind | 1.1.2 | MIT |
| get-intrinsic | 1.3.0 | MIT |
| get-proto | 1.0.1 | MIT |
| gopd | 1.2.0 | MIT |
| has-symbols | 1.1.0 | MIT |
| has-tostringtag | 1.0.2 | MIT |
| hasown | 2.0.4 | MIT |
| html-encoding-sniffer | 4.0.0 | MIT |
| http-proxy-agent | 7.0.2 | MIT |
| https-proxy-agent | 7.0.6 | MIT |
| iconv-lite | 0.6.3 | MIT |
| is-potential-custom-element-name | 1.0.1 | MIT |
| jsdom | 25.0.1 | MIT |
| lru-cache | 10.4.3 | ISC |
| math-intrinsics | 1.1.0 | MIT |
| mime-db | 1.52.0 | MIT |
| mime-types | 2.1.35 | MIT |
| ms | 2.1.3 | MIT |
| nwsapi | 2.2.24 | MIT |
| parse5 | 7.3.0 | MIT |
| punycode | 2.3.1 | MIT |
| rrweb-cssom | 0.7.1 | MIT |
| safer-buffer | 2.1.2 | MIT |
| saxes | 6.0.0 | ISC |
| symbol-tree | 3.2.4 | MIT |
| tldts | 6.1.86 | MIT |
| tldts-core | 6.1.86 | MIT |
| tough-cookie | 5.1.2 | BSD-3-Clause |
| tr46 | 5.1.1 | MIT |
| undici-types | 8.3.0 | MIT |
| w3c-xmlserializer | 5.0.0 | MIT |
| webidl-conversions | 7.0.0 | BSD-2-Clause |
| whatwg-encoding | 3.1.1 | MIT |
| whatwg-mimetype | 4.0.0 | MIT |
| whatwg-url | 14.2.0 | MIT |
| ws | 8.21.3 | MIT |
| xml-name-validator | 5.0.0 | Apache-2.0 |
| xmlchars | 2.2.0 | MIT |

### `scripts/browser-check/` — 2 installed packages

| Package | Version | License |
| --- | --- | --- |
| playwright | 1.62.1 | Apache-2.0 |
| playwright-core | 1.62.1 | Apache-2.0 |

### License summary

**Every dependency is permissively licensed.** Distribution: MIT (~60), Apache-2.0 (4: `fake-indexeddb`, `xml-name-validator`, `playwright`, `playwright-core`), BSD-2-Clause (2: `entities`, `webidl-conversions`), BSD-3-Clause (1: `tough-cookie`), ISC (2: `lru-cache`, `saxes`), MIT-0 (1: `@csstools/color-helpers`).

**No copyleft (GPL/LGPL/AGPL), no SSPL, no BSL, no unlicensed/UNKNOWN packages.** Nothing here creates a redistribution obligation beyond attribution, and only one dependency is actually redistributed to end users — `@supabase/supabase-js` via `vendor/supabase.js`, whose MIT license text is correctly checked in at `vendor/supabase.LICENSE`.

### Transitive depth

The 71-package root tree comes almost entirely from `jsdom` (dev-only, ~55 packages of CSS/HTML/URL parsing) and `@supabase/supabase-js` (6 first-party sub-packages plus `ws`, `@types/*`). Only the Supabase subtree reaches production, and even then only via the vendored bundle. `jsdom`, `fake-indexeddb` and `playwright` never touch a user.

---

## 5. Install-script supply-chain surface

Scanned every installed `package.json` in both trees for `preinstall`, `install` and `postinstall`:

```
grep -o '"(post|pre)?install"…' node_modules/*/package.json node_modules/@*/*/package.json \
     scripts/browser-check/node_modules/*/package.json
→ (no matches)
```

**Zero packages in either tree run an install script.** Across 73 installed packages, nothing executes arbitrary code at install time. This is the cleanest possible result for this check and materially reduces exposure to the most common npm supply-chain attack (a compromised release adding a `postinstall` that exfiltrates env vars or CI tokens).

Worth noting explicitly since it is counter-intuitive: **`playwright` does not use a postinstall hook.** Browser binaries are fetched by the separate, explicit `npx playwright install chromium` step, which both `scripts/browser-check/package.json`'s `setup` script and the CI workflow invoke by hand. That is the safer design and it is why the browser-check tree scores clean.

Consequence: `npm ci --ignore-scripts` would work in both projects with no loss of function. Adopting it in CI would make the property permanent rather than incidental — right now a future dependency that *does* add a postinstall would be executed silently.

---

## 6. Dependencies npm cannot see

Two production dependency surfaces sit outside npm's view and outside both `npm audit` runs:

1. **`vendor/supabase.js`** — covered in §3. Not scanned by `npm audit`; version-checked but not integrity-checked.
2. **Deno imports in `supabase/functions/`** — the three Edge Functions (`recap_weekly`, `purge_abandoned_profiles`, `admin_reset_password`) run on Supabase's Deno runtime and import from URLs, not from `node_modules`. There is no lockfile (`deno.lock`) checked in for them and no `deno` in CI, so their transitive dependency versions are resolved at deploy time and are **unpinned and unaudited**. Recommend adding a `deno.lock` and, if the functions grow, a `deno check` step.

---

## 7. Process gaps

| Gap | Impact |
| --- | --- |
| **No Dependabot / Renovate** — `.github/` contains only `workflows/test.yml`, no `dependabot.yml` | Nothing notifies anyone of a security release. Combined with §3, the browser-facing Supabase client can sit on a vulnerable version indefinitely. **Highest-value fix in this document**, and it is a ~10-line config file. |
| **No `npm audit` step in CI** | The clean result above is a point-in-time snapshot from this checkout, not an enforced gate. A vulnerable transitive dependency introduced tomorrow would not fail any build. Add `npm audit --audit-level=high` to both jobs. |
| **No `--ignore-scripts` in CI** | §5 passes today by luck of the current tree, not by policy. |
| **No integrity pin on `vendor/supabase.js`** | See §3. |
| **No `deno.lock` for Edge Functions** | See §6. |
| **Pre-commit hook is opt-in and inactive in this clone** | `git config core.hooksPath` returns nothing here, so `.githooks/pre-commit` — which is what runs `check-vendored-supabase-version.mjs` — is **not currently running**. The vendor-drift check exists but is not enforced anywhere: not in the hook (opt-in, off) and not in CI (no such step). See INFRASTRUCTURE_AUDIT.md §4. Adding `npm run check-vendor-version` and `npm run check-version` to the CI workflow would make both checks real regardless of local setup. |

---

## 8. Summary

| Metric | Root | browser-check |
| --- | --- | --- |
| Vulnerabilities (crit/high/mod/low) | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| Direct dependencies | 3 (1 prod, 2 dev) | 1 |
| Installed packages | 71 | 2 |
| Packages with install scripts | 0 | 0 |
| Non-permissive licenses | 0 | 0 |
| Lockfile committed | yes (v3) | yes |
| CI installs with `npm ci` | yes | yes |

The dependency posture is genuinely strong — small surface, no install scripts, permissive licenses throughout, lockfiles committed, `npm ci` in CI, and the one hand-vendored artifact has a real version check that currently passes. The weaknesses are all *process* rather than *state*: nothing watches for new advisories, nothing enforces the vendor check, and nothing verifies the vendored bytes.
