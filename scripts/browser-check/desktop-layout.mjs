#!/usr/bin/env node
// Track 1, Phase 4: above a 900px viewport, the mobile hamburger + full-page
// nav-menu overlay give way to a persistent sidebar - CSS alone decides
// which nav surface shows (see .app-shell/.desktop-sidebar in index.html),
// no JS branching. There is no other coverage of this at all today (zero
// responsive handling existed before this phase), so this is new ground,
// not a migration of an existing check.
//
// Usage:
//   node desktop-layout.mjs                 # local working tree
//   TARGET_URL=<url> node desktop-layout.mjs # a deployed site
import { chromium } from "playwright";
import { resolveTarget } from "./lib/target.mjs";
import { dismissWelcomeModal, consoleErrorCollector } from "./lib/actions.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const target = await resolveTarget();
console.log(`Target: ${target.url}${target.local ? " (local static server)" : ""}`);

const browser = await chromium.launch();

// --- Narrow viewport: today's mobile behavior must be untouched ---
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = await consoleErrorCollector(page);
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible" });
  await dismissWelcomeModal(page);

  const hamburgerVisible = await page.locator("#navMenuBtn").isVisible();
  const sidebarVisible = await page.locator("#desktopSidebar").isVisible();
  check("below the breakpoint: hamburger visible, sidebar hidden", hamburgerVisible && !sidebarVisible, `hamburger=${hamburgerVisible} sidebar=${sidebarVisible}`);

  check("no console errors at narrow width", errors.length === 0, errors.join(" | "));
  await page.close();
}

// --- Wide viewport: the desktop sidebar takes over ---
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = await consoleErrorCollector(page);
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible" });
  await dismissWelcomeModal(page);

  const hamburgerVisible = await page.locator("#navMenuBtn").isVisible();
  const sidebarVisible = await page.locator("#desktopSidebar").isVisible();
  check("above the breakpoint: sidebar visible, hamburger hidden", sidebarVisible && !hamburgerVisible, `hamburger=${hamburgerVisible} sidebar=${sidebarVisible}`);

  // The sidebar renders from the same getNavItems() registry as the mobile
  // menu, just without the tabAddBtn/etc ids - switching tabs from it has
  // to go through data-tab alone, the same thing switchTab()'s id-based
  // click ultimately triggers via the shared click delegator.
  await page.click("#desktopSidebar .navrow[data-tab='history']");
  await page.waitForTimeout(150);
  const contentNotEmpty = await page.evaluate(() => document.getElementById("content").children.length > 0);
  const historyRowActive = await page.locator("#desktopSidebar .navrow[data-tab='history']").evaluate((el) => el.classList.contains("active"));
  check("clicking a sidebar row (no id, data-tab only) switches tabs and marks itself active", contentNotEmpty && historyRowActive, `content=${contentNotEmpty} active=${historyRowActive}`);

  // No duplicate DOM ids: the mobile nav-menu copy of this same row keeps
  // tabHistoryBtn: the sidebar copy must not silently carry it too.
  const idCount = await page.evaluate(() => document.querySelectorAll("#tabHistoryBtn").length);
  check("the sidebar row never duplicates the mobile row's id", idCount === 1, `#tabHistoryBtn count=${idCount}`);

  // The settings screen (Phase 3) also has to work from the sidebar's own
  // entry point, not just the mobile menu's.
  await page.click("#desktopSidebar [data-action='open-settings']");
  await page.waitForSelector("#settingsOverlay.open");
  check("settings opens from the sidebar's own settings row", true);
  await page.click("button[data-action='close-settings']");
  await page.waitForTimeout(150);

  // A real regression: overflow-x:hidden on html/body forced overflow-y's
  // used value to auto on one of them per the CSS overflow spec (non-visible
  // overflow-x + unset overflow-y => overflow-y computes to auto), which
  // made it the "scroll container" .desktop-sidebar's position:sticky
  // resolved against instead of the real viewport - and since neither html
  // nor body ever actually scrolls itself (nothing caps body's height, so
  // it just grows to fit its content), the sidebar tracked page scroll in
  // exact 1:1 lockstep, indistinguishable from static/relative. Fixed by
  // removing overflow-x:hidden from html,body (index.html) rather than
  // adding it to .app-shell, which is .desktop-sidebar's own direct parent
  // and would have reintroduced the identical bug one level down. A
  // synthetic spacer proves the mechanism itself rather than depending on
  // whichever tab happens to be tall enough right now.
  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.id = "__stickyTestSpacer";
    spacer.style.height = "3000px";
    document.getElementById("app").appendChild(spacer);
  });
  const topBeforeScroll = (await page.locator("#desktopSidebar").boundingBox()).y;
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.waitForTimeout(150);
  const topAfterScroll = (await page.locator("#desktopSidebar").boundingBox()).y;
  const scrolledY = await page.evaluate(() => window.scrollY);
  check("the sidebar actually sticks on scroll, not just visually near the top of an unscrolled page",
    scrolledY > 1000 && Math.abs(topAfterScroll - topBeforeScroll) < 5,
    `top ${topBeforeScroll} -> ${topAfterScroll} after scrolling to y=${scrolledY}`);
  await page.evaluate(() => document.getElementById("__stickyTestSpacer").remove());

  check("no console errors at wide width", errors.length === 0, errors.join(" | "));
  await page.close();
}

await browser.close();
await target.close();
console.log(failed ? "\ndesktop-layout: FAILED" : "\ndesktop-layout: all checks passed");
process.exit(failed ? 1 : 0);
