// COMM-014. The Supabase Realtime harness.
//
// The bug this file exists to prevent is invisible in a browser: a
// channel that stays open after the view that created it is gone. It
// costs nothing visible, it never throws, and it accumulates. So the
// assertions here are mostly about what is closed, not what is open.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, bootApp } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

// A filter object built inside the jsdom window carries that realm's
// Object.prototype, which deepStrictEqual reads as a mismatch even when
// the data agrees. JSON re-homes it in this realm.
const plain = (v) => JSON.parse(JSON.stringify(v));

function silence(window) {
  const warns = [];
  const errors = [];
  window.console.warn = (...args) => warns.push(args.join(" "));
  window.console.error = (...args) => errors.push(args.join(" "));
  return { warns, errors };
}

async function harness() {
  const mock = createMockSupabase();
  const window = await bootApp();
  window.HaimuniaRealtime.configure({ client: mock.client });
  return { window, mock, rt: window.HaimuniaRealtime };
}

test("subscribe opens one channel, binds postgres_changes with the given filter, and returns an unsubscribe", async () => {
  const { mock, rt } = await harness();
  const seen = [];
  const off = rt.subscribe("post-comments-p1", { table: "comments", event: "INSERT", filter: "post_id=eq.p1" }, (p) => seen.push(p));

  assert.strictEqual(typeof off, "function");
  assert.strictEqual(rt.count(), 1);
  assert.deepStrictEqual(mock.openChannels(), ["post-comments-p1"]);

  const binding = mock.channels[0].bindings[0];
  assert.strictEqual(binding.kind, "postgres_changes");
  assert.deepStrictEqual(plain(binding.filter), { event: "INSERT", schema: "public", table: "comments", filter: "post_id=eq.p1" });

  assert.strictEqual(mock.emitRealtime("post-comments-p1", { new: { id: "c1" } }), 1);
  assert.deepStrictEqual(seen, [{ new: { id: "c1" } }]);
});

test("the defaults are every event on the public schema, so a caller only has to name a table", async () => {
  const { mock, rt } = await harness();
  rt.subscribe("reactions", { table: "reactions" }, () => {});
  assert.deepStrictEqual(plain(mock.channels[0].bindings[0].filter), { event: "*", schema: "public", table: "reactions" });
});

test("unsubscribe removes the channel from the client, not only from the registry, and is idempotent", async () => {
  const { mock, rt } = await harness();
  const off = rt.subscribe("chal-progress-1", { table: "challenge_progress" }, () => {});

  assert.strictEqual(off(), true);
  assert.strictEqual(rt.count(), 0);
  assert.deepStrictEqual(mock.openChannels(), [], "removeChannel must actually have been called");
  // A closed channel delivers nothing, which is the whole point.
  assert.strictEqual(mock.emitRealtime("chal-progress-1", {}), 0);

  assert.strictEqual(off(), false, "a second unsubscribe is a no-op, not a throw");
  assert.strictEqual(rt.unsubscribe("chal-progress-1"), false);
});

test("teardownAll closes every open channel and reports how many", async () => {
  const { mock, rt } = await harness();
  rt.subscribe("a", { table: "comments" }, () => {});
  rt.subscribe("b", { table: "reactions" }, () => {});
  rt.subscribe("c", { table: "challenge_progress" }, () => {});
  assert.strictEqual(rt.count(), 3);

  assert.strictEqual(rt.teardownAll(), 3);
  assert.strictEqual(rt.count(), 0);
  assert.deepStrictEqual(mock.openChannels(), []);
  assert.strictEqual(rt.teardownAll(), 0, "tearing down twice closes nothing the second time");
});

test("changing the community sub-tab tears every subscription down", async () => {
  const mock = createMockSupabase();
  const window = await bootCommunity(mock);
  const rt = window.HaimuniaRealtime;
  rt.configure({ client: mock.client });
  rt.subscribe("feed-comments", { table: "comments" }, () => {});
  rt.subscribe("feed-reactions", { table: "reactions" }, () => {});
  assert.strictEqual(rt.count(), 2);

  window.handleCommunityClick({ dataset: { communityAction: "set-tab", tab: "profile" } });

  assert.strictEqual(rt.count(), 0, "leaving a sub-tab must close the channels that sub-tab opened");
  assert.deepStrictEqual(mock.openChannels(), []);
});

test("re-selecting the sub-tab already showing does not tear down its own subscriptions", async () => {
  const mock = createMockSupabase();
  const window = await bootCommunity(mock);
  const rt = window.HaimuniaRealtime;
  rt.configure({ client: mock.client });
  rt.subscribe("feed-comments", { table: "comments" }, () => {});

  // "feed" is the default sub-tab; tapping it again is not a view change.
  window.handleCommunityClick({ dataset: { communityAction: "set-tab", tab: "feed" } });
  assert.strictEqual(rt.count(), 1);
});

test("subscribing twice under one name replaces the binding rather than delivering everything twice", async () => {
  const { mock, rt } = await harness();
  const first = [];
  const second = [];
  rt.subscribe("post-comments-p1", { table: "comments" }, (p) => first.push(p));
  rt.subscribe("post-comments-p1", { table: "comments" }, (p) => second.push(p));

  assert.strictEqual(rt.count(), 1);
  assert.deepStrictEqual(mock.openChannels(), ["post-comments-p1"]);
  assert.strictEqual(mock.emitRealtime("post-comments-p1", { new: { id: "c1" } }), 1);
  assert.strictEqual(first.length, 0, "the replaced handler must be gone");
  assert.strictEqual(second.length, 1);
});

test("handlers are bound before subscribe, so a reconnect cannot duplicate them", async () => {
  const { window, mock, rt } = await harness();
  silence(window);
  const seen = [];
  rt.subscribe("reconnecting", { table: "comments" }, (p) => seen.push(p));
  const channel = mock.channels[0];
  assert.strictEqual(channel.bindings.length, 1);

  // A dropped socket that rejoins replays the SUBSCRIBED status. Nothing
  // in the harness re-binds on that callback, so the binding count must
  // not move.
  mock.pushRealtimeStatus("reconnecting", "CHANNEL_ERROR", new Error("socket closed"));
  mock.pushRealtimeStatus("reconnecting", "SUBSCRIBED", null);
  assert.strictEqual(channel.bindings.length, 1, "a rejoin must not add a second binding");
  assert.strictEqual(channel.subscribeCalls, 1, "the harness must not call subscribe() again on a rejoin");

  assert.strictEqual(mock.emitRealtime("reconnecting", { new: { id: "c1" } }), 1);
  assert.strictEqual(seen.length, 1, "one payload must arrive once, not once per reconnect");
});

test("a CLOSED status drops the registry slot, so the next subscribe opens a fresh channel", async () => {
  const { mock, rt } = await harness();
  rt.subscribe("closing", { table: "comments" }, () => {});
  assert.strictEqual(rt.count(), 1);

  mock.pushRealtimeStatus("closing", "CLOSED", null);
  assert.strictEqual(rt.count(), 0, "a terminal CLOSED must not leave a dead channel in the registry");

  rt.subscribe("closing", { table: "comments" }, () => {});
  assert.strictEqual(rt.count(), 1);
  assert.strictEqual(mock.channels.length, 2, "the second subscribe must open a new channel object");
});

test("the eleventh subscription evicts the oldest with a warning rather than silently growing", async () => {
  const { window, mock, rt } = await harness();
  const logs = silence(window);
  assert.strictEqual(rt.MAX_SUBSCRIPTIONS, 10);

  for (let i = 0; i < 10; i++) rt.subscribe("ch-" + i, { table: "comments" }, () => {});
  assert.strictEqual(rt.count(), 10);

  rt.subscribe("ch-10", { table: "comments" }, () => {});
  assert.strictEqual(rt.count(), 10, "the cap must hold");
  const open = mock.openChannels();
  assert.ok(!open.includes("ch-0"), "the oldest channel is the one that goes");
  assert.ok(open.includes("ch-10"));
  assert.ok(logs.warns.some((l) => l.includes("subscription cap of 10 reached")));
});

test("a throwing handler is isolated and does not tear the channel down", async () => {
  const { window, mock, rt } = await harness();
  const logs = silence(window);
  rt.subscribe("noisy", { table: "comments" }, () => { throw new Error("consumer bug"); });

  assert.doesNotThrow(() => mock.emitRealtime("noisy", { new: {} }));
  assert.ok(logs.errors.some((l) => l.includes("handler failed for comments")));
  assert.strictEqual(rt.count(), 1, "one bad payload must not close the subscription");
});

test("with no client configured, subscribe is a working no-op instead of an error path callers must handle", async () => {
  const window = await bootApp();
  const rt = window.HaimuniaRealtime;
  const off = rt.subscribe("anything", { table: "comments" }, () => {});
  assert.strictEqual(typeof off, "function");
  assert.strictEqual(off(), false);
  assert.strictEqual(rt.count(), 0);
});

test("a missing name or handler is refused without opening a channel", async () => {
  const { window, mock, rt } = await harness();
  silence(window);
  assert.strictEqual(typeof rt.subscribe("", { table: "comments" }, () => {}), "function");
  assert.strictEqual(typeof rt.subscribe("named", { table: "comments" }, null), "function");
  assert.strictEqual(rt.count(), 0);
  assert.strictEqual(mock.channels.length, 0);
});

test("broadcast and presence bindings go through the same registry, so they tear down the same way", async () => {
  const { mock, rt } = await harness();
  const seen = [];
  rt.subscribe("urgent-announcements", { broadcast: "announcement" }, (p) => seen.push(p));
  assert.strictEqual(mock.channels[0].bindings[0].kind, "broadcast");
  assert.strictEqual(mock.emitRealtime("urgent-announcements", { text: "gym closed" }, "broadcast"), 1);
  assert.deepStrictEqual(seen, [{ text: "gym closed" }]);

  rt.subscribe("who-is-here", { presence: "sync" }, () => {});
  assert.strictEqual(rt.count(), 2);
  assert.strictEqual(rt.teardownAll(), 2);
});

test("Phase 0 ships with nothing subscribed - no feature opens a channel at boot", async () => {
  const mock = createMockSupabase();
  const window = await bootCommunity(mock, { syncEnabled: true });
  assert.strictEqual(window.HaimuniaRealtime.count(), 0);
  assert.strictEqual(mock.channels.length, 0);

  // And no feature code reaches client.channel() behind the harness's
  // back, which is the rule the harness only enforces by being the one
  // place that calls it.
  const cloud = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
  assert.doesNotMatch(cloud, /client\.channel\(/, "feature code must subscribe through HaimuniaRealtime, not client.channel()");
});
