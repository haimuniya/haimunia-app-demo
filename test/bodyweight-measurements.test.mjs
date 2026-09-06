// Coverage gap closed (full-codebase audit): the History tab's bodyweight
// and custom-measurements sections (both nested under #tabHistoryBtn, not
// their own top-level tabs) had zero automated coverage. Drives the real
// expand/save actions and confirms the write actually lands in IndexedDB.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp } from "./helpers/boot.mjs";

test("logging today's bodyweight persists it and updates the collapsed row's summary", async () => {
  const window = await bootApp();
  window.document.getElementById("tabHistoryBtn").click();
  window.document.querySelector("[data-action='toggle-bodyweight']").click();

  window.applyFieldValue("bw-step", "bwWeight", 78.5);
  window.document.querySelector("[data-action='save-bw']").click();
  await new Promise((r) => setTimeout(r, 0)); // saveBodyweight() is async

  const rows = await window.dbLoadBodyweight();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].weight, 78.5);
  assert.equal(rows[0].date, window.todayISO());

  // Collapse and re-expand: the collapsed row's summary should reflect the
  // just-saved weight, not the pre-save default.
  window.document.querySelector("[data-action='toggle-bodyweight']").click();
  const summaryText = window.document.getElementById("bodyweightArea").textContent;
  assert.ok(summaryText.includes("78.5"), "the collapsed row should show the newly-saved weight");
});

test("logging bodyweight again the same day overwrites today's entry instead of adding a second one", async () => {
  const window = await bootApp();
  window.document.getElementById("tabHistoryBtn").click();
  window.document.querySelector("[data-action='toggle-bodyweight']").click();

  window.applyFieldValue("bw-step", "bwWeight", 80);
  window.document.querySelector("[data-action='save-bw']").click();
  await new Promise((r) => setTimeout(r, 0));

  window.applyFieldValue("bw-step", "bwWeight", 81);
  window.document.querySelector("[data-action='save-bw']").click();
  await new Promise((r) => setTimeout(r, 0));

  const rows = await window.dbLoadBodyweight();
  assert.equal(rows.length, 1, "same-day saves should overwrite, not duplicate");
  assert.equal(rows[0].weight, 81);
});

test("adding a custom measure type, then logging and reading back a measurement", async () => {
  const window = await bootApp();
  window.document.getElementById("tabHistoryBtn").click();

  await window.addMeasureType("Test Waist");
  const typesArea = window.document.getElementById("measureArea").textContent;
  assert.ok(typesArea.includes("Test Waist"), "the new measure type should appear in the list");

  const type = (await window.dbLoadMeasureTypes()).find((t) => t.name === "Test Waist");
  assert.ok(type, "the type should be persisted");

  // addMeasureType() already expands the freshly-created type.
  window.applyFieldValue("measure-step", type.id, 82);
  window.document.querySelector(`[data-action='save-measurement'][data-id='${type.id}']`).click();
  await new Promise((r) => setTimeout(r, 0));

  const entries = await window.dbLoadMeasurements();
  const saved = entries.find((e) => e.typeId === type.id);
  assert.ok(saved, "the measurement should be persisted");
  assert.equal(saved.value, 82);
  assert.equal(saved.date, window.todayISO());
});

test("adding a measure type with a name that already exists re-opens the existing one instead of duplicating it", async () => {
  const window = await bootApp();
  window.document.getElementById("tabHistoryBtn").click();
  await window.addMeasureType("Test Chest");
  await window.addMeasureType("test chest"); // same name, different case

  const types = await window.dbLoadMeasureTypes();
  const matches = types.filter((t) => t.name.toLowerCase() === "test chest");
  assert.equal(matches.length, 1, "re-adding the same name (case-insensitively) should not create a duplicate type");
});

test("deleting a measure type removes it and its logged measurements", async () => {
  const window = await bootApp();
  window.document.getElementById("tabHistoryBtn").click();
  await window.addMeasureType("Test Hips");
  const type = (await window.dbLoadMeasureTypes()).find((t) => t.name === "Test Hips");

  window.applyFieldValue("measure-step", type.id, 95);
  await window.saveMeasurement(type.id);
  assert.ok((await window.dbLoadMeasurements()).some((e) => e.typeId === type.id));

  await window.deleteMeasureType(type.id);

  assert.ok(!(await window.dbLoadMeasureTypes()).some((t) => t.id === type.id), "the type itself should be gone");
  assert.ok(!(await window.dbLoadMeasurements()).some((e) => e.typeId === type.id), "its measurements should be cleaned up too, not left orphaned");
});

// Launch-readiness audit bug fix: applyRemotePrivateRecord() (app.js) had a
// deleted branch for every synced record type except bodyweight - a
// bodyweight row's remote deletion (e.g. deleted from another device, or by
// a coach through the Supabase dashboard) silently did nothing at all,
// leaving the entry stuck on this device forever.
test("a remote bodyweight deletion actually removes the local entry", async () => {
  const window = await bootApp();
  window.document.getElementById("tabHistoryBtn").click();
  window.document.querySelector("[data-action='toggle-bodyweight']").click();
  window.applyFieldValue("bw-step", "bwWeight", 82);
  window.document.querySelector("[data-action='save-bw']").click();
  await new Promise((r) => setTimeout(r, 0));
  const [entry] = await window.dbLoadBodyweight();
  assert.ok(entry, "the entry saved locally first");

  await window.applyRemotePrivateRecord({ record_type: "bodyweight", record_id: entry.id, payload: {}, deleted_at: new Date().toISOString() });

  assert.ok(!(await window.dbLoadBodyweight()).some((e) => e.id === entry.id), "the remote deletion removed the local entry");
});

// Launch-readiness audit bug fix: syncApplyingRemote used to be a single
// global boolean, so applyRemotePrivateRecord() applying ONE remote record
// blocked queueSyncRecord() for EVERY record - a local edit to a completely
// different record, made while that remote pull was still mid-flight (it
// awaits real IndexedDB writes), was silently dropped from the sync outbox
// and never pushed to the cloud. Scoped per-record, only the record
// actually being applied should be guarded.
test("applying one remote record does not block a concurrent local edit to a different record from reaching the sync outbox", async () => {
  const window = await bootApp();
  // applyRemotePrivateRecord() runs synchronously up to its own first
  // internal `await` - which is AFTER the line that marks the record as
  // "being applied" - so calling it without awaiting, then immediately
  // (still synchronously, no intervening await) calling queueSyncRecord()
  // for a DIFFERENT record, deterministically lands inside the exact
  // window the old bug affected: a single global flag was still `true`
  // for every record, not just remote-1, and would have silently
  // swallowed local-1's outbox row.
  const applyPromise = window.applyRemotePrivateRecord({
    record_type: "bodyweight", record_id: "remote-1",
    payload: { id: "remote-1", weight: 70, date: window.todayISO(), ts: Date.now() },
    deleted_at: null,
  });
  await window.queueSyncRecord("measurement", { id: "local-1", typeId: "t1", value: 10, date: window.todayISO(), ts: Date.now() });
  await applyPromise;

  const outbox = await window.dbLoadSyncOutbox();
  assert.ok(outbox.some((r) => r.recordId === "local-1" && !r.deleted), "the concurrent local edit still reached the outbox");
});
