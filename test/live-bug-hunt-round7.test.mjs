// Live bug hunt, round 7 (2026-09-11): three fresh agents on cross-tab/
// multi-window/concurrent-session behavior found confirmed bugs in the
// offline training log's IndexedDB layer (see CHANGES.md for the full
// report). This file covers the src/db.js cross-tab deadlock fix and the
// quota-exceeded silent-data-loss fix; the bodyweight/measurement
// duplicate-row fix has its own regression test next to its siblings in
// test/bodyweight-measurements.test.mjs.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp } from "./helpers/boot.mjs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

// ---------------------------------------------------------------------------
// src/db.js openDB(): a v9 connection idle in one tab used to permanently
// block a v10 open request in another tab - neither half of the standard
// onversionchange/onblocked handshake existed. Confirmed live with two real
// tabs; reproduced here directly against the same openDB() this app boots
// with, via a second, independently-opened connection racing a version bump.
// ---------------------------------------------------------------------------
test("a newer-version IndexedDB open does not hang forever behind this app's own open connection", async () => {
  const window = await bootApp();
  await window.dbLoadAll(); // make sure openDB() has actually run and resolved
  const db1 = await window.openDB();
  const name = db1.name;
  const oldVersion = db1.version;

  const opened = await new Promise((resolve, reject) => {
    const req = window.indexedDB.open(name, oldVersion + 1);
    const timer = setTimeout(() => resolve("TIMED_OUT"), 2000);
    req.onupgradeneeded = () => {};
    req.onsuccess = () => { clearTimeout(timer); req.result.close(); resolve("OPENED"); };
    req.onerror = () => { clearTimeout(timer); reject(req.error); };
  });
  assert.equal(opened, "OPENED",
    "a newer-version open must succeed (this app's connection must step aside via onversionchange), not hang forever");
});

// CONTROL: proves the assertion above is not vacuous - a connection that
// does NOT self-close on versionchange (bypassing openDB() entirely, the
// pre-fix shape) genuinely does block a newer-version open in this same
// environment.
test("CONTROL: a raw connection with no onversionchange handler genuinely blocks a newer-version open (proves the fix above is load-bearing)", async () => {
  const window = await bootApp();
  const db1 = await window.openDB();
  const name = db1.name;
  const oldVersion = db1.version;

  // A second, independent connection at the SAME version, deliberately
  // wired the pre-fix way (no onversionchange) - this is what every
  // connection in this app looked like before the fix.
  const rawConn = await new Promise((resolve, reject) => {
    const req = window.indexedDB.open(name, oldVersion);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const opened = await new Promise((resolve, reject) => {
    const req = window.indexedDB.open(name, oldVersion + 1);
    const timer = setTimeout(() => resolve("TIMED_OUT"), 1500);
    req.onupgradeneeded = () => {};
    req.onsuccess = () => { clearTimeout(timer); req.result.close(); resolve("OPENED"); };
    req.onerror = () => { clearTimeout(timer); reject(req.error); };
  });
  rawConn.close();
  assert.equal(opened, "TIMED_OUT",
    "without an onversionchange handler, a newer-version open genuinely hangs - confirming the fix's onversionchange handler is what prevents this app's own connections from doing the same");
});

// ---------------------------------------------------------------------------
// saveSet(): entries was mutated (unshift/sort) and the celebration/PR flow
// decided BEFORE dbPut() was awaited, with no rollback on failure - a
// QuotaExceededError left the UI celebrating a set that never persisted.
// ---------------------------------------------------------------------------
test("a save that fails with QuotaExceededError has no visible side effect - no celebration, no phantom entry, no PR flag", async () => {
  const window = await bootApp();
  await window.addMovement("Test Quota Squat", "Squat");
  const movement = window.allMovements().find((m) => m.name === "Test Quota Squat");
  window.choosePickedMovement(movement.id);
  window.applyFieldValue("step", "weight", 60);
  window.applyFieldValue("step", "reps", 5);

  const realDbPut = window.dbPut;
  window.dbPut = () => Promise.reject(new DOMException("quota exceeded", "QuotaExceededError"));
  try {
    await window.saveSet();
  } finally {
    window.dbPut = realDbPut;
  }

  const persisted = (await window.dbLoadAll()).filter((e) => e.exerciseId === movement.id);
  assert.equal(persisted.length, 0, "a failed write must leave nothing in IndexedDB");
  assert.equal(
    window.document.getElementById("celebrationOverlay").classList.contains("open"),
    false,
    "no celebration may show for a set that was never actually saved"
  );
  const alertBanner = window.document.querySelector('[role="alert"]');
  assert.ok(alertBanner, "a storage-error banner must be shown so the failure isn't silent");

  // Confirm the app is not stuck: a real, unpatched save afterward succeeds
  // normally and is the only entry on file.
  await window.saveSet();
  const after = (await window.dbLoadAll()).filter((e) => e.exerciseId === movement.id);
  assert.equal(after.length, 1, "a subsequent real save must succeed cleanly, exactly once");
});

test("a WOD save that fails with QuotaExceededError has no visible side effect", async () => {
  const window = await bootApp();
  window.document.getElementById("tabWodBtn").click();
  const wod = window.allWods().find((w) => w.scoreType === "time");
  window.choosePickedWod(wod.id);
  window.applyFieldValue("wod-step", "wodMinutes", 12);
  window.applyFieldValue("wod-step", "wodSeconds", 30);
  window.setWodRx(true);

  const realDbPutWodEntry = window.dbPutWodEntry;
  window.dbPutWodEntry = () => Promise.reject(new DOMException("quota exceeded", "QuotaExceededError"));
  try {
    await window.saveWod();
  } finally {
    window.dbPutWodEntry = realDbPutWodEntry;
  }

  const persisted = (await window.dbLoadWodEntries()).filter((e) => e.wodId === wod.id);
  assert.equal(persisted.length, 0, "a failed WOD write must leave nothing in IndexedDB");
  const alertBanner = window.document.querySelector('[role="alert"]');
  assert.ok(alertBanner, "a storage-error banner must be shown so the failure isn't silent");
});

// ---------------------------------------------------------------------------
// The Community gate: state.signupStarted resets to false on reload, so a
// real member whose invite-code redemption already committed server-side
// (the RPC's response just never made it back before a reload) used to be
// bounced back to the neutral "start" screen, as if signup had never begun.
// ---------------------------------------------------------------------------
test("reloading with an already-committed server-side redemption skips the neutral start screen and goes straight to credentials", async () => {
  const mock = createMockSupabase({
    profiles: [], invite_redemptions: [{ user_id: "new-1", invite_id: "inv-1", role: "member", redeemed_at: new Date().toISOString() }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    community_streaks: [], workout_posts: [], feed_page_rows: [], member_contact_log: [],
    coach_engagement_flags: [], analytics_events: [], notifications: [], notification_preferences: [],
    monthly_club_recaps: [], reports: [],
  });
  mock.setUser({ id: "new-1", is_anonymous: true, email: null });
  // Deliberately NOT calling start-signup - this is exactly the "just
  // reloaded, signupStarted reset to false" state, with a real redemption
  // already on the server.
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityCredentials"), 4000);

  assert.equal(window.document.querySelector('[data-community-action="start-signup"]'), null,
    "must not show the neutral 'יש לי קוד הזמנה' start screen for a session that already redeemed");
  assert.ok(window.document.getElementById("communityCredentials"),
    "must land on the credentials step instead (a real redemption exists, is_anonymous is still true)");
});
