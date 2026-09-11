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
  // false, and no redemption on file either) rather than skipping straight
  // past it as if start-signup had been clicked. Live bug hunt
  // (2026-09-11) widened the condition to also fall through for a
  // CONFIRMED server-side redemption (state.redemption) - a backup-only
  // session has none, so it is unaffected and still hits this same gate.
  assert.match(cloudJs, /if \(!state\.user \|\| \(state\.user\.is_anonymous && !state\.signupStarted && !state\.redemption\)\) \{/);
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

// THE 2026-09-08 CONSENT CORRECTION. The four guarantees above are unchanged
// in substance, but the SECOND one had to be re-stated: c4cd505 added the S5
// backup-consent card and 8136133 made maybeAutoStartBackup() return early
// while window.haimuniaBackupConsentPending() is true, so on a device that is
// asked, NO anonymous account exists until the member answers. "From the
// first workout you save, the app opens a cloud account for you" was true of
// every member when it was written and is now true only of the grandfathered
// half (app.js:5831). The section headings changed with it, which is why the
// verbatim strings below moved.
test("PRIVACY.md discloses private backup - private, at the first save, separate from joining the community, and reversible - in Hebrew", () => {
  assert.match(privacyText, /גיבוי פרטי לענן — ומתי הוא מתחיל בלי לשאול/);
  assert.match(privacyText, /הגיבוי לענן מתחיל באימון הראשון שאתם שומרים/);
  assert.match(privacyText, /נפרד לחלוטין מהקהילה/);
  assert.match(privacyText, /אפשר לכבות או להפעיל בכל רגע בהגדרות/);
});

test("PRIVACY.md discloses private backup - private, at the first save, separate from joining the community, and reversible - in English", () => {
  assert.match(privacyText, /Private cloud backup — and when it starts without asking/);
  assert.match(privacyText, /Cloud backup starts at the first workout you save/);
  assert.match(privacyText, /entirely separate from the community/);
  assert.match(privacyText, /turn it off or on at any time in Settings/);
});

// The interlock, stated as the member experiences it. This is the sentence
// 8136133's guard makes true, and it is the one a member is entitled to rely
// on: answering the card is what opens the account, not saving the workout.
//
// SCOPED TO THE BACKUP ACCOUNT, and that scope is load-bearing rather than
// hedging. refreshSession()/onAuthStateChange call enableSyncIfAllowed() for
// ANY session, so a member who redeemed an invite before ever logging a set
// already has an account and already syncs by the time the card appears -
// backupConsent is still null on that device, so the card is still shown. An
// unqualified "no account is opened until you answer" would be false for
// exactly that member, which is the defect class being closed here, so the
// policy states the exception and these assertions require it.
test("PRIVACY.md promises that on a device that asks, no BACKUP account is opened and nothing is uploaded before the answer", () => {
  assert.match(privacyText, /עד שאתם עונים, האפליקציה לא פותחת עבורכם חשבון גיבוי ולא מעלה שום רשומה/);
  assert.match(privacyText, /Until you answer, the app opens no backup account for you and uploads no record/);
});

test("PRIVACY.md names the one case where an account already exists when the card appears - joining the community first", () => {
  assert.match(privacyText, /אם כבר נכנסתם לקהילה עם קוד הזמנה, חשבון כבר נפתח לכם באותה כניסה/);
  assert.match(privacyText, /if you have already joined the community with an invite code, an account was opened for you at that step/i);
});

// And the guard that matters most: the retired claim is a sentence somebody
// could plausibly restore while "simplifying" this section, and restoring it
// would misdescribe the collection point AND the legal basis built on it.
test("the retired 'without asking first' claim cannot return to PRIVACY.md in either language", () => {
  assert.doesNotMatch(privacyText, /אוטומטית, בלי לשאול אתכם קודם/);
  assert.doesNotMatch(privacyText, /זה קורה אוטומטית ובלי לשאול אתכם/);
  assert.doesNotMatch(privacyText, /אין כרגע מסך שמבקש את אישורכם/);
  assert.doesNotMatch(privacyText, /automatically, without asking first/i);
  assert.doesNotMatch(privacyText, /This happens automatically and without asking you/i);
  assert.doesNotMatch(privacyText, /there is currently no screen that asks for your agreement/i);
});

// THIS TEST USED TO ASSERT A BUG, and its own comment argued the bug was a
// feature. Until 202609070001, purge_abandoned_profiles() deleted a
// backup-only anonymous account 30 days after it was OPENED, and
// private_records cascades from auth.users - so a member who logged workouts
// for a month and never joined the community lost every entry they had, from
// their only server-side copy, silently. The policy described that as a
// retention limit and this test held the description in place, which is how a
// green suite came to certify data loss.
//
// 202609070001 is now the source of truth and the rule is different in kind,
// not in degree: an account holding ANY training data is removed from that
// job's population outright, under any window (account_holds_training_data(),
// which counts private_records by presence - soft-deleted rows included - plus
// any attendance_log row), and the clock is last activity rather than account
// age. What is still collected is a shell that was opened for backup and never
// had anything backed up to it.
//
// So the disclosure this suite has to hold is now TWO facts, not one, and the
// second is the one that matters to a member: the window exists, AND a log is
// never inside it. The doesNotMatch guard is the point of the test - the old
// promise is a sentence somebody could plausibly reintroduce while "restoring
// the retention limit", and it must not come back without this failing.
test("PRIVACY.md scopes the 30-day rule to an EMPTY backup-only account and promises a saved workout is never deleted by it", () => {
  assert.match(privacyText, /חשבון גיבוי בלבד וריק נסגר אחרי 30 יום/);
  assert.match(privacyText, /אם שמרתם אליו ולו אימון אחד — הוא לא נמחק/);
  assert.match(privacyText, /an empty backup-only account is closed after 30 days/i);
  assert.match(privacyText, /If you have saved even one workout to it, it is not deleted/);
  assert.match(privacyText, /set a username and password/);
});

test("the retired promise of data loss cannot return to PRIVACY.md in either language", () => {
  // The exact wording that shipped, plus the generalisation of it: any
  // sentence saying a backup-only account (unqualified) is deleted, or that
  // what was backed up goes with it.
  assert.doesNotMatch(privacyText, /חשבון גיבוי בלבד נמחק אחרי 30 יום/);
  assert.doesNotMatch(privacyText, /יחד עם כל מה שגובה אליו/);
  assert.doesNotMatch(privacyText, /רשת ביטחון קצרת טווח/);
  assert.doesNotMatch(privacyText, /a backup-only account is deleted after 30 days/i);
  assert.doesNotMatch(privacyText, /along with everything backed up to it/i);
  assert.doesNotMatch(privacyText, /short-term safety net/i);
});

// The loss that IS real, and is the whole reason the paragraph still exists:
// an anonymous account has no username, no password and no email, so a lost
// or wiped device is unrecoverable. Correcting the retention claim must not
// quietly delete this one - it is the only warning a member gets before the
// only copy of their log becomes unreachable.
test("PRIVACY.md still states the unrecoverability of an anonymous account, in both languages", () => {
  assert.match(privacyText, /אם תאבדו את המכשיר או תמחקו את נתוני הדפדפן/);
  assert.match(privacyText, /אף אחד — גם לא אנחנו — לא יוכל לשחזר אותו עבורכם/);
  assert.match(privacyText, /if you lose this device or clear its data, nobody — including us — can restore it to you/i);
});
