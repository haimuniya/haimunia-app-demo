// COMM-014. The Supabase Realtime harness.
//
// One subscription helper and one registry. Feature code never touches
// client.channel() directly: it asks for a subscription, gets a teardown
// function back, and the registry guarantees that leaving the community
// view closes everything, whether or not the feature remembered to.
//
// A leaked realtime channel is not a visible bug. It is an open
// websocket binding that keeps firing handlers against state the view
// already threw away, and it accumulates every time a member switches
// tabs. Centralising teardown is the only reliable fix, because the
// alternative is trusting every future feature ticket to clean up after
// itself.
//
// Phase 0 shipped zero active subscriptions. Phase 2 is where the first
// live ones land, all of them in cloud.js and all of them through
// subscribe() below: the challenge detail's challenge_progress and
// challenge_participants channels (COMM-209), the feed session's shared
// post_comments and reactions channels (COMM-227), and the own-row
// notifications channel COMM-140 wired ahead of time. Each of those five
// tables had to be added to the supabase_realtime publication first
// (migration 202608290007) - before that, subscribe() was a working
// no-op because Postgres replicated nothing for them.
(function () {
  "use strict";

  // Ten open channels per session. The realtime service bills and limits
  // on concurrent channels, and a view that legitimately needs more than
  // ten live bindings has a design problem, not a capacity problem.
  const MAX_SUBSCRIPTIONS = 10;

  let getClient = () => null;
  // Insertion-ordered, keyed by channel name. Map preserves insertion
  // order, which is what makes "evict the oldest" a first-key lookup.
  const registry = new Map();

  function resolveClient() {
    try {
      const client = getClient();
      return client && typeof client.channel === "function" ? client : null;
    } catch (err) {
      return null;
    }
  }

  // Bind one handler set to a channel. Bindings are attached BEFORE
  // subscribe() is called, which is what makes reconnect safe: the
  // vendored client rejoins an existing channel object after a dropped
  // socket and replays its own bindings, it does not ask us to re-bind.
  // Nothing in this file re-binds on a status callback, so a reconnect
  // cannot duplicate handlers.
  function bind(channel, opts, handler) {
    const o = opts || {};
    if (o.table) {
      const filter = { event: o.event || "*", schema: o.schema || "public", table: o.table };
      if (o.filter) filter.filter = o.filter;
      channel.on("postgres_changes", filter, (payload) => {
        try { handler(payload); } catch (err) { console.error("[realtime] handler failed for " + o.table, err); }
      });
      return;
    }
    if (o.broadcast) {
      channel.on("broadcast", { event: o.broadcast }, (payload) => {
        try { handler(payload); } catch (err) { console.error("[realtime] broadcast handler failed for " + o.broadcast, err); }
      });
      return;
    }
    if (o.presence) {
      channel.on("presence", { event: o.presence }, (payload) => {
        try { handler(payload); } catch (err) { console.error("[realtime] presence handler failed", err); }
      });
    }
  }

  // Subscribe to a table or channel. Returns an unsubscribe function,
  // always - a caller never has to null-check the return value, and a
  // teardown path stays one line whether or not the subscription was
  // actually opened.
  //
  //   const off = HaimuniaRealtime.subscribe("post-comments-" + postId,
  //     { table: "comments", event: "INSERT", filter: "post_id=eq." + postId },
  //     (payload) => { ... });
  //
  function subscribe(channelName, opts, handler) {
    const name = String(channelName || "").trim();
    if (!name) { console.warn("[realtime] subscribe needs a channel name"); return function noop() { return false; }; }
    if (typeof handler !== "function") { console.warn("[realtime] subscribe needs a handler for " + name); return function noop() { return false; }; }

    const client = resolveClient();
    // No configured client (Phase 0, or sync switched off) is a normal
    // state, not an error. Return a working no-op so callers do not need
    // a second code path for it.
    if (!client) return function noop() { return false; };

    // One channel per name. A repeat subscribe replaces the old binding
    // rather than stacking a second one, so a re-entered view cannot end
    // up delivering every event twice.
    if (registry.has(name)) unsubscribe(name);

    if (registry.size >= MAX_SUBSCRIPTIONS) {
      const oldest = registry.keys().next().value;
      console.warn("[realtime] subscription cap of " + MAX_SUBSCRIPTIONS + " reached, closing the oldest channel: " + oldest);
      unsubscribe(oldest);
    }

    let channel;
    try {
      channel = client.channel(name);
      bind(channel, opts, handler);
    } catch (err) {
      console.error("[realtime] could not open channel " + name, err);
      return function noop() { return false; };
    }

    const entry = { name, channel, status: "opening" };
    registry.set(name, entry);

    try {
      channel.subscribe((status, err) => {
        entry.status = status;
        if (err) console.warn("[realtime] channel " + name + " reported " + status, err);
        // CLOSED is terminal for this channel object. Drop the registry
        // slot so a later subscribe under the same name opens a fresh
        // one instead of handing back a dead channel.
        if (status === "CLOSED" && registry.get(name) === entry) registry.delete(name);
      });
    } catch (err) {
      console.error("[realtime] subscribe failed for " + name, err);
      registry.delete(name);
      try { client.removeChannel(channel); } catch (e) { /* nothing to close */ }
      return function noop() { return false; };
    }

    let live = true;
    return function off() {
      if (!live) return false;
      live = false;
      return unsubscribe(name);
    };
  }

  // Close one channel by name. Idempotent: closing an already-closed
  // channel returns false rather than throwing.
  function unsubscribe(channelName) {
    const entry = registry.get(channelName);
    if (!entry) return false;
    registry.delete(channelName);
    const client = resolveClient();
    try {
      if (client && typeof client.removeChannel === "function") client.removeChannel(entry.channel);
      else if (entry.channel && typeof entry.channel.unsubscribe === "function") entry.channel.unsubscribe();
    } catch (err) {
      console.warn("[realtime] removeChannel failed for " + channelName, err);
    }
    return true;
  }

  // Close everything. Called on community sub-tab change from cloud.js
  // and on sign-out. Returns how many channels were closed.
  function teardownAll() {
    let closed = 0;
    for (const name of Array.from(registry.keys())) if (unsubscribe(name)) closed++;
    return closed;
  }

  function configure(opts) {
    const o = opts || {};
    if (o.client) getClient = () => o.client;
    else if (typeof o.getClient === "function") getClient = o.getClient;
    return true;
  }

  function reset() {
    teardownAll();
    getClient = () => null;
  }

  function list() { return Array.from(registry.values()).map((e) => ({ name: e.name, status: e.status })); }
  function count() { return registry.size; }

  window.HaimuniaRealtime = {
    MAX_SUBSCRIPTIONS,
    configure,
    subscribe,
    unsubscribe,
    teardownAll,
    reset,
    list,
    count,
  };
})();
