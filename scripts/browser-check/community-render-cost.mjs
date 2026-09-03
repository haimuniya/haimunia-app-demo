#!/usr/bin/env node
// COMM-366 spike instrument. Measures what one rerender() of the Community
// tab actually costs in real Chromium, so the scoped-vs-full-rerender
// decision recorded in docs/community/2026-09-03-render-architecture-spike.md
// rests on numbers from this codebase rather than on general advice about
// innerHTML.
//
// It reports, for a signed-in member on a feed of N posts:
//   * the byte size of the HTML renderCommunityApp() returns,
//   * the element and focusable-control count in #content after the write,
//   * the wall time of window.render() (build + innerHTML + post-render),
//   * how much of that is the innerHTML write alone,
//   * how it scales as the feed grows,
//   * that a rerender really does destroy and rebuild every node - the
//     premise the whole spike rests on.
//
// Local static server + the in-page mock backend only, never TARGET_URL:
// same rule every other community scenario here follows.
//
// Usage: node community-render-cost.mjs
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { switchTab, dismissWelcomeModal } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

// run-all.mjs picks this file up automatically, so it is a regression guard as
// well as an instrument: the trip-wire COMM-366's spike names in prose is
// asserted here rather than left aspirational. See
// docs/community/2026-09-03-render-architecture-spike.md §5.
let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " - " + detail : ""}`);
  if (!ok) failed = true;
}
// The spike's own reversal threshold: a full rerender over 16 ms at 4x CPU
// throttle means the full-tree model no longer fits a frame on a mid-range
// phone, and the migration plan in that note's §6 comes off the shelf.
const TRIPWIRE_MS_AT_4X = 16;

const VERIFIED = new Date().toISOString();
const FEED_ROWS = 30;

// The row shape feed_page() actually returns, copied from the one
// test/community-feed-client.test.mjs already proves the client renders.
function feedRow(i) {
  return {
    id: "p" + i,
    post_type: "POST_TEXT",
    author_id: "u" + ((i % 2) + 1),
    author: { display_name: i % 2 ? "נועם" : "דנה", handle: i % 2 ? "noam" : "dana" },
    body: "פוסט מספר " + i + " - טקסט לדוגמה שמייצג פוסט רגיל באורך סביר בפיד של המועדון.",
    visibility: "club",
    created_at: new Date(Date.now() - i * 60000).toISOString(),
    published_at: new Date(Date.now() - i * 60000).toISOString(),
    reaction_count: i % 7,
    comment_count: i % 4,
    media: [],
    metadata: {},
  };
}

const seedTables = {
  profiles: [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_follows: true },
    { id: "u2", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_attendance: true, allow_follows: true },
  ],
  invite_redemptions: [
    { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
    { user_id: "u2", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
  ],
  clubs: [{ id: "club-1", name: "חיימוניה" }],
  feed_page_rows: Array.from({ length: FEED_ROWS }, (_, i) => feedRow(i)),
  feed_impressions: [], feed_interactions: [], hidden_posts: [], saved_posts: [],
  private_records: [], follows: [], blocks: [], analytics_events: [],
  attendance_log: [], notifications: [], notification_preferences: [],
};

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend)\n`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
await page.addInitScript(() => localStorage.setItem("haimunia-demo:cloudSyncEnabled", "1"));
// test/helpers/mockSupabase.mjs's feed_page() stand-in base64s its cursor
// through node's Buffer, which does not exist in a browser - so it throws the
// moment it has any row to page, and the feed comes back empty. Every other
// community browser scenario seeds feed_page_rows: [] and never hits it; this
// one is the first that needs a NON-empty feed, so it brings its own minimal
// Buffer shim rather than editing the shared mock out from under the jsdom
// suite. Only the two calls that mock makes are implemented.
await page.addInitScript(() => {
  if (typeof globalThis.Buffer !== "undefined") return;
  globalThis.Buffer = {
    from(input, enc) {
      if (enc === "base64") { const bin = atob(String(input)); return { toString: () => bin }; }
      const s = String(input);
      return { toString: (e) => (e === "base64" ? btoa(s) : s) };
    },
  };
});
await installMockCloud(page, seedTables, { user: { id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" } });
await page.goto(target.url, { waitUntil: "networkidle" });
await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
await dismissWelcomeModal(page);
await switchTab(page, "tabCommunityBtn");
await page.waitForSelector("#communityFeedList .post-card", { timeout: 10000 });

const measure = await page.evaluate(() => {
  const content = document.getElementById("content");
  window.render(); // warm the JIT and settle the tab
  const html = content.innerHTML;
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) window.render();
  const perRender = (performance.now() - t0) / 50;
  const scratch = document.createElement("div");
  document.body.appendChild(scratch);
  const t1 = performance.now();
  for (let i = 0; i < 50; i++) scratch.innerHTML = html;
  const perWrite = (performance.now() - t1) / 50;
  scratch.remove();
  return {
    htmlBytes: html.length,
    elements: content.querySelectorAll("*").length,
    focusables: content.querySelectorAll('button, input, select, textarea, a[href], [tabindex]').length,
    posts: content.querySelectorAll("[data-post-id]").length,
    perRenderMs: +perRender.toFixed(3),
    perWriteMs: +perWrite.toFixed(3),
  };
});

console.log("Community tab, signed-in member, feed loaded:");
console.log(`  post cards in #content   ${measure.posts}`);
console.log(`  HTML returned            ${measure.htmlBytes} bytes`);
console.log(`  elements in #content     ${measure.elements}`);
console.log(`  focusable controls       ${measure.focusables}`);
console.log(`  window.render()          ${measure.perRenderMs} ms   (mean of 50)`);
console.log(`  innerHTML write alone    ${measure.perWriteMs} ms   (mean of 50)`);
console.log(`  => string building       ${+(measure.perRenderMs - measure.perWriteMs).toFixed(3)} ms of it`);
check("the feed actually rendered, so the numbers above describe a real screen", measure.posts > 0, `${measure.posts} post cards`);

const scaling = await page.evaluate(() => {
  const first = document.querySelector("#content [data-post-id]");
  const unit = first ? first.outerHTML : null;
  if (!unit) return null;
  const scratch = document.createElement("div");
  document.body.appendChild(scratch);
  const out = [];
  for (const n of [1, 10, 30, 60, 120]) {
    const html = unit.repeat(n);
    const t0 = performance.now();
    for (let i = 0; i < 30; i++) scratch.innerHTML = html;
    out.push({ n, bytes: html.length, elements: scratch.querySelectorAll("*").length, ms: +((performance.now() - t0) / 30).toFixed(3) });
  }
  scratch.remove();
  return out;
});

if (scaling) {
  console.log("\nHow the innerHTML write alone scales with feed depth (one real post card, repeated):");
  console.log("  cards    bytes   elements   ms/write");
  for (const r of scaling) {
    console.log(`  ${String(r.n).padStart(5)}   ${String(r.bytes).padStart(6)}   ${String(r.elements).padStart(8)}   ${String(r.ms).padStart(8)}`);
  }
}

// The numbers above are from an unthrottled desktop CPU. A member on a
// mid-range phone is the case that actually decides this, so re-measure under
// CDP CPU throttling - the same knob Lighthouse's mobile profile uses.
const cdp = await page.context().newCDPSession(page);
console.log("\nSame full render(), under CDP CPU throttling:");
for (const rate of [1, 4, 6]) {
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  const ms = await page.evaluate(() => {
    window.render();
    const t0 = performance.now();
    for (let i = 0; i < 30; i++) window.render();
    return +((performance.now() - t0) / 30).toFixed(3);
  });
  console.log(`  ${rate}x slowdown${rate === 1 ? " (desktop)" : rate === 4 ? " (~mid-range phone)" : " (~low-end phone)"}   ${ms} ms/render`);
  if (rate === 4) {
    check(
      `a full rerender still fits a frame on a mid-range phone (COMM-366 trip-wire: < ${TRIPWIRE_MS_AT_4X} ms at 4x)`,
      ms < TRIPWIRE_MS_AT_4X,
      `${ms} ms - if this fails, re-read docs/community/2026-09-03-render-architecture-spike.md §5/§6 before adding more UI`
    );
  }
}
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

// How many FULL rebuilds does one ordinary interaction cost? This is the
// number that matters more than any single render's ms: the question is not
// whether one rebuild is affordable, it is how many of them a tap triggers.
const perInteraction = await page.evaluate(async () => {
  const real = window.render;
  let count = 0;
  window.render = function () { count++; return real.apply(this, arguments); };
  const btn = document.querySelector("#communityFeedList [data-community-action='react'], #communityFeedList [data-community-action='toggle-comments']");
  const label = btn ? btn.getAttribute("data-community-action") : null;
  if (btn) { btn.click(); await new Promise((r) => setTimeout(r, 600)); }
  window.render = real;
  return { label, count };
});
console.log(`\nOne tap on the feed's "${perInteraction.label}" control triggered ${perInteraction.count} full-tab rebuild(s).`);
check("one tap costs a small, bounded number of full rebuilds", perInteraction.count > 0 && perInteraction.count <= 4, String(perInteraction.count));

const identity = await page.evaluate(() => {
  const content = document.getElementById("content");
  const before = content.firstElementChild;
  window.render();
  return { sameNode: before === content.firstElementChild };
});
console.log(`\nAfter one rerender, #content's first element is the same DOM node: ${identity.sameNode}`);
console.log(identity.sameNode
  ? "  UNEXPECTED - something is preserving nodes; re-read the spike's premise."
  : "  Expected: every node is destroyed and rebuilt. That is why focus, scroll\n" +
    "  position, IME composition and <details> open-state all have to be restored\n" +
    "  by hand (syncCloudDialogFocus) instead of simply surviving.");

check(
  "a rerender still destroys and rebuilds every node - the premise the spike rests on",
  identity.sameNode === false
);

await browser.close();
await target.close();
console.log(failed ? "\ncommunity-render-cost: FAILED" : "\ncommunity-render-cost: all checks passed");
process.exit(failed ? 1 : 0);
