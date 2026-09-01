// window.setCommunityTab / window.getCommunityNavPreview: two exports added
// solely for the parallel UI-restructuring track's new app.js nav menu to
// call into cloud.js's existing Community sub-tab logic without touching
// its closure. Not tied to any COMM ticket; covered here so the export
// contract stays honest as cloud.js changes underneath it.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

function seeded(role) {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role, redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    mod_queue: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

test("getCommunityNavPreview lists the four member sub-tabs, in order, for a plain member", async () => {
  const mock = seeded("member");
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  const preview = window.getCommunityNavPreview();
  assert.deepEqual(preview.map((t) => t.id), ["feed", "boards", "directory", "account"]);
});

test("getCommunityNavPreview adds the coach sub-tab only for staff, last", async () => {
  const mock = seeded("coach");
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  const preview = window.getCommunityNavPreview();
  assert.deepEqual(preview.map((t) => t.id), ["feed", "boards", "directory", "account", "coach"]);
});

test("setCommunityTab switches the real Community sub-tab, same as clicking the sub-tab button", async () => {
  const mock = seeded("member");
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.setCommunityTab("directory");
  await waitFor(() => window.document.querySelector('[data-community-action="set-tab"][data-tab="directory"]').classList.contains("active"), 3000);
});
