// COMM-218. Announcement priority levels and expiry, client side. Schema
// (announcements.priority, announcements.expires_at, the important mirror,
// the announcements_read expiry predicate) already shipped in
// 202608290010 and is exercised server-side by
// supabase/tests/0030_announcement_priority_expiry_test.sql; this file only
// covers what cloud.js owns:
//
// - the composer's 3-way priority select and optional expiry field, with
//   client-side "must be after now" validation and the ticket's exact
//   Hebrew save-failure copy;
// - urgent rendering visually stronger than important, both carrying an
//   icon and a text label (never colour alone), normal carrying no badge;
// - a defensive client-side mirror of the server's expiry predicate, so an
//   announcement that has expired mid-session drops out of the feed top
//   area even without a refetch;
// - COMM-155's pin cap/behaviour staying genuinely unaffected: a pin on an
//   expired announcement stays in the pinned strip, because the strip
//   renders off the pins table's own stored note, never off a live
//   announcements re-read.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const PAST = new Date(Date.now() - 3600000).toISOString();
const FUTURE_LOCAL = "2099-01-01T10:00";
const PAST_LOCAL = "2000-01-01T10:00";

function staffMock(overrides) {
  const mock = createMockSupabase(Object.assign({
    profiles: [
      { id: "staff-1", handle: "coach", display_name: "מאמן", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true },
    ],
    invite_redemptions: [
      { user_id: "staff-1", invite_id: "i1", role: "head_coach", redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    announcements: [],
    pins: [],
    admin_actions: [],
    workout_posts: [], feed_page_rows: [], follows: [], hidden_posts: [], saved_posts: [], notifications: [],
  }, overrides || {}));
  mock.setUser({ id: "staff-1", is_anonymous: false, email: "coach@members.haimuniya.invalid" });
  return mock;
}

async function openFeed(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityClubTop"), 4000);
  await waitFor(() => !!window.document.getElementById("communityAnnouncement"), 4000);
}

test("the composer offers normal/important/urgent plus an optional expiry field, and posting urgent with an expiry writes both columns", async () => {
  const mock = staffMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);

  const form = window.document.getElementById("communityAnnouncement");
  const select = form.querySelector('select[name="priority"]');
  assert.ok(select, "a priority select exists");
  const optionValues = Array.from(select.options).map((o) => o.value);
  assert.deepEqual(optionValues, ["normal", "important", "urgent"]);
  assert.equal(select.value, "normal", "defaults to normal");

  form.querySelector('input[name="title"]').value = "אימון בוקר בוטל";
  form.querySelector('textarea[name="body"]').value = "בשל תחזוקה, האימון של הבוקר בוטל";
  select.value = "urgent";
  form.querySelector('input[name="expiresAt"]').value = FUTURE_LOCAL;
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

  await waitFor(() => mock.db.announcements.length === 1, 3000);
  const row = mock.db.announcements[0];
  assert.equal(row.priority, "urgent");
  assert.ok(row.expires_at, "expires_at was written");
  assert.ok(new Date(row.expires_at).getTime() > Date.now());
});

test("an expiry that is not after the moment of submission is rejected client-side, with no insert and no server CHECK involved", async () => {
  const mock = staffMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);

  const form = window.document.getElementById("communityAnnouncement");
  form.querySelector('input[name="title"]').value = "כותרת";
  form.querySelector('textarea[name="body"]').value = "תוכן";
  form.querySelector('input[name="expiresAt"]').value = PAST_LOCAL;
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

  await waitFor(() => /תאריך התפוגה חייב להיות אחרי מועד הפרסום/.test(window.document.body.textContent), 3000);
  assert.equal(mock.db.announcements.length, 0, "nothing was inserted");
});

test("a save failure shows the ticket's exact Hebrew copy", async () => {
  const mock = staffMock();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);

  const realFrom = mock.client.from.bind(mock.client);
  mock.client.from = (table) => {
    const chain = realFrom(table);
    if (table === "announcements") chain.insert = () => ({ then: (res) => Promise.resolve(res({ error: { message: "boom" } })) });
    return chain;
  };

  const form = window.document.getElementById("communityAnnouncement");
  form.querySelector('input[name="title"]').value = "כותרת";
  form.querySelector('textarea[name="body"]').value = "תוכן";
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

  await waitFor(() => /לא ניתן היה לשמור את ההודעה\. נסו שוב\./.test(window.document.body.textContent), 3000);
  assert.equal(mock.db.announcements.length, 0);
});

test("urgent renders visually stronger than important, both with an icon and a text label; normal carries no badge", async () => {
  const mock = staffMock({
    announcements: [
      { id: "a-normal", author_id: "staff-1", title: "הודעה רגילה", body: "תוכן", priority: "normal", expires_at: null, created_at: VERIFIED, pinned_date: null, profiles: { handle: "coach", display_name: "מאמן" } },
      { id: "a-important", author_id: "staff-1", title: "הודעה חשובה", body: "תוכן", priority: "important", expires_at: null, created_at: VERIFIED, pinned_date: null, profiles: { handle: "coach", display_name: "מאמן" } },
      { id: "a-urgent", author_id: "staff-1", title: "הודעה דחופה", body: "תוכן", priority: "urgent", expires_at: null, created_at: VERIFIED, pinned_date: null, profiles: { handle: "coach", display_name: "מאמן" } },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await waitFor(() => /הודעה דחופה/.test(window.document.body.textContent), 3000);

  const rowText = (title) => {
    const el = Array.from(window.document.querySelectorAll(".log-row")).find((r) => r.textContent.includes(title));
    assert.ok(el, `row for ${title} renders`);
    return el;
  };
  const normalRow = rowText("הודעה רגילה");
  const importantRow = rowText("הודעה חשובה");
  const urgentRow = rowText("הודעה דחופה");

  // Never colour alone: both elevated tiers carry an icon AND a text label.
  assert.match(importantRow.innerHTML, /❗/);
  assert.match(importantRow.textContent, /חשוב/);
  assert.match(urgentRow.innerHTML, /🚨/);
  assert.match(urgentRow.textContent, /דחוף/);
  // normal gets no badge at all.
  assert.doesNotMatch(normalRow.innerHTML, /❗|🚨/);
  // urgent is visually distinct from important, not just the badge colour:
  // it also carries the stronger banner-style accent on the row itself.
  assert.match(urgentRow.getAttribute("style") || "", /var\(--red\)/);
  assert.match(importantRow.getAttribute("style") || "", /var\(--brass\)/);
  assert.doesNotMatch(importantRow.getAttribute("style") || "", /var\(--red\)/);
});

test("an expired announcement drops out of the feed top area defensively, but a pin on it stays in the pinned strip until explicit unpin (COMM-155 unaffected)", async () => {
  const mock = staffMock({
    announcements: [
      { id: "a-live", author_id: "staff-1", title: "הודעה פעילה", body: "תוכן", priority: "normal", expires_at: null, created_at: VERIFIED, pinned_date: null, profiles: { handle: "coach", display_name: "מאמן" } },
      { id: "a-expired", author_id: "staff-1", title: "הודעה שפגה", body: "תוכן ישן", priority: "important", expires_at: PAST, created_at: VERIFIED, pinned_date: null, profiles: { handle: "coach", display_name: "מאמן" } },
    ],
    pins: [
      { id: "p1", target_type: "announcement", target_id: "a-expired", slot: 0, note: "הודעה שפגה - עדיין מוצמדת", pinned_by: "staff-1", created_at: VERIFIED },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openFeed(window);
  await waitFor(() => !!window.document.getElementById("communityPinnedStrip"), 3000);

  // The pinned strip (COMM-155, the pins table) is unaffected by expiry:
  // pin_set/pin_clear only ever fire on deleted_at, never on expires_at, and
  // the strip renders off the pin's own stored note rather than a live
  // announcements re-read, so it keeps showing until an explicit unpin.
  const strip = window.document.getElementById("communityPinnedStrip");
  assert.match(strip.textContent, /הודעה שפגה - עדיין מוצמדת/);
  assert.equal(mock.db.pins.length, 1, "the pin row itself was never auto-removed by expiry");

  // The regular announcements list (the feed top area itself), however,
  // defensively drops the expired row - the live one still shows.
  assert.match(window.document.body.textContent, /הודעה פעילה/);
  const announcementSection = Array.from(window.document.querySelectorAll(".ach-section")).find((s) => s.textContent.includes("הודעות מהמועדון"));
  assert.ok(announcementSection);
  assert.doesNotMatch(announcementSection.textContent, /תוכן ישן/, "the expired announcement's own body is not rendered in the feed top area");
});
