// Five-persona UX audit, defects 1 and 2, in the admin member-management
// panel and the moderation queue.
//
// DEFECT 1 - THE GUARD WAS ON THE WRONG DIRECTION. Granting coach opened a
// confirmation. Revoking the same permission fired on a single click, off a
// list of visually near-identical rows, with no dialog, no undo and an
// audit row written before the admin knew anything had happened. The same
// inversion existed one control over: head_coach -> coach ("הורדה למאמן/ת")
// opened the PROMOTION dialog, worded "להעניק הרשאת מאמן/ת" and styled
// non-destructively, so both directions of one control read alike.
//
// DEFECT 2 - NO CONFIRMATION NAMED ITS SUBJECT. "הגבלת פרסום קבועה" and
// "לחסום את המשתמש?" are dialogs opened FROM A LIST about a specific human,
// and neither said which one. That is the mechanism by which the wrong
// member gets actioned.
//
// THE ROUTE TAKEN, because a previous pass took a different one. Commit
// 05e1ee5 concluded askConfirm() "structurally cannot carry a name that
// mixes Latin and Hebrew" and built renderGhostReclaimSheet() as a
// dedicated dialog. That conclusion held for the MESSAGE field only - one
// flat esc()'d run, into which a name cannot be spliced without being
// reordered against the Hebrew around it, and into which a <bdi> cannot be
// spliced at all because esc() would render the tag as literal text. So the
// name no longer travels inside the message: the message carries a
// {subject} TOKEN, the name rides beside it as `subject`, and
// subjectSentenceHtml() joins the escaped sentence fragments around a
// bidiText()-isolated name. esc() runs over every part, nothing is
// bypassed, EVERY existing askConfirm call site is fixed at once, and
// CLOUD_DIALOGS stays at 13 (no fourth pattern - see the count pinned in
// community-state-namespaces.test.mjs).
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const src = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const VERIFIED = new Date().toISOString();

// דנה כהן holds a coach role; the admin acting on her is יעל בר. "Dana K"
// is the mixed-script case: a Latin display name inside an RTL Hebrew
// sentence, which is the whole reason the name is isolated rather than
// concatenated.
function adminMock(overrides) {
  const mock = createMockSupabase(Object.assign({
    profiles: [
      { id: "adm-1", handle: "yael_b", display_name: "יעל בר", is_admin: true, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: "coach-1", handle: "dana_k", display_name: "דנה כהן", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: "mem-1", handle: "kobi", display_name: "קובי", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    ],
    invite_redemptions: [
      { user_id: "adm-1", invite_id: "i1", role: "member", redeemed_at: VERIFIED },
      { user_id: "coach-1", invite_id: "i2", role: "coach", redeemed_at: VERIFIED },
      { user_id: "mem-1", invite_id: "i3", role: "member", redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    admin_actions: [], reports: [], pins: [], posting_restrictions: [],
    workout_posts: [], feed_page_rows: [], follows: [], hidden_posts: [],
    saved_posts: [], notifications: [],
  }, overrides || {}));
  mock.setUser({ id: "adm-1", is_anonymous: false, email: "yael@members.haimuniya.invalid" });
  return mock;
}

async function gotoManage(window, subtab) {
  await waitFor(() => !!window.document.getElementById("tabManageBtn"), 4000);
  window.document.getElementById("tabManageBtn").click();
  await waitFor(() => !!window.document.querySelector(`[data-community-action="set-manage-tab"][data-tab="${subtab}"]`), 4000);
  window.document.querySelector(`[data-community-action="set-manage-tab"][data-tab="${subtab}"]`).click();
}

// Drives the real search box, so the rows under test are the ones an admin
// would actually be looking at when they click - which is also what
// subjectNameFor() resolves the name from.
async function searchMembers(window, mock, results, query) {
  mock.onRpc("admin_search_members", () => ({ data: results, error: null }));
  await gotoManage(window, "members");
  const input = window.document.getElementById("adminMemberSearch");
  input.value = query;
  input.dispatchEvent(new window.Event("input"));
  await waitFor(() => results.every((r) => window.document.body.textContent.includes(r.display_name || r.handle)), 3000);
}

function memberRow(over) {
  return Object.assign({ id: "coach-1", handle: "dana_k", display_name: "דנה כהן", role: "coach", redeemed_at: VERIFIED, last_activity_on: null, is_admin: false }, over || {});
}

const dialog = (window) => window.document.querySelector('[data-cloud-dialog="confirmSheet"]');

// ===== DEFECT 1: the destructive direction is guarded at least as well ====

test("revoking coach opens a confirmation instead of firing on the click, and calls nothing until it is confirmed", async () => {
  const mock = adminMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await searchMembers(window, mock, [memberRow()], "dana");

  const revoke = window.document.querySelector('[data-community-action="admin-revoke-coach"][data-id="coach-1"]');
  assert.ok(revoke, "the revoke control is on the row");
  revoke.click();
  await waitFor(() => !!dialog(window), 3000);
  // The whole defect in one assertion: the click alone changed nothing.
  assert.equal(mock.callsTo("admin_revoke_coach").length, 0, "a single click must not revoke");
  assert.equal(mock.db.admin_actions.length, 0, "and must not write an audit row");

  window.document.querySelector('[data-community-action="confirm-yes"]').click();
  await waitFor(() => mock.callsTo("admin_revoke_coach").length === 1, 3000);
  assert.equal(mock.db.invite_redemptions.find((r) => r.user_id === "coach-1").role, "member");
  assert.ok(mock.db.admin_actions.some((a) => a.action_type === "role_change" && a.target_id === "coach-1"),
    "the action still completes and still writes its audit row");
});

test("cancelling the revoke confirmation leaves the coach a coach", async () => {
  const mock = adminMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await searchMembers(window, mock, [memberRow()], "dana");
  window.document.querySelector('[data-community-action="admin-revoke-coach"]').click();
  await waitFor(() => !!dialog(window), 3000);
  window.document.querySelector('[data-community-action="confirm-no"]').click();
  await waitFor(() => !dialog(window), 3000);
  assert.equal(mock.callsTo("admin_revoke_coach").length, 0);
  assert.equal(mock.db.invite_redemptions.find((r) => r.user_id === "coach-1").role, "coach");
});

test("the revoke dialog is styled destructive, while the grant it mirrors is not", async () => {
  const mock = adminMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await searchMembers(window, mock, [memberRow({ id: "mem-1", handle: "kobi", display_name: "קובי", role: "member" })], "kobi");
  // Constructive direction: grant.
  window.document.querySelector('[data-community-action="admin-grant-coach"]').click();
  await waitFor(() => !!dialog(window), 3000);
  assert.equal(dialog(window).querySelector('[data-community-action="confirm-yes"]').classList.contains("danger"), false);
  window.document.querySelector('[data-community-action="confirm-no"]').click();
  await waitFor(() => !dialog(window), 3000);

  // Destructive direction: revoke. Both ask; only this one is red.
  await searchMembers(window, mock, [memberRow()], "dana");
  window.document.querySelector('[data-community-action="admin-revoke-coach"]').click();
  await waitFor(() => !!dialog(window), 3000);
  assert.equal(dialog(window).querySelector('[data-community-action="confirm-yes"]').classList.contains("danger"), true);
});

test("head_coach -> coach asks as a demotion, not as a grant", async () => {
  const mock = adminMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await searchMembers(window, mock, [memberRow({ role: "head_coach" })], "dana");
  const demote = window.document.querySelector('[data-community-action="admin-set-role"][data-role="coach"]');
  assert.ok(demote, "the demotion control is on the row for a head coach");
  demote.click();
  await waitFor(() => !!dialog(window), 3000);
  const text = dialog(window).textContent;
  assert.match(text, /להוריד/, "the sentence says it lowers the role");
  assert.doesNotMatch(text, /להעניק/, "it must not reuse the promotion wording");
  assert.match(text, /דנה כהן/);
  assert.equal(dialog(window).querySelector('[data-community-action="confirm-yes"]').classList.contains("danger"), true);
});

test("removing a member still confirms, names the member, and writes its audit row on confirm", async () => {
  const mock = adminMock();
  let removed = null;
  mock.onRpc("admin_remove_member", (args, ctx) => {
    removed = args.p_user_id;
    ctx.db.admin_actions.push({ id: "aa-rm", admin_id: "adm-1", action_type: "member_restrict", target_type: "member", target_id: args.p_user_id, before_data: null, after_data: { removed: true }, created_at: new Date().toISOString() });
    return { data: null, error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await searchMembers(window, mock, [memberRow()], "dana");
  window.document.querySelector('[data-community-action="admin-remove-member"]').click();
  await waitFor(() => !!dialog(window), 3000);
  assert.match(dialog(window).textContent, /דנה כהן/, "the removal names who is being removed");
  assert.equal(removed, null, "nothing removed before the confirmation");
  window.document.querySelector('[data-community-action="confirm-yes"]').click();
  await waitFor(() => removed === "coach-1", 3000);
  assert.ok(mock.db.admin_actions.some((a) => a.target_id === "coach-1"));
});

// A source guard rather than one test per control: the point of defect 1 is
// that ONE control was missed, so what needs pinning is the rule, not the
// three call sites that happened to be found.
test("every person-scoped confirmation carries a named subject, and no person-scoped destructive action bypasses the dialog", () => {
  const calls = src.match(/askConfirm\(\{[^\n]*payload: \{ userId[^\n]*\}\)/g) || [];
  assert.ok(calls.length >= 5, `expected the person-scoped confirmations to be found, got ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /\{subject\}/, `this confirmation does not name its subject: ${call.slice(0, 90)}`);
    assert.match(call, /subject: subjectNameFor\(/, `this confirmation does not resolve a name: ${call.slice(0, 90)}`);
  }
  // The click handler may open a dialog for these; it may never call the
  // mutating function itself. runConfirm() is the only caller - so this
  // looks only inside window.handleCommunityClick, where `c.action === ...`
  // (runConfirm's own dispatch) cannot be mistaken for a click branch.
  const handler = src.slice(src.indexOf("window.handleCommunityClick = function (el) {"));
  for (const fn of ["adminRevokeCoach", "adminRemoveMember", "adminSetRole", "adminGrantCoach", "adminResetPassword"]) {
    const direct = new RegExp(`[^.]action === "[a-z-]+"\\)\\s*${fn}\\(`);
    assert.doesNotMatch(handler, direct, `${fn}() must not be reachable straight from a click`);
  }
});

// ===== DEFECT 2: the subject is named, and named SAFELY ==================

test("a Latin display name in an RTL sentence is bidi-isolated, not concatenated", async () => {
  const mock = adminMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await searchMembers(window, mock, [memberRow({ display_name: "Dana K" })], "dana");
  window.document.querySelector('[data-community-action="admin-revoke-coach"]').click();
  await waitFor(() => !!dialog(window), 3000);
  const bdi = Array.from(dialog(window).querySelectorAll("bdi")).find((b) => b.textContent === "Dana K");
  assert.ok(bdi, "the name is inside its own <bdi>, so it cannot be reordered against the Hebrew around it");
  assert.match(dialog(window).textContent, /להסיר הרשאת מאמן\/ת מDana K\?/);
});

test("the subject is escaped, not injected - esc() is still the only path to the DOM", async () => {
  const mock = adminMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await searchMembers(window, mock, [memberRow({ display_name: '<img src=x onerror=alert(1)> & "פ"' })], "img");
  window.document.querySelector('[data-community-action="admin-remove-member"]').click();
  await waitFor(() => !!dialog(window), 3000);
  assert.equal(dialog(window).querySelector("img"), null, "no element is created from a display name");
  assert.match(dialog(window).textContent, /<img src=x onerror=alert\(1\)> & "פ"/, "it renders as the literal text it is");
});

test("an unresolvable subject degrades to one shared wording, never to a hole in the sentence", async () => {
  const mock = adminMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await gotoManage(window, "members");
  // No search was run, so no row for this id exists on the client at all.
  window.eval('window.handleCommunityClick({ dataset: { communityAction: "admin-remove-member", id: "nobody-here" } })');
  await waitFor(() => !!dialog(window), 3000);
  assert.match(dialog(window).textContent, /להסיר את החבר\/ה מהמועדון\?/);
  assert.doesNotMatch(dialog(window).textContent, /להסיר את \?/, "never an empty subject slot");
});

test("blocking from a feed post names the author it was opened from", async () => {
  const mock = adminMock({
    workout_posts: [{ id: "post-1", author_id: "mem-1", post_type: "POST_TEXT", body: "שלום", status: "active", created_at: VERIFIED, published_at: VERIFIED }],
    feed_page_rows: [{ id: "post-1", author_id: "mem-1", post_type: "POST_TEXT", body: "שלום", created_at: VERIFIED, display_name: "קובי", handle: "kobi" }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => window.document.body.textContent.includes("קובי"), 4000);
  window.eval('window.handleCommunityClick({ dataset: { communityAction: "block", id: "mem-1" } })');
  await waitFor(() => !!dialog(window), 3000);
  assert.match(dialog(window).textContent, /לחסום את קובי\?/);
});

// ===== DEFECT 2 in the moderation queue =================================

test("a permanent posting restriction names the member it lands on, and still routes through mod_review with an audit row", async () => {
  const mock = adminMock({
    workout_posts: [{ id: "post-1", author_id: "mem-1", post_type: "POST_TEXT", body: "תוכן שדווח", status: "active", created_at: VERIFIED, published_at: VERIFIED }],
    reports: [{ id: "rep-1", reporter_id: "coach-1", target_type: "post", target_id: "post-1", reason: "harassment", note: "", status: "open", created_at: VERIFIED }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await gotoManage(window, "moderation");
  await waitFor(() => !!window.document.querySelector('[data-mod-report-id="rep-1"]'), 4000);

  window.document.querySelector('[data-community-action="mod-action"][data-decision="restrict_permanent"]').click();
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="modAction"]'), 3000);
  const sheet = window.document.querySelector('[data-cloud-dialog="modAction"]');
  const subject = sheet.querySelector('[data-mod-action-subject="1"]');
  assert.ok(subject, "the sheet no longer shows a bare decision label with no subject");
  assert.match(subject.textContent, /קובי/, "it names the reported member");
  assert.ok(subject.querySelector("bdi"), "through the same isolation every other name gets");

  sheet.querySelector('[data-community-action="mod-action-run"]').click();
  await waitFor(() => mock.callsTo("mod_review").length === 1, 3000);
  assert.equal(mock.callsTo("mod_review")[0].p_decision, "restrict_permanent");
  assert.ok(mock.db.admin_actions.some((a) => a.action_type === "member_restrict"), "the trusted function wrote the audit row");
});

test("every queue decision has a subject sentence, so none of them can ship unnamed", () => {
  const start = src.indexOf("const MOD_DECISIONS = [");
  const block = src.slice(start, src.indexOf("];", start));
  for (const id of ["remove", "warn", "restrict_temp", "restrict_permanent", "dismiss"]) {
    const line = block.split("\n").find((l) => l.includes(`id: "${id}"`));
    assert.ok(line, `${id} must be in MOD_DECISIONS`);
    assert.match(line, /effect: "[^"]*\{subject\}/, `${id} must name the member it acts on`);
  }
});

// ===== the mechanism itself ==============================================

test("subjectSentenceHtml escapes both halves and isolates only the name, and no fourth dialog was added", () => {
  const fn = src.slice(src.indexOf("function subjectSentenceHtml("), src.indexOf("function askConfirm("));
  assert.match(fn, /parts\.map\(esc\)\.join\(bidiText\(name\)\)/,
    "the sentence fragments stay esc()'d and only the name is wrapped - never the other way round");
  assert.match(fn, /\|\| CONFIRM_SUBJECT_UNKNOWN/, "one shared fallback wording, not a per-call-site one");
  // The route: askConfirm was taught to carry the subject, so this fix adds
  // no dialog. renderGhostReclaimSheet stays the only dedicated one.
  //
  // The count moved 13 -> 14 for the outward-share sheet (five-persona UX
  // audit, outward sharing) and for nothing else. That sheet is not a
  // confirmation and could not have reused askConfirm: it renders a canvas
  // preview of the image about to leave the device, a switch that repaints
  // that image, and four different exits (share, copy, download, close).
  // askConfirm is a title + message + one confirm + one cancel, with no
  // place to put any of that. Assert the exact set rather than only the
  // count, so a NEW dialog still trips this even if one is removed in the
  // same change.
  //
  // "termSheet" is the fifteenth, added by design spec section 3 (jargon
  // disclosure). Treated as the review trigger this pin is meant to be:
  //
  //   WHY A DIALOG AND NOT A REUSE. The candidates were askConfirm and the
  //   report sheet. askConfirm is a title + message + confirm + cancel and
  //   its whole shape is "make a decision" - but a term sheet asks for NO
  //   decision, has no destructive counterpart, and must be dismissible by
  //   tapping outside without anything happening. Bending askConfirm to
  //   carry a term, a gloss, a body, an optional worked example and a
  //   second page (the full glossary) would have turned it into a general
  //   dialog framework, which is precisely what this pin exists to prevent.
  //
  //   WHY IT IS THIRD. Same stacking rule as confirmSheet and outwardShare
  //   above it, applied in the other direction: a `?` marker can be rendered
  //   inside the challenge, event, recap and profile overlays' own content,
  //   so the term sheet paints on top of those and must be matched before
  //   them. It stays BELOW confirmSheet and outwardShare because neither of
  //   those can contain a term marker, so nothing can stack on top of it.
  //
  //   WHY IT IS ONE ENTRY AND NOT TWO. The full glossary is a second PAGE of
  //   this same sheet (state.ui.termGlossaryOpen), not a second dialog, so
  //   both pages share one focus trap, one Escape binding and one backdrop
  //   click instead of duplicating all three.
  const dialogs = src.slice(src.indexOf("const CLOUD_DIALOGS = ["), src.indexOf("];", src.indexOf("const CLOUD_DIALOGS = [")));
  assert.deepEqual([...dialogs.matchAll(/\{ key: "([^"]+)"/g)].map((m) => m[1]), [
    "confirmSheet", "outwardShare", "termSheet", "reportSheet", "modAction", "reclaimInvite", "modContext",
    "notifCenter", "achUnlock", "prPrompt", "composer", "profileView",
    "challengeView", "eventView", "recapView",
  ], "a dialog was added or removed - say why here and update the pin in community-state-namespaces.test.mjs too");
});
