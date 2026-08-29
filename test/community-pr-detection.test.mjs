// COMM-132 / COMM-133. The offline save path detects a strength or rep PR and,
// only when the community layer reports a signed-in session, announces it on
// the product event bus as PR_CREATED with the exact keys the posts-cluster
// PR share prompt reads. Detection still runs offline and nothing is ever
// auto-posted. This file boots the real app.js (and, for the end-to-end
// check, the real cloud.js) rather than re-implementing any of it.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp, bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

function logReps(window, weight, reps = 5) {
  window.applyFieldValue("step", "weight", weight);
  window.applyFieldValue("step", "reps", reps);
  window.applyFieldValue("step", "sets", 1);
  return window.saveSet();
}

test("a detected rep PR emits PR_CREATED with record_id, movement and new_result once community is signed in", async () => {
  const window = await bootApp();
  window.isCommunitySignedIn = () => true;
  const seen = [];
  window.HaimuniaEvents.on(window.PRODUCT_EVENTS.PR_CREATED, (p) => seen.push(p));

  await window.addMovement("PR Hook Deadlift", "Deadlift");
  await logReps(window, 100);

  assert.equal(seen.length, 1, "the first ever set on a movement is a PR and should emit once");
  const rec = seen[0].record;
  assert.ok(rec, "payload carries a record object");
  assert.ok(rec.record_id, "record_id is set so the prompt can de-dupe");
  assert.equal(rec.movement, "PR Hook Deadlift");
  assert.match(rec.new_result, /100/);
});

test("a heavier set at the same reps emits a second event carrying previous_result and improvement", async () => {
  const window = await bootApp();
  window.isCommunitySignedIn = () => true;
  const seen = [];
  window.HaimuniaEvents.on(window.PRODUCT_EVENTS.PR_CREATED, (p) => seen.push(p));

  await window.addMovement("PR Hook Squat", "Squat");
  await logReps(window, 80);
  await logReps(window, 90);

  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].record.record_id, seen[1].record.record_id, "each saved record is its own event");
  assert.match(seen[1].record.previous_result, /80/);
  assert.match(seen[1].record.improvement, /\+/);
});

test("a lighter set after a PR is not a PR and emits nothing new", async () => {
  const window = await bootApp();
  window.isCommunitySignedIn = () => true;
  const seen = [];
  window.HaimuniaEvents.on(window.PRODUCT_EVENTS.PR_CREATED, (p) => seen.push(p));

  await window.addMovement("PR Hook Press", "Press");
  await logReps(window, 60);
  assert.equal(seen.length, 1);
  await logReps(window, 50);
  assert.equal(seen.length, 1, "a value below the best is not inferred as a PR");
});

test("no PR_CREATED and no behaviour change when the community is not signed in", async () => {
  const window = await bootApp();
  // window.isCommunitySignedIn is undefined here - cloud.js never loaded.
  const seen = [];
  window.HaimuniaEvents.on(window.PRODUCT_EVENTS.PR_CREATED, (p) => seen.push(p));

  await window.addMovement("PR Hook Offline", "Deadlift");
  await logReps(window, 120);

  assert.equal(seen.length, 0, "detection still runs but nothing is announced offline");
  assert.equal(window.document.getElementById("celebrationOverlay").classList.contains("open"), true,
    "the local PR celebration is unchanged");
});

test("end to end: a logged lift drives the PR share prompt and posts nothing on its own", async () => {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    community_feed: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });

  const window = await bootCommunity(mock, { syncEnabled: false });
  await waitFor(() => window.isCommunitySignedIn && window.isCommunitySignedIn(), 3000);

  await window.addMovement("Prompt Deadlift", "Deadlift");
  await logReps(window, 140);

  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);
  const prompt = window.document.getElementById("prPrompt");
  assert.match(prompt.textContent, /שיא חדש זוהה/);
  assert.match(prompt.textContent, /Prompt Deadlift/);
  assert.match(prompt.textContent, /140/);
  assert.equal(mock.callsTo("pr_share").length, 0, "the event alone never publishes");
});
