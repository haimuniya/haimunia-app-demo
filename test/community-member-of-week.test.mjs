// COMM-315, client half: member-of-the-week rotation across recognition
// categories. Schema half shipped in 202609010001_member_of_week.sql
// (member_of_week_category/_category_label, member_of_week_candidates(),
// member_of_week_publish()) - see that migration's own comments and
// contracts.md's "Needs from schema, member of the week" for the exact
// envelope shape and the five real Postgres errors member_of_week_publish()
// raises.
//
// Executed for real (bootCommunity + the mock Supabase client), the same
// way test/community-coach-tools.test.mjs drives Celebrate/Welcome/Engage -
// real render/click paths against a real (if hand-rolled) member_of_week_candidates
// / member_of_week_publish stand-in, not source-text matches.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

function seeded(extra) {
  const mock = createMockSupabase(Object.assign({
    profiles: [
      { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: "u9", handle: "noa", display_name: "נועה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
      { id: "u-prev", handle: "yael", display_name: "יעל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    ],
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: "coach", redeemed_at: VERIFIED },
      { user_id: "u9", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: "u-prev", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    community_streaks: [], workout_posts: [], feed_page_rows: [], member_contact_log: [],
    coach_engagement_flags: [], analytics_events: [], notifications: [], notification_preferences: [],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}
async function openCoachTab(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="coach"]').click();
}

function computedEnvelope(overrides) {
  return Object.assign({
    week_start: "2026-08-31",
    category: "most_prs",
    category_label: "שיאים אישיים השבוע",
    rotation_index: 1,
    free_selection: false,
    published: null,
    previous_week_user_id: null,
    candidates: [],
  }, overrides || {});
}

// --- loading / error / retry ------------------------------------------------

test("Member of the Week shows the loading skeleton, then the populated section labelled with the week's category", async () => {
  const mock = seeded({});
  let resolveCands;
  mock.onRpc("member_of_week_candidates", () => new Promise((resolve) => { resolveCands = resolve; }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => window.document.body.textContent.includes("חבר/ת השבוע"), 3000);
  assert.ok(window.document.querySelector('[aria-busy="true"]'), "a loading skeleton renders while the envelope is in flight");

  resolveCands({
    data: [computedEnvelope({
      candidates: [{ user_id: "u9", handle: "noa", display_name: "נועה", avatar_url: null, value: 3, detail: { pr_count: 3 } }],
    })],
    error: null,
  });
  await waitFor(() => window.document.body.textContent.includes("שיאים אישיים השבוע"), 3000);
});

test("a load error shows the standard message with a working retry", async () => {
  const mock = seeded({});
  let calls = 0;
  mock.onRpc("member_of_week_candidates", () => {
    calls++;
    return calls === 1 ? { data: null, error: { message: "boom" } } : { data: [computedEnvelope({ candidates: [] })], error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => window.document.body.textContent.includes("לא ניתן היה לטעון את המועמדים."), 3000);
  window.document.querySelector('[data-community-action="coach-mow-retry"]').click();
  await waitFor(() => window.document.body.textContent.includes("אין מועמדים השבוע לקטגוריה זו"), 3000);
});

// --- populated / empty / coachs_pick states ---------------------------------

test("Populated: computed candidates render with their category-shaped detail and a per-candidate Publish, alongside the coach's-pick free-selection form", async () => {
  const mock = seeded({});
  mock.onRpc("member_of_week_candidates", () => ({
    data: [computedEnvelope({
      category: "consistency_streak",
      category_label: "עקביות באימונים",
      candidates: [{ user_id: "u9", handle: "noa", display_name: "נועה", avatar_url: null, value: 4, detail: { streak_weeks: 4, rank: 1 } }],
    })],
    error: null,
  }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="coach-mow-publish-candidate"]'), 3000);
  const row = window.document.querySelector('[data-community-action="coach-mow-publish-candidate"]').closest(".log-row");
  assert.match(row.textContent, /נועה/);
  assert.match(row.textContent, /4 שבועות/);
  // The free-selection ("coach's pick") form is offered beside the
  // suggestions, not only as an empty-state fallback - COMM-315's own
  // "Populated" frontend state names both together.
  assert.ok(window.document.querySelector('[data-mow-pick-handle]'), "the coach's-pick form is present alongside a non-empty suggestion list");
  assert.ok(window.document.querySelector('[data-mow-pick-reason]'), "the reason field is present too");
});

test("Empty: a computed category with zero candidates shows the exact Hebrew empty copy, and still offers the coach's-pick fallback form", async () => {
  const mock = seeded({});
  mock.onRpc("member_of_week_candidates", () => ({ data: [computedEnvelope({ category: "most_prs", candidates: [] })], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => window.document.body.textContent.includes("אין מועמדים השבוע לקטגוריה זו"), 3000);
  assert.ok(window.document.querySelector('[data-mow-pick-handle]'), "staff can still fall back to a coach's pick from the empty state");
});

test("the coachs_pick week shows only the free-selection form - no candidate list and no empty message, since it is the category's own definition", async () => {
  const mock = seeded({});
  mock.onRpc("member_of_week_candidates", () => ({
    data: [computedEnvelope({ category: "coachs_pick", category_label: "בחירת המאמן/ת", free_selection: true, candidates: [] })],
    error: null,
  }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-mow-pick-handle]'), 3000);
  assert.equal(window.document.body.textContent.includes("אין מועמדים השבוע לקטגוריה זו"), false, "the coachs_pick week is never rendered as the empty state");
  assert.equal(window.document.querySelector('[data-community-action="coach-mow-publish-candidate"]'), null, "there is no computed candidate to publish on a coachs_pick week");
});

test("published: shows who/what was published instead of any suggestion UI - the publish action is spent for the week", async () => {
  const mock = seeded({});
  mock.onRpc("member_of_week_candidates", () => ({
    data: [computedEnvelope({
      category: "most_prs",
      category_label: "שיאים אישיים השבוע",
      candidates: [{ user_id: "u9", handle: "noa", display_name: "נועה", avatar_url: null, value: 3, detail: { pr_count: 3 } }],
      published: { id: "mow-1", user_id: "u9", category: "most_prs", reason: "", post_id: "post-1", published_at: VERIFIED },
    })],
    error: null,
  }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => window.document.body.textContent.includes("חבר/ת השבוע"), 3000);
  await waitFor(() => window.document.body.textContent.includes("נועה"), 3000);
  assert.equal(window.document.querySelector('[data-community-action="coach-mow-publish-candidate"]'), null, "no publish control once the week is already published");
  assert.equal(window.document.querySelector('[data-mow-pick-handle]'), null, "no free-selection form either - the action is spent for the week");
});

// --- the previous week's member is named, not merely hidden -----------------

test("the free-selection form names last week's member so a coach does not discover the once-per-two-weeks rule by hitting it", async () => {
  const mock = seeded({});
  mock.onRpc("member_of_week_candidates", () => ({
    data: [computedEnvelope({ category: "coachs_pick", free_selection: true, candidates: [], previous_week_user_id: "u-prev" })],
    error: null,
  }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => window.document.body.textContent.includes("יעל"), 3000);
  assert.match(window.document.body.textContent, /נבחר.*בשבוע שעבר/);
});

// --- publishing a computed candidate -----------------------------------------

test("publishing a computed candidate sends {p_week_start:null, p_user_id, p_reason:''} and re-fetches the envelope on success", async () => {
  const mock = seeded({});
  let loadCalls = 0;
  mock.onRpc("member_of_week_candidates", () => {
    loadCalls++;
    if (loadCalls === 1) {
      return {
        data: [computedEnvelope({
          category: "most_prs", category_label: "שיאים אישיים השבוע",
          candidates: [{ user_id: "u9", handle: "noa", display_name: "נועה", avatar_url: null, value: 3, detail: { pr_count: 3 } }],
        })],
        error: null,
      };
    }
    return {
      data: [computedEnvelope({
        category: "most_prs", category_label: "שיאים אישיים השבוע",
        candidates: [{ user_id: "u9", handle: "noa", display_name: "נועה", avatar_url: null, value: 3, detail: { pr_count: 3 } }],
        published: { id: "mow-1", user_id: "u9", category: "most_prs", reason: "", post_id: "post-1", published_at: VERIFIED },
      })],
      error: null,
    };
  });
  const calls = [];
  mock.onRpc("member_of_week_publish", (args) => { calls.push(args); return { data: "mow-1", error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="coach-mow-publish-candidate"]'), 3000);
  window.document.querySelector('[data-community-action="coach-mow-publish-candidate"]').click();
  await waitFor(() => calls.length === 1, 3000);
  assert.deepEqual(calls[0], { p_week_start: null, p_user_id: "u9", p_reason: "" });
  await waitFor(() => window.document.querySelector('[data-community-action="coach-mow-publish-candidate"]') == null, 3000);
  assert.match(window.document.body.textContent, /נועה/);
});

test("publishing the same candidate twice in a row is a no-op the second time - a disabled control produces no second call", async () => {
  const mock = seeded({});
  mock.onRpc("member_of_week_candidates", () => ({
    data: [computedEnvelope({
      candidates: [
        { user_id: "u9", handle: "noa", display_name: "נועה", avatar_url: null, value: 3, detail: { pr_count: 3 } },
      ],
    })],
    error: null,
  }));
  let resolvePublish;
  mock.onRpc("member_of_week_publish", () => new Promise((resolve) => { resolvePublish = resolve; }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="coach-mow-publish-candidate"]'), 3000);
  const btn = () => window.document.querySelector('[data-community-action="coach-mow-publish-candidate"]');
  btn().click();
  await waitFor(() => btn().disabled === true, 3000);
  const before = mock.callsTo("member_of_week_publish").length;
  btn().click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(mock.callsTo("member_of_week_publish").length, before, "a busy control produces no second call");
  resolvePublish({ data: "mow-1", error: null });
});

// --- the coach's-pick free-selection form ------------------------------------

test("the coach's-pick form requires both a handle and a non-empty reason before it ever calls the server", async () => {
  const mock = seeded({});
  mock.onRpc("member_of_week_candidates", () => ({
    data: [computedEnvelope({ category: "coachs_pick", free_selection: true, candidates: [] })],
    error: null,
  }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-mow-pick-handle]'), 3000);
  window.document.querySelector('[data-community-action="coach-mow-publish-pick"]').click();
  await waitFor(() => window.document.body.textContent.includes("יש להזין שם משתמש."), 3000);
  assert.equal(mock.callsTo("member_of_week_publish").length, 0);

  const handleInput = window.document.querySelector('[data-mow-pick-handle]');
  handleInput.value = "noa";
  handleInput.dispatchEvent(new window.Event("input", { bubbles: true }));
  window.document.querySelector('[data-community-action="coach-mow-publish-pick"]').click();
  await waitFor(() => window.document.body.textContent.includes("יש להזין סיבה לבחירת המאמן/ת."), 3000);
  assert.equal(mock.callsTo("member_of_week_publish").length, 0, "a handle with no reason still never reaches the server");
});

test("the coach's-pick form resolves a typed handle to an id and publishes with the typed reason", async () => {
  const mock = seeded({});
  mock.onRpc("member_of_week_candidates", () => ({
    data: [computedEnvelope({ category: "coachs_pick", free_selection: true, candidates: [] })],
    error: null,
  }));
  const calls = [];
  mock.onRpc("member_of_week_publish", (args) => { calls.push(args); return { data: "mow-2", error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-mow-pick-handle]'), 3000);
  const handleInput = window.document.querySelector('[data-mow-pick-handle]');
  handleInput.value = "noa";
  handleInput.dispatchEvent(new window.Event("input", { bubbles: true }));
  const reasonInput = window.document.querySelector('[data-mow-pick-reason]');
  reasonInput.value = "עבדה קשה כל החודש";
  reasonInput.dispatchEvent(new window.Event("input", { bubbles: true }));
  window.document.querySelector('[data-community-action="coach-mow-publish-pick"]').click();
  await waitFor(() => calls.length === 1, 3000);
  assert.deepEqual(calls[0], { p_week_start: null, p_user_id: "u9", p_reason: "עבדה קשה כל החודש" });
});

test("the coach's-pick form's reason field carries a live 500-char counter", async () => {
  const mock = seeded({});
  mock.onRpc("member_of_week_candidates", () => ({
    data: [computedEnvelope({ category: "coachs_pick", free_selection: true, candidates: [] })],
    error: null,
  }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-mow-pick-reason]'), 3000);
  assert.equal(window.document.querySelector('[data-mow-pick-counter]').textContent, "0/500");
  const reasonInput = window.document.querySelector('[data-mow-pick-reason]');
  reasonInput.value = "מצוין";
  reasonInput.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(window.document.querySelector('[data-mow-pick-counter]').textContent, "5/500");
});

// --- server error mapping ----------------------------------------------------

test("each of the five real server refusals maps to its own short Hebrew message", async () => {
  const cases = [
    ["week already published", "כבר פורסם"],
    ["member was recognised last week", "בשבוע שעבר"],
    ["member not found", "לא נמצא"],
    ["member is not visible to the club", "גלוי/ה למועדון"],
    ["reason required for a coach's pick", "יש להזין סיבה"],
  ];
  for (const [serverMessage, expectedFragment] of cases) {
    const mock = seeded({});
    mock.onRpc("member_of_week_candidates", () => ({
      data: [computedEnvelope({
        candidates: [{ user_id: "u9", handle: "noa", display_name: "נועה", avatar_url: null, value: 1, detail: { pr_count: 1 } }],
      })],
      error: null,
    }));
    mock.onRpc("member_of_week_publish", () => ({ data: null, error: { message: serverMessage } }));
    const window = await bootCommunity(mock, { syncEnabled: false });
    await openCoachTab(window);
    await waitFor(() => !!window.document.querySelector('[data-community-action="coach-mow-publish-candidate"]'), 3000);
    window.document.querySelector('[data-community-action="coach-mow-publish-candidate"]').click();
    try {
      await waitFor(() => window.document.body.textContent.includes(expectedFragment), 3000);
    } catch (e) {
      throw new Error(`expected "${expectedFragment}" for server message "${serverMessage}": ${e.message}`);
    }
    // The control re-enables so the coach can retry (or fall back to the
    // coach's-pick form) rather than being stuck on a dead button.
    await waitFor(() => window.document.querySelector('[data-community-action="coach-mow-publish-candidate"]').disabled === false, 3000);
  }
});

test("an unmapped server error falls back to the same generic retry copy the rest of the coach-tools cluster uses", async () => {
  const mock = seeded({});
  mock.onRpc("member_of_week_candidates", () => ({
    data: [computedEnvelope({
      candidates: [{ user_id: "u9", handle: "noa", display_name: "נועה", avatar_url: null, value: 1, detail: { pr_count: 1 } }],
    })],
    error: null,
  }));
  mock.onRpc("member_of_week_publish", () => ({ data: null, error: { message: "some_new_server_message" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!window.document.querySelector('[data-community-action="coach-mow-publish-candidate"]'), 3000);
  window.document.querySelector('[data-community-action="coach-mow-publish-candidate"]').click();
  await waitFor(() => window.document.body.textContent.includes("הפרסום נכשל. נסו שוב."), 3000);
});
