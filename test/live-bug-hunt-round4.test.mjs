// Live bug hunt, round 4 (2026-09-11): three fresh agents driving the real
// app in Chromium against the mocked backend found 8 confirmed bugs across
// notifications, moderation/blocking, and data-integrity edges (see
// CHANGES.md for the full report). This file covers the one finding that
// lives in app.js (the offline training log, no Community backend
// involved); the seven Community-side findings (notifications, blocking,
// re-reporting) have their own regression tests appended to
// test/community-moderation.test.mjs and supabase/tests/
// 0025_moderation_reshape_test.sql, right next to the sibling behavior each
// one mirrors.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp } from "./helpers/boot.mjs";

test("editing an entry re-reads the current on-disk record instead of trusting a possibly-stale in-memory copy (same-device, two-tab staleness)", async () => {
  const window = await bootApp();
  await window.addMovement("Test Stale Edit", "Press");
  const movement = window.allMovements().find((m) => m.name === "Test Stale Edit");
  window.choosePickedMovement(movement.id);
  window.applyFieldValue("step", "weight", 50);
  window.applyFieldValue("step", "reps", 10);
  await window.saveSet();
  const saved = (await window.dbLoadAll()).find((e) => e.exerciseId === movement.id);

  // Simulate a sibling tab's edit landing on disk AFTER this tab's own
  // in-memory `entries` array was last refreshed - directly write a changed
  // weight straight to IndexedDB, bypassing this window's in-memory copy
  // entirely (which startEditEntry() used to trust blindly, seeding the
  // edit form from it instead of re-reading disk).
  await window.dbPut({ ...saved, weight: 90 });

  await window.startEditEntry(saved.id);
  // Only reps is touched in this edit - weight is left exactly as the form
  // was seeded, the same way a real member would leave a field they aren't
  // correcting alone.
  window.applyFieldValue("step", "reps", 15);
  await window.saveSet();

  const final = (await window.dbLoadAll()).find((e) => e.id === saved.id);
  assert.equal(final.reps, 15, "the field actually being edited saves correctly");
  assert.equal(final.weight, 90,
    "the sibling tab's weight correction must survive - before the fix, startEditEntry() seeded the form from the stale in-memory weight (50), silently reverting the other tab's edit the moment this tab saved");
});

test("editing a WOD entry gets the same two-tab staleness fix as strength entries", async () => {
  const window = await bootApp();
  await window.addCustomWod("Test Stale WOD Edit", "load", "");
  const wod = window.allWods().find((w) => w.name === "Test Stale WOD Edit");

  window.document.getElementById("tabWodBtn").click();
  window.applyFieldValue("wod-step", "wodWeight", 40);
  const { answerWodRx } = await import("./helpers/boot.mjs");
  answerWodRx(window, true);
  await window.saveWod();
  const saved = (await window.dbLoadWodEntries()).find((e) => e.wodId === wod.id);

  // Same simulated sibling-tab write as the strength-entry test above.
  await window.dbPutWodEntry({ ...saved, weight: 80 });

  await window.startEditWodEntry(saved.id);
  window.applyFieldValue("wod-step", "wodPartnerTag", "עם דנה");
  const partnerInput = window.document.getElementById("wodPartnerTagInput");
  if (partnerInput) { partnerInput.value = "עם דנה"; partnerInput.dispatchEvent(new window.Event("input", { bubbles: true })); }
  await window.saveWod();

  const final = (await window.dbLoadWodEntries()).find((e) => e.id === saved.id);
  assert.equal(final.weight, 80, "the sibling tab's weight correction must survive the same way the strength-entry path now does");
});
