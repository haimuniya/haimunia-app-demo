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
import { installMockCloud } from "./lib/mockCloud.mjs";

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
  // COMM-333: cloud.js boots unconditionally regardless of viewport width,
  // and cloud-config.js points at the real, live production Supabase
  // project - see ladder.mjs's own comment on this same call for the full
  // reasoning (safety, and the source of intermittent 401/409s).
  await installMockCloud(page);
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
  // COMM-333: cloud.js boots unconditionally regardless of viewport width,
  // and cloud-config.js points at the real, live production Supabase
  // project - see ladder.mjs's own comment on this same call for the full
  // reasoning (safety, and the source of intermittent 401/409s).
  await installMockCloud(page);
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

// --- UX audit §6: the wide-desktop tier -------------------------------------
//
// The finding this covers, measured in this app at 1440x900 before the
// change: .app-shell{max-width:1100px} put the shell at x=170-1270, #app at
// x=300-860 and #desktopSidebar at x=892-1140 - 808px of live column in a
// 1440px viewport, so 632px (43.9%) carried nothing at all. At 1920 it was
// 1112px (57.9%).
//
// What is asserted below is deliberately BOTH halves of the fix, because
// each half is meaningless on its own and it would be easy to "pass" this
// section while shipping the wrong thing:
//
//   * Lifting the .app-shell cap on its own reclaims NOTHING. The shell is
//     centred by margin:0 auto and its contents are centred inside it, so a
//     wider under-filled shell puts the columns on exactly the same x and
//     just moves the dead space inboard. That is checked as an equality
//     (#app stays at x=300, w=560), not hand-waved.
//   * The context column is what actually fills the space - but it is a
//     mount point owned by app.js/cloud.js, and index.html ships it empty.
//     An empty sticky card would be worse than no card, so the rules that
//     draw it are gated on it having a real element child. Both states are
//     checked: empty => not rendered at all; populated => a real column.
//
// The populated state is driven here by writing into #contextCol from the
// test, which IS the production contract (see the comment on #contextCol in
// index.html) - not a fixture that bypasses it.
const CONTEXT_HTML = '<h2 style="font-size:15px">היסטוריה</h2><div style="height:900px"></div>';
async function colGeometry(page) {
  return page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      if (getComputedStyle(el).display === "none") return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), w: Math.round(r.width) };
    };
    const app = box("#app"), side = box("#desktopSidebar"), col = box("#contextCol");
    return {
      app, side, col,
      livePx: [app, side, col].filter(Boolean).reduce((s, o) => s + o.w, 0),
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
}

{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = await consoleErrorCollector(page);
  await installMockCloud(page);
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible" });
  await dismissWelcomeModal(page);

  // 1. The empty column must be invisible, and the two-column layout must be
  //    bit-for-bit what it was before the cap moved.
  const empty1440 = await colGeometry(page);
  check("an unfilled context column renders nothing at all (no empty sticky card)",
    empty1440.col === null,
    `#contextCol box=${JSON.stringify(empty1440.col)}`);
  check("lifting the .app-shell cap does not move the two existing columns",
    empty1440.app.x === 300 && empty1440.app.w === 560 && empty1440.side.x === 892 && empty1440.side.w === 248,
    `app=${JSON.stringify(empty1440.app)} sidebar=${JSON.stringify(empty1440.side)}`);

  // 2. Populated: three columns, and the logging column has not moved a pixel.
  await page.evaluate((html) => { document.getElementById("contextCol").innerHTML = html; }, CONTEXT_HTML);
  await page.waitForTimeout(120);
  const full1440 = await colGeometry(page);
  check("a populated context column appears as a third column at 1440",
    full1440.col !== null && full1440.col.w >= 380 && full1440.col.w <= 520,
    `context=${JSON.stringify(full1440.col)}`);
  // THE constraint of spec §6: logging is a phone-shaped task done at a rack.
  // Before the explicit flex:0 0 560px this measured 424px, because the third
  // flex item reasserted the grow/shrink maths that max-width:560px only
  // masked while there were two columns.
  check("the 560px logging column is still exactly 560px with a third column present",
    full1440.app.w === 560,
    `#app w=${full1440.app.w}`);
  check("the third column reclaims the dead space (>=90% of a 1440px viewport is live column)",
    full1440.livePx >= 1296 && full1440.scrollWidth === 1440,
    `live=${full1440.livePx}px of ${full1440.viewport} scrollWidth=${full1440.scrollWidth}`);

  // 3. It is a sticky rail, not a block that scrolls away - same mechanism
  //    (and the same overflow trap) as .desktop-sidebar above.
  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.id = "__ctxTestSpacer";
    spacer.style.height = "3000px";
    document.getElementById("app").appendChild(spacer);
  });
  const ctxBefore = (await page.locator("#contextCol").boundingBox()).y;
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.waitForTimeout(150);
  const ctxAfter = (await page.locator("#contextCol").boundingBox()).y;
  check("the context column sticks on scroll rather than scrolling away",
    Math.abs(ctxAfter - ctxBefore) < 5,
    `top ${ctxBefore} -> ${ctxAfter} at scrollY=${await page.evaluate(() => window.scrollY)}`);
  await page.evaluate(() => { window.scrollTo(0, 0); document.getElementById("__ctxTestSpacer").remove(); });

  // 4. The contract's hide path. `innerHTML = ""` must genuinely take the
  //    column off screen - a consumer that clears it on tab change must not
  //    be left with a 520px hole.
  await page.evaluate(() => { document.getElementById("contextCol").innerHTML = ""; });
  await page.waitForTimeout(120);
  check("clearing the column with innerHTML = \"\" removes it and restores the two-column layout",
    (await colGeometry(page)).col === null && (await colGeometry(page)).app.x === 300);
  // And the near-miss: whitespace is not content. A column drawn for "\n"
  // would be exactly the empty card this section exists to prevent.
  await page.evaluate(() => { document.getElementById("contextCol").innerHTML = "\n  "; });
  await page.waitForTimeout(120);
  check("whitespace-only content does not draw a column either",
    (await colGeometry(page)).col === null);
  await page.evaluate(() => { document.getElementById("contextCol").innerHTML = ""; });

  // 5. The breakpoint boundary. 1280 rather than the spec's 1200 for a reason
  //    that is pure arithmetic: sidebar 248 + logging 560 + the column's own
  //    380px floor is already 1188px of column, and a 1200px viewport leaves
  //    12px for two gutters and two page margins. Honouring 1200 literally
  //    means a horizontal scrollbar or a ~288px column, and 380 is the floor
  //    precisely because the modules that mount here are the phone-shaped
  //    ones. Both sides of the boundary are pinned so the number cannot drift
  //    silently in either direction.
  await page.evaluate((html) => { document.getElementById("contextCol").innerHTML = html; }, CONTEXT_HTML);
  await page.setViewportSize({ width: 1279, height: 900 });
  await page.waitForTimeout(150);
  const below = await colGeometry(page);
  check("one pixel below the breakpoint there is no third column and no overflow",
    below.col === null && below.app.w === 560 && below.scrollWidth === 1279,
    `context=${JSON.stringify(below.col)} app=${below.app.w} scrollWidth=${below.scrollWidth}`);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(150);
  const at = await colGeometry(page);
  check("at the breakpoint the column appears at its 380px floor, the logging column holds, and nothing overflows",
    at.col !== null && at.col.w >= 380 && at.app.w === 560 && at.scrollWidth === 1280,
    `context=${JSON.stringify(at.col)} app=${at.app.w} scrollWidth=${at.scrollWidth}`);
  await page.evaluate(() => { document.getElementById("contextCol").innerHTML = ""; });

  // 6. Overlays get a content measure at desktop too. .modal-sheet is
  //    width:100%, which is the right answer on a phone (where 100% IS the
  //    content measure) and had no cap at all above 900px. Measured at 1440
  //    before the fix: #settingsSheet 1440px wide, so the segmented theme
  //    control ran to 1374px with 452x44 options - the one screen whose
  //    stated purpose (spec §4.1) is that a control should look like a
  //    control. The exercise picker was the same, with 1400px rows.
  //    Two surfaces are checked because they are the two presentations:
  //    a full-height panel and a bottom sheet.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(150);
  const sheetGeom = async (sel) => page.evaluate((s) => {
    const el = document.querySelector(s); if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), w: Math.round(r.width), centred: Math.abs((r.x + r.width / 2) - window.innerWidth / 2) <= 1 };
  }, sel);

  await page.click("#desktopSidebar [data-action='open-settings']");
  await page.waitForSelector("#settingsOverlay.open");
  await page.waitForTimeout(150);
  const settingsSheet = await sheetGeom("#settingsSheet");
  const segOpt = await page.evaluate(() => {
    const el = document.querySelector("#themeRow [role='radio']");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  check("the settings panel gets a content measure at 1440 instead of spanning the viewport",
    settingsSheet.w === 592 && settingsSheet.centred,
    `#settingsSheet=${JSON.stringify(settingsSheet)}`);
  check("the segmented theme control is a control-shaped control at 1440, not a 452px band",
    segOpt !== null && segOpt.w <= 200 && segOpt.h >= 44,
    `option box=${JSON.stringify(segOpt)}`);
  await page.click("button[data-action='close-settings']");
  await page.waitForTimeout(150);

  await page.click("[data-action='open-picker']");
  await page.waitForSelector("#pickerOverlay.open");
  await page.waitForTimeout(150);
  const pickerSheet = await sheetGeom("#pickerOverlay .modal-sheet");
  check("a bottom sheet is capped and centred at 1440 rather than a full-viewport band",
    pickerSheet.w === 592 && pickerSheet.centred,
    `picker sheet=${JSON.stringify(pickerSheet)}`);
  await page.click("#pickerOverlay button[data-action='close-picker']");
  await page.waitForTimeout(150);

  check("no console errors across the wide-desktop tier", errors.length === 0, errors.join(" | "));
  await page.close();
}

// --- UX audit §6.2: the staff table area ------------------------------------
//
// "#app and the context column merge into one ~940px table area" for the
// ניהול tab - the moderation queue, the member roster, the incomplete-signups
// list and the analytics dashboard are genuinely tabular admin work, and this
// is the one surface where 560px is a cost rather than a feature. It is also
// the only part of §6 that needs no new JS, so unlike the context column it
// ships working today.
//
// The CSS hook is markup index.html does not own (renderManageApp() in
// cloud.js: a .subtabbar with its own aria-label, and per-tab #manageTab-*
// ids). That is exactly why this check drives the REAL manage tab behind the
// real staff gate rather than pasting a copy of that markup into #content -
// a fixture would keep passing after a cloud.js rename, which is the one
// failure worth catching here.
{
  const VERIFIED = new Date().toISOString();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = await consoleErrorCollector(page);
  await installMockCloud(page, {
    profiles: [{ id: "coach-1", handle: "coach", display_name: "מאמנת", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "coach-1", invite_id: "i1", role: "head_coach", redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    workout_posts: [], feed_page_rows: [], post_comments: [], reports: [], admin_actions: [],
    pins: [], posting_restrictions: [], follows: [], hidden_posts: [], notifications: [],
    notification_preferences: [],
  }, { user: { id: "coach-1", is_anonymous: false, email: "coach@members.haimuniya.invalid" } });
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible" });
  await dismissWelcomeModal(page);

  const memberWidth = await page.evaluate(() => Math.round(document.getElementById("app").getBoundingClientRect().width));
  check("a member-facing tab keeps the 560px column at 1440", memberWidth === 560, `#app w=${memberWidth}`);

  // getNavItems() only emits the manage row for a staff viewer, so reaching
  // it from the sidebar is itself the permission check.
  await page.waitForSelector("#desktopSidebar .navrow[data-tab='manage']", { timeout: 10000 });
  await page.click("#desktopSidebar .navrow[data-tab='manage']");
  await page.waitForSelector("#content .subtabbar[aria-label='ניווט בניהול']", { timeout: 10000 });

  const manage = await colGeometry(page);
  check("the real ניהול tab widens #app to the ~940px table area at 1440",
    manage.app.w === 940 && manage.scrollWidth === 1440,
    `#app w=${manage.app.w} scrollWidth=${manage.scrollWidth}`);
  check("the staff table area reclaims the dead space (>=80% of 1440 is live column)",
    manage.livePx >= 1152,
    `live=${manage.livePx}px of ${manage.viewport}`);

  // At 1200 the same rule applies but there is less room; it must shrink to
  // fit rather than push a horizontal scrollbar onto an admin screen.
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.waitForTimeout(150);
  const manage1200 = await colGeometry(page);
  check("the staff table area shrinks to fit at 1200 instead of overflowing",
    manage1200.app.w > 560 && manage1200.app.w <= 940 && manage1200.scrollWidth === 1200,
    `#app w=${manage1200.app.w} scrollWidth=${manage1200.scrollWidth}`);

  // Below the tier, admin work is back in the 560px column - the widening is
  // additive at wide widths and changes nothing that already worked.
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.waitForTimeout(150);
  const manage1100 = await colGeometry(page);
  check("below 1200 the ניהול tab is unchanged at 560px",
    manage1100.app.w === 560, `#app w=${manage1100.app.w}`);

  check("no console errors on the staff tier", errors.length === 0, errors.join(" | "));
  await page.close();
}

// --- The phone layout must not have moved ------------------------------------
// #contextCol is markup that now exists at every width. .context-col is
// display:none outside the ≥1280 tier, so at 390px it must be a zero-box that
// contributes nothing - measured against the mobile column's own geometry,
// which is unchanged from before this section existed.
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = await consoleErrorCollector(page);
  await installMockCloud(page);
  await page.goto(target.url, { waitUntil: "networkidle" });
  await page.waitForSelector("#app", { state: "visible" });
  await dismissWelcomeModal(page);

  const phone = await page.evaluate(() => {
    const col = document.getElementById("contextCol");
    const app = document.getElementById("app").getBoundingClientRect();
    return {
      colDisplay: getComputedStyle(col).display,
      colBox: col.getBoundingClientRect().width + "x" + col.getBoundingClientRect().height,
      appX: Math.round(app.x), appW: Math.round(app.width),
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  check("the context column is display:none and a zero box at 390px",
    phone.colDisplay === "none" && phone.colBox === "0x0", JSON.stringify(phone));
  check("the phone content column is untouched (x=0, full 390px, no horizontal scroll)",
    phone.appX === 0 && phone.appW === 390 && phone.scrollWidth === 390, JSON.stringify(phone));
  check("no console errors at phone width", errors.length === 0, errors.join(" | "));
  await page.close();
}

await browser.close();
await target.close();
console.log(failed ? "\ndesktop-layout: FAILED" : "\ndesktop-layout: all checks passed");
process.exit(failed ? 1 : 0);
