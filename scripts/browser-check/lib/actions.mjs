// Shared page interactions used across check scripts, factored out once
// each pattern proved necessary (mostly: things a naive selector gets wrong
// on this app's specific markup — see the comments on each one).

// Completes the whole first-run sequence for a fresh browser context: the
// welcome/name modal, then the onboarding walkthrough it now triggers right
// after (added alongside the update-notifications/onboarding roadmap round —
// every fresh-context check hits this, not just onboarding-specific ones).
// THE FLAKINESS THIS FIXES (launch-readiness audit). This used to sample
// `welcomeOverlay.open` ONCE and return early if it was false:
//
//     const open = await page.evaluate(... .contains("open"));
//     if (!open) return;
//
// app.js opens that modal during boot when no local profile exists, and
// `page.goto(..., { waitUntil: "networkidle" })` does not guarantee it has
// opened yet. Lose that race and the helper returns having done nothing,
// the modal opens a moment later ON TOP of the app, and every subsequent
// click in the scenario lands on a full-page overlay instead of the control
// it was aiming at - which surfaces much later as an unrelated
// `waitForSelector` timeout, in whichever scenario happened to lose the
// race. That is the intermittent failure the suite has carried (recorded
// previously as "flaky under CPU contention"); it was a harness race, not
// contention, and not the app.
//
// Now: wait for the modal to actually appear before deciding it is not
// coming, and wait for each overlay to actually close rather than sleeping
// a fixed 150 ms and hoping.
const WELCOME_APPEAR_MS = 4000;

async function overlayOpen(page, id) {
  return page.evaluate((elId) => !!document.getElementById(elId)?.classList.contains("open"), id);
}

export async function dismissWelcomeModal(page, name = "בדיקה") {
  // Bounded wait for the modal to appear. A scenario that legitimately has
  // no welcome modal (a profile already in IndexedDB) simply times out here
  // and continues - that is the "not coming" answer, arrived at by waiting
  // rather than by sampling once.
  try {
    await page.waitForFunction(
      () => !!document.getElementById("welcomeOverlay")?.classList.contains("open"),
      { timeout: WELCOME_APPEAR_MS },
    );
  } catch {
    return;
  }

  await page.fill("#welcomeNameInput", name);
  await page.click("[data-action='save-user-name']");
  // Wait for it to be gone rather than sleeping: a slow render must not
  // leave the overlay swallowing the scenario's next click.
  await page.waitForFunction(
    () => !document.getElementById("welcomeOverlay")?.classList.contains("open"),
    { timeout: 10000 },
  );

  if (await overlayOpen(page, "onboardingOverlay")) {
    await page.click("[data-action='close-onboarding']");
    await page.waitForFunction(
      () => !document.getElementById("onboardingOverlay")?.classList.contains("open"),
      { timeout: 10000 },
    );
  }
}

// Submit a form the way a member does - by clicking its submit button.
//
// THE RACE THIS REPLACES (launch-readiness audit). Several scenarios did:
//
//     await page.locator("#someForm").evaluate((form) => form.requestSubmit());
//
// Playwright resolves that locator to a node, then evaluates against it.
// This app re-renders by replacing #content's innerHTML wholesale, so any
// render landing between those two steps swaps the form for a fresh,
// identical-looking node - and requestSubmit() then fires on a DETACHED
// element, where the event bubbles to nothing and the app's delegated
// submit handler never runs. The scenario sees the form still on screen
// and times out somewhere later, with no error and no clue.
//
// Confirmed by instrumenting the mock client: on a failing run,
// redeem_invite_code was never called at all - the submit simply vanished.
// It reproduced on the FIRST page of a browser (the slowest render, where
// maybeAutoStartBackup()'s message triggers an extra rerender at exactly
// the wrong moment) and against pristine HEAD, so it is the harness racing
// the app, not a regression.
//
// page.click() re-resolves the selector and waits for actionability at
// click time, so it cannot hold a stale node. Prefer this everywhere a
// form is submitted.
export async function submitForm(page, formSelector, { timeout = 15000 } = {}) {
  await page.click(`${formSelector} button[type="submit"]`, { timeout });
}

// Picking a movement by an exact-name query hits the app's own "+ add as
// new" shortcut button, which also carries the movement-btn class and
// sorts first for an exact match — so this always searches by partial name
// and waits for the filtered list before clicking, not `nth=0` blindly.
export async function selectMovement(page, partialQuery) {
  await page.click("[data-action='open-picker']");
  await page.fill("#pickerSearch", partialQuery);
  await page.waitForFunction(
    (q) => {
      const btn = document.querySelector(".modal-list .movement-btn[data-id]");
      return btn && btn.textContent.includes(q);
    },
    partialQuery,
    { timeout: 5000 }
  );
  await page.click(".modal-list .movement-btn[data-id] >> nth=0");
  await page.waitForFunction(() => !document.getElementById("pickerOverlay").classList.contains("open"), { timeout: 5000 });
}

// COMM-360: selectedWodId now defaults to unset (was WOD_LIBRARY[0]/"Fran"),
// so a fresh visit to the WOD tab's log subtab shows a pick-a-WOD empty
// state with no exercise-select/open-wod-picker button of its own (same
// shape as the log tab's own pick-a-movement state) - anything that needs
// a real WOD selected (the picker, the builder, an actual log/save) has to
// pick one first. Goes through the benchmarks subtab, same as a real user
// would, and lands back on the log subtab with that WOD selected.
export async function selectBenchmarkWod(page, id) {
  await page.click("button.subtabbtn[data-subtab='benchmarks']");
  await page.waitForTimeout(150);
  await page.click(`[data-action='select-benchmark'][data-id='${id}']`);
  await page.waitForTimeout(150);
}

// The PR-celebration popup blocks every click behind it until dismissed.
// Returns whether it was actually open, so callers can assert on that too.
export async function dismissCelebrationIfOpen(page) {
  const open = await page.evaluate(() => document.getElementById("celebrationOverlay")?.classList.contains("open"));
  if (open) {
    await page.click("#celebrationOverlay button[data-action='close-celebration']");
    await page.waitForTimeout(150);
  }
  return open;
}

// COMM-327 put the 4 main (offline training-log) tabs into a fixed bottom
// tab bar (#tabAddBtn/#tabHistoryBtn/#tabCalendarBtn/#tabWodBtn, reachable
// directly, no menu) and left Community (#tabCommunityBtn) as the one item
// still inside the hamburger's full-page nav menu. That's since been
// revisited: Community is `main: true` too now (see app.js's getNavItems()
// comment for why - it already has its own on-screen subtabbar, the same
// thing WOD already proved works fine from the bottom bar), so all 5 ids
// are reachable directly. This helper used to branch on which set a given
// id belonged to; now every id takes the same path - close the nav menu
// overlay first if a caller left it open (it would otherwise sit on top
// of, and intercept clicks on, the bottom bar underneath), then click the
// bottom-bar button directly. No id opens the menu to be reached any more.
export async function switchTab(page, tabId) {
  const menuOpen = await page.evaluate(() => document.getElementById("navMenuOverlay")?.classList.contains("open"));
  if (menuOpen) {
    // The explicit close (X) button, not the bare [data-action='close-
    // nav-menu'] selector - that also matches the overlay div itself
    // (backdrop-click-to-close), whose bounding-box center sits under
    // the full-height modal-sheet it contains, which would intercept
    // the click the same way this fix is for.
    await page.click("#navMenuOverlay button[data-action='close-nav-menu']");
    await page.waitForFunction(() => !document.getElementById("navMenuOverlay")?.classList.contains("open"), { timeout: 5000 });
  }
  await page.click(`#${tabId}`);
}

// Settings (theme, text scale, backup, delete-all-data) moved off the
// bottom of every tab into their own screen, reached through the nav
// menu. Opens the menu if needed, taps its settings row, and waits for
// the settings overlay to actually be open before returning.
export async function openSettings(page) {
  const menuOpen = await page.evaluate(() => document.getElementById("navMenuOverlay")?.classList.contains("open"));
  if (!menuOpen) await page.click("[data-action='open-nav-menu']");
  // Scoped to the nav-menu overlay specifically: the desktop sidebar (Phase
  // 4) renders its own "open-settings" row from the same markup, always in
  // the DOM (just CSS-hidden below the 900px breakpoint) - a bare
  // [data-action='open-settings'] selector resolves in DOM order and can
  // silently grab that hidden copy instead of the visible mobile one.
  await page.click("#navMenuOverlay [data-action='open-settings']");
  await page.waitForFunction(() => document.getElementById("settingsOverlay")?.classList.contains("open"), { timeout: 5000 });
}

export async function consoleErrorCollector(page) {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    // Known, expected, harmless — frame-ancestors can't be set via <meta>,
    // documented inline in index.html's own CSP comment.
    if (msg.text().includes("frame-ancestors")) return;
    errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push("pageerror: " + err.message));
  return errors;
}
