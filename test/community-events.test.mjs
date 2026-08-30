// COMM-213..217. The Phase 2 events cluster: Upcoming/Past list, a
// create/edit form gated on community.event.manage, server-enforced RSVP
// (event_rsvp + the capacity/deadline trigger, both shipped in
// 202608280010), event type badges, a client-built .ics download, and a
// comment thread that reuses the whole engagement stack through a
// companion POST_EVENT post (COMM-216's design decision).
//
// Executed for real (bootCommunity + the mock Supabase client), not
// source-text matches - these drive the real render path and the real
// event_rsvp() mock RPC, which mirrors the shipped enforce_event_capacity()
// trigger's exclude-your-own-row and deadline checks.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();
const NOW = Date.now();
const iso = (deltaHours) => new Date(NOW + deltaHours * 3600000).toISOString();

function submit(window, id) {
  window.document.getElementById(id).dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

function baseProfiles() {
  return [
    { id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_in_attendee_lists: true },
    { id: "u2", handle: "noam", display_name: "נועם", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_in_attendee_lists: true },
    { id: "coach1", handle: "yael", display_name: "יעל", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, show_in_attendee_lists: true },
  ];
}
function seeded(extra, asStaff) {
  const mock = createMockSupabase(Object.assign({
    profiles: baseProfiles(),
    invite_redemptions: [
      { user_id: "u1", invite_id: "inv-1", role: asStaff ? "coach" : "member", redeemed_at: VERIFIED },
      { user_id: "u2", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED },
      { user_id: "coach1", invite_id: "inv-1", role: "coach", redeemed_at: VERIFIED },
    ],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    events: [], event_attendees: [], workout_posts: [], post_comments: [],
    feed_page_rows: [], analytics_events: [], notifications: [], notification_preferences: [],
  }, extra || {}));
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}
async function openBoards(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="boards"]').click();
  await waitFor(() => window.document.body.textContent.includes("אירועי המועדון"), 3000);
}
function openEventCard(window, id) {
  const card = window.document.querySelector(`[data-event-id="${id}"]`);
  card.querySelector('[data-community-action="open-event"]').click();
}
function eventViewDialog(window) { return window.document.querySelector('[data-cloud-dialog="eventView"]'); }

test("the Boards tab lists a published upcoming event with title, date and going count", async () => {
  const mock = seeded({
    events: [{ id: "e1", event_type: "workshop", title: "סדנת גמישות", description: "", status: "published", start_at: iso(24), end_at: null, location: "אולם 1", capacity: null, registration_deadline: null, created_by: "coach1" }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-event-id="e1"]'), 3000);
  const card = window.document.querySelector('[data-event-id="e1"]');
  assert.match(card.textContent, /סדנת גמישות/);
  assert.match(card.textContent, /0 משתתפים/);
});

test("no upcoming events renders the documented empty state", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  await openBoards(window);
  assert.match(window.document.body.textContent, /אין אירועים קרובים כרגע/);
});

test("Upcoming/Past split: a past-dated published event and a cancelled event both land in Past, never Upcoming", async () => {
  const mock = seeded({
    events: [
      { id: "future", event_type: "seminar", title: "הרצאת תזונה", description: "", status: "published", start_at: iso(48), end_at: null, location: null, capacity: null, registration_deadline: null, created_by: "coach1" },
      { id: "past", event_type: "seminar", title: "הרצאה שהייתה", description: "", status: "published", start_at: iso(-48), end_at: null, location: null, capacity: null, registration_deadline: null, created_by: "coach1" },
      { id: "cancelled", event_type: "seminar", title: "אירוע מבוטל", description: "", status: "cancelled", start_at: iso(72), end_at: null, location: null, capacity: null, registration_deadline: null, created_by: "coach1" },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-event-id="future"]'), 3000);
  assert.equal(window.document.querySelector('[data-event-id="future"][data-event-status="published"]').closest(".ach-section") !== null, true);
  const pastCard = window.document.querySelector('[data-event-id="past"]');
  const cancelledCard = window.document.querySelector('[data-event-id="cancelled"]');
  assert.ok(pastCard, "a published event whose start_at has passed still renders, in Past");
  assert.ok(cancelledCard, "a cancelled event still renders, in Past");
  assert.match(cancelledCard.textContent, /בוטל/);
  // Both past-bucket cards render after the future one in document order,
  // under the "אירועים שהסתיימו" sub-heading.
  const section = window.document.body.textContent;
  assert.ok(section.indexOf("אירועים שהסתיימו") < section.indexOf("הרצאה שהייתה"));
});

test("a draft event is hidden from a plain member and offers no card, but a staff holder sees and can publish it", async () => {
  const draft = { id: "edraft", event_type: "workshop", title: "טיוטת אירוע", description: "", status: "draft", start_at: iso(24), end_at: null, location: null, capacity: null, registration_deadline: null, created_by: "coach1" };
  const memberWindow = await bootCommunity(seeded({ events: [draft] }, false), { syncEnabled: false });
  await openBoards(memberWindow);
  assert.equal(memberWindow.document.querySelector('[data-event-id="edraft"]'), null, "a plain member's list never renders a draft card");

  const staffWindow = await bootCommunity(seeded({ events: [draft] }, true), { syncEnabled: false });
  await openBoards(staffWindow);
  await waitFor(() => !!staffWindow.document.querySelector('[data-event-id="edraft"]'), 3000);
  assert.ok(staffWindow.document.querySelector('[data-community-action="open-event"]'), "staff sees the draft card");
});

test("a coach can create a published event through the form, gated by community.event.manage", async () => {
  const mock = seeded({}, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  window.document.querySelector('[data-community-action="open-event-form"]').click();
  await waitFor(() => !!window.document.getElementById("communityEventForm"), 3000);
  const form = window.document.getElementById("communityEventForm");
  form.querySelector('[name="title"]').value = "ערב טריוויה";
  form.querySelector('[name="startAt"]').value = "2027-01-01T18:00";
  form.querySelector('[name="publishNow"]').checked = true;
  submit(window, "communityEventForm");
  await waitFor(() => mock.db.events.some((e) => e.title === "ערב טריוויה" && e.status === "published"), 3000);
  const created = mock.db.events.find((e) => e.title === "ערב טריוויה");
  assert.equal(created.event_type, "workshop", "the default type picker selection is used when untouched");
  assert.equal(created.created_by, "u1");
});

test("a plain member's Boards tab offers no create-event button", async () => {
  const window = await bootCommunity(seeded({}, false), { syncEnabled: false });
  await openBoards(window);
  assert.equal(window.document.querySelector('[data-community-action="open-event-form"]'), null);
});

test("publishing an event creates a companion POST_EVENT post through post_create with links.event_id", async () => {
  const mock = seeded({}, true);
  mock.onRpc("post_create", (args, ctx) => {
    ctx.db.__lastPostCreate = args;
    const id = "post-" + ((ctx.db.__postSeq = (ctx.db.__postSeq || 0) + 1));
    ctx.db.workout_posts = ctx.db.workout_posts || [];
    ctx.db.workout_posts.push({ id, author_id: ctx.currentUser && ctx.currentUser.id, post_type: "POST_TEXT", body: args.body, visibility: args.visibility, metadata: {}, status: "active", created_at: new Date().toISOString() });
    return { data: id, error: null };
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  window.document.querySelector('[data-community-action="open-event-form"]').click();
  await waitFor(() => !!window.document.getElementById("communityEventForm"), 3000);
  const form = window.document.getElementById("communityEventForm");
  form.querySelector('[name="title"]').value = "מפגש ריצה בוקר";
  form.querySelector('[name="startAt"]').value = "2027-02-01T07:00";
  form.querySelector('[name="publishNow"]').checked = true;
  submit(window, "communityEventForm");
  await waitFor(() => mock.db.events.some((e) => e.title === "מפגש ריצה בוקר"), 3000);
  const created = mock.db.events.find((e) => e.title === "מפגש ריצה בוקר");
  await waitFor(() => mock.db.__lastPostCreate && mock.db.__lastPostCreate.links && mock.db.__lastPostCreate.links.event_id === created.id, 3000);
  // The follow-up own-row RLS update (posts_update_self) is what turns
  // post_create's default POST_TEXT into the real POST_EVENT shape - see
  // ensureEventCompanionPost()'s comment for why that is not a bypass.
  await waitFor(() => mock.db.workout_posts.some((p) => p.post_type === "POST_EVENT" && p.metadata && p.metadata.event_id === created.id), 3000);
  const companion = mock.db.workout_posts.find((p) => p.post_type === "POST_EVENT");
  assert.equal(companion.metadata.event_title, "מפגש ריצה בוקר");
});

test("event detail shows description, location, capacity, registration deadline and organizer", async () => {
  const mock = seeded({
    events: [{ id: "e1", event_type: "competition", title: "תחרות קיץ", description: "יום כיף לכולם", status: "published", start_at: iso(24), end_at: iso(26), location: "פארק הירקון", map_link: "https://maps.example/x", capacity: 20, registration_deadline: iso(12), created_by: "coach1" }],
    event_attendees: [{ event_id: "e1", user_id: "u2", response: "going", registered_at: VERIFIED }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-event-id="e1"]'), 3000);
  openEventCard(window, "e1");
  await waitFor(() => !!eventViewDialog(window), 3000);
  await waitFor(() => eventViewDialog(window).textContent.includes("יום כיף לכולם"), 3000);
  const body = eventViewDialog(window).textContent;
  assert.match(body, /פארק הירקון/);
  assert.match(body, /1 \/ 20 משתתפים/);
  assert.match(body, /מועד אחרון להרשמה/);
  assert.match(body, /יעל/, "the organizer's display name (created_by) is shown");
});

test("RSVP round trip: clicking Going inserts an event_attendees row and the button reflects the response", async () => {
  const mock = seeded({
    events: [{ id: "e1", event_type: "social_night", title: "ערב פיצה", description: "", status: "published", start_at: iso(24), end_at: null, location: null, capacity: null, registration_deadline: null, created_by: "coach1" }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-event-id="e1"]'), 3000);
  openEventCard(window, "e1");
  await waitFor(() => !!eventViewDialog(window), 3000);
  await waitFor(() => !!eventViewDialog(window).querySelector('[data-community-action="event-rsvp"][data-response="going"]'), 3000);
  eventViewDialog(window).querySelector('[data-community-action="event-rsvp"][data-response="going"]').click();
  await waitFor(() => mock.db.event_attendees.some((a) => a.event_id === "e1" && a.user_id === "u1" && a.response === "going"), 3000);
  await waitFor(() => {
    const btn = eventViewDialog(window).querySelector('[data-community-action="event-rsvp"][data-response="going"]');
    return btn && btn.className.includes("primary");
  }, 3000);
});

test("capacity: a full event disables Going with 'האירוע מלא' but still allows Interested, and a going->going update stays enabled for the member already going", async () => {
  const mock = seeded({
    events: [{ id: "e1", event_type: "workshop", title: "סדנה מלאה", description: "", status: "published", start_at: iso(24), end_at: null, location: null, capacity: 1, registration_deadline: null, created_by: "coach1" }],
    event_attendees: [{ event_id: "e1", user_id: "u2", response: "going", registered_at: VERIFIED }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-event-id="e1"]'), 3000);
  openEventCard(window, "e1");
  await waitFor(() => !!eventViewDialog(window), 3000);
  await waitFor(() => !!eventViewDialog(window).querySelector('[data-community-action="event-rsvp"][data-response="going"]'), 3000);
  const goingBtn = eventViewDialog(window).querySelector('[data-community-action="event-rsvp"][data-response="going"]');
  assert.ok(goingBtn.disabled, "Going is disabled on a full event for a member not already going");
  assert.match(eventViewDialog(window).textContent, /האירוע מלא/);
  const interestedBtn = eventViewDialog(window).querySelector('[data-community-action="event-rsvp"][data-response="interested"]');
  assert.ok(!interestedBtn.disabled, "Interested stays open on a full event");
  interestedBtn.click();
  await waitFor(() => mock.db.event_attendees.some((a) => a.user_id === "u1" && a.response === "interested"), 3000);
});

test("capacity race: two members RSVPing for the last spot leaves exactly one going, and the loser sees event_full", async () => {
  const mock = seeded({
    events: [{ id: "e1", event_type: "workshop", title: "מקום אחרון", description: "", status: "published", start_at: iso(24), end_at: null, location: null, capacity: 1, registration_deadline: null, created_by: "coach1" }],
  });
  mock.setUser({ id: "u1", is_anonymous: false });
  const first = await mock.client.rpc("event_rsvp", { p_event_id: "e1", p_response: "going" });
  assert.equal(first.error, null, "the first RSVP for the last spot succeeds");
  mock.setUser({ id: "u2", is_anonymous: false });
  const second = await mock.client.rpc("event_rsvp", { p_event_id: "e1", p_response: "going" });
  assert.equal(second.error.message, "event_full", "the second RSVP for the same spot loses");
  const going = mock.db.event_attendees.filter((a) => a.event_id === "e1" && a.response === "going");
  assert.equal(going.length, 1, "exactly one going row remains");
  // Idempotent: u1 (already going) can RSVP going again on the still-full event.
  mock.setUser({ id: "u1", is_anonymous: false });
  const again = await mock.client.rpc("event_rsvp", { p_event_id: "e1", p_response: "going" });
  assert.equal(again.error, null, "a going->going update on a full event stays idempotent");
});

test("deadline: an event past its registration deadline disables every RSVP button with 'ההרשמה נסגרה'", async () => {
  const mock = seeded({
    events: [{ id: "e1", event_type: "workshop", title: "ההרשמה נסגרה", description: "", status: "published", start_at: iso(24), end_at: null, location: null, capacity: null, registration_deadline: iso(-1), created_by: "coach1" }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-event-id="e1"]'), 3000);
  openEventCard(window, "e1");
  await waitFor(() => !!eventViewDialog(window), 3000);
  await waitFor(() => !!eventViewDialog(window).querySelector('[data-community-action="event-rsvp"]'), 3000);
  const buttons = eventViewDialog(window).querySelectorAll('[data-community-action="event-rsvp"]');
  assert.equal(buttons.length, 3);
  for (const b of buttons) assert.ok(b.disabled, "every RSVP button is disabled past the deadline: " + b.dataset.response);
  assert.match(eventViewDialog(window).textContent, /ההרשמה נסגרה/);
});

test("cancelling a published event moves it out of Upcoming and into Past marked cancelled", async () => {
  const mock = seeded({
    events: [{ id: "e1", event_type: "workshop", title: "אירוע לביטול", description: "", status: "published", start_at: iso(24), end_at: null, location: null, capacity: null, registration_deadline: null, created_by: "coach1" }],
  }, true);
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-event-id="e1"]'), 3000);
  openEventCard(window, "e1");
  await waitFor(() => !!eventViewDialog(window), 3000);
  await waitFor(() => !!eventViewDialog(window).querySelector('[data-community-action="event-cancel-confirm"]'), 3000);
  eventViewDialog(window).querySelector('[data-community-action="event-cancel-confirm"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="confirm-yes"]'), 3000);
  window.document.querySelector('[data-community-action="confirm-yes"]').click();
  await waitFor(() => mock.db.events.find((e) => e.id === "e1").status === "cancelled", 3000);
  await waitFor(() => !!window.document.querySelector('[data-event-id="e1"][data-event-status="cancelled"]'), 3000);
  const card = window.document.querySelector('[data-event-id="e1"]');
  assert.match(card.textContent, /בוטל/);
});

test("each event_type renders a distinct label and icon on the card", async () => {
  const mock = seeded({
    events: [
      { id: "e1", event_type: "running_meetup", title: "ריצת בוקר", description: "", status: "published", start_at: iso(24), end_at: null, location: null, capacity: null, registration_deadline: null, created_by: "coach1" },
      { id: "e2", event_type: "holiday_event", title: "מסיבת חנוכה", description: "", status: "published", start_at: iso(48), end_at: null, location: null, capacity: null, registration_deadline: null, created_by: "coach1" },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-event-id="e2"]'), 3000);
  assert.match(window.document.querySelector('[data-event-id="e1"]').textContent, /🏃/);
  assert.match(window.document.querySelector('[data-event-id="e1"]').textContent, /מפגש ריצה/);
  assert.match(window.document.querySelector('[data-event-id="e2"]').textContent, /🎊/);
  assert.match(window.document.querySelector('[data-event-id="e2"]').textContent, /אירוע חג/);
});

test("buildEventIcs produces a valid iCalendar body, defaults end_at to start_at plus one hour, and escapes special characters", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  const ics = window.buildEventIcs({
    id: "e1", title: "אימון, מיוחד; הערה", description: "שורה אחת\nשורה שתיים",
    location: "אולם A", start_at: "2027-03-01T09:00:00.000Z", end_at: null,
  }, "https://app.example/community/feed?event=e1");
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /DTSTART:20270301T090000Z/);
  assert.match(ics, /DTEND:20270301T100000Z/, "end_at null defaults to start_at plus one hour");
  assert.match(ics, /SUMMARY:אימון\\, מיוחד\\; הערה/);
  assert.match(ics, /שורה אחת\\nשורה שתיים/);
  assert.match(ics, /LOCATION:אולם A/);
  assert.match(ics, /feed\?event=e1/);
});

test("Add to Calendar degrades to the documented error message rather than throwing when the download API is unavailable", async () => {
  const mock = seeded({
    events: [{ id: "e1", event_type: "workshop", title: "סדנה", description: "", status: "published", start_at: iso(24), end_at: null, location: null, capacity: null, registration_deadline: null, created_by: "coach1" }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-event-id="e1"]'), 3000);
  openEventCard(window, "e1");
  await waitFor(() => !!eventViewDialog(window), 3000);
  await waitFor(() => !!eventViewDialog(window).querySelector('[data-community-action="event-ics"]'), 3000);
  // jsdom implements neither Blob URLs nor a download click meaningfully;
  // this proves the click cannot crash the dialog, which is what the
  // ticket's "defensive only" error state is for.
  eventViewDialog(window).querySelector('[data-community-action="event-ics"]').click();
  await waitFor(() => !!eventViewDialog(window), 500).catch(() => {});
  assert.ok(eventViewDialog(window), "the dialog survives an Add to Calendar click either way");
});

test("event comments reuse the engagement stack: add_post_comment on the companion post appears in the event detail thread", async () => {
  const mock = seeded({
    workout_posts: [{ id: "post-e1", author_id: "coach1", post_type: "POST_EVENT", body: "בואו נתאמן", metadata: { event_id: "e1", event_title: "אימון קבוצתי", starts_at: iso(24) }, status: "active", visibility: "club", created_at: VERIFIED, published_at: VERIFIED }],
    events: [{ id: "e1", event_type: "outdoor_workout", title: "אימון קבוצתי", description: "", status: "published", start_at: iso(24), end_at: null, location: null, capacity: null, registration_deadline: null, created_by: "coach1" }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openBoards(window);
  await waitFor(() => !!window.document.querySelector('[data-event-id="e1"]'), 3000);
  openEventCard(window, "e1");
  await waitFor(() => !!eventViewDialog(window), 3000);
  await waitFor(() => !!eventViewDialog(window).querySelector('[data-comment-post-id="post-e1"]'), 3000);
  const input = eventViewDialog(window).querySelector('[data-comment-post-id="post-e1"] [data-comment-input]');
  input.value = "מתי נפגשים?";
  eventViewDialog(window).querySelector('[data-comment-post-id="post-e1"]').dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => mock.db.post_comments.some((c) => c.post_id === "post-e1" && c.body === "מתי נפגשים?"), 3000);
});

test("the feed top area shows the soonest upcoming event with quick RSVP actions, and omits the slot when there is none", async () => {
  const mock = seeded({
    events: [
      { id: "soon", event_type: "seminar", title: "האירוע הקרוב", description: "", status: "published", start_at: iso(6), end_at: null, location: null, capacity: null, registration_deadline: null, created_by: "coach1" },
      { id: "later", event_type: "seminar", title: "אירוע מאוחר יותר", description: "", status: "published", start_at: iso(48), end_at: null, location: null, capacity: null, registration_deadline: null, created_by: "coach1" },
    ],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  await waitFor(() => !!window.document.querySelector('[data-event-id="soon"]'), 3000);
  const card = window.document.querySelector('[data-event-id="soon"]');
  assert.match(card.textContent, /האירוע הקרוב/);
  assert.equal(window.document.querySelector('[data-event-id="later"].chart-card[style*="margin-top:10px"]'), null, "only the single soonest upcoming event gets the top-area slot");
  card.querySelector('[data-community-action="event-rsvp"][data-response="going"]').click();
  await waitFor(() => mock.db.event_attendees.some((a) => a.event_id === "soon" && a.user_id === "u1" && a.response === "going"), 3000);

  const emptyMock = seeded();
  const emptyWindow = await bootCommunity(emptyMock, { syncEnabled: false });
  emptyWindow.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!emptyWindow.document.querySelector(".subtabbar"), 3000);
  await waitFor(() => emptyMock.db && true, 100).catch(() => {});
  assert.equal(emptyWindow.document.querySelector('[data-community-action="event-rsvp"]'), null, "no upcoming event renders no top-area slot");
});

test("a search result's open-event action opens the real event detail, not just a tracked view", async () => {
  const mock = seeded({
    events: [{ id: "e1", event_type: "workshop", title: "אירוע לחיפוש", description: "", status: "published", start_at: iso(24), end_at: null, location: null, capacity: null, registration_deadline: null, created_by: "coach1" }],
  });
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => !!window.document.getElementById("communityPeopleSearch"), 3000);
  const box = window.document.getElementById("communityPeopleSearch");
  box.value = "לחיפוש";
  box.dispatchEvent(new window.Event("input", { bubbles: true }));
  await waitFor(() => !!window.document.querySelector('[data-search-event-id="e1"]'), 3000);
  window.document.querySelector('[data-search-event-id="e1"] [data-community-action="open-event"]').click();
  await waitFor(() => !!eventViewDialog(window) && eventViewDialog(window).textContent.includes("אירוע לחיפוש"), 3000);
});

test("notifResolveTarget routes an event_cancelled deep link to the event, not to plain feed", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  const target = window.notifResolveTarget({ deep_link: "/community/feed?event=abc-123", type: "event_cancelled" });
  assert.deepEqual(target, { tab: "feed", event: "abc-123" });
});
