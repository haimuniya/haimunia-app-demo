// iOS Safari evicts a site's IndexedDB after ~7 days without a visit, and
// until now the only path to cloud backup ran through the Community tab's
// full invite-code join flow - so anyone who never touched Community had
// zero protection. This adds a second, independent path: a backup-only
// anonymous session that starts itself the first time a member actually
// saves something (not on page load - an empty visit creating a cloud
// account has no upside), auto-enables forward sync with no click, and
// stays entirely decoupled from posting/feed/profile/invite codes. See
// COMMUNITY_SETUP.md's "Offline synchronization" section and PRIVACY.md.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const appJs = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const privacyMd = fs.readFileSync(new URL("../PRIVACY.md", import.meta.url), "utf8");

test("maybeAutoStartBackup only fires when there's no session yet and the member hasn't opted out, and is wired to the sync-needed event (not page load)", () => {
  assert.match(cloudJs, /function maybeAutoStartBackup\(\) \{\s*\n\s*if \(!client \|\| state\.user \|\| backupOptedOut\(\)\) return;\s*\n\s*ensureAnonymousSession\(\);/);
  assert.match(cloudJs, /window\.addEventListener\("haimunia-sync-needed", \(\) => \{ maybeAutoStartBackup\(\); flushOutbox\(\); pingActivity\(\); \}\);/);
});

test("enableSyncIfAllowed only turns sync on, never off, and respects the opt-out", () => {
  const fn = cloudJs.slice(cloudJs.indexOf("function enableSyncIfAllowed"), cloudJs.indexOf("function maybeAutoStartBackup"));
  assert.match(fn, /if \(state\.syncEnabled \|\| backupOptedOut\(\)\) return;/);
  assert.match(fn, /state\.syncEnabled = true;/);
});

test("enableSyncIfAllowed runs on both session-hydration paths (refreshSession and onAuthStateChange), not just one", () => {
  const refreshSessionBody = cloudJs.slice(cloudJs.indexOf("async function refreshSession"), cloudJs.indexOf("async function loadProfile()"));
  assert.match(refreshSessionBody, /enableSyncIfAllowed\(\);/);
  const authChangeBody = cloudJs.slice(cloudJs.indexOf('client.auth.onAuthStateChange'), cloudJs.indexOf('refreshSession();'));
  assert.match(authChangeBody, /enableSyncIfAllowed\(\);/);
});

test("backup-only bootstrap never touches invite codes, redemption, or profiles - purely private_records via the outbox", () => {
  const start = cloudJs.indexOf("function maybeAutoStartBackup");
  const fn = cloudJs.slice(start, cloudJs.indexOf("\n  }\n", start) + 5);
  assert.doesNotMatch(fn, /redeem_invite_code|invite_redemptions|profiles/);
});

test("Settings exposes an on/off toggle for automatic backup, fully independent of joining Community", () => {
  assert.match(cloudJs, /window\.renderBackupSettingsPanel = function/);
  const fn = cloudJs.slice(cloudJs.indexOf("window.renderBackupSettingsPanel = function"), cloudJs.indexOf("window.renderBackupSettingsPanel = function") + 2000);
  assert.match(fn, /data-community-action="backup-enable"/);
  assert.match(fn, /data-community-action="backup-optout"/);
  // Never an invite code or a feed/profile reference - this panel must
  // stand on its own, never look like the same action as joining Community.
  assert.doesNotMatch(fn, /קוד הזמנה|invite/);
});

test("backup-enable clears the opt-out and starts or resumes sync; backup-optout remembers the choice and stops future syncing", () => {
  assert.match(cloudJs, /action === "backup-enable"\) \{\s*\n\s*localStorage\.removeItem\(BACKUP_OPTOUT_KEY\);/);
  assert.match(cloudJs, /action === "backup-optout"\) \{\s*\n\s*localStorage\.setItem\(BACKUP_OPTOUT_KEY, "1"\);/);
});

test("the anonymous backup session and the Community join flow use the same underlying session without duplicating it", () => {
  // The Community tab's login-or-start gate has to keep showing for a
  // backup-only anonymous session (is_anonymous, signupStarted still
  // false) rather than skipping straight past it as if start-signup had
  // been clicked.
  assert.match(cloudJs, /if \(!state\.user \|\| \(state\.user\.is_anonymous && !state\.signupStarted\)\) \{/);
});

test("setCredentials (the anonymous-to-permanent-account upgrade) is reusable from the standalone backupCredentials form in Settings, not only the Community onboarding gate", () => {
  assert.match(cloudJs, /event\.target\.id === "backupCredentials"\) \{ event\.preventDefault\(\); setCredentials\(event\.target\); \}/);
});

test("navigator.storage.persist() is requested at boot, best-effort", () => {
  assert.match(appJs, /navigator\.storage && navigator\.storage\.persist/);
  assert.match(appJs, /navigator\.storage\.persist\(\)\.catch/);
});

test("an iOS-specific install banner exists, independent of the Chrome/Android beforeinstallprompt banner", () => {
  assert.match(appJs, /function isIOSDevice\(\)/);
  assert.match(appJs, /function maybeShowIOSInstallBanner\(\)/);
  assert.match(appJs, /if \(!isIOSDevice\(\) \|\| isStandalone\(\)\) return;/);
});

test("the stale-local-export reminder threshold tightens for anyone not already covered by automatic cloud sync", () => {
  const fn = appJs.slice(appJs.indexOf("function renderSettingsBody"), appJs.indexOf("function renderSettingsBody") + 1200);
  assert.match(fn, /window\.cloudSyncActive/);
  assert.match(fn, /cloudCovered \? 30 : 5/);
});

test("PRIVACY.md discloses automatic private backup as separate from joining the community, and reversible", () => {
  assert.match(privacyMd, /backed up automatically and privately/);
  assert.match(privacyMd, /turned off at any time/);
});
