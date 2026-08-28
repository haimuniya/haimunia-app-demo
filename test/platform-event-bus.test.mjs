// COMM-012. The product event bus.
//
// Boots the real shell so the bus is exercised exactly as index.html
// loads it, rather than importing a reimplementation. The wiring tests
// at the bottom are the ones that catch the silent failure mode: a new
// src/*.js file that works in tests but was never added to the service
// worker's precache list or to the boot helper's load order.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootApp } from "./helpers/boot.mjs";

const EXPECTED_TYPES = [
  "WORKOUT_COMPLETED",
  "PR_CREATED",
  "ATTENDANCE_RECORDED",
  "ACHIEVEMENT_UNLOCKED",
  "CHALLENGE_JOINED",
  "CHALLENGE_COMPLETED",
  "EVENT_REGISTERED",
  "POST_CREATED",
  "COMMENT_CREATED",
  "REACTION_CREATED",
  "MEMBER_JOINED",
];

// An object built inside the jsdom window has that realm's
// Object.prototype, which deepStrictEqual treats as a mismatch even when
// every key and value agrees. Round-tripping through JSON re-homes it in
// this realm so the comparison is about the data, not the realm.
const plain = (v) => JSON.parse(JSON.stringify(v));

// Silences the bus's own console.warn/error so a test that deliberately
// throws inside a handler doesn't print a stack trace that reads like a
// failure. Returns what was logged, so a test can assert on it.
function captureConsole(window) {
  const warns = [];
  const errors = [];
  window.console.warn = (...args) => warns.push(args.join(" "));
  window.console.error = (...args) => errors.push(args.join(" "));
  return { warns, errors };
}

test("the bus exposes exactly the eleven typed product events", async () => {
  const window = await bootApp();
  const bus = window.HaimuniaEvents;
  assert.ok(bus, "window.HaimuniaEvents must exist after the shell loads");
  assert.deepStrictEqual(Object.keys(bus.EVENTS).sort(), EXPECTED_TYPES.slice().sort());
  // Each constant's value is its own name, so a payload logged with the
  // raw string is still traceable back to the constant.
  for (const type of EXPECTED_TYPES) assert.strictEqual(bus.EVENTS[type], type);
  assert.strictEqual(window.PRODUCT_EVENTS, bus.EVENTS, "the flat alias must be the same frozen object");
});

test("emit delivers the payload to every subscriber, on returns a working unsubscribe", async () => {
  const window = await bootApp();
  const bus = window.HaimuniaEvents;
  const seenA = [];
  const seenB = [];
  const offA = bus.on(bus.EVENTS.POST_CREATED, (p) => seenA.push(p));
  bus.on(bus.EVENTS.POST_CREATED, (p) => seenB.push(p));

  assert.strictEqual(bus.emit(bus.EVENTS.POST_CREATED, { postId: "p1" }), 2);
  assert.deepStrictEqual(seenA, [{ postId: "p1" }]);
  assert.deepStrictEqual(seenB, [{ postId: "p1" }]);

  // Unsubscribing one must not touch the other, and calling it a second
  // time must be a harmless no-op rather than removing someone else.
  assert.strictEqual(offA(), true);
  assert.strictEqual(offA(), false);
  assert.strictEqual(bus.emit(bus.EVENTS.POST_CREATED, { postId: "p2" }), 1);
  assert.strictEqual(seenA.length, 1);
  assert.strictEqual(seenB.length, 2);
});

test("an event with no subscribers is delivered to nobody and does not throw", async () => {
  const window = await bootApp();
  const bus = window.HaimuniaEvents;
  assert.strictEqual(bus.emit(bus.EVENTS.MEMBER_JOINED, { userId: "u1" }), 0);
});

test("ATTENDANCE_RECORDED is accepted with no producer, so wiring attendance later touches no other file", async () => {
  const window = await bootApp();
  const bus = window.HaimuniaEvents;
  const seen = [];
  bus.on(bus.EVENTS.ATTENDANCE_RECORDED, (p) => seen.push(p));
  assert.strictEqual(bus.emit(bus.EVENTS.ATTENDANCE_RECORDED, { classId: "c1" }), 1);
  assert.deepStrictEqual(seen, [{ classId: "c1" }]);
});

test("one throwing handler does not stop the others", async () => {
  const window = await bootApp();
  const logs = captureConsole(window);
  const bus = window.HaimuniaEvents;
  const order = [];
  bus.on(bus.EVENTS.COMMENT_CREATED, () => order.push("first"));
  bus.on(bus.EVENTS.COMMENT_CREATED, () => { throw new Error("consumer bug"); });
  bus.on(bus.EVENTS.COMMENT_CREATED, () => order.push("third"));

  assert.strictEqual(bus.emit(bus.EVENTS.COMMENT_CREATED, { commentId: "c1" }), 3);
  assert.deepStrictEqual(order, ["first", "third"]);
  assert.ok(logs.errors.some((l) => l.includes("handler failed for COMMENT_CREATED")));
});

test("a rejected promise from an async handler is caught, not left unhandled", async () => {
  const window = await bootApp();
  const logs = captureConsole(window);
  const bus = window.HaimuniaEvents;
  bus.on(bus.EVENTS.REACTION_CREATED, async () => { throw new Error("async consumer bug"); });
  assert.strictEqual(bus.emit(bus.EVENTS.REACTION_CREATED, {}), 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(logs.errors.some((l) => l.includes("async handler failed for REACTION_CREATED")));
});

test("emit does not wait on its handlers - a slow consumer cannot block a producer", async () => {
  const window = await bootApp();
  const bus = window.HaimuniaEvents;
  let resolved = false;
  bus.on(bus.EVENTS.PR_CREATED, () => new Promise((r) => setTimeout(() => { resolved = true; r(); }, 50)));
  bus.emit(bus.EVENTS.PR_CREATED, {});
  assert.strictEqual(resolved, false, "emit must return before a slow handler finishes");
});

test("an unknown event type throws in development", async () => {
  const window = await bootApp();
  window.HAIMUNIA_DEV = true;
  const bus = window.HaimuniaEvents;
  assert.throws(() => bus.emit("NOT_A_REAL_EVENT", {}), /unknown event type on emit/);
  assert.throws(() => bus.on("NOT_A_REAL_EVENT", () => {}), /unknown event type on subscribe/);
});

test("an unknown event type is dropped with a warning in production, never thrown at a member", async () => {
  const window = await bootApp();
  window.HAIMUNIA_DEV = false;
  const logs = captureConsole(window);
  const bus = window.HaimuniaEvents;
  assert.strictEqual(bus.emit("NOT_A_REAL_EVENT", {}), 0);
  const off = bus.on("NOT_A_REAL_EVENT", () => {});
  assert.strictEqual(typeof off, "function");
  assert.strictEqual(off(), undefined, "the no-op unsubscribe must be safe to call");
  assert.strictEqual(logs.warns.filter((l) => l.includes("unknown event type")).length, 2);
});

test("a non-object payload is refused - the bus carries structured events, not bare strings", async () => {
  const window = await bootApp();
  window.HAIMUNIA_DEV = true;
  const bus = window.HaimuniaEvents;
  assert.throws(() => bus.emit(bus.EVENTS.POST_CREATED, "p1"), /must be a plain object/);
  assert.throws(() => bus.emit(bus.EVENTS.POST_CREATED, ["p1"]), /must be a plain object/);
  // Omitting the payload entirely is fine and arrives as an empty object.
  const seen = [];
  bus.on(bus.EVENTS.POST_CREATED, (p) => seen.push(p));
  assert.strictEqual(bus.emit(bus.EVENTS.POST_CREATED), 1);
  assert.deepStrictEqual(plain(seen), [{}]);
});

test("the bus does not clone the payload - producers pass data they are done mutating", async () => {
  const window = await bootApp();
  const bus = window.HaimuniaEvents;
  const payload = { postId: "p1" };
  let received = null;
  bus.on(bus.EVENTS.POST_CREATED, (p) => { received = p; });
  bus.emit(bus.EVENTS.POST_CREATED, payload);
  assert.strictEqual(received, payload, "handlers get the same object reference, by design");
});

test("subscribing or unsubscribing from inside a handler does not change the running dispatch", async () => {
  const window = await bootApp();
  const bus = window.HaimuniaEvents;
  const order = [];
  const offSecond = bus.on(bus.EVENTS.CHALLENGE_JOINED, () => order.push("second"));
  bus.on(bus.EVENTS.CHALLENGE_JOINED, () => {
    order.push("late-subscriber");
  });
  const offFirst = bus.on(bus.EVENTS.CHALLENGE_JOINED, () => {
    order.push("first");
    offSecond();
    bus.on(bus.EVENTS.CHALLENGE_JOINED, () => order.push("added-mid-dispatch"));
  });
  // The handler added mid-dispatch must not run in this emit, and the one
  // unsubscribed mid-dispatch must still run in this emit.
  assert.strictEqual(bus.emit(bus.EVENTS.CHALLENGE_JOINED, {}), 3);
  assert.deepStrictEqual(order, ["second", "late-subscriber", "first"]);
  offFirst();
});

test("reset drops every subscription", async () => {
  const window = await bootApp();
  const bus = window.HaimuniaEvents;
  bus.on(bus.EVENTS.EVENT_REGISTERED, () => {});
  bus.on(bus.EVENTS.WORKOUT_COMPLETED, () => {});
  assert.strictEqual(bus.handlerCount(bus.EVENTS.EVENT_REGISTERED), 1);
  bus.reset();
  assert.strictEqual(bus.handlerCount(bus.EVENTS.EVENT_REGISTERED), 0);
  assert.strictEqual(bus.emit(bus.EVENTS.WORKOUT_COMPLETED, {}), 0);
});

// --- shell wiring ------------------------------------------------------
// A platform module that isn't in all three places is a module that
// works in tests and is missing offline, or works in the browser and is
// invisible to every test. sw-precache.test.mjs already derives the
// service worker half from index.html; these cover the order and the
// boot-helper half it deliberately does not.

const root = new URL("../", import.meta.url);
const html = fs.readFileSync(new URL("index.html", root), "utf8");
const boot = fs.readFileSync(new URL("test/helpers/boot.mjs", root), "utf8");

const PLATFORM_FILES = ["./src/eventbus.js", "./src/analytics.js", "./src/realtime.js", "./src/image.js"];

test("every platform module is loaded by index.html before cloud.js and app.js", () => {
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  const cloudAt = scripts.indexOf("./cloud.js");
  const appAt = scripts.indexOf("./app.js");
  assert.ok(cloudAt > 0 && appAt > 0, "sanity check: index.html loads cloud.js and app.js");
  for (const file of PLATFORM_FILES) {
    const at = scripts.indexOf(file);
    assert.ok(at >= 0, `${file} must be loaded by index.html`);
    assert.ok(at < cloudAt, `${file} must load before cloud.js, which reaches it through window`);
    assert.ok(at < appAt, `${file} must load before app.js`);
  }
});

test("the boot helper loads the platform modules in the same order index.html does", () => {
  const listed = [...boot.matchAll(/path\.join\(root, "src", "([a-z]+\.js)"\)/g)].map((m) => "./src/" + m[1]);
  for (const file of PLATFORM_FILES) {
    assert.ok(listed.includes(file), `${file} is loaded by index.html but missing from test/helpers/boot.mjs`);
  }
  // The relative order inside boot.mjs must match index.html, because a
  // module that reads another one's window global at load time would
  // otherwise pass in the browser and fail (or worse, silently no-op) in
  // the test harness.
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]).filter((s) => PLATFORM_FILES.includes(s));
  assert.deepStrictEqual(listed.filter((f) => PLATFORM_FILES.includes(f)), scripts);
  assert.ok(boot.includes("readPlatformSrc()"), "boot.mjs must actually eval the platform sources");
});
