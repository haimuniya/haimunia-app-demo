#!/usr/bin/env node
// COMM-234 browser scenario: RSVP to an event and see the capacity figure
// update live, real Chromium against the in-page mock backend (lib/mockCloud.mjs).
//
// Caveat, same class as Phase 0's local pgTAP gap: genuine Postgres realtime
// (a second device's WAL-driven postgres_changes push) cannot be simulated
// by a single Chromium page with no live Postgres behind it. What this
// script verifies is the path every RSVP actually takes for the member who
// just tapped it — event_rsvp() resolves, the client re-fetches the event
// through its own existing load path, and the capacity figure the member
// sees updates immediately, with no reload — which is the "live" a real
// user experiences. The second-device confirmation over
// chal-progress/feed-* channels is covered against the mock RLS-faithful
// backend at the RPC layer in test/community-realtime-and-search.test.mjs;
// a real cross-device push is not reproducible in CI without a live
// Postgres, exactly the caveat already logged for the local pgTAP gap.
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { switchTab, consoleErrorCollector, dismissWelcomeModal } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const NOW = Date.now();
const iso = (deltaHours) => new Date(NOW + deltaHours * 3600000).toISOString();
const VERIFIED = new Date().toISOString();

const seedTables = {
  profiles: [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_in_attendee_lists: true },
    { id: "coach1", handle: "yael", display_name: "יעל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_in_attendee_lists: true },
  ],
  invite_redemptions: [
    { user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
    { user_id: "coach1", invite_id: "inv-1", role: "coach", redeemed_at: VERIFIED },
  ],
  clubs: [{ id: "club-1", name: "חיימוניה" }],
  events: [{ id: "e1", event_type: "workshop", title: "סדנת גמישות", description: "", status: "published", start_at: iso(24), end_at: null, location: "אולם 1", capacity: 2, registration_deadline: null, created_by: "coach1" }],
  event_attendees: [], workout_posts: [], post_comments: [],
  feed_page_rows: [], analytics_events: [], notifications: [], notification_preferences: [],
};

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend — see lib/mockCloud.mjs)`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const errors = await consoleErrorCollector(page);

await installMockCloud(page, seedTables, { user: { id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" } });

await page.goto(target.url, { waitUntil: "networkidle" });
await page.waitForSelector("#app", { state: "visible", timeout: 10000 });
await dismissWelcomeModal(page);

await switchTab(page, "tabCommunityBtn");
await page.waitForSelector(".subtabbar", { timeout: 5000 });
await page.click('[data-community-action="set-tab"][data-tab="boards"]');
await page.waitForFunction(() => document.body.textContent.includes("אירועי המועדון"), { timeout: 5000 });

await page.click('[data-event-id="e1"] [data-community-action="open-event"]');
await page.waitForSelector('[data-cloud-dialog="eventView"]', { timeout: 5000 });
await page.waitForFunction(() => document.body.textContent.includes("0 / 2"), { timeout: 5000 });
check("event detail opens showing the starting capacity, 0 / 2", true);

await page.click('[data-cloud-dialog="eventView"] [data-community-action="event-rsvp"][data-response="going"]');
await page.waitForFunction(
  () => window.__mock.db.event_attendees.some((a) => a.event_id === "e1" && a.user_id === "u1" && a.response === "going"),
  { timeout: 5000 }
);
await page.waitForFunction(() => document.body.textContent.includes("1 / 2"), { timeout: 5000 });
check("RSVPing going updates the capacity figure to 1 / 2 with no reload", true);

const goingLabelActive = await page.evaluate(
  // COMM-325 replaced .primary with .selected for chip "currently chosen"
  // state (vs. .primary staying reserved for submit/action buttons) -
  // this control is a selection, not an action.
  () => document.querySelector('[data-cloud-dialog="eventView"] [data-community-action="event-rsvp"][data-response="going"]').classList.contains("selected")
);
check("the Going control itself flips to the active/selected state", goingLabelActive);

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\ncommunity-event-rsvp: FAILED" : "\ncommunity-event-rsvp: all checks passed");
process.exit(failed ? 1 : 0);
