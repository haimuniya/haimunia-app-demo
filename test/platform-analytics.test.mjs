// COMM-013. The analytics helper.
//
// The contract that matters is negative: analyticsTrack() must never
// throw, never reject, and never make the caller wait on a network
// round trip, because every call site is a UI action that has already
// happened. Most of this file is proving the failure paths stay silent.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootApp } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const SPEC_77_EVENTS = [
  "club_tab_viewed", "feed_viewed", "post_impression", "post_opened", "post_created",
  "workout_shared", "achievement_shared", "reaction_added", "comment_created",
  "profile_opened", "member_followed", "challenge_viewed", "challenge_joined",
  "challenge_completed", "leaderboard_viewed", "event_viewed", "event_rsvp",
  "notification_opened", "weekly_recap_opened", "weekly_recap_shared", "report_submitted",
];

// An object built inside the jsdom window carries that realm's
// Object.prototype, which deepStrictEqual reads as a mismatch even when
// the data agrees. JSON re-homes it in this realm.
const plain = (v) => JSON.parse(JSON.stringify(v));

function silence(window) {
  const warns = [];
  window.console.warn = (...args) => warns.push(args.join(" "));
  return warns;
}

test("every tracked event name from spec section 77 is defined as a constant", async () => {
  const window = await bootApp();
  const analytics = window.HaimuniaAnalytics;
  assert.ok(analytics, "window.HaimuniaAnalytics must exist after the shell loads");
  assert.deepStrictEqual(Object.values(analytics.EVENTS).sort(), SPEC_77_EVENTS.slice().sort());
  // The migration's CHECK is `^[a-z][a-z0-9_.]{2,63}$`. A constant that
  // fails it would be rejected by Postgres at insert time, not here.
  for (const name of Object.values(analytics.EVENTS)) {
    assert.match(name, /^[a-z][a-z0-9_.]{2,63}$/, `${name} does not match the analytics_events name CHECK`);
  }
  assert.strictEqual(typeof window.analyticsTrack, "function", "the flat helper alias must exist");
});

// COMM-170 moved the definition out of the module comment and into the
// doc. The module keeps a one-line pointer, so the two cannot both exist
// and disagree - which is the failure this test now guards.
test("the Weekly Community Active Members definition is documented in docs/community/metrics.md", () => {
  const doc = fs.readFileSync(new URL("../docs/community/metrics.md", import.meta.url), "utf8");
  assert.match(doc, /Weekly Community Active Members/);
  assert.match(doc, /section 78/);
  // The seven qualifying actions from the definition.
  for (const action of ["created a post", "created a comment", "added a reaction", "joined a challenge", "participated in an event", "shared an achievement", "interacted with a coach"]) {
    assert.ok(doc.includes(action), `the WCAM definition must name "${action}"`);
  }
  assert.ok(doc.includes("Passive views alone do not count"), "the definition must say what does NOT count");

  const src = fs.readFileSync(new URL("../src/analytics.js", import.meta.url), "utf8");
  assert.ok(src.includes("docs/community/metrics.md"), "the module must point at the doc");
  assert.ok(!src.includes("Passive views alone do not count"), "the definition must live in exactly one place, not two that can drift");
});

test("the active-member event set matches the WCAM definition and excludes passive views", async () => {
  const window = await bootApp();
  const a = window.HaimuniaAnalytics;
  for (const name of [a.EVENTS.POST_CREATED, a.EVENTS.COMMENT_CREATED, a.EVENTS.REACTION_ADDED, a.EVENTS.CHALLENGE_JOINED, a.EVENTS.EVENT_RSVP, a.EVENTS.ACHIEVEMENT_SHARED]) {
    assert.ok(a.isActiveMemberEvent(name), `${name} must count toward WCAM`);
  }
  for (const name of [a.EVENTS.CLUB_TAB_VIEWED, a.EVENTS.FEED_VIEWED, a.EVENTS.POST_IMPRESSION, a.EVENTS.LEADERBOARD_VIEWED, a.EVENTS.CHALLENGE_VIEWED, a.EVENTS.EVENT_VIEWED]) {
    assert.ok(!a.isActiveMemberEvent(name), `${name} is a passive view and must not count toward WCAM`);
  }
});

test("a tracked event writes one analytics_events row with the schema version and the caller's own user id", async () => {
  const window = await bootApp();
  const mock = createMockSupabase();
  window.HaimuniaAnalytics.configure({ client: mock.client, userId: "user-1" });

  assert.strictEqual(await window.analyticsTrack("post_opened", { post_id: "p1", position: 3 }), true);
  assert.strictEqual(mock.db.analytics_events.length, 1);
  const row = mock.db.analytics_events[0];
  assert.strictEqual(row.event_name, "post_opened");
  assert.strictEqual(row.user_id, "user-1");
  assert.strictEqual(row.schema_version, window.HaimuniaAnalytics.SCHEMA_VERSION);
  assert.deepStrictEqual(plain(row.props), { post_id: "p1", position: 3 });
});

test("a pre-profile event is recorded with a null user_id, which the insert policy allows", async () => {
  const window = await bootApp();
  const mock = createMockSupabase();
  window.HaimuniaAnalytics.configure({ client: mock.client });
  await window.analyticsTrack("club_tab_viewed", {});
  assert.strictEqual(mock.db.analytics_events[0].user_id, null);
});

test("an unknown event name is dropped with a warning and never reaches the table", async () => {
  const window = await bootApp();
  const warns = silence(window);
  const mock = createMockSupabase();
  window.HaimuniaAnalytics.configure({ client: mock.client, userId: "user-1" });

  assert.strictEqual(await window.analyticsTrack("post_viewed_maybe", {}), false);
  assert.strictEqual(mock.db.analytics_events, undefined, "nothing may be written for an undefined event name");
  assert.ok(warns.some((l) => l.includes("unknown event name")));
});

test("props over the client budget are trimmed largest-value-first and marked, not rejected", async () => {
  const window = await bootApp();
  const mock = createMockSupabase();
  const a = window.HaimuniaAnalytics;
  a.configure({ client: mock.client, userId: "user-1" });

  assert.ok(a.PROPS_BUDGET_BYTES < a.MAX_PROPS_BYTES, "the client budget must leave headroom under the 4 KB server trigger");
  assert.strictEqual(a.MAX_PROPS_BYTES, 4096, "the cap must match the analytics_events_props_size trigger");

  await window.analyticsTrack("post_created", { post_id: "p1", kind: "photo", blob: "x".repeat(5000) });
  const row = mock.db.analytics_events[0];
  assert.strictEqual(row.props._truncated, true, "a trimmed payload must be marked so a query can tell");
  assert.strictEqual(row.props.blob, undefined, "the oversized prop is the one that goes");
  assert.strictEqual(row.props.post_id, "p1", "the small props survive the trim");
  assert.strictEqual(row.props.kind, "photo");
  assert.ok(JSON.stringify(row.props).length <= a.PROPS_BUDGET_BYTES);
});

test("props that fit are left untouched, and undefined values are dropped rather than serialized to null", async () => {
  const window = await bootApp();
  const a = window.HaimuniaAnalytics;
  const fitted = a.fitProps({ a: 1, b: undefined, c: "two" });
  assert.deepStrictEqual(plain(fitted.props), { a: 1, c: "two" });
  assert.strictEqual(fitted.truncated, false);
  assert.deepStrictEqual(plain(a.fitProps(undefined).props), {});
  assert.deepStrictEqual(plain(a.fitProps("not an object").props), {});
});

test("a rejected insert is silent - track resolves false and never throws", async () => {
  const window = await bootApp();
  const a = window.HaimuniaAnalytics;
  a.configure({ client: { from: () => ({ insert: () => Promise.resolve({ error: { message: "new row violates row-level security policy" } }) }) } });
  assert.strictEqual(await window.analyticsTrack("feed_viewed", {}), false);
});

test("a client that throws on the way to the network is swallowed, not surfaced to the caller", async () => {
  const window = await bootApp();
  const a = window.HaimuniaAnalytics;
  a.configure({ client: { from: () => { throw new Error("socket closed"); } } });
  assert.strictEqual(await window.analyticsTrack("feed_viewed", {}), false);
  a.configure({ client: { from: () => ({ insert: () => Promise.reject(new Error("network down")) }) } });
  assert.strictEqual(await window.analyticsTrack("feed_viewed", {}), false);
});

test("an unconfigured helper is an inert no-op, which is what Phase 0 ships", async () => {
  const window = await bootApp();
  assert.strictEqual(await window.analyticsTrack("feed_viewed", {}), false);
});

test("configure attaches the bus bridge, and only the one-to-one product events map through", async () => {
  const window = await bootApp();
  const mock = createMockSupabase();
  const bus = window.HaimuniaEvents;
  const a = window.HaimuniaAnalytics;
  a.configure({ client: mock.client, userId: "user-1" });

  bus.emit(bus.EVENTS.POST_CREATED, { post_id: "p1" });
  bus.emit(bus.EVENTS.COMMENT_CREATED, { comment_id: "c1" });
  bus.emit(bus.EVENTS.REACTION_CREATED, { post_id: "p1" });
  bus.emit(bus.EVENTS.EVENT_REGISTERED, { event_id: "e1" });
  // Deliberately unmapped: completing a workout is not sharing one, and
  // unlocking an achievement is not sharing it. Mapping either would
  // inflate WCAM with actions that are not community participation.
  bus.emit(bus.EVENTS.WORKOUT_COMPLETED, {});
  bus.emit(bus.EVENTS.ACHIEVEMENT_UNLOCKED, {});
  bus.emit(bus.EVENTS.PR_CREATED, {});
  bus.emit(bus.EVENTS.MEMBER_JOINED, {});
  bus.emit(bus.EVENTS.ATTENDANCE_RECORDED, {});
  await new Promise((r) => setTimeout(r, 10));

  assert.deepStrictEqual(mock.db.analytics_events.map((r) => r.event_name), ["post_created", "comment_created", "reaction_added", "event_rsvp"]);
});

test("configuring twice does not double-track, and detach stops the bridge", async () => {
  const window = await bootApp();
  const mock = createMockSupabase();
  const bus = window.HaimuniaEvents;
  const a = window.HaimuniaAnalytics;

  a.configure({ client: mock.client, userId: "user-1" });
  a.configure({ client: mock.client, userId: "user-1" });
  bus.emit(bus.EVENTS.POST_CREATED, { post_id: "p1" });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(mock.db.analytics_events.length, 1, "a second configure must replace the bridge, not stack a second one");

  a.detachFromBus();
  bus.emit(bus.EVENTS.POST_CREATED, { post_id: "p2" });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(mock.db.analytics_events.length, 1);
});

// COMM-170. The dev switch and the bus prop projection.

test("the dev switch logs the event to the console and writes nothing", async () => {
  const window = await bootApp();
  const mock = createMockSupabase();
  const logged = [];
  window.console.log = (...args) => logged.push(args);
  window.HaimuniaAnalytics.configure({ client: mock.client, userId: "user-1", debug: true });

  assert.strictEqual(await window.analyticsTrack("feed_viewed", { scope: "for_you" }), true);
  assert.strictEqual(mock.db.analytics_events, undefined, "debug mode must not write");
  assert.strictEqual(logged.length, 1);
  assert.match(logged[0][0], /feed_viewed/);
  assert.deepStrictEqual(plain(logged[0][1].props), { scope: "for_you" });
  assert.strictEqual(logged[0][1].user_id, "user-1");

  // Flipping the global at runtime wins over what configure was given,
  // which is what makes it usable from a console on a live device.
  window.HAIMUNIA_ANALYTICS_DEBUG = false;
  await window.analyticsTrack("feed_viewed", {});
  assert.strictEqual(mock.db.analytics_events.length, 1, "turning it off resumes writing");
  window.HAIMUNIA_ANALYTICS_DEBUG = true;
  await window.analyticsTrack("feed_viewed", {});
  assert.strictEqual(mock.db.analytics_events.length, 1, "turning it on stops writing again");
});

test("a bridged bus payload is projected onto the documented props, so a producer cannot widen the row", async () => {
  const window = await bootApp();
  const mock = createMockSupabase();
  const bus = window.HaimuniaEvents;
  window.HaimuniaAnalytics.configure({ client: mock.client, userId: "user-1" });

  // A payload built for the notification consumer: it carries the author
  // and the resolved mention objects, neither of which belongs in
  // analytics.
  bus.emit(bus.EVENTS.COMMENT_CREATED, {
    post_id: "p1", comment_id: "c1", parent_comment_id: null,
    author_id: "user-1",
    mentions: [{ user_id: "user-2", name: "נועם" }, { user_id: "user-3", name: "דנה" }],
  });
  await new Promise((r) => setTimeout(r, 10));

  const props = plain(mock.db.analytics_events[0].props);
  assert.deepStrictEqual(props, { post_id: "p1", comment_id: "c1", mention_count: 2 });
  assert.ok(!JSON.stringify(props).includes("נועם"), "member-authored text must never reach the table");

  // A key no allow-list mentions is dropped, not stored.
  bus.emit(bus.EVENTS.POST_CREATED, { post_id: "p2", post_type: "POST_TEXT", body: "the whole caption" });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(plain(mock.db.analytics_events[1].props), { post_id: "p2", post_type: "POST_TEXT" });
});

test("every bridged event has a declared prop allow-list, so a new mapping cannot ship unprojected", async () => {
  const window = await bootApp();
  const a = window.HaimuniaAnalytics;
  for (const productEvent of Object.keys(a.BUS_EVENT_MAP)) {
    const keys = a.BUS_PROP_KEYS[productEvent];
    assert.ok(Array.isArray(keys) && keys.length, `${productEvent} is bridged but has no BUS_PROP_KEYS entry`);
  }
  // An unmapped or unknown event projects to nothing rather than passing
  // the payload through.
  assert.deepStrictEqual(plain(a.projectBusPayload("WORKOUT_COMPLETED", { anything: 1 })), {});
  assert.deepStrictEqual(plain(a.projectBusPayload("POST_CREATED", null)), {});
});

test("attachToBus:false configures the writer without the bridge", async () => {
  const window = await bootApp();
  const mock = createMockSupabase();
  const bus = window.HaimuniaEvents;
  window.HaimuniaAnalytics.configure({ client: mock.client, userId: "user-1", attachToBus: false });
  bus.emit(bus.EVENTS.POST_CREATED, { post_id: "p1" });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(mock.db.analytics_events, undefined);
  // The writer still works when called directly.
  await window.analyticsTrack("post_created", { post_id: "p1" });
  assert.strictEqual(mock.db.analytics_events.length, 1);
});
