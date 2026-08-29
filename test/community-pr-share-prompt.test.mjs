// COMM-105. The PR share prompt. On PR_CREATED from the event bus a member
// sees a prompt with Share, Add photo, Add note, Not now. It never
// auto-publishes. Share calls pr_share. Not now dismisses without a post and
// does not nag again for the same record. Escape maps to Not now.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

function seeded() {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    community_feed: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  mock.onRpc("pr_share", (args, ctx) => { ctx.db.__prShare = args; return { data: "pr-post-1", error: null }; });
  return mock;
}

const RECORD = { record_id: "rec-42", movement: "Deadlift", new_result: '180 ק"ג', previous_result: '172.5 ק"ג', improvement: '+7.5 ק"ג', achieved_on: "2026-08-28" };

async function bootReady(mock) {
  const window = await bootCommunity(mock, { syncEnabled: false });
  await waitFor(() => window.isCommunitySignedIn && window.isCommunitySignedIn(), 3000);
  return window;
}

function emitPr(window, record = RECORD) {
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record });
}

test("PR_CREATED shows a prompt with Share, Add photo, Add note and Not now, and never auto-posts", async () => {
  const mock = seeded();
  const window = await bootReady(mock);
  emitPr(window);
  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);
  const p = window.document.getElementById("prPrompt");
  assert.match(p.textContent, /שיא חדש זוהה/);
  assert.match(p.textContent, /Deadlift/);
  assert.match(p.textContent, /180/);
  assert.ok(p.querySelector('[data-community-action="pr-share"]'));
  assert.ok(p.querySelector("[data-pr-file]"), "Add photo");
  assert.ok(p.querySelector('[data-community-action="pr-add-note"]'), "Add note");
  assert.ok(p.querySelector('[data-community-action="pr-not-now"]'), "Not now");
  assert.equal(mock.db.__prShare, undefined, "nothing published just from the event");
});

test("Add note reveals a note field and Share sends it to pr_share with the record id", async () => {
  const mock = seeded();
  const window = await bootReady(mock);
  emitPr(window);
  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);
  window.document.querySelector('[data-community-action="pr-add-note"]').click();
  await waitFor(() => !!window.document.querySelector("[data-pr-note]"), 3000);
  const note = window.document.querySelector("[data-pr-note]");
  note.value = "שבירת מחסום";
  note.dispatchEvent(new window.Event("input", { bubbles: true }));
  window.document.querySelector('[data-community-action="pr-share"]').click();
  await waitFor(() => !!mock.db.__prShare, 3000);
  assert.equal(mock.db.__prShare.record_id, "rec-42");
  assert.equal(mock.db.__prShare.note, "שבירת מחסום");
  assert.deepEqual(mock.db.__prShare.media, []);
  await waitFor(() => !window.document.getElementById("prPrompt"), 3000);
});

test("Not now dismisses with no post and does not re-prompt for the same record", async () => {
  const mock = seeded();
  const window = await bootReady(mock);
  emitPr(window);
  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);
  window.document.querySelector('[data-community-action="pr-not-now"]').click();
  await waitFor(() => !window.document.getElementById("prPrompt"), 3000);
  assert.equal(mock.db.__prShare, undefined);

  emitPr(window);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(window.document.getElementById("prPrompt"), null, "same record does not nag again");

  emitPr(window, { ...RECORD, record_id: "rec-99" });
  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);
});

test("Escape maps to Not now", async () => {
  const mock = seeded();
  const window = await bootReady(mock);
  emitPr(window);
  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor(() => !window.document.getElementById("prPrompt"), 3000);
  assert.equal(mock.db.__prShare, undefined);
});
