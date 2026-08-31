// COMM-012. The product event bus.
//
// One typed stream every community feature publishes to and subscribes
// from. Producers (posts, engagement, challenges, events, achievements)
// call emit(). Consumers (achievements, notifications, feed, analytics,
// coach-tools) call on(). Nothing subscribes to a Supabase channel or
// reaches into another feature's internals to learn that something
// happened - that is the whole point of having this file.
//
// Loaded as a classic <script> before cloud.js and app.js, so both can
// reach it. Everything it needs lives on window.HaimuniaEvents; nothing
// here depends on a lexical binding leaking across script tags.
//
// Phase 0 ships the bus with no producers and no consumers wired. Each
// feature ticket attaches its own end.
(function () {
  "use strict";

  // The full typed list. A type not in here is not a product event.
  //
  // ATTENDANCE_RECORDED was defined and accepted in Phase 0 on purpose,
  // with no producer, because the attendance data source was still
  // unpicked. COMM-300 (Phase 3) picked it - the member's own training-log
  // sync - and `flushOutbox()` in cloud.js is now its producer, carrying
  // `{occurred_on}`. Defining it early paid off exactly as intended: wiring
  // attendance did not change this file.
  //
  // What a consumer must not assume: this emit is a courtesy. The
  // `attendance_log` row is written server-side by a trigger on
  // `private_records`, independently, so a member on an older cached build
  // produces the row without ever emitting here. Nothing may depend on this
  // event firing for correctness.
  const EVENTS = Object.freeze({
    WORKOUT_COMPLETED: "WORKOUT_COMPLETED",
    PR_CREATED: "PR_CREATED",
    ATTENDANCE_RECORDED: "ATTENDANCE_RECORDED",
    ACHIEVEMENT_UNLOCKED: "ACHIEVEMENT_UNLOCKED",
    CHALLENGE_JOINED: "CHALLENGE_JOINED",
    CHALLENGE_COMPLETED: "CHALLENGE_COMPLETED",
    EVENT_REGISTERED: "EVENT_REGISTERED",
    POST_CREATED: "POST_CREATED",
    COMMENT_CREATED: "COMMENT_CREATED",
    REACTION_CREATED: "REACTION_CREATED",
    MEMBER_JOINED: "MEMBER_JOINED",
  });
  const KNOWN = new Set(Object.keys(EVENTS));

  // type -> Set of handler functions. A Set is what makes a double
  // subscribe of the same function idempotent and an unsubscribe cheap.
  const handlers = new Map();

  // An unknown event type is a programming mistake, so it should be loud
  // where a developer will see it and silent where a member would. There
  // is no build step to define this away, so it is decided at call time:
  // an explicit window.HAIMUNIA_DEV flag wins, otherwise a local origin
  // counts as development and anything else (the deployed origin) does
  // not.
  function isDev() {
    if (typeof window.HAIMUNIA_DEV === "boolean") return window.HAIMUNIA_DEV;
    const host = (window.location && window.location.hostname) || "";
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "" || host.endsWith(".local");
  }

  function reject(message) {
    if (isDev()) throw new Error("[eventbus] " + message);
    console.warn("[eventbus] " + message);
    return false;
  }

  function isPlainPayload(payload) {
    return payload !== null && typeof payload === "object" && !Array.isArray(payload);
  }

  // Subscribe to one product event. Returns an unsubscribe function.
  // Calling it twice is safe and never removes anyone else's handler,
  // because the Set is keyed by the function identity we captured.
  function on(type, handler) {
    if (!KNOWN.has(type)) {
      reject("unknown event type on subscribe: " + String(type));
      return function noop() {};
    }
    if (typeof handler !== "function") {
      reject("handler for " + type + " is not a function");
      return function noop() {};
    }
    let set = handlers.get(type);
    if (!set) { set = new Set(); handlers.set(type, set); }
    set.add(handler);
    let live = true;
    return function unsubscribe() {
      if (!live) return false;
      live = false;
      const current = handlers.get(type);
      if (!current) return false;
      const removed = current.delete(handler);
      if (current.size === 0) handlers.delete(type);
      return removed;
    };
  }

  // Publish one product event. Returns the number of handlers invoked,
  // or 0 when the event was dropped.
  //
  // The bus does not deep-clone the payload - producers pass data they
  // are done mutating. It also does not await handlers: a consumer that
  // returns a promise owns its own failure, and emit() must never make a
  // producer wait on notifications or analytics.
  function emit(type, payload) {
    if (!KNOWN.has(type)) {
      reject("unknown event type on emit: " + String(type));
      return 0;
    }
    const body = payload === undefined ? {} : payload;
    if (!isPlainPayload(body)) {
      reject("payload for " + type + " must be a plain object");
      return 0;
    }
    const set = handlers.get(type);
    if (!set || set.size === 0) return 0;
    // Snapshot before dispatch. A handler is allowed to subscribe or
    // unsubscribe while it runs, and neither should change who this
    // particular emit delivers to.
    const snapshot = Array.from(set);
    let delivered = 0;
    for (const handler of snapshot) {
      delivered++;
      // Handlers are isolated. One consumer throwing must not stop the
      // rest: an achievements bug must not silently cost a member their
      // notification.
      try {
        const result = handler(body, type);
        if (result && typeof result.catch === "function") {
          result.catch((err) => console.error("[eventbus] async handler failed for " + type, err));
        }
      } catch (err) {
        console.error("[eventbus] handler failed for " + type, err);
      }
    }
    return delivered;
  }

  // Drops every subscription. Used by tests and by a full sign-out, so a
  // consumer bound to the previous session cannot keep receiving events.
  function reset() {
    handlers.clear();
  }

  // How many handlers are attached to a type. Read-only introspection,
  // used by tests and by the realtime and analytics helpers to decide
  // whether a bridge is already attached.
  function handlerCount(type) {
    const set = handlers.get(type);
    return set ? set.size : 0;
  }

  window.HaimuniaEvents = { EVENTS, on, emit, reset, handlerCount, isKnown: (t) => KNOWN.has(t) };
  // Flat alias for the type list, so a call site inside cloud.js reads as
  // HaimuniaEvents.emit(PRODUCT_EVENTS.POST_CREATED, {...}) rather than
  // repeating the namespace twice on one line.
  window.PRODUCT_EVENTS = EVENTS;
})();
