// Audit finding (high severity): editing an entry, then picking a different
// exercise/WOD *without* cancelling the edit first, then saving, used to
// silently overwrite the original entry's identity in place — saveSet()/
// saveWod() keep the edited entry's id/timestamp but write the newly-picked
// exercise/WOD's data onto it. Reproduced and confirmed on both the
// strength side (saveSet, via choosePickedMovement) and the WOD side
// (saveWod, via select-benchmark/pick-wod/addCustomWod's "already exists"
// branch/the WOD picker's Enter-to-exact-match shortcut).
//
// Fix: endEntryEditIfActive()/endWodEditIfActive() cancel any in-flight
// edit (clearing editingEntryId/editingWodEntryId and resetting the date)
// at every path that changes selectedId/selectedWodId out from under it —
// so picking something else while mid-edit starts a fresh entry instead of
// corrupting the one being edited.
//
// Both editingEntryId/editingWodEntryId are module-scope `let` bindings,
// not `window` properties (top-level `let` never attaches to the global
// object, unlike function declarations) — so these tests observe the fix
// through the rendered edit banner and the actual saved entries, the same
// way a user would, rather than reading internal state directly.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp } from "./helpers/boot.mjs";

test("picking a different exercise mid-edit does not overwrite the original entry", async () => {
  const window = await bootApp();
  await window.addMovement("Test Original Exercise", "Press");
  const original = window.allMovements().find((m) => m.name === "Test Original Exercise");

  window.applyFieldValue("step", "weight", 50);
  window.applyFieldValue("step", "reps", 5);
  window.applyFieldValue("step", "sets", 1);
  await window.saveSet();
  const [originalEntry] = window.entriesFor(original.id);
  assert.ok(originalEntry, "original entry should exist");

  window.startEditEntry(originalEntry.id);
  assert.ok(window.document.querySelector("[data-action='cancel-edit-entry']"), "edit banner should show while an edit is in flight");

  // Pick a different exercise WITHOUT cancelling the edit first — this is
  // the exact sequence that used to corrupt the original entry.
  await window.addMovement("Test Other Exercise", "Press");
  const other = window.allMovements().find((m) => m.name === "Test Other Exercise");

  assert.equal(window.document.querySelector("[data-action='cancel-edit-entry']"), null, "picking a different exercise mid-edit should cancel the edit, not carry it over");

  window.applyFieldValue("step", "weight", 999);
  window.applyFieldValue("step", "reps", 1);
  window.applyFieldValue("step", "sets", 1);
  await window.saveSet();

  const originalAfter = window.entriesFor(original.id);
  assert.equal(originalAfter.length, 1, "the original exercise should still have exactly its one entry");
  assert.equal(originalAfter[0].id, originalEntry.id);
  assert.equal(originalAfter[0].weight, 50, "the original entry must be untouched, not overwritten with the other exercise's data");

  const otherAfter = window.entriesFor(other.id);
  assert.equal(otherAfter.length, 1, "the new exercise should get its own new entry");
  assert.equal(otherAfter[0].weight, 999);
  assert.notEqual(otherAfter[0].id, originalEntry.id, "the new entry must not reuse the original entry's id");
});

test("picking a different WOD mid-edit does not overwrite the original WOD entry", async () => {
  const window = await bootApp();
  await window.addCustomWod("Test Original WOD", "load", "");
  const original = window.allWods().find((w) => w.name === "Test Original WOD");

  window.applyFieldValue("wod-step", "wodWeight", 100);
  await window.saveWod();
  const [originalEntry] = window.wodEntriesFor(original.id);
  assert.ok(originalEntry, "original WOD entry should exist");

  window.startEditWodEntry(originalEntry.id);
  assert.ok(window.document.querySelector("[data-action='cancel-edit-wod-entry']"), "WOD edit banner should show while an edit is in flight");

  // Switch to a built-in benchmark WITHOUT cancelling the edit — the exact
  // sequence that used to corrupt the original entry's identity.
  window.document.getElementById("tabWodBtn").click();
  window.document.querySelector(".subtabbtn[data-subtab='benchmarks']").click();
  const franBtn = window.document.querySelector("[data-action='select-benchmark'][data-id='fran']");
  assert.ok(franBtn, "Fran should be pickable from the benchmarks list");
  franBtn.click();

  assert.equal(window.document.querySelector("[data-action='cancel-edit-wod-entry']"), null, "picking a different WOD mid-edit should cancel the edit, not carry it over");
  const headerText = window.document.querySelector(".exercise-select span")?.textContent || "";
  assert.equal(headerText, "Fran", "the log form should now show the newly-picked WOD");

  window.applyFieldValue("wod-step", "wodMinutes", 5);
  window.applyFieldValue("wod-step", "wodSeconds", 30);
  await window.saveWod();

  const originalAfter = window.wodEntriesFor(original.id);
  assert.equal(originalAfter.length, 1, "the original WOD should still have exactly its one entry");
  assert.equal(originalAfter[0].id, originalEntry.id);
  assert.equal(originalAfter[0].weight, 100, "the original entry must be untouched, not overwritten with Fran's data");

  const franAfter = window.wodEntriesFor("fran");
  assert.equal(franAfter.length, 1, "Fran should get its own new entry");
  assert.notEqual(franAfter[0].id, originalEntry.id, "the new entry must not reuse the original entry's id");
});

test("EMOM reps reset when swapping between two same-length EMOM WODs, not just differently-shaped ones", async () => {
  const window = await bootApp();
  await window.addCustomWod("Test EMOM A", "emom", "", {
    emomMinutes: 10, emomMovements: ["Burpees", "Sit-ups"], emomTargetReps: [5, 5],
  });
  window.document.getElementById("tabWodBtn").click();

  // Overwrite with non-default values to prove the later read is A's own
  // stale data, not just fresh target reps that happen to match.
  window.applyFieldValue("wod-emom-step", "0", 8);
  window.applyFieldValue("wod-emom-step", "1", 9);
  assert.equal(window.getFieldValue("wod-emom-step", "0"), 8);
  assert.equal(window.getFieldValue("wod-emom-step", "1"), 9);

  // A second EMOM WOD with the SAME movement count as A (2), but a
  // different identity and different target reps.
  await window.addCustomWod("Test EMOM B", "emom", "", {
    emomMinutes: 8, emomMovements: ["Push-ups", "Air Squats"], emomTargetReps: [12, 15],
  });
  window.document.getElementById("tabWodBtn").click();

  assert.equal(window.getFieldValue("wod-emom-step", "0"), 12, "swapping to a different same-length EMOM WOD should reset to its own target reps, not keep the previous WOD's");
  assert.equal(window.getFieldValue("wod-emom-step", "1"), 15);
});
