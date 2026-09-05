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
import { consoleErrorCollector, dismissWelcomeModal } from "./lib/actions.mjs";
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
await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
await dismissWelcomeModal(page);

await page.click("#tabCommunityBtn");
await page.waitForSelector('[data-community-action="start-signup"]', { timeout: 5000 });
await page.click('[data-community-action="start-signup"]');
await page.waitForSelector("#communityInviteCode", { timeout: 5000 });
await page.fill('#communityInviteCode input[name="code"]', "CLUBCODE");
await page.locator("#communityInviteCode").evaluate((form) => form.requestSubmit());

await page.waitForSelector("#communityCredentials", { timeout: 10000 });
await page.fill('#communityCredentials input[name="username"]', "new_member");
await page.fill('#communityCredentials input[name="password"]', "new-member-password");
await page.fill('#communityCredentials input[name="passwordConfirm"]', "new-member-password");
await page.locator("#communityCredentials").evaluate((form) => form.requestSubmit());

await page.waitForSelector('[data-intro-carousel="1"]', { timeout: 10000 });
check("the intro carousel appears right after credentials, before profile completion", true);
check("starts on the first screen", (await page.getAttribute('[data-intro-carousel="1"]', "data-intro-step")) === "welcome_intro");
check("no back button on the first screen", (await page.$('[data-community-action="intro-carousel-back"]')) === null);

await page.click('[data-community-action="intro-carousel-next"]');
await page.waitForFunction(() => document.querySelector('[data-intro-carousel="1"]')?.dataset.introStep === "club_rules", { timeout: 5000 });
await page.click('[data-community-action="intro-carousel-next"]');
await page.waitForFunction(() => document.querySelector('[data-intro-carousel="1"]')?.dataset.introStep === "getting_started", { timeout: 5000 });
const lastLabel = await page.textContent('[data-community-action="intro-carousel-next"]');
check("the last screen's button names what happens next", lastLabel.includes("המשך להשלמת הפרופיל"), lastLabel.trim());

await page.click('[data-community-action="intro-carousel-next"]');
await page.waitForSelector("#communityProfile", { timeout: 5000 });
check("finishing the carousel lands on the existing, unmodified profile-completion gate", true);
check("the carousel itself is gone", (await page.$('[data-intro-carousel="1"]')) === null);

const seenFlag = await page.evaluate(() => localStorage.getItem("haimunia-demo:seenIntroCarousel"));
check("the one-time device flag is stamped", seenFlag === "1");

await page.fill('#communityProfile input[name="handle"]', "new_member");
await page.locator("#communityProfile").evaluate((form) => form.requestSubmit());
await page.waitForSelector(".subtabbar", { timeout: 5000 });
check("profile completion lands in the normal tabbed Community UI", true);
check("the carousel never reappears once a profile exists", (await page.$('[data-intro-carousel="1"]')) === null);

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\ncommunity-intro-carousel: FAILED" : "\ncommunity-intro-carousel: all checks passed");
process.exit(failed ? 1 : 0);
