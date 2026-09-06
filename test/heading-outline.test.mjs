// COMM-329's own acceptance criterion #3 ("an axe or heading-outline scan of
// every top-level tab ... shows a non-empty, logically nested heading list")
// was never verified by an actual scanner — the ticket's own "Not done"
// section says so explicitly. No axe-core dependency exists anywhere in this
// repo (checked: not in package.json, not in node_modules, and
// scripts/browser-check has no accessibility-scan pattern to extend, only
// playwright-driven functional checks), so a real axe integration is new
// tooling, not a small addition here.
//
// A heading-outline scan, though, needs nothing beyond jsdom (already a
// devDependency, already how every other DOM-shaped test in this repo
// boots the real app). This file is that scan for the 4 solo top-level
// tabs (add/history/calendar/wod) — the ones COMM-329's own "Shipped
// 2026-09-02" note says renderTabHeader() already covers. It checks the
// two things acceptance criterion #3 actually asks for: the heading list
// inside <main> is non-empty, and it never skips a level on the way deeper
// (h3 with no ancestor h2, etc.) - the real definition of "logically
// nested" a screen-reader user's heading navigation depends on.
//
// The community screens (feed/profile/challenges/admin) named in the same
// criterion are NOT covered here: reaching them needs a signed-in
// community fixture (bootCommunity + a mock Supabase project, admin/coach
// role fixtures for the admin panels) wired up per screen, which is real,
// separate work - see the COMM-329 ticket file's "Not done" section.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp, bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

function headingOutline(container) {
  return Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6")).map((h) => Number(h.tagName[1]));
}

function assertLogicallyNested(levels, label) {
  assert.ok(levels.length > 0, `${label}: expected at least one heading, found none`);
  let max = 0;
  for (const level of levels) {
    assert.ok(level <= max + 1, `${label}: heading level jumped from h${max} to h${level} with nothing in between (outline: ${levels.map((l) => "h" + l).join(" > ")})`);
    max = Math.max(max, level);
  }
}

const SOLO_TABS = [
  { id: "add", btn: "tabAddBtn" },
  { id: "history", btn: "tabHistoryBtn" },
  { id: "calendar", btn: "tabCalendarBtn" },
  { id: "wod", btn: "tabWodBtn" },
];

for (const { id, btn } of SOLO_TABS) {
  test(`heading outline: the "${id}" tab has a non-empty, logically nested heading list inside <main>`, async () => {
    const window = await bootApp();
    window.document.getElementById(btn).click();
    const main = window.document.querySelector("main");
    assert.ok(main, "expected a <main> landmark");
    const levels = headingOutline(main);
    assertLogicallyNested(levels, id);
    // Each solo tab is its own single screen inside one <main> - exactly one
    // h1 (its renderTabHeader() page title), not zero and not several.
    assert.equal(levels.filter((l) => l === 1).length, 1, `${id}: expected exactly one h1`);
  });
}

// Manage is not a solo bootApp() tab - it is staff-only and lives behind
// bootCommunity's mock Supabase project, same as every other community
// surface. Not part of the COMM-329 "Not done" list of community screens
// (feed/profile/challenges/admin) either; it did not exist yet when that
// note was written (Redesign, Phase 1 added it later) - covered here
// instead, extending this file's own solo-tab pattern rather than
// starting a second heading-outline file just for one more tab.
test('heading outline: the "manage" tab (dashboard sub-tab) has a non-empty, logically nested heading list inside <main>', async () => {
  const VERIFIED = new Date().toISOString();
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: true, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabManageBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  const main = window.document.querySelector("main");
  assert.ok(main, "expected a <main> landmark");
  const levels = headingOutline(main);
  assertLogicallyNested(levels, "manage");
  assert.equal(levels.filter((l) => l === 1).length, 1, "manage: expected exactly one h1");
});
