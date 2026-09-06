#!/usr/bin/env node
// Redesign, Phase 3 browser scenario: the full first-run path in a real
// browser - invite code -> credentials -> the new 3-step intro carousel ->
// the existing, unmodified profile-completion gate -> the normal tabbed
// Community UI. Real Chromium against the in-page mock backend
// (lib/mockCloud.mjs), same shape every other community-*.mjs scenario
// here uses. The carousel's own step-by-step behavior already has
// thorough jsdom coverage (test/community-intro-carousel.test.mjs); this
// adds the one thing that only a real browser proves - that the whole
// chain, including the two gates on either side of the carousel that this
// phase deliberately did not touch, still runs end to end with real DOM
// events, not window.eval'd handler calls.
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { consoleErrorCollector, dismissWelcomeModal, submitForm } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend — see lib/mockCloud.mjs)`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const errors = await consoleErrorCollector(page);

// seenIntroCarousel: false is the one override this scenario needs -
// every other community-*.mjs script gets the "already seen" default so
// the carousel never intercepts a flow it isn't testing.
await installMockCloud(page, {}, { seenIntroCarousel: false });

await page.goto(target.url, { waitUntil: "networkidle" });
// Timeouts here are deliberately generous rather than the 5000/10000 ms the
// rest of this suite uses. This scenario drives the longest chain in the
// app - invite redemption, credential creation, an auth state change, and
// three renders - and run-all.mjs runs scenarios back-to-back on a loaded
// machine, where a 10 s budget was observed to expire before the carousel
// painted even though every assertion passes when the file is run alone.
// A release gate that fails intermittently teaches people to re-run it
// until it goes green, which is worse than a slow gate.
await page.waitForSelector("#app", { state: "visible", timeout: 30000 });
await dismissWelcomeModal(page);

await page.click("#tabCommunityBtn");
await page.waitForSelector('[data-community-action="start-signup"]', { timeout: 20000 });
await page.click('[data-community-action="start-signup"]');
await page.waitForSelector("#communityInviteCode", { timeout: 20000 });
await page.fill('#communityInviteCode input[name="code"]', "CLUBCODE");
await submitForm(page, "#communityInviteCode");

await page.waitForSelector("#communityCredentials", { timeout: 30000 });
await page.fill('#communityCredentials input[name="username"]', "new_member");
await page.fill('#communityCredentials input[name="password"]', "NewMember1pass");
await page.fill('#communityCredentials input[name="passwordConfirm"]', "NewMember1pass");
await submitForm(page, "#communityCredentials");

await page.waitForSelector('[data-intro-carousel="1"]', { timeout: 30000 });
check("the intro carousel appears right after credentials, before profile completion", true);
check("starts on the first screen", (await page.getAttribute('[data-intro-carousel="1"]', "data-intro-step")) === "welcome_intro");
check("no back button on the first screen", (await page.$('[data-community-action="intro-carousel-back"]')) === null);

await page.click('[data-community-action="intro-carousel-next"]');
await page.waitForFunction(() => document.querySelector('[data-intro-carousel="1"]')?.dataset.introStep === "club_rules", { timeout: 20000 });
await page.click('[data-community-action="intro-carousel-next"]');
await page.waitForFunction(() => document.querySelector('[data-intro-carousel="1"]')?.dataset.introStep === "getting_started", { timeout: 20000 });
const lastLabel = await page.textContent('[data-community-action="intro-carousel-next"]');
check("the last screen's button names what happens next", lastLabel.includes("המשך להשלמת הפרופיל"), lastLabel.trim());

await page.click('[data-community-action="intro-carousel-next"]');
await page.waitForSelector("#communityProfile", { timeout: 20000 });
check("finishing the carousel lands on the existing, unmodified profile-completion gate", true);
check("the carousel itself is gone", (await page.$('[data-intro-carousel="1"]')) === null);

const seenFlag = await page.evaluate(() => localStorage.getItem("haimunia-demo:seenIntroCarousel"));
check("the one-time device flag is stamped", seenFlag === "1");

await page.fill('#communityProfile input[name="handle"]', "new_member");
await submitForm(page, "#communityProfile");
await page.waitForSelector(".subtabbar", { timeout: 20000 });
check("profile completion lands in the normal tabbed Community UI", true);
// Not a reload/persistence check (this script never reloads the page) -
// just confirming the carousel stays gone, not re-inserted, now that the
// tabbed Community UI itself has rendered on top of it.
check("the carousel is still absent now that the tabbed Community UI has loaded", (await page.$('[data-intro-carousel="1"]')) === null);

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\ncommunity-intro-carousel: FAILED" : "\ncommunity-intro-carousel: all checks passed");
process.exit(failed ? 1 : 0);
