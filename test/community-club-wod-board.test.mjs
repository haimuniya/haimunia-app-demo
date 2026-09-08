// THE FEED WRITES ITSELF - club WOD sessions and boards, client half
// (202609080001 / 202609080002).
//
// THE FINDING THIS EXISTS FOR: the community layer competes with WhatsApp on
// typed posts and loses. WhatsApp is at 99% penetration and 99% daily use in
// Israel and every box already has a group, so an in-house feed that asks
// people to TYPE is asking for a behaviour that will not move. The only
// content WhatsApp cannot produce is what this app already knows - today's
// programming, and who did it. So the feed has to write itself: a coach
// programs one catalogue WOD to one day (ONE card, ONE board), and a member
// who has ALREADY LOGGED it attaches their own result with a single tap from
// the form they were filling in anyway.
//
// THE FIRST TEST IS THE WHOLE FEATURE, end to end and in one process: a coach
// publishes today's WOD, a member logs it and attaches, a second member opens
// the board, and a member whose show_workout_results is false appears LISTED
// WITHOUT A FIGURE. That last one is this feature's central privacy claim and
// it is SHOWN here rather than assumed. Everything after it is an invariant
// that loop depends on.
//
// WHAT IS ASSERTED HERE AND WHAT IS NOT. The gates, the rate limit, the
// ownership probe and the figure's recomputation are Postgres's and are
// asserted in pgTAP plus against a real local stack with real JWTs (dana_k
// coach, yael_b admin, noa_s/itai_r members) - including the run that
// produced the exact refusal strings mapped in cloud.js's SERVER_ERROR_TEXT
// and checked at the bottom of this file. What is asserted HERE is the
// client's half: that it branches on the card type before the deep link,
// that it builds every control off the board's `viewer` rather than
// re-deriving the rules, that it drives the attach CTA from app.js's own
// local log because the server cannot know whether a member logged anything,
// that it never ranks, and that it never flips a privacy toggle.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor, answerWodRx } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const appJs = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
// Every negative assertion below is about CODE. This feature's section is
// mostly prose - it has to be, since most of what it is is a set of things
// deliberately not built - so a sweep over the raw text would be tripped by
// the explanation instead of by an implementation.
const stripComments = (s) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

const VERIFIED = "2026-08-01T00:00:00.000Z";
const TODAY = new Date().toISOString().slice(0, 10);
const TOMORROW = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const WOD_ID = "customwod-11111111-2222-3333-4444-555555555555";
const SESSION_ID = "5e551011-0000-4000-8000-000000000001";

const PEOPLE = {
  "coach-1": { id: "coach-1", handle: "dana_k", display_name: "דנה", role: "coach", show_workout_results: false },
  "member-1": { id: "member-1", handle: "noa_s", display_name: "נועה", role: "member", show_workout_results: false },
  "member-2": { id: "member-2", handle: "itai_r", display_name: "איתי", role: "member", show_workout_results: true },
};

// club_wod_json()'s exact output shape.
function clubWodRow() {
  return {
    id: WOD_ID, name: "Dana's Chipper", category: "Club", scoreType: "time",
    desc: "21-15-9 Thrusters + Pull-ups. Rx 43/30 ק\"ג",
    emomMovements: [], emomTargetReps: [], emomMinutes: null, timeCapSeconds: 1200,
    publishedBy: "coach-1", publishedAt: "2026-09-06T08:00:00.000Z", retiredAt: null,
  };
}

// ===========================================================================
// A stand-in for club_wod_board_json(), the ONE definition of a board that
// all six RPCs return. Faithful in the three ways the client depends on:
//
//   * EVERY KEY IS ALWAYS PRESENT, so the empty, cancelled and not-attached
//     states need no absence tests on the client;
//   * TWO SEPARATE PRIVACY GATES - visible_to_club decides whether a member
//     is LISTED, show_workout_results (DEFAULT FALSE) decides whether their
//     FIGURE comes back, and result_count is counted over the same filtered
//     set as the list so no aggregate discloses someone the viewer cannot see;
//   * `results` ORDERED BY attached_at, never by anything score-shaped.
//
// It is not a reimplementation of the migration - the real gates are
// Postgres's - only enough server for the client's own logic to be exercised
// honestly.
// ===========================================================================
function boardJson(db, sessionId, viewerId) {
  const s = (db.club_wod_sessions || []).find((r) => r.id === sessionId);
  if (!s) return null;
  const rows = (db.club_wod_results || [])
    .filter((r) => r.session_id === sessionId)
    .sort((a, b) => String(a.attached_at).localeCompare(String(b.attached_at)));
  const visible = rows.filter((r) => r.user_id === viewerId || PEOPLE[r.user_id].visible_to_club !== false);
  const results = visible.map((r) => {
    const p = PEOPLE[r.user_id];
    const maySee = r.user_id === viewerId || p.show_workout_results === true;
    return {
      user_id: r.user_id, display_name: p.display_name, handle: p.handle, avatar_url: null,
      is_viewer: r.user_id === viewerId,
      result_text: maySee ? r.result_text : null,
      result_hidden: r.result_text != null && !maySee,
      score_type: r.score_type, rx: r.rx, occurred_on: r.occurred_on, attached_at: r.attached_at,
    };
  });
  const mine = rows.find((r) => r.user_id === viewerId) || null;
  const closed = s.cancelled_at ? "cancelled"
    : s.session_date > TODAY ? "future"
    : s.session_date < new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10) ? "expired"
    : null;
  return {
    session_id: s.id, session_date: s.session_date, note: s.note, post_id: s.post_id,
    published_at: s.published_at,
    published_by: { id: "coach-1", display_name: "דנה", handle: "dana_k", avatar_url: null },
    cancelled_at: s.cancelled_at || null,
    wod: clubWodRow(),
    result_count: results.length,
    results,
    viewer: {
      attached: !!mine,
      result_text: mine ? mine.result_text : null,
      score_type: mine ? mine.score_type : null,
      rx: mine ? mine.rx : null,
      occurred_on: mine ? mine.occurred_on : null,
      attached_at: mine ? mine.attached_at : null,
      can_attach: closed === null,
      // Detaching is ALWAYS available, including from a cancelled or an
      // expired board: a member must be able to take their own result down.
      can_detach: !!mine,
      closed_reason: closed,
    },
  };
}

function installBoardRpcs(mock, viewerId, canProgram) {
  const board = (ctx, id) => boardJson(ctx.db, id, viewerId);
  mock.onRpc("club_wods_list", (a, ctx) => ({ data: (ctx.db.club_wods || []).slice(), error: null }));
  mock.onRpc("club_wod_boards", (a, ctx) => ({
    data: (ctx.db.club_wod_sessions || [])
      .filter((s) => s.session_date === TODAY && !s.cancelled_at)
      .map((s) => board(ctx, s.id)),
    error: null,
  }));
  mock.onRpc("club_wod_board", (a, ctx) => {
    const b = board(ctx, a.p_session_id);
    return b ? { data: b, error: null } : { data: null, error: { message: "session not found" } };
  });
  mock.onRpc("club_wod_session_publish", (a, ctx) => {
    if (!canProgram) return { data: null, error: { message: "not authorized" } };
    const date = a.p_session_date || TODAY;
    const rows = (ctx.db.club_wod_sessions = ctx.db.club_wod_sessions || []);
    if (!(ctx.db.club_wods || []).some((w) => w.id === a.p_wod_id)) {
      return { data: null, error: { message: "wod not found" } };
    }
    if (rows.filter((r) => r.session_date === date && !r.cancelled_at).length >= 4) {
      return { data: null, error: { message: "too many sessions posted for that day" } };
    }
    const existing = rows.find((r) => r.wod_id === a.p_wod_id && r.session_date === date);
    if (existing && !existing.cancelled_at) {
      if (String(existing.note || "") !== String(a.p_note || "")) return { data: null, error: { message: "session already posted" } };
      return { data: board(ctx, existing.id), error: null };
    }
    const id = existing ? existing.id : SESSION_ID;
    const postId = `post-${id}`;
    // The card. source_type and source_id are left NULL on purpose - the
    // session id travels in metadata, because this card opens a BOARD.
    (ctx.db.workout_posts = ctx.db.workout_posts || []).push({
      id: postId, author_id: "coach-1", post_type: "POST_CLUB_WOD", visibility: "club",
      title: clubWodRow().name, body: a.p_note || null, occurred_on: date,
      source_type: null, source_id: null,
      metadata: { club_wod_session_id: id, club_wod_id: a.p_wod_id, session_date: date, score_type: "time" },
      status: "active", created_at: new Date().toISOString(), published_at: new Date().toISOString(),
    });
    if (existing) Object.assign(existing, { cancelled_at: null, note: a.p_note || "", post_id: postId });
    else rows.push({ id, wod_id: a.p_wod_id, session_date: date, note: a.p_note || "", post_id: postId, published_at: new Date().toISOString(), cancelled_at: null });
    return { data: board(ctx, id), error: null };
  });
  mock.onRpc("club_wod_session_cancel", (a, ctx) => {
    if (!canProgram) return { data: null, error: { message: "not authorized" } };
    const s = (ctx.db.club_wod_sessions || []).find((r) => r.id === a.p_session_id);
    if (!s) return { data: null, error: { message: "session not found" } };
    // DELETES NOTHING: the card is withdrawn, the board closes, every
    // attached result survives.
    s.cancelled_at = new Date().toISOString();
    return { data: board(ctx, s.id), error: null };
  });
  mock.onRpc("club_wod_attach_result", (a, ctx) => {
    const s = (ctx.db.club_wod_sessions || []).find((r) => r.id === a.p_session_id);
    if (!s) return { data: null, error: { message: "session not found" } };
    if (s.cancelled_at) return { data: null, error: { message: "this board is closed" } };
    if (s.session_date > TODAY) return { data: null, error: { message: "the session has not happened yet" } };
    if (!a.p_record_id) return { data: null, error: { message: "record is required" } };
    const entry = a.p_entry || null;
    if (entry && String(entry.wodId || "") !== s.wod_id) {
      return { data: null, error: { message: "that result is for a different workout" } };
    }
    // THE FIGURE IS RECOMPUTED SERVER-SIDE from clamped structured fields -
    // no caller string is ever stored. p_entry is the fallback the client
    // sends so a member with cloud backup OFF still gets a figure.
    const secs = entry && entry.scoreType === "time" ? Number(entry.timeSeconds || 0) : null;
    const text = secs == null ? null
      : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}${entry.rx === false && entry.scaledWeight ? ` @ ${entry.scaledWeight} ק"ג` : ""}`;
    const rows = (ctx.db.club_wod_results = ctx.db.club_wod_results || []);
    const prior = rows.find((r) => r.session_id === s.id && r.user_id === viewerId);
    // One member, one row, one board. A second attach REPLACES the figure and
    // deliberately does NOT bump attached_at, so re-attaching cannot move
    // anyone up a list ordered by it.
    if (prior) Object.assign(prior, { record_id: a.p_record_id, result_text: text, score_type: entry && entry.scoreType, rx: entry ? entry.rx !== false : null, occurred_on: entry && entry.date });
    else rows.push({ session_id: s.id, user_id: viewerId, record_id: a.p_record_id, result_text: text,
      score_type: entry && entry.scoreType, rx: entry ? entry.rx !== false : null,
      occurred_on: entry && entry.date, attached_at: new Date(Date.now() + rows.length).toISOString() });
    return { data: board(ctx, s.id), error: null };
  });
  mock.onRpc("club_wod_detach_result", (a, ctx) => {
    const s = (ctx.db.club_wod_sessions || []).find((r) => r.id === a.p_session_id);
    if (!s) return { data: null, error: { message: "session not found" } };
    ctx.db.club_wod_results = (ctx.db.club_wod_results || []).filter((r) => !(r.session_id === s.id && r.user_id === viewerId));
    return { data: board(ctx, s.id), error: null };
  });
}

function personaMock(who, shared) {
  const p = PEOPLE[who];
  const db = Object.assign({
    profiles: Object.values(PEOPLE).map((x) => ({
      id: x.id, handle: x.handle, display_name: x.display_name, is_admin: false,
      recovery_verified_at: VERIFIED, visible_to_club: true,
      show_workout_results: x.show_workout_results, in_leaderboards: true,
    })),
    invite_redemptions: Object.values(PEOPLE).map((x) => ({ user_id: x.id, invite_id: "inv-1", role: x.role, redeemed_at: VERIFIED })),
    club_wods: [clubWodRow()],
    club_wod_sessions: [], club_wod_results: [], workout_posts: [],
    clubs: [{ id: "club-1", name: "חיימוניה", member_count: 12 }],
  }, shared || {});
  const mock = createMockSupabase(db);
  mock.setUser({ id: p.id, is_anonymous: false, email: `${p.handle}@members.haimuniya.invalid` });
  installBoardRpcs(mock, p.id, p.role === "coach");
  return mock;
}

async function openCommunity(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityClubTop"), 5000);
}
// The feed reads feed_page_rows, so the card the coach's publish minted has
// to be handed to the next persona the way the real feed would hand it over.
function feedRowsFrom(db) {
  return (db.workout_posts || []).map((p) => Object.assign({}, p, { author_handle: "dana_k", author_display_name: "דנה", author_is_staff: true, reaction_count: 0, comment_count: 0 }));
}
// Logs one WOD in the REAL log form, the way a member does.
async function logTheWod(window, minutes, seconds, rx, scaledWeight) {
  window.document.getElementById("tabWodBtn").click();
  window.choosePickedWod(WOD_ID);
  window.render();
  window.applyFieldValue("wod-step", "wodMinutes", minutes);
  window.applyFieldValue("wod-step", "wodSeconds", seconds);
  answerWodRx(window, rx);
  if (scaledWeight) window.applyFieldValue("wod-step", "wodScaledWeight", scaledWeight);
  await window.saveWod();
}

// ===========================================================================
// THE LOOP. This is the feature; everything below it is an invariant it needs.
// ===========================================================================
test("a coach publishes today's WOD, a member logs it and attaches from the log form, a second member sees the board - and a member whose results are private is LISTED WITHOUT A FIGURE", async () => {
  // ---- ACT ONE: the coach programs the day ------------------------------
  const coachMock = personaMock("coach-1");
  const coach = await bootCommunity(coachMock, { syncEnabled: false });
  await openCommunity(coach);
  await waitFor(() => coachMock.callsTo("club_wod_boards").length > 0, 5000);

  // Nothing is programmed yet. A member would see NOTHING here; the coach -
  // the only person who can fix an empty feed - sees the door.
  await waitFor(() => !!coach.document.querySelector('[data-empty-state="club-wod-today-none"]'), 4000);
  const form = coach.document.getElementById("communityClubWodSession");
  assert.ok(form, "a community.challenge.create holder gets the publish form");
  form.elements.wodId.value = WOD_ID;
  form.elements.sessionDate.value = TODAY;
  form.elements.note.value = "21-15-9. חמים טוב לפני.";
  form.dispatchEvent(new coach.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => coachMock.callsTo("club_wod_session_publish").length === 1, 5000);

  const sent = coachMock.callsTo("club_wod_session_publish")[0];
  assert.equal(sent.p_wod_id, WOD_ID);
  assert.equal(sent.p_session_date, TODAY);
  assert.equal(sent.p_note, "21-15-9. חמים טוב לפני.");
  assert.equal(coachMock.db.club_wod_sessions.length, 1, "ONE session");
  assert.equal(coachMock.db.workout_posts.filter((p) => p.post_type === "POST_CLUB_WOD").length, 1, "and ONE card");

  // The strip is now what the box is doing today, at ZERO member results -
  // which is the whole point: the card is worth reading before anybody has
  // contributed anything.
  await waitFor(() => !!coach.document.querySelector('[data-community-action="open-club-wod-board"][data-source="strip"]'), 4000);
  // Design direction C turned this strip into the club's BOARD, so the empty
  // state is worded as a board is ("nobody yet - you could be first") rather
  // than as a data table with no rows. The assertion that matters is
  // unchanged: at zero results the surface still says so in words, instead of
  // rendering a blank the reader has to interpret.
  assert.match(coach.document.getElementById("content").textContent, /עדיין אף אחד/);

  const publishedDb = coachMock.db;

  // ---- ACT TWO: a member logs it, and attaches from the log form ---------
  // The whole premise: attaching costs less than composing. The member never
  // opens a composer and never visits the feed.
  const noaMock = personaMock("member-1", {
    club_wod_sessions: publishedDb.club_wod_sessions.map((s) => Object.assign({}, s)),
    club_wod_results: [],
    workout_posts: publishedDb.workout_posts.map((p) => Object.assign({}, p)),
    feed_page_rows: feedRowsFrom(publishedDb),
  });
  const noa = await bootCommunity(noaMock, { syncEnabled: false });
  await openCommunity(noa);
  await waitFor(() => noaMock.callsTo("club_wod_boards").length > 0, 5000);

  // BEFORE LOGGING. The board says the session is open (can_attach true), and
  // the client still offers no way onto it - because THE CLIENT OWNS THE ONE
  // FACT THE SERVER CANNOT KNOW: this member has not logged this WOD. The log
  // is local-first and cloud backup is opt-out, so viewer.attached answers
  // "is your result on the board", never "did you do it".
  noa.document.getElementById("tabWodBtn").click();
  noa.choosePickedWod(WOD_ID);
  noa.render();
  await waitFor(() => !!noa.document.getElementById("wodContent"), 3000);
  assert.equal(noa.document.querySelector('[data-action="attach-club-wod-result"]'), null,
    "no attach control before the member has logged it - participation is never inferred");
  assert.match(noa.document.getElementById("wodContent").textContent, /אחרי שתרשמו את האימון כאן/);

  // AFTER LOGGING. Same screen, same form, one new button.
  await logTheWod(noa, 8, 42, true);
  noa.choosePickedWod(WOD_ID);
  noa.render();
  await waitFor(() => !!noa.document.querySelector('[data-action="attach-club-wod-result"]'), 4000);
  const attachBtn = noa.document.querySelector('[data-action="attach-club-wod-result"]');
  assert.equal(attachBtn.dataset.id, SESSION_ID, "it names the session, not the WOD");
  assert.match(attachBtn.textContent, /8:42/, "and it shows the member WHICH of their results it will attach");

  attachBtn.click();
  await waitFor(() => noaMock.callsTo("club_wod_attach_result").length === 1, 5000);
  const att = noaMock.callsTo("club_wod_attach_result")[0];
  assert.equal(att.p_session_id, SESSION_ID);
  assert.ok(att.p_record_id, "a record id, never a typed string");
  // p_entry: the entry the client already holds, sent so a member with cloud
  // backup OFF still lands on the board with a figure. It is a fallback, not
  // a claim - the server prefers its own copy and re-formats either source.
  assert.equal(att.p_entry.wodId, WOD_ID);
  assert.equal(att.p_entry.scoreType, "time");
  assert.equal(att.p_entry.timeSeconds, 8 * 60 + 42);
  assert.equal(noaMock.db.club_wod_results.length, 1);
  assert.equal(noaMock.db.club_wod_results[0].result_text, "8:42", "the figure came from structured fields");
  // FIFTEEN RESULTS PRODUCE ZERO EXTRA POSTS. Attaching costs no feed slot,
  // which is the reason a member will do it and the reason the feed cannot
  // flood.
  assert.equal(noaMock.db.workout_posts.filter((p) => p.post_type !== "POST_CLUB_WOD").length, 0,
    "attaching creates no post at all");
  await waitFor(() => /התוצאה שלך על הלוח/.test(noa.document.getElementById("wodContent").textContent), 4000);

  // ---- ACT THREE: a second member, on the board -------------------------
  // itai_r has show_workout_results TRUE; noa_s has it FALSE, which is the
  // shipped DEFAULT.
  const afterAttach = noaMock.db;
  const itaiMock = personaMock("member-2", {
    club_wod_sessions: afterAttach.club_wod_sessions.map((s) => Object.assign({}, s)),
    club_wod_results: afterAttach.club_wod_results.map((r) => Object.assign({}, r)),
    workout_posts: afterAttach.workout_posts.map((p) => Object.assign({}, p)),
    feed_page_rows: feedRowsFrom(afterAttach),
  });
  const itai = await bootCommunity(itaiMock, { syncEnabled: false });
  await openCommunity(itai);
  await waitFor(() => !!itai.document.querySelector('[data-post-type="POST_CLUB_WOD"]'), 6000);

  // THE CARD, AND THE TRAP. POST_CLUB_WOD rows carry source_type and
  // source_id NULL on purpose. renderWorkoutPostCard's deep link defaults a
  // missing source_type to "workout", so a card that fell through to it would
  // offer to open a workout that does not exist. renderPostCard branches on
  // the type FIRST, and this card opens the BOARD.
  const card = itai.document.querySelector('[data-post-type="POST_CLUB_WOD"]');
  assert.equal(card.querySelector("[data-source-type]"), null,
    "no data-source-type deep link on a card whose source_type is deliberately null");
  assert.equal(card.querySelector('[data-community-action="open-source"]'), null);
  const openBoard = card.querySelector('[data-community-action="open-club-wod-board"]');
  assert.ok(openBoard, "the card opens the board");
  assert.equal(openBoard.dataset.id, SESSION_ID, "off metadata.club_wod_session_id");
  // It is worth reading before it is opened: the programming itself is on it.
  assert.match(card.textContent, /Dana's Chipper/);
  assert.match(card.textContent, /21-15-9/);

  itai.document.querySelector('[data-post-type="POST_CLUB_WOD"] [data-community-action="open-club-wod-board"]').click();
  await waitFor(() => !!itai.document.querySelector('[data-cloud-dialog="clubWodBoard"]'), 5000);
  const boardEl = itai.document.querySelector('[data-cloud-dialog="clubWodBoard"]');

  // THE PRIVACY CLAIM, SHOWN. noa_s is ON the board - she attached, so being
  // listed is consented - and her FIGURE is not there. The toggle strips the
  // number; it does not remove the member.
  const noaRow = boardEl.querySelector('[data-club-wod-user="member-1"]');
  assert.ok(noaRow, "a member with show_workout_results false is STILL LISTED");
  assert.match(noaRow.textContent, /נועה/, "by name");
  assert.match(noaRow.textContent, /התוצאה מוסתרת/, "and the client says HIDDEN, which is a different fact from 'no result'");
  assert.equal(/8:42/.test(boardEl.textContent), false, "her figure is nowhere on this viewer's board");

  // And the two states sit in ONE list. itai_r attaches his own scaled
  // result; it lands beside noa_s's Rx one, in attach order, with no
  // separation and no ranking.
  await logTheWod(itai, 11, 5, false, 30);
  itai.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!itai.document.querySelector('[data-cloud-dialog="clubWodBoard"] [data-community-action="club-wod-attach"]'), 5000);
  itai.document.querySelector('[data-cloud-dialog="clubWodBoard"] [data-community-action="club-wod-attach"]').click();
  await waitFor(() => itaiMock.callsTo("club_wod_attach_result").length === 1, 5000);
  await waitFor(() => !!itai.document.querySelector('[data-club-wod-user="member-2"]'), 5000);

  const rows = Array.prototype.map.call(
    itai.document.querySelectorAll('[data-cloud-dialog="clubWodBoard"] [data-club-wod-user]'),
    (n) => n.dataset.clubWodUser);
  assert.deepEqual(rows, ["member-1", "member-2"], "attached_at order - the order people trained in");
  const itaiRow = itai.document.querySelector('[data-club-wod-user="member-2"]');
  assert.match(itaiRow.textContent, /11:05/, "his own figure is always his to see");
  assert.match(itaiRow.textContent, /מותאם/, "scaled is labelled, not segregated");
  // Two members, two results, one board, zero extra posts, and nobody typed
  // a word.
  assert.match(itai.document.querySelector('[data-cloud-dialog="clubWodBoard"]').textContent, /2 מהמועדון על הלוח/);
});

// ===========================================================================
// The invariants that loop depends on.
// ===========================================================================

test("the card branches on POST_CLUB_WOD BEFORE the data-source-type deep link, which is the trap this post type sets", () => {
  // Source-level, because the dispatch table is what makes the ordering true
  // for every future card as well as for the one the loop above rendered.
  assert.match(cloudJs, /POST_CLUB_WOD: renderClubWodPostCard,/,
    "registered in the one dispatch, so renderWorkoutPostCard can never see this type");
  const start = cloudJs.indexOf("function renderClubWodPostCard(post)");
  const body = cloudJs.slice(start, cloudJs.indexOf("\n  }", start));
  assert.ok(start > -1, "the renderer exists");
  assert.equal(/data-source-type/.test(body), false,
    "source_type is null on these rows and the default is 'workout' - this card must emit no such link");
  assert.match(body, /metadata.*club_wod_session_id|m\.club_wod_session_id/,
    "the session id travels in metadata, which feed_page passes through untouched");
});

test("every control is built off the board's `viewer`, never off a re-derivation of the rules", async () => {
  // The refusal and the board have to agree. can_attach / can_detach /
  // closed_reason are the server's answers, asked in the same order the write
  // path raises in - so a client that recomputed them from session_date and
  // cancelled_at would be a second, drifting copy of a rule it does not own.
  const start = cloudJs.indexOf("function renderClubWodViewerPanel(board, v)");
  const body = cloudJs.slice(start, cloudJs.indexOf("\n  }\n\n  function renderClubWodBoardBody", start));
  assert.ok(start > -1);
  assert.match(body, /viewer\.can_attach/);
  assert.match(body, /viewer\.can_detach/);
  assert.match(body, /viewer\.closed_reason/);
  assert.equal(/session_date|cancelled_at/.test(body), false,
    "the viewer panel must not re-derive open/closed from the raw columns");

  // And the closed states SAY why rather than hiding a control. A session
  // posted for tomorrow is the reachable one.
  const mock = personaMock("member-1", {
    club_wod_sessions: [{ id: SESSION_ID, wod_id: WOD_ID, session_date: TOMORROW, note: "", post_id: "post-x", published_at: new Date().toISOString(), cancelled_at: null }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  window.openClubWodBoard(SESSION_ID);
  await waitFor(() => {
    const el = window.document.querySelector('[data-cloud-dialog="clubWodBoard"]');
    return el && /נקבע למחר/.test(el.textContent);
  }, 5000);
  assert.equal(window.document.querySelector('[data-community-action="club-wod-attach"]'), null,
    "no attach control on a future board - and the reason is on screen");
});

test("a cancelled board still opens by id, and detaching still works on it", async () => {
  // A member holding a result on a withdrawn board must always be able to
  // take it down - not blocked by the cancellation, not by an expiry, not by
  // a posting restriction. That is why club_wod_detach_result carries no
  // permission check and no window check, and why can_detach is independent
  // of can_attach.
  const mock = personaMock("member-1", {
    club_wod_sessions: [{ id: SESSION_ID, wod_id: WOD_ID, session_date: TODAY, note: "", post_id: "post-x", published_at: new Date().toISOString(), cancelled_at: new Date().toISOString() }],
    club_wod_results: [{ session_id: SESSION_ID, user_id: "member-1", record_id: "wod-1", result_text: "8:42", score_type: "time", rx: true, occurred_on: TODAY, attached_at: new Date().toISOString() }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  window.openClubWodBoard(SESSION_ID);
  await waitFor(() => !!window.document.querySelector('[data-community-action="club-wod-detach"]'), 5000);
  assert.match(window.document.querySelector('[data-cloud-dialog="clubWodBoard"]').textContent, /בוטל/,
    "the board says it was cancelled");
  window.document.querySelector('[data-community-action="club-wod-detach"]').click();
  await waitFor(() => mock.callsTo("club_wod_detach_result").length === 1, 5000);
  assert.equal(mock.db.club_wod_results.length, 0);
});

test("nothing ranks: no position, no sort, and the ranked conventions are not borrowed", () => {
  const start = cloudJs.indexOf("// THE FEED WRITES ITSELF - club WOD sessions and boards");
  const end = cloudJs.indexOf("async function loadInactiveMembers");
  // Comments stripped first: this section EXPLAINS at length why it is not a
  // leaderboard and names every convention it refuses to borrow, so a sweep
  // over the raw text would be tripped by the reasoning rather than by code.
  const section = stripComments(cloudJs.slice(start, end));
  assert.ok(start > -1 && end > start);
  // The table has no score_value, score_direction or rank column BY DESIGN,
  // asserted as a catalog property in pgTAP. This is the client half of the
  // same promise: there is nothing here that could build a ranking even from
  // data that did carry one.
  for (const forbidden of [/\.sort\(/, /\brank\b/, /score_value/, /score_direction/, /renderRankedList/, /leaderboardRowHtml/, /🏆/]) {
    assert.equal(forbidden.test(section), false, `the club WOD board must not use ${forbidden} - it is not a leaderboard`);
  }
  // results are rendered in the order they arrived, full stop.
  assert.match(section, /board\.results\.map\(\(r\) => renderClubWodResultRow\(r, board\.session_date\)\)/,
    "rendered in the order they arrived, full stop");
});

test("the attach CTA is driven by app.js's own log, because the server cannot know whether a member logged anything", () => {
  // The bridge, and the reason it exists: cloud backup is opt-OUT, so
  // private_records may simply not hold the entry. The board reports only
  // the board.
  assert.match(appJs, /window\.communityWodLogFor = function \(wodId\)/);
  assert.match(appJs, /window\.communityWodEntryForAttach = function \(recordId\)/);
  assert.match(cloudJs, /function clubWodLoggedEntries\(wodId\)/);
  assert.match(cloudJs, /window\.communityWodLogFor/);
  // And it is an OFFER, never an act: no code path attaches because an entry
  // happens to match the day or the WOD.
  const start = appJs.indexOf("function renderClubWodAttachAffordance(w)");
  const body = appJs.slice(start, appJs.indexOf("\n}", start));
  assert.ok(start > -1);
  assert.match(body, /data-action="attach-club-wod-result"/);
  assert.equal(/attachClubWodResult\(/.test(body), false,
    "the renderer offers the control; it never performs the attach");
});

test("show_workout_results is never written, and the hint LINKS to the privacy screen instead", () => {
  // The single most important negative in this feature. It defaults FALSE, so
  // the honest shipped state is a board of names with few numbers - and that
  // is arguably the better first state, since the beginner persona found
  // leaderboards intimidating and "eight people did this today" is a roll
  // call. The client must not flip it, or offer to.
  for (const src of [cloudJs, appJs]) {
    assert.equal(/show_workout_results"?\s*[:,]\s*(true|false)/.test(src), false,
      "no client code writes show_workout_results");
    assert.equal(/savePrivacyField\("show_workout_results"/.test(src), false,
      "and it is never routed through the privacy writer either");
  }
  // What IS offered: a link.
  assert.match(cloudJs, /data-community-action="open-privacy-settings"/);
  assert.match(cloudJs, /function openPrivacySettings\(\)/);
  assert.match(cloudJs, /id="communityPrivacyPanel"/, "the link has somewhere to land");
  assert.match(appJs, /data-action="open-community-privacy"/);
  // Read-only bridge: app.js can ASK whether the figure reaches the club, and
  // has no way to change the answer.
  assert.match(cloudJs, /window\.communityShowsWorkoutResults = function \(\)/);
  assert.equal(/window\.setCommunityShowsWorkoutResults|communitySetWorkoutResults/.test(cloudJs), false);
});

test("the member's own hidden figure produces a hint that links, and no toggle", async () => {
  const mock = personaMock("member-1", {
    club_wod_sessions: [{ id: SESSION_ID, wod_id: WOD_ID, session_date: TODAY, note: "", post_id: "post-x", published_at: new Date().toISOString(), cancelled_at: null }],
    club_wod_results: [{ session_id: SESSION_ID, user_id: "member-1", record_id: "wod-1", result_text: "8:42", score_type: "time", rx: true, occurred_on: TODAY, attached_at: new Date().toISOString() }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(window);
  window.openClubWodBoard(SESSION_ID);
  await waitFor(() => {
    const el = window.document.querySelector('[data-cloud-dialog="clubWodBoard"]');
    return el && /להגדרות הפרטיות/.test(el.textContent);
  }, 5000);
  const panel = window.document.querySelector('[data-cloud-dialog="clubWodBoard"]');
  assert.match(panel.textContent, /לא את התוצאה עצמה/, "it states the fact");
  assert.equal(panel.querySelector('input[type="checkbox"][data-privacy-field]'), null,
    "and offers no toggle - not even a convenience one");
  const link = panel.querySelector('[data-community-action="open-privacy-settings"]');
  assert.ok(link, "the only affordance is the link");
  link.click();
  await waitFor(() => !!window.document.getElementById("communityPrivacyPanel"), 5000);
  assert.equal(window.document.querySelector('[data-cloud-dialog="clubWodBoard"]'), null,
    "the board closes first - the privacy panel lives under an overlay that would cover it");
});

test("publish and cancel are shown only to a community.challenge.create holder, and the DB is the real boundary", async () => {
  // isStaff() would be wrong here and is not used: it also admits the `staff`
  // role, which holds no challenge permission at all. The UI gate is a
  // display rule; both RPCs check the permission themselves.
  assert.match(cloudJs, /function clubWodCanProgram\(\) \{ return hasPerm\(PERM\.CHALLENGE_CREATE\); \}/);
  const start = cloudJs.indexOf("// THE FEED WRITES ITSELF - club WOD sessions and boards");
  const section = stripComments(cloudJs.slice(start, cloudJs.indexOf("async function loadInactiveMembers")));
  assert.equal(/isStaff\(\)/.test(section), false, "not isStaff() - the `staff` role holds no challenge permission");

  const member = await bootCommunity(personaMock("member-1", {
    club_wod_sessions: [{ id: SESSION_ID, wod_id: WOD_ID, session_date: TODAY, note: "", post_id: "post-x", published_at: new Date().toISOString(), cancelled_at: null }],
  }), { syncEnabled: false });
  await openCommunity(member);
  await waitFor(() => !!member.document.querySelector('[data-community-action="open-club-wod-board"]'), 5000);
  assert.equal(member.document.getElementById("communityClubWodSession"), null, "a member gets no publish form");
  member.openClubWodBoard(SESSION_ID);
  await waitFor(() => !!member.document.querySelector('[data-cloud-dialog="clubWodBoard"]'), 5000);
  assert.equal(member.document.querySelector('[data-community-action="club-wod-cancel-confirm"]'), null,
    "and no cancel control");
});

test("cancelling asks first, says nothing is deleted, and withdraws the card without touching the results", async () => {
  const mock = personaMock("coach-1", {
    club_wod_sessions: [{ id: SESSION_ID, wod_id: WOD_ID, session_date: TODAY, note: "", post_id: "post-x", published_at: new Date().toISOString(), cancelled_at: null }],
    club_wod_results: [{ session_id: SESSION_ID, user_id: "member-1", record_id: "wod-1", result_text: "8:42", score_type: "time", rx: true, occurred_on: TODAY, attached_at: new Date().toISOString() }],
  });
  const coach = await bootCommunity(mock, { syncEnabled: false });
  await openCommunity(coach);
  coach.openClubWodBoard(SESSION_ID);
  await waitFor(() => !!coach.document.querySelector('[data-community-action="club-wod-cancel-confirm"]'), 5000);
  coach.document.querySelector('[data-community-action="club-wod-cancel-confirm"]').click();
  await waitFor(() => !!coach.document.querySelector('[data-community-action="confirm-yes"]'), 4000);
  // The destructive-language rule: "ביטול" reads like a delete, and this one
  // deletes nothing, so the sheet has to say so before the member decides.
  const sheet = coach.document.querySelector('[data-cloud-dialog="confirmSheet"]');
  assert.match(sheet.textContent, /שום תוצאה לא נמחקת/);
  coach.document.querySelector('[data-community-action="confirm-yes"]').click();
  await waitFor(() => mock.callsTo("club_wod_session_cancel").length === 1, 5000);
  assert.equal(mock.db.club_wod_results.length, 1, "the attached results survive a cancellation");
  assert.ok(mock.db.club_wod_sessions[0].cancelled_at);
});

test("every refusal these six RPCs can raise is mapped to Hebrew, and none of them says 'try again'", () => {
  // The strings below are the REAL ones: each was produced by calling the RPC
  // against the local Supabase stack with a real JWT (dana_k as the coach,
  // noa_s as a member) and recording what came back - the same method
  // community-error-copy.test.mjs's own table was built with.
  const start = cloudJs.indexOf("const SERVER_ERROR_TEXT");
  const table = cloudJs.slice(start, cloudJs.indexOf("\n  };", start));
  const raised = [
    "wod not found", "wod is retired", "session already posted",
    "too many sessions posted for that day",
    "a session can only be posted for yesterday, today or tomorrow",
    "session not found", "this board is closed", "the session has not happened yet",
    "record is required", "that result is for a different workout",
  ];
  for (const key of raised) {
    assert.ok(table.includes(`"${key}":`), `${key} reaches a member unmapped`);
  }
  // Not a style rule: every one of these is a STABLE STATE, so a retry cannot
  // succeed, and a sentence that invites one is a sentence that wastes the
  // member's time and hides the move that would actually work.
  const section = table.slice(table.indexOf('"wod is retired"'), table.indexOf('"session expired"'));
  assert.equal(/לנסות שוב/.test(section), false, "nothing here may say 'try again' - none of it can succeed on a retry");
});
