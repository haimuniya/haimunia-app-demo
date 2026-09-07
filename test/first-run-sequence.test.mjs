// Design spec §1 — the first-run sequence.
//
// WHAT THIS FILE IS FOR. The audit's top-ranked friction finding was that a
// new member's first load stacked four surfaces that each wanted something
// before the app had given them anything: the welcome sheet (name AND
// box-start date), the five-screen explainer as a gate, a celebration, and
// the install banner — with two consecutive primary buttons carrying the
// identical string בואו נתחיל. 8afbc57 fixed the STACKING (one modal queue).
// This is the SEQUENCE, and these are the assertions that keep it sequenced.
//
// Each test below pins one of the five deferrals §1.2 makes, and every one of
// them is a claim about behaviour a member can feel, not about markup:
// how many things are in front of them, what the app asks for and when, and
// whether an answer they gave is remembered.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp } from "./helpers/boot.mjs";

function openOverlayIds(window) {
  return [...window.document.querySelectorAll(".modal-overlay.open")].map((el) => el.id);
}
function installBannerShown(window) {
  return window.document.getElementById("installBanner").style.display === "block";
}
async function logASet(window, weight = 60) {
  window.applyFieldValue("step", "weight", weight);
  window.applyFieldValue("step", "reps", 5);
  window.applyFieldValue("step", "sets", 1);
  await window.saveSet();
}

// ---- S1: the welcome sheet is the only thing on the first screen --------

test("first load puts exactly ONE surface in front of a new member", async () => {
  const window = await bootApp();
  assert.deepEqual(openOverlayIds(window), ["welcomeOverlay"],
    "the welcome sheet must be alone — the whole finding was four surfaces competing before a single rep");
  assert.equal(installBannerShown(window), false,
    "the install banner must not be behind the welcome sheet on a first load");
});

test("no two consecutive primary buttons in the first run carry the same label", async () => {
  const window = await bootApp();
  const welcomePrimary = window.document.getElementById("welcomeSaveLabel").textContent.trim();
  window.openOnboarding();
  const explainerPrimary = window.document
    .querySelector("#onboardingOverlay [data-action='close-onboarding'].save-btn").textContent.trim();

  assert.equal(welcomePrimary, "יאללה, נתחיל");
  assert.equal(explainerPrimary, "הבנתי, קדימה");
  // The rule, not just the two current strings: tapping two identical
  // primaries in a row is why the flow read as a screen that had not
  // advanced. If either label is ever retuned, they still may not match.
  assert.notEqual(welcomePrimary, explainerPrimary);
  assert.ok(welcomePrimary !== "בואו נתחיל" && explainerPrimary !== "בואו נתחיל",
    "בואו נתחיל was the duplicated string; neither button may go back to it");
});

test("the welcome sheet asks for a name and nothing else; the box-start date moves to the profile editor", async () => {
  const window = await bootApp();
  const dateInput = window.document.getElementById("welcomeBoxStartInput");
  const dateLabel = window.document.getElementById("welcomeBoxStartLabel");

  assert.equal(dateInput.style.display, "none",
    "asking a member who has never trained for their box-start date is what produced the hollow-praise finding");
  assert.equal(dateLabel.style.display, "none");

  // Same sheet, edit mode — this IS the profile editor reached from Settings
  // and from the achievements screen's prompt card, and there the field is
  // the entire point of the visit.
  window.closeWelcomeModal();
  window.openWelcomeModal(true);
  assert.notEqual(window.document.getElementById("welcomeBoxStartInput").style.display, "none");
  assert.notEqual(window.document.getElementById("welcomeBoxStartLabel").style.display, "none");
});

test("dismissing the welcome sheet opens nothing at all — the explainer is no longer a gate", async () => {
  const window = await bootApp();
  window.saveWelcomeForm("רונית");
  assert.deepEqual(openOverlayIds(window), [],
    "the explainer used to open here, as a second full-screen gate; nothing may stand between the welcome sheet and the logging screen");
});

test("skipping the name is also a clear path to the logging screen", async () => {
  const window = await bootApp();
  window.saveWelcomeForm(""); // the דילוג path
  assert.deepEqual(openOverlayIds(window), []);
  assert.equal(installBannerShown(window), false);
});

// ---- S2: the explainer, demoted from a gate to a pull ------------------

test("the explainer is offered as a card on the logging screen, and survives as a permanent Settings row", async () => {
  const window = await bootApp();
  window.saveWelcomeForm("רונית");

  const logTab = window.renderLogTab();
  assert.match(logTab, /data-action="open-onboarding"/,
    "a fresh member must be able to reach the explainer without hunting for it");
  assert.match(logTab, /סיור קצר במסכים/);

  // Below the picker, not above it: the app's own job stays the first thing
  // on the screen. (Deliberate departure from §1.2 S2's wording — see the
  // comment on renderTourCard().)
  assert.ok(logTab.indexOf('data-action="open-picker"') < logTab.indexOf('data-action="open-onboarding"'),
    "the tour card must not push the exercise picker down the first screen a member ever sees");

  assert.match(window.renderSettingsBody(), /data-action="open-onboarding"/,
    "its defect was showing exactly once with no way back — Settings is the way back");
});

test("the tour card retires itself once it has been taken", async () => {
  const window = await bootApp();
  window.saveWelcomeForm("רונית");
  assert.equal(window.shouldShowTourCard(), true);

  window.openOnboarding();
  window.closeOnboarding();
  assert.equal(window.shouldShowTourCard(), false);
  assert.doesNotMatch(window.renderLogTab(), /סיור קצר במסכים/);
  // ...but never becomes unreachable.
  assert.match(window.renderSettingsBody(), /data-action="open-onboarding"/);
});

test("the tour card also retires for a member who clearly does not need it", async () => {
  const window = await bootApp();
  window.saveWelcomeForm("רונית");
  await window.addMovement("Tour Card Squat", "Squat");

  await logASet(window, 60);
  assert.equal(window.shouldShowTourCard(), true, "one entry is not evidence of anything");
  await logASet(window, 62.5);
  await logASet(window, 65);
  assert.equal(window.shouldShowTourCard(), false,
    "three logged entries is a member who has found their way around; stop offering the tour");
});

// ---- S4: the first entry gets an arrival, not an award -----------------

test("the first-ever logged entry is answered as arrival, with no medal and no שיא אישי", async () => {
  const window = await bootApp();
  window.saveWelcomeForm("רונית");
  await window.addMovement("Arrival Squat", "Squat");
  await logASet(window, 40);

  const overlay = window.document.getElementById("celebrationOverlay");
  assert.ok(overlay.classList.contains("open"),
    "before this, the single most important moment in the app produced no response at all");
  assert.equal(window.document.getElementById("celebrationTitle").textContent, "הרישום הראשון שלך נשמר");
  // The load-bearing half. With no history every set is trivially a record,
  // and a card that says שיא אישי on day one is exactly how a member learns
  // the phrase means nothing — which is what the beginner persona concluded.
  assert.doesNotMatch(overlay.textContent, /שיא אישי/);
  assert.equal(window.document.getElementById("celebrationMedals").children.length, 0,
    "no medal on entry one");
  assert.deepEqual(openOverlayIds(window), ["celebrationOverlay"], "still one surface at a time");
});

test("the arrival card happens once in a member's life, not once per empty log", async () => {
  const window = await bootApp();
  window.saveWelcomeForm("רונית");
  await window.addMovement("Once Squat", "Squat");

  await logASet(window, 40);
  window.closeCelebration();

  await logASet(window, 42.5);
  const overlay = window.document.getElementById("celebrationOverlay");
  assert.ok(!overlay.classList.contains("open") || overlay.textContent.indexOf("הרישום הראשון שלך נשמר") === -1,
    "the second entry is not an arrival");
});

// ---- S5: cloud-backup consent -----------------------------------------

test("no anonymous cloud account may be created before the member has been asked", async () => {
  const window = await bootApp();
  window.saveWelcomeForm("רונית");
  // The predicate cloud.js's maybeAutoStartBackup() is asked to respect. It
  // is the only thing standing between "the member has data worth backing
  // up" and "an account was opened on their behalf without a question".
  assert.equal(typeof window.haimuniaBackupConsentPending, "function",
    "cloud.js reads this hook by name — removing it silently re-opens the consent gap");
  assert.equal(window.haimuniaBackupConsentPending(), true);

  window.setBackupConsent("later");
  assert.equal(window.haimuniaBackupConsentPending(), false, "answered is answered, either way");
});

test("the consent card is not asked before there is anything to back up", async () => {
  const window = await bootApp();
  window.saveWelcomeForm("רונית");
  assert.equal(window.totalLoggedEntries(), 0);
  assert.equal(window.shouldShowBackupConsent(), false,
    "'back up your workouts' is a question with no meaning for someone who has no workouts");
});

// ---- S6: install, deferred to day two ---------------------------------

test("the install prompt is not shown on the first day, however much the member logs", async () => {
  const window = await bootApp();
  window.saveWelcomeForm("רונית");
  assert.equal(window.installGateOpen(), false, "nothing saved yet");

  await window.addMovement("Install Squat", "Squat");
  await logASet(window, 60);
  assert.equal(window.installGateOpen(), false,
    "one session is not evidence enough to ask someone to commit; §1.2 S6 requires a second calendar day");
  assert.equal(installBannerShown(window), false);
});

test("the install prompt opens on a later day, once there is something to keep", async () => {
  const window = await bootApp();
  window.saveWelcomeForm("רונית");
  await window.addMovement("Day Two Squat", "Squat");

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await window.dbSetSetting("haimunia-demo:firstOpenDate", yesterday);
  await window.loadFirstOpenDate();

  assert.equal(window.installGateOpen(), false, "a second day with an empty log is still nothing to keep");
  await logASet(window, 60);
  assert.equal(window.installGateOpen(), true);
});

test("a dismissed install prompt stays dismissed across a cold open", async () => {
  const window = await bootApp();
  window.saveWelcomeForm("רונית");
  await window.addMovement("Dismiss Squat", "Squat");
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await window.dbSetSetting("haimunia-demo:firstOpenDate", yesterday);
  await window.loadFirstOpenDate();
  await logASet(window, 60);
  assert.equal(window.installGateOpen(), true);

  window.dismissInstallBanner();
  // Persona finding B10: the dismissal key was sessionStorage-scoped, so a
  // banner the member had explicitly declined came back on the very next
  // cold open, forever. A cold open is a new session and the same origin.
  assert.equal(window.sessionStorage.getItem("haimunia-demo:installDismissed"), null,
    "a session-scoped 'no' is not a 'no'");
  assert.equal(window.localStorage.getItem("haimunia-demo:installDismissed"), "1");
  assert.equal(window.installGateOpen(), false);
});

// ---- §1.5: everything deferred has a permanent home --------------------

test("every surface the first run defers is reachable from Settings afterwards", async () => {
  const window = await bootApp();
  window.saveWelcomeForm("רונית");
  const settings = window.renderSettingsBody();

  assert.match(settings, /עזרה והתאמה/);
  // Deferring a surface without giving it a home is just deleting it.
  assert.match(settings, /data-action="open-onboarding"/, "the explainer");
  assert.match(settings, /data-action="show-install-hint"/, "the install prompt");
  assert.match(settings, /data-action="edit-box-start-date"/, "the box-start date");
});

test("the box-start date's other home — the achievements screen — still offers it", async () => {
  const window = await bootApp();
  window.saveWelcomeForm("רונית");
  // §1.4 routes the date to the achievements screen's existing prompt card
  // as well as Settings, because that is where a member is actually looking
  // at the tenure badges it unlocks.
  assert.match(window.renderAchievementsContent(), /data-action="open-profile-from-achievements"/);
});

test("clearing all data returns the member to a real first run, not a spent one", async () => {
  const window = await bootApp();
  window.saveWelcomeForm("רונית");
  window.openOnboarding();
  window.closeOnboarding();
  await window.addMovement("Cleared Squat", "Squat");
  await logASet(window, 60);
  window.closeCelebration();
  assert.equal(window.shouldShowTourCard(), false);

  await window.clearAllData();

  // A device returned to empty is a first run by every definition the
  // sequence uses; without this the member gets the welcome sheet and then
  // an app that has already decided they have seen everything.
  assert.equal(window.shouldShowTourCard(), true, "the tour card is offered again");
  assert.equal(window.haimuniaBackupConsentPending(), true, "consent is unasked again");
  assert.equal(window.installGateOpen(), false, "day one again");
  assert.deepEqual(openOverlayIds(window), ["welcomeOverlay"]);
});
