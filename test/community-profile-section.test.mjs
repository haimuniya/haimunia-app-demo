// COMM-180. The member profile community section: header (photo, name, role,
// member since, Follow) plus Overview / Progress / Achievements / Posts tabs.
// Every field is filtered server-side by community_profile; the client just
// renders what comes back and omits absent fields rather than showing blanks.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

function seeded(profileView) {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    community_feed: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  mock.onRpc("community_profile", (args, ctx) => {
    ctx.db.__profileArg = args;
    return { data: profileView, error: null };
  });
  return mock;
}

async function openProfile(window, userId = "u2") {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.eval(`window.__vp = "${userId}";`);
  // Reach the profile through the same action the feed and search use.
  const el = window.document.createElement("button");
  el.dataset.communityAction = "view-profile";
  el.dataset.id = userId;
  window.document.body.appendChild(el);
  el.click();
  await waitFor(() => !!window.document.getElementById("profileViewTitle"), 3000);
  await waitFor(() => !/טוען פרופיל/.test(window.document.getElementById("profileViewTitle").closest(".modal-sheet").textContent), 3000);
}

test("a full profile renders the header and all four tabs, and only the fields present come back", async () => {
  const mock = seeded({
    display_name: "רון לוי", role: "coach", member_since: "2023-04-01",
    training_frequency: "3 בשבוע", current_streak: 5,
    recent_workouts: [{ title: "Grace", date: "2026-08-26" }],
    achievements: [{ title: "מאה אימונים", badge_icon: "🏅" }],
    posts: [{ id: "pp1", post_type: "POST_TEXT", author_id: "u2", display_name: "רון לוי", body: "פוסט בפרופיל", published_at: VERIFIED }],
    // prs deliberately absent -> Progress is hidden, not blank
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openProfile(window);

  assert.equal(mock.db.__profileArg.user_id, "u2");
  const overlay = window.document.getElementById("profileViewTitle").closest(".modal-sheet");
  assert.match(overlay.textContent, /רון לוי/);
  assert.match(overlay.textContent, /מאמן\/ת/);
  assert.match(overlay.textContent, /חבר\/ה מאז 2023-04-01/);
  assert.ok(overlay.querySelector('[data-community-action="follow"][data-id="u2"]'));
  for (const t of ["overview", "progress", "achievements", "posts"]) {
    assert.ok(overlay.querySelector(`[data-community-action="profile-tab"][data-tab="${t}"]`), `${t} tab`);
  }
  assert.match(overlay.textContent, /3 בשבוע/);

  overlay.querySelector('[data-community-action="profile-tab"][data-tab="progress"]').click();
  await waitFor(() => /ההתקדמות מוסתרת/.test(window.document.getElementById("profileViewTitle").closest(".modal-sheet").textContent), 3000);

  window.document.querySelector('[data-community-action="profile-tab"][data-tab="posts"]').click();
  await waitFor(() => !!window.document.querySelector('.modal-sheet .post-card[data-post-id="pp1"]'), 3000);
});

test("a fully private profile shows only name, role and member since, with empty states per tab", async () => {
  const mock = seeded({ display_name: "מוסתר", role: "member", member_since: "2024-01-01" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openProfile(window);
  const overlay = window.document.getElementById("profileViewTitle").closest(".modal-sheet");
  assert.match(overlay.textContent, /מוסתר/);
  assert.match(overlay.textContent, /חבר\/ה מאז 2024-01-01/);
  assert.match(overlay.textContent, /אין מידע להצגה/);

  overlay.querySelector('[data-community-action="profile-tab"][data-tab="achievements"]').click();
  await waitFor(() => /ההישגים מוסתרים/.test(window.document.getElementById("profileViewTitle").closest(".modal-sheet").textContent), 3000);

  window.document.querySelector('[data-community-action="profile-tab"][data-tab="posts"]').click();
  await waitFor(() => /אין עדיין פוסטים/.test(window.document.getElementById("profileViewTitle").closest(".modal-sheet").textContent), 3000);
});

test("the profile overlay closes on its close button and on Escape", async () => {
  const mock = seeded({ display_name: "רון", role: "member", member_since: "2024-01-01" });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openProfile(window);
  window.document.querySelector('[data-community-action="close-profile"]').click();
  await waitFor(() => !window.document.getElementById("profileViewTitle"), 3000);

  await openProfile(window);
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor(() => !window.document.getElementById("profileViewTitle"), 3000);
});
