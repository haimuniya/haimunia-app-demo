#!/usr/bin/env node
// COMM-381 (Phase 4 QA sweep) browser scenario: the full per-person invite
// lifecycle end to end — real Chromium against the in-page mock backend
// (lib/mockCloud.mjs), never the live production Supabase project, per
// COMM-234/317's own precedent for exactly this kind of check. An admin
// generates a per-person invite, a brand-new signup redeems it, the admin
// sees it flip to redeemed with the right identity attached, and a second
// redemption attempt on the same code is refused.
//
// test/helpers/mockSupabase.mjs's BUILT-IN redeem_invite_code knows nothing
// about public.invites (it always answers "member" - see its own comment),
// and admin_invite_create/admin_invite_list have no built-in at all. The
// real Postgres functions are already proven exhaustively by
// supabase/tests/0056_person_invites_test.sql and
// supabase/tests/0058_redeem_person_invite_test.sql (the permission matrix,
// the anti-enumeration 'invalid' answer, the single-use UPDATE ... RETURNING
// claim). What only a real browser adds is proving the CLIENT's own
// continuity: one raw code, shown once, actually round-trips from the
// admin's create form through a fresh signup's redeem form and back into
// the admin's own list — so this script registers a small, faithful
// in-page stand-in (one shared `invites` array closed over by all three
// RPC handlers) and drives the whole lifecycle in a single Chromium page,
// switching identity the same way a real device would: sign out, sign up
// fresh, sign back in with a password.
import { chromium } from "playwright";
import { resolveLocalOnlyTarget } from "./lib/target.mjs";
import { switchTab, consoleErrorCollector, dismissWelcomeModal } from "./lib/actions.mjs";
import { installMockCloud } from "./lib/mockCloud.mjs";

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failed = true;
}

const VERIFIED = new Date().toISOString();
const ADMIN_EMAIL = "roi@members.haimuniya.invalid";
const ADMIN_PASSWORD = "e2e-admin-password";

const seedTables = {
  profiles: [{ id: "admin1", handle: "roi", display_name: "רועי", is_admin: true, recovery_verified_at: VERIFIED, visible_to_club: true }],
  invite_redemptions: [{ user_id: "admin1", invite_id: "inv-1", role: "admin", redeemed_at: VERIFIED }],
  clubs: [{ id: "club-1", name: "חיימוניה" }],
  community_streaks: [], workout_posts: [], feed_page_rows: [], member_contact_log: [],
  coach_engagement_flags: [], analytics_events: [], notifications: [], notification_preferences: [],
  monthly_club_recaps: [], reports: [], challenges: [], onboarding_step_content: [],
  onboarding_progress: [],
};

const target = await resolveLocalOnlyTarget();
console.log(`Target: ${target.url} (local static server, mocked backend — see lib/mockCloud.mjs)`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const errors = await consoleErrorCollector(page);

await installMockCloud(page, seedTables, { user: { id: "admin1", is_anonymous: false, email: ADMIN_EMAIL } });
await page.goto(target.url, { waitUntil: "networkidle" });
await page.waitForSelector("#app", { state: "visible", timeout: 10000 });

// So the script can sign back in as the same admin later through the app's
// own login form, rather than reaching into the mock to fake a session -
// the point of this scenario is that the CLIENT carries the identity
// through, not that the harness does.
await page.evaluate((creds) => window.__mock.seedCredentials("admin1", creds.email, creds.password), { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });

// A faithful, single-shared-array stand-in for public.invites plus the
// three RPCs this scenario needs, registered once so every step below
// (the admin's create, the new signup's redeem, the admin's list re-read,
// the second-redemption refusal) reads and writes the SAME rows - the
// continuity a real two-actor lifecycle needs that pgTAP's own
// transaction-per-file tests do not have to provide, and that a mocked
// unit test asserting one RPC call in isolation does not prove either.
await page.evaluate(() => {
  const invites = [];
  let n = 0;
  window.__e2eInvites = invites; // exposed for this script's own later assertions
  window.__mock.onRpc("admin_invite_create", (args) => {
    n += 1;
    const code = `e2e${n}${Math.random().toString(36).slice(2)}`.padEnd(24, "0");
    const row = {
      id: `pinv-${n}`, code,
      role: args.p_role, label: args.p_label || null,
      created_at: new Date(Date.now() + n).toISOString(),
      expires_at: args.p_expires_at || null,
      revoked_at: null, redeemed_at: null, redeemed_by: null,
    };
    invites.push(row);
    return Promise.resolve({
      data: { id: row.id, code: row.code, role: row.role, label: row.label, created_at: row.created_at, expires_at: row.expires_at, status: "pending" },
      error: null,
    });
  });
  window.__mock.onRpc("admin_invite_list", (args) => {
    const status = (args && args.p_status) || "all";
    const data = invites
      .map((i) => {
        const redeemer = i.redeemed_by ? window.__mock.db.profiles.find((p) => p.id === i.redeemed_by) : null;
        const s = i.redeemed_at ? "redeemed" : i.revoked_at ? "revoked" : "pending";
        return {
          id: i.id, role: i.role, label: i.label, created_at: i.created_at, expires_at: i.expires_at,
          revoked_at: i.revoked_at, redeemed_at: i.redeemed_at, redeemed_by: i.redeemed_by,
          redeemed_by_display_name: redeemer ? redeemer.display_name : null,
          redeemed_by_handle: redeemer ? redeemer.handle : null,
          status: s,
        };
      })
      .filter((r) => status === "all" || r.status === status)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return Promise.resolve({ data, error: null });
  });
  window.__mock.onRpc("redeem_invite_code", (args) => {
    const user = window.__mock.getUser();
    const uid = user && user.id;
    const invite = invites.find((i) => i.code === (args && args.p_code));
    // Same generic answer for "never existed", "already spent" and
    // "revoked" - COMM-372's own anti-enumeration property, already proven
    // exhaustively in supabase/tests/0058_redeem_person_invite_test.sql.
    // This mock only needs to HOLD that property for this scenario's own
    // second-attempt check, not re-derive it.
    if (!invite || invite.redeemed_at || invite.revoked_at) {
      return Promise.resolve({ data: "invalid", error: null });
    }
    invite.redeemed_at = new Date().toISOString();
    invite.redeemed_by = uid;
    window.__mock.db.invite_redemptions.push({ user_id: uid, invite_id: null, person_invite_id: invite.id, role: invite.role, redeemed_at: invite.redeemed_at });
    return Promise.resolve({ data: invite.role, error: null });
  });
  // admin_invite_code_list / admin_invite_revoke are left unregistered -
  // they fall back to the mock's own default ({ data: null, error: null }),
  // harmless here since the shared-code panel and a revoke are not part of
  // this scenario.
});

await dismissWelcomeModal(page);
await switchTab(page, "tabCommunityBtn");
await page.waitForSelector(".subtabbar", { timeout: 5000 });

// Redesign, Phase 1: invite management now lives on its own "ניהול"
// (Manage) bottom-tab, Invites sub-tab - relocated out of Community's
// Account tab.
async function openManageInvites() {
  await switchTab(page, "tabManageBtn");
  await page.waitForSelector('[data-community-action="set-manage-tab"][data-tab="invites"]', { timeout: 5000 });
  await page.click('[data-community-action="set-manage-tab"][data-tab="invites"]');
}

// ===========================================================================
// Step 1: the admin generates a per-person invite.
// ===========================================================================
await openManageInvites();
await page.waitForSelector('[data-invite-management-section="1"]', { timeout: 5000 });
check("the admin reaches the invite management section", true);

await page.waitForSelector("#communityInviteCreate", { timeout: 5000 });
await page.fill('#communityInviteCreate input[name="label"]', "דנה, יום שלישי 06:00");
await page.locator("#communityInviteCreate").evaluate((form) => form.requestSubmit());
await page.waitForSelector('[data-invite-created="1"]', { timeout: 5000 });
const code = (await page.textContent('[data-invite-created="1"] code')).trim();
check("the admin's create form reveals a raw code exactly once", code.length > 8, code);

await page.waitForSelector("[data-invite-id]", { timeout: 5000 });
const pendingRowText = await page.locator("[data-invite-id]").first().textContent();
check("the new invite appears in the admin's own list as pending, carrying the label", pendingRowText.includes("ממתין") && pendingRowText.includes("יום שלישי"), pendingRowText);

// ===========================================================================
// Step 2: sign out, start a brand-new signup, redeem that exact code.
// ===========================================================================
// sign-out stayed put in Community's Account tab (not moved to Manage) -
// back out of Manage to reach it.
await switchTab(page, "tabCommunityBtn");
await page.waitForSelector(".subtabbar", { timeout: 5000 });
await page.click('[data-community-action="set-tab"][data-tab="account"]');
await page.waitForSelector('[data-community-action="sign-out"]', { timeout: 5000 });
await page.click('[data-community-action="sign-out"]');
await page.waitForSelector('[data-community-action="start-signup"]', { timeout: 5000 });
check("signing out drops back to the signed-out community gate", true);

await page.click('[data-community-action="start-signup"]');
await page.waitForSelector("#communityInviteCode", { timeout: 5000 });
await page.fill('#communityInviteCode input[name="code"]', code);
await page.locator("#communityInviteCode").evaluate((form) => form.requestSubmit());
await page.waitForFunction(() => !document.getElementById("communityInviteCode"), { timeout: 5000 });
check("the new signup's redemption succeeded and moved past the invite-code screen", true);

// Right after a code redemption the bootstrap session is still anonymous,
// so renderCommunityApp() shows the "create an account" (username/password)
// screen BEFORE the profile form - state.user.is_anonymous only flips once
// setCredentials() succeeds (cloud.js's own ordering, see its comment on
// this exact gate). Skipping this step is what left the earlier draft of
// this script stuck waiting on #communityProfile.
await page.waitForSelector("#communityCredentials", { timeout: 5000 });
await page.fill('#communityCredentials input[name="username"]', "new_member");
await page.fill('#communityCredentials input[name="password"]', "new-member-password");
await page.fill('#communityCredentials input[name="passwordConfirm"]', "new-member-password");
await page.locator("#communityCredentials").evaluate((form) => form.requestSubmit());
check("the new signup creates real, device-portable credentials", true);

// profiles_insert_self's own RLS requires the redemption to exist first
// (contracts.md) - this scenario's own order already satisfies that, and
// completing the profile is what gives the admin's list a real identity to
// show, rather than the two null name keys an unfinished signup leaves.
await page.waitForSelector("#communityProfile", { timeout: 5000 });
await page.fill('#communityProfile input[name="handle"]', "new_member");
await page.fill('#communityProfile input[name="displayName"]', "חברה חדשה");
await page.locator("#communityProfile").evaluate((form) => form.requestSubmit());
// Not "wait for the 'הפרופיל נשמר' message": ensureCommunityDataLoaded()'s
// own comment documents that loadFeed()'s success also calls setMessage(""),
// racing saveProfile()'s own success message on the exact same state field -
// "whichever finished last silently won". The tab bar appearing is the
// non-racy signal: it renders only once every earlier gate (redemption,
// credentials, profile) has passed.
await page.waitForSelector(".subtabbar", { timeout: 5000 });
check("the new member completed their profile and reached the real tabbed community UI", true);

// ===========================================================================
// Step 3: sign back in as the admin and see the invite flip to redeemed.
// ===========================================================================
// Still signed in as the brand-new plain member here - they have no Manage
// tab at all (staff-only), so this reaches sign-out via Community's Account
// tab, same as the admin's own sign-out in Step 2.
await switchTab(page, "tabCommunityBtn");
await page.waitForSelector(".subtabbar", { timeout: 5000 });
await page.click('[data-community-action="set-tab"][data-tab="account"]');
await page.waitForSelector('[data-community-action="sign-out"]', { timeout: 5000 });
await page.click('[data-community-action="sign-out"]');
await page.waitForSelector("#communityLogin", { timeout: 5000 });
await page.fill('#communityLogin input[name="username"]', "roi");
await page.fill('#communityLogin input[name="password"]', ADMIN_PASSWORD);
await page.locator("#communityLogin").evaluate((form) => form.requestSubmit());
await page.waitForSelector(".subtabbar", { timeout: 5000 });
check("the admin logs back in with their own username and password", true);

await openManageInvites();
await page.waitForFunction(() => !!document.querySelector("[data-invite-id]"), { timeout: 5000 });
const redeemedRowText = await page.locator("[data-invite-id]").first().textContent();
check(
  "the admin's re-fetched list shows the invite flipped to redeemed, with the new member's own identity attached",
  redeemedRowText.includes("מומש") && redeemedRowText.includes("חברה חדשה"),
  redeemedRowText
);
check("no revoke control is offered on a redeemed row", await page.locator('[data-invite-id] [data-community-action="invite-revoke"]').count() === 0);

// ===========================================================================
// Step 4: a second redemption attempt on the same code is refused.
// ===========================================================================
const secondAttempt = await page.evaluate(
  (c) => window.__mock.client.rpc("redeem_invite_code", { p_code: c, p_actor_key: "e2e-second-attempt" }).then((r) => r.data),
  code
);
check("a second redemption attempt on the already-spent code answers the generic 'invalid' - never a distinguishable 'already used'", secondAttempt === "invalid", String(secondAttempt));

const finalRedemptionCount = await page.evaluate(() => window.__mock.db.invite_redemptions.filter((r) => r.person_invite_id === window.__e2eInvites[0].id).length);
check("the refused second attempt wrote no second invite_redemptions row - the invite stays single-use", finalRedemptionCount === 1, String(finalRedemptionCount));

check("no console errors", errors.length === 0, errors.join(" | "));

await browser.close();
await target.close();
console.log(failed ? "\ncommunity-person-invite-lifecycle: FAILED" : "\ncommunity-person-invite-lifecycle: all checks passed");
process.exit(failed ? 1 : 0);
