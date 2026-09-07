// The club WOD catalogue, client half (202609060028).
//
// THE DEFECT, stated as the box owner reported it: a coach sets a weekly
// challenge by choosing a comparison key. On a built-in WOD that works,
// because WOD_LIBRARY ships inside src/constants.js and so `wod:fran:time:rx`
// means the same thing on every device in the box. On the coach's OWN custom
// WOD it was broken for everybody else - a custom WOD is local data
// (IndexedDB plus a private_records row nobody but its author can read), so
// no other member could resolve the id, the challenge was stamped invalid,
// and nobody could even log the workout to score against it. A coach's own
// programming is exactly what the box wants to run a club challenge on.
//
// The database side is 202609060028 (verified separately in pgTAP and against
// a real local stack with real JWTs). This file is the client side, and the
// FIRST test is the whole feature: a coach publishes their own custom WOD,
// sets a challenge on it, and a DIFFERENT member sees that challenge as valid
// and produces a matching key from a result of their own. Everything after it
// is an invariant that loop depends on.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp, bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = "2026-08-01T00:00:00.000Z";
const TODAY = new Date().toISOString().slice(0, 10);
// A real id from the client's own uid("customwod") shape - the catalogue
// reuses the coach's id rather than minting a new one, which is what makes
// their already-logged entries match the challenge from day one.
const CLUB_ID = "customwod-11111111-2222-3333-4444-555555555555";

// club_wod_json()'s exact output shape: sanitizeCustomWod's field set, plus
// publishedBy/publishedAt/retiredAt, with category the literal 'Club'.
function clubWodRow(over) {
  return Object.assign({
    id: CLUB_ID,
    name: "Dana's Chipper",
    category: "Club",
    scoreType: "time",
    desc: "For time: 50 wall balls, 40 burpees, 30 pull-ups",
    emomMovements: [],
    emomTargetReps: [],
    emomMinutes: null,
    timeCapSeconds: 1200,
    publishedBy: "coach-1",
    publishedAt: "2026-09-06T08:00:00.000Z",
    retiredAt: null,
  }, over || {});
}

function personaMock(who, extra) {
  const staff = who === "coach";
  const id = staff ? "coach-1" : "member-1";
  const mock = createMockSupabase(Object.assign({
    profiles: [{ id, handle: staff ? "dana_k" : "noa_s", display_name: staff ? "דנה" : "נועה",
      is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: id, invite_id: "inv-1", role: staff ? "coach" : "member", redeemed_at: VERIFIED }],
    weekly_challenges: [],
    club_wods: [],
  }, extra || {}));
  mock.setUser({ id, is_anonymous: false, email: `${staff ? "dana_k" : "noa_s"}@members.haimuniya.invalid` });
  installClubWodRpcs(mock, staff);
  return mock;
}

// A stand-in for the four RPCs that keeps the behaviours the client actually
// depends on: staff-only writes, the snapshot rule ('wod already published'
// on a CHANGED definition, a no-op on an identical one), and a list that
// always includes retired rows. It is not a reimplementation of the migration
// - the real gates are Postgres's and are asserted there - it is only enough
// server for the client's own logic to be exercised honestly.
function installClubWodRpcs(mock, staff) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  mock.onRpc("club_wods_list", (args, ctx) => ({ data: (ctx.db.club_wods || []).slice(), error: null }));
  mock.onRpc("club_wod_publish", (args, ctx) => {
    if (!staff) return { data: null, error: { message: "not authorized" } };
    if (!/^customwod-[a-z0-9-]+$/.test(String(args.p_wod_id || ""))) {
      return { data: null, error: { message: "wod id must be a custom WOD id" } };
    }
    const rows = ctx.db.club_wods;
    const next = clubWodRow({
      id: args.p_wod_id, name: args.p_name, scoreType: args.p_score_type,
      desc: args.p_description || "", timeCapSeconds: args.p_time_cap_seconds || null,
      emomMovements: args.p_emom_movements || [], emomTargetReps: args.p_emom_target_reps || [],
      emomMinutes: args.p_emom_minutes == null ? null : args.p_emom_minutes,
      publishedBy: ctx.currentUser && ctx.currentUser.id,
    });
    const existing = rows.find((r) => r.id === next.id);
    if (existing) {
      // The snapshot rule: identical is idempotent, changed RAISES rather
      // than silently overwriting what a running challenge asks of people.
      const fields = (r) => [r.name, r.scoreType, r.desc, r.emomMovements, r.emomTargetReps, r.emomMinutes, r.timeCapSeconds];
      if (same(fields(existing), fields(next))) return { data: existing, error: null };
      return { data: null, error: { message: "wod already published" } };
    }
    rows.push(next);
    return { data: next, error: null };
  });
  mock.onRpc("club_wod_retire", (args, ctx) => {
    if (!staff) return { data: null, error: { message: "not authorized" } };
    const row = (ctx.db.club_wods || []).find((r) => r.id === args.p_wod_id);
    if (!row) return { data: null, error: { message: "wod not found" } };
    row.retiredAt = "2026-09-07T08:00:00.000Z";
    return { data: row, error: null };
  });
  mock.onRpc("club_wod_restore", (args, ctx) => {
    if (!staff) return { data: null, error: { message: "not authorized" } };
    const row = (ctx.db.club_wods || []).find((r) => r.id === args.p_wod_id);
    if (!row) return { data: null, error: { message: "wod not found" } };
    row.retiredAt = null;
    return { data: row, error: null };
  });
  mock.onRpc("club_wod_edit", (args, ctx) => {
    if (!staff) return { data: null, error: { message: "not authorized" } };
    const row = (ctx.db.club_wods || []).find((r) => r.id === args.p_wod_id);
    if (!row) return { data: null, error: { message: "wod not found" } };
    row.name = args.p_name; row.desc = args.p_description || "";
    return { data: row, error: null };
  });
}

async function openBoards(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="set-tab"][data-tab="boards"]'), 4000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="boards"]').click();
  await waitFor(() => !!window.document.querySelector(".ach-section"), 3000);
}
function submitChallenge(window, comparisonKey) {
  const form = window.document.getElementById("communityWeeklyChallenge");
  form.elements.title.value = "אתגר הצ'יפר";
  form.elements.startsOn.value = TODAY;
  form.elements.endsOn.value = TODAY;
  form.elements.comparisonKey.value = comparisonKey;
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}
// Everything the community layer loads is deferred behind
// ensureCommunityDataLoaded(), which is triggered by the Community tab
// actually rendering (afterRenderCommunity) - so opening it IS the boot as
// far as this feature is concerned.
async function clubWodsLoaded(window, mock) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => mock.callsTo("club_wods_list").length > 0 && window.allWods().some((w) => w.category === "Club"), 5000);
}

// ===========================================================================
// THE LOOP. This is the feature; everything below is an invariant it needs.
// ===========================================================================

test("a coach publishes their own custom WOD, sets a challenge on it, and a DIFFERENT member sees that challenge as valid and can score against it", async () => {
  // ---- ACT ONE: the coach, on their own device -------------------------
  const coachMock = personaMock("coach");
  const coach = await bootCommunity(coachMock, { syncEnabled: false });

  // A WOD the coach built here, in the app's own builder. Before the
  // catalogue this id existed on exactly one device in the world.
  await coach.addCustomWod("Dana's Chipper", "time", "For time: 50 wall balls, 40 burpees, 30 pull-ups");
  const local = coach.allWods().find((w) => w.name === "Dana's Chipper");
  assert.equal(local.category, "Custom", "it starts as the coach's private programming");

  // The picker refuses to offer it as a challenge, because a per-device id
  // can never match another member's post. This is the defect, reproduced.
  await openBoards(coach);
  const before = Array.prototype.map.call(
    coach.document.getElementById("communityWeeklyChallenge").elements.comparisonKey.options, (o) => o.value);
  assert.ok(!before.some((v) => v.split(":")[1] === local.id),
    "a private custom WOD must not be offerable - nobody else could resolve it");

  // The coach publishes it. Staff-gated affordance, confirmation, RPC.
  coach.document.getElementById("tabWodBtn").click();
  coach.choosePickedWod(local.id); coach.render();
  await waitFor(() => !!coach.document.querySelector('[data-action="publish-club-wod"]'), 3000);
  const publishBtn = coach.document.querySelector('[data-action="publish-club-wod"]');
  assert.equal(publishBtn.dataset.id, local.id);
  publishBtn.click();
  await waitFor(() => !!coach.document.querySelector('[data-community-action="confirm-yes"]'), 3000);
  coach.document.querySelector('[data-community-action="confirm-yes"]').click();
  await waitFor(() => coachMock.callsTo("club_wod_publish").length === 1, 4000);

  const sent = coachMock.callsTo("club_wod_publish")[0];
  assert.equal(sent.p_wod_id, local.id, "the coach's OWN id is reused, not reminted");
  assert.equal(sent.p_score_type, "time");
  assert.equal(sent.p_name, "Dana's Chipper");
  const stored = coachMock.db.club_wods[0];

  // On the coach's own device the club copy now shadows their local row.
  await waitFor(() => coach.allWods().some((w) => w.id === local.id && w.category === "Club"), 4000);
  assert.equal(coach.allWods().filter((w) => w.id === local.id).length, 1,
    "exactly one definition wins - two would be two different comparison keys");

  // And the challenge picker offers it now.
  await openBoards(coach);
  const key = `wod:${local.id}:time:rx`;
  const after = Array.prototype.map.call(
    coach.document.getElementById("communityWeeklyChallenge").elements.comparisonKey.options, (o) => o.value);
  assert.ok(after.includes(key), "published programming is offerable as a challenge");
  submitChallenge(coach, key);
  await waitFor(() => coachMock.db.weekly_challenges.length === 1, 4000);
  assert.equal(coachMock.db.weekly_challenges[0].comparison_key, key);

  // ---- ACT TWO: a different member, on a different device --------------
  // Same club: the catalogue row the coach published and the challenge they
  // set. Nothing else crosses over - in particular the member has never
  // heard of this WOD and holds no custom WOD of their own.
  const memberMock = personaMock("member", {
    club_wods: [stored],
    weekly_challenges: [coachMock.db.weekly_challenges[0]],
    clubs: [{ id: "club-1", name: "חיימוניה", active_challenge: { id: coachMock.db.weekly_challenges[0].id, title: "אתגר הצ'יפר", source: "weekly" } }],
  });
  const member = await bootCommunity(memberMock, { syncEnabled: false });
  await clubWodsLoaded(member, memberMock);

  // 1. The member's client resolves the id at all. This was undefined before.
  const resolved = member.wodById(local.id);
  assert.ok(resolved, "the member's own device can now resolve the coach's WOD id");
  assert.equal(resolved.category, "Club");
  assert.equal(resolved.scoreType, "time");

  // 2. The challenge reads as VALID and is advertised. Before, it was stamped
  //    invalid and the club home showed nothing a member could join.
  member.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!member.document.getElementById("communityClubTop"), 4000);
  await waitFor(() => !!member.document.querySelector('[data-community-action="open-active-challenge"]'), 4000);
  assert.ok(member.document.querySelector('[data-community-action="open-active-challenge"]'),
    "a challenge on the box's own programming is joinable, so it is advertised");
  await openBoards(member);
  assert.doesNotMatch(member.document.body.textContent, /אין אתגר פעיל כרגע/,
    "and the Boards tab agrees there is one running");

  // 3. The member can LOG it and the result carries the challenge's exact
  //    key. This is "can score against it": without a resolvable WOD,
  //    wodShareCandidate() returns null and there is nothing to post.
  member.document.getElementById("tabWodBtn").click();
  member.choosePickedWod(local.id); member.render();
  member.applyFieldValue("wod-step", "wodMinutes", 12);
  member.applyFieldValue("wod-step", "wodSeconds", 30);
  await member.saveWod();
  const entry = member.wodEntriesFor(local.id)[0];
  assert.ok(entry, "the member logged the coach's workout on their own device");
  const candidate = member.communityShareCandidateFor("wod_entry", entry.id);
  assert.ok(candidate, "and it is shareable - a WOD the client cannot resolve produces no candidate at all");
  assert.equal(candidate.comparisonKey, key,
    "the member's result carries byte-identical the key the coach's challenge was created with");
  assert.equal(candidate.title, "Dana's Chipper", "under the name the coach published, not the member's own");
  assert.equal(candidate.scoreDirection, "lower", "and with the score direction the published scoreType implies");
});

// ===========================================================================
// sanitizeCustomWod
// ===========================================================================

test("sanitizeClubWod mints the Club category and carries retiredAt", async () => {
  const window = await bootApp();
  const club = window.sanitizeClubWod(clubWodRow({ retiredAt: "2026-09-07T00:00:00.000Z" }));
  assert.equal(club.category, "Club");
  assert.equal(club.retiredAt, "2026-09-07T00:00:00.000Z");
  assert.equal(club.timeCapSeconds, 1200);

  const active = window.sanitizeClubWod(clubWodRow());
  assert.equal(active.retiredAt, null, "an active club WOD carries retiredAt: null, not a missing key");
});

// The category is decided by WHICH FUNCTION IS CALLED, never by the payload,
// and that is a security boundary rather than a style preference.
//
// sanitizeCustomWod runs on two inputs a member fully controls: private_records
// restores (record_type "custom_wod") and imported backup files. An earlier
// draft read `w.category`, so hand-writing `category: "Club"` into a backup and
// importing it minted a pseudo-club WOD on that member's own device -
// undeletable, because deleteCustomWod() refuses anything that is not "Custom",
// AND offered as a weekly-challenge key, because challengeKeyChoices() skips
// only "Custom". Two identity checks that each read correctly on their own
// combine into a privilege the member does not have.
test("sanitizeCustomWod can never mint a Club WOD, whatever the payload claims", async () => {
  const window = await bootApp();
  for (const category of [undefined, "Custom", "Girls", "Heroes", "club", "CLUB", 1, null, "Club"]) {
    const out = window.sanitizeCustomWod({ id: "customwod-x", name: "n", scoreType: "time", category });
    assert.equal(out.category, "Custom", `category ${JSON.stringify(category)} must not become Club`);
    assert.ok(!("retiredAt" in out), "a member's own WOD carries no retiredAt");
  }

  // The full exploit shape: a hand-edited backup row claiming to be club
  // programming, complete with a retirement stamp, sanitizes to an ordinary
  // deletable custom WOD.
  const forged = window.sanitizeCustomWod(clubWodRow({ retiredAt: "2026-09-07T00:00:00.000Z" }));
  assert.equal(forged.category, "Custom", "an imported backup cannot forge club programming");
  assert.ok(!("retiredAt" in forged), "and cannot forge a retirement stamp either");
});

// ===========================================================================
// allWods() - the id collision
// ===========================================================================

test("on an id collision the CLUB copy wins, so the publishing coach cannot generate a different comparison key from everybody else", async () => {
  const window = await bootApp();
  await window.addCustomWod("Dana's Chipper", "time", "the original");
  const local = window.allWods().find((w) => w.name === "Dana's Chipper");

  // The coach edits their local copy AFTER publishing - which is exactly the
  // case the snapshot rule exists for. The club copy is what the rest of the
  // box holds, so it has to be what this device builds its key from too.
  window.setClubWods([clubWodRow({ id: local.id, scoreType: "time", name: "Dana's Chipper" })]);
  const merged = window.allWods().filter((w) => w.id === local.id);
  assert.equal(merged.length, 1, "exactly one definition, or the key is ambiguous");
  assert.equal(merged[0].category, "Club");
  assert.equal(merged[0].desc, "For time: 50 wall balls, 40 burpees, 30 pull-ups", "the published snapshot, not the local edit");

  // The local row is only SHADOWED. It is still the coach's own data and is
  // still on their disk - dropping it would be deleting a member's record
  // because somebody published something with the same id.
  const onDisk = await window.dbLoadCustomWods();
  assert.ok(onDisk.some((w) => w.id === local.id), "the coach's local row survives on disk, shadowed rather than destroyed");
});

test("the club catalogue is never written into the custom-WOD store, so it cannot sync back out as the member's own private data", async () => {
  const window = await bootApp();
  window.setClubWods([clubWodRow()]);
  assert.ok(window.allWods().some((w) => w.id === CLUB_ID), "it is in the merged catalogue");

  const onDisk = await window.dbLoadCustomWods();
  assert.ok(!onDisk.some((w) => w.id === CLUB_ID),
    "CUSTOMWODSTORE is what the backup sync pushes up as this member's private custom_wod records");
  const backup = window.buildBackupPayload();
  assert.ok(!(backup.customWods || []).some((w) => w.id === CLUB_ID),
    "and the exported backup must not claim the box's programming is this member's own");
});

// ===========================================================================
// Offline
// ===========================================================================

test("a member who logged a club WOD and opens the app offline still resolves it, instead of watching their own history render as an unknown workout", async () => {
  const window = await bootApp();
  window.setClubWods([clubWodRow()]);
  window.document.getElementById("tabWodBtn").click();
  window.choosePickedWod(CLUB_ID); window.render();
  window.applyFieldValue("wod-step", "wodMinutes", 14);
  await window.saveWod();
  const entry = window.wodEntriesFor(CLUB_ID)[0];
  assert.ok(entry, "the member has a real result against the box's programming");

  // The cache is written where it cannot leak: the settings store, which is
  // neither exported by buildBackupPayload() nor synced as private_records.
  let cached = null;
  await waitFor(async () => {
    cached = await window.dbGetSetting("haimunia-demo:clubWods");
    return Array.isArray(cached) && cached.some((w) => w.id === CLUB_ID);
  }, 3000);

  // Now a cold start with no network at all: in-memory catalogue empty (as it
  // is on every fresh load), the cache still on disk from last session, and
  // nothing calling setClubWods(). Hydration is the only thing that can save
  // this member's own history.
  window.setClubWods([]);
  await window.dbSetSetting("haimunia-demo:clubWods", cached);
  assert.equal(window.wodById(CLUB_ID), undefined, "without hydration this is the broken state");
  assert.equal(window.communityShareCandidateFor("wod_entry", entry.id), null,
    "and an unresolvable WOD produces no share candidate at all");

  await window.loadCachedClubWods();
  const back = window.wodById(CLUB_ID);
  assert.ok(back, "the cached catalogue hydrates before the network answers");
  assert.equal(back.category, "Club");
  assert.equal(back.name, "Dana's Chipper");
  assert.ok(window.communityShareCandidateFor("wod_entry", entry.id), "and the member's own result is whole again");
});

test("boot hydrates the cached catalogue before the first render, not after", async () => {
  const window = await bootApp();
  const src = window.eval("String(init)");
  const hydrate = src.indexOf("loadCachedClubWods()");
  const firstRender = src.indexOf('getElementById("loading")');
  assert.ok(hydrate > -1, "init() must hydrate the cached catalogue");
  assert.ok(hydrate < firstRender,
    "hydrating after the first render is the same broken frame the cache exists to remove");
});

// ===========================================================================
// The picker
// ===========================================================================

test("club WODs get their own group in the picker, between the benchmarks and the member's own", async () => {
  const window = await bootApp();
  await window.addCustomWod("My Own Thing", "load", "");
  window.setClubWods([clubWodRow()]);
  window.openWodPicker();
  const heads = Array.prototype.map.call(
    window.document.querySelectorAll("#wodPickerList .cat-name"), (n) => n.textContent);
  assert.ok(heads.includes("Club"), "the box's own programming is not filed under Custom");
  assert.ok(heads.indexOf("Club") > heads.indexOf("Heroes"), "benchmarks first");
  assert.ok(heads.indexOf("Club") < heads.indexOf("Custom"), "the box's programming outranks a private WOD");
});

test("a club WOD offers no delete button, and deleteCustomWod refuses it - a member cannot delete the box's programming off their own device", async () => {
  const window = await bootApp();
  window.setClubWods([clubWodRow()]);
  window.openWodPicker();
  assert.equal(window.document.querySelector(`[data-action='delete-custom-wod'][data-id='${CLUB_ID}']`), null);
  await window.deleteCustomWod(CLUB_ID);
  assert.ok(window.allWods().some((w) => w.id === CLUB_ID), "and the direct call refuses too");
});

test("a retired club WOD leaves the picker, unless this member actually logged it - then it is their own history's doorway", async () => {
  const window = await bootApp();
  window.setClubWods([clubWodRow()]);
  window.openWodPicker();
  assert.ok(window.document.querySelector(`[data-action='pick-wod'][data-id='${CLUB_ID}']`), "offered while it is live");

  window.setClubWods([clubWodRow({ retiredAt: "2026-09-07T00:00:00.000Z" })]);
  window.openWodPicker();
  assert.equal(window.document.querySelector(`[data-action='pick-wod'][data-id='${CLUB_ID}']`), null,
    "the box stopped programming it, so it leaves the picker for NEW logs");
  assert.ok(window.wodById(CLUB_ID),
    "but it stays in allWods() - challenge keys, feed posts and logged history all still reference the id");

  // A member who has done it keeps the row: hiding it would take away the
  // only route to data they own.
  window.setClubWods([clubWodRow()]);
  window.choosePickedWod(CLUB_ID); window.render();
  window.applyFieldValue("wod-step", "wodMinutes", 11);
  await window.saveWod();
  window.setClubWods([clubWodRow({ retiredAt: "2026-09-07T00:00:00.000Z" })]);
  window.openWodPicker();
  assert.ok(window.document.querySelector(`[data-action='pick-wod'][data-id='${CLUB_ID}']`),
    "a member with a logged result keeps the row");
});

// ===========================================================================
// The challenge picker and the ordering
// ===========================================================================

test("a retired club WOD cannot be the subject of a NEW challenge", async () => {
  const mock = personaMock("coach", { club_wods: [clubWodRow({ retiredAt: "2026-09-07T00:00:00.000Z" })] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await clubWodsLoaded(window, mock);
  await openBoards(window);
  const values = Array.prototype.map.call(
    window.document.getElementById("communityWeeklyChallenge").elements.comparisonKey.options, (o) => o.value);
  assert.ok(!values.some((v) => v.split(":")[1] === CLUB_ID), "retired programming is not offerable");

  // And the submit check refuses it too, so a stale or tampered DOM cannot
  // store one either.
  submitChallenge(window, `wod:${CLUB_ID}:time:rx`);
  await waitFor(() => mock.db.weekly_challenges.length === 0 && !!window.document.querySelector(".field-error"), 3000);
  assert.equal(mock.db.weekly_challenges.length, 0);
});

test("a challenge on a club WOD is valid however late the catalogue arrives - validity is derived at read time, not frozen when the challenge row was read", async () => {
  // THE ORDERING DEFECT, directly. `valid` used to be computed once inside
  // loadWeeklyChallenge(); if the catalogue had not merged by then, a
  // perfectly good club challenge was stamped invalid for the entire session
  // and no later load could correct it. Here the catalogue is deliberately
  // withheld until well after every community load has finished.
  let release;
  const gate = new Promise((r) => { release = r; });
  const mock = personaMock("member", {
    weekly_challenges: [{ id: "wc-1", title: "אתגר הצ'יפר", comparison_key: `wod:${CLUB_ID}:time:rx`,
      starts_on: TODAY, ends_on: TODAY, created_by: "coach-1" }],
    clubs: [{ id: "club-1", name: "חיימוניה", active_challenge: { id: "wc-1", title: "אתגר הצ'יפר", source: "weekly" } }],
  });
  mock.onRpc("club_wods_list", () => gate.then(() => ({ data: [clubWodRow()], error: null })));

  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityClubTop"), 4000);
  // The challenge is not joinable YET, and that is honest: this member
  // genuinely cannot resolve the WOD at this instant.
  assert.equal(window.document.querySelector('[data-community-action="open-active-challenge"]'), null);

  release();
  await waitFor(() => window.allWods().some((w) => w.id === CLUB_ID), 5000);
  window.render();
  assert.ok(window.document.querySelector('[data-community-action="open-active-challenge"]'),
    "once the catalogue lands the SAME challenge row is joinable - no reload, no second challenge read");
});

// ===========================================================================
// Publishing: the gate and the one error a coach has to understand
// ===========================================================================

test("the publish affordance is staff-only and appears on a member's own custom WOD, never on a club one", async () => {
  const mock = personaMock("member");
  const window = await bootCommunity(mock, { syncEnabled: false });
  await window.addCustomWod("Private Thing", "load", "");
  const local = window.allWods().find((w) => w.name === "Private Thing");
  window.document.getElementById("tabWodBtn").click();
  window.choosePickedWod(local.id); window.render();
  assert.equal(window.document.querySelector('[data-action="publish-club-wod"]'), null,
    "a plain member is never shown a control that can only fail");

  const staffMock = personaMock("coach", { club_wods: [clubWodRow()] });
  const coach = await bootCommunity(staffMock, { syncEnabled: false });
  await clubWodsLoaded(coach, staffMock);
  coach.document.getElementById("tabWodBtn").click();
  coach.choosePickedWod(CLUB_ID); coach.render();
  assert.equal(coach.document.querySelector('[data-action="publish-club-wod"]'), null,
    "an already-published WOD offers no second publish");
});

test("re-publishing after a local edit says the club copy is a snapshot and the edit did not propagate - not a generic failure", async () => {
  const mock = personaMock("coach", { club_wods: [clubWodRow()] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await clubWodsLoaded(window, mock);

  // The coach's device still holds their own row under the same id. Publish
  // it again with a changed definition, which is what a coach who edited
  // locally and re-tapped publish is doing.
  await window.publishClubWod({ id: CLUB_ID, name: "Dana's Chipper", category: "Custom",
    scoreType: "time", desc: "now 60 burpees", timeCapSeconds: 1200 });
  await waitFor(() => !!window.document.querySelector('[data-community-action="confirm-yes"]'), 3000);
  window.document.querySelector('[data-community-action="confirm-yes"]').click();
  await waitFor(() => mock.callsTo("club_wod_publish").length === 1, 4000);

  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => /צילום מצב/.test(window.document.body.textContent), 4000);
  const text = window.document.body.textContent;
  assert.match(text, /כבר נמצא בקטלוג/, "it says the WOD is already there");
  assert.match(text, /לא עבר אליו/, "and that the local edit did NOT propagate - the thing a coach must understand");
  assert.doesNotMatch(text, /wod already published/, "the raw English server string never reaches a member");
});

test("the retire, restore and edit wrappers are staff-only and re-read the catalogue after every write", async () => {
  const mock = personaMock("coach", { club_wods: [clubWodRow()] });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await clubWodsLoaded(window, mock);
  const listsBefore = mock.callsTo("club_wods_list").length;

  assert.equal(await window.retireClubWod(CLUB_ID, "seasonal"), true);
  await waitFor(() => window.allWods().some((w) => w.id === CLUB_ID && w.retiredAt), 4000);
  assert.ok(mock.callsTo("club_wods_list").length > listsBefore, "a write is followed by a re-read");

  assert.equal(await window.restoreClubWod(CLUB_ID), true);
  await waitFor(() => window.allWods().some((w) => w.id === CLUB_ID && !w.retiredAt), 4000);

  assert.equal(await window.editClubWod(CLUB_ID, "Dana's Chipper v2", "same workout, better name"), true);
  await waitFor(() => window.allWods().some((w) => w.name === "Dana's Chipper v2"), 4000);

  // A plain member holds the same four functions and gets nowhere with them.
  const memberMock = personaMock("member", { club_wods: [clubWodRow()] });
  const memberWindow = await bootCommunity(memberMock, { syncEnabled: false });
  await clubWodsLoaded(memberWindow, memberMock);
  assert.equal(await memberWindow.retireClubWod(CLUB_ID, "nope"), false, "staff-gated before it reaches the network");
  assert.equal(await memberWindow.editClubWod(CLUB_ID, "Hijacked"), false);
  assert.equal(await memberWindow.restoreClubWod(CLUB_ID), false);
  for (const name of ["club_wod_retire", "club_wod_edit", "club_wod_restore"]) {
    assert.equal(memberMock.callsTo(name).length, 0, `${name} must not even be attempted by a plain member`);
  }
  assert.equal(memberWindow.wodById(CLUB_ID).name, "Dana's Chipper", "and the catalogue is untouched");
});

test("a catalogue read that fails mid-session leaves the loaded catalogue alone rather than blanking it", async () => {
  // A member whose connection drops must not watch their own logged history
  // turn into an unknown workout because one request failed. loadClubWods()
  // returns early on error without touching state; this drives that through
  // the real code path rather than asserting it about the source.
  let fail = false;
  const mock = personaMock("coach", { club_wods: [clubWodRow()] });
  mock.onRpc("club_wods_list", (args, ctx) => (fail
    ? { data: null, error: { message: "failed to fetch" } }
    : { data: (ctx.db.club_wods || []).slice(), error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await clubWodsLoaded(window, mock);

  // editClubWod() succeeds and then re-reads the catalogue - and that re-read
  // is the one that fails.
  fail = true;
  const listsBefore = mock.callsTo("club_wods_list").length;
  assert.equal(await window.editClubWod(CLUB_ID, "Dana's Chipper v2", ""), true);
  await waitFor(() => mock.callsTo("club_wods_list").length > listsBefore, 4000);
  assert.ok(window.wodById(CLUB_ID), "the WOD is still resolvable after the failed re-read");
  assert.equal(window.wodById(CLUB_ID).name, "Dana's Chipper", "holding the last good copy, not nothing");
});
