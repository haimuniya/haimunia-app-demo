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

test("maybeAutoStartBackup only fires when there's no session yet, the member hasn't opted out, and consent has actually been asked - and is wired to the sync-needed event (not page load)", () => {
  // The first two guards are unchanged. The third landed with the first-run
  // sequence (c4cd505): consent is asked AFTER the member's first saved
  // entry, but this function fires ON that same first write - so without the
  // guard an anonymous account already existed by the time the card appeared,
  // and "לא עכשיו" was answering a question the app had already answered for
  // them. The screen would promise something the code broke, which is the
  // defect class this audit kept finding (see a42f9d1's account-security
  // screen, which claimed browse-only access the database refused).
  //
  // Asserted as three separate guards rather than one whitespace-exact block,
  // because the previous single-regex form pinned the function's LAYOUT and
  // broke on a comment - which tells you nothing about behaviour. Each of
  // these is a real precondition and each can now fail independently.
  const fn = cloudJs.match(/function maybeAutoStartBackup\(\) \{[\s\S]*?\n  \}/);
  assert.ok(fn, "maybeAutoStartBackup must exist");
  assert.match(fn[0], /if \(!client \|\| state\.user \|\| backupOptedOut\(\)\) return;/,
    "still refuses without a client, with a session, or after an opt-out");
  assert.match(fn[0], /window\.haimuniaBackupConsentPending\(\)\) return;/,
    "and must not create an anonymous account while the consent card is still unanswered");
  assert.match(fn[0], /ensureAnonymousSession\(\);/, "otherwise it starts the session");
  // "not asked yet" and "asked and declined" are deliberately different
  // states: collapsing them would make a member who has never seen the card
  // indistinguishable from one who said no.
  assert.match(appJs, /window\.haimuniaBackupConsentPending = function \(\) \{ return backupConsent === null; \};/,
    "pending means unanswered, not declined");
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

// PRIVACY.md became bilingual (Hebrew first, English second) on 2026-09-06,
// so the English sentence this test used to grep for was rewritten and the
// line wrapping moved. The GUARANTEE is unchanged and is what is asserted
// below - in BOTH languages, because the Hebrew half is the text members are
// actually given and an English-only assertion would let the Hebrew half
// silently lose the disclosure:
//
//   1. the backup is automatic and private,
//   2. it begins at the first saved workout (the real point of collection),
//   3. it is separate from joining the community, and
//   4. it is reversible from Settings.
//
// Matching is done on a whitespace-normalised copy so a reflow of the source
// paragraphs can never fail this the way it just did; the phrases themselves
// are still required verbatim.
const privacyText = privacyMd.replace(/\s+/g, " ");

test("PRIVACY.md discloses automatic private backup - private, from the first save, separate from joining the community, and reversible - in Hebrew", () => {
  assert.match(privacyText, /גיבוי אוטומטי ופרטי לענן/);
  assert.match(privacyText, /מהאימון הראשון שאתם שומרים/);
  assert.match(privacyText, /נפרד לחלוטין מהקהילה/);
  assert.match(privacyText, /אפשר לכבות בכל רגע/);
});

test("PRIVACY.md discloses automatic private backup - private, from the first save, separate from joining the community, and reversible - in English", () => {
  assert.match(privacyText, /Automatic private cloud backup/);
  assert.match(privacyText, /From the first workout you save, the app opens a cloud account for you/);
  assert.match(privacyText, /entirely separate from the community/);
  assert.match(privacyText, /turn it off at any time in Settings/);
});

// The 30-day rule is the other half of an honest backup disclosure: a
// backup-only anonymous account (no invite redeemed, no username/password) is
// collected by purge_abandoned_profiles() 30 days after it was opened, taking
// the private_records rows with it through the auth.users cascade. A policy
// that advertises automatic backup without this reads as long-term storage.
test("PRIVACY.md warns that a backup-only account, and everything backed up to it, is deleted after 30 days", () => {
  assert.match(privacyText, /חשבון גיבוי בלבד נמחק אחרי 30 יום/);
  assert.match(privacyText, /a backup-only account is deleted after 30 days/i);
  assert.match(privacyText, /set a username and password/);
});
