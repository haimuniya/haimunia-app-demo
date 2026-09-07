// Five-persona UX audit, defect 3 (202609060023). The admin surface for
// incomplete signups - the "ghost accounts" every roster query in this
// module is structurally blind to.
//
// WHAT IS BEING TESTED AND WHY IT EXISTS. Signup is two-stage: the invite is
// consumed by redeem_invite_code() at the very start, and public.profiles is
// written only at the END of a three-slide intro carousel. Abandon the
// carousel and what is left is a real authenticated account holding a spent
// invite with NO profiles row - invisible in ניהול חברים and in every roster
// query, because all of them start `from public.profiles`. The club handed
// out an invite, it is gone, and until this screen existed the only way to
// find out whose it was was the Supabase SQL editor.
//
// THE PERMISSION SPLIT IS THE POINT OF HALF THIS FILE. Listing is is_staff()
// (a coach chasing a member who never showed up is the obvious first user);
// reclaiming is a real is_admin(), because it un-memberships an account. The
// client mirrors both, and the server enforces both regardless.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

function seeded(role) {
  const mock = createMockSupabase({
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: role === "admin", recovery_verified_at: VERIFIED, visible_to_club: true },
    ],
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: role === "admin" ? "member" : (role || "member"), redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    community_streaks: [], workout_posts: [], feed_page_rows: [], member_contact_log: [],
    coach_engagement_flags: [], analytics_events: [], notifications: [], notification_preferences: [],
    monthly_club_recaps: [], reports: [], challenges: [], onboarding_step_content: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

// admin_incomplete_signups()'s exact ten columns.
function ghost(extra) {
  return Object.assign({
    user_id: "ghost-1",
    username: "ghost_carousel",
    label: null,
    role: "member",
    invite_source: "shared_code",
    redeemed_at: "2026-08-18T04:26:31.730Z",
    signed_up_at: "2026-08-18T04:20:00.000Z",
    last_sign_in_at: "2026-08-18T04:26:00.000Z",
    stalled_days: 20,
    purgeable_after_reclaim: false,
  }, extra || {});
}

async function openMembersTab(window) {
  window.document.getElementById("tabManageBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-manage-tab"][data-tab="members"]').click();
}

async function bootWith(role, rows) {
  const mock = seeded(role);
  mock.onRpc("admin_member_roster", () => ({ data: [], error: null }));
  mock.onRpc("admin_incomplete_signups", () => ({ data: rows, error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openMembersTab(window);
  await waitFor(() => !!window.document.querySelector('[data-incomplete-signups-section="1"]'), 3000);
  return { mock, window };
}

test("a plain member never sees the section, and admin_incomplete_signups is never called", async () => {
  const mock = seeded("member");
  const calls = [];
  mock.onRpc("admin_incomplete_signups", (args) => { calls.push(args); return { data: [], error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  assert.equal(window.document.getElementById("tabManageBtn"), null, "a plain member never gets the Manage tab at all");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(window.document.querySelector('[data-incomplete-signups-section="1"]'), null);
  assert.equal(calls.length, 0, "the RPC is never even attempted");
});

test("THE PERMISSION SPLIT: a coach sees every unfinished signup and is offered no reclaim control at all", async () => {
  const { window } = await bootWith("coach", [ghost()]);
  await waitFor(() => window.document.body.textContent.includes("ghost_carousel"), 3000);
  const section = window.document.querySelector('[data-incomplete-signups-section="1"]');
  assert.equal(section.querySelector('[data-community-action="ghost-reclaim"]'), null,
    "not a disabled button - no button, because there is no path from a coach to this action and a disabled control would imply there is one");
  assert.match(section.textContent, /שמור למנהל\/ת/, "and the row says why, rather than silently omitting it");
});

test("an admin gets a live reclaim control, and one still inside the 7-day grace window is disabled", async () => {
  const { window } = await bootWith("admin", [
    ghost(),
    ghost({ user_id: "ghost-fresh", username: "ghost_fresh", stalled_days: 0 }),
  ]);
  await waitFor(() => window.document.body.textContent.includes("ghost_fresh"), 3000);
  const ready = window.document.querySelector('[data-ghost-user-id="ghost-1"] [data-community-action="ghost-reclaim"]');
  const fresh = window.document.querySelector('[data-ghost-user-id="ghost-fresh"] [data-community-action="ghost-reclaim"]');
  assert.equal(ready.disabled, false, "20 days stalled is past the grace window");
  assert.equal(fresh.disabled, true, "someone who redeemed today may be on slide two right now");
  assert.match(window.document.querySelector('[data-ghost-user-id="ghost-fresh"]').textContent, /עדיין בתהליך/);
});

test("THE CONFIRMATION NAMES ITS SUBJECT - the username, when there is one", async () => {
  const { window } = await bootWith("admin", [ghost()]);
  await waitFor(() => window.document.body.textContent.includes("ghost_carousel"), 3000);
  window.document.querySelector('[data-community-action="ghost-reclaim"]').click();
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="reclaimInvite"]'), 3000);
  const subject = window.document.querySelector('[data-reclaim-subject="1"]');
  assert.ok(subject, "the sheet leads with who it is about, not with a generic sentence");
  assert.match(subject.textContent, /ghost_carousel/);
});

test("...and the per-person invite's own label when the ghost never got as far as a username", async () => {
  // The hardest case the migration calls out: someone who abandoned BEFORE
  // credentials has no username anywhere, and the admin-authored invite
  // label is the only identifying string that exists in the whole system.
  const { window } = await bootWith("admin", [
    ghost({ user_id: "ghost-2", username: null, label: "דנה מהבוקר של שני", invite_source: "person_invite", stalled_days: 9, purgeable_after_reclaim: true }),
  ]);
  await waitFor(() => window.document.body.textContent.includes("דנה מהבוקר של שני"), 3000);
  window.document.querySelector('[data-community-action="ghost-reclaim"]').click();
  await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="reclaimInvite"]'), 3000);
  assert.match(window.document.querySelector('[data-reclaim-subject="1"]').textContent, /דנה מהבוקר של שני/);
});

test("the reclaim goes through admin_reclaim_invite with the account and the optional note", async () => {
  const mock = seeded("admin");
  mock.onRpc("admin_member_roster", () => ({ data: [], error: null }));
  mock.onRpc("admin_incomplete_signups", () => ({ data: [ghost()], error: null }));
  const calls = [];
  mock.onRpc("admin_reclaim_invite", (args) => {
    calls.push(args);
    return { data: { user_id: "ghost-1", invite_source: "shared_code", invite_id: "inv-1", released: true, welcome_posts_retracted: 1, purgeable_by_purge_abandoned_profiles: false }, error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openMembersTab(window);
  await waitFor(() => window.document.body.textContent.includes("ghost_carousel"), 3000);
  window.document.querySelector('[data-community-action="ghost-reclaim"]').click();
  await waitFor(() => !!window.document.querySelector("[data-reclaim-note]"), 3000);
  const note = window.document.querySelector("[data-reclaim-note]");
  note.value = "לא השלימ/ה הרשמה, שוחרר לשימוש חוזר";
  note.dispatchEvent(new window.Event("input", { bubbles: true }));
  window.document.querySelector('[data-community-action="reclaim-run"]').click();
  await waitFor(() => calls.length === 1, 3000);
  assert.equal(calls[0].p_user_id, "ghost-1");
  assert.equal(calls[0].p_note, "לא השלימ/ה הרשמה, שוחרר לשימוש חוזר",
    "admin_reclaim_invite records the note in the audit row, so it has to actually be sent");
});

test("what actually happened is surfaced, not a silent success: released, and the welcome posts retracted", async () => {
  const mock = seeded("admin");
  mock.onRpc("admin_member_roster", () => ({ data: [], error: null }));
  let listCalls = 0;
  mock.onRpc("admin_incomplete_signups", () => { listCalls++; return { data: listCalls === 1 ? [ghost()] : [], error: null }; });
  mock.onRpc("admin_reclaim_invite", () => ({ data: { user_id: "ghost-1", invite_source: "shared_code", invite_id: "inv-1", released: true, welcome_posts_retracted: 1, purgeable_by_purge_abandoned_profiles: false }, error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openMembersTab(window);
  await waitFor(() => window.document.body.textContent.includes("ghost_carousel"), 3000);
  window.document.querySelector('[data-community-action="ghost-reclaim"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="reclaim-run"]'), 3000);
  window.document.querySelector('[data-community-action="reclaim-run"]').click();
  await waitFor(() => !!window.document.querySelector('[data-reclaim-result="1"]'), 3000);
  const card = window.document.querySelector('[data-reclaim-result="1"]');
  assert.match(card.textContent, /ghost_carousel/, "the result names the subject too");
  assert.match(card.textContent, /שימוש אחד הוחזר/, "a shared code got its seat back");
  assert.match(card.textContent, /1 פוסטי/, "the club was told someone joined and the retraction is reported, not hidden");
  assert.match(card.textContent, /החשבון לא נמחק/, "and the thing an admin would otherwise assume wrongly");
  // The reclaimed row is gone from the list, because its redemption row is.
  await waitFor(() => !window.document.querySelector('[data-ghost-user-id="ghost-1"]'), 3000);
});

test("each of admin_reclaim_invite's named refusals gets its own sentence, never a generic retry", async () => {
  const cases = [
    ["member has a profile", /כבר יש פרופיל/],
    ["signup is still in progress", /עדיין בתהליך/],
    ["no invite to reclaim", /כבר שוחררה/],
    ["cannot reclaim your own invite", /של עצמך/],
  ];
  for (const [serverMessage, expected] of cases) {
    const mock = seeded("admin");
    mock.onRpc("admin_member_roster", () => ({ data: [], error: null }));
    mock.onRpc("admin_incomplete_signups", () => ({ data: [ghost()], error: null }));
    mock.onRpc("admin_reclaim_invite", () => ({ data: null, error: { message: serverMessage } }));
    const window = await bootCommunity(mock, { syncEnabled: false });
    await openMembersTab(window);
    await waitFor(() => window.document.body.textContent.includes("ghost_carousel"), 3000);
    window.document.querySelector('[data-community-action="ghost-reclaim"]').click();
    await waitFor(() => !!window.document.querySelector('[data-community-action="reclaim-run"]'), 3000);
    window.document.querySelector('[data-community-action="reclaim-run"]').click();
    await waitFor(() => !!window.document.querySelector('[data-cloud-dialog="reclaimInvite"] [role="alert"]'), 3000);
    const alert = window.document.querySelector('[data-cloud-dialog="reclaimInvite"] [role="alert"]');
    assert.match(alert.textContent, expected, `"${serverMessage}" must name its own reason`);
    assert.doesNotMatch(alert.textContent, /נסו שוב/, `"${serverMessage}" can never succeed on a retry, so it must not suggest one`);
  }
});

test("a genuinely empty list says so, and explains what an empty list means", async () => {
  const { window } = await bootWith("admin", []);
  const section = window.document.querySelector('[data-incomplete-signups-section="1"]');
  assert.match(section.textContent, /אין הרשמות שלא הושלמו/);
  assert.ok(section.querySelector(".empty"), "a real empty state, not a blank area");
});

test("the explainer says what these accounts are, and what reclaiming does NOT do", async () => {
  const { window } = await bootWith("admin", [ghost()]);
  const section = window.document.querySelector('[data-incomplete-signups-section="1"]');
  assert.match(section.textContent, /לא תקלה/, "an admin meeting this list must not read it as an error report");
  assert.match(section.textContent, /ספאם/, "nor as a spam wave");
  assert.match(section.textContent, /לא מוחק את החשבון/, "and must be told the account is not deleted");
});

test("Error state renders its own copy with a working retry", async () => {
  const mock = seeded("admin");
  mock.onRpc("admin_member_roster", () => ({ data: [], error: null }));
  let calls = 0;
  mock.onRpc("admin_incomplete_signups", () => { calls++; return calls === 1 ? { data: null, error: { message: "boom" } } : { data: [ghost()], error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openMembersTab(window);
  await waitFor(() => window.document.body.textContent.includes("לא ניתן היה לטעון את ההרשמות שלא הושלמו."), 3000);
  window.document.querySelector('[data-community-action="ghosts-retry"]').click();
  await waitFor(() => window.document.body.textContent.includes("ghost_carousel"), 3000);
});

test("Load more pages on the last row's own redeemed_at", async () => {
  const mock = seeded("admin");
  mock.onRpc("admin_member_roster", () => ({ data: [], error: null }));
  const calls = [];
  mock.onRpc("admin_incomplete_signups", (args) => {
    calls.push(args);
    if (calls.length === 1) {
      return { data: Array.from({ length: 25 }, (_, i) => ghost({ user_id: `g${i}`, username: `g${i}`, redeemed_at: `2026-08-${String(25 - i).padStart(2, "0")}T00:00:00Z` })), error: null };
    }
    return { data: [ghost({ user_id: "older", username: "older_ghost", redeemed_at: "2026-07-01T00:00:00Z" })], error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openMembersTab(window);
  await waitFor(() => window.document.body.textContent.includes("g0"), 3000);
  window.document.querySelector('[data-community-action="ghosts-more"]').click();
  await waitFor(() => calls.length === 2, 3000);
  assert.equal(calls[1].p_cursor, "2026-08-01T00:00:00Z");
  await waitFor(() => window.document.body.textContent.includes("older_ghost"), 3000);
});

test("BIDI: the username and the stalled-day count are isolated, so Hebrew around them cannot reorder them", async () => {
  const { window } = await bootWith("admin", [ghost()]);
  await waitFor(() => window.document.body.textContent.includes("ghost_carousel"), 3000);
  const row = window.document.querySelector('[data-ghost-user-id="ghost-1"]');
  const isolated = Array.from(row.querySelectorAll("bdi")).map((n) => n.textContent);
  assert.ok(isolated.includes("ghost_carousel"), "a Latin username inside an RTL paragraph must be <bdi>-isolated");
  assert.ok(isolated.some((t) => /20 ימים/.test(t)), "and so must a day count, which is a digit run in Hebrew text");
});

test("the reclaim sheet is a first-class dialog: registered, Escape-closable, and rendered last", () => {
  assert.match(cloudJs, /\{ key: "reclaimInvite", isOpen: \(\) => state\.admin\.reclaim, close: function \(\) \{ closeGhostReclaim\(\); \} \}/,
    "in CLOUD_DIALOGS, or the Tab trap and the backdrop click do not know it exists");
  assert.match(cloudJs, /if \(state\.admin\.reclaim\) \{ e\.preventDefault\(\); closeGhostReclaim\(\); return; \}/,
    "and in the Escape chain");
  assert.match(cloudJs, /renderGhostReclaimSheet\(\)/);
});

test("invite_reclaimed is labelled and filterable in the audit log it writes to", () => {
  // admin_reclaim_invite writes one invite_reclaimed admin_actions row. Without
  // a label the existing audit view renders the raw English action_type in an
  // otherwise all-Hebrew list - the exact gap auditActionLabel's own comments
  // already record for six earlier action types.
  assert.match(cloudJs, /invite_reclaimed: "שחרור הזמנה"/);
  assert.match(cloudJs, /AUDIT_ACTION_TYPES = \[[^\]]*"invite_reclaimed"/);
});
