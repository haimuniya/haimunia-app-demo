// Shared page interactions used across check scripts, factored out once
// each pattern proved necessary (mostly: things a naive selector gets wrong
// on this app's specific markup — see the comments on each one).

// Completes the whole first-run sequence for a fresh browser context: the
// welcome/name modal, then the onboarding walkthrough it now triggers right
// after (added alongside the update-notifications/onboarding roadmap round —
// every fresh-context check hits this, not just onboarding-specific ones).
export async function dismissWelcomeModal(page, name = "בדיקה") {
  const open = await page.evaluate(() => document.getElementById("welcomeOverlay")?.classList.contains("open"));
  if (!open) return;
  await page.fill("#welcomeNameInput", name);
  await page.click("[data-action='save-user-name']");
  await page.waitForTimeout(150);
  const onboardingOpen = await page.evaluate(() => document.getElementById("onboardingOverlay")?.classList.contains("open"));
  if (onboardingOpen) {
    await page.click("[data-action='close-onboarding']");
    await page.waitForTimeout(150);
  }
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
