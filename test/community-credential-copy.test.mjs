// Two defects from the five-persona UX audit, both cases of the app stating
// something that is not true about its own rules.
//
// 1. The password field's placeholder promised "לפחות 8 תווים" while the
//    validator demanded ten characters plus an upper, a lower and a digit.
//    Eight characters - exactly what the app asked for - came back rejected.
//    Three separate personas hit it, which is to say every member hits it on
//    their first attempt. The username field had the same defect in milder
//    form: the placeholder said "אותיות אנגליות" and the error added a case
//    and a length nobody had been shown.
//
// 2. Signup asked for a name TWICE, three screens apart, both labelled
//    "שם משתמש", with contradictory rules behind them - stage one rejects
//    Hebrew, stage two suggests it ("למשל דנה_כהן"). A member could not tell
//    which name the club would see.
//
// Executing tests against the real gate cascade, not source-text matches: the
// point of the first group is that what the screen PROMISES and what the code
// ACCEPTS are the same thing, and only running both halves can show that.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor, waitForCommunityGate } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

function submit(window, id) {
  window.document.getElementById(id).dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}
function type(window, input, value) {
  input.value = value;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}
function fieldError(window, formId, name) {
  const input = window.document.querySelector(`#${formId} [name="${name}"]`);
  const label = input.closest("label.field");
  const err = label && label.querySelector(".field-error");
  return err ? err.textContent : null;
}

// Brand-new signup, driven through the real gates up to the credentials
// screen - the same path community-intro-carousel.test.mjs uses.
async function reachCredentials(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitForCommunityGate(window);
  window.document.querySelector('[data-community-action="start-signup"]').click();
  await waitFor(() => !!window.document.getElementById("communityInviteCode"), 3000);
  window.document.querySelector('#communityInviteCode input[name="code"]').value = "CLUBCODE";
  submit(window, "communityInviteCode");
  await waitFor(() => !!window.document.getElementById("communityCredentials"), 3000);
}

// ===========================================================================
// 1. The placeholder and the validator state the same rule
// ===========================================================================

test("a password of exactly the length the placeholder promises, with exactly the character classes it names, is accepted", async () => {
  const window = await bootCommunity(createMockSupabase(), { syncEnabled: false });
  await reachCredentials(window);

  const passwordInput = window.document.querySelector('#communityCredentials input[name="password"]');
  // Read the promise off the screen and build the smallest password that
  // satisfies it, rather than hard-coding one that happens to work. If the
  // placeholder ever drifts from the rule again, this fails.
  const promisedLength = Number((passwordInput.placeholder.match(/\d+/) || [])[0]);
  assert.ok(promisedLength >= 10, `the placeholder must state the real minimum, said "${passwordInput.placeholder}"`);
  assert.match(passwordInput.placeholder, /אות גדולה/, "and name the uppercase requirement");
  assert.match(passwordInput.placeholder, /אות קטנה/, "and the lowercase one");
  assert.match(passwordInput.placeholder, /ספרה/, "and the digit");
  const password = "Aa1" + "b".repeat(promisedLength - 3);
  assert.equal(password.length, promisedLength);

  window.document.querySelector('#communityCredentials input[name="username"]').value = "dana";
  passwordInput.value = password;
  window.document.querySelector('#communityCredentials input[name="passwordConfirm"]').value = password;
  submit(window, "communityCredentials");

  // Getting past this gate at all is the assertion: the account was created.
  await waitFor(() => !window.document.getElementById("communityCredentials"), 3000);
});

test("the username placeholder states the case and the length the validator actually enforces", async () => {
  const window = await bootCommunity(createMockSupabase(), { syncEnabled: false });
  await reachCredentials(window);
  const placeholder = window.document.querySelector('#communityCredentials input[name="username"]').placeholder;
  assert.match(placeholder, /קטנות/, "the audit's complaint: the error demanded lowercase, the placeholder never said so");
  assert.match(placeholder, /3/, "and the length was only ever mentioned in the rejection");
  assert.match(placeholder, /24/);
  // Not a "3–24" range: a numeric range joined by a neutral dash inside an RTL
  // sentence can paint reversed, which is the bidi hazard the file's own
  // conventions call out.
  assert.doesNotMatch(placeholder, /3\s*[-–—]\s*24/, "spell the range with a Hebrew word between the numbers, not a bare dash");
});

// ===========================================================================
// 2. Both fields check themselves as the member types
// ===========================================================================

test("a too-short password is reported while the member is still typing, not only after submitting", async () => {
  const window = await bootCommunity(createMockSupabase(), { syncEnabled: false });
  await reachCredentials(window);
  const passwordInput = window.document.querySelector('#communityCredentials input[name="password"]');

  type(window, passwordInput, "Abcdefg1");
  const shown = fieldError(window, "communityCredentials", "password");
  assert.ok(shown, "eight characters must be flagged before the member commits to it");
  assert.match(shown, /10/, "and the message says what the real minimum is");
  assert.equal(passwordInput.getAttribute("aria-invalid"), "true", "screen readers learn it at the same moment");
  assert.equal(passwordInput.getAttribute("aria-describedby"), "err-communityCredentials-password");

  type(window, passwordInput, "Abcdefghi1");
  assert.equal(fieldError(window, "communityCredentials", "password"), null, "and it clears the moment the rule is met");
  assert.equal(passwordInput.getAttribute("aria-invalid"), null);
});

test("live validation never steals focus or the caret - it patches the field in place instead of re-rendering it", async () => {
  const window = await bootCommunity(createMockSupabase(), { syncEnabled: false });
  await reachCredentials(window);
  const passwordInput = window.document.querySelector('#communityCredentials input[name="password"]');
  passwordInput.focus();

  type(window, passwordInput, "Abc");
  assert.ok(fieldError(window, "communityCredentials", "password"), "the error is showing");
  assert.equal(window.document.activeElement, passwordInput, "the member is still typing in the same field");
  assert.equal(
    window.document.querySelector('#communityCredentials input[name="password"]'), passwordInput,
    "and it is the same element - a rerender here would swap it out mid-word and drop the caret",
  );
});

test("a username the app cannot accept is reported as it is typed, and says what it does accept", async () => {
  const window = await bootCommunity(createMockSupabase(), { syncEnabled: false });
  await reachCredentials(window);
  const usernameInput = window.document.querySelector('#communityCredentials input[name="username"]');

  type(window, usernameInput, "דנה");
  const shown = fieldError(window, "communityCredentials", "username");
  assert.ok(shown, "Hebrew is rejected by USERNAME_RE, so it must be flagged here");
  assert.match(shown, /אנגליות/, "and the message names what is allowed instead");

  type(window, usernameInput, "dana_k");
  assert.equal(fieldError(window, "communityCredentials", "username"), null);
});

test("a capital letter is not flagged, because setCredentials lower-cases before saving and would have accepted it", async () => {
  // A live check stricter than the submit it fronts is the same class of
  // defect as one looser than it: both make the app say something untrue.
  const window = await bootCommunity(createMockSupabase(), { syncEnabled: false });
  await reachCredentials(window);
  const usernameInput = window.document.querySelector('#communityCredentials input[name="username"]');
  type(window, usernameInput, "Dana_K");
  assert.equal(fieldError(window, "communityCredentials", "username"), null, "the submit accepts this and stores it as dana_k");
});

test("the confirmation field reports a mismatch as it is typed, and clears when the first field is corrected to match", async () => {
  const window = await bootCommunity(createMockSupabase(), { syncEnabled: false });
  await reachCredentials(window);
  const passwordInput = window.document.querySelector('#communityCredentials input[name="password"]');
  const confirmInput = window.document.querySelector('#communityCredentials input[name="passwordConfirm"]');

  type(window, passwordInput, "Abcdefghi1");
  type(window, confirmInput, "Abcdefghi2");
  assert.match(fieldError(window, "communityCredentials", "passwordConfirm"), /לא תואמות/);

  // Correcting the FIRST field must clear the error on the second one, which
  // is now correct and which the member has no reason to go back and touch.
  type(window, passwordInput, "Abcdefghi2");
  assert.equal(fieldError(window, "communityCredentials", "passwordConfirm"), null);
});

test("the backup-only credentials form in Settings gets the same honest placeholders and the same live checks", async () => {
  // Same two fields, a second entry point, and it had the same two lying
  // placeholders. Fixing one and not the other would just move the defect.
  const window = await bootCommunity(createMockSupabase(), { syncEnabled: false });
  // The form only renders while the session is still anonymous, which is
  // exactly where reachCredentials() leaves it.
  await reachCredentials(window);
  const panel = String(window.renderBackupSettingsPanel());
  assert.ok(panel.includes("backupCredentials"), "the backup-credentials form renders for an anonymous session");
  assert.doesNotMatch(panel, /placeholder="לפחות 8 תווים"/, "the eight-character promise must be gone from here too");
  assert.match(panel, /placeholder="לפחות 10 תווים/, "and the real rule is what it promises now");
  assert.match(panel, /שם לכניסה/, "and its name field is disambiguated the same way");
  assert.match(panel, /data-live-validate="password"/);
  assert.match(panel, /data-live-validate="username"/);
});

// ===========================================================================
// 3. The two name fields say what they are for
// ===========================================================================

test("the login name and the club-facing name are not both called שם משתמש", async () => {
  const window = await bootCommunity(createMockSupabase(), { syncEnabled: false });
  await reachCredentials(window);

  const credentialsCard = window.document.getElementById("communityCredentials").closest(".chart-card");
  const loginLabel = window.document.querySelector('#communityCredentials [name="username"]').closest("label.field").querySelector(".field-label").textContent;
  assert.notEqual(loginLabel, "שם משתמש", "the ambiguous label is what made the two fields indistinguishable");
  assert.match(loginLabel, /כניסה/, "this one is the name you log in with, and says so");
  // And the screen names the OTHER name, so this field does not read as the
  // one the club will see.
  assert.match(credentialsCard.textContent, /השם שחברי המועדון/, "it must say the club-facing name is chosen separately");

  // Through the gate and on to profile completion, where the second name is.
  window.document.querySelector('#communityCredentials input[name="username"]').value = "dana";
  window.document.querySelector('#communityCredentials input[name="password"]').value = "Abcdefghi1";
  window.document.querySelector('#communityCredentials input[name="passwordConfirm"]').value = "Abcdefghi1";
  submit(window, "communityCredentials");
  await waitFor(() => !!window.document.getElementById("communityProfile"), 3000);

  const profileCard = window.document.getElementById("communityProfile").closest(".chart-card");
  const handleLabel = window.document.querySelector('#communityProfile [name="handle"]').closest("label.field").querySelector(".field-label").textContent;
  assert.notEqual(handleLabel, "שם משתמש");
  assert.notEqual(handleLabel, loginLabel, "the two name fields must not carry the same label");
  assert.match(handleLabel, /מועדון/, "this one is the name other members see, and says so");
  assert.match(profileCard.textContent, /לא שם הכניסה/, "and it says explicitly that it is not the login name");
});

test("the club-facing name field still accepts the Hebrew its own placeholder suggests", async () => {
  // The placeholder "למשל דנה_כהן" is only honest if Hebrew is genuinely
  // accepted here - it is the first field's rules, not this one's, that
  // reject it. Disambiguating the labels must not have quietly unified them.
  const window = await bootCommunity(createMockSupabase(), { syncEnabled: false });
  await reachCredentials(window);
  window.document.querySelector('#communityCredentials input[name="username"]').value = "dana";
  window.document.querySelector('#communityCredentials input[name="password"]').value = "Abcdefghi1";
  window.document.querySelector('#communityCredentials input[name="passwordConfirm"]').value = "Abcdefghi1";
  submit(window, "communityCredentials");
  await waitFor(() => !!window.document.getElementById("communityProfile"), 3000);

  const handleInput = window.document.querySelector('#communityProfile [name="handle"]');
  assert.match(handleInput.placeholder, /דנה/, "the placeholder still suggests Hebrew");
  handleInput.value = "דנה_כהן";
  submit(window, "communityProfile");
  await waitFor(() => !window.document.getElementById("communityProfile"), 3000);
});
