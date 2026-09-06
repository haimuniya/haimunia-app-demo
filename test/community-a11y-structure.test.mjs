// Launch-readiness audit, A1 and A2: the Community module's document
// structure.
//
// A NOTE ON WHAT THE AUDIT ACTUALLY FOUND. The finding was recorded as
// "the entire Community module ships 5 heading elements", measured with
// `grep -oE "<h[1-6]" cloud.js`. That counts SOURCE occurrences, and this
// file builds its headings through helpers - sectionHead() emits an <h2>
// and is called 36 times, and 20 more card titles emit an <h3>. The module
// therefore renders on the order of 56 headings, not 5, and the severity
// was overstated by the measurement rather than by the code.
//
// Two things in that finding were nonetheless real and are fixed here:
//   * every dialog's title was a <div>, so none of the 13 dialogs appeared
//     in heading navigation even though each was correctly NAMED via
//     aria-labelledby;
//   * the tab pattern was half-declared - tabs with role="tab" but no
//     aria-controls, and a role="tabpanel" with no accessible name (A1).
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cloudJs = fs.readFileSync(path.join(root, "cloud.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("A2: the section and card helpers emit real headings, so every screen built from them has structure", () => {
  // sectionHead() is the module's section header everywhere.
  assert.match(cloudJs, /function sectionHead\([\s\S]{0,200}?<h2 class="ach-section-title">/,
    "sectionHead() must emit an <h2>");
  const sectionCalls = (cloudJs.match(/sectionHead\(/g) || []).length;
  assert.ok(sectionCalls >= 30,
    `expected sectionHead() to still be the shared section header (found ${sectionCalls} call sites)`);
});

test("A2: every dialog title is a heading, not a styled div", () => {
  // Each of these is the aria-labelledby target of a role="dialog".
  const titleIds = [...cloudJs.matchAll(/aria-labelledby="([a-zA-Z]+Title)"/g)].map((m) => m[1]);
  assert.ok(titleIds.length >= 12, `expected the full dialog set, found ${titleIds.length}`);
  for (const id of [...new Set(titleIds)]) {
    assert.match(cloudJs, new RegExp(`<h2 id="${id}"`),
      `#${id} labels a dialog but is not a heading - it will not appear in heading navigation`);
    assert.doesNotMatch(cloudJs, new RegExp(`<div id="${id}"`),
      `#${id} still has a <div> form somewhere`);
  }
});

test("A2: converting those titles to headings did not change their layout", () => {
  // <h2> carries a default top and bottom margin that a <div> does not.
  // Every converted title pins both explicitly, so the visual result is
  // identical to before - this was a semantics change, not a design one.
  for (const m of cloudJs.matchAll(/<h2 id="([a-zA-Z]+Title)" style="([^"]*)"/g)) {
    const [, id, style] = m;
    assert.match(style, /margin-top:\s*0/, `#${id} must pin margin-top so the h2 default does not shift the dialog`);
    assert.match(style, /margin-bottom:/, `#${id} must pin margin-bottom for the same reason`);
  }
});

test("A1: the tab pattern is fully declared - tabs point at the panel and the panel names itself", () => {
  // index.html owns the panel...
  assert.match(indexHtml, /<div id="content" role="tabpanel">/,
    "#content is the single tabpanel the Community tabs swap");

  // ...cloud.js owns the tabs, which must point at it.
  const tabBars = (cloudJs.match(/role="tablist"/g) || []).length;
  assert.ok(tabBars >= 3, `expected the Community, Manage and feed-filter tablists (found ${tabBars})`);
  assert.match(cloudJs, /id="commTab-\$\{t\.id\}" aria-controls="content"/,
    "each Community tab must carry a stable id and aria-controls");
  assert.match(cloudJs, /id="manageTab-\$\{t\.id\}" aria-controls="content"/,
    "each Manage tab must carry a stable id and aria-controls");

  // ...and the panel must be labelled by whichever tab is selected, which
  // can only happen after render because the tabs are rendered by cloud.js.
  assert.match(cloudJs, /panel\.setAttribute\("aria-labelledby", selectedTab\.id\)/,
    "#content must be labelled by the active tab after each render");
  assert.match(cloudJs, /panel\.removeAttribute\("aria-labelledby"\)/,
    "and must drop a stale label when no tab is selected, rather than pointing at a removed id");
});

test("A1: every tablist has an accessible name", () => {
  for (const m of cloudJs.matchAll(/role="tablist"([^>]*)>/g)) {
    assert.match(m[1], /aria-label(?:ledby)?=/,
      `a tablist with no accessible name: ${m[0].slice(0, 90)}`);
  }
});
