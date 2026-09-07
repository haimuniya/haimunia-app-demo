// Three findings the five-persona UX audit left open, all inside cloud.js.
//
//  1. The coach dashboard's and analytics cards' empty states were bare
//     one-liners, against a design spec (§2.1) that asks for four slots:
//     icon / forward-looking headline / one line of explanation / a real
//     >=44px action - or, where no honest action exists, a `when`.
//  2. <input type="date"> renders mm/dd/yyyy on an en-US browser profile in
//     a Hebrew RTL app. The beginner persona typed 01/06/2026 meaning
//     1 June and the app stored 6 January. The VALUE always round-trips
//     (type=date submits ISO); the defect is what she reads while typing.
//  3. The composer's "image is decorative" checkbox row was the only one in
//     the file missing the shared `field` wrapper its siblings all use.
//
// Driven through the real render path (bootCommunity + the mock Supabase
// client) wherever the finding is about what a member SEES; source-text
// assertions only for the invariants that are about the shape of the code
// itself (which call sites exist, which tone rules hold across all of them).
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const src = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const VERIFIED = "2026-08-01T00:00:00.000Z";
const NOW = Date.now();
const daysAgoIso = (days) => new Date(NOW - days * 86400000).toISOString();

function staffMock(extra, isAdmin) {
  const mock = createMockSupabase(Object.assign({
    profiles: [{ id: "coach-1", handle: "dana_k", display_name: "דנה", is_admin: !!isAdmin, recovery_verified_at: VERIFIED, visible_to_club: true, created_at: daysAgoIso(400) }],
    invite_redemptions: [{ user_id: "coach-1", invite_id: "inv-1", role: "coach", redeemed_at: daysAgoIso(400) }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    community_streaks: [], workout_posts: [], feed_page_rows: [], member_contact_log: [],
    coach_engagement_flags: [], analytics_events: [], notifications: [], notification_preferences: [],
    monthly_club_recaps: [], reports: [], challenges: [], weekly_challenges: [], onboarding_step_content: [],
  }, extra || {}));
  mock.setUser({ id: "coach-1", is_anonymous: false, email: "dana_k@members.haimuniya.invalid" });
  return mock;
}
async function openCoachTab(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="set-tab"][data-tab="coach"]'), 4000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="coach"]').click();
}
// The staff-only weekly-challenge setter (two of the six date fields)
// renders on the Boards sub-tab, not the club home.
async function openBoards(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="set-tab"][data-tab="boards"]'), 4000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="boards"]').click();
  await waitFor(() => !!window.document.querySelector(".ach-section"), 3000);
}
const emptyState = (window, key) => window.document.querySelector(`[data-empty-state="${key}"]`);

// ===========================================================================
// FINDING 1 - the four-slot empty-state pattern
// ===========================================================================

// The structural invariant, asserted once over every call site rather than
// re-asserted per state: the whole point of the finding is that nine states
// had drifted apart, so what has to be pinned is that they can no longer.
test("every empty state renders all four slots: an icon, a headline, an explanation, and exactly one of an action or a when-line", async () => {
  const mock = staffMock({}, true);
  mock.onRpc("coach_celebrate_feed", () => ({ data: [], error: null }));
  mock.onRpc("coach_new_members", () => ({ data: [], error: null }));
  mock.onRpc("member_of_week_candidates", () => ({ data: [{ category: "most_prs", category_label: "הכי הרבה שיאים", week_start: "2026-09-07", candidates: [], free_selection: false, published: null }], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!emptyState(window, "coach-celebrate"), 4000);

  const states = [...window.document.querySelectorAll("[data-empty-state]")];
  assert.ok(states.length >= 3, "the coach dashboard renders several empty states at once on a quiet week");
  for (const el of states) {
    const key = el.getAttribute("data-empty-state");
    // Slot 1. Decorative, so aria-hidden - it carries no information the
    // headline and explanation do not already carry in words.
    const icon = el.querySelector("svg");
    assert.ok(icon, `${key}: slot 1, an icon`);
    assert.equal(icon.closest("[aria-hidden]").getAttribute("aria-hidden"), "true", `${key}: the icon is decorative, not announced`);
    assert.equal(icon.getAttribute("width"), "28", `${key}: the icon is the spec's 28px`);
    // Slots 2 and 3.
    const text = el.textContent.replace(/\s+/g, " ").trim();
    assert.ok(text.length > 40, `${key}: slot 2+3, a headline and an explanation, not a one-liner`);
    // Slot 4, exclusively one or the other.
    const action = el.querySelector("[data-community-action]");
    const hasWhen = text.length > 80;
    assert.ok(action || hasWhen, `${key}: slot 4, either a real action or a when-line`);
  }
});

test("no empty-state headline opens with a word the spec's tone rules ban, and none of them renders red", () => {
  // Tone rule 1 (spec §2.1): אין / עדיין לא / מעולם לא may not OPEN a
  // headline - a headline names what WILL be here, never what is missing.
  // Read off the source rather than the DOM so that a state which is hard to
  // reach at runtime (a permission-gated analytics card, say) is covered too.
  const headlines = [...src.matchAll(/^\s*headline: "([^"]+)"/gm)].map((m) => m[1]);
  assert.ok(headlines.length >= 11, `expected every emptyStateHtml call site to declare a headline, found ${headlines.length}`);
  for (const h of headlines) {
    assert.ok(!/^(אין|עדיין לא|מעולם לא)\b/.test(h), `headline opens with a banned word: ${h}`);
  }
  // Tone rule 2: absence is not an error. No empty state may reach for the
  // red-text token or a red ground the way the scolding badges did.
  const helper = src.slice(src.indexOf("function emptyStateHtml"), src.indexOf("function emptyStateHtml") + 2000);
  assert.equal(/--red/.test(helper), false, "no empty state renders in red - absence is not an error");
});

test("an empty state that offers an action offers a real one: >=44px, primary, and wired to a handler that actually refetches", async () => {
  // The five analytics cards are the only states that carry a button, and
  // this is why they are allowed one: pressing it genuinely fills the space,
  // because those branches are pre-fetch states rather than no-data states.
  const calls = [];
  const mock = staffMock({}, true);
  mock.onRpc("community_health_history", () => { calls.push(1); return { data: [], error: null }; });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabManageBtn").click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="set-manage-tab"]'), 4000);

  // Every action an empty state declares must be a real branch of the click
  // dispatcher - the "never a button that goes nowhere" rule, checked
  // mechanically rather than by reading.
  const actions = [...src.matchAll(/^\s*action: "([a-z-]+)", actionLabel: "([^"]+)"/gm)];
  assert.ok(actions.length >= 5, `expected the analytics cards to declare load actions, found ${actions.length}`);
  for (const [, action, label] of actions) {
    assert.ok(src.includes(`action === "${action}"`), `${action} is declared by an empty state but handled nowhere - a dead button`);
    assert.ok(label.trim().length > 0, `${action} has an empty button label`);
  }
  assert.match(src.slice(src.indexOf("function emptyStateHtml")), /chip-btn primary[\s\S]{0,200}min-height:44px/, "the action button meets the spec's 44px floor and uses the primary style");
});

test("the empty-state block is width-bounded, which is what stops it reading as broken in the 940px staff column", () => {
  // Half of this finding only reproduces at desktop width: `.empty`
  // (index.html) is text-align:center with no width bound, so in the 940px
  // staff column one short sentence lands adrift in ~900px of nothing. The
  // measurable fix is that the text block declares a max-width; jsdom does
  // no layout, so the declaration is the honest thing to pin.
  const helper = src.slice(src.indexOf("function emptyStateHtml"), src.indexOf("function emptyStateHtml") + 2000);
  assert.match(helper, /max-width:34ch/, "the headline/explanation block is bounded");
  assert.match(helper, /padding:32px 20px/, "the spec's own container padding");
  assert.match(helper, /flex-direction:column;align-items:center;gap:10px/, "centred column with the spec's 10px gap");
});

test("Celebrate's empty state says what a PR feed is built from and offers no button, because no button a coach can press puts a row in it", async () => {
  const mock = staffMock({}, true);
  mock.onRpc("coach_celebrate_feed", () => ({ data: [], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!emptyState(window, "coach-celebrate"), 4000);
  const el = emptyState(window, "coach-celebrate");
  assert.match(el.textContent, /שיאים/, "says what the list is built from");
  assert.equal(el.querySelector("button"), null, "no invented button - a coach cannot make someone hit a PR");
});

test("Celebrate and Welcome do not share one generic sentence - an empty PR feed and an empty new-member list mean different things", async () => {
  const mock = staffMock({}, true);
  mock.onRpc("coach_celebrate_feed", () => ({ data: [], error: null }));
  mock.onRpc("coach_new_members", () => ({ data: [], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!emptyState(window, "coach-celebrate"), 4000);
  await waitFor(() => !!emptyState(window, "coach-welcome"), 4000);
  const celebrate = emptyState(window, "coach-celebrate").textContent.replace(/\s+/g, " ").trim();
  const welcome = emptyState(window, "coach-welcome").textContent.replace(/\s+/g, " ").trim();
  assert.notEqual(celebrate, welcome, "the two states must not collapse into the same generic copy");
  assert.match(welcome, /הצטרף/, "the welcome list is empty because nobody joined, and says so");
});

test("Engage's empty state reads as the all-clear it is, not as a panel that failed under a red section dot", async () => {
  const mock = staffMock({}, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!emptyState(window, "coach-engage"), 4000);
  const el = emptyState(window, "coach-engage");
  // The section head is var(--red); the empty state inside it must not be.
  assert.equal(/red/.test(el.getAttribute("style") || ""), false, "an empty engagement list is good news about the club, not a fault");
  assert.equal(el.querySelector("button"), null, "there is nobody to reach out to, so no reach-out button");
});

test("the Member of the Week empty state points at the pick form already on screen instead of opening a second door onto it", async () => {
  const mock = staffMock({}, true);
  mock.onRpc("member_of_week_candidates", () => ({ data: [{ category: "most_prs", category_label: "הכי הרבה שיאים", week_start: "2026-09-07", candidates: [], free_selection: false, published: null }], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openCoachTab(window);
  await waitFor(() => !!emptyState(window, "coach-member-of-week"), 4000);
  assert.ok(window.document.querySelector("[data-mow-pick-handle]"), "the real action, the free-selection form, is rendered directly below");
  assert.equal(emptyState(window, "coach-member-of-week").querySelector("button"), null, "and is not duplicated as a button inside the empty state");
});

// ===========================================================================
// FINDING 2 - date inputs in a Hebrew RTL app
// ===========================================================================

test("every native date input in cloud.js goes through dateField, so none can ship without the disambiguating echo", () => {
  // The regression this pins: a seventh date field added later that quietly
  // reuses field() and reintroduces exactly the defect.
  const dateInputs = [...src.matchAll(/[a-zA-Z]+\((\s*)?"[^"]+", "[^"]+", "[^"]+", `<input[^`]*type="date"/g)];
  assert.ok(dateInputs.length >= 6, `expected the six known date fields, found ${dateInputs.length}`);
  for (const m of dateInputs) {
    assert.ok(m[0].startsWith("dateField("), `a type="date" input is still on plain field(): ${m[0].slice(0, 80)}`);
  }
});

test("the echo resolves the exact ambiguity the beginner persona hit: 2026-06-01 reads as June, never as January", async () => {
  const mock = staffMock({}, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.getElementById("communityWeeklyChallenge"), 4000);
  const input = window.document.querySelector('#communityWeeklyChallenge [name="startsOn"]');
  assert.equal(input.type, "date", "still a native control - no hand-rolled picker was introduced to win this");

  const echo = window.document.getElementById(input.dataset.dateEcho);
  assert.ok(echo, "the input names its own echo element");
  // Before anything is picked the slot says the echo is coming, rather than
  // sitting there as an empty frame.
  assert.match(echo.textContent, /אחרי הבחירה/);

  input.value = "2026-06-01";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.match(echo.textContent, /ביוני/, "1 June is echoed as June");
  assert.equal(/בינואר/.test(echo.textContent), false, "and never as 6 January, which is what the app used to store silently");
  assert.match(echo.textContent, /1 /, "the day is 1");
  assert.match(echo.textContent, /2026/);
});

test("the echo survives a value committed through the native picker, which does not always fire input", async () => {
  const mock = staffMock({}, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.getElementById("communityWeeklyChallenge"), 4000);
  const input = window.document.querySelector('#communityWeeklyChallenge [name="endsOn"]');
  const echo = window.document.getElementById(input.dataset.dateEcho);
  input.value = "2026-12-31";
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.match(echo.textContent, /בדצמבר/);
  assert.match(echo.textContent, /31/);
});

test("an incomplete or cleared date falls back to the pending line rather than echoing a wrong date", async () => {
  const mock = staffMock({}, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.getElementById("communityWeeklyChallenge"), 4000);
  const input = window.document.querySelector('#communityWeeklyChallenge [name="startsOn"]');
  const echo = window.document.getElementById(input.dataset.dateEcho);
  input.value = "2026-06-01";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.match(echo.textContent, /ביוני/);
  input.value = "";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.match(echo.textContent, /אחרי הבחירה/, "clearing the field clears the echo instead of stranding a stale date");
});

test("the echo is bidi-isolated, since it is a Hebrew month name between two Latin-digit runs in an RTL paragraph", async () => {
  const mock = staffMock({}, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.getElementById("communityWeeklyChallenge"), 4000);
  const input = window.document.querySelector('#communityWeeklyChallenge [name="startsOn"]');
  const echo = window.document.getElementById(input.dataset.dateEcho);
  // The isolation is the element the text is written INTO, so it survives
  // every live update rather than being rebuilt (and possibly dropped) on each.
  assert.equal(echo.tagName.toLowerCase(), "bdi", "the echo target is the <bdi> itself");
  input.value = "2026-06-01";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(echo.tagName.toLowerCase(), "bdi", "and is still a <bdi> after a live update");
  assert.equal(echo.querySelector("*"), null, "the update writes textContent, never markup - cloud.js keeps zero innerHTML sinks");
});

test("the echo does not claim a segment order, because the browser owns that and we cannot read it back", () => {
  // Deliberate: a literal "dd/mm/yyyy" hint is WRONG for exactly the member
  // this finding is about - the one whose control is painting mm/dd/yyyy.
  const helper = src.slice(src.indexOf("const HEB_MONTHS"), src.indexOf("function updateDateEcho") + 400);
  assert.equal(/dd\/mm\/yyyy|mm\/dd\/yyyy/.test(helper.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")), false,
    "no format-order string is rendered to the member");
});

test("the date value itself is untouched: the form still submits and stores ISO", async () => {
  // The finding is explicit that the value was never the bug - type="date"
  // always submits ISO. This pins that adding the echo did not make it one:
  // the echo is a second, read-only presentation of the value and is never
  // in the write path (setWeeklyChallenge still reads form.elements directly).
  const mock = staffMock({}, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.getElementById("communityWeeklyChallenge"), 4000);
  const form = window.document.getElementById("communityWeeklyChallenge");
  form.elements.title.value = "אתגר בדיקה";
  form.elements.startsOn.value = "2026-06-01";
  form.elements.endsOn.value = "2026-06-08";
  // Drive the echo too, so this covers the real "typed a date, then
  // submitted" sequence rather than a value set behind the echo's back.
  form.elements.startsOn.dispatchEvent(new window.Event("input", { bubbles: true }));
  const select = form.elements.comparisonKey;
  const firstRealKey = Array.prototype.map.call(select.options, (o) => o.value).find(Boolean);
  assert.ok(firstRealKey, "the picker offers at least one real comparison key");
  select.value = firstRealKey;
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => mock.db.weekly_challenges.length > 0, 3000);
  const row = mock.db.weekly_challenges[0];
  assert.equal(row.starts_on, "2026-06-01", "still ISO, exactly as before");
  assert.equal(row.ends_on, "2026-06-08");
});

// ===========================================================================
// FINDING 3 - the checkbox row missing the shared field wrapper
// ===========================================================================

test("the composer's decorative-image checkbox row now uses the same field wrapper as every other checkbox row", () => {
  // Re-scoped by QA from "an unstyled checkbox": index.html styles
  // input[type=checkbox] as a bare element selector, so no checkbox can be
  // individually unstyled. The outlier was layout - this row was the only
  // checkbox label on `flex gap-6` WITHOUT `field`.
  const row = src.slice(src.indexOf("data-composer-decorative") - 400, src.indexOf("data-composer-decorative") + 200);
  assert.match(row, /<label class="field flex gap-6" style="align-items:center;"><input type="checkbox" data-composer-decorative/);
  assert.equal(/margin-top:4px/.test(row), false, "the hand-rolled margin is gone; `.field + .field` supplies the 10px its siblings get");
});

test("no checkbox label in cloud.js is left on flex gap-6 without the field wrapper", () => {
  // The general form of the finding, so a future row cannot reintroduce it.
  const labels = [...src.matchAll(/<label class="([^"]*)"[^>]*>\s*<input type="checkbox"/g)];
  assert.ok(labels.length >= 4, `expected several checkbox rows, found ${labels.length}`);
  for (const [, cls] of labels) {
    if (cls.includes("flex gap-6")) {
      assert.ok(cls.includes("field"), `a checkbox row is on "flex gap-6" without the shared field wrapper: ${cls}`);
    }
  }
});

test("the decorative checkbox label wraps its text in a span, matching its siblings, rather than leaving it bare after the input", async () => {
  const mock = staffMock({}, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="set-tab"]'), 4000);
  // Source-level is the honest check for the span: reaching a composer photo
  // tile needs a real uploaded photo, which is a different test's subject.
  const tile = src.slice(src.indexOf("data-composer-decorative"), src.indexOf("data-composer-decorative") + 260);
  assert.match(tile, /\/><span style="font-size:12\.5px;color:var\(--steel\);">התמונה דקורטיבית/);
});
