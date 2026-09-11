// The weekly challenge accepted anything a coach typed and produced a dead
// leaderboard.
//
// The comparison key is a database key ("movement:back-squat:est1rm") and the
// form asked a coach to hand-type it. The audit typed six malformed keys and
// all six were accepted and stored: Hebrew free text, a missing prefix, a
// misspelled movement id, a bare "movement:". On screen it was worse than
// silent - a malformed challenge rendered as a bright orange primary hero
// button at the top of every member's club home, while the Boards tab where
// you would go to join it said "אין אתגר פעיל כרגע". A coach's typo became the
// club's front-page call to action, and tapping it 400'd with nothing shown.
//
// Three things had to change and each is covered here: the field is a picker
// so an invalid key cannot be produced; the submit re-checks the key against
// the real catalogs so a tampered or stale DOM cannot get one in either; and
// nothing advertises a challenge that no member can join.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = "2026-08-01T00:00:00.000Z";
// Live bug hunt (2026-09-11): must match cloud.js's own todayIso(),
// which computes the LOCAL calendar date, not the UTC one - the two
// disagree for 2-3 hours after local midnight every night (Israel is
// always ahead of UTC), and this test file hit that exact window for real.
const TODAY = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();

// The six keys the audit typed, all of which were accepted and stored.
const MALFORMED_KEYS = [
  "סקוואט אחורי",                  // Hebrew free text
  "back-squat",                    // no prefix at all
  "movement:bck-squat:est1rm",     // correctly shaped, misspelled movement id
  "movement:",                     // bare prefix
  "movement:back-squat",           // no metric
  "wod:fran",                      // WOD, no metric and no rx/scaled
];

function coachMock(extra) {
  const mock = createMockSupabase(Object.assign({
    profiles: [{ id: "coach-1", handle: "dana_k", display_name: "דנה", is_admin: true, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "coach-1", invite_id: "inv-1", role: "coach", redeemed_at: VERIFIED }],
    weekly_challenges: [],
  }, extra || {}));
  mock.setUser({ id: "coach-1", is_anonymous: false, email: "dana_k@members.haimuniya.invalid" });
  return mock;
}

function memberMock(extra) {
  const mock = createMockSupabase(Object.assign({
    profiles: [{ id: "m-1", handle: "rina_member", display_name: "רינה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "m-1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    weekly_challenges: [],
  }, extra || {}));
  mock.setUser({ id: "m-1", is_anonymous: false, email: "rina_member@members.haimuniya.invalid" });
  return mock;
}

function activeRow(comparisonKey, title) {
  return { id: "wc-1", title: title || "אתגר השבוע", comparison_key: comparisonKey, starts_on: TODAY, ends_on: TODAY, created_by: "coach-1" };
}
function clubWithHero() {
  return [{ id: "club-1", name: "חיימוניה", active_challenge: { id: "wc-1", title: "אתגר השבוע", source: "weekly" } }];
}

async function openBoards(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="set-tab"][data-tab="boards"]'), 4000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="boards"]').click();
  await waitFor(() => !!window.document.querySelector(".ach-section"), 3000);
}
async function openClubHome(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityClubTop"), 4000);
}
function submit(window, id) {
  window.document.getElementById(id).dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}
function fieldError(window, formId, name) {
  const input = window.document.querySelector(`#${formId} [name="${name}"]`);
  const label = input && input.closest("label.field");
  const err = label && label.querySelector(".field-error");
  return err ? err.textContent : null;
}
// Fills title and dates and forces a comparison key onto the picker, then
// submits. Forcing a value the <select> does not offer is the point: it is how
// a tampered, scripted or stale DOM would reach setWeeklyChallenge(), and the
// check there is what has to stop it.
function submitChallenge(window, comparisonKey) {
  const form = window.document.getElementById("communityWeeklyChallenge");
  form.elements.title.value = "אתגר בדיקה";
  form.elements.startsOn.value = TODAY;
  form.elements.endsOn.value = TODAY;
  const select = form.elements.comparisonKey;
  if (comparisonKey && !Array.prototype.some.call(select.options, (o) => o.value === comparisonKey)) {
    const option = window.document.createElement("option");
    option.value = comparisonKey;
    option.textContent = comparisonKey;
    select.appendChild(option);
  }
  select.value = comparisonKey;
  submit(window, "communityWeeklyChallenge");
}

// ===========================================================================
// The picker
// ===========================================================================

test("the comparison key is chosen from a list, not typed - there is no free-text key field left", async () => {
  const window = await bootCommunity(coachMock(), { syncEnabled: false });
  await openBoards(window);
  const form = window.document.getElementById("communityWeeklyChallenge");
  assert.ok(form, "the staff-only challenge setter renders for a coach");
  const control = form.elements.comparisonKey;
  assert.equal(control.tagName, "SELECT", "the box owner's stated reason for not using the feature was being asked to type a database key");
  assert.ok(control.querySelectorAll("optgroup").length >= 2, "movements and WODs are grouped");
});

test("every option the picker offers is a key the app could actually produce from a real logged result", async () => {
  const window = await bootCommunity(coachMock(), { syncEnabled: false });
  await openBoards(window);
  const select = window.document.getElementById("communityWeeklyChallenge").elements.comparisonKey;
  const values = Array.prototype.map.call(select.options, (o) => o.value).filter(Boolean);
  assert.ok(values.length > 50, `expected the real catalogs, got ${values.length} options`);

  // The exact shapes app.js builds in communityShareCandidateFor().
  const shape = /^(movement:[a-z0-9-]+:(est1rm|duration)|wod:[a-z0-9-]+:[a-z]+:(rx|scaled))$/;
  for (const value of values) assert.match(value, shape, `${value} is not a shape a shared result would ever carry`);

  const movementIds = new Set(window.allMovements().map((m) => m.id));
  const wodIds = new Set(window.allWods().map((w) => w.id));
  for (const value of values) {
    const parts = value.split(":");
    const known = parts[0] === "movement" ? movementIds.has(parts[1]) : wodIds.has(parts[1]);
    assert.ok(known, `${value} names something that is not in the app's catalogs`);
  }
  assert.ok(values.includes("movement:back-squat:est1rm"), "the format's own documented example must be offerable");
});

test("the picker never offers a CUSTOM movement or WOD, whose ids are per-device and could never match another member's post", async () => {
  const window = await bootCommunity(coachMock(), { syncEnabled: false });
  // A custom WOD created on the coach's own device, exactly as the WOD
  // builder would create it.
  await window.addCustomWod("אימון הבית שלנו", "time", "");
  await openBoards(window);
  const select = window.document.getElementById("communityWeeklyChallenge").elements.comparisonKey;
  const values = Array.prototype.map.call(select.options, (o) => o.value).filter(Boolean);
  const customIds = new Set(window.allWods().filter((w) => w.category === "Custom").map((w) => w.id));
  assert.ok(customIds.size >= 1, "the custom WOD was created");
  for (const value of values) {
    assert.ok(!customIds.has(value.split(":")[1]), `${value} is a per-device custom id and can never match anybody else's result`);
  }
});

// ===========================================================================
// The submit check
// ===========================================================================

test("every one of the six malformed keys the audit stored is now refused, and none of them reaches the database", async () => {
  for (const key of MALFORMED_KEYS) {
    const mock = coachMock();
    const window = await bootCommunity(mock, { syncEnabled: false });
    await openBoards(window);
    submitChallenge(window, key);
    await waitFor(() => !!fieldError(window, "communityWeeklyChallenge", "comparisonKey"), 3000);
    assert.equal(mock.db.weekly_challenges.length, 0, `"${key}" was stored anyway`);
  }
});

test("a correctly shaped key that names a movement the app has never heard of is refused, and the message says why", async () => {
  // The shape check alone was never enough, and this is the case that proves
  // it: "movement:bck-squat:est1rm" is perfectly well-formed and matches
  // nothing that will ever be posted.
  const mock = coachMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  submitChallenge(window, "movement:bck-squat:est1rm");
  await waitFor(() => !!fieldError(window, "communityWeeklyChallenge", "comparisonKey"), 3000);
  const message = fieldError(window, "communityWeeklyChallenge", "comparisonKey");
  assert.match(message, /לא קיים/, "it must say the thing does not exist, not just 'invalid format'");
  assert.equal(mock.db.weekly_challenges.length, 0);
  // And the error is wired to the control for a screen reader, which needed
  // field() to learn about <select>.
  const select = window.document.getElementById("communityWeeklyChallenge").elements.comparisonKey;
  assert.equal(select.getAttribute("aria-invalid"), "true");
  assert.equal(select.getAttribute("aria-describedby"), "err-communityWeeklyChallenge-comparisonKey");
});

test("a key picked from the list is accepted and stored exactly as chosen", async () => {
  const mock = coachMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  submitChallenge(window, "movement:back-squat:est1rm");
  await waitFor(() => mock.db.weekly_challenges.length === 1, 3000);
  assert.equal(mock.db.weekly_challenges[0].comparison_key, "movement:back-squat:est1rm");
  assert.equal(fieldError(window, "communityWeeklyChallenge", "comparisonKey"), null);
});

test("a rejected submit keeps the coach's pick instead of silently resetting the picker", async () => {
  const mock = coachMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  const form = window.document.getElementById("communityWeeklyChallenge");
  const select = form.elements.comparisonKey;
  select.value = "movement:back-squat:est1rm";
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  form.elements.title.value = ""; // the thing that will fail
  form.elements.startsOn.value = TODAY;
  form.elements.endsOn.value = TODAY;
  submit(window, "communityWeeklyChallenge");
  await waitFor(() => !!fieldError(window, "communityWeeklyChallenge", "title"), 3000);
  assert.equal(
    window.document.getElementById("communityWeeklyChallenge").elements.comparisonKey.value,
    "movement:back-squat:est1rm",
    "a missing title must not throw away what the coach already chose",
  );
});

// ===========================================================================
// The club home and the Boards tab now agree
// ===========================================================================

test("a malformed active challenge is not advertised on the club home, and Boards agrees there is nothing on", async () => {
  const mock = memberMock({ clubs: clubWithHero(), weekly_challenges: [activeRow("סקוואט אחורי")] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openClubHome(window);
  assert.equal(
    window.document.querySelector('[data-community-action="open-active-challenge"]'), null,
    "a coach's typo must not become the club's front-page call to action",
  );
  await openBoards(window);
  const boards = window.document.body.textContent;
  assert.match(boards, /אין אתגר פעיל כרגע/, "and the two screens must say the same thing");
});

test("a valid active challenge with no entries yet is advertised, and Boards says it is open rather than denying it exists", async () => {
  // The other half of the contradiction: an empty leaderboard used to read as
  // "no challenge", which is a lie about a challenge that is genuinely running
  // and that a member could join right now by posting a result.
  const mock = memberMock({ clubs: clubWithHero(), weekly_challenges: [activeRow("movement:back-squat:est1rm")] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openClubHome(window);
  const hero = window.document.querySelector('[data-community-action="open-active-challenge"]');
  assert.ok(hero, "a real, joinable challenge is worth a hero button");

  await openBoards(window);
  const boards = window.document.body.textContent;
  assert.doesNotMatch(boards, /אין אתגר פעיל כרגע/, "there IS one active");
  assert.match(boards, /עדיין אין תוצאות/, "it says nobody has posted yet, which is the true statement");
});

test("tapping the weekly hero opens the Boards tab instead of a challenge id that table does not have", async () => {
  const mock = memberMock({ clubs: clubWithHero(), weekly_challenges: [activeRow("movement:back-squat:est1rm")] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openClubHome(window);
  const hero = window.document.querySelector('[data-community-action="open-active-challenge"]');
  assert.equal(hero.dataset.id, undefined, "openChallenge() would 400 on a weekly id - that is the request that showed the member nothing");
  hero.click();
  await waitFor(() => !!window.document.getElementById("communityWeeklyChallenge") || /אתגר השבוע/.test(window.document.body.textContent), 3000);
  const boardsTab = window.document.querySelector('[data-community-action="set-tab"][data-tab="boards"]');
  assert.equal(boardsTab.getAttribute("aria-selected"), "true", "the tap lands on the tab where a weekly challenge actually lives");
});

test("a coach is told why their broken challenge is invisible; a member is not shown the wreckage", async () => {
  const coachWindow = await bootCommunity(coachMock({ clubs: clubWithHero(), weekly_challenges: [activeRow("movement:bck-squat:est1rm", "סקוואט אחורי")] }), { syncEnabled: false });
  await openBoards(coachWindow);
  const coachText = coachWindow.document.body.textContent;
  assert.match(coachText, /לא מוצג לחברי המועדון/, "the only person who can fix it has to know it is broken");
  assert.match(coachText, /movement:bck-squat:est1rm/, "and which key is the problem");

  const memberWindow = await bootCommunity(memberMock({ clubs: clubWithHero(), weekly_challenges: [activeRow("movement:bck-squat:est1rm", "סקוואט אחורי")] }), { syncEnabled: false });
  await openBoards(memberWindow);
  assert.doesNotMatch(memberWindow.document.body.textContent, /לא מוצג לחברי המועדון/, "a member has nothing to do with this");
});
