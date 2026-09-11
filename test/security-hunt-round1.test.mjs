// Security hunt, round 1 (2026-09-11): authorization/RLS boundary testing,
// XSS/injection surface, and sensitive-data exposure. Three fresh agents
// found no new authorization/RLS gaps (this codebase already went through
// five prior hardening passes, re-verified live against real local
// Postgres) and no exploitable XSS, but did confirm one real, low-severity
// information-disclosure bug and flag two defense-in-depth hardening
// opportunities worth closing even though neither is currently
// exploitable on its own. See CHANGES.md for the full report.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp } from "./helpers/boot.mjs";

test("a render failure shows a generic message, not the raw internal exception text", async () => {
  const window = await bootApp();
  const original = window.renderCalendarTab;
  const secret = "Cannot read properties of undefined (reading 'internalFieldName_do_not_leak')";
  window.renderCalendarTab = () => { throw new Error(secret); };
  try {
    window.document.getElementById("tabCalendarBtn").click();
    const content = window.document.getElementById("content").textContent;
    assert.match(content, /משהו השתבש בהצגת הטאב הזה/, "the friendly fallback heading still renders");
    assert.ok(!content.includes(secret), "the raw exception message must never reach the screen - console.error still gets it, the DOM must not");
  } finally {
    window.renderCalendarTab = original;
  }
});

test("event map_link is only rendered as a clickable link when it actually starts http(s):// - a second, render-site gate independent of the submit-time check and the DB constraint", async () => {
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8"));
  // Source-text assertion (cloud.js has no jsdom-executable community-driven
  // render path in bootApp() alone - see community-*.test.mjs for the
  // bootCommunity-driven equivalents this fix's sibling checks already use).
  // This pins the actual gate exists, matching the exact regex
  // submitEventForm() already uses for the same field, so both checks can
  // never silently drift out of sync with each other.
  assert.ok(src.includes('const mapLinkSafe = e.map_link && /^https?:\\/\\//i.test(e.map_link);'),
    "the render-site gate must exist and use the same http(s):// regex submitEventForm() uses");
  assert.match(src, /\$\{mapLinkSafe \? ` · <a class="link-btn" href="\$\{esc\(e\.map_link\)\}"/,
    "the map link is only rendered as an <a href> when mapLinkSafe is true");
});

test("navigateToNotifTarget builds its post-id selector through the shared cssSel() helper, not a naive manual escape", async () => {
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8"));
  assert.match(src, /const cssSel = window\.BoxLogSafe\.cssSel;/, "cssSel must be bound from the shared safe-helpers module, same pattern as esc/bidiText");
  assert.match(src, /const sel = '\[data-post-id="' \+ cssSel\(target\.post\) \+ '"\]';/,
    "the selector must be built with cssSel(), not a bare .replace() escape");
});
