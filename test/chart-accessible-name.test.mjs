// COMM-359: the generated SVG progression chart (est1RM, bodyweight, and
// body-measurement charts all share this one renderChart()) had no
// role="img", aria-label, or text alternative - a screen-reader user got
// nothing where a sighted user sees the full trend, including which points
// are PRs. Confirmed still open from the 2026-08-27 audit's finding #11.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp } from "./helpers/boot.mjs";

test("renderChart() gives the SVG role=img and an aria-label summarizing range, latest value and PR count", async () => {
  const window = await bootApp();
  const html = window.renderChart([
    { dateLabel: "1.1", est1RM: 100, isPR: false },
    { dateLabel: "8.1", est1RM: 110, isPR: true },
    { dateLabel: "15.1", est1RM: 120, isPR: true },
  ]);
  const container = window.document.createElement("div");
  container.innerHTML = html;
  const svg = container.querySelector("svg");
  assert.equal(svg.getAttribute("role"), "img");
  const label = svg.getAttribute("aria-label");
  assert.match(label, /3/, "should mention the point count");
  assert.match(label, /100/, "should mention the earliest value");
  assert.match(label, /120/, "should mention the latest value");
  assert.match(label, /2/, "should mention the PR count (2 PRs)");
});

test("a single-point chart still gets a real aria-label, not a range description", async () => {
  const window = await bootApp();
  const html = window.renderChart([{ dateLabel: "1.1", est1RM: 60, isPR: false }]);
  const container = window.document.createElement("div");
  container.innerHTML = html;
  const svg = container.querySelector("svg");
  assert.equal(svg.getAttribute("role"), "img");
  assert.match(svg.getAttribute("aria-label"), /60/);
});
