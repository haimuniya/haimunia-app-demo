// Coverage gap closed (full-codebase audit): renderWodDetailCard()'s EMOM
// skip-branch had zero automated coverage. EMOM has no single comparable
// score across attempts (see scoreValue()/bestWodScore), so the PR-trend
// chart is deliberately skipped for it — this proves that branch actually
// fires (no chart, no "שיא:" best line) while every other score type still
// gets its chart, guarding against the skip condition silently swallowing
// a score type it shouldn't.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp } from "./helpers/boot.mjs";

test("an EMOM WOD's history card skips the chart and the best-score line", async () => {
  const window = await bootApp();
  await window.addCustomWod("Test Chart EMOM", "emom", "", {
    emomMinutes: 10, emomMovements: ["Burpees", "Sit-ups"], emomTargetReps: [5, 5],
  });
  const wod = window.allWods().find((w) => w.name === "Test Chart EMOM");

  window.applyFieldValue("wod-emom-step", "0", 8);
  window.applyFieldValue("wod-emom-step", "1", 9);
  await window.saveWod();

  const html = window.renderWodDetailCard(wod);
  assert.ok(!html.includes("viewBox"), "EMOM should not render the SVG trend chart");
  assert.ok(!html.includes("שיא:"), "EMOM should not show a best-score line — there's no single comparable score");
  assert.ok(html.includes(wod.name), "the card should still render, just without the chart");
});

test("a non-EMOM WOD's history card still gets the chart and best-score line", async () => {
  const window = await bootApp();
  await window.addCustomWod("Test Chart Load", "load", "");
  const wod = window.allWods().find((w) => w.name === "Test Chart Load");

  window.applyFieldValue("wod-step", "wodWeight", 60);
  await window.saveWod();

  const html = window.renderWodDetailCard(wod);
  assert.ok(html.includes("viewBox"), "a non-EMOM WOD should still get the SVG trend chart");
  assert.ok(html.includes("שיא:"), "a non-EMOM WOD should still show its best score");
});

test("an EMOM WOD with no logged attempts renders nothing, same as any other WOD", async () => {
  const window = await bootApp();
  await window.addCustomWod("Test Chart EMOM Unused", "emom", "", {
    emomMinutes: 5, emomMovements: ["Push-ups"], emomTargetReps: [10],
  });
  const wod = window.allWods().find((w) => w.name === "Test Chart EMOM Unused");
  assert.equal(window.renderWodDetailCard(wod), "", "a WOD with zero logged entries should render an empty card, EMOM or not");
});
