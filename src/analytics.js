// COMM-013. The analytics helper.
//
// One place that writes public.analytics_events (migration
// 202608280012). Every tracked product action goes through
// analyticsTrack(), so the event names stay an allow-list in one file
// instead of drifting into free-text strings at each call site.
//
// The table takes a direct RLS insert, not an RPC: the insert policy is
// own-row or a null user_id, and reads are gated on
// community.analytics.view, so a member cannot read back what they wrote.
//
// Phase 0 ships the helper, the constants, and the bus bridge. Wiring the
// actual surfaces (a club tab view, a feed impression, a post open) is
// COMM-170 in Phase 1.
//
// ---------------------------------------------------------------------
// Weekly Community Active Members (WCAM), spec section 78
// ---------------------------------------------------------------------
// The core community health metric. One agreed definition, so the client
// event stream and any later server-side rollup cannot disagree.
//
//   WCAM for a calendar week = the count of unique members who, inside
//   that week, did at least ONE of:
//     - created a post
//     - created a comment
//     - added a reaction
//     - joined a challenge
//     - participated in an event (an RSVP of going, or attending)
//     - shared an achievement
//     - interacted with a coach or with a community item (opened a post,
//       opened a member profile, opened an announcement, opened a
//       notification)
//
// Passive views alone do not count: opening the club tab or scrolling
// the feed is not membership activity. Uniqueness is per member per
// week, not per action, so ten comments from one member is one active
// member. Week boundaries follow the club's local week, not UTC.
//
// The event names below that qualify are listed in ACTIVE_MEMBER_EVENTS.
// ---------------------------------------------------------------------
//
// Schema versioning: adding a prop to an existing event is additive and
// does not move SCHEMA_VERSION. Removing or renaming a prop, or changing
// what an existing prop means, bumps it, so a query can tell the two
// shapes apart.
(function () {
  "use strict";

  const SCHEMA_VERSION = 1;

  // The tracked event names from spec section 77. The migration's CHECK
  // only enforces the name shape (lower snake case, 3 to 64 chars); this
  // list is the real allow-list, and it lives here rather than in a CHECK
  // so adding a tracked event does not need a migration.
  const EVENTS = Object.freeze({
    CLUB_TAB_VIEWED: "club_tab_viewed",
    FEED_VIEWED: "feed_viewed",
    POST_IMPRESSION: "post_impression",
    POST_OPENED: "post_opened",
    POST_CREATED: "post_created",
    WORKOUT_SHARED: "workout_shared",
    ACHIEVEMENT_SHARED: "achievement_shared",
    REACTION_ADDED: "reaction_added",
    COMMENT_CREATED: "comment_created",
    PROFILE_OPENED: "profile_opened",
    MEMBER_FOLLOWED: "member_followed",
    CHALLENGE_VIEWED: "challenge_viewed",
    CHALLENGE_JOINED: "challenge_joined",
    CHALLENGE_COMPLETED: "challenge_completed",
    LEADERBOARD_VIEWED: "leaderboard_viewed",
    EVENT_VIEWED: "event_viewed",
    EVENT_RSVP: "event_rsvp",
    NOTIFICATION_OPENED: "notification_opened",
    WEEKLY_RECAP_OPENED: "weekly_recap_opened",
    WEEKLY_RECAP_SHARED: "weekly_recap_shared",
    REPORT_SUBMITTED: "report_submitted",
  });
  const KNOWN = new Set(Object.values(EVENTS));

  // The subset of the above that counts a member as active for the week,
  // per the WCAM definition at the top of this file. Kept as data so a
  // rollup query and this client cannot drift apart.
  const ACTIVE_MEMBER_EVENTS = Object.freeze([
    EVENTS.POST_CREATED,
    EVENTS.WORKOUT_SHARED,
    EVENTS.ACHIEVEMENT_SHARED,
    EVENTS.COMMENT_CREATED,
    EVENTS.REACTION_ADDED,
    EVENTS.CHALLENGE_JOINED,
    EVENTS.CHALLENGE_COMPLETED,
    EVENTS.EVENT_RSVP,
    EVENTS.POST_OPENED,
    EVENTS.PROFILE_OPENED,
    EVENTS.MEMBER_FOLLOWED,
    EVENTS.NOTIFICATION_OPENED,
  ]);
  const ACTIVE_MEMBER_EVENT_SET = new Set(ACTIVE_MEMBER_EVENTS);

  // The server rejects a props payload over 4 KB (the
  // analytics_events_props_size trigger). It measures pg_column_size()
  // on the stored jsonb, which is not the same number as the length of
  // the JSON text we send, so the client trims against a smaller budget
  // and leaves headroom rather than betting the two measurements agree.
  const MAX_PROPS_BYTES = 4096;
  const PROPS_BUDGET_BYTES = 3072;

  // The one-to-one mappings from the product event bus (COMM-012) to a
  // tracked analytics name. Only genuinely one-to-one entries belong
  // here. WORKOUT_COMPLETED, PR_CREATED, MEMBER_JOINED,
  // ACHIEVEMENT_UNLOCKED and ATTENDANCE_RECORDED are deliberately absent:
  // completing a workout is not sharing one, and unlocking an achievement
  // is not sharing it, so mapping them would inflate WCAM with actions
  // that are not community participation.
  const BUS_EVENT_MAP = Object.freeze({
    POST_CREATED: EVENTS.POST_CREATED,
    COMMENT_CREATED: EVENTS.COMMENT_CREATED,
    REACTION_CREATED: EVENTS.REACTION_ADDED,
    CHALLENGE_JOINED: EVENTS.CHALLENGE_JOINED,
    CHALLENGE_COMPLETED: EVENTS.CHALLENGE_COMPLETED,
    EVENT_REGISTERED: EVENTS.EVENT_RSVP,
  });

  let getClient = () => null;
  let getUserId = () => null;
  let busUnsubscribes = [];

  function byteLength(text) {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
    return unescape(encodeURIComponent(text)).length;
  }

  // Drop keys until the payload fits the budget, largest value first, and
  // mark the row so a query can tell a trimmed payload from a small one.
  // Trimming beats rejecting: losing one oversized prop is better than
  // losing the whole event, and an oversized prop is nearly always a blob
  // somebody attached by accident.
  function fitProps(props) {
    let body = {};
    if (props && typeof props === "object" && !Array.isArray(props)) {
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined || typeof value === "function") continue;
        body[key] = value;
      }
    }
    let serialized;
    try { serialized = JSON.stringify(body); } catch (err) { return { props: { _unserializable: true }, truncated: true }; }
    if (byteLength(serialized) <= PROPS_BUDGET_BYTES) return { props: body, truncated: false };

    const sized = Object.keys(body)
      .map((key) => ({ key, size: byteLength(JSON.stringify(body[key]) || "") }))
      .sort((a, b) => b.size - a.size);
    const trimmed = { ...body, _truncated: true };
    for (const entry of sized) {
      delete trimmed[entry.key];
      if (byteLength(JSON.stringify(trimmed)) <= PROPS_BUDGET_BYTES) return { props: trimmed, truncated: true };
    }
    return { props: { _truncated: true }, truncated: true };
  }

  // Record one tracked event. Returns a promise resolving true when the
  // row was accepted, false otherwise.
  //
  // It never throws and never rejects. Analytics is measurement, not a
  // feature: a dropped row is acceptable, a broken compose button is not.
  // Callers are free to ignore the return value, and every caller does.
  function analyticsTrack(eventName, props) {
    try {
      if (!KNOWN.has(eventName)) {
        console.warn("[analytics] unknown event name, dropped: " + String(eventName));
        return Promise.resolve(false);
      }
      const client = getClient();
      if (!client || typeof client.from !== "function") return Promise.resolve(false);

      const fitted = fitProps(props);
      let userId = null;
      try { userId = getUserId() || null; } catch (err) { userId = null; }

      const row = {
        event_name: eventName,
        props: fitted.props,
        schema_version: SCHEMA_VERSION,
        // Null is a legal value under the insert policy, which is what
        // makes a pre-profile event (an invite screen, a failed
        // redemption) recordable at all.
        user_id: userId,
      };
      return Promise.resolve(client.from("analytics_events").insert(row))
        .then((result) => !(result && result.error))
        .catch(() => false);
    } catch (err) {
      return Promise.resolve(false);
    }
  }

  // Attach the product bus bridge. Idempotent: calling it twice does not
  // double-track, because the previous subscriptions are dropped first.
  function attachToBus() {
    const bus = window.HaimuniaEvents;
    if (!bus || typeof bus.on !== "function") return 0;
    detachFromBus();
    for (const [productEvent, analyticsName] of Object.entries(BUS_EVENT_MAP)) {
      busUnsubscribes.push(bus.on(productEvent, (payload) => analyticsTrack(analyticsName, payload)));
    }
    return busUnsubscribes.length;
  }

  function detachFromBus() {
    for (const off of busUnsubscribes) { try { off(); } catch (err) { /* already gone */ } }
    busUnsubscribes = [];
  }

  // Hand the helper a Supabase client and a way to read the current user
  // id. Nothing calls this in Phase 0, which is exactly why the helper is
  // an inert no-op until COMM-170 wires it up: an unconfigured track()
  // returns false without touching the network.
  //
  // Passing attachToBus:false configures the writer without the bus
  // bridge, for a caller that wants to emit analytics by hand.
  function configure(opts) {
    const o = opts || {};
    if (o.client) getClient = () => o.client;
    else if (typeof o.getClient === "function") getClient = o.getClient;
    if (typeof o.getUserId === "function") getUserId = o.getUserId;
    else if ("userId" in o) getUserId = () => o.userId;
    if (o.attachToBus !== false) attachToBus();
    return true;
  }

  function reset() {
    detachFromBus();
    getClient = () => null;
    getUserId = () => null;
  }

  function isActiveMemberEvent(eventName) { return ACTIVE_MEMBER_EVENT_SET.has(eventName); }

  window.HaimuniaAnalytics = {
    EVENTS,
    ACTIVE_MEMBER_EVENTS,
    BUS_EVENT_MAP,
    SCHEMA_VERSION,
    MAX_PROPS_BYTES,
    PROPS_BUDGET_BYTES,
    track: analyticsTrack,
    configure,
    attachToBus,
    detachFromBus,
    reset,
    isActiveMemberEvent,
    isKnown: (name) => KNOWN.has(name),
    fitProps,
  };
  window.analyticsTrack = analyticsTrack;
  window.ANALYTICS_EVENTS = EVENTS;
})();
