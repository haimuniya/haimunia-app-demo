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
// Phase 0 ships the helper, the constants, and the bus bridge. COMM-170
// in Phase 1 calls configure() from cloud.js and wires the surfaces.
// COMM-233 in Phase 2 wires the surfaces that shipped after it, adds the
// four names those needed, and adds HAND_PROP_KEYS - the same allow-list
// discipline the bus bridge had, for the events that are tracked by hand.
//
// Every tracked event, its trigger surface, its props, and the Weekly
// Community Active Members definition: docs/community/metrics.md.
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
    // COMM-233 calls these two recap_viewed / recap_shared. The wire names
    // stay the ones spec 77 reserved and docs/community/metrics.md has
    // carried since Phase 1: they were defined-but-unwired for exactly this
    // surface, so wiring them is what the ticket asks for. Minting a second
    // pair of names for the same two actions would split every recap query
    // between two spellings for no gain.
    WEEKLY_RECAP_OPENED: "weekly_recap_opened",
    WEEKLY_RECAP_SHARED: "weekly_recap_shared",
    REPORT_SUBMITTED: "report_submitted",
    // COMM-233. The Phase 2 surfaces.
    SEARCH_PERFORMED: "search_performed",
    PUSH_OPT_IN: "push_opt_in",
    COACH_CONGRATULATE_SENT: "coach_congratulate_sent",
    DIRECTORY_OPENED: "directory_opened",
    // COMM-300, Phase 3. The first tracked event that is not a community
    // action at all: it is a training session, derived from the member's own
    // private log reaching the server. Carries the calendar day and nothing
    // else - never the workout title, never the result.
    ATTENDANCE_RECORDED: "attendance_recorded",
    // COMM-307, Phase 3. The trained-with-you card in the feed top area was
    // shown with at least one classmate on it. A new name rather than a reuse
    // of leaderboard_viewed or event_viewed, which were the two candidates:
    // both of those are "a member looked at a named object" and both feed
    // existing metrics.md queries (leaderboard pull, event pull), so folding a
    // passive feed card into either would silently inflate a number that
    // already means something else. The card is also the only surface in the
    // app whose whole point is that it usually does not exist, which makes
    // "how often did it exist, and how many people were on it" a question no
    // other event can answer.
    CLASSMATES_CARD_VIEWED: "classmates_card_viewed",
  });
  const KNOWN = new Set(Object.values(EVENTS));

  // The subset of the above that counts a member as active for the week,
  // per the WCAM definition in docs/community/metrics.md. Kept as data so
  // a rollup query and this client cannot drift apart.
  //
  // COMM-233 reviewed every Phase 2 name against the definition rather than
  // letting a new event default into or out of the set:
  // - challenge_joined, challenge_completed and event_rsvp were already
  //   qualifying activity types under the spec 78 definition, and now have
  //   real producers. No change.
  // - coach_congratulate_sent counts, for the coach who sent it. The row's
  //   user_id is the actor, so the celebrated member is never made active
  //   by somebody else's action - the comment or post it writes reaches
  //   them through post_created / comment_created on their own behalf when
  //   they answer it.
  // - weekly_recap_shared counts, on the same reading as achievement_shared
  //   already in this list: a share is a post the member published.
  // - leaderboard_viewed, weekly_recap_opened, search_performed and
  //   directory_opened do not. Viewing is not the bar the definition sets
  //   (posting, commenting, reacting, joining, attending, or opening a
  //   community item somebody else made); a roster and a search box are
  //   navigation, not participation.
  // - push_opt_in does not. Changing a notification setting is account
  //   configuration, not community activity.
  //
  // COMM-300 adds attendance_recorded, and it counts. "Attending" is named
  // outright in the spec 78 definition this list implements, and training is
  // the strongest participation the club has: a member who showed up and
  // trained is active for that week whether or not they posted about it.
  // This is the one qualifying activity WCAM has been missing since Phase 0,
  // and the only one on this list that can be true for a member who never
  // opened the Community tab.
  //
  // COMM-307 adds classmates_card_viewed and it does NOT count, on exactly
  // the reasoning leaderboard_viewed already uses: viewing is not the bar the
  // definition sets. The card appearing is not something the member did - it
  // is something their training and somebody else's happened to make true -
  // and the training that produced it is already counted, once, as
  // attendance_recorded. Counting the card too would count one member's
  // session twice and would also make a member active for a week on the
  // strength of another member's session. A follow or a profile open from the
  // card counts, through member_followed and profile_opened, because those
  // are the member acting.
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
    EVENTS.WEEKLY_RECAP_SHARED,
    EVENTS.COACH_CONGRATULATE_SENT,
    EVENTS.ATTENDANCE_RECORDED,
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
  // here. WORKOUT_COMPLETED, PR_CREATED, MEMBER_JOINED and
  // ACHIEVEMENT_UNLOCKED are deliberately absent: completing a workout is
  // not sharing one, and unlocking an achievement is not sharing it, so
  // mapping them would inflate WCAM with actions that are not community
  // participation.
  //
  // COMM-300 maps ATTENDANCE_RECORDED, which was on that absent list until
  // Phase 3 for a different reason - it had no producer at all. It has one
  // now (flushOutbox() in cloud.js), and unlike WORKOUT_COMPLETED it is
  // already deduplicated to one emit per member per calendar day, which is
  // what makes it a genuinely one-to-one mapping rather than a per-set
  // firehose. It counts for WCAM; see ACTIVE_MEMBER_EVENTS above for why
  // that is not the same call as mapping WORKOUT_COMPLETED would be.
  const BUS_EVENT_MAP = Object.freeze({
    POST_CREATED: EVENTS.POST_CREATED,
    COMMENT_CREATED: EVENTS.COMMENT_CREATED,
    REACTION_CREATED: EVENTS.REACTION_ADDED,
    CHALLENGE_JOINED: EVENTS.CHALLENGE_JOINED,
    CHALLENGE_COMPLETED: EVENTS.CHALLENGE_COMPLETED,
    EVENT_REGISTERED: EVENTS.EVENT_RSVP,
    ATTENDANCE_RECORDED: EVENTS.ATTENDANCE_RECORDED,
  });

  // COMM-170. What each bridged bus payload contributes to the analytics
  // row, key by key. A bus payload is built for its consumers
  // (notifications needs the mention list, achievements needs the author),
  // not for this table, so it is projected rather than stored whole. Two
  // reasons: the props shape stays a stable, documented contract that a
  // producer cannot widen by accident, and member-authored text (a
  // mention's display name, a caption) never reaches analytics. Anything
  // not listed here is dropped, including a key a future producer adds.
  const BUS_PROP_KEYS = Object.freeze({
    POST_CREATED: ["post_id", "post_type", "visibility", "has_media"],
    COMMENT_CREATED: ["post_id", "comment_id", "parent_comment_id"],
    REACTION_CREATED: ["post_id", "reaction_type"],
    CHALLENGE_JOINED: ["challenge_id", "challenge_type"],
    CHALLENGE_COMPLETED: ["challenge_id", "challenge_type"],
    EVENT_REGISTERED: ["event_id", "rsvp_status"],
    // COMM-300. The calendar day only. The bus payload is already just
    // {occurred_on}, and the allow-list is what keeps it that way if a
    // later producer widens it: a workout title or a result string must
    // never reach this table off a training log entry.
    ATTENDANCE_RECORDED: ["occurred_on"],
  });
  // Counted, not carried: an array prop is stored as its length so the
  // signal survives without the contents. `mentions` is the live case.
  const BUS_COUNT_KEYS = Object.freeze({ COMMENT_CREATED: { mentions: "mention_count" } });

  // COMM-233. The same discipline for the hand-tracked Phase 2 events,
  // which have no bus payload to project: the props each one may carry,
  // by name. A key not listed here is dropped before the row is built, so
  // a call site cannot attach a challenge's rules text, a recap figure's
  // sentence, or what the member typed into the search box - the three
  // free-text leaks this ticket set out to make impossible rather than
  // merely avoided by hand at each call site.
  //
  // Only the Phase 2 names have entries. The Phase 1 events keep passing
  // their props through untouched: their call sites are already pinned by
  // test/community-analytics-surfaces.test.mjs, and retro-fitting an
  // allow-list onto them would be a silent behaviour change on events that
  // are already in the table, which is exactly what SCHEMA_VERSION exists
  // to make visible. An event with no entry is not "unprotected", it is
  // "not narrowed here".
  const HAND_PROP_KEYS = Object.freeze({
    [EVENTS.CHALLENGE_VIEWED]: ["challenge_id", "challenge_key", "source"],
    [EVENTS.EVENT_VIEWED]: ["event_id", "source"],
    [EVENTS.LEADERBOARD_VIEWED]: ["board", "rows", "source"],
    [EVENTS.WEEKLY_RECAP_OPENED]: ["source"],
    [EVENTS.WEEKLY_RECAP_SHARED]: ["figure", "post_id"],
    [EVENTS.SEARCH_PERFORMED]: ["source", "query_length", "member_count", "event_count", "challenge_count"],
    [EVENTS.PUSH_OPT_IN]: ["source", "pref_type"],
    [EVENTS.COACH_CONGRATULATE_SENT]: ["kind", "via"],
    [EVENTS.DIRECTORY_OPENED]: ["source"],
    // COMM-307. A count and a surface. Never a user_id, never a handle: the
    // card's whole content is other members' identities, and a props
    // allow-list is the thing that keeps them from riding along into a table
    // whose read grant is community.analytics.view.
    [EVENTS.CLASSMATES_CARD_VIEWED]: ["rows", "source"],
  });

  function projectHandProps(eventName, props) {
    const keys = HAND_PROP_KEYS[eventName];
    if (!keys) return props;
    const body = (props && typeof props === "object" && !Array.isArray(props)) ? props : {};
    const out = {};
    for (const key of keys) if (body[key] !== undefined) out[key] = body[key];
    return out;
  }

  function projectBusPayload(productEvent, payload) {
    const body = (payload && typeof payload === "object" && !Array.isArray(payload)) ? payload : {};
    const out = {};
    for (const key of BUS_PROP_KEYS[productEvent] || []) {
      if (body[key] !== undefined && body[key] !== null) out[key] = body[key];
    }
    const counts = BUS_COUNT_KEYS[productEvent];
    for (const key of Object.keys(counts || {})) {
      if (Array.isArray(body[key])) out[counts[key]] = body[key].length;
    }
    return out;
  }

  let getClient = () => null;
  let getUserId = () => null;
  let busUnsubscribes = [];
  // The dev switch. When on, a tracked event is logged to the console and
  // nothing is written, so a developer can watch the stream on a real
  // device without polluting the table. Flipping the global at runtime
  // wins over whatever configure() was given, which is what makes it
  // usable from a console on a device that is already running.
  let debugMode = false;
  function isDebug() {
    if (typeof window.HAIMUNIA_ANALYTICS_DEBUG === "boolean") return window.HAIMUNIA_ANALYTICS_DEBUG;
    return debugMode;
  }

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
      const fitted = fitProps(projectHandProps(eventName, props));
      let userId = null;
      try { userId = getUserId() || null; } catch (err) { userId = null; }

      // The dev switch is checked before the client, so it works on an
      // unconfigured helper too - watching the stream is exactly what a
      // developer wants before the session is ready.
      if (isDebug()) {
        console.log("[analytics] " + eventName, { props: fitted.props, user_id: userId, schema_version: SCHEMA_VERSION });
        return Promise.resolve(true);
      }
      const client = getClient();
      if (!client || typeof client.from !== "function") return Promise.resolve(false);

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
      busUnsubscribes.push(bus.on(productEvent, (payload) => analyticsTrack(analyticsName, projectBusPayload(productEvent, payload))));
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
  // bridge, for a caller that wants to emit analytics by hand. Passing
  // debug:true turns on the console-only dev switch.
  function configure(opts) {
    const o = opts || {};
    if (o.client) getClient = () => o.client;
    else if (typeof o.getClient === "function") getClient = o.getClient;
    if (typeof o.getUserId === "function") getUserId = o.getUserId;
    else if ("userId" in o) getUserId = () => o.userId;
    if (typeof o.debug === "boolean") debugMode = o.debug;
    if (o.attachToBus !== false) attachToBus();
    return true;
  }

  function reset() {
    detachFromBus();
    getClient = () => null;
    getUserId = () => null;
    debugMode = false;
  }

  function isActiveMemberEvent(eventName) { return ACTIVE_MEMBER_EVENT_SET.has(eventName); }

  window.HaimuniaAnalytics = {
    EVENTS,
    ACTIVE_MEMBER_EVENTS,
    BUS_EVENT_MAP,
    BUS_PROP_KEYS,
    HAND_PROP_KEYS,
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
    isDebug,
    fitProps,
    projectBusPayload,
    projectHandProps,
  };
  window.analyticsTrack = analyticsTrack;
  window.ANALYTICS_EVENTS = EVENTS;
})();
