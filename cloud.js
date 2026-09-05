(function () {
  "use strict";
  // COMM-367/COMM-368. THE HTML escape for every template literal in this
  // file - ~370 call sites. Until COMM-367 this file carried its own
  // byte-identical local copy called esc(), so a hardening fix to the
  // escape had to be made twice; now there is exactly one definition, in
  // src/shared/safe-helpers.js, shared with app.js and (by design) with the
  // sibling Box Log client.
  //
  // Read off window, not as a bare identifier, for the same reason every
  // other platform module is (eventbus/analytics/realtime/image): this file
  // is its own IIFE and jsdom does not share a lexical environment across
  // separately-eval'd classic scripts the way a browser does. Reached
  // unguarded, and deliberately: safe-helpers.js is the first script
  // index.html loads and a REQUIRED service-worker precache asset, so it is
  // always there - and an escape function is the one dependency that must
  // fail loudly rather than degrade to a no-op fallback that would ship XSS.
  const esc = window.BoxLogSafe.esc;
  const cfg = window.HAIMUNIA_CONFIG || {};
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(cfg.supabaseUrl || "") && !!cfg.supabasePublishableKey;
  const client = configured && window.supabase ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  }) : null;
  // COMM-365. One state object, namespaced by feature domain.
  //
  // Until COMM-365 this was 139 flat sibling keys, grouped only by which
  // ticket added them and disambiguated only by hand-maintained name prefixes
  // (feedScope / challengeView / coachCelebrate / modQueueStatus...). Every new
  // feature cluster grew the same one namespace, so the prefix convention was
  // the only thing keeping two clusters from colliding on a name like `view`,
  // `items`, `loading` or `error`.
  //
  // Now each cluster owns a sub-object and the prefix is the namespace:
  // state.feed.scope, state.challenges.view, state.coach.celebrate,
  // state.admin.modQueueStatus. Two domains can both have `.loading` and
  // `.error` without either one having to invent a longer name.
  //
  // The ROOT of the object is deliberately NOT a domain. It holds only the
  // session/auth/config core that every domain reads and no domain owns:
  // `configured`/`client` (the Supabase wiring), `user`/`profile`/`redemption`
  // (who is signed in and what they are), `syncEnabled` and `featureFlags`
  // (localStorage-backed, read once at module init), the boot guard, the
  // cached permission set, and the caller's own avatar-upload status.
  // Namespacing those would only add a level of indirection to the most-read
  // keys in the file without separating anything.
  //
  // Sub-object identity matters: nothing ever replaces a whole namespace
  // (state.feed = {...} would silently drop keys the sign-out reset does not
  // list). Every write is to a leaf.
  const state = {
    // ---- session / auth / config core (see above: intentionally flat) ----
    configured, client, user: null, profile: null, redemption: null,
    syncEnabled: localStorage.getItem("haimunia-demo:cloudSyncEnabled") === "1",
    signupStarted: false,
    // COMM-331. Guards ensureCommunityDataLoaded()'s feed/streaks/
    // announcements/etc. cascade so it fires once, the first time the
    // Community tab actually renders, instead of on every cold boot. See
    // that function's own comment for exactly which loaders this covers
    // and, just as importantly, which ones it deliberately does NOT (kept
    // eager in refreshSession()/onAuthStateChange instead, because a
    // cross-tab consumer needs them regardless of whether Community was
    // ever opened).
    communityDataLoaded: false, communityDataLoading: false,
    // COMM-150. permissions is the caller's permission set from
    // my_permissions(), cached once per session and read through hasPerm();
    // the server policy behind each control is the real authority and this
    // only decides what to render. Session-scoped, not admin-scoped - a
    // member with no permissions at all still has this pair.
    permissions: [], permissionsLoaded: false,
    // COMM-226 built the coach-engage section flag-gated and hidden, default
    // off, with no producer. COMM-304 is that producer
    // (coach_detect_engagement_decline(), the scheduled job in 202608310008)
    // and this is the ticket that flips the flag: default ON now (`!== "0"`,
    // not `=== "1"`), so a test that wants the pre-304 hidden state has to opt
    // into it explicitly the same localStorage-backed way a test always has.
    // featureFlags.coachEngage is still read once, synchronously, at this
    // module-level literal - before cloud.js's own module-load, not after - so
    // a test flips it via bootCommunity's localStorage hook, never by mutating
    // state post-boot.
    // COMM-229. Same localStorage-backed pattern as coachEngage above, so a
    // test can flip it before boot the same way. Stays default off in
    // production until VAPID keys are provisioned server-side (per the
    // plan's operator checklist) - this ticket does not flip that default.
    featureFlags: { coachEngage: localStorage.getItem("haimunia-demo:coachEngageFlag") !== "0", notifPush: localStorage.getItem("haimunia-demo:notifPushFlag") === "1" },
    // COMM-318. { status: "idle"|"processing", error }, drives the avatar
    // control on the account profile form only.
    avatarUpload: { status: "idle", error: "" },

    // ---- ui: the community tab shell ----
    // tab is which community sub-tab is showing. message is the one status
    // line every surface writes through setMessage(). fieldErrors is keyed by
    // form+field (see field()). confirmDialog is the shared confirm sheet.
    ui: { tab: "feed", loading: false, message: "", fieldErrors: {}, confirmDialog: null },

    // ---- feed (COMM-110..115) ----
    // items holds feed_page() rows in the exact order the function returned
    // them and is never re-sorted here.
    feed: {
      items: [], scope: "for_you", cursor: null, loading: false, error: false,
      loadingMore: false, moreError: false, end: false, pagesLoaded: 0,
      sessionId: null, seen: {}, pending: [],
    },

    // ---- posts: composing, own-post controls, sharing (COMM-100..108) ----
    // openMenu is the post id whose "..." menu is open; savedIds is the
    // caller's own saved-post set; comparison/comparisonForPostId are the
    // inline compare strip, scoped to the one post that asked for it.
    posts: {
      composer: null, composerTrigger: null, openMenu: null, savedIds: {},
      captionEdit: null, visibilityEdit: null, prPrompt: null, openShare: {},
      comparison: [], comparisonForPostId: null,
    },

    // ---- engagement: comments, replies, reactions, mentions (COMM-120..125) ----
    engagement: {
      comments: {}, openComments: {}, commentDrafts: {}, commentErrors: {},
      commentSending: null, commentEdit: null, openReplies: {}, replyTo: {},
      reactions: {}, reactionError: null, mentionPicker: null,
    },

    // ---- members: search results, directory, follow/block, profiles ----
    members: {
      // COMM-228. `people` is community_search()'s members group and keeps
      // its exact row shape - it is what the follow/block/profile controls
      // read. `search`/`results` are the older standalone member lookup.
      people: [], search: "", results: [],
      // COMM-124 / COMM-160. One batched, cached user-id -> server role map,
      // shared by the comment coach emphasis and the coach badge on every
      // other surface a member is shown.
      roles: {},
      blockedIds: [], blocksLoaded: false, profileView: null,
      // COMM-231 members directory. items is the paginated roster loaded so
      // far (display_name order, cursor = the last row's own display_name,
      // page size DIRECTORY_PAGE_SIZE). query is what the member typed, kept
      // verbatim the same way search.query is. searchResults is
      // community_search's members group once the query reaches
      // SEARCH_MIN_CHARS, or null when the box is empty/under threshold (in
      // which case the visible rows are a client-side filter over items).
      directory: { items: [], loading: false, loadingMore: false, loaded: false, error: false, end: false, cursor: null, query: "", searchResults: null, searchLoading: false },
      // COMM-232. people_suggestions() output, rendered in the order returned
      // (the function already ranks by strongest signal). busy holds the ids
      // of in-flight follows. An error leaves the strip omitted entirely, so
      // there is deliberately no retry affordance keyed off `error` here.
      suggestions: { items: [], loading: false, loaded: false, error: false, busy: {} },
      // COMM-307. attendance_classmates_today() output - the members other than
      // the caller who logged a session today, in the order the function
      // returned them (most recently recorded first; it is a total order and the
      // client never re-sorts it). There is deliberately no `busy` map beside
      // this one, unlike suggestions: a classmate row is not a suggestion
      // card that disappears when followed, so the Follow control is the same
      // plain `follow` action the directory and the following lists use.
      //
      // `error` and "loaded with zero items" both mean exactly one thing to the
      // renderer - no card - so nothing downstream ever has to tell them apart.
      // Neither does the server: an empty set is what a member gets when they
      // did not train today, when they trained alone, and when their own
      // show_attendance is off, and that indistinguishability is the function's
      // own privacy answer (202608310005), not a gap here.
      classmatesToday: { items: [], loading: false, loaded: false, error: false },
    },

    // ---- club: the box itself and its club-wide surfaces ----
    // `row` is the caller's own club record. features/featuresLoaded is the
    // club_features module map; moduleBusy (COMM-321) is which module_key (if
    // any) has an in-flight toggle write.
    club: {
      row: null, features: {}, featuresLoaded: false, moduleBusy: null,
      announcements: [], announcementSaving: false, streaks: [],
      inactiveMembers: [], newMembers: [],
      weeklyChallenge: null, weeklyLeaderboard: [],
    },

    // ---- leaderboard (COMM-210/211/212) ----
    // The club-wide consistency board on the Boards sub-tab: rows are
    // feed_leaderboard() output in the exact order the function returned them
    // and are never re-sorted here (the rank column is the server's, not an
    // array index). scope is 'club' or 'friends' and is the only thing a scope
    // switch changes - it re-fetches, it does not reload the tab. The challenge
    // progress board lives on state.challenges.view.board instead, because it
    // is scoped to whichever challenge detail is open.
    //
    // COMM-212. hideMine is client-only, per-device, never a query parameter
    // and never a privacy setting: the server always returns the caller's own
    // row, and this only stops the client from drawing it. The real,
    // server-enforced opt-out is the in_leaderboards toggle in the Privacy
    // panel (COMM-018). Stored the same localStorage-backed way as
    // syncEnabled/coachEngage are, read once at module init, defaulting to
    // showing the row.
    leaderboard: {
      scope: "club", rows: [], loading: false, loaded: false, error: false,
      hideMine: localStorage.getItem("haimunia-demo:hideMyLeaderboardResult") === "1",
    },

    // ---- admin: moderation queue, reports, pins, audit log (COMM-150..156) ----
    // modQueue holds mod_queue() rows. pins holds pin rows for the club
    // strip. auditLog holds admin_actions_page() rows. The permission set
    // these controls are checked against lives at the root, not here - see
    // `permissions` above.
    admin: {
      reports: [],
      modQueue: [], modQueueStatus: "open", modQueueLoading: false, modQueueError: false, modQueueLoaded: false,
      modAction: null, modContext: null, reportSheet: null,
      pins: [], pinsLoaded: false, pinError: "",
      // One-time password-reset reveal (2026-09-05), same shape as
      // invites.created/inviteCodes.created above: { userId, tempPassword }
      // shown once, cleared by close-password-reset-result.
      passwordResetResult: null,
      auditLog: [], auditCursor: null, auditLoading: false, auditError: false, auditLoaded: false, auditEnd: false, auditFilters: {},

      // ---- COMM-376. Invite and code management ---------------------
      // invites is the per-person panel: items is admin_invite_list()'s
      // current page (cursor-paginated on created_at desc, the same
      // loading/loadingMore/loaded/error/end shape the audit log above
      // already uses), status is the active filter chip, created is the
      // one-time { id, code, role, label, created_at, expires_at, status }
      // reveal admin_invite_create() returned (the raw code is never
      // retrievable again after this - see contracts.md), and revoking is
      // the id of an invite whose admin_invite_revoke() call is in flight.
      invites: { items: [], status: "all", cursor: null, loading: false, loadingMore: false, loaded: false, error: false, end: false, created: null, revoking: null },
      // inviteCodes is the shared-code panel: items is admin_invite_code_list()'s
      // full (unpaginated - a club has a handful) list, created is the same
      // kind of one-time reveal for a freshly minted shared code, busy is the
      // id of a code whose admin_invite_code_set_active() call is in flight.
      inviteCodes: { items: [], loading: false, loaded: false, error: false, created: null, busy: null },

      // ---- COMM-377. Member roster ------------------------------------
      // items is admin_member_roster()'s accumulated pages, newest-joined
      // first. cursor is the last row's own redeemed_at - see loadRoster()'s
      // own comment for why a null-redeemed_at row (no invite_redemptions
      // row at all) ends pagination there rather than resending a null
      // cursor, a real gap between what this RPC returns and what its own
      // sort key needs (documented in docs/community/backlog.md's COMM-377
      // paragraph).
      roster: { items: [], cursor: null, loading: false, loadingMore: false, loaded: false, error: false, end: false },
    },

    // ---- analytics: the admin dashboards (COMM-310..313) ----
    analytics: {
      // COMM-310 admin community analytics dashboard, client half. THE
      // FOUNDATIONAL SHELL later Phase 3 admin tickets extend - COMM-311
      // (member segments), COMM-312 (health scores) and COMM-313 (retention
      // cohorts) each say "reusing COMM-310's dashboard shell" in their own
      // tickets. mode is "week" or "month", the two cadences metrics.md's own
      // 18 metric definitions are written in ("per week", "in a week"); start/
      // end are the resolved ISO dates for whichever period is currently
      // anchored, both inclusive - matching analytics_dashboard()'s own
      // p_period_start/p_period_end contract exactly, so they can be sent
      // straight back as RPC args with no reshaping. data is the raw jsonb
      // analytics_dashboard() returned, rendered as-is and never reshaped
      // here, the same "server is the one definition" posture COMM-309's
      // monthly recap figures already follow. A later ticket's own section
      // (a Segments card, a Health score card, a Retention card) reads
      // state.analytics.dashboard.start/end the same way and appends its render
      // call inside renderAdminAnalyticsDashboard() after the two
      // metrics.md-defined groups, rather than opening a second nav
      // destination or a second period selector.
      dashboard: { mode: "week", start: null, end: null, loading: false, loaded: false, error: false, errorText: "", data: null },
      // COMM-311 member engagement segmentation, client half. THE FIRST
      // ticket to actually extend COMM-310's shell, per that ticket's own
      // "reusing COMM-310's dashboard shell" instruction. Its own load fires
      // from inside loadAdminAnalyticsDashboard() itself (see that function),
      // never from a second period selector or a second lazy-load gate on the
      // account tab - see cloud.js's own comment there for why. data is the
      // RAW array member_segments() returned (one {user_id, display_name,
      // handle, segment} row per club member, already ordered by segment then
      // name server-side - never re-sorted here), grouped into the six named
      // buckets only at render time. asOf is the p_as_of this client actually
      // sent (COMM-310's own selected period end, capped at today - see
      // memberSegmentsAsOf()), shown so a reviewer can see what date a count
      // was computed for. expanded is a plain {segment: bool} map of which
      // segment cards are currently drilled into, reset never (a card a staff
      // member opened stays open across a period change, the same way
      // COMM-310's own period selector does not collapse anything else on
      // screen).
      segments: { loading: false, loaded: false, error: false, errorText: "", data: null, asOf: null, expanded: {} },
      // COMM-313 retention correlation views, client half. Gated STRICTLY on
      // real is_admin() - not the hasPerm(PERM.ANALYTICS_VIEW) || isAdmin()
      // pair every other section in this cluster (COMM-310/311) uses - per
      // that ticket's own "gated by real is_admin, matching COMM-312's
      // narrower bar" acceptance criterion. Because the gate is narrower than
      // COMM-310's shell gate, this section is rendered as its OWN top-level
      // ach-section (renderRetentionCorrelations(), wired in next to
      // renderAdminAnalyticsDashboard() in the account tab, not appended
      // inside it) - see that function's own comment for the full reasoning.
      // Three independent RPC results, all fetched together on one lazy load
      // (retention_cohorts/retention_onboarding_correlation/
      // retention_welcome_correlation take no shared period from COMM-310's
      // own selector - the two correlations do not even accept a parameter -
      // so there is no period selector to reuse here). cohorts/onboarding/
      // welcome are each the RAW array the matching RPC returned, never
      // reshaped here (grouped into series only at render time, the same
      // "server is the one definition" posture COMM-310/311 already follow).
      // onboardingStep is which of the five onboarding_progress columns the
      // onboarding overlay currently shows (one step at a time - all five at
      // once would be five pairs of curves on screen together). showOnboarding
      // / showWelcome are the two independent overlay toggles the ticket's own
      // "Populated" frontend state calls for.
      retention: {
        loading: false, loaded: false, error: false, errorText: "",
        cohorts: [], onboarding: [], welcome: [],
        onboardingStep: "welcomed_at", showOnboarding: false, showWelcome: false,
      },
      // COMM-312 community health score, client half. Same is_admin()-only bar
      // as COMM-313 (not the hasPerm(PERM.ANALYTICS_VIEW) || isAdmin() pair
      // COMM-310/311 use), for the same reason: community_health_history()
      // itself is gated on real is_admin() alone, per that function's own
      // migration comment. Its own top-level ach-section
      // (renderCommunityHealthScore(), wired in next to
      // renderRetentionCorrelations() in the account tab) and its own lazy
      // load (loadCommunityHealth()), not piggybacking on either COMM-310's or
      // COMM-313's load. weeks is the RAW array community_health_history()
      // returned - {week_start, score, components} per row, already ordered
      // OLDEST FIRST by the RPC itself, so it is drawn left-to-right with no
      // re-sort here (see renderCommunityHealthTrend()). There is no p_weeks
      // selector in state: COMMUNITY_HEALTH_WEEKS is a fixed constant passed on
      // every load, per the ticket's own "your call" on offering a selector -
      // this ticket's frontend states name no such control, and COMM-313's own
      // sibling section has none either.
      health: { loading: false, loaded: false, error: false, errorText: "", weeks: [] },
      // COMM-379 registration funnel analytics, client half. Same shape and
      // same precedent as COMM-311's segments just above: appended INSIDE
      // renderAdminAnalyticsDashboard()'s own populated branch, its own load
      // fired from inside loadAdminAnalyticsDashboard() once a.data is
      // truthy, reusing state.analytics.dashboard.start/end - no second nav
      // destination, no second period selector. Gated on the SAME pair as
      // the shell itself (community.analytics.view or real is_admin(), per
      // registration_funnel()'s own AUTH note - not is_staff(), so a coach
      // is refused here the same way COMM-310/311 already refuse one). data
      // is the raw jsonb registration_funnel() returned, rendered as-is.
      registrationFunnel: { loading: false, loaded: false, error: false, errorText: "", data: null },
    },

    // ---- challenges (COMM-201..207) ----
    // items holds every `challenges` row the caller may see (challenges_read
    // already scopes out a draft that is not theirs), sorted soonest end_at
    // first. participation is the caller's own challenge_participants row per
    // challenge_id, loaded alongside the list so a card can show Join/Joined
    // without a per-card round trip. aggregates is chal_progress() output
    // cached per challenge_id, fetched only for the types whose card needs an
    // aggregate figure (cooperative, team) - every other type's card reads
    // straight off participation. view is the open detail dialog (COMM-207);
    // form is the staff create/edit dialog (COMM-201).
    //
    // COMM-209. _rtId is the challenge id whose realtime channels are
    // currently open, so re-arming after a teardown is idempotent and
    // switching challenges closes the previous pair rather than stacking a
    // second one.
    //
    // In-memory only (COMM-205): _consistencyWeekLogged is which ISO week a
    // consistency challenge has already logged a "week hit" delta for on this
    // device this session, so a repeated WORKOUT_COMPLETED burst within the
    // same week cannot log twice. Never persisted - a real attendance source
    // replaces this client-side tally entirely (COMM-306, Phase 3).
    challenges: {
      items: [], loaded: false, loading: false, error: false,
      participation: {}, aggregates: {},
      view: null, form: null,
      _rtId: null,
      _consistencyWeekLogged: {}, _consistencySessionCounts: {},
    },

    // ---- events (COMM-213..217) ----
    // items holds every `events` row the caller may see (events_read already
    // scopes out a draft that is not theirs), sorted soonest start_at first.
    // byId is the same rows keyed by id, read both by the POST_EVENT card
    // upgrade and by the feed top-area card. attendees is every
    // event_attendees row the caller may see (event_attendees_read's own
    // show_in_attendee_lists filter already applies), keyed by event_id, which
    // is what both the going count and the attendee list read. view is the
    // open detail dialog; form is the staff create/edit dialog.
    events: {
      items: [], byId: {}, loaded: false, loading: false, error: false,
      attendees: {}, view: null, form: null,
    },

    // ---- search (COMM-228) ----
    // One community_search() call fills all three groups; the members group
    // lands in state.members.people, which keeps its own name and row shape,
    // so widening the search did not change that existing caller. query is
    // what the member typed, kept verbatim so a re-render can put it back in
    // the box; only the request is sanitized.
    search: { events: [], challenges: [], query: "", loading: false },

    // ---- achievements (COMM-130/134) ----
    achievements: { mine: [], unlock: null },

    // ---- notif (COMM-140..144) ----
    // COMM-229. Web push is device-level (one PushSubscription per
    // browser/device backs every type whose preference is "push" -
    // notifRoute still decides per type whether that channel is used).
    // pushSub is this device's existing push_subscriptions row once confirmed
    // unrevoked (null until checked, or genuinely none). pushChecked guards
    // the lazy load (window.afterRenderCommunity) to once per flag-on session,
    // the same way coach.engage's own .loaded guards its own lazy load.
    notif: {
      center: null, unread: 0, unreadLoaded: false,
      prefs: {}, prefsLoaded: false, prefSaving: {},
      _rtUid: null, pushSub: null, pushChecked: false,
    },

    // ---- onboarding (COMM-220..222, COMM-316) ----
    // progress is the caller's own onboarding_progress row (null = not loaded
    // yet; a real row always exists once loaded, seeded server-side at
    // MEMBER_JOINED). firstMonth is the lazily-computed first-month personal
    // summary (COMM-222's third step), fetched only once that step is due.
    //
    // COMM-316 (closing COMM-P07). attendance is the member's own
    // attendance_log row count, read directly under
    // attendance_log_self_select - the ONLY thing the two new onboarding steps
    // (first_class, third_class) need to decide eligibility. attendance_log is
    // unique on (user_id, occurred_on) (202608310001), so this plain row count
    // already IS the distinct-day count; no separate query. `loaded` false is
    // read by currentOnboardingStep() as "not due yet", never as "due" - see
    // that function for why an undetermined answer must never flash a step on
    // and then off.
    onboarding: {
      progress: null, firstMonth: null,
      attendance: { count: 0, loading: false, loaded: false, error: false },
      // COMM-373/378. stepContent is a plain {step: {step,title,body,
      // updated_at}} map read straight off onboarding_step_content, own-
      // audience select (RLS `using (true)`), loaded once for EVERY member
      // (not just staff) at boot alongside loadOnboardingProgress() -
      // renderOnboardingWelcomeStep() and its four siblings read title/body
      // from here instead of a literal string. stepContentLoaded/-Error
      // gate the loading/error frontend states of COMM-378's own editor;
      // every member-facing onboarding card falls back to today's exact
      // hardcoded copy while this is still in flight, so there is no flash
      // even before the first load resolves. editor is COMM-378's own
      // per-row form state: drafts (title/body, seeded from stepContent the
      // first time a row is touched and never re-seeded from a background
      // reload, so mid-edit typing survives a save landing on another row),
      // saving/saved are per-step busy/confirmation flags.
      stepContent: {}, stepContentLoaded: false, stepContentError: false,
      editor: { drafts: {}, saving: {}, saved: {} },
    },

    // ---- recaps (COMM-220..222, COMM-309) ----
    // view is the open weekly recap dialog (COMM-221); its own
    // load/prev/next calls read straight off weekly_recaps, own row only.
    //
    // COMM-309. monthly is the member-facing monthly club recap, an inline
    // Account-tab card rather than a dialog (unlike view above) - there is one
    // club-wide row to browse, not a per-member history to page through. .row
    // is the newest PUBLISHED month only: the query behind loadMonthlyRecap()
    // filters `published_at is not null` itself rather than leaning on RLS, so
    // a draft can never surface here even before the row reaches this client.
    // Empty (no row yet) and error both mean "render nothing" - COMM-309's own
    // frontend states ask for the surface to simply not show a monthly recap
    // entry before a month is published, and there is no separate error
    // affordance specified for the member side (unlike the staff preview,
    // which does have one - see state.coach.monthlyRecap).
    recaps: {
      view: null,
      monthly: { loading: false, loaded: false, error: false, row: null },
    },

    // ---- coach: the Coach Dashboard sub-tab (COMM-223..226, 309, 315) ----
    // Only ever added to the tab bar for isStaff(), see the render function -
    // Celebrate, Welcome, Engage, Member of the Week, Monthly recap preview.
    // Challenges re-surfaces renderChallengesListSection() unchanged, so it
    // has no state of its own here.
    coach: {
      // celebrate.items holds coach_celebrate_feed() rows exactly as
      // returned (already sorted by recency - never re-sorted here).
      // congratulated is a client-only dedupe set keyed by celebrateItemKey()
      // (kind+user_id+occurred_at, since a feed row has no id of its own),
      // so a second tap on an already-congratulated item is a no-op even
      // before the server rate limit would catch it. busy holds the key of
      // whichever item's Congratulate is in flight, if any.
      celebrate: { items: [], loading: false, loaded: false, error: false, congratulated: {}, busy: null },
      // welcome.members holds the last 30 days of joiners. contactedIds
      // is a user_id -> true set built from member_contact_log (staff can
      // read any row, COMM-224), so "contacted or not" never depends on the
      // caller having been the one who logged it. assignDrafts/contactDrafts
      // hold the free-text inputs for the assign-by-handle and mark-contacted
      // note fields, keyed by member id, read only at click time (no rerender
      // on input, so typing never loses focus).
      welcome: { members: [], loading: false, loaded: false, error: false, contactedIds: {}, assignDrafts: {}, contactDrafts: {}, busy: null },
      // COMM-226/304. Gated on featureFlags.coachEngage (see the root).
      // profiles is a batched user_id -> {display_name,handle,avatar_url} map
      // for the open flags in .items, read the same way welcome.contactedIds
      // is: a second, separate query rather than an embedded `profiles(...)`
      // select (see loadCoachEngageFlags for why). reachedOut is a client-only
      // dedupe set keyed by flag id, the same shape celebrate.congratulated
      // uses, so a second tap on an already-sent "reach out" - or a tap while
      // the first is still in flight - is a no-op. busy is { id, action } for
      // whichever flag row has a review/dismiss/reach-out in flight, if any -
      // all three actions on one row share it, so a row disables itself
      // entirely rather than only the one control that was tapped.
      engage: { items: [], loading: false, loaded: false, error: false, profiles: {}, reachedOut: {}, busy: null },
      // COMM-315. Coach Dashboard's own recognition section: Member of the
      // Week, one rotating category a week (consistency streak -> most PRs ->
      // challenge completion -> coach's pick, member_of_week_category() -
      // never re-derived client-side). envelope holds
      // member_of_week_candidates()'s single jsonb row exactly as returned -
      // {week_start, category, category_label, rotation_index, free_selection,
      // published, previous_week_user_id, candidates[]} - never reshaped here.
      // publishedProfile/previousProfile are two small, separate profiles
      // reads (the same batched-read shape engage.profiles and
      // welcome.contactedIds already use) for the two ids the envelope
      // names but does not itself carry a display name for: the published
      // member once published is non-null, and last week's member so the
      // free-selection form can name them in its grey-out note rather than a
      // coach discovering the rule by hitting it. pickHandle/pickReason are
      // the free-selection ("coach's pick") form's two inputs, read only at
      // publish time - no rerender on input, the same no-focus-loss shape
      // welcome's assignDrafts/contactDrafts already use; the live
      // character counter under the reason field is DOM-patched directly on
      // input instead, the same way composerSetBody's own counter is. busy
      // holds the user_id of whichever candidate publish is in flight, or the
      // literal "pick" for the free-selection form's own publish.
      memberOfWeek: { loading: false, loaded: false, error: false, envelope: null, publishedProfile: null, previousProfile: null, pickHandle: "", pickReason: "", busy: null, publishErr: "" },
      // COMM-309. Coach Dashboard's sixth section: the monthly club recap
      // staff preview. row is a single monthly_club_recaps row - the newest
      // month, draft or published, exactly as RLS hands it to a staff/
      // community.analytics.view reader (monthly_club_recaps_staff_select),
      // never reshaped. null means no month has ever been generated (there is
      // no scheduler yet - see the migration's own note - so this is a real,
      // expected state, not a load failure). busy holds the row id whose
      // publish is in flight, the same single-flight shape
      // memberOfWeek.busy uses for its own publish action.
      monthlyRecap: { loading: false, loaded: false, error: false, row: null, busy: null, publishErr: "" },
    },
  };
  const photoUrlCache = {};

  // COMM-141. The notification badge refreshes on a realtime own-row
  // event. That subscription was written before public.notifications was
  // in the supabase_realtime publication, so it was a working no-op until
  // 202608290007 landed; COMM-227 is the ticket that made it live, with no
  // change to the subscription itself.
  if (client && window.HaimuniaRealtime && typeof window.HaimuniaRealtime.configure === "function") {
    window.HaimuniaRealtime.configure({ client });
  }

  // --- COMM-170 / COMM-233 analytics -------------------------------------
  // The tracked event names (COMM-013) and the one call into the helper.
  // COMM-170 wired the Phase 1 surfaces, COMM-233 the Phase 2 ones.
  // Every call below is a measurement of something that already happened:
  // nothing is awaited, nothing sets a message, and nothing here can fail
  // in a way a member sees. Props carry ids, enums, counts and booleans
  // only - never a display name, a handle, a caption, a comment body or a
  // report note. The full event-to-surface table is in
  // docs/community/metrics.md.
  const A = window.ANALYTICS_EVENTS || {};
  function track(eventName, props) {
    if (!eventName) return;
    try { if (typeof window.analyticsTrack === "function") window.analyticsTrack(eventName, props); } catch (e) {}
  }
  // configure() has to run BEFORE the first track(): an unconfigured
  // analyticsTrack() is an inert no-op that silently drops the event. So
  // it sits at the head of the session-ready path, not the tail. getUserId
  // is a getter over state.user rather than a snapshot, which is why one
  // configure covers every later sign-out and sign-in without a second
  // call - and a second call would only replace the bus bridge anyway,
  // never stack it.
  let analyticsConfigured = false;
  function ensureAnalyticsConfigured() {
    if (analyticsConfigured || !client || !window.HaimuniaAnalytics) return false;
    analyticsConfigured = true;
    window.HaimuniaAnalytics.configure({ client, getUserId: () => (state.user ? state.user.id : null) });
    return true;
  }

  // Coach and admin are both "staff" for the fixed set of powers every
  // coach gets (announcements, the weekly challenge, the new/inactive
  // member views) — matches public.is_staff() server-side, which is what
  // actually enforces this; this is only for deciding what to show.
  // COMM-150. Named permission strings, checked against the caller's cached
  // permission set. No community staff control branches on a role literal or
  // on is_admin any more; the server policy behind each control is the real
  // authority and this only decides what to render. The set is loaded once
  // per session by loadPermissions() from my_permissions(), dropped on
  // sign-out, and reloaded on the auth-state-change path so a role change
  // takes effect without a reload.
  const PERM = {
    POST_DELETE_ANY: "community.post.delete_any",
    COMMENT_MODERATE: "community.comment.moderate",
    CHALLENGE_CREATE: "community.challenge.create",
    EVENT_MANAGE: "community.event.manage",
    ANALYTICS_VIEW: "community.analytics.view",
    MEMBER_RESTRICT: "community.member.restrict",
    CONTENT_PIN: "community.content.pin",
    ANNOUNCEMENT_PUBLISH: "community.announcement.publish",
    CLUB_MANAGE_MODULES: "community.club.manage_modules",
    // Phase 4 (COMM-370/371/373). MEMBER_INVITE gates the per-person invite
    // half of COMM-376's screen and is held by coach and up (the server's
    // own admin_invite_create/list/revoke pair) - NOT the same tier as
    // MEMBER_RESTRICT, see contracts.md's own correction of that comparison.
    // INVITE_MANAGE_CODES gates the shared-code half, admin/owner only
    // (admin_invite_code_*). CONTENT_MANAGE_ONBOARDING gates COMM-378's
    // editor, matching community.announcement.publish's seeded role list.
    MEMBER_INVITE: "community.member.invite",
    INVITE_MANAGE_CODES: "community.invite.manage_codes",
    CONTENT_MANAGE_ONBOARDING: "community.content.manage_onboarding",
  };
  // COMM-321 Club Modules. The six toggles the current app structure
  // actually exposes as independently gateable surfaces (matching the
  // schema's own seeded module_key set, 202609010012) - declared here,
  // ahead of both toggleClubFeature() and renderClubModulesPanel(), since
  // this is a top-level const evaluated at script load, not inside a
  // function body where declaration order wouldn't matter.
  const CLUB_MODULE_TOGGLES = [
    { key: "announcements", label: "הודעות מועדון" },
    { key: "events", label: "אירועים" },
    { key: "challenges", label: "אתגרים" },
    { key: "achievements", label: "הישגים ועיטורים" },
    { key: "feed", label: "פיד (כולל תגובות ותגובות חיזוק)" },
    { key: "leaderboards", label: "טבלאות מובילים" },
  ];
  const CLUB_MODULE_KEYS = CLUB_MODULE_TOGGLES.map((m) => m.key);
  function hasPerm(code) { return !!state.permissions && state.permissions.indexOf(code) >= 0; }
  async function loadPermissions() {
    if (!state.user) { state.permissions = []; state.permissionsLoaded = false; return; }
    const { data, error } = await client.rpc("my_permissions");
    state.permissions = error ? [] : (data || []);
    state.permissionsLoaded = !error;
  }
  // COMM-321 Club Modules. club_features has select open to authenticated
  // (no RLS role gate) - every member, not just staff, needs to know which
  // modules are on, same as permissions itself.
  async function loadClubFeatures() {
    if (!state.user) { state.club.features = {}; state.club.featuresLoaded = false; return; }
    const { data, error } = await client.from("club_features").select("module_key,enabled,config");
    if (error) { state.club.features = {}; state.club.featuresLoaded = false; return; }
    const next = {};
    for (const row of (data || [])) next[row.module_key] = { enabled: row.enabled, config: row.config || {} };
    state.club.features = next;
    state.club.featuresLoaded = true;
  }
  // Defaults to true while not yet loaded and for any key with no row at
  // all - deliberately not mirroring notifPrefsLoaded's skeleton-row
  // pattern: this gates whether content renders at all across many call
  // sites, not one section's own loading state, and RLS (club_feature_enabled
  // in every extended policy) is the real backstop regardless of what
  // renders here during the brief pre-load window. Must never be reached
  // before isCommunitySignedIn() gates rendering, same as hasPerm().
  function isModuleEnabled(key, subKey) {
    if (!state.club.featuresLoaded) return true;
    const row = state.club.features[key];
    if (!row) return true;
    if (!row.enabled) return false;
    if (subKey && row.config && Object.prototype.hasOwnProperty.call(row.config, subKey)) return !!row.config[subKey];
    return true;
  }
  // A thin convenience over the role model: coach rank or above, mirroring
  // the server's public.is_staff(). Kept for the fixed coach powers
  // (announcements, the weekly challenge, the new/inactive member views)
  // whose policies bind to is_staff() rather than a named permission; the
  // server is the authority, this only decides what to show. head_coach
  // reads as staff here the same way it does server-side.
  function isStaff() { return !!(state.profile && (state.profile.is_admin || (state.redemption && (state.redemption.role === "coach" || state.redemption.role === "head_coach")))); }
  // Real is_admin only. Kept for the handful of server functions that still
  // check the profiles.is_admin column inline rather than a permission:
  // review_report(), the posts_select_admin_review RLS bypass, and the
  // admin_* member-management RPCs. Every other gate uses hasPerm().
  function isAdmin() { return !!(state.profile && state.profile.is_admin); }
  function rerender() { if (typeof window.render === "function") window.render(); }
  function setMessage(message) { state.ui.message = message || ""; rerender(); }
  function todayIso() { return new Date().toISOString().slice(0, 10); }
  function setFieldErrors(formId, errors) {
    if (errors && Object.keys(errors).length) state.ui.fieldErrors[formId] = errors;
    else delete state.ui.fieldErrors[formId];
    rerender();
  }
  // Compact, deterministic per-identity color so the same person always
  // gets the same avatar color across the feed, comments and search.
  const AVATAR_PALETTE = ["var(--energy)", "var(--blue)", "var(--teal)", "var(--purple)", "var(--green)", "var(--brass)"];
  // COMM-318. avatarUrl is optional and always the third argument, so every
  // pre-existing 2-arg call keeps rendering the initials badge unchanged. A
  // real photo replaces the badge outright rather than sitting behind it -
  // there is nothing to blend, an avatar is either a photo or initials.
  function avatarHtml(name, size, avatarUrl) {
    const px = size || 36;
    if (avatarUrl) {
      return `<img alt="" aria-hidden="true" class="avatar-badge" src="${esc(avatarUrl)}" style="width:${px}px;height:${px}px;object-fit:cover;"/>`;
    }
    // Two conventions call this: some sites pass the bare handle
    // (`display_name || handle`), others the display string
    // (`display_name || "@" + handle`). For a member with no display name
    // the second gave every avatar the initial "@" and, because the colour
    // hash runs over the same label, a DIFFERENT colour from the first - so
    // one member showed up as a different badge in the directory than in
    // their own profile header. Dropping a leading "@" here makes both
    // conventions agree without touching eighteen call sites.
    const label = String(name || "?").trim().replace(/^@+/, "");
    const initial = label ? label[0].toUpperCase() : "?";
    let hash = 0;
    for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
    const color = AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
    return `<span aria-hidden="true" class="avatar-badge" style="width:${px}px;height:${px}px;font-size:${Math.round(px * 0.42)}px;background:${color};">${esc(initial)}</span>`;
  }
  // display_name is Hebrew and renders fine on its own; the "@handle"
  // fallback is a Latin run with a leading neutral "@" - in this app's RTL
  // paragraphs that "@" resolves to match the paragraph direction rather
  // than hugging the handle, so it paints as "handle@" instead of
  // "@handle". <bdi> isolates the run from the surrounding paragraph
  // direction the same way this problem is meant to be solved - no CSS
  // needed, and it degrades to plain text in a context that already
  // requires no HTML (there is none here).
  function nameHtml(displayName, handle) {
    return displayName ? esc(displayName) : `<bdi>@${esc(handle || "")}</bdi>`;
  }
  // Shared batch profile lookup - the shape loadCoachEngage(), loadCoachMemberOfWeek()
  // and loadFollowList() each independently hand-rolled. Consolidated after
  // finding real drift between the copies (a missing avatar_url column in
  // one, ad-hoc dedup in another): every caller now gets the same base
  // columns for free, and adding one going forward can't silently miss a
  // field the way a fourth hand-written copy could. extraCols appends
  // caller-specific columns (e.g. loadFollowList's allow_follows) - never
  // subtracts from the shared base.
  async function loadProfilesById(ids, extraCols) {
    const uniqueIds = Array.from(new Set((ids || []).filter(Boolean)));
    const map = {};
    if (!uniqueIds.length) return { map, error: null };
    const cols = "id,handle,display_name,avatar_url" + (extraCols ? "," + extraCols : "");
    const { data, error } = await client.from("profiles").select(cols).in("id", uniqueIds);
    if (error) return { map, error };
    for (const p of (data || [])) map[p.id] = p;
    return { map, error: null };
  }
  function relativeTime(iso) {
    if (!iso) return "";
    const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (diffMin < 1) return "עכשיו";
    if (diffMin < 60) return `לפני ${diffMin} דק׳`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `לפני ${diffHr} שע׳`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `לפני ${diffDay} ימים`;
    return new Date(iso).toLocaleDateString("he-IL");
  }

  // COMM-331. The feed/streaks/announcements/weekly-challenge/club-summary/
  // blocked-ids/achievements/notifications/pins/events/onboarding-progress/
  // staff/mod-queue cascade used to run unconditionally inside
  // refreshSession() (and again in onAuthStateChange below) on every cold
  // boot - ~16 parallel requests fired before a member who only ever opens
  // the training-log tabs had touched the Community tab once. It now runs
  // once per session, gated by the communityDataLoaded/communityDataLoading
  // pair, the first time the Community tab actually renders - see the
  // afterRenderCommunity() call below, the same once-per-session lazy
  // pattern already used there for the audit log and analytics dashboard.
  //
  // What this function deliberately does NOT cover, and why: loadProfile(),
  // loadRedemption(), loadChallenges() and loadClubFeatures() stay eager in
  // refreshSession()/onAuthStateChange instead of moving here, along with
  // pingActivity() and the syncCommunityMilestones() trigger that depend on
  // profile being loaded. A first attempt at this ticket deferred all of
  // them and broke real, cross-tab behavior (18 test failures) that a
  // static read of the call sites did not surface: window.isCommunitySignedIn()
  // - a global gate consumed by the PR-share prompt and achievement-claim
  // flows, both triggered from the core training-log tabs, not just the
  // Community tab - depends on state.profile. onPrCreatedForChallenges()
  // (also triggered from a core-tab save, via the PR_CREATED bus event)
  // reads state.challenges.items/state.challenges.participation to auto-log a
  // challenge delta, which is why loadChallenges() is eager here too - and
  // loadClubFeatures() rides along with it: isModuleEnabled() defaults a
  // module "on" until its row loads, so with challenges data present but
  // the feature gate still pending, a module the club actually turned off
  // would render for the gap between the two (caught by a real test, not
  // static analysis, and closed by loading both together rather than
  // leaving it to self-correct after a visible flash). Every other loader
  // below was traced against every top-level event-bus listener and every
  // window.*-exposed function app.js calls before being
  // judged safe to defer - see the reverted attempt's own writeup
  // (docs/community/tickets/COMM-331.md) for the full trace.
  async function ensureCommunityDataLoaded() {
    // Also gated on recovery_verified_at: renderCommunityApp() returns the
    // recovery gate's own content and nothing else while it's pending (see
    // that check's own comment, COMM-016), so there's no UI yet for any of
    // this to feed. Loading it anyway raced loadFeed()'s state.ui.message
    // reset (on success, loadFeed sets it to "") against verifyRecovery()'s
    // own failure message on the exact same field - whichever finished
    // last silently won, so a real verification failure could show no
    // error at all depending on timing. The gate's own success path
    // re-renders once verified, which re-enters afterRenderCommunity() and
    // triggers this for real at that point.
    if (!state.user || !state.profile || !state.profile.recovery_verified_at || state.communityDataLoaded || state.communityDataLoading) return;
    state.communityDataLoading = true;
    try {
      await Promise.all([loadPermissions(), loadFeed(), loadStreaks(), loadAnnouncements(), loadWeeklyChallenge(), loadClubSummary(), loadBlockedIds(), loadMyAchievements(), loadNotifUnread(), loadNotifPrefs(), loadPins(), loadEvents(), loadOnboardingProgress(), loadOnboardingStepContent()]);
      if (isStaff()) await Promise.all([loadInactiveMembers(), loadNewMembers()]);
      if (hasPerm(PERM.COMMENT_MODERATE) || isAdmin()) await loadModQueue();
      // COMM-141. Arm the own-row notification channel for this session.
      ensureNotifRealtime();
      // COMM-229. Consumes window.__pendingPushDeepLink once the session
      // and its data are actually ready - see communityHandlePushDeepLink
      // for why this exists (the cold-start "sw.js opened a fresh window"
      // path). Deferring this alongside the rest is safe: a push
      // notification's deep link always points into Community, so it
      // needs this same data loaded before it can resolve regardless.
      if (window.__pendingPushDeepLink) {
        const link = window.__pendingPushDeepLink;
        window.__pendingPushDeepLink = null;
        communityHandlePushDeepLink(link);
      }
    } finally {
      state.communityDataLoaded = true;
      state.communityDataLoading = false;
    }
    rerender();
  }

  async function refreshSession() {
    if (!client) return;
    const { data } = await client.auth.getSession();
    state.user = data.session ? data.session.user : null;
    if (state.user) {
      enableSyncIfAllowed();
      // COMM-170. First thing in the session-ready path, so every track()
      // below it writes instead of dropping.
      ensureAnalyticsConfigured();
      await loadRedemption();
      // loadProfile() and loadChallenges() stay eager - see
      // ensureCommunityDataLoaded()'s own comment for exactly why (both
      // gate cross-tab flows triggered from the core training-log tabs,
      // not just from Community). loadClubFeatures() rides along with
      // loadChallenges() rather than living in the deferred batch: with
      // challenges data present but the club-feature gate not yet
      // resolved, a module the club has turned off would render (its
      // resolver defaults "on" until a row loads) for the brief window
      // before the deferred batch finishes - loading both together closes
      // that gap instead of leaving it to self-correct after a flash.
      await Promise.all([loadProfile(), loadChallenges(), loadClubFeatures()]);
      // Push pending local edits before pulling the remote copy - without
      // this, reopening the app with an unflushed outbox (e.g. a set
      // logged offline seconds ago) pulls the still-stale server record
      // and silently overwrites the just-made local edit in IndexedDB.
      // The outbox row survives and re-pushes later, but the UI regresses
      // in the meantime. onAuthStateChange already flushes before
      // pulling; this is the far more common path (reopening an existing
      // session) and was missing it.
      await flushOutbox();
      await pullPrivateRecords();
      await pingActivity();
      // COMM-130. Claim any non-attendance milestone this device already
      // crossed before the member joined the community.
      if (typeof window.syncCommunityMilestones === "function") window.syncCommunityMilestones();
      // If the Community tab happens to be the active one on this boot
      // (e.g. a manifest shortcut, a deep link, or the last-active tab),
      // render() calling afterRenderCommunity() below already triggers
      // ensureCommunityDataLoaded() - nothing further to do here.
    }
    rerender();
  }
  // recovery_verified_at drives the COMM-016 gate; the privacy columns
  // (COMM-018) drive the Account > Privacy panel and are read straight off
  // state.profile, so they have to be selected here too.
  const PROFILE_COLUMNS = "id,handle,display_name,bio,avatar_url,is_admin,recovery_verified_at,visible_to_club,show_workout_results,show_prs,show_achievements,show_attendance,show_upcoming_booking,show_in_attendee_lists,in_leaderboards,allow_follows,allow_mentions,allow_messages";
  async function loadProfile() {
    if (!state.user) return;
    const { data } = await client.from("profiles").select(PROFILE_COLUMNS).eq("id", state.user.id).maybeSingle();
    state.profile = data || null;
  }
  // A profile can only be created once a valid box invite code has been
  // redeemed (enforced server-side by profiles_insert_self's RLS check,
  // not just here) — this just drives which form the Community tab shows.
  async function loadRedemption() {
    if (!state.user) return;
    const { data } = await client.from("invite_redemptions").select("invite_id,role,redeemed_at").eq("user_id", state.user.id).maybeSingle();
    state.redemption = data || null;
  }
  // COMM-222. Own-row select; seed_onboarding_progress (202608290011) seeds
  // exactly one row per member at MEMBER_JOINED, so null here means "not
  // loaded yet" or a real fetch error, never "no row for this member."
  async function loadOnboardingProgress() {
    if (!state.user) return;
    const { data, error } = await client.from("onboarding_progress").select("*").eq("user_id", state.user.id).maybeSingle();
    state.onboarding.progress = error ? null : (data || null);
  }
  // COMM-373/378. All five rows, open to every signed-in member under
  // onboarding_step_content's own `using (true)` read policy - not staff-
  // gated, since every member's own onboarding cards read from here, not
  // only COMM-378's editor. Loaded once at boot alongside
  // loadOnboardingProgress(); the editor's own retry re-runs this same
  // function rather than a second loader.
  async function loadOnboardingStepContent() {
    if (!state.user) return;
    const { data, error } = await client.from("onboarding_step_content").select("step,title,body,updated_at");
    if (error) { state.onboarding.stepContentError = true; return; }
    const map = {};
    for (const row of (data || [])) map[row.step] = row;
    state.onboarding.stepContent = map;
    state.onboarding.stepContentLoaded = true;
    state.onboarding.stepContentError = false;
  }
  // COMM-017. A stable per-client identifier the invite throttle keys on
  // in ADDITION to the Auth uid, so discarding an anonymous session and
  // signing in again does not reset the five-attempts-per-15-minutes
  // limit: the uid changes on every anonymous sign-in, this key does not,
  // because it lives in localStorage and a sign-out never touches it.
  // It is not a security boundary, only a cost floor against the trivial
  // "clear the session and retry" guessing loop - a determined attacker
  // rotates it, and the high-entropy codes remain the real protection.
  // A full browser site-data clear (NOT the in-app "delete all data",
  // which leaves this key alone) does reset it, which is acceptable:
  // redemption then restarts from a fresh anonymous session anyway.
  const ACTOR_KEY_STORAGE = "haimunia-demo:communityActorKey";
  function communityActorKey() {
    let key = null;
    try { key = localStorage.getItem(ACTOR_KEY_STORAGE); } catch (e) { key = null; }
    if (!key) {
      const rnd = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID() + window.crypto.randomUUID()
        : String(Date.now()) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      key = rnd.replace(/-/g, "").slice(0, 128);
      try { localStorage.setItem(ACTOR_KEY_STORAGE, key); } catch (e) {}
    }
    return key.slice(0, 128);
  }
  async function redeemCode(form) {
    if (!state.user) return;
    const code = String(form.elements.code.value || "").trim();
    if (!code) return setFieldErrors("communityInviteCode", { code: "יש להזין קוד הזמנה" });
    // Two-arg overload: passes the actor key so the throttle holds across
    // session replacement. The server returns the same generic answer and
    // applies the same increment whether or not this actor has been seen
    // before, so the message here must not hint at a remaining count.
    const { data, error } = await client.rpc("redeem_invite_code", { p_code: code, p_actor_key: communityActorKey() });
    if (error || data === "rate_limited") return setFieldErrors("communityInviteCode", { code: data === "rate_limited" ? "יותר מדי ניסיונות. יש לנסות שוב מאוחר יותר" : "קוד ההזמנה שגוי או לא פעיל" });
    // COMM-380: the RPC now grants a per-person invite's own role, so a
    // successful redemption can return "coach" as well as "member"
    // (COMM-372). Checking for the literal "invalid" instead of the
    // literal "member" keeps this a generic success/failure branch, not
    // one hardcoded to the one role a shared code could ever grant.
    if (data === "invalid") return setFieldErrors("communityInviteCode", { code: "קוד ההזמנה שגוי, פג תוקף או נוצל" });
    setFieldErrors("communityInviteCode", {});
    await loadRedemption();
    // COMM-222. This is the module's MEMBER_JOINED moment (mirrors the
    // server side: seed_onboarding_progress fires off the same
    // invite_redemptions insert). Emitting it lets the onboarding sequence
    // pick up the fresh row in this same tab instead of waiting for a
    // reload before the welcome step can render.
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.MEMBER_JOINED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.MEMBER_JOINED, { user_id: state.user.id }); } catch (e) {}
    }
    setMessage("קוד אושר, אפשר להשלים פרופיל");
    rerender();
  }
  // One row per user per day they had the app open — the raw dates stay
  // private (activity_pings RLS is self-only); this only ever records
  // today, so a missed day just isn't there rather than being backfilled.
  async function pingActivity() {
    // state.profile, not just state.user: "start-signup" opens an ANONYMOUS
    // session before the member has redeemed a code, and activity_pings'
    // user_id references profiles - so pinging on that session raised a 409
    // foreign-key violation on every fresh signup. Both callers load the
    // profile before reaching here, so a real member is never skipped. Same
    // condition window.isCommunitySignedIn() already uses for "is actually
    // a member yet".
    if (!client || !state.user || !state.profile) return;
    // Found in the post-Phase-3 front-end review, against a real Supabase
    // client rather than the mock: .catch() chained directly on a
    // PostgrestFilterBuilder throws "is not a function" synchronously,
    // BEFORE the builder's own .then() ever fires the request - so this
    // upsert has never actually reached the server. Invisible to every
    // Node test, because mockSupabase.mjs's chain() object happens to
    // implement .catch() itself, which the real client's builder does not.
    // Real impact: activity_pings feeds coach_inactive_members(),
    // coach_new_members() and admin_search_members()'s last-activity
    // column (202608270005/011) - all three have likely been reading an
    // empty table since this shipped. try/catch, matching this file's own
    // established "swallow a non-critical side effect" shape one line
    // above (window.HaimuniaEvents.emit).
    try { await client.from("activity_pings").upsert({ user_id: state.user.id, activity_date: todayIso() }, { onConflict: "user_id,activity_date", ignoreDuplicates: true }); } catch (e) {}
  }
  async function loadStreaks() {
    if (!state.user) return;
    const { data, error } = await client.from("community_streaks").select("user_id,handle,display_name,current_streak,last_activity_on").order("current_streak", { ascending: false }).limit(50);
    state.club.streaks = error ? [] : (data || []).filter((r) => r.current_streak > 0);
  }

  // ---- COMM-222 onboarding sequence -----------------------------------
  // COMM-316 (closing COMM-P07) added the two steps tied to the member's
  // first and third class, once attendance existed to tie them to.
  const ONBOARDING_STEP_COLUMNS = { welcome: "welcomed_at", first_week: "first_week_shown_at", first_month: "first_month_shown_at", first_class: "first_class_shown_at", third_class: "third_class_shown_at" };
  // Which single step (if any) is due right now. THE ORDER, and why it is
  // safe:
  //
  //   welcome -> first_week -> first_month -> first_class -> third_class
  //
  // The first three are COMM-222, UNCHANGED - same columns, same elapsed-
  // time conditions, checked first and in the same order they always were.
  // That is what makes COMM-316's own acceptance criterion ("these two
  // steps do not block or reorder the three already-shipped steps") true
  // STRUCTURALLY rather than by convention: the two attendance checks below
  // only run once none of the three time-based steps is due, so a first or
  // third class landing early, late, or never cannot move welcome's Day-1
  // firing, first_week's 7-day firing or first_month's 30-day firing by so
  // much as a render.
  //
  // JUDGMENT CALL (the ticket names this as one, not fully specified):
  // first-class ranks below all three existing steps rather than between
  // welcome and first-week. The tempting alternative - an eager member who
  // logs a class on day one seeing "first class" before or instead of
  // "welcome" - was rejected because the single onboarding slot can only
  // show one card, and letting an attendance milestone occupy that slot
  // ahead of (or instead of) welcome/first_week would be exactly the
  // "reorder" effect the ticket's own criterion asks this file to avoid.
  // Appending the two new checks after the three, rather than interleaving
  // them, is the version where that claim can be verified by reading the
  // first three lines below and stopping - they are byte-for-byte what
  // COMM-222 shipped. first-class ranks above third-class for the obvious
  // reason: three classes cannot happen before one.
  //
  // Only one step shows at a time, the same COMM-222 shape: a later step
  // becoming due never hides an earlier one still undismissed, and
  // dismissing one lets whichever step is due next - by this same order -
  // show on the very next render.
  function currentOnboardingStep() {
    const row = state.onboarding.progress;
    const redeemedAtRaw = state.redemption && state.redemption.redeemed_at;
    if (!row || !redeemedAtRaw) return null;
    const redeemedAt = new Date(redeemedAtRaw).getTime();
    if (!Number.isFinite(redeemedAt)) return null;
    const DAY_MS = 86400000;
    const elapsed = Date.now() - redeemedAt;
    if (row.welcomed_at == null) return "welcome";
    if (row.first_week_shown_at == null && elapsed >= 7 * DAY_MS) return "first_week";
    if (row.first_month_shown_at == null && elapsed >= 30 * DAY_MS) return "first_month";
    // COMM-316. Eligibility here is attendance, not elapsed time - "do I
    // have at least one attendance_log row" / "...at least three distinct
    // occurred_on days" - read client-side under attendance_log_self_select
    // (202608310001) by loadOnboardingAttendance(), never a server column or
    // RPC (the schema migration's own comment: "the client asks the table
    // it already reads"). `!loaded` reads as "not due yet", the same as any
    // step whose data has not arrived - never as "due", which would risk a
    // step flashing on before its real eligibility is known and then off
    // once the real answer turns out to be "not yet".
    if (!state.onboarding.attendance.loaded) return null;
    if (row.first_class_shown_at == null && state.onboarding.attendance.count >= 1) return "first_class";
    if (row.third_class_shown_at == null && state.onboarding.attendance.count >= 3) return "third_class";
    return null;
  }
  // COMM-316. Own-row attendance count - the only input the two new steps'
  // eligibility needs. attendance_log is unique on (user_id, occurred_on)
  // (202608310001), so a plain row count already IS the distinct-day count;
  // there is no separate "distinct days" query to write. Lazy, and fetched
  // from the Feed sub-tab rather than the boot Promise.all, for the exact
  // reason renderClassmatesTodayCard's own loader documents for the same
  // table: the member's own attendance row for a class taken today is
  // written by the private_records trigger behind flushOutbox(), which runs
  // AFTER the boot batch, so asking during boot could ask before that row
  // exists and read a stale "not eligible yet" answer for an entire
  // session.
  async function loadOnboardingAttendance() {
    if (!client || !state.user) return;
    const s = state.onboarding.attendance;
    s.loading = true;
    rerender();
    const { data, error } = await client.from("attendance_log").select("occurred_on").eq("user_id", state.user.id);
    s.loading = false; s.loaded = true;
    if (error) { s.error = true; s.count = 0; return rerender(); }
    s.error = false;
    s.count = Array.isArray(data) ? data.length : 0;
    rerender();
  }
  // The write only ever happens from a Dismiss click inside the card that
  // is already on screen (COMM-222: "shown" means actually rendered, not
  // merely scheduled) - there is no eligibility-computation path that ever
  // calls this on its own. Fire-and-forget per contracts.md's note on this
  // table: the BEFORE UPDATE pin trigger makes a repeat or a retried
  // failed write harmless, so a failed write here surfaces no error - the
  // next full load re-reads the row, finds the stamp still null, and the
  // step simply becomes due again.
  async function dismissOnboardingStep(step) {
    const col = ONBOARDING_STEP_COLUMNS[step];
    if (!col || !state.onboarding.progress || !state.user || !client) return;
    state.onboarding.progress[col] = new Date().toISOString();
    rerender();
    // Same real bug pingActivity() had, found in the same front-end review
    // pass: .catch() chained directly on a PostgrestFilterBuilder throws
    // synchronously against the real client (its builder has no .catch
    // method, only .then), so this write has never actually reached the
    // server. Real impact here is worse than a missing ping: the optimistic
    // local update above always makes the dismiss LOOK like it worked this
    // session, but the server-side stamp never lands - so on the member's
    // very next load, onboarding_progress reads the column back as still
    // null and the exact same step shows again. Fire-and-forget is the
    // right shape here (the optimistic update above already rerendered;
    // this must not block on the network) - Promise.resolve() wraps the
    // builder in a real Promise instance so .catch() is a genuine method
    // rather than being called on the bare thenable, the same fix
    // feed_record_impressions/feed_record_interaction already use a few
    // hundred lines below.
    Promise.resolve(client.from("onboarding_progress").update({ [col]: new Date().toISOString() }).eq("user_id", state.user.id)).catch(() => {});
  }
  // Lazy, same pattern the audit log already uses (afterRenderCommunity):
  // fetched once, only when the step it feeds is actually due, not on
  // every session. Built from the same aggregation weekly_recaps uses
  // (COMM-220) over the member's own first month - not the Phase 3
  // club-wide monthly recap.
  async function loadOnboardingFirstMonthSummary() {
    if (!state.user || !client || !state.redemption || !state.redemption.redeemed_at) return;
    state.onboarding.firstMonth = { loading: true, error: false, sessions: 0, prs: 0, achievements: 0 };
    const redeemedAt = new Date(state.redemption.redeemed_at);
    const monthEnd = new Date(redeemedAt.getTime() + 30 * 86400000);
    const { data, error } = await client.from("weekly_recaps").select("sessions_completed,prs,achievements")
      .eq("user_id", state.user.id)
      .gte("week_start", redeemedAt.toISOString().slice(0, 10))
      .lte("week_start", monthEnd.toISOString().slice(0, 10));
    if (!state.onboarding.firstMonth) return; // dismissed/torn down mid-flight
    if (error) { state.onboarding.firstMonth = { loading: false, error: true, sessions: 0, prs: 0, achievements: 0 }; return rerender(); }
    const totals = (data || []).reduce((acc, r) => {
      acc.sessions += Number(r.sessions_completed) || 0;
      acc.prs += Array.isArray(r.prs) ? r.prs.length : 0;
      acc.achievements += Array.isArray(r.achievements) ? r.achievements.length : 0;
      return acc;
    }, { sessions: 0, prs: 0, achievements: 0 });
    state.onboarding.firstMonth = { loading: false, error: false, ...totals };
    rerender();
  }
  function renderOnboardingCard(title, bodyHtml, step, extraActionHtml) {
    return `<div class="chart-card admin-card" style="margin-bottom:12px;" data-onboarding-step="${step}">
      <div style="font-weight:800;margin-bottom:6px;">${esc(title)}</div>
      <div style="font-size:13px;line-height:1.6;color:var(--steel);margin-bottom:10px;">${bodyHtml}</div>
      <div class="chip-row">${extraActionHtml || ""}<button class="chip-btn primary" data-community-action="onboarding-dismiss" data-step="${step}">הבנתי</button></div>
    </div>`;
  }
  // COMM-378. Every one of the five card renderers below now reads its
  // title/body from state.onboarding.stepContent (COMM-373's table) instead
  // of a literal string, falling back to today's exact hardcoded copy while
  // that table has not loaded yet - the two are byte-identical on first
  // deploy (COMM-373's own seed), so there is no flash either way. welcome/
  // first_class/third_class have no dynamic line at all: the table's body IS
  // the whole card, editable end to end. first_week/first_month are the two
  // COMM-373 seeded with an EMPTY body on purpose (their bodies are entirely
  // computed today) - this function prepends the table's body (once a staff
  // member fills one in) before that same computed sentence, never after,
  // per COMM-378's own "appended after the editable lead sentence" criterion
  // read from the other direction (the lead comes first, the computed line
  // follows it).
  function onboardingStepTitle(step, fallback) {
    const c = state.onboarding.stepContent[step];
    return (c && c.title) || fallback;
  }
  // Raw (unescaped) body text, or "" when the table has not loaded yet or
  // the row's own body is empty (first_week/first_month's own seed) - every
  // caller below decides for itself when and how to escape it, since the
  // static-body cards (welcome/first_class/third_class) need it escaped
  // alone while the computed-line cards (first_week/first_month) need it
  // escaped and then concatenated with ALREADY-RAW computed HTML.
  function onboardingStepBodyRaw(step) {
    const c = state.onboarding.stepContent[step];
    return (c && typeof c.body === "string") ? c.body : "";
  }
  function renderOnboardingWelcomeStep() {
    const bodyRaw = onboardingStepBodyRaw("welcome") || `כאן רואים מה קורה במועדון, ואפשר לשתף אימונים ושיאים ולהגיב לחברים אחרים. לחיצה על "כתיבת פוסט" למעלה פותחת את השיתוף הראשון שלכם.`;
    return renderOnboardingCard(onboardingStepTitle("welcome", "ברוכים הבאים לקהילה!"), esc(bodyRaw), "welcome");
  }
  function renderOnboardingFirstWeekStep() {
    // COMM-207's own list, sorted the same soonest-end-first order the
    // Boards tab already uses - just the first entry.
    const active = state.challenges.items.filter((c) => c.status === "active").slice().sort((a, b) => new Date(a.end_at) - new Date(b.end_at))[0];
    const computed = active
      ? `יש אתגר פעיל במועדון עכשיו: <strong>${esc(active.title)}</strong>.`
      : `אין כרגע אתגר פעיל במועדון, אבל שווה להציץ בלוח האתגרים מדי פעם.`;
    const leadRaw = onboardingStepBodyRaw("first_week");
    const lead = leadRaw ? esc(leadRaw) + " " : "";
    const openBtn = active ? `<button class="chip-btn" data-community-action="open-challenge" data-id="${esc(active.id)}" data-source="onboarding">פתיחת האתגר</button>` : "";
    return renderOnboardingCard(onboardingStepTitle("first_week", "השבוע הראשון שלכם מאחוריכם"), lead + computed, "first_week", openBtn);
  }
  function renderOnboardingFirstMonthStep() {
    const summary = state.onboarding.firstMonth;
    const computed = (!summary || summary.loading)
      ? `<span aria-hidden="true" style="display:inline-block;height:12px;width:70%;background:var(--border);border-radius:6px;"></span>`
      : summary.error
      ? `החודש הראשון שלכם הסתיים - לא הצלחנו לטעון את הסיכום כרגע.`
      : `החודש הראשון שלכם: ${summary.sessions} אימונים, ${summary.prs} שיאים ו-${summary.achievements} הישגים חדשים. כל הכבוד!`;
    const leadRaw = onboardingStepBodyRaw("first_month");
    const lead = leadRaw ? esc(leadRaw) + " " : "";
    return renderOnboardingCard(onboardingStepTitle("first_month", "החודש הראשון שלכם במועדון"), lead + computed, "first_month");
  }
  // COMM-316. Static copy, same shape as welcome above - no dependent data
  // to load beyond the attendance count that already decided the step is
  // due (currentOnboardingStep), so there is no loading/error variant here
  // the way first_month's summary needs one.
  function renderOnboardingFirstClassStep() {
    const bodyRaw = onboardingStepBodyRaw("first_class") || `האימון הראשון שלכם כבר נרשם במערכת. ממשיכים באותו הקצב?`;
    return renderOnboardingCard(onboardingStepTitle("first_class", "הגעתם לאימון הראשון!"), esc(bodyRaw), "first_class");
  }
  function renderOnboardingThirdClassStep() {
    const bodyRaw = onboardingStepBodyRaw("third_class") || `שלושה אימונים כבר מאחוריכם. ככה בונים הרגל אימונים.`;
    return renderOnboardingCard(onboardingStepTitle("third_class", "אימון שלישי — אתם כבר בקצב!"), esc(bodyRaw), "third_class");
  }
  function renderOnboardingStep() {
    const step = currentOnboardingStep();
    if (!state.onboarding.progress) {
      // A loading skeleton only while a redemption is actually known - a
      // pre-redemption visitor never had a row seeded, so there is nothing
      // pending to skeleton for.
      return state.redemption ? `<div class="chart-card" aria-busy="true" style="margin-bottom:12px;height:60px;background:var(--border);opacity:.35;"></div>` : "";
    }
    if (!step) return "";
    if (step === "welcome") return renderOnboardingWelcomeStep();
    if (step === "first_week") return renderOnboardingFirstWeekStep();
    if (step === "first_month") return renderOnboardingFirstMonthStep();
    if (step === "first_class") return renderOnboardingFirstClassStep();
    return renderOnboardingThirdClassStep();
  }
  // ---- COMM-378. Onboarding step content editor ------------------------
  // Admin-console content management (same cluster as pinned content and
  // the announcement/analytics admin surfaces), not a coach-tools member-
  // relationship action - see backlog.md's own placement note. Gated on
  // community.content.manage_onboarding or real is_admin(), matching
  // onboarding_step_content's own write policy exactly - a coach without
  // that permission never sees the entry point at all, per this ticket's
  // own criterion.
  const ONBOARDING_STEPS_ORDER = ["welcome", "first_week", "first_month", "first_class", "third_class"];
  const ONBOARDING_STEP_LABELS = {
    welcome: "ברוכים הבאים", first_week: "השבוע הראשון", first_month: "החודש הראשון",
    first_class: "אימון ראשון", third_class: "אימון שלישי",
  };
  // Seeded from the loaded row the first time a step is touched, and never
  // re-seeded from a background reload afterward - so a save landing on one
  // row (which triggers loadOnboardingStepContent() again) can never clobber
  // an in-progress, unsaved edit on a sibling row.
  function onboardingEditorDraft(step) {
    const drafts = state.onboarding.editor.drafts;
    if (!drafts[step]) {
      const c = state.onboarding.stepContent[step];
      drafts[step] = { title: (c && c.title) || "", body: (c && c.body) || "" };
    }
    return drafts[step];
  }
  async function saveOnboardingContent(step) {
    if (!state.user || !(hasPerm(PERM.CONTENT_MANAGE_ONBOARDING) || isAdmin())) return;
    const e = state.onboarding.editor;
    if (e.saving[step]) return;
    const draft = onboardingEditorDraft(step);
    const title = String(draft.title || "").trim().slice(0, 120);
    const body = String(draft.body || "").slice(0, 2000);
    const formId = "onboardingEdit_" + step;
    if (!title) { setFieldErrors(formId, { title: "יש למלא כותרת" }); return; }
    setFieldErrors(formId, {});
    e.saving[step] = true; e.saved[step] = false; rerender();
    const { error } = await client.from("onboarding_step_content").update({ title, body }).eq("step", step);
    e.saving[step] = false;
    if (error) { setFieldErrors(formId, { title: "השמירה נכשלה, נסו שוב." }); rerender(); return; }
    // contracts.md's own COMM-373 note: a refused UPDATE against this table
    // never raises - a failing RLS USING clause on UPDATE just matches zero
    // rows - so a client that only checks `error` cannot tell a real save
    // from a silently-dropped one. Reading the row back is the only honest
    // check; a mismatch means the write did not really land.
    await loadOnboardingStepContent();
    const saved = state.onboarding.stepContent[step];
    if (!saved || saved.title !== title || (saved.body || "") !== body) {
      setFieldErrors(formId, { title: "השמירה לא בוצעה - ייתכן שאין הרשאה מספקת." });
      rerender();
      return;
    }
    delete e.drafts[step]; // next read reflects the fresh server row
    e.saved[step] = true;
    rerender();
  }
  function renderOnboardingContentEditor() {
    if (!(hasPerm(PERM.CONTENT_MANAGE_ONBOARDING) || isAdmin())) return "";
    let body;
    if (!state.onboarding.stepContentLoaded && !state.onboarding.stepContentError) {
      const skRow = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:60%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
      body = `<div class="log-list" aria-busy="true" data-onboarding-editor-skeleton="1">${skRow.repeat(5)}</div>`;
    } else if (state.onboarding.stepContentError) {
      body = `<div class="empty">לא ניתן היה לטעון את תוכן ההיכרות.<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="onboarding-content-retry">ניסיון חוזר</button></div></div>`;
    } else {
      body = ONBOARDING_STEPS_ORDER.map((step) => {
        const draft = onboardingEditorDraft(step);
        const formId = "onboardingEdit_" + step;
        const saving = !!state.onboarding.editor.saving[step];
        const saved = !!state.onboarding.editor.saved[step];
        return `<div class="chart-card" style="margin-bottom:10px;" data-onboarding-editor-row="${step}">
          <div class="field-label" style="margin-bottom:6px;">${esc(ONBOARDING_STEP_LABELS[step] || step)}</div>
          ${field(formId, "title", "כותרת", `<input class="text-input" maxlength="120" data-onboarding-edit-title="${step}" value="${esc(draft.title)}"/>`)}
          ${field(formId, "body", "משפט פתיחה", `<textarea class="text-input" maxlength="2000" rows="3" data-onboarding-edit-body="${step}">${esc(draft.body)}</textarea>`)}
          <div class="chip-row" style="margin-top:6px;">
            <button class="chip-btn primary" data-community-action="onboarding-content-save" data-step="${step}"${saving ? " disabled" : ""}>${saving ? "שומר…" : "שמירה"}</button>
            ${saved ? `<span class="footer-note" role="status">נשמר</span>` : ""}
          </div>
        </div>`;
      }).join("");
    }
    return `<div class="ach-section" style="margin-top:18px;" data-onboarding-editor-section="1">${sectionHead("var(--teal)", "עריכת תוכן היכרות", true)}${body}</div>`;
  }
  // COMM-218. The three-tier client-facing control that replaces the plain
  // `important` boolean; `announcements.important` still exists server-side
  // as a trigger-maintained mirror (202608290010) but is never written or
  // read directly from here. Order matters: it drives the <select> option
  // order in the composer.
  const ANNOUNCEMENT_PRIORITY_OPTIONS = [
    { value: "normal", label: "רגילה" },
    { value: "important", label: "חשובה" },
    { value: "urgent", label: "דחופה" },
  ];
  // COMM-218. Icon + Hebrew label, never colour alone: `urgent` reads as a
  // stronger, more alarming badge than `important`; `normal` gets no badge
  // at all. Shared by the feed top area and the "today's note" card.
  function announcementPriorityBadge(a) {
    const priority = (a && a.priority) || "normal";
    if (priority === "urgent") return `<span class="admin-tag" role="status" style="color:var(--red);background:color-mix(in srgb, var(--red) 16%, transparent);border-color:var(--red);">🚨 דחוף</span>`;
    if (priority === "important") return `<span class="admin-tag" role="status" style="color:var(--brass);background:color-mix(in srgb, var(--brass) 14%, transparent);border-color:var(--brass);">❗ חשוב</span>`;
    return "";
  }
  // The accent that goes with the badge above, applied to the wrapping
  // card/row rather than the badge itself: `urgent` gets a full tinted
  // border + background (a banner, not just a chip), `important` gets only
  // the border, so the two tiers stay visually distinct beyond the badge.
  function announcementAccentStyle(a) {
    const priority = (a && a.priority) || "normal";
    if (priority === "urgent") return "border:1px solid var(--red);background:color-mix(in srgb, var(--red) 7%, transparent);";
    if (priority === "important") return "border:1px solid var(--brass);";
    return "";
  }
  // COMM-218. `announcements_read` RLS already drops an expired row for a
  // non-staff member at query time - this is a defensive mirror only, for a
  // session that has had the feed open across the expiry moment without a
  // refetch. Never the boundary itself.
  function isAnnouncementExpired(a) { return !!(a && a.expires_at && new Date(a.expires_at).getTime() <= Date.now()); }
  async function loadAnnouncements() {
    if (!state.user) return;
    const { data, error } = await client.from("announcements").select("id,title,body,created_at,pinned_date,priority,expires_at,profiles(handle,display_name)").order("created_at", { ascending: false }).limit(20);
    state.club.announcements = error ? [] : (data || []);
  }
  async function postAnnouncement(form) {
    if (!state.user || !isStaff()) return;
    const title = String(form.elements.title.value || "").trim().slice(0, 120);
    const body = String(form.elements.body.value || "").trim().slice(0, 2000);
    const priorityRaw = String((form.elements.priority && form.elements.priority.value) || "normal");
    const priority = ANNOUNCEMENT_PRIORITY_OPTIONS.some((o) => o.value === priorityRaw) ? priorityRaw : "normal";
    const expiresAtRaw = String((form.elements.expiresAt && form.elements.expiresAt.value) || "").trim();
    const errors = {};
    if (!title) errors.title = "יש למלא כותרת";
    if (!body) errors.body = "יש למלא תוכן להודעה";
    // Client-side only, no server CHECK: a staff member correcting an
    // already-posted announcement's expiry is legitimate (COMM-218). For a
    // brand-new announcement created_at is "now", so "after created_at"
    // means after the moment of submission.
    let expiresAtIso = null;
    if (expiresAtRaw) {
      const expiresAtDate = new Date(expiresAtRaw);
      if (Number.isNaN(expiresAtDate.getTime()) || expiresAtDate.getTime() <= Date.now()) {
        errors.expiresAt = "תאריך התפוגה חייב להיות אחרי מועד הפרסום";
      } else {
        expiresAtIso = expiresAtDate.toISOString();
      }
    }
    if (Object.keys(errors).length) return setFieldErrors("communityAnnouncement", errors);
    setFieldErrors("communityAnnouncement", {});
    const payload = { author_id: state.user.id, title, body, priority };
    if (expiresAtIso) payload.expires_at = expiresAtIso;
    if (form.elements.pinToday && form.elements.pinToday.checked) payload.pinned_date = todayIso();
    state.club.announcementSaving = true; rerender();
    const { error } = await client.from("announcements").insert(payload);
    state.club.announcementSaving = false;
    if (error) return setMessage("לא ניתן היה לשמור את ההודעה. נסו שוב.");
    form.reset(); await loadAnnouncements(); setMessage("ההודעה פורסמה"); rerender();
  }
  async function loadWeeklyChallenge() {
    if (!state.user) return;
    const { data, error } = await client.from("weekly_challenge_leaderboard").select("*").limit(50);
    if (error || !data || !data.length) { state.club.weeklyChallenge = null; state.club.weeklyLeaderboard = []; return; }
    state.club.weeklyChallenge = { title: data[0].title, comparisonKey: data[0].comparison_key, startsOn: data[0].starts_on, endsOn: data[0].ends_on };
    state.club.weeklyLeaderboard = data.sort((a, b) => a.score_direction === "lower" ? Number(a.score_value) - Number(b.score_value) : Number(b.score_value) - Number(a.score_value));
  }
  async function setWeeklyChallenge(form) {
    if (!state.user || !isStaff()) return;
    const title = String(form.elements.title.value || "").trim().slice(0, 120);
    const comparisonKey = String(form.elements.comparisonKey.value || "").trim().slice(0, 160);
    const startsOn = form.elements.startsOn.value, endsOn = form.elements.endsOn.value;
    const errors = {};
    if (!title) errors.title = "יש למלא שם לאתגר";
    if (!comparisonKey) errors.comparisonKey = "יש למלא מפתח השוואה";
    // A key in the wrong shape (e.g. the bare movement name a coach might
    // reasonably guess) silently creates a challenge that can never match
    // a real post - the empty leaderboard then looks identical to a
    // legitimately fresh challenge with no entries yet, so the mistake
    // was invisible. Catch the shape here instead.
    else if (!/^(movement:[a-z0-9-]+:(est1rm|duration)|wod:[a-z0-9-]+:[a-z]+:(rx|scaled))$/.test(comparisonKey)) errors.comparisonKey = "פורמט לא תקין — movement:שם-תרגיל:est1rm או wod:שם-אימון:סוג-תוצאה:rx";
    if (!startsOn) errors.startsOn = "יש לבחור תאריך התחלה";
    if (!endsOn) errors.endsOn = "יש לבחור תאריך סיום";
    if (Object.keys(errors).length) return setFieldErrors("communityWeeklyChallenge", errors);
    setFieldErrors("communityWeeklyChallenge", {});
    const { error } = await client.from("weekly_challenges").insert({ title, comparison_key: comparisonKey, starts_on: startsOn, ends_on: endsOn, created_by: state.user.id });
    if (error) return setMessage("קביעת האתגר נכשלה");
    form.reset(); await loadWeeklyChallenge(); setMessage("האתגר השבועי עודכן"); rerender();
  }
  async function loadInactiveMembers() {
    if (!state.user || !isStaff()) return;
    const { data, error } = await client.rpc("coach_inactive_members");
    state.club.inactiveMembers = error ? [] : (data || []);
  }
  async function loadNewMembers() {
    if (!state.user || !isStaff()) return;
    const { data, error } = await client.rpc("coach_new_members");
    state.club.newMembers = error ? [] : (data || []);
  }

  // ==========================================================================
  // COMM-223..226 coach-tools cluster. Coach Dashboard: Celebrate, Welcome,
  // Engage (scaffold, hidden). Challenges re-surfaces renderChallengesListSection()
  // (COMM-201..207) unchanged - see the render function below - so it owns no
  // state or load function here. Schema shipped in 202608290013; see the
  // three "###" subsections under "Needs from schema, coach-tools" in
  // contracts.md for the exact shapes read below.
  //
  // Read-path note (COMM-224 "new members"): the ticket text says to join
  // profiles with invite_redemptions.redeemed_at directly. That table has
  // exactly one SELECT policy on this schema, invite_redemptions_self_select
  // (202608270003, `user_id = auth.uid()`), and 202608290013 did not widen
  // it for staff - so a coach's cross-user select of it would silently
  // return nothing for every row but their own, the exact "looks like it
  // works, does nothing" failure mode 202608290013's own comments call out
  // for the Assign-coach column. profiles.created_at is used instead: it is
  // already club-wide readable (profiles_read_authenticated, 202608280003)
  // and profiles_insert_self requires a redeemed invite to already exist, so
  // it lands within the same session as redeemed_at for every real member.
  // Follow-up: either invite_redemptions gets a staff-readable SELECT
  // policy, or created_at is accepted as the canonical join date for good.
  //
  // "Sessions logged" (COMM-224): there is no readable-by-a-coach raw
  // lifetime session count anywhere in this schema (community_streaks
  // exposes a consecutive-day run, not a total; community_profile's
  // training_frequency/current_streak are the same shape, gated to the
  // subject's own toggle). current_streak from community_streaks - the
  // exact figure and the exact label ("רצף נוכחי") the profile overlay
  // already uses at community_profile's current_streak field - is reused
  // here rather than inventing a new count query, per COMM-224's own
  // instruction to reuse what already exists.
  function celebrateItemKey(item) { return `${item.kind}|${item.user_id}|${item.occurred_at}`; }
  async function loadCoachCelebrate() {
    if (!state.user || !isStaff()) return;
    state.coach.celebrate.loading = true;
    state.coach.celebrate.error = false;
    rerender();
    const { data, error } = await client.rpc("coach_celebrate_feed", { p_days: 7 });
    state.coach.celebrate.loading = false;
    state.coach.celebrate.loaded = true;
    if (error) { state.coach.celebrate.error = true; state.coach.celebrate.items = []; rerender(); return; }
    // The RPC already sorts newest-first; never re-sorted here.
    state.coach.celebrate.items = data || [];
    rerender();
  }
  // COMM-225 templates. Short, Hebrew, kind-specific, and well under the
  // 1000-char comment/post cap add_post_comment and post_create both
  // already enforce server-side.
  function celebrateTemplateBody(item) {
    const name = item.display_name || (item.handle ? "@" + item.handle : "חבר/ה");
    const d = item.detail || {};
    if (item.kind === "pr") {
      const movement = d.movement ? ` ב${d.movement}` : "";
      const result = d.result ? ` (${d.result})` : "";
      return `כל הכבוד ל${name} על שיא חדש${movement}${result}! 💪`;
    }
    if (item.kind === "anniversary") {
      const years = Number(d.years) || 0;
      const yearsLabel = years === 1 ? "שנה" : `${years} שנים`;
      return `מזל טוב ל${name} על ${yearsLabel} במועדון! 🎉`;
    }
    if (item.kind === "challenge_completion") {
      const title = d.title ? ` את האתגר ${d.title}` : " את האתגר";
      return `כל הכבוד ל${name} על השלמת${title}! 🏆`;
    }
    return `כל הכבוד ל${name}! 🎉`;
  }
  // COMM-225. post_id present -> add_post_comment on that post. post_id
  // null -> post_create (always lands POST_TEXT, 202608280023) followed by
  // one direct own-row update to post_type 'POST_COACH', the exact
  // workaround the events cluster already established for post_create's own
  // type gaps (see ensureEventCompanionPost below) rather than a new RPC or
  // a schema change this ticket does not own. No confirmation dialog: the
  // tap itself is the confirmation. congratulated/busy are keyed by
  // celebrateItemKey() so a second tap on an already-sent item, or a tap
  // while the first is still in flight, is a no-op before the server rate
  // limit would even see it.
  async function congratulateCelebrateItem(item) {
    if (!item) return;
    const key = celebrateItemKey(item);
    if (state.coach.celebrate.congratulated[key] || state.coach.celebrate.busy === key) return;
    state.coach.celebrate.busy = key;
    rerender();
    const body = celebrateTemplateBody(item);
    let ok = false;
    if (item.post_id) {
      const { error } = await client.rpc("add_post_comment", { p_post_id: item.post_id, p_body: body, p_parent_comment_id: null });
      ok = !error;
    } else {
      const { data: postId, error } = await client.rpc("post_create", { body, visibility: "club", media: [], links: null });
      if (!error && postId) {
        const { error: updErr } = await client.from("workout_posts").update({ post_type: "POST_COACH" }).eq("id", postId);
        ok = !updErr;
      }
    }
    state.coach.celebrate.busy = null;
    // COMM-233. After the write, and only on success. The row's user_id is
    // the coach, which is what makes this count toward the coach's own WCAM
    // and never the celebrated member's - being congratulated is not an
    // action they took. `kind` is the celebrate item's own enum and `via`
    // says which of the two write paths ran; neither the member nor the
    // generated greeting is a prop.
    if (ok) { state.coach.celebrate.congratulated[key] = true; setMessage(""); track(A.COACH_CONGRATULATE_SENT, { kind: item.kind || null, via: item.post_id ? "comment" : "post" }); }
    else setMessage("לא ניתן היה לשלוח ברכה. נסו שוב.");
    rerender();
  }

  // ---- Welcome (COMM-224) --------------------------------------------------
  async function loadCoachWelcome() {
    if (!state.user || !isStaff()) return;
    state.coach.welcome.loading = true;
    state.coach.welcome.error = false;
    rerender();
    const cutoffIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await client.from("profiles").select("id,handle,display_name,avatar_url,created_at,assigned_coach_id").gte("created_at", cutoffIso).order("created_at", { ascending: false });
    if (error) {
      state.coach.welcome.loading = false; state.coach.welcome.loaded = true; state.coach.welcome.error = true; state.coach.welcome.members = [];
      rerender();
      return;
    }
    // deleted_at isn't selected above - profiles_read_authenticated already
    // excludes a soft-deleted row server-side, so there is nothing left for
    // a client-side filter to add here.
    const members = data || [];
    state.coach.welcome.members = members;
    const ids = members.map((m) => m.id);
    // Staff can read any user's member_contact_log rows (COMM-224's own
    // shipped RLS), so this is one batched read, not one per member.
    const contactedIds = {};
    if (ids.length) {
      const { data: contacts } = await client.from("member_contact_log").select("user_id").in("user_id", ids);
      for (const row of contacts || []) contactedIds[row.user_id] = true;
    }
    state.coach.welcome.contactedIds = contactedIds;
    state.coach.welcome.loading = false;
    state.coach.welcome.loaded = true;
    rerender();
  }
  // Same lookup shape ensureEventCompanionPost() below already uses for
  // "does a companion post already exist for this record": no stored
  // pointer from profiles back to the POST_NEW_MEMBER row, so the metadata
  // carried on the post itself (member_id, set the way
  // community-post-cards.test.mjs's fixture and renderNewMemberPostCard's
  // own reading of it both already assume) is the source of truth.
  //
  // Follow-up worth flagging: COMM-107 (the POST_NEW_MEMBER producer) was
  // never actually built as a server insert - 202608290004's own comment
  // says so in as many words - so in a real club today this lookup finds
  // nothing for any member yet. This function and coachWelcomeMember() are
  // correct and ready; they are inert until COMM-107 or an equivalent
  // producer ships. The standard error message covers "no matching post
  // found" the same way it covers a failed RPC, rather than pretending the
  // tap worked.
  async function findNewMemberPost(memberId) {
    const { data, error } = await client.from("workout_posts").select("id,post_type,metadata").eq("post_type", "POST_NEW_MEMBER");
    if (error) return null;
    return (data || []).find((r) => r.metadata && r.metadata.member_id === memberId) || null;
  }
  // Reuses welcomeNewMember(postId) (COMM-107/COMM-124) rather than a second
  // add_post_comment call with a near-duplicate template - one Hebrew
  // welcome string, one place it is sent from.
  async function coachWelcomeMember(memberId) {
    if (!memberId || state.coach.welcome.busy) return;
    state.coach.welcome.busy = memberId;
    rerender();
    const post = await findNewMemberPost(memberId);
    if (!post) {
      state.coach.welcome.busy = null;
      setMessage("לא ניתן היה לבצע את הפעולה. נסו שוב.");
      rerender();
      return;
    }
    await welcomeNewMember(post.id);
    state.coach.welcome.busy = null;
    rerender();
  }
  // Assign coach (optional). Only write path is coach_assign_coach() -
  // profiles has exactly one UPDATE policy and it is own-row only
  // (202608290013's own correction to this ticket's original "direct RLS
  // update" ask). p_coach_id null clears the assignment. There is no
  // staff-readable directory RPC on this schema to build a real dropdown of
  // coaches from (admin_search_members is real-is_admin-only, not
  // is_staff() - 202608270011), so the picker is: assign to me (always
  // valid, the caller is staff by construction of this whole surface),
  // clear, or resolve another coach by their handle through the same
  // club-wide profiles read every other lookup here already uses - the
  // server still validates the target is staff and raises otherwise, so a
  // typo or a plain member's handle fails safely rather than silently
  // mis-assigning. A real staff-directory RPC would turn this into an
  // actual dropdown; noted as a follow-up rather than invented here.
  async function coachAssignCoach(memberId, coachId) {
    if (!memberId || state.coach.welcome.busy) return;
    state.coach.welcome.busy = memberId;
    rerender();
    const { error } = await client.rpc("coach_assign_coach", { p_user_id: memberId, p_coach_id: coachId || null });
    state.coach.welcome.busy = null;
    if (error) { setMessage("לא ניתן היה לבצע את הפעולה. נסו שוב."); rerender(); return; }
    const m = state.coach.welcome.members.find((x) => x.id === memberId);
    if (m) m.assigned_coach_id = coachId || null;
    setMessage(coachId ? "המאמן/ת שויכ/ה" : "השיוך בוטל");
    rerender();
  }
  async function coachAssignByHandle(memberId) {
    const handle = String((state.coach.welcome.assignDrafts || {})[memberId] || "").trim().toLowerCase().replace(/^@/, "");
    if (!handle) return;
    const { data } = await client.from("profiles").select("id").eq("handle", handle).maybeSingle();
    if (!data || !data.id) { setMessage("לא ניתן היה לבצע את הפעולה. נסו שוב."); rerender(); return; }
    await coachAssignCoach(memberId, data.id);
  }
  // Mark contacted. Staff-only insert, contacted_by defaults to auth.uid()
  // server-side (202608290013), so the client sends only {user_id, note}.
  async function coachMarkContacted(memberId) {
    if (!memberId || state.coach.welcome.busy) return;
    state.coach.welcome.busy = memberId;
    rerender();
    const note = String((state.coach.welcome.contactDrafts || {})[memberId] || "").trim().slice(0, 500);
    const { error } = await client.from("member_contact_log").insert({ user_id: memberId, note });
    state.coach.welcome.busy = null;
    if (error) { setMessage("לא ניתן היה לבצע את הפעולה. נסו שוב."); rerender(); return; }
    state.coach.welcome.contactedIds[memberId] = true;
    setMessage("סומן כנוצר קשר");
    rerender();
  }

  // ---- Engage (COMM-226 scaffold, COMM-304 real data + actions) ------------
  // Flag-gated (state.featureFlags.coachEngage, defaults ON as of COMM-304)
  // on top of the staff gate every other section here already has - COMM-226
  // asked that no code path reach coach_engagement_flags outside the
  // flag-gated staff surface, and that still holds: this is never called
  // from refreshSession() the way the always-on staff loads above are, only
  // from the coach tab's own lazy load. The table's own RLS
  // (`user_id <> auth.uid()`, COMM-011, re-asserted against real rows by
  // 202608310008) is the real boundary that keeps a flagged member from ever
  // reading their own row, staff or not; nothing here works around it.
  //
  // COLUMNS DELIBERATELY NOT SELECTED: baseline_sessions_per_week and
  // recent_sessions_per_week. COMM-304's own "Frontend states" wording -
  // "no raw session numbers shown to anyone but the reviewing staff member"
  // - is a narrower bar than "staff may see them", so this reads the same
  // five columns COMM-226 already selected and no more: id, user_id, level,
  // status, flagged_at. The level bucket is the signal a coach needs to
  // decide whether to act; the two figures behind it are not rendered
  // anywhere in this file.
  //
  // PROFILE JOIN, AND A KNOWN GAP: display name/handle/avatar are a second,
  // separate `.from("profiles")` read batched over every flagged user_id -
  // the same shape coachWelcome.contactedIds already uses for
  // member_contact_log - rather than an embedded `coach_engagement_flags`
  // select with `profiles(...)` nested in it. Worth flagging for a reviewer:
  // profiles_read_authenticated (202608280003) only bypasses a member's own
  // `visible_to_club = false` for `is_admin()`, not for `is_staff()` - so a
  // coach who is not an admin resolving a flagged member who has hidden
  // their own profile from the club gets nothing back for that id, and the
  // row below falls back to the generic "חבר/ה" label instead of a name.
  // Same failure mode COMM-224's own comment already logged for
  // invite_redemptions ("looks like it works, does nothing" for a coach,
  // not for an admin) - not fixed here, since fixing it is a policy change
  // this client-only ticket does not own.
  async function loadCoachEngageFlags() {
    if (!state.user || !isStaff() || !state.featureFlags.coachEngage) return;
    state.coach.engage.loading = true;
    state.coach.engage.error = false;
    rerender();
    const { data, error } = await client.from("coach_engagement_flags").select("id,user_id,level,status,flagged_at").eq("status", "open").order("flagged_at", { ascending: false });
    if (error) {
      state.coach.engage.loading = false; state.coach.engage.loaded = true; state.coach.engage.error = true; state.coach.engage.items = [];
      rerender();
      return;
    }
    const items = data || [];
    const { map: profiles } = await loadProfilesById(items.map((it) => it.user_id));
    state.coach.engage.items = items;
    state.coach.engage.profiles = profiles;
    state.coach.engage.loading = false;
    state.coach.engage.loaded = true;
    rerender();
  }
  // The three level buckets coach_detect_engagement_decline() writes
  // (202608310008), translated for display - the raw enum value never
  // reaches the DOM as text. Colour is severity only, not a new signal:
  // `inactive` reuses the same red the section header already carries.
  const ENGAGE_LEVEL_LABELS = { mild: "ירידה קלה בהגעה", significant: "ירידה משמעותית בהגעה", inactive: "לא פעיל/ה" };
  const ENGAGE_LEVEL_COLORS = { mild: "var(--brass)", significant: "var(--energy)", inactive: "var(--red)" };
  function engageLevelLabel(level) { return ENGAGE_LEVEL_LABELS[level] || level || ""; }
  function engageLevelColor(level) { return ENGAGE_LEVEL_COLORS[level] || "var(--steel)"; }
  function engageMemberName(userId) {
    const p = state.coach.engage.profiles[userId] || {};
    return p.display_name || (p.handle ? "@" + p.handle : "חבר/ה");
  }
  // COMM-304's "reach out" one-tap action, modeled directly on COMM-225's
  // congratulateCelebrateItem(): no confirmation dialog (the tap itself is
  // the confirmation), deduped by reachedOut so a second tap - or a tap
  // while the first is still in flight - is a no-op. It always takes
  // congratulateCelebrateItem's post_create branch, never its
  // add_post_comment one: an engagement flag has no source post the way a
  // PR or an anniversary does, so there is nothing to comment on. No new
  // "Message" affordance is added - this is the same public
  // post_create + own-row POST_COACH update path Celebrate already uses,
  // per the phase's standing no-direct-messaging resolution.
  //
  // The template is deliberately generic and carries no per-level text -
  // the same warm check-in a coach could send any member, unrelated to why
  // this one was flagged. It never mentions attendance, a session figure or
  // a level. `user_id <> auth.uid()` on this table exists so the flagged
  // member never learns they were flagged; a post that says "we noticed
  // you've been away" would leak exactly that fact, just through a
  // different door than the table it is trying to protect.
  function engageReachOutTemplateBody(name) {
    return `היי ${name}, רק רצינו לומר שלום ולראות מה שלומך! נשמח לראות אותך באימון בקרוב 😊`;
  }
  async function coachEngageReachOut(flagId) {
    if (!flagId) return;
    if (state.coach.engage.reachedOut[flagId] || (state.coach.engage.busy && state.coach.engage.busy.id === flagId)) return;
    const item = state.coach.engage.items.find((it) => it.id === flagId);
    if (!item) return;
    state.coach.engage.busy = { id: flagId, action: "reach-out" };
    rerender();
    const body = engageReachOutTemplateBody(engageMemberName(item.user_id));
    let ok = false;
    const { data: postId, error } = await client.rpc("post_create", { body, visibility: "club", media: [], links: null });
    if (!error && postId) {
      const { error: updErr } = await client.from("workout_posts").update({ post_type: "POST_COACH" }).eq("id", postId);
      ok = !updErr;
    }
    state.coach.engage.busy = null;
    if (ok) { state.coach.engage.reachedOut[flagId] = true; setMessage(""); }
    else setMessage("לא ניתן היה לשלוח פנייה. נסו שוב.");
    rerender();
  }
  // Review / dismiss. A direct RLS update on `status`, `reviewed_by`,
  // `reviewed_at` - COMM-304's schema half (202608310008) verified rather
  // than assumed that coach_engagement_flags_staff_update (Phase 0,
  // 202608280011) already covers all three columns for any staff member
  // acting on another member's row, so no migration backs this call. Once
  // resolved, a flag falls out of the open list this section reads (it only
  // ever selects status='open'), so the row is removed locally rather than
  // re-fetched.
  async function coachEngageResolveFlag(flagId, status) {
    if (!flagId || (state.coach.engage.busy && state.coach.engage.busy.id === flagId)) return;
    state.coach.engage.busy = { id: flagId, action: status };
    rerender();
    const { error } = await client.from("coach_engagement_flags")
      .update({ status, reviewed_by: state.user.id, reviewed_at: new Date().toISOString() })
      .eq("id", flagId);
    state.coach.engage.busy = null;
    if (error) { setMessage("לא ניתן היה לבצע את הפעולה. נסו שוב."); rerender(); return; }
    state.coach.engage.items = state.coach.engage.items.filter((it) => it.id !== flagId);
    delete state.coach.engage.reachedOut[flagId];
    setMessage(status === "reviewed" ? "סומן כנבדק" : "הפריט נדחה");
    rerender();
  }

  // ---- Member of the Week (COMM-315) ---------------------------------------
  // Staff-only fifth section of the Coach Dashboard. Schema shipped in
  // 202609010001 (see contracts.md, "Needs from schema, member of the week").
  // member_of_week_candidates() is the whole read: one jsonb envelope, always
  // exactly one row (data[0], no client-side join or reshape), carrying the
  // week's rotation category, its (at most 3) computed candidates - or []
  // for the coachs_pick week, which is that category's definition and not an
  // empty result - whether the week is already published, and last week's
  // member so the free-selection form can name them rather than a coach
  // discovering the once-per-two-weeks rule by hitting it. Never
  // auto-published: COMM-309's generated-draft/staff-publishes shape, the
  // same one Celebrate already uses.
  async function loadCoachMemberOfWeek() {
    if (!state.user || !isStaff()) return;
    state.coach.memberOfWeek.loading = true;
    state.coach.memberOfWeek.error = false;
    rerender();
    const { data, error } = await client.rpc("member_of_week_candidates", { p_week_start: null });
    if (error || !data || !data[0]) {
      state.coach.memberOfWeek.loading = false;
      state.coach.memberOfWeek.loaded = true;
      state.coach.memberOfWeek.error = true;
      state.coach.memberOfWeek.envelope = null;
      rerender();
      return;
    }
    const envelope = data[0];
    state.coach.memberOfWeek.envelope = envelope;
    // One small, separate profile read (loadProfilesById - the shared shape
    // coachEngage/loadFollowList also use, rather than an embedded join)
    // for the two ids the envelope names but does not itself carry a
    // display name for.
    const { map: profiles } = await loadProfilesById([envelope.published && envelope.published.user_id, envelope.previous_week_user_id]);
    state.coach.memberOfWeek.publishedProfile = envelope.published ? (profiles[envelope.published.user_id] || null) : null;
    state.coach.memberOfWeek.previousProfile = envelope.previous_week_user_id ? (profiles[envelope.previous_week_user_id] || null) : null;
    state.coach.memberOfWeek.loading = false;
    state.coach.memberOfWeek.loaded = true;
    state.coach.memberOfWeek.error = false;
    rerender();
  }
  // The five real Postgres errors member_of_week_publish() raises (COMM-315's
  // schema half, verbatim), mapped to short Hebrew - the same
  // setMessage()-surfaced pattern coachAssignByHandle/coachMarkContacted and
  // coachEngageResolveFlag already use for a failed staff action, not a new
  // display mechanism. Any other error (network, a future server message)
  // falls back to the same generic retry copy the rest of this cluster uses.
  const MEMBER_OF_WEEK_ERROR_LABELS = {
    "week already published": "השבוע הזה כבר פורסם.",
    "member was recognised last week": "לא ניתן לבחור שוב בחבר/ה שנבחר/ה כבר בשבוע שעבר.",
    "member not found": "לא נמצא/ה חבר/ה כזה/כזאת.",
    "member is not visible to the club": "לא ניתן לפרסם עבור חבר/ה שאינו/ה גלוי/ה למועדון.",
    "reason required for a coach's pick": "יש להזין סיבה לבחירת המאמן/ת.",
  };
  function memberOfWeekErrorText(error) {
    const msg = error && error.message;
    return (msg && MEMBER_OF_WEEK_ERROR_LABELS[msg]) || "הפרסום נכשל. נסו שוב.";
  }
  // One publish path for both the computed-candidate "Publish" button and the
  // free-selection ("coach's pick") form - member_of_week_publish() itself
  // decides which category the row records (on the shortlist -> the week's
  // rotation category, off it -> coachs_pick), so the client never sends a
  // category and never needs two write paths to keep in sync. p_reason is
  // trimmed and capped at 500 client-side too (the same shape
  // coachMarkContacted's member_contact_log.note write already applies); the
  // server re-trims and re-caps regardless, this only keeps what the client
  // sends honest before it does. On success the whole envelope is re-fetched
  // rather than patched by hand, since the server - not the client - resolves
  // which category the row actually records.
  async function publishMemberOfWeek(userId, reason, busyKey) {
    if (!userId || state.coach.memberOfWeek.busy) return;
    state.coach.memberOfWeek.busy = busyKey || userId;
    state.coach.memberOfWeek.publishErr = "";
    rerender();
    const p_reason = String(reason || "").trim().slice(0, 500);
    const { error } = await client.rpc("member_of_week_publish", { p_week_start: null, p_user_id: userId, p_reason });
    if (error) {
      state.coach.memberOfWeek.busy = null;
      state.coach.memberOfWeek.publishErr = memberOfWeekErrorText(error);
      setMessage(state.coach.memberOfWeek.publishErr);
      rerender();
      return;
    }
    state.coach.memberOfWeek.pickHandle = "";
    state.coach.memberOfWeek.pickReason = "";
    setMessage("חבר/ת השבוע פורסמ/ה");
    await loadCoachMemberOfWeek();
    state.coach.memberOfWeek.busy = null;
    rerender();
  }
  // A computed-candidate publish carries no typed reason - the category
  // itself is the reason, exactly as the three computed categories' own
  // shortlist already states it (COMM-315's schema half only requires a
  // reason when the resolved category is coachs_pick, which a shortlisted
  // candidate's publish can never resolve to).
  function memberOfWeekPublishCandidate(userId) { publishMemberOfWeek(userId, ""); }
  // The free-selection ("coach's pick") form. Resolves a typed handle to an
  // id the same way coachAssignByHandle already does (there is no
  // staff-readable directory RPC to build a real member picker from - see
  // coachAssignByHandle's own comment on that gap), and requires a non-empty
  // reason client-side before ever calling the server, matching COMM-315's
  // own definition of a coach's pick ("a free staff selection... with a
  // short reason staff types") - the server enforces the same rule and is
  // still the real authority; this only saves a round trip for the obvious
  // case.
  async function memberOfWeekPublishPick() {
    if (state.coach.memberOfWeek.busy) return;
    const handle = String(state.coach.memberOfWeek.pickHandle || "").trim().toLowerCase().replace(/^@/, "");
    const reason = String(state.coach.memberOfWeek.pickReason || "").trim();
    if (!handle) { state.coach.memberOfWeek.publishErr = "יש להזין שם משתמש."; setMessage(state.coach.memberOfWeek.publishErr); rerender(); return; }
    if (!reason) { state.coach.memberOfWeek.publishErr = "יש להזין סיבה לבחירת המאמן/ת."; setMessage(state.coach.memberOfWeek.publishErr); rerender(); return; }
    const { data } = await client.from("profiles").select("id").eq("handle", handle).maybeSingle();
    if (!data || !data.id) {
      state.coach.memberOfWeek.publishErr = "לא נמצא/ה חבר/ה עם שם המשתמש הזה.";
      setMessage(state.coach.memberOfWeek.publishErr);
      rerender();
      return;
    }
    // "pick" rather than data.id: the busy state is set before the resolved
    // id is known to any renderer, and the whole free-selection form (not
    // one candidate row) is what should read as busy while this is in
    // flight - the same literal the state comment above documents.
    await publishMemberOfWeek(data.id, reason, "pick");
  }

  // ---- Monthly club recap (COMM-309) ---------------------------------------
  // Schema half shipped in 202609010002_monthly_club_recap.sql. The client
  // never calls or triggers generation - `recap_monthly_generate()` is
  // service_role-only, granted to nobody else - it only reads
  // `monthly_club_recaps` directly under RLS and calls
  // `recap_monthly_publish(p_id)`. See the migration's own comments and
  // contracts.md, "Needs from schema, monthly club recap (COMM-309, Phase
  // 3)" for the full reasoning.
  //
  // Two separate loaders for two separate audiences reading the same table
  // under two different RLS policies, not one shared function:
  //   loadCoachMonthlyRecap() - the Coach Dashboard staff preview. No
  //     `published_at` filter at all: monthly_club_recaps_staff_select lets
  //     a staff/community.analytics.view reader see ANY row, draft or
  //     published, and the preview's whole job is to show the newest month
  //     regardless of its state.
  //   loadMonthlyRecap() - the member-facing surface. Filters
  //     `published_at is not null` itself, in the query, rather than
  //     leaning on RLS to do it: RLS enforces the same boundary for a real
  //     plain member, but a staff member (who can also read drafts) lands
  //     on the Account tab too, and this filter is what keeps a draft from
  //     leaking into their own member-facing card. Both loaders use the
  //     same "select, order desc, limit 1, read data[0]" shape
  //     refreshRecapView already uses for "no explicit week" rather than
  //     .maybeSingle(), since order()+limit() only apply to a real query,
  //     not to a .maybeSingle() short-circuit.
  async function loadCoachMonthlyRecap() {
    if (!state.user || !isStaff()) return;
    state.coach.monthlyRecap.loading = true;
    state.coach.monthlyRecap.error = false;
    rerender();
    const { data, error } = await client.from("monthly_club_recaps").select("*")
      .order("month_start", { ascending: false }).limit(1);
    state.coach.monthlyRecap.loading = false;
    state.coach.monthlyRecap.loaded = true;
    if (error) {
      state.coach.monthlyRecap.error = true;
      state.coach.monthlyRecap.row = null;
      rerender();
      return;
    }
    state.coach.monthlyRecap.error = false;
    state.coach.monthlyRecap.row = (Array.isArray(data) && data.length) ? data[0] : null;
    rerender();
  }
  async function loadMonthlyRecap() {
    if (!state.user) return;
    state.recaps.monthly.loading = true;
    state.recaps.monthly.error = false;
    rerender();
    const { data, error } = await client.from("monthly_club_recaps").select("*")
      .not("published_at", "is", null).order("month_start", { ascending: false }).limit(1);
    state.recaps.monthly.loading = false;
    state.recaps.monthly.loaded = true;
    if (error) {
      state.recaps.monthly.error = true;
      state.recaps.monthly.row = null;
      rerender();
      return;
    }
    state.recaps.monthly.error = false;
    state.recaps.monthly.row = (Array.isArray(data) && data.length) ? data[0] : null;
    rerender();
  }
  // The two real Postgres errors recap_monthly_publish() raises (the schema
  // half's own comment on that function, verbatim), mapped to short Hebrew -
  // the same setMessage()-surfaced, error.message === "..." pattern
  // coachEngageResolveFlag and memberOfWeekErrorText both already use for a
  // failed staff action. Any other error (network, "not authorized" for a
  // caller whose permission changed between page-load and click) falls back
  // to the same generic retry copy the rest of this cluster uses.
  const MONTHLY_RECAP_ERROR_LABELS = {
    "recap not found": "התקציר לא נמצא.",
    "recap already published": "התקציר כבר פורסם.",
  };
  function monthlyRecapErrorText(error) {
    const msg = error && error.message;
    return (msg && MONTHLY_RECAP_ERROR_LABELS[msg]) || "הפרסום נכשל. נסו שוב.";
  }
  // recap_monthly_publish(p_id) is narrower than the staff read policy - it
  // requires community.analytics.view or real is_admin(), which a plain
  // coach does not hold (the migration's own long comment on this asymmetry
  // is the reason renderCoachMonthlyRecapSection() gates the button on
  // hasPerm(PERM.ANALYTICS_VIEW) || isAdmin(), not on isStaff()). This
  // function does not re-check that client-side before calling - the button
  // it is wired to is already absent for a caller who lacks it, and the
  // server is the real authority regardless - it only maps the refusal if
  // one somehow arrives anyway (e.g. a permission revoked mid-session).
  async function publishMonthlyRecap(id) {
    if (!id || state.coach.monthlyRecap.busy) return;
    state.coach.monthlyRecap.busy = id;
    state.coach.monthlyRecap.publishErr = "";
    rerender();
    const { error } = await client.rpc("recap_monthly_publish", { p_id: id });
    if (error) {
      state.coach.monthlyRecap.busy = null;
      state.coach.monthlyRecap.publishErr = monthlyRecapErrorText(error);
      setMessage(state.coach.monthlyRecap.publishErr);
      rerender();
      return;
    }
    setMessage("התקציר החודשי פורסם");
    await loadCoachMonthlyRecap();
    state.coach.monthlyRecap.busy = null;
    rerender();
  }

  // ==========================================================================
  // COMM-150..156  admin-moderation cluster.
  // The moderation queue, its actions, the pinned strip and the admin audit
  // view. Every queue action routes through mod_review(), a trusted
  // security-definer function that stamps the reviewer id and timestamp,
  // applies the decision (content removal, warning, posting restriction,
  // dismissal) and writes admin_actions in the same transaction. The client
  // never writes reports, posting_restrictions, pins or admin_actions
  // directly - it has no grant to - so the audit trail is a property of the
  // schema, not of this file.
  // ==========================================================================

  const MOD_QUEUE_STATUSES = [
    { id: "open", label: "פתוח" },
    { id: "reviewing", label: "בטיפול" },
    { id: "action_taken", label: "טופל" },
    { id: "dismissed", label: "נדחה" },
    { id: "all", label: "הכול" },
  ];
  const MOD_STATUS_LABEL = { open: "פתוח", reviewing: "בטיפול", action_taken: "טופל", dismissed: "נדחה" };
  // Reason codes match the report() RPC contract. inappropriate covers
  // "inappropriate content", privacy covers "privacy concern",
  // unsafe_advice covers "unsafe training advice".
  const REPORT_REASONS = [
    { id: "harassment", label: "הטרדה" },
    { id: "spam", label: "ספאם" },
    { id: "inappropriate", label: "תוכן לא הולם" },
    { id: "privacy", label: "פגיעה בפרטיות" },
    { id: "unsafe_advice", label: "המלצת אימון מסוכנת" },
    { id: "other", label: "אחר" },
  ];
  function reportReasonLabel(code) { const r = REPORT_REASONS.find((x) => x.id === code); return r ? r.label : (code || ""); }
  // The five queue decisions. restrict_temp carries a duration; the rest
  // do not. Every one is passed straight to mod_review().
  const MOD_DECISIONS = [
    { id: "remove", label: "הסרת התוכן", destructive: true },
    { id: "warn", label: "אזהרה לחבר/ה" },
    { id: "restrict_temp", label: "הגבלת פרסום זמנית" },
    { id: "restrict_permanent", label: "הגבלת פרסום קבועה", destructive: true },
    { id: "dismiss", label: "דחיית הדיווח" },
  ];
  const RESTRICT_TEMP_DAYS = [3, 7, 14, 30];

  // Read via mod_queue(), an admin-only path: the function checks
  // community.comment.moderate or real is_admin and only it can resolve the
  // reporter identities, which stay invisible to everyone else.
  async function loadModQueue() {
    if (!state.user || !(hasPerm(PERM.COMMENT_MODERATE) || isAdmin())) { state.admin.modQueue = []; return; }
    state.admin.modQueueLoading = true; state.admin.modQueueError = false; rerender();
    const { data, error } = await client.rpc("mod_queue", { p_status: state.admin.modQueueStatus, p_cursor: null, p_limit: 50 });
    state.admin.modQueueLoading = false;
    state.admin.modQueueLoaded = true;
    if (error) { state.admin.modQueueError = true; state.admin.modQueue = []; rerender(); return; }
    state.admin.modQueue = data || [];
    rerender();
  }
  function setModQueueStatus(status) {
    if (!MOD_QUEUE_STATUSES.some((s) => s.id === status) || state.admin.modQueueStatus === status) return;
    state.admin.modQueueStatus = status;
    loadModQueue();
  }
  function openModContext(reportId) {
    const item = (state.admin.modQueue || []).find((r) => r.report_id === reportId);
    if (!item) return;
    state.admin.modContext = item;
    rerender();
  }
  function closeModContext() { state.admin.modContext = null; rerender(); }
  function openModAction(reportId, decision) {
    const item = (state.admin.modQueue || []).find((r) => r.report_id === reportId);
    if (!item || !MOD_DECISIONS.some((d) => d.id === decision)) return;
    state.admin.modAction = { reportId, decision, note: "", days: 7, saving: false, error: "", targetType: item.target_type };
    rerender();
  }
  function closeModAction() { state.admin.modAction = null; rerender(); }
  async function runModAction() {
    const a = state.admin.modAction;
    if (!a || a.saving) return;
    a.saving = true; a.error = ""; rerender();
    const args = { p_report_id: a.reportId, p_decision: a.decision, p_note: String(a.note || "").slice(0, 500) };
    // Only a temporary restriction carries an end time; mod_review ignores
    // p_expires_at for every other decision.
    if (a.decision === "restrict_temp") args.p_expires_at = new Date(Date.now() + a.days * 86400000).toISOString();
    const { error } = await client.rpc("mod_review", args);
    if (error) {
      a.saving = false;
      a.error = "לא ניתן היה להשלים את הפעולה. נסו שוב.";
      rerender();
      return;
    }
    state.admin.modAction = null;
    // The card carried a post that was removed - drop it from the feed too.
    if (a.decision === "remove" && a.targetType === "post") {
      const it = (state.admin.modQueue || []).find((r) => r.report_id === a.reportId);
      if (it && Array.isArray(state.feed.items)) state.feed.items = state.feed.items.filter((p) => p && p.id !== it.target_id);
    }
    setMessage("הפעולה נרשמה");
    await loadModQueue();
  }
  // Admin-only member lookup/management - was previously only possible
  // through the Supabase SQL editor. Search by handle/name or paste an
  // exact user id; role changes and removal each check real is_admin
  // server-side too (admin_grant_coach/admin_revoke_coach/
  // admin_remove_member), this is only for deciding what to show.
  async function searchMembers(query) {
    state.members.search = query;
    const q = String(query || "").trim();
    if (q.length < 2) { state.members.results = []; return rerender(); }
    const { data, error } = await client.rpc("admin_search_members", { p_query: q });
    state.members.results = error ? [] : (data || []);
    rerender();
  }
  // COMM-156. HEAD_COACH is exposed in Phase 1; STAFF and OWNER are modelled
  // server-side but stay out of this list until Phase 2. A role change goes
  // through the same is_admin-gated promotion path, which writes an
  // admin_actions row of type role_change. The bare coach grant keeps the
  // original single-argument call so nothing that already drives it breaks;
  // head_coach passes p_role through.
  const GRANTABLE_ROLES = [
    { id: "member", label: "חבר/ה" },
    { id: "coach", label: "מאמן/ת" },
    { id: "head_coach", label: "מאמן/ת ראשי/ת" },
  ];
  function roleCodeLabel(code) { const r = GRANTABLE_ROLES.find((x) => x.id === code); return r ? r.label : code; }
  async function adminGrantCoach(userId) {
    if (!state.user || !isAdmin()) return;
    const { error } = await client.rpc("admin_grant_coach", { p_user_id: userId });
    if (error) return setMessage("הענקת ההרשאה נכשלה");
    setMessage("הרשאת מאמן/ת הוענקה");
    await searchMembers(state.members.search);
  }
  async function adminSetRole(userId, roleCode) {
    if (!state.user || !isAdmin()) return;
    if (roleCode === "member") return adminRevokeCoach(userId);
    if (roleCode === "coach") return adminGrantCoach(userId);
    if (roleCode !== "head_coach") return;
    const { error } = await client.rpc("admin_grant_coach", { p_user_id: userId, p_role: "head_coach" });
    if (error) return setMessage("שינוי ההרשאה נכשל");
    setMessage("ההרשאה עודכנה ל" + roleCodeLabel(roleCode));
    await searchMembers(state.members.search);
  }
  async function adminRevokeCoach(userId) {
    if (!state.user || !isAdmin()) return;
    const { error } = await client.rpc("admin_revoke_coach", { p_user_id: userId });
    if (error) return setMessage("ביטול ההרשאה נכשל");
    setMessage("הרשאת מאמן/ת בוטלה");
    await searchMembers(state.members.search);
  }
  // ---- COMM-376. Invite and code management -----------------------------
  // Two independent panels, gated on the two different permissions COMM-
  // 370/371 set up server-side (contracts.md's own "Needs from schema,
  // registration and invite management" section is the ground truth for
  // every signature below - COMM-376's own ticket text still names the
  // pre-hardening (p_code, p_role) shapes, which never shipped). A coach who
  // holds community.member.invite but not community.invite.manage_codes
  // sees the per-person panel only, matching that permission split exactly.
  function inviteCodeCreateErrorText(error) {
    const msg = error && error.message;
    return {
      "not authorized": "אין הרשאה ליצור קוד הצטרפות.",
      "invalid role": "תפקיד לא תקין.",
      "shared codes cannot grant coach": "קוד משותף לא יכול להעניק הרשאת מאמן/ת.",
      "max uses must be between 1 and 1000": "מספר השימושים חייב להיות בין 1 ל-1000.",
      "expiry must be in the future": "תאריך התפוגה חייב להיות בעתיד.",
    }[msg] || "יצירת הקוד נכשלה, נסו שוב.";
  }
  async function loadInviteCodes() {
    if (!state.user || !(hasPerm(PERM.INVITE_MANAGE_CODES) || isAdmin())) { state.admin.inviteCodes.items = []; return; }
    const ic = state.admin.inviteCodes;
    ic.loading = true; ic.error = false; rerender();
    const { data, error } = await client.rpc("admin_invite_code_list");
    ic.loading = false; ic.loaded = true;
    if (error) { ic.error = true; rerender(); return; }
    ic.items = Array.isArray(data) ? data : [];
    rerender();
  }
  async function createInviteCode(form) {
    if (!state.user || !(hasPerm(PERM.INVITE_MANAGE_CODES) || isAdmin())) return;
    const maxUsesRaw = String((form.elements.maxUses && form.elements.maxUses.value) || "").trim();
    const expiresRaw = String((form.elements.expiresAt && form.elements.expiresAt.value) || "").trim();
    const errors = {};
    let maxUses = 100;
    if (maxUsesRaw) {
      maxUses = Number(maxUsesRaw);
      if (!Number.isFinite(maxUses) || maxUses < 1 || maxUses > 1000) errors.maxUses = "מספר שימושים חייב להיות בין 1 ל-1000";
    }
    let expiresAtIso = null;
    if (expiresRaw) {
      const d = new Date(expiresRaw);
      if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) errors.expiresAt = "תאריך התפוגה חייב להיות בעתיד";
      else expiresAtIso = d.toISOString();
    }
    if (Object.keys(errors).length) return setFieldErrors("communityInviteCodeCreate", errors);
    setFieldErrors("communityInviteCodeCreate", {});
    // p_role is always "member" - admin_invite_code_create refuses a coach
    // role unconditionally (COMM-371's own DEVIATION note: a shared code
    // with role='coach' would be permanently unredeemable, since
    // redeem_invite_code's shared branch never grants anything but member),
    // so there is no role selector here at all, not even for an admin.
    const { data, error } = await client.rpc("admin_invite_code_create", { p_role: "member", p_expires_at: expiresAtIso, p_max_uses: maxUses });
    if (error) return setMessage(inviteCodeCreateErrorText(error));
    form.reset();
    state.admin.inviteCodes.created = data;
    setMessage("קוד ההצטרפות נוצר");
    await loadInviteCodes();
  }
  async function setInviteCodeActive(codeId, active) {
    if (!state.user || !(hasPerm(PERM.INVITE_MANAGE_CODES) || isAdmin()) || state.admin.inviteCodes.busy) return;
    state.admin.inviteCodes.busy = codeId; rerender();
    const { error } = await client.rpc("admin_invite_code_set_active", { p_code_id: codeId, p_active: active });
    state.admin.inviteCodes.busy = null;
    if (error) { setMessage("עדכון הסטטוס נכשל"); rerender(); return; }
    await loadInviteCodes();
  }
  function dismissInviteCodeCreated() { state.admin.inviteCodes.created = null; rerender(); }
  function copyInviteCode(code) {
    if (!code) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(() => setMessage("הקוד הועתק")).catch(() => setMessage("ההעתקה נכשלה, אפשר להעתיק ידנית"));
    } else {
      setMessage("ההעתקה נכשלה, אפשר להעתיק ידנית");
    }
  }
  const INVITE_STATUS_FILTERS = [
    { id: "all", label: "הכול" }, { id: "pending", label: "ממתין" }, { id: "redeemed", label: "מומש" },
    { id: "revoked", label: "בוטל" }, { id: "expired", label: "פג תוקף" },
  ];
  function inviteStatusLabel(s) { return { pending: "ממתין", redeemed: "מומש", revoked: "בוטל", expired: "פג תוקף" }[s] || s; }
  async function loadInvites(reset) {
    if (!state.user || !(hasPerm(PERM.MEMBER_INVITE) || isAdmin())) { state.admin.invites.items = []; return; }
    const iv = state.admin.invites;
    if (reset) { iv.items = []; iv.cursor = null; iv.end = false; iv.loading = true; } else { iv.loadingMore = true; }
    iv.error = false; rerender();
    const { data, error } = await client.rpc("admin_invite_list", { p_status: iv.status, p_cursor: iv.cursor, p_limit: 25 });
    iv.loading = false; iv.loadingMore = false; iv.loaded = true;
    if (error) { iv.error = true; rerender(); return; }
    const page = Array.isArray(data) ? data : [];
    iv.items = reset ? page : iv.items.concat(page);
    iv.end = page.length < 25;
    const last = page[page.length - 1];
    if (last) iv.cursor = last.created_at;
    rerender();
  }
  function setInviteStatusFilter(status) {
    if (!INVITE_STATUS_FILTERS.some((s) => s.id === status) || state.admin.invites.status === status) return;
    state.admin.invites.status = status;
    loadInvites(true);
  }
  function inviteCreateErrorText(error) {
    const msg = error && error.message;
    return {
      "not authorized": "אין הרשאה ליצור הזמנה מסוג זה.",
      "invalid role": "תפקיד לא תקין.",
      "label too long": "התווית ארוכה מדי (עד 120 תווים).",
      "expiry must be in the future": "תאריך התפוגה חייב להיות בעתיד.",
      "could not generate a unique invite code": "יצירת הקוד נכשלה, נסו שוב.",
    }[msg] || "יצירת ההזמנה נכשלה, נסו שוב.";
  }
  async function createInvite(form) {
    if (!state.user || !(hasPerm(PERM.MEMBER_INVITE) || isAdmin())) return;
    const roleInput = form.querySelector('input[name="role"]:checked');
    const role = roleInput ? roleInput.value : "member";
    const label = String((form.elements.label && form.elements.label.value) || "").trim().slice(0, 120);
    const expiresRaw = String((form.elements.expiresAt && form.elements.expiresAt.value) || "").trim();
    const errors = {};
    if (role !== "member" && role !== "coach") errors.label = "תפקיד לא תקין";
    // COMM-376's own mandate: a coach never even sees the coach radio (see
    // renderPersonInvitesPanel), but the server is the real boundary
    // (admin_invite_create's 202609030008 narrowing) - this is a defensive
    // second check in case that ever drifts, not the enforcement itself.
    if (role === "coach" && !isAdmin()) errors.label = "רק מנהל/ת יכול/ה ליצור הזמנת מאמן/ת";
    let expiresAtIso = null;
    if (expiresRaw) {
      const d = new Date(expiresRaw);
      if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) errors.expiresAt = "תאריך התפוגה חייב להיות בעתיד";
      else expiresAtIso = d.toISOString();
    }
    if (Object.keys(errors).length) return setFieldErrors("communityInviteCreate", errors);
    setFieldErrors("communityInviteCreate", {});
    const { data, error } = await client.rpc("admin_invite_create", { p_role: role, p_label: label || null, p_expires_at: expiresAtIso });
    if (error) return setFieldErrors("communityInviteCreate", { label: inviteCreateErrorText(error) });
    form.reset();
    state.admin.invites.created = data;
    setMessage("ההזמנה נוצרה");
    await loadInvites(true);
  }
  function dismissInviteCreated() { state.admin.invites.created = null; rerender(); }
  async function revokeInvite(inviteId) {
    if (!state.user || !(hasPerm(PERM.MEMBER_INVITE) || isAdmin()) || state.admin.invites.revoking) return;
    state.admin.invites.revoking = inviteId; rerender();
    const { error } = await client.rpc("admin_invite_revoke", { p_invite_id: inviteId });
    state.admin.invites.revoking = null;
    if (error) {
      setMessage(error.message === "already redeemed" ? "לא ניתן לבטל הזמנה שכבר מומשה" : "ביטול ההזמנה נכשל");
      rerender();
      return;
    }
    setMessage("ההזמנה בוטלה");
    await loadInvites(true);
  }
  function renderSharedCodesPanel() {
    if (!(hasPerm(PERM.INVITE_MANAGE_CODES) || isAdmin())) return "";
    const ic = state.admin.inviteCodes;
    const createdHtml = ic.created ? `<div class="chart-card" style="margin-bottom:10px;border:1px solid var(--brass);" data-invite-code-created="1">
      <div class="field-label" style="margin-bottom:4px;">הקוד נוצר - זו הפעם היחידה שהוא יוצג</div>
      <div class="flex gap-10" style="align-items:center;flex-wrap:wrap;">
        <code class="mono" style="font-size:15px;">${esc(ic.created.code)}</code>
        <button class="chip-btn" data-community-action="copy-invite-code" data-code="${esc(ic.created.code)}">העתקה</button>
        <button class="link-btn" data-community-action="dismiss-invite-code-created">סגירה</button>
      </div>
    </div>` : "";
    const form = `<form id="communityInviteCodeCreate" class="chart-card" style="margin-bottom:10px;">
      <div class="field-label" style="margin-bottom:6px;">קוד הצטרפות משותף חדש</div>
      ${field("communityInviteCodeCreate", "maxUses", "מקסימום שימושים", `<input class="text-input" name="maxUses" type="number" min="1" max="1000" placeholder="100"/>`)}
      ${field("communityInviteCodeCreate", "expiresAt", "תפוגה (רשות)", `<input class="text-input" name="expiresAt" type="date"/>`)}
      <button class="chip-btn primary" type="submit" style="margin-top:6px;">יצירת קוד</button>
    </form>`;
    let list;
    if (ic.loading && !ic.items.length) {
      const skRow = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:55%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
      list = `<div class="log-list" aria-busy="true" data-invite-codes-skeleton="1">${skRow.repeat(2)}</div>`;
    } else if (ic.error) {
      list = `<div class="empty">לא ניתן היה לטעון את הקודים.</div>`;
    } else if (!ic.items.length) {
      list = `<div class="empty">אין קודי הצטרפות משותפים עדיין</div>`;
    } else {
      list = `<div class="log-list">${ic.items.map((c) => `<div class="log-row" style="align-items:flex-start;flex-direction:column;gap:6px;" data-invite-code-id="${esc(c.id)}">
        <div class="flex" style="justify-content:space-between;width:100%;">
          <span>${roleCodeLabel(c.role)} · נוצר ${esc(String(c.created_at || "").slice(0, 10))}</span>
          <span class="admin-tag" style="${c.active ? "" : "opacity:.6;"}">${c.active ? "פעיל" : "כבוי"}</span>
        </div>
        <div style="color:var(--steel);font-size:12px;">${Number(c.redemption_count || 0)} מימושים · שימושים ${Number(c.use_count || 0)}${c.max_uses ? "/" + esc(c.max_uses) : ""}${c.expires_at ? " · תפוגה " + esc(String(c.expires_at).slice(0, 10)) : ""}</div>
        <button class="chip-btn"${ic.busy ? " disabled" : ""} data-community-action="invite-code-toggle-active" data-id="${esc(c.id)}" data-active="${c.active ? "0" : "1"}">${c.active ? "כיבוי" : "הפעלה"}</button>
      </div>`).join("")}</div>`;
    }
    return `<div data-invite-codes-panel="1">
      <div class="field-label" style="margin:4px 0 8px;">קודי הצטרפות משותפים</div>
      <div class="footer-note" style="margin-bottom:8px;">כיבוי קוד לא משפיע על מי שכבר הצטרף/ה דרכו - הוא רק מפסיק להתקבל בהצטרפויות חדשות.</div>
      ${createdHtml}${form}${list}
    </div>`;
  }
  function renderPersonInvitesPanel() {
    if (!(hasPerm(PERM.MEMBER_INVITE) || isAdmin())) return "";
    const iv = state.admin.invites;
    const admin = isAdmin();
    const createdHtml = iv.created ? `<div class="chart-card" style="margin-bottom:10px;border:1px solid var(--brass);" data-invite-created="1">
      <div class="field-label" style="margin-bottom:4px;">ההזמנה נוצרה - זו הפעם היחידה שהקוד יוצג</div>
      <div class="flex gap-10" style="align-items:center;flex-wrap:wrap;">
        <code class="mono" style="font-size:15px;">${esc(iv.created.code)}</code>
        <button class="chip-btn" data-community-action="copy-invite-code" data-code="${esc(iv.created.code)}">העתקה</button>
        <button class="link-btn" data-community-action="dismiss-invite-created">סגירה</button>
      </div>
    </div>` : "";
    const form = `<form id="communityInviteCreate" class="chart-card" style="margin-bottom:10px;">
      <div class="field-label" style="margin-bottom:6px;">הזמנה אישית חדשה</div>
      <div class="chip-row" style="margin-bottom:6px;">
        <label class="flex gap-6" style="align-items:center;"><input type="radio" name="role" value="member" checked/> חבר/ה</label>
        ${admin ? `<label class="flex gap-6" style="align-items:center;"><input type="radio" name="role" value="coach"/> מאמן/ת</label>` : `<span class="footer-note">הזמנת מאמן/ת זמינה רק למנהל/ת</span>`}
      </div>
      ${field("communityInviteCreate", "label", "תווית (רשות)", `<input class="text-input" name="label" maxlength="120" placeholder="למשל: שם המוזמן/ת"/>`)}
      ${field("communityInviteCreate", "expiresAt", "תפוגה (רשות)", `<input class="text-input" name="expiresAt" type="date"/>`)}
      <button class="chip-btn primary" type="submit" style="margin-top:6px;">יצירת הזמנה</button>
    </form>`;
    const filters = `<div class="chip-row" style="margin:0 0 10px;">${INVITE_STATUS_FILTERS.map((s) => `<button class="chip-btn${iv.status === s.id ? " selected" : ""}" data-community-action="invite-status-filter" data-status="${s.id}">${s.label}</button>`).join("")}</div>`;
    const rowHtml = (inv) => `<div class="log-row" style="align-items:flex-start;flex-direction:column;gap:4px;" data-invite-id="${esc(inv.id)}">
      <div class="flex" style="justify-content:space-between;width:100%;">
        <span>${esc(inv.label || "(ללא תווית)")} · ${roleCodeLabel(inv.role)}</span>
        <span class="admin-tag">${inviteStatusLabel(inv.status)}</span>
      </div>
      <div style="color:var(--steel);font-size:12px;">נוצר ${esc(String(inv.created_at || "").slice(0, 10))}${inv.expires_at ? " · תפוגה " + esc(String(inv.expires_at).slice(0, 10)) : ""}</div>
      ${inv.status === "redeemed" ? `<div style="color:var(--steel);font-size:12px;">מומש/ה ע"י ${esc(inv.redeemed_by_display_name || inv.redeemed_by_handle || "חבר/ה")} · ${esc(String(inv.redeemed_at || "").slice(0, 10))}</div>` : ""}
      ${inv.status === "pending" ? `<button class="chip-btn danger"${iv.revoking === inv.id ? " disabled" : ""} data-community-action="invite-revoke" data-id="${esc(inv.id)}">ביטול</button>` : ""}
    </div>`;
    let list;
    if (iv.loading && !iv.items.length) {
      const skRow = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:55%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
      list = `<div class="log-list" aria-busy="true" data-person-invites-skeleton="1">${skRow.repeat(3)}</div>`;
    } else if (iv.error) {
      list = `<div class="empty">לא ניתן היה לטעון את ההזמנות.<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="invite-list-retry">ניסיון חוזר</button></div></div>`;
    } else if (!iv.items.length) {
      list = `<div class="empty">עדיין לא נוצרו הזמנות אישיות</div>`;
    } else {
      list = `<div class="log-list">${iv.items.map(rowHtml).join("")}</div>${iv.end ? "" : `<div class="chip-row" style="justify-content:center;margin-top:8px;"><button class="chip-btn" data-community-action="invite-list-more"${iv.loadingMore ? " disabled" : ""}>${iv.loadingMore ? "טוען…" : "טעינת עוד"}</button></div>`}`;
    }
    return `<div data-person-invites-panel="1" style="margin-top:14px;">
      <div class="field-label" style="margin:4px 0 8px;">הזמנות אישיות</div>
      ${createdHtml}${form}${filters}${list}
    </div>`;
  }
  function renderInviteManagement() {
    const shared = renderSharedCodesPanel();
    const person = renderPersonInvitesPanel();
    if (!shared && !person) return "";
    return `<div class="ach-section" style="margin-top:18px;" data-invite-management-section="1">${sectionHead("var(--purple)", "ניהול הזמנות וקודי הצטרפות", true)}${shared}${person}</div>`;
  }
  // ---- Pinned content (COMM-155) --------------------------------------
  // Read is open to every member; pin_set / pin_clear are the only write
  // paths and both check community.content.pin and write admin_actions in
  // one transaction. The cap of 3 is a slot column server-side, so a fourth
  // pin_set raises pin_limit_reached rather than silently succeeding.
  async function loadPins() {
    if (!state.user) { state.admin.pins = []; return; }
    const { data, error } = await client.from("pins")
      .select("id,target_type,target_id,slot,note,created_at")
      .order("slot", { ascending: true });
    state.admin.pins = error ? [] : (data || []);
    state.admin.pinsLoaded = !error;
  }
  // In-flight guard for pin/unpin - a fast double-click on either used to be
  // able to fire the RPC twice before the first response landed. Keyed by
  // action+target (not just target) so a pin and a following unpin on the
  // same target never see each other's flag.
  const pinBusy = {};
  async function pinTarget(targetType, targetId, note) {
    if (!state.user || !hasPerm(PERM.CONTENT_PIN)) return;
    const key = "pin:" + targetType + ":" + targetId;
    if (pinBusy[key]) return;
    pinBusy[key] = true;
    state.admin.pinError = "";
    const { error } = await client.rpc("pin_set", { p_target_type: targetType, p_target_id: targetId, p_note: String(note || "").slice(0, 200) });
    pinBusy[key] = false;
    if (error) {
      state.admin.pinError = (error.message || "") === "pin_limit_reached"
        ? "אפשר להצמיד עד שלושה פריטים. יש לבטל הצמדה קיימת קודם."
        : "לא ניתן היה לעדכן את ההצמדות.";
      return rerender();
    }
    await loadPins();
    setMessage("הפריט הוצמד");
  }
  async function unpinTarget(targetType, targetId) {
    if (!state.user || !hasPerm(PERM.CONTENT_PIN)) return;
    const key = "unpin:" + targetType + ":" + targetId;
    if (pinBusy[key]) return;
    pinBusy[key] = true;
    state.admin.pinError = "";
    const { error } = await client.rpc("pin_clear", { p_target_type: targetType, p_target_id: targetId });
    pinBusy[key] = false;
    if (error) { state.admin.pinError = "לא ניתן היה לעדכן את ההצמדות."; return rerender(); }
    await loadPins();
    setMessage("ההצמדה בוטלה");
  }
  // ---- Admin community analytics dashboard (COMM-310) ------------------
  // One RPC, analytics_dashboard(p_period_start, p_period_end)
  // (202609010006), answers all 18 metrics in docs/community/metrics.md's
  // Core (5) and Additional (13) sections in one call - see that
  // migration's own header comment for the full jsonb shape, mirrored
  // key-for-key by the render functions below. Gated on
  // community.analytics.view or real is_admin(), the same asymmetry
  // recap_monthly_publish() and this file's own canPublish already encode:
  // NARROWER than isStaff(), so a plain coach (isStaff() true) is refused
  // server-side and the nav entry is gated on the permission, never on
  // staffness, to match.
  //
  // Monday-based UTC weeks/months only, matching analytics_week_buckets()'s
  // own TIMEZONE note - this client makes the same "UTC ISO week, not the
  // club's local week" choice the schema half already recorded, not a
  // different one.
  function adminAnalyticsMondayUtc(d) {
    const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = dt.getUTCDay();
    dt.setUTCDate(dt.getUTCDate() + (day === 0 ? -6 : 1 - day));
    return dt;
  }
  function adminAnalyticsIsoDate(d) { return d.toISOString().slice(0, 10); }
  // The resolved {start, end} (both inclusive, matching the RPC's own
  // contract) for whichever week or month contains anchorIso (default:
  // today). Pure - never reads or mutates state - so both the mode switch
  // and the prev/next paging below can share it.
  function adminAnalyticsDefaultPeriod(mode, anchorIso) {
    const anchor = anchorIso ? new Date(anchorIso + "T00:00:00.000Z") : new Date();
    if (mode === "month") {
      const y = anchor.getUTCFullYear(), m = anchor.getUTCMonth();
      const start = new Date(Date.UTC(y, m, 1));
      const end = new Date(Date.UTC(y, m + 1, 0));
      return { start: adminAnalyticsIsoDate(start), end: adminAnalyticsIsoDate(end) };
    }
    const start = adminAnalyticsMondayUtc(anchor);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    return { start: adminAnalyticsIsoDate(start), end: adminAnalyticsIsoDate(end) };
  }
  // The four real Postgres errors analytics_dashboard() raises (the
  // migration's own comment on that function, verbatim), mapped to short
  // Hebrew - the same error.message === "..." pattern
  // MONTHLY_RECAP_ERROR_LABELS above already uses. Any other error
  // (network, a permission revoked mid-session) falls back to COMM-310's
  // own frontend-states copy for the Error state, "לא ניתן היה לטעון את
  // הנתונים." - not a generic retry line invented for this surface.
  const ADMIN_ANALYTICS_ERROR_LABELS = {
    "not authorized": "אין לך הרשאה לצפות בנתונים אלו.",
    "period required": "יש לבחור טווח תאריכים.",
    "period end before start": "תאריך הסיום קודם לתאריך ההתחלה.",
    "period exceeds 366 days": "טווח התאריכים ארוך מדי (מקסימום 366 ימים).",
  };
  function adminAnalyticsErrorText(error) {
    const msg = error && error.message;
    return (msg && ADMIN_ANALYTICS_ERROR_LABELS[msg]) || "לא ניתן היה לטעון את הנתונים.";
  }
  async function loadAdminAnalyticsDashboard() {
    if (!state.user || !(hasPerm(PERM.ANALYTICS_VIEW) || isAdmin())) { state.analytics.dashboard.data = null; return; }
    const a = state.analytics.dashboard;
    if (!a.start || !a.end) Object.assign(a, adminAnalyticsDefaultPeriod(a.mode));
    a.loading = true; a.error = false; a.errorText = "";
    rerender();
    const { data, error } = await client.rpc("analytics_dashboard", { p_period_start: a.start, p_period_end: a.end });
    a.loading = false; a.loaded = true;
    if (error) { a.error = true; a.errorText = adminAnalyticsErrorText(error); rerender(); return; }
    a.data = data || null;
    rerender();
    // COMM-311's own section only ever renders inside this same populated
    // branch (renderAdminAnalyticsDashboard() appends it after the two
    // metrics.md groups, inside the `else` where a.data is truthy) - so its
    // own load only ever needs to fire from this one place, the instant
    // a.data just became truthy, rather than being wired into
    // setAdminAnalyticsMode()/shiftAdminAnalyticsPeriod() separately or
    // into the account tab's own lazy-load gate a second time. That is the
    // "reusing the same period selector and load cycle, not a second nav
    // destination or a second RPC-driven load cycle" COMM-310's own commit
    // message asked a later ticket to do. Not awaited: this function's own
    // render must not wait on an RPC it does not itself depend on.
    loadMemberSegments();
    // COMM-379, same precedent, same reasoning: fires the instant a.data
    // becomes truthy, not awaited, no second period selector.
    loadRegistrationFunnel();
  }
  function setAdminAnalyticsMode(mode) {
    if (mode !== "week" && mode !== "month") return;
    const a = state.analytics.dashboard;
    if (a.mode === mode) return;
    a.mode = mode;
    Object.assign(a, adminAnalyticsDefaultPeriod(mode, a.start));
    loadAdminAnalyticsDashboard();
  }
  // dir < 0 is the previous period, dir > 0 the next one - one week or one
  // calendar month at a time, per the current mode. Anchored off a.start
  // (always day 1 of the month in month mode, always a Monday in week
  // mode), so paging never drifts off that anchor the way adding/
  // subtracting a flat 30 days would.
  function shiftAdminAnalyticsPeriod(dir) {
    const a = state.analytics.dashboard;
    if (!a.start) return;
    const anchor = new Date(a.start + "T00:00:00.000Z");
    if (a.mode === "month") anchor.setUTCMonth(anchor.getUTCMonth() + (dir < 0 ? -1 : 1));
    else anchor.setUTCDate(anchor.getUTCDate() + (dir < 0 ? -7 : 7));
    Object.assign(a, adminAnalyticsDefaultPeriod(a.mode, adminAnalyticsIsoDate(anchor)));
    loadAdminAnalyticsDashboard();
  }
  // ---- Member engagement segmentation (COMM-311) ----------------------
  // member_segments(p_as_of date) (202609010007) takes ONE as-of date, not
  // a range like analytics_dashboard() - so there is no second period
  // selector to build. Instead this reuses COMM-310's own selected period,
  // capped at today: a week or month period's own `end` can be in the
  // future (the current week/month is not over), and member_segments()
  // REFUSES a future as-of date outright rather than clamping it
  // server-side (the migration's own "a clamped date would put a
  // segmentation on screen labelled with a date it was not computed for"
  // note). Capping once here, client-side, is simpler than teaching this
  // section a second period concept only it would use.
  function memberSegmentsAsOf() {
    const todayIso = adminAnalyticsIsoDate(new Date());
    const end = state.analytics.dashboard.end;
    return (end && end < todayIso) ? end : todayIso;
  }
  // The two real Postgres errors member_segments() raises (the migration's
  // own comment on that function, verbatim), mapped to short Hebrew - same
  // error.message === "..." pattern ADMIN_ANALYTICS_ERROR_LABELS uses right
  // above. Anything else (network, a permission revoked mid-session) falls
  // back to COMM-311's own frontend-states copy for the Error state,
  // exactly as written in that ticket: "לא ניתן היה לטעון את הפילוח."
  const MEMBER_SEGMENTS_ERROR_LABELS = {
    "not authorized": "אין לך הרשאה לצפות בפילוח זה.",
    "as-of date is in the future": "לא ניתן להציג פילוח לתאריך עתידי.",
  };
  function memberSegmentsErrorText(error) {
    const msg = error && error.message;
    return (msg && MEMBER_SEGMENTS_ERROR_LABELS[msg]) || "לא ניתן היה לטעון את הפילוח.";
  }
  async function loadMemberSegments() {
    if (!state.user || !(hasPerm(PERM.ANALYTICS_VIEW) || isAdmin())) { state.analytics.segments.data = null; return; }
    const ms = state.analytics.segments;
    const asOf = memberSegmentsAsOf();
    ms.loading = true; ms.error = false; ms.errorText = ""; ms.asOf = asOf;
    rerender();
    const { data, error } = await client.rpc("member_segments", { p_as_of: asOf });
    ms.loading = false; ms.loaded = true;
    if (error) { ms.error = true; ms.errorText = memberSegmentsErrorText(error); rerender(); return; }
    // setof jsonb comes back as a plain array from PostgREST; defensive
    // Array.isArray() guard only, no reshaping - the six-way grouping
    // happens at render time in groupMemberSegments(), never here, the same
    // "server is the one definition" posture data itself already follows.
    ms.data = Array.isArray(data) ? data : [];
    rerender();
  }
  // ---- COMM-379. Registration funnel analytics --------------------------
  // Same gate as the shell itself (community.analytics.view or real
  // is_admin() - registration_funnel()'s own AUTH note says NOT is_staff(),
  // matching analytics_dashboard exactly), so a coach who can browse the
  // roster (COMM-377, is_staff()) is still refused here, the one asymmetry
  // this cluster keeps consistent everywhere it appears.
  const REGISTRATION_FUNNEL_ERROR_LABELS = {
    "not authorized": "אין לך הרשאה לצפות בנתוני ההרשמה.",
    "period required": "יש לבחור טווח תאריכים.",
    "period end before start": "תאריך הסיום קודם לתאריך ההתחלה.",
    "period exceeds 366 days": "טווח התאריכים ארוך מדי (מקסימום 366 ימים).",
  };
  function registrationFunnelErrorText(error) {
    const msg = error && error.message;
    return (msg && REGISTRATION_FUNNEL_ERROR_LABELS[msg]) || "לא ניתן היה לטעון את נתוני ההרשמה.";
  }
  async function loadRegistrationFunnel() {
    if (!state.user || !(hasPerm(PERM.ANALYTICS_VIEW) || isAdmin())) { state.analytics.registrationFunnel.data = null; return; }
    const a = state.analytics.dashboard;
    const rf = state.analytics.registrationFunnel;
    rf.loading = true; rf.error = false; rf.errorText = "";
    rerender();
    const { data, error } = await client.rpc("registration_funnel", { p_period_start: a.start, p_period_end: a.end });
    rf.loading = false; rf.loaded = true;
    if (error) { rf.error = true; rf.errorText = registrationFunnelErrorText(error); rerender(); return; }
    rf.data = data || null;
    rerender();
  }
  // A segment card's own drill-down toggle - independent of anything
  // COMM-310's period selector owns, and never reset by a period change (a
  // card a staff member opened stays open across paging, matching how
  // nothing else on this screen collapses on a period change either).
  function toggleMemberSegment(segment) {
    const ms = state.analytics.segments;
    ms.expanded[segment] = !ms.expanded[segment];
    rerender();
  }
  // ---- Retention correlation views (COMM-313) --------------------------
  // Three security-definer functions (202609010008), all gated on real
  // is_admin() ALONE - see state.analytics.retention's own comment for why that is
  // deliberately narrower than every other section in this cluster.
  // retention_cohorts(p_cohort_months) returns the cohort retention curve
  // itself; retention_onboarding_correlation() and
  // retention_welcome_correlation() take NO parameter at all (both use a
  // fixed 6-month window server-side, named constants the client cannot
  // move) and each return a two-group comparison. p_cohort_months is passed
  // explicitly as 6 here - the same window the two parameter-less
  // correlations are hardcoded to - so all three curves this section can
  // ever show share one x-axis's worth of members, rather than leaving the
  // cohort curve's own window to drift from the two correlations' fixed one
  // by relying on the RPC's own default matching it by coincidence.
  const RETENTION_COHORT_MONTHS = 6;
  // The one real Postgres error all three functions raise (identical
  // message, since the gate is identical) - same error.message === "..."
  // pattern ADMIN_ANALYTICS_ERROR_LABELS/MEMBER_SEGMENTS_ERROR_LABELS use.
  // Anything else (network, a permission revoked mid-session) falls back to
  // COMM-313's own frontend-states copy for the Error state, verbatim:
  // "לא ניתן היה לטעון את נתוני השימור."
  const RETENTION_ERROR_LABELS = {
    "not authorized": "אין לך הרשאה לצפות בנתוני השימור.",
  };
  function retentionErrorText(error) {
    const msg = error && error.message;
    return (msg && RETENTION_ERROR_LABELS[msg]) || "לא ניתן היה לטעון את נתוני השימור.";
  }
  // All three RPCs fire together on one lazy load, not staggered behind a
  // toggle click - COMM-311's own loadMemberSegments() precedent piggybacks
  // on COMM-310's load instead, but this section has no shared parent load
  // to piggyback on (its gate is narrower, so it cannot live inside
  // loadAdminAnalyticsDashboard() without also loosening that gate), so it
  // is its own lazy load wired into the account tab directly, same shape as
  // loadAdminAnalyticsDashboard() itself. The two overlays fetch eagerly
  // alongside the main curve rather than on first toggle: both are cheap,
  // pooled, parameter-less queries, and fetching them only on toggle would
  // mean a second loading state this ticket's own frontend-states list does
  // not name.
  async function loadRetentionCorrelations() {
    if (!state.user || !isAdmin()) { state.analytics.retention.cohorts = []; state.analytics.retention.onboarding = []; state.analytics.retention.welcome = []; return; }
    const r = state.analytics.retention;
    r.loading = true; r.error = false; r.errorText = "";
    rerender();
    const [cohortsRes, onboardingRes, welcomeRes] = await Promise.all([
      client.rpc("retention_cohorts", { p_cohort_months: RETENTION_COHORT_MONTHS }),
      client.rpc("retention_onboarding_correlation"),
      client.rpc("retention_welcome_correlation"),
    ]);
    r.loading = false; r.loaded = true;
    // The cohort curve is this section's primary content - if it fails, the
    // whole section shows COMM-313's own Error state, matching how COMM-310
    // treats its own primary RPC. A correlation cut failing on its own
    // (while the main curve loaded fine) does not blank the section; it just
    // leaves that one overlay with nothing to show, same as an overlay
    // nobody has been stamped with yet - see renderRetentionOnboardingOverlay.
    if (cohortsRes.error) { r.error = true; r.errorText = retentionErrorText(cohortsRes.error); rerender(); return; }
    r.cohorts = Array.isArray(cohortsRes.data) ? cohortsRes.data : [];
    r.onboarding = (!onboardingRes.error && Array.isArray(onboardingRes.data)) ? onboardingRes.data : [];
    r.welcome = (!welcomeRes.error && Array.isArray(welcomeRes.data)) ? welcomeRes.data : [];
    rerender();
  }
  function toggleRetentionOnboardingOverlay() { state.analytics.retention.showOnboarding = !state.analytics.retention.showOnboarding; rerender(); }
  function toggleRetentionWelcomeOverlay() { state.analytics.retention.showWelcome = !state.analytics.retention.showWelcome; rerender(); }
  function setRetentionOnboardingStep(step) {
    if (!RETENTION_ONBOARDING_STEPS.some((s) => s.id === step)) return;
    if (state.analytics.retention.onboardingStep === step) return;
    state.analytics.retention.onboardingStep = step;
    rerender();
  }
  // ---- Community health score (COMM-312) --------------------------------
  // ONE read path: community_health_history(p_weeks default 12) returns
  // setof jsonb, {week_start, score, components} per row - security definer,
  // gated on real is_admin() ALONE (202609010009), same narrower bar as
  // COMM-313's three functions and, like them, NOT the hasPerm(PERM.
  // ANALYTICS_VIEW) || isAdmin() pair COMM-310/311 use. There is no write
  // path reachable from here at all: community_health_generate() is
  // service_role only, revoked from authenticated, so this half is read-only
  // by construction - no "recompute now" button exists here because one
  // would just 42501.
  const COMMUNITY_HEALTH_WEEKS = 12;
  // The one real Postgres error community_health_history() raises, mapped to
  // short Hebrew - same error.message === "..." pattern
  // RETENTION_ERROR_LABELS/MEMBER_SEGMENTS_ERROR_LABELS use. Anything else
  // (network, a permission revoked mid-session) falls back to COMM-312's own
  // frontend-states copy for the Error state, verbatim: "לא ניתן היה לטעון
  // את הציון."
  const COMMUNITY_HEALTH_ERROR_LABELS = {
    "not authorized": "אין לך הרשאה לצפות בציון זה.",
  };
  function communityHealthErrorText(error) {
    const msg = error && error.message;
    return (msg && COMMUNITY_HEALTH_ERROR_LABELS[msg]) || "לא ניתן היה לטעון את הציון.";
  }
  async function loadCommunityHealth() {
    if (!state.user || !isAdmin()) { state.analytics.health.weeks = []; return; }
    const h = state.analytics.health;
    h.loading = true; h.error = false; h.errorText = "";
    rerender();
    const { data, error } = await client.rpc("community_health_history", { p_weeks: COMMUNITY_HEALTH_WEEKS });
    h.loading = false; h.loaded = true;
    if (error) { h.error = true; h.errorText = communityHealthErrorText(error); rerender(); return; }
    // setof jsonb comes back as a plain array from PostgREST; defensive
    // Array.isArray() guard only - the RPC itself already returns it OLDEST
    // FIRST, so nothing here re-sorts it.
    h.weeks = Array.isArray(data) ? data : [];
    rerender();
  }
  // ---- Admin audit view (COMM-154) -----------------------------------
  // Read-only, gated on community.analytics.view. admin_actions_page checks
  // the same permission again inside the function and once more via the
  // table's own select policy, so a client-only gate here changes nothing.
  async function loadAuditLog(reset) {
    if (!state.user || !hasPerm(PERM.ANALYTICS_VIEW)) { state.admin.auditLog = []; return; }
    if (state.admin.auditLoading) return;
    state.admin.auditLoading = true; state.admin.auditError = false;
    if (reset) { state.admin.auditLog = []; state.admin.auditCursor = null; state.admin.auditEnd = false; }
    rerender();
    const filters = {};
    if (state.admin.auditFilters.action_type) filters.action_type = state.admin.auditFilters.action_type;
    if (state.admin.auditFilters.admin_id) filters.admin_id = state.admin.auditFilters.admin_id;
    const { data, error } = await client.rpc("admin_actions_page", { p_cursor: state.admin.auditCursor, p_limit: 25, p_filters: filters });
    state.admin.auditLoading = false;
    state.admin.auditLoaded = true;
    if (error) { state.admin.auditError = true; rerender(); return; }
    const rows = data || [];
    state.admin.auditLog = reset ? rows : state.admin.auditLog.concat(rows);
    state.admin.auditCursor = rows.length ? rows[rows.length - 1].created_at : state.admin.auditCursor;
    state.admin.auditEnd = rows.length < 25;
    rerender();
  }
  function setAuditFilter(key, value) {
    state.admin.auditFilters = Object.assign({}, state.admin.auditFilters);
    if (value) state.admin.auditFilters[key] = value; else delete state.admin.auditFilters[key];
    loadAuditLog(true);
  }
  // ---- Report flow (COMM-151) --------------------------------------
  // A member reports a post or a comment, picks a reason, optionally adds
  // detail, and gets a plain acknowledgement. Nothing about what follows is
  // disclosed. Duplicate reports on the same target by the same member
  // collapse server-side; the reporter count still moves once.
  function openReportSheet(targetType, targetId) {
    if (!state.user) return;
    state.admin.reportSheet = { targetType, targetId, reason: "", note: "", saving: false, error: "", done: false };
    rerender();
  }
  function closeReportSheet() { state.admin.reportSheet = null; rerender(); }
  function setReportReason(reason) { if (state.admin.reportSheet) { state.admin.reportSheet.reason = reason; state.admin.reportSheet.error = ""; rerender(); } }
  async function submitReportSheet() {
    const s = state.admin.reportSheet;
    if (!s || s.saving) return;
    if (!REPORT_REASONS.some((r) => r.id === s.reason)) { s.error = "יש לבחור סיבה"; return rerender(); }
    s.saving = true; s.error = ""; rerender();
    const { error } = await client.rpc("report", {
      p_target_type: s.targetType,
      p_target_id: s.targetId,
      p_reason: s.reason,
      p_note: String(s.note || "").slice(0, 500),
    });
    if (error) {
      s.saving = false;
      s.error = (error.message || "") === "rate_limited"
        ? "יותר מדי דיווחים, נסו שוב בעוד כמה דקות"
        : "לא ניתן היה לשלוח את הדיווח. נסו שוב.";
      return rerender();
    }
    // COMM-151. A post report also records a feed interaction so the ranker
    // learns from it. Comments are not feed items and record nothing.
    if (s.targetType === "post") trackFeedInteraction(s.targetId, "hide");
    // COMM-170. The reason code only. The free-text note is member-authored
    // content about another member and never enters the analytics table.
    track(A.REPORT_SUBMITTED, { target_type: s.targetType, reason: s.reason });
    s.saving = false; s.done = true;
    rerender();
    if (s.targetType === "post") loadFeed();
  }
  const removeMemberBusy = {};
  async function adminRemoveMember(userId) {
    if (!state.user || !isAdmin()) return;
    if (removeMemberBusy[userId]) return;
    removeMemberBusy[userId] = true;
    const { error } = await client.rpc("admin_remove_member", { p_user_id: userId });
    removeMemberBusy[userId] = false;
    if (error) return setMessage("הסרת החבר/ה נכשלה");
    setMessage("החבר/ה הוסר/ה");
    await searchMembers(state.members.search);
  }
  // 2026-09-05 launch-readiness fix. Login emails are synthetic
  // (usernameToEmail() - never a real deliverable address), so there is no
  // self-service "email me a reset link" path. This calls the
  // admin_reset_password Edge Function, which verifies the caller is a
  // real admin server-side (never trusting this client), then uses the
  // Supabase Admin SDK to set a new temporary password - the officially
  // supported way to do that, not a direct write to auth.users. The
  // returned password is shown exactly once (server never stores or
  // re-shows it) so the admin can relay it to the member directly.
  const resetPasswordBusy = {};
  async function adminResetPassword(userId) {
    if (!state.user || !isAdmin()) return;
    if (resetPasswordBusy[userId]) return;
    resetPasswordBusy[userId] = true;
    rerender();
    const { data, error } = await client.functions.invoke("admin_reset_password", { body: { target_user_id: userId } });
    resetPasswordBusy[userId] = false;
    if (error || !data || !data.temp_password) { rerender(); return setMessage("איפוס הסיסמה נכשל"); }
    state.admin.passwordResetResult = { userId, tempPassword: data.temp_password };
    rerender();
  }
  async function publishAchievement(achievementId, title, rule) {
    if (!state.user || !state.profile) return setMessage("התחברו לקהילה כדי לשתף עיטור");
    const payload = { author_id: state.user.id, source_type: "achievement", source_record_id: achievementId, visibility: "followers", title: String(title || "עיטור חדש").slice(0, 120), result_text: String(rule || "עיטור חדש נפתח").slice(0, 240), occurred_on: todayIso() };
    const { error } = await client.from("workout_posts").upsert(payload, { onConflict: "author_id,source_type,source_record_id" });
    if (error) return setMessage("שיתוף העיטור נכשל");
    // COMM-170. The app.js entry point (window.shareAchievementToCommunity),
    // distinct from the unlock sheet below and never both in one action.
    track(A.ACHIEVEMENT_SHARED, { member_achievement_id: null, code: null, source: "app_share_button" });
    await loadFeed(); setMessage("העיטור שותף לעוקבים שלכם"); rerender();
  }
  async function uploadPostPhoto(file) {
    if (!file || !state.user) return null;
    const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
    const path = `${state.user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await client.storage.from("post-photos").upload(path, file, { contentType: file.type, upsert: false });
    return error ? null : path;
  }
  async function resolvePhotoUrl(path) {
    if (!path || photoUrlCache[path]) return;
    const { data, error } = await client.storage.from("post-photos").createSignedUrl(path, 3600);
    if (!error && data) { photoUrlCache[path] = data.signedUrl; rerender(); }
  }
  // ==========================================================================
  // COMM-110..115  feed cluster.
  // Ranking, diversity and the page boundary all live in public.feed_page()
  // (migration 202608280019). Everything below consumes that function: it
  // renders the rows in the order they arrived, asks for the next page with
  // the opaque cursor the function handed back, and measures what was shown.
  // It never re-scores and never re-sorts - a client that re-sorted a ranked
  // list would be disagreeing with the server about what the member has
  // already seen, which is exactly what the impression stream is for.
  // ==========================================================================

  const FEED_PAGE_SIZE = 20;              // COMM-113: 20 first load, 20 per page
  const FEED_IMPRESSION_BATCH = 50;       // the server caps one call at 50 rows
  const FEED_IMPRESSION_DWELL_MS = 1000;  // COMM-114: half visible for one second
  // COMM-111. Order matters, the first entry is the default.
  const FEED_SCOPES = [
    { id: "for_you", label: "בשבילך", empty: "פעילות המועדון תופיע כאן." },
    { id: "following", label: "אחרי מי שאני עוקב/ת", empty: "אין עדיין פוסטים ממי שאתם עוקבים אחריו." },
    { id: "achievements", label: "הישגים", empty: "אין עדיין הישגים לשתף." },
    { id: "coach", label: "פוסטים מהמאמנים", empty: "אין עדיין פוסטים מהמאמנים." },
    // COMM-P01. The scope exists on both sides and answers empty on the
    // server; the chip is rendered disabled until an attendance source is
    // picked, so nobody can reach a filter with nothing behind it.
    { id: "my_classes", label: "השיעורים שלי", empty: "", parked: true },
  ];
  function feedScopeDef(id) { return FEED_SCOPES.find((s) => s.id === id) || FEED_SCOPES[0]; }

  function newFeedId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    // jsdom and older WebViews. Only ever used as a correlation key.
    const hex = "0123456789abcdef";
    let out = "";
    for (let i = 0; i < 36; i++) out += (i === 8 || i === 13 || i === 18 || i === 23) ? "-" : hex[Math.floor(Math.random() * 16)];
    return out;
  }

  // A feed session is one continuous read of one scope: the first page plus
  // every "load more" after it. A new session starts on a scope change, a
  // refresh, or a sign-in - and the previous session's impressions are
  // flushed before the new id is minted, so a row can never be attributed to
  // the wrong session.
  function startFeedSession() {
    flushFeedImpressions();
    state.feed.sessionId = newFeedId();
    state.feed.seen = {};
  }

  // COMM-110/113. One page. The cursor is opaque: the client stores it and
  // hands it back, it never parses or derives one.
  async function fetchFeedPage() {
    const { data, error } = await client.rpc("feed_page", {
      p_cursor: state.feed.cursor,
      p_limit: FEED_PAGE_SIZE,
      p_scope: state.feed.scope,
    });
    if (error) return false;
    const rows = Array.isArray(data) ? data : (data ? [data] : []);
    // Appended in the order feed_page returned them. No sort, no filter, no
    // re-ordering of any kind on this side.
    for (const row of rows) state.feed.items.push(row);
    state.feed.pagesLoaded += 1;
    const next = rows.length ? rows[rows.length - 1].next_cursor : null;
    state.feed.cursor = next || null;
    state.feed.end = !next;
    for (const row of rows) {
      if (row && row.photo_path) resolvePhotoUrl(row.photo_path);
      for (const m of (row && row.media) || []) if (m && m.storage_path && !m.url) resolvePhotoUrl(m.storage_path);
    }
    // COMM-160. The post author coach badge reads the same cached server
    // role set the comments do. One lookup per page; a re-render follows
    // when it resolves so the badge is not gated on the feed round-trip.
    if (rows.length) loadMemberRoles(rows.map((r) => r && r.author_id)).then(() => rerender());
    return true;
  }

  // Reloads the feed from the top as a fresh session. It restores however
  // many pages were already loaded, so a caller that just reacted or
  // commented deep in the list does not get collapsed back to twenty items.
  async function loadFeed() {
    if (!state.user) return;
    const pages = Math.max(1, state.feed.pagesLoaded || 1);
    startFeedSession();
    state.ui.loading = true;
    state.feed.loading = true;
    state.feed.error = false;
    state.feed.moreError = false;
    state.feed.items = [];
    state.feed.cursor = null;
    state.feed.end = false;
    state.feed.pagesLoaded = 0;
    let ok = true;
    for (let i = 0; i < pages; i++) {
      ok = await fetchFeedPage();
      if (!ok || state.feed.end) break;
    }
    state.feed.error = !ok;
    state.ui.message = ok ? "" : "לא ניתן לטעון את הקהילה כרגע";
    state.feed.loading = false;
    state.ui.loading = false;
  }

  // COMM-113. The "load more" control and the intersection sentinel both
  // land here. Earlier items are kept on failure, per the ticket.
  async function loadMoreFeed() {
    if (!state.user || state.feed.loadingMore || state.feed.end || !state.feed.cursor) return;
    state.feed.loadingMore = true;
    state.feed.moreError = false;
    rerender();
    const ok = await fetchFeedPage();
    state.feed.moreError = !ok;
    state.feed.loadingMore = false;
    rerender();
  }

  // COMM-111. Switching a filter is a new feed session, not a re-filter of
  // what is already in memory: the ranking is per scope and only the server
  // knows it.
  function setFeedScope(scope) {
    const def = FEED_SCOPES.find((s) => s.id === scope);
    if (!def || def.parked || def.id === state.feed.scope) return;
    state.feed.scope = def.id;
    state.feed.pagesLoaded = 0;
    // COMM-170. A scope change is a new read of the feed, so it is a second
    // feed_viewed, distinguished from the tab entry by `source`. It is not
    // tracked in loadFeed(), which also runs after a reaction, a comment or
    // a block, none of which is a member viewing the feed.
    track(A.FEED_VIEWED, { scope: def.id, source: "scope_change" });
    loadFeed().then(rerender);
    rerender();
  }

  // COMM-115. Club name, mark, member count, the active challenge shortcut
  // and the unread notification count, in one call.
  async function loadClubSummary() {
    if (!state.user) return;
    const { data, error } = await client.rpc("club_summary");
    state.club.row = error ? null : (data || null);
  }

  // --- COMM-114 impressions and interactions --------------------------------
  // A card counts as seen once it has been at least half visible for a
  // second. Rows queue up and are written in one batched call per feed
  // session (or per 50 rows, which is the server's cap), never on the render
  // path - nothing here is awaited by anything that draws.
  function noteFeedImpression(postId, position) {
    if (!postId || !state.feed.sessionId) return;
    if (state.feed.seen[postId]) return;
    state.feed.seen[postId] = true;
    // COMM-170. The ranking pipeline reads feed_impressions (COMM-114);
    // the product metric reads analytics_events. Two tables, two consumers,
    // one trigger - and the state.feed.seen guard above is what makes both
    // of them exactly once per post per feed session.
    track(A.POST_IMPRESSION, { post_id: postId, position: Math.max(0, Number(position) || 0), feed_session_id: state.feed.sessionId });
    state.feed.pending.push({
      post_id: postId,
      position: Math.max(0, Number(position) || 0),
      feed_session_id: state.feed.sessionId,
      shown_at: new Date().toISOString(),
    });
    if (state.feed.pending.length >= FEED_IMPRESSION_BATCH) flushFeedImpressions();
  }
  function flushFeedImpressions() {
    if (!client || !state.user || !state.feed.pending.length) return;
    const rows = state.feed.pending;
    state.feed.pending = [];
    for (let i = 0; i < rows.length; i += FEED_IMPRESSION_BATCH) {
      const chunk = rows.slice(i, i + FEED_IMPRESSION_BATCH);
      try { Promise.resolve(client.rpc("feed_record_impressions", { p_rows: chunk })).catch(() => {}); } catch (e) {}
    }
  }
  const FEED_INTERACTION_KINDS = ["open", "react", "comment", "share", "hide", "save", "profile_open"];
  // Fire and forget. A failed measurement must never surface as a failed
  // action, so nothing here is awaited and nothing here sets a message.
  function trackFeedInteraction(postId, kind) {
    if (!client || !state.user || !postId) return;
    if (FEED_INTERACTION_KINDS.indexOf(kind) < 0) return;
    try { Promise.resolve(client.rpc("feed_record_interaction", { p_post_id: postId, p_kind: kind })).catch(() => {}); } catch (e) {}
  }
  // Exposed so a later share affordance on a card (posts cluster) can record
  // the `share` kind without reaching into the feed's internals.
  window.trackFeedInteraction = trackFeedInteraction;

  // Which click on a card counts as which interaction. The post id is taken
  // from the enclosing card, so the same action name used outside the feed
  // (a profile opened from member search, say) records nothing.
  const FEED_ACTION_KINDS = {
    "cheer": "react",
    "toggle-comments": "open",
    "post-hide": "hide",
    "post-save": "save",
    "view-profile": "profile_open",
  };
  function trackFeedClick(el) {
    const kind = FEED_ACTION_KINDS[el && el.dataset && el.dataset.communityAction];
    if (!kind) return;
    const card = el.closest && el.closest("[data-post-id]");
    if (!card) return;
    trackFeedInteraction(card.getAttribute("data-post-id"), kind);
  }

  // The observer is rebuilt on every render because the card elements are
  // replaced wholesale by rerender(). Without IntersectionObserver (jsdom,
  // very old WebViews) a rendered card is counted after the same dwell,
  // which is the honest fallback: the environment cannot report visibility.
  let feedObserver = null;
  const feedDwellTimers = {};
  function observeFeedImpressions() {
    if (!state.user || !state.feed.sessionId) return;
    if (feedObserver) { try { feedObserver.disconnect(); } catch (e) {} feedObserver = null; }
    const cards = Array.prototype.slice.call(document.querySelectorAll("#communityFeedList [data-post-id]"));
    if (!cards.length) return;
    const positionOf = (el) => {
      const id = el.getAttribute("data-post-id");
      const idx = state.feed.items.findIndex((p) => p && String(p.id) === id);
      return idx < 0 ? 0 : idx;
    };
    if (typeof window.IntersectionObserver !== "function") {
      for (const el of cards) {
        const id = el.getAttribute("data-post-id");
        if (state.feed.seen[id] || feedDwellTimers[id]) continue;
        feedDwellTimers[id] = setTimeout(() => {
          delete feedDwellTimers[id];
          noteFeedImpression(id, positionOf(el));
        }, FEED_IMPRESSION_DWELL_MS);
      }
      return;
    }
    feedObserver = new window.IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = entry.target.getAttribute("data-post-id");
        if (!id) continue;
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
          if (state.feed.seen[id] || feedDwellTimers[id]) continue;
          feedDwellTimers[id] = setTimeout(() => {
            delete feedDwellTimers[id];
            noteFeedImpression(id, positionOf(entry.target));
          }, FEED_IMPRESSION_DWELL_MS);
        } else if (feedDwellTimers[id]) {
          clearTimeout(feedDwellTimers[id]);
          delete feedDwellTimers[id];
        }
      }
    }, { threshold: [0.5] });
    for (const el of cards) feedObserver.observe(el);
  }

  // COMM-113. The sentinel triggers the next page before the member reaches
  // the end of the list. The button under it is the same call, for anyone
  // without IntersectionObserver or reaching it by keyboard.
  let feedSentinelObserver = null;
  function observeFeedSentinel() {
    if (feedSentinelObserver) { try { feedSentinelObserver.disconnect(); } catch (e) {} feedSentinelObserver = null; }
    const sentinel = document.getElementById("communityFeedSentinel");
    if (!sentinel || typeof window.IntersectionObserver !== "function") return;
    feedSentinelObserver = new window.IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMoreFeed();
    }, { rootMargin: "200px" });
    feedSentinelObserver.observe(sentinel);
  }
  // ==========================================================================
  // COMM-120..125  engagement cluster: reactions, comments, replies, mentions,
  // coach comment emphasis, block effects. The post card (posts cluster) only
  // exposes the `cheer` / `toggle-comments` hooks and a slot that renders
  // renderComments(post); everything below is engagement-owned.
  // ==========================================================================

  const COMMENT_BODY_MAX = 1000;
  const MENTION_MAX = 10;
  const REACTOR_AVATARS_SHOWN = 5;
  // @[Display Name](uuid). Stored verbatim in the comment body and resolved to
  // a profile link on render. Keyed by member id, so a later display-name
  // change keeps the link pointing at the right member (COMM-123).
  const MENTION_MARKER_RE = /@\[([^\]\n]{1,200})\]\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)/g;

  function commentKey(postId, parentId) { return parentId ? String(postId) + ":" + String(parentId) : String(postId); }
  function selfDisplayName() {
    return (state.profile && (state.profile.display_name || (state.profile.handle ? "@" + state.profile.handle : ""))) || "אני";
  }
  function extractMentions(body) {
    const re = new RegExp(MENTION_MARKER_RE.source, "g");
    const seen = {};
    const out = [];
    let m;
    while ((m = re.exec(body))) {
      if (seen[m[2]]) continue;
      seen[m[2]] = true;
      out.push({ user_id: m[2], name: m[1] });
      if (out.length >= MENTION_MAX) break;
    }
    return out;
  }
  function mentionMarkersToHtml(body) {
    return esc(String(body == null ? "" : body)).replace(new RegExp(MENTION_MARKER_RE.source, "g"),
      function (full, name, id) {
        return '<button type="button" class="link-btn mention-chip" data-community-action="view-profile" data-id="' + id + '" style="padding:0;font-weight:700;color:var(--blue);">@' + name + "</button>";
      });
  }

  // COMM-125. A block edge in EITHER direction hides that member's comments
  // and reaction avatars from the viewer. feed_page already anti-joins blocked
  // authors server-side; this is the comment and reaction read half, a client
  // echo of the same rule rather than the enforcement point.
  async function loadBlockedIds() {
    if (!state.user) { state.members.blockedIds = []; state.members.blocksLoaded = true; return; }
    const ids = {};
    const a = await client.from("blocks").select("blocked_id").eq("blocker_id", state.user.id);
    for (const r of (a.data || [])) ids[r.blocked_id] = true;
    const b = await client.from("blocks").select("blocker_id").eq("blocked_id", state.user.id);
    for (const r of (b.data || [])) ids[r.blocker_id] = true;
    state.members.blockedIds = Object.keys(ids);
    state.members.blocksLoaded = true;
  }
  function isBlockedUser(userId) { return !!userId && state.members.blockedIds.indexOf(userId) >= 0; }

  // ---- Reactions (COMM-120) ----------------------------------------------

  function reactionState(postId) {
    if (state.engagement.reactions[postId]) return state.engagement.reactions[postId];
    const row = findFeedPost(postId);
    const count = row ? Number((row.reaction_count != null ? row.reaction_count : row.cheer_count) || 0) : 0;
    return { loaded: false, mine: false, list: [], count: count };
  }
  function ensureReactionsLoaded(postId) {
    if (!postId || state.engagement.reactions[postId]) return;
    state.engagement.reactions[postId] = { loaded: false, loading: true, mine: false, list: [], count: reactionState(postId).count };
    loadReactionsFor(postId);
  }
  async function loadReactionsFor(postId) {
    const { data, error } = await client.from("reactions")
      .select("user_id,profiles(handle,display_name,avatar_url)")
      .eq("post_id", postId).eq("kind", "cheer").order("created_at", { ascending: true }).limit(200);
    if (error) { delete state.engagement.reactions[postId]; return; }
    const rows = data || [];
    state.engagement.reactions[postId] = {
      loaded: true,
      mine: !!(state.user && rows.some((r) => r.user_id === state.user.id)),
      list: rows.map((r) => ({ id: r.user_id, name: r.profiles ? (r.profiles.display_name || "@" + r.profiles.handle) : "", avatar_url: r.profiles ? r.profiles.avatar_url : null })),
      count: rows.length,
    };
    rerender();
  }
  function syncFeedReactionCount(postId, count) {
    const row = findFeedPost(postId);
    if (row) { row.reaction_count = count; row.cheer_count = count; }
  }
  async function react(postId) {
    if (!state.user) return;
    const before = reactionState(postId);
    const wasMine = !!before.mine;
    const others = (before.list || []).filter((r) => r.id !== state.user.id);
    // Optimistic. Tap adds, tap again removes; the button and the avatar
    // strip both reflect it before the server answers (COMM-120).
    const optimistic = {
      loaded: before.loaded,
      mine: !wasMine,
      list: wasMine ? others : [{ id: state.user.id, name: selfDisplayName() }].concat(others),
      count: Math.max(0, before.count + (wasMine ? -1 : 1)),
    };
    state.engagement.reactions[postId] = optimistic;
    syncFeedReactionCount(postId, optimistic.count);
    state.engagement.reactionError = null;
    rerender();
    const { error } = await client.rpc("toggle_reaction", { p_post_id: postId });
    if (error) {
      state.engagement.reactions[postId] = before;
      syncFeedReactionCount(postId, before.count);
      state.engagement.reactionError = postId;
      setMessage(error.message === "rate_limited" ? "יותר מדי לחיצות, נסו שוב בעוד כמה דקות" : "לא ניתן היה להגיב כרגע");
      rerender();
      return;
    }
    if (!wasMine && window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.REACTION_CREATED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.REACTION_CREATED, { post_id: postId }); } catch (e) {}
    }
    loadReactionsFor(postId);
  }

  // ---- Comments and replies (COMM-121, COMM-122, COMM-124) --------------

  async function loadCommentsFor(postId) {
    // The embed names its foreign key explicitly. post_comments has TWO
    // references to profiles - author_id and the deleted_by column added by
    // 202608280021 - so a bare `profiles(...)` is ambiguous and PostgREST
    // refuses the whole request with PGRST201 (HTTP 300) rather than
    // picking one. Comments have therefore never loaded since that
    // migration shipped: every thread came back as the empty `error ? []`
    // branch below. Invisible to the Node suite, which does not model
    // PostgREST embedding at all. The result key stays `profiles`, which is
    // what the comment renderers read.
    const { data, error } = await client.from("post_comments")
      .select("id,body,created_at,edited_at,deleted_at,status,author_id,parent_comment_id,profiles!post_comments_author_id_fkey(handle,display_name,avatar_url)")
      .eq("post_id", postId).order("created_at", { ascending: true }).limit(400);
    const rows = error ? [] : (data || []);
    state.engagement.comments[postId] = rows;
    await loadMemberRoles(rows.map((c) => c.author_id));
    rerender();
  }
  // COMM-124 / COMM-160. The coach badge on every surface a member is shown
  // (comment, feed post author, profile header, people search, member
  // directory) is driven by the server role set, never a client guess:
  // invite_redemptions.role for each user id, looked up once and cached.
  // Batched so a feed page or a comment thread is a single query.
  //
  // POST-PHASE-3 FIX. This used to be a direct
  // client.from("invite_redemptions").select(...).in("user_id", need) read.
  // invite_redemptions has carried exactly one SELECT policy since Phase 0
  // (202608270003), own-row only, never widened - so that read could only
  // ever return the CALLER's own row; every other id in `need` came back
  // silently absent under real RLS, and the coach badge this function backs
  // has been unable to identify anyone but the viewer themselves since it
  // was built. Invisible to this repo's own tests, because mockSupabase.mjs's
  // plain `.from()` reads carry no RLS simulation. Now calls
  // member_roles(uuid[]), a definer function added specifically for this
  // (202609010011) that returns only {user_id, role} for the requested ids -
  // never the whole table, never redeemed_at or code.
  function memberRole(userId) { return (userId && state.members.roles[userId]) || null; }
  function isCoachRole(role) { return role === "coach" || role === "head_coach"; }
  async function loadMemberRoles(ids) {
    const need = [];
    for (const id of ids || []) if (id && !(id in state.members.roles)) need.push(id);
    if (!need.length) return;
    for (const id of need) state.members.roles[id] = null;
    const { data } = await client.rpc("member_roles", { p_ids: need });
    for (const r of (data || [])) state.members.roles[r.user_id] = r.role || null;
  }
  function toggleComments(postId) {
    if (state.engagement.openComments[postId]) { delete state.engagement.openComments[postId]; rerender(); return; }
    state.engagement.openComments[postId] = true;
    // COMM-170. Opening the thread is what "opened a post" means on this
    // feed - there is no separate post detail view in V1. The early return
    // above is what keeps a close from counting as a second open.
    const opened = findFeedPost(postId);
    track(A.POST_OPENED, { post_id: postId, post_type: (opened && opened.post_type) || null, source: "feed" });
    if (!state.members.blocksLoaded) loadBlockedIds().then(rerender);
    if (!state.engagement.comments[postId]) loadCommentsFor(postId); else rerender();
  }
  function commentErrorMessage(error) {
    const msg = (error && error.message) || "";
    if (msg === "rate_limited") return "יותר מדי תגובות, נסו שוב בעוד כמה דקות";
    if (msg === "posting_restricted") return "החשבון שלכם מוגבל כרגע משליחת תגובות";
    if (/depth is capped|already has replies/.test(msg)) return "אי אפשר להשיב לתשובה. אפשר להגיב על התגובה המקורית";
    if (/another post/.test(msg)) return "התגובה שאליה ניסיתם להשיב שייכת לפוסט אחר";
    if (/no longer available|not found/.test(msg)) return "התגובה שאליה ניסיתם להשיב כבר אינה זמינה";
    return "שליחת התגובה נכשלה";
  }
  // COMM-123. Resolve @[Name](id) markers before the write: a member whose
  // allow_mentions is off, or on either side of a block edge, is stripped
  // back to plain "@Name" text and never enters the mention signal.
  async function resolveCommentMentions(body) {
    let stored = body;
    const allowed = [];
    for (const mn of extractMentions(body)) {
      let ok = false;
      try { ok = await canViewProfileField(mn.user_id, "allow_mentions"); } catch (e) { ok = false; }
      if (ok && !isBlockedUser(mn.user_id)) allowed.push(mn);
      else stored = stored.split("@[" + mn.name + "](" + mn.user_id + ")").join("@" + mn.name);
    }
    return { stored: stored, mentions: allowed };
  }
  async function addComment(postId, form, parentCommentId) {
    if (!state.user) return;
    const key = commentKey(postId, parentCommentId || null);
    const raw = String((form.elements && form.elements.body && form.elements.body.value) || "");
    const body = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim().slice(0, COMMENT_BODY_MAX);
    if (!body) return;
    // The draft is held in state until the server confirms the write, so a
    // failed send never drops what the member typed (COMM-121).
    state.engagement.commentDrafts[key] = raw;
    delete state.engagement.commentErrors[key];
    state.engagement.commentSending = key;
    state.engagement.mentionPicker = null;
    rerender();

    const resolved = await resolveCommentMentions(body);
    const { data, error } = await client.rpc("add_post_comment", { p_post_id: postId, p_body: resolved.stored, p_parent_comment_id: parentCommentId || null });
    state.engagement.commentSending = null;
    if (error) {
      state.engagement.commentErrors[key] = commentErrorMessage(error);
      rerender();
      return;
    }
    delete state.engagement.commentDrafts[key];
    delete state.engagement.commentErrors[key];
    if (parentCommentId) { state.engagement.openReplies[parentCommentId] = true; state.engagement.replyTo[postId] = null; }
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.COMMENT_CREATED) {
      try {
        window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.COMMENT_CREATED, {
          post_id: postId, comment_id: data || null, parent_comment_id: parentCommentId || null,
          author_id: state.user.id, mentions: resolved.mentions,
        });
      } catch (e) {}
    }
    if (typeof form.reset === "function") form.reset();
    await loadCommentsFor(postId);
    await loadFeed();
  }
  function retryComment(postId, parentId) {
    const key = commentKey(postId, parentId || null);
    const draft = state.engagement.commentDrafts[key];
    if (draft == null) return;
    addComment(postId, { elements: { body: { value: draft } }, reset: function () {} }, parentId || null);
  }
  async function deleteComment(commentId, postId) {
    if (!state.user) return;
    const list = state.engagement.comments[postId] || [];
    const target = list.find((c) => c.id === commentId);
    // post_comments_delete_self is author-only. A moderator removal is a
    // status change through mod_review (COMM-153), not a client delete, so it
    // is not offered here.
    if (target && target.author_id !== state.user.id) return;
    const snapshot = list.slice();
    state.engagement.comments[postId] = list.filter((c) => c.id !== commentId);
    rerender();
    const { error } = await client.from("post_comments").delete().eq("id", commentId).eq("author_id", state.user.id);
    if (error) {
      state.engagement.comments[postId] = snapshot;
      setMessage("מחיקת התגובה נכשלה");
      rerender();
      return;
    }
    await loadCommentsFor(postId);
    await loadFeed();
  }
  function startCommentEdit(commentId, postId) {
    const list = state.engagement.comments[postId] || [];
    const c = list.find((x) => x.id === commentId);
    if (!c || c.author_id !== (state.user && state.user.id)) return;
    state.engagement.commentEdit = { commentId: commentId, postId: postId, body: String(c.body || ""), saving: false, error: "" };
    state.engagement.mentionPicker = null;
    rerender();
  }
  function cancelCommentEdit() { state.engagement.commentEdit = null; rerender(); }
  async function saveCommentEdit() {
    const e = state.engagement.commentEdit;
    if (!e || e.saving) return;
    const body = String(e.body || "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim().slice(0, COMMENT_BODY_MAX);
    if (!body) { e.error = "אי אפשר לשמור תגובה ריקה"; rerender(); return; }
    const resolved = await resolveCommentMentions(body);
    e.saving = true; e.error = ""; rerender();
    const list = state.engagement.comments[e.postId] || [];
    const target = list.find((x) => x.id === e.commentId);
    const prev = target ? { body: target.body, edited_at: target.edited_at } : null;
    if (target) { target.body = resolved.stored; target.edited_at = new Date().toISOString(); }
    rerender();
    const { error } = await client.rpc("comment_edit", { p_comment_id: e.commentId, p_body: resolved.stored });
    if (error) {
      if (target && prev) { target.body = prev.body; target.edited_at = prev.edited_at; }
      e.saving = false;
      e.error = error.message === "rate_limited" ? "יותר מדי עריכות, נסו שוב בעוד כמה דקות"
        : error.message === "posting_restricted" ? "החשבון שלכם מוגבל כרגע מעריכת תגובות"
        : "לא ניתן היה לשמור את העריכה";
      rerender();
      return;
    }
    state.engagement.commentEdit = null;
    await loadCommentsFor(e.postId);
  }
  // COMM-151. Opens the reason sheet for a comment. The write goes through
  // the same report() RPC as a post, with p_target_type 'comment'.
  function reportComment(commentId) { openReportSheet("comment", commentId); }

  // ---- Mention picker (COMM-123) ---------------------------------------

  function onCommentInput(input) {
    const key = input.dataset.commentKey;
    state.engagement.commentDrafts[key] = input.value;
    const caret = input.selectionStart == null ? input.value.length : input.selectionStart;
    const m = /(?:^|\s)@([^\s@]{0,30})$/.exec(input.value.slice(0, caret));
    if (m) {
      const q = m[1];
      const active = state.engagement.mentionPicker && state.engagement.mentionPicker.key === key;
      if (active && state.engagement.mentionPicker.query === q) return;
      state.engagement.mentionPicker = { key: key, query: q, results: active ? state.engagement.mentionPicker.results : [], loading: true, index: 0 };
      searchMentionPeople(key, q);
      rerender();
      restoreCommentFocus(key, caret);
    } else if (state.engagement.mentionPicker && state.engagement.mentionPicker.key === key) {
      state.engagement.mentionPicker = null;
      rerender();
      restoreCommentFocus(key, caret);
    }
  }
  async function searchMentionPeople(key, query) {
    const q = String(query || "").trim().replace(/[%_,()]/g, "");
    let results = [];
    if (q.length >= 1 && state.user) {
      const { data } = await client.from("profiles")
        .select("id,handle,display_name,avatar_url,allow_mentions")
        .or("handle.ilike.%" + q + "%,display_name.ilike.%" + q + "%")
        .neq("id", state.user.id).limit(6);
      results = (data || []).filter((p) => !isBlockedUser(p.id));
    }
    if (state.engagement.mentionPicker && state.engagement.mentionPicker.key === key) {
      state.engagement.mentionPicker.results = results;
      state.engagement.mentionPicker.loading = false;
      rerender();
      restoreCommentFocus(key, null);
    }
  }
  function mentionPick(key, id, name) {
    const cur = state.engagement.commentDrafts[key] || "";
    const replaced = cur.replace(/(^|\s)@([^\s@]*)$/, function (full, pre) { return pre + "@[" + name + "](" + id + ") "; });
    state.engagement.commentDrafts[key] = replaced === cur ? cur + "@[" + name + "](" + id + ") " : replaced;
    state.engagement.mentionPicker = null;
    rerender();
    restoreCommentFocus(key, state.engagement.commentDrafts[key].length);
  }
  function restoreCommentFocus(key, caret) {
    setTimeout(function () {
      const el = document.querySelector('[data-comment-input][data-comment-key="' + key + '"]');
      if (!el) return;
      el.focus();
      if (caret != null) { try { el.setSelectionRange(caret, caret); } catch (e) {} }
    }, 0);
  }
  // No real email is ever collected or sent - a synthetic, RFC 2606
  // "invalid" address is built locally from a username purely so
  // Supabase's password-auth provider (which requires an email-shaped
  // identifier) has something to key on. Login/signup are both a plain
  // in-app form submit, no redirect anywhere - the exact problem
  // magic-link email had (opening in the phone's default browser,
  // disconnected from the installed home-screen app) doesn't apply here.
  function usernameToEmail(username) { return `${username}@members.haimuniya.invalid`; }
  const USERNAME_RE = /^[a-z0-9_]{3,24}$/;

  // A brand-new member starts anonymous (zero typing) purely so
  // redeem_invite_code has a session to attach the redemption to - this
  // identity is upgraded to a real username+password account (same
  // auth.uid(), same redemption/profile - see setCredentials) before
  // profile completion, never left as the permanent identity.
  //
  // Two independent callers reach this now: startSignup() below (explicit
  // click), and maybeAutoStartBackup() (fires on the member's first local
  // write, no click at all - see that function's comment for why this
  // does not reopen the "nothing happens silently" concern the removed
  // on-load version raised). Both share the exact same session; whichever
  // fires first wins, the guard below makes the second call a no-op.
  let anonSignInAttempted = false;
  async function ensureAnonymousSession() {
    if (!client || state.user || anonSignInAttempted) return;
    anonSignInAttempted = true;
    const { error } = await client.auth.signInAnonymously();
    if (error) { setMessage("לא ניתן להתחבר לקהילה כרגע, נסו לרענן את הדף"); return; }
    // onAuthStateChange below picks up the new session and loads everything.
  }
  function startSignup() { state.signupStarted = true; ensureAnonymousSession(); rerender(); }

  // Private-backup-to-cloud is opt-out, not opt-in - see PRIVACY.md. Distinct
  // from cloudSyncEnabled (which is the actual on/off switch flushOutbox()
  // checks): this only remembers that the member explicitly declined, so
  // maybeAutoStartBackup()/enableSyncIfAllowed() never re-enable it behind
  // their back after they turned it off in Settings.
  const BACKUP_OPTOUT_KEY = "haimunia-demo:backupOptOut";
  function backupOptedOut() { return localStorage.getItem(BACKUP_OPTOUT_KEY) === "1"; }
  // Turns cloudSyncEnabled on the moment any session exists (anonymous
  // backup-only, or a real community member), unless the member opted out.
  // Only ever flips it on - going forward, never touches history already
  // sitting unsynced in IndexedDB. That's still what the "migrate"/"sync
  // private history" action is for.
  function enableSyncIfAllowed() {
    if (state.syncEnabled || backupOptedOut()) return;
    state.syncEnabled = true;
    localStorage.setItem("haimunia-demo:cloudSyncEnabled", "1");
  }
  // COMM sync-loss fix (iOS 7-day IndexedDB eviction). Fires on the
  // member's first local write (queueSyncRecord's haimunia-sync-needed
  // event), not on app load - creating a cloud account for a visit that
  // never records a workout has no upside and a real cost (an
  // auth.users row + a private_records writer that will never write
  // anything). By the time this fires there is real data to protect, and
  // the ensureAnonymousSession() guard makes it a no-op for anyone who
  // already has a session, backup-only or otherwise.
  function maybeAutoStartBackup() {
    if (!client || state.user || backupOptedOut()) return;
    ensureAnonymousSession();
  }

  // COMM-016. Community RLS (is_community_member()) requires
  // profiles.recovery_verified_at, and mark_recovery_verified() is the
  // only client-reachable way to set it - the RPC refuses unless Supabase
  // Auth itself confirms a real email plus password on the user, so the
  // gate cannot be self-certified from the client. It is idempotent, so a
  // retry after a transient failure is safe. Called once the profile row
  // exists (the insert policy forces recovery_verified_at to null, so it
  // can only be stamped afterwards) and credentials are set. The one-shot
  // guard mirrors anonSignInAttempted so a render loop cannot hammer the
  // RPC while it is failing; the visible retry button passes { force }.
  let recoveryVerifyAttempted = false;
  async function verifyRecovery(opts) {
    if (!state.user || state.user.is_anonymous || !state.profile) return false;
    if (state.profile.recovery_verified_at) return true;
    if (!(opts && opts.force) && recoveryVerifyAttempted) return false;
    recoveryVerifyAttempted = true;
    const { data, error } = await client.rpc("mark_recovery_verified");
    if (error || !data) { setMessage("אימות החשבון נכשל, אפשר לנסות שוב"); return false; }
    await loadProfile();
    if (state.profile && state.profile.recovery_verified_at) setMessage("");
    rerender();
    return !!(state.profile && state.profile.recovery_verified_at);
  }
  // A returning member logs into the exact same account (same auth.uid(),
  // same profile/history/streak) from any device - the one thing
  // anonymous-only sign-in structurally couldn't offer.
  async function login(form) {
    if (!client) return;
    const username = String(form.elements.username.value || "").trim().toLowerCase();
    const password = String(form.elements.password.value || "");
    const errors = {};
    if (!USERNAME_RE.test(username)) errors.username = "שם משתמש לא תקין";
    if (!password) errors.password = "יש להזין סיסמה";
    if (Object.keys(errors).length) return setFieldErrors("communityLogin", errors);
    const { error } = await client.auth.signInWithPassword({ email: usernameToEmail(username), password });
    if (error) return setFieldErrors("communityLogin", { password: "שם משתמש או סיסמה שגויים" });
    setFieldErrors("communityLogin", {});
    // onAuthStateChange picks up the session and loads the existing account.
  }
  // Upgrades the bootstrap anonymous session to a permanent one by
  // linking real credentials to it (Supabase's supported anonymous-user
  // conversion path) - the underlying auth.uid() never changes, so the
  // redemption and profile already tied to it carry straight over with
  // no migration step.
  async function setCredentials(form) {
    if (!state.user) return;
    // Shared by two forms now: the Community-onboarding "communityCredentials"
    // screen, and the standalone backup-only "backupCredentials" form in
    // Settings (window.renderBackupSettingsPanel) - form.id keys the field
    // errors so both report inline on whichever one was actually submitted.
    const formId = form.id;
    const username = String(form.elements.username.value || "").trim().toLowerCase();
    const password = String(form.elements.password.value || "");
    const passwordConfirm = String(form.elements.passwordConfirm.value || "");
    const errors = {};
    if (!USERNAME_RE.test(username)) errors.username = "שם משתמש: 3–24 תווים, אותיות אנגליות קטנות, ספרות או קו תחתון";
    if (password.length < 8) errors.password = "הסיסמה חייבת להכיל לפחות 8 תווים";
    if (password !== passwordConfirm) errors.passwordConfirm = "הסיסמאות לא תואמות";
    if (Object.keys(errors).length) return setFieldErrors(formId, errors);
    const { data, error } = await client.auth.updateUser({ email: usernameToEmail(username), password });
    if (error) return setFieldErrors(formId, { username: /registered|exists|taken/i.test(error.message || "") ? "שם המשתמש כבר תפוס" : "השמירה נכשלה, נסו שוב" });
    state.user = data.user;
    setFieldErrors(formId, {});
    setMessage("החשבון נוצר, אפשר להתחבר איתו מכל מכשיר");
    // For a member who already had a profile before setting a recovery
    // method (an existing anonymous account after the Phase 0 migration),
    // the method is verifiable the moment credentials exist. A brand-new
    // signup has no profile row yet, so this no-ops and the stamp happens
    // in saveProfile() instead.
    if (state.profile && !state.profile.recovery_verified_at) await verifyRecovery({ force: true });
    rerender();
  }
  async function saveProfile(form) {
    if (!state.user) return;
    const formId = form.id;
    const handle = String(form.elements.handle.value || "").trim().toLowerCase();
    if (!/^[a-zא-ת0-9_]{3,24}$/.test(handle)) return setFieldErrors(formId, { handle: "שם המשתמש חייב להכיל 3–24 תווים (עברית או אנגלית), מספרים או קו תחתון, בלי רווחים" });
    // is_admin is deliberately never sent from here — a coach-code
    // redemption is a label only (invite_redemptions.role), not automatic
    // full admin access. Full admin stays a manual dashboard-only flip;
    // real coach-scoped permissions (their own classes/members) are a
    // separate piece of work, not built yet.
    const payload = { id: state.user.id, handle, display_name: String(form.elements.displayName.value || "").trim().slice(0, 80), bio: String(form.elements.bio.value || "").trim().slice(0, 160) };
    const { error } = await client.from("profiles").upsert(payload);
    if (error) {
      if (error.code === "23505") setFieldErrors(formId, { handle: "שם המשתמש כבר תפוס" });
      else setMessage("שמירת הפרופיל נכשלה");
      return;
    }
    setFieldErrors(formId, {});
    await loadProfile();
    // Right after the first profile insert (which the RLS policy forces to
    // land with recovery_verified_at null), stamp the recovery method so
    // the new member is a full community_member and never sees the
    // COMM-016 gate. A returning member editing their profile from the
    // Account tab is already verified, so this no-ops for them.
    if (!state.user.is_anonymous && state.profile && !state.profile.recovery_verified_at) await verifyRecovery({ force: true });
    setMessage("הפרופיל נשמר");
  }
  async function migrateLocalData() {
    if (!state.user || typeof window.queueAllLocalRecordsForSync !== "function") return;
    await window.queueAllLocalRecordsForSync();
    state.syncEnabled = true;
    localStorage.setItem("haimunia-demo:cloudSyncEnabled", "1");
    await flushOutbox();
    setMessage("ההיסטוריה הפרטית סונכרנה לחשבון");
  }
  // COMM-300. The two private_records types that stand for "I trained
  // today". Kept in step with attendance_session_record_types() in
  // 202608310001 - bodyweight and measurement carry a `date` of the same
  // shape and are deliberately not here, because stepping on a scale is not
  // training.
  const ATTENDANCE_SESSION_TYPES = ["strength_entry", "wod_entry"];
  const ATTENDANCE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
  // One emit per member per calendar day for the life of this page, mirroring
  // the (user_id, occurred_on) unique key server-side. Three lifts logged on
  // one day are one attendance day, so they are one event here too - without
  // this, "sessions per week" in metrics.md would count sets, not days.
  const attendanceEmitted = new Set();
  // COMM-300, and COMM-012's ATTENDANCE_RECORDED getting its first producer
  // since Phase 0. This is a COURTESY for client consumers (a future
  // challenge auto-progress rule is the named case) and for the analytics
  // bridge. It is explicitly NOT what writes public.attendance_log: the
  // private_records_attendance_log trigger does that, server-side,
  // independently, from the same upsert that just succeeded. Nothing
  // downstream may depend on this firing for correctness - a member on a
  // build without this line still produces attendance rows.
  function noteAttendanceRecorded(row) {
    if (!row || row.deleted) return;
    if (!ATTENDANCE_SESSION_TYPES.includes(row.recordType)) return;
    const occurredOn = row.payload && row.payload.date;
    if (typeof occurredOn !== "string" || !ATTENDANCE_DAY_RE.test(occurredOn)) return;
    const key = `${state.user ? state.user.id : ""}:${occurredOn}`;
    if (attendanceEmitted.has(key)) return;
    attendanceEmitted.add(key);
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.ATTENDANCE_RECORDED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.ATTENDANCE_RECORDED, { occurred_on: occurredOn }); } catch (e) {}
    }
  }
  async function flushOutbox() {
    if (!client || !state.user || !state.syncEnabled || typeof window.dbLoadSyncOutbox !== "function") return;
    const rows = await window.dbLoadSyncOutbox();
    for (const row of rows) {
      const payload = { user_id: state.user.id, record_type: row.recordType, record_id: row.recordId, payload: row.payload || {}, deleted_at: row.deleted ? new Date(row.queuedAt).toISOString() : null, updated_at: new Date(row.queuedAt).toISOString() };
      const { error } = await client.from("private_records").upsert(payload, { onConflict: "user_id,record_type,record_id" });
      if (!error) {
        await window.dbDeleteSyncOutbox(row.id);
        // After the write succeeded, never before: a failed sync is not a
        // session, and the row stays in the outbox to be retried.
        noteAttendanceRecorded(row);
      }
    }
  }
  // Every login used to re-fetch and re-apply every private record (up
  // to 20,000) from scratch, even though almost nothing changed since
  // last time - slow and IndexedDB-write-heavy for a long-running
  // account. Keyed per-user (dbGetSetting/dbSetSetting), not globally,
  // so a different account signing in on the same device never inherits
  // a stale cursor and silently misses its own older records.
  function syncCursorKey(userId) { return `haimunia-demo:syncCursor:${userId}`; }
  async function pullPrivateRecords() {
    if (!client || !state.user || typeof window.applyRemotePrivateRecord !== "function") return;
    const cursorKey = syncCursorKey(state.user.id);
    const cursor = typeof window.dbGetSetting === "function" ? await window.dbGetSetting(cursorKey) : null;
    let query = client.from("private_records").select("record_type,record_id,payload,deleted_at,updated_at").order("updated_at", { ascending: true }).limit(20000);
    if (cursor) query = query.gt("updated_at", cursor);
    const { data, error } = await query;
    if (error) return;
    for (const row of data || []) await window.applyRemotePrivateRecord(row);
    const newest = (data || []).length ? data[data.length - 1].updated_at : null;
    if (newest && typeof window.dbSetSetting === "function") await window.dbSetSetting(cursorKey, newest);
    if (typeof window.reloadFromDb === "function") { await window.reloadFromDb(); rerender(); }
  }
  // COMM-151. Opens the reason sheet for a post. The acknowledgement after
  // submit is plain ("הדיווח התקבל.") and says nothing about what follows.
  function report(postId) { openReportSheet("post", postId); }
  // 2026-09-05 launch-readiness fix. Posts and comments could be reported;
  // a member's profile (bio, display name) could not, even though it's
  // just as visible to the whole club. Requires the schema widening
  // reports.target_type/report() to accept 'profile' (2026-09-05 migration).
  function reportProfile(userId) { openReportSheet("profile", userId); }
  // COMM-228. Members, events and challenges in one round trip. The RPC is
  // security definer and unions three rules that already exist as RLS
  // policies (profiles_read_authenticated, events_read, challenges_read),
  // so it never returns a row the caller could not already have read one at
  // a time - see "## Realtime and search" in docs/community/contracts.md.
  const SEARCH_MIN_CHARS = 2;
  const SEARCH_GROUP_LIMIT = 10;
  let searchToken = 0;
  // The exact characters the RPC strips server-side. Sanitizing here too is
  // not redundant: it is what makes the under-2-chars check agree with the
  // server's, so a query of only "%_,()" never costs a round trip.
  function sanitizeSearchQuery(query) { return String(query || "").trim().replace(/[%_,()]/g, ""); }
  // COMM-233. One search_performed per search the member actually made,
  // not one per keystroke. Both boxes fire a request on every input event
  // (there is no debounce on the fetch itself - COMM-228 chose latency over
  // batching and the token guard makes it safe), so tracking the raw call
  // would put three rows in the table for a member typing "noam" and turn
  // "searches per week" into "characters typed per week". The last result
  // set to settle inside the window is the one recorded, which is the query
  // the member actually meant. Never the query text itself: only its
  // length and the size of each result group, and the helper's own
  // HAND_PROP_KEYS allow-list drops anything else a future call site adds.
  const SEARCH_TRACK_DEBOUNCE_MS = 600;
  let searchTrackTimer = null;
  function trackSearchPerformed(props) {
    if (searchTrackTimer) clearTimeout(searchTrackTimer);
    searchTrackTimer = setTimeout(() => { searchTrackTimer = null; track(A.SEARCH_PERFORMED, props); }, SEARCH_TRACK_DEBOUNCE_MS);
  }
  // Clearing the box, or backspacing under the two-character floor, is the
  // member abandoning the search. Nothing was searched, so nothing pending
  // is worth recording.
  function cancelSearchTracking() { if (searchTrackTimer) { clearTimeout(searchTrackTimer); searchTrackTimer = null; } }
  function clearSearchResults() { state.members.people = []; state.search.events = []; state.search.challenges = []; }
  async function communitySearch(query) {
    if (!state.user) return;
    // state.search.query keeps what the member typed, so a re-render does not
    // rewrite the box under their cursor; only the request is sanitized.
    state.search.query = String(query || "");
    const q = sanitizeSearchQuery(query);
    const token = ++searchToken;
    // Under two characters is empty results, no request and no error -
    // the same threshold the RPC re-applies for a caller that skips it.
    if (q.length < SEARCH_MIN_CHARS) { cancelSearchTracking(); clearSearchResults(); state.search.loading = false; return rerender(); }
    state.search.loading = true;
    rerender();
    const { data, error } = await client.rpc("community_search", { p_query: q, p_limit: SEARCH_GROUP_LIMIT });
    // A slower earlier keystroke must not overwrite a later one's results.
    if (token !== searchToken) return;
    state.search.loading = false;
    // Failure clears rather than showing a broken state, matching what the
    // members-only search did before this ticket widened it.
    const groups = (!error && data && typeof data === "object") ? data : {};
    // allow_follows comes back in the members group so the follow button can
    // be hidden for a member who turned follows off. The server still
    // rejects the insert (follows_insert_self checks the same column plus
    // block edges), this is only so the button does not lie.
    state.members.people = Array.isArray(groups.members) ? groups.members : [];
    state.search.events = Array.isArray(groups.events) ? groups.events : [];
    state.search.challenges = Array.isArray(groups.challenges) ? groups.challenges : [];
    trackSearchPerformed({
      source: "community_search",
      query_length: q.length,
      member_count: state.members.people.length,
      event_count: state.search.events.length,
      challenge_count: state.search.challenges.length,
    });
    rerender();
    // COMM-160. Resolve the coach badge for the result set from the shared
    // server role cache, then re-render.
    loadMemberRoles(state.members.people.map((p) => p.id)).then(() => rerender());
  }
  // The search box's input handler keeps its original name: it is still the
  // members-first entry point every existing caller wired, COMM-228 only
  // widened what one keystroke fetches.
  function searchPeople(query) { return communitySearch(query); }
  // COMM-018. The single client entry point to the server's per-field
  // privacy resolver. Feed, profile, leaderboard and search all resolve a
  // hidden field through this RPC (or the equivalent RLS policy) so one
  // surface cannot leak what another hides. Returns false on any error or
  // null caller, matching the function's own contract.
  async function canViewProfileField(targetUserId, fieldName) {
    if (!state.user || !targetUserId) return false;
    const { data, error } = await client.rpc("can_view_profile_field", { p_target: targetUserId, p_field: fieldName });
    return !error && data === true;
  }
  // Exposed so the feed, engagement and search surfaces owned by other
  // agents resolve hidden fields through the same one place.
  window.canViewProfileField = canViewProfileField;
  // COMM-018. Every toggle is a direct own-row RLS upsert into profiles.
  // protect_is_admin() pins is_admin, club_id and recovery_verified_at on
  // any authenticated write, so sending just the one boolean is safe. The
  // enforcement point is the server (profiles_read_authenticated,
  // follows_insert_self, can_view_profile_field); this only records the
  // member's choice. Optimistic, reverts the toggle on error.
  const PRIVACY_FIELDS = [
    { key: "visible_to_club", label: "הפרופיל שלי גלוי לחברי המועדון" },
    { key: "show_workout_results", label: "תוצאות האימונים שלי גלויות לחברי המועדון" },
    { key: "show_prs", label: "שיאים אישיים (PR) גלויים" },
    { key: "show_achievements", label: "הישגים ועיטורים גלויים" },
    { key: "show_attendance", label: "נוכחות בשיעורים גלויה" },
    { key: "show_upcoming_booking", label: "רישום קרוב לשיעור גלוי" },
    { key: "show_in_attendee_lists", label: "הופעה ברשימת הנרשמים לשיעור" },
    { key: "in_leaderboards", label: "הכללה בטבלאות המובילים" },
    { key: "allow_follows", label: "אפשר לחברי המועדון לעקוב אחריי" },
    { key: "allow_mentions", label: "אפשר אזכור שלי בתגובות (@)" },
    { key: "allow_messages", label: "אפשר הודעות פרטיות אליי" },
  ];
  const PRIVACY_KEYS = PRIVACY_FIELDS.map((f) => f.key);
  async function savePrivacyField(field, value) {
    if (!state.user || !state.profile || PRIVACY_KEYS.indexOf(field) < 0) return;
    const prev = state.profile[field];
    if (prev === value) return;
    state.profile[field] = value;
    rerender();
    const { error } = await client.from("profiles").upsert({ id: state.user.id, [field]: value });
    if (error) { state.profile[field] = prev; setMessage("לא ניתן לשמור הגדרה זו"); return; }
    setMessage("הגדרת הפרטיות נשמרה");
  }
  // COMM-321. Optimistic, same shape as savePrivacyField just above - the
  // write path is admin_set_club_feature(), not a direct table write
  // (club_features has no write policy at all, only the definer RPC).
  async function toggleClubFeature(key, enabled) {
    if (!state.user || CLUB_MODULE_KEYS.indexOf(key) < 0 || state.club.moduleBusy) return;
    const prevRow = state.club.features[key];
    const prevEnabled = prevRow ? prevRow.enabled : true;
    if (prevEnabled === enabled) return;
    state.club.features[key] = { enabled, config: (prevRow && prevRow.config) || {} };
    state.club.moduleBusy = key;
    rerender();
    const { error } = await client.rpc("admin_set_club_feature", { p_module_key: key, p_enabled: enabled });
    state.club.moduleBusy = null;
    if (error) {
      state.club.features[key] = { enabled: prevEnabled, config: (prevRow && prevRow.config) || {} };
      setMessage("לא ניתן היה לעדכן את המודול");
      return rerender();
    }
    setMessage("הגדרת המודול נשמרה");
    rerender();
  }
  // COMM-230. Returns { error } so a caller that needs to know whether the
  // toggle actually succeeded (the following list's own optimistic
  // remove/rollback) can tell, without a second write path: every follow or
  // unfollow anywhere in the app - search, suggestions, the profile header,
  // the directory, the following surface - still goes through this one
  // function. Callers that never read the return value (most of them, still)
  // are unaffected.
  async function follow(userId) {
    if (!state.user) return { error: { message: "not signed in" } };
    const { error } = await client.from("follows").insert({ follower_id: state.user.id, followed_id: userId });
    let finalError = error || null;
    if (error && error.code === "23505") {
      const del = await client.from("follows").delete().eq("follower_id", state.user.id).eq("followed_id", userId);
      finalError = del.error || null;
    }
    // COMM-170. This control toggles: the 23505 branch above is an
    // unfollow, and a rejected insert is neither. Only a real new follow
    // edge is tracked, and there is no member_unfollowed in the event set.
    else if (!error) track(A.MEMBER_FOLLOWED, { user_id: userId });
    await loadFeed(); setMessage(finalError ? "עדכון המעקב נכשל" : "המעקב עודכן");
    return { error: finalError };
  }
  async function block(userId) {
    if (!state.user) return;
    const { error } = await client.from("blocks").upsert({ blocker_id: state.user.id, blocked_id: userId });
    if (error) { setMessage("לא ניתן היה לחסום. נסו שוב"); return; }
    await client.from("follows").delete().eq("follower_id", state.user.id).eq("followed_id", userId);
    state.members.people = state.members.people.filter((person) => person.id !== userId);
    // COMM-125. Refresh the block set so comments and reaction avatars from
    // the newly blocked member drop out of the current view too.
    await loadBlockedIds();
    state.engagement.comments = {}; state.engagement.reactions = {};
    await loadFeed();
    setMessage("המשתמש נחסם");
  }
  async function deletePost(postId) {
    if (!state.user) return;
    const { error } = await client.from("workout_posts").delete().eq("id", postId).eq("author_id", state.user.id);
    if (error) return setMessage("הסרת השיתוף נכשלה");
    await loadFeed(); setMessage("השיתוף הוסר");
  }
  async function publishWorkout(type, id, visibility, photoFile) {
    if (!state.user || !state.profile || typeof window.communityShareCandidateFor !== "function") return;
    // communityShareCandidateFor looks up any entry by id regardless of
    // age - unlike the old recency-limited list, sharing can now be
    // triggered from Calendar or Progress, which show results from any
    // date, not just the last few.
    const item = window.communityShareCandidateFor(type, id);
    if (!item) return setMessage("לא ניתן למצוא את התוצאה במכשיר");
    let photoPath = null;
    if (photoFile) {
      // Was uploadPostPhoto(photoFile) directly on the raw File - every
      // other upload path (composerAddPhoto, avatar, PR prompt) goes
      // through prepareImage first, which strips EXIF/GPS and compresses.
      // This was the one path that shipped a member's raw photo, metadata
      // and all, straight to storage.
      try {
        const prepared = await window.HaimuniaImage.prepareImage(photoFile);
        photoPath = await uploadPreparedPhoto(prepared);
      } catch (e) {
        photoPath = null;
      }
      if (!photoPath) return setMessage("העלאת התמונה נכשלה, אפשר לנסות שוב בלי תמונה");
    }
    const payload = { author_id: state.user.id, source_type: item.type, source_record_id: item.id, visibility: visibility === "public" ? "public" : "followers", title: item.title, result_text: item.resultText, comparison_key: item.comparisonKey, score_value: item.scoreValue, score_direction: item.scoreDirection, rx: item.rx, occurred_on: item.occurredOn };
    if (photoPath) payload.photo_path = photoPath;
    const { error } = await client.from("workout_posts").upsert(payload, { onConflict: "author_id,source_type,source_record_id" });
    if (error) return setMessage("שיתוף התוצאה נכשל");
    // COMM-170. After the write, so a failed share is not counted as one.
    // This path predates the composer and does not emit POST_CREATED, so
    // workout_shared is the only record of it.
    track(A.WORKOUT_SHARED, { source_type: item.type, visibility: payload.visibility, has_photo: !!photoPath });
    delete state.posts.openShare[shareKey(type, id)];
    await loadFeed(); setMessage("התוצאה שותפה בלי הערות, מדדים או פרטים אישיים");
  }
  // Collapsed to one small icon by default wherever a result actually
  // lives (Calendar day view, a movement/WOD's Progress card) instead of
  // a standing list of everything shareable sitting in the Community tab
  // itself - tap to expand the same photo/visibility controls publishing
  // already had.
  function shareKey(type, id) { return `${type}:${id}`; }
  function toggleShare(type, id) {
    const key = shareKey(type, id);
    if (state.posts.openShare[key]) delete state.posts.openShare[key]; else state.posts.openShare[key] = true;
    rerender();
  }
  window.renderShareControl = function (type, id) {
    if (!window.isCommunitySignedIn || !window.isCommunitySignedIn()) return "";
    const key = shareKey(type, id);
    if (!state.posts.openShare[key]) return `<button data-community-action="toggle-share" data-type="${esc(type)}" data-id="${esc(id)}" aria-label="שיתוף לקהילה" style="color:var(--steel);padding:4px;">📤</button>`;
    return `<div class="flex items-center gap-6" style="flex-wrap:wrap;">
      <input type="file" id="photo-${esc(id)}" accept="image/jpeg,image/png,image/webp" style="display:none;"/>
      <label class="chip-btn" for="photo-${esc(id)}" style="cursor:pointer;padding:5px 9px;font-size:11px;">📷</label>
      <button class="chip-btn" data-community-action="publish" data-type="${esc(type)}" data-id="${esc(id)}" data-visibility="followers" style="padding:5px 9px;font-size:11px;">לעוקבים</button>
      <button class="chip-btn primary" data-community-action="publish" data-type="${esc(type)}" data-id="${esc(id)}" data-visibility="public" style="padding:5px 9px;font-size:11px;">לכולם</button>
      <button class="link-btn" data-community-action="toggle-share" data-type="${esc(type)}" data-id="${esc(id)}" aria-label="ביטול שיתוף" style="padding:5px;">✕</button>
    </div>`;
  };
  // Renders directly under the post whose "השוואה" button was tapped
  // (see feed rendering below) instead of in one spot at the top of the
  // whole feed - tapping compare on a post scrolled far down used to
  // produce a result the viewer had to scroll back up to find, with no
  // visual link back to which post triggered it. A second tap on the
  // same post's button closes it again.
  async function compare(comparisonKey, postId) {
    if (state.posts.comparisonForPostId === postId) { state.posts.comparisonForPostId = null; state.posts.comparison = []; return rerender(); }
    if (!comparisonKey) return;
    const { data, error } = await client.from("community_feed").select("id,handle,display_name,result_text,score_value,score_direction,occurred_on").eq("comparison_key", comparisonKey).limit(50);
    state.posts.comparison = error ? [] : (data || []).sort((a, b) => a.score_direction === "lower" ? Number(a.score_value) - Number(b.score_value) : Number(b.score_value) - Number(a.score_value));
    state.posts.comparisonForPostId = postId;
    setMessage(error ? "השוואת התוצאות נכשלה" : "");
  }
  async function requestDeletion() {
    if (!state.user) return;
    const { error } = await client.rpc("request_account_deletion");
    if (error) return setMessage("בקשת המחיקה נכשלה");
    await client.auth.signOut();
  }
  // COMM-014. Every realtime channel is scoped to the sub-tab that
  // opened it, so leaving that sub-tab closes all of them here rather
  // than in each feature. COMM-209 and COMM-227 are the first tickets
  // with live channels behind this call: the challenge detail's two
  // filtered channels, the feed's two shared ones, and the own-row
  // notification channel all close here and re-arm from
  // afterRenderCommunity() if the new tab still wants them.
  function setCommunityTab(tab) {
    if (state.ui.tab !== tab) {
      // COMM-209. The challenge detail belongs to the view that opened it.
      // Leaving that view closes it, so its two channels stay closed after
      // the teardown below instead of being re-armed by the next render
      // for a dialog nobody can see behind the new tab.
      state.challenges.view = null;
      if (window.HaimuniaRealtime) window.HaimuniaRealtime.teardownAll();
      // Both flags describe channels that no longer exist. Clearing them
      // is what lets the arm points above open a fresh channel instead of
      // trusting a stale "already subscribed" memory.
      state.challenges._rtId = null;
      state.notif._rtUid = null;
      clearRealtimeDebounces();
    }
    // COMM-114: "flushed once per feed session, or on view change, whichever
    // comes first". Leaving the Feed sub-tab is a view change.
    if (state.ui.tab !== tab) flushFeedImpressions();
    state.ui.tab = tab;
    rerender();
  }

  // COMM-170. One club_tab_viewed per entry into a sub-tab, never one per
  // render. afterRenderCommunity() runs on every re-render of the Community
  // tab - a reaction, a comment, a photo URL resolving - so the sub-tab
  // that was last counted is remembered and a repeat render of the same one
  // records nothing. Leaving the Community tab clears that memory (the
  // capture-phase listener further down), so coming back counts as a new
  // view, which is the honest reading of "viewed" and the only signal
  // cloud.js can see without app.js telling it which top-level tab is up.
  let lastClubTabView = null;
  // COMM-233. Where the member came from when they land on the roster. Set
  // by the one control that routes there from somewhere else (COMM-232's
  // "find people" call to action on the leaderboard), consumed by the next
  // directory view and reset, so a later plain tab tap is not still
  // attributed to it.
  let directoryEntrySource = "club_tab";
  function resetClubTabView() { lastClubTabView = null; }
  function noteClubTabView() {
    if (!state.user || !state.profile) return;
    const tab = state.ui.tab || "feed";
    if (lastClubTabView === tab) return;
    lastClubTabView = tab;
    track(A.CLUB_TAB_VIEWED, { tab });
    // The feed and the boards are surfaces in their own right, measured
    // separately from the tab that happens to contain them. Two different
    // event names on one action is not double counting.
    if (tab === "feed") track(A.FEED_VIEWED, { scope: state.feed.scope, source: "club_tab" });
    if (tab === "boards") {
      // Only when there is one. An empty board is not a challenge view.
      if (state.club.weeklyChallenge) {
        track(A.CHALLENGE_VIEWED, { challenge_id: null, challenge_key: state.club.weeklyChallenge.comparisonKey || null, source: "boards" });
      }
      track(A.LEADERBOARD_VIEWED, { board: "weekly_challenge", rows: (state.club.weeklyLeaderboard || []).length, source: "boards" });
    }
    // COMM-233. The roster is a surface in its own right, measured
    // separately from the sub-tab that contains it, the same way the feed
    // and the boards already are. It rides this same once-per-entry guard,
    // so the directory's own re-renders (a page of members arriving, a
    // follow toggling) record nothing.
    if (tab === "directory") {
      track(A.DIRECTORY_OPENED, { source: directoryEntrySource });
      directoryEntrySource = "club_tab";
    }
  }

  // A single in-app confirm dialog, replacing three different patterns
  // that used to exist for comparably serious actions: the native browser
  // confirm dialog (broke out of the app's entire custom visual language), an inline
  // footer swap (app.js's clear-all-data), and no confirmation at all
  // (publishing to the community feed, which — unlike blocking someone —
  // used to fire immediately). Every destructive or broadcast-to-others
  // action now goes through this same path.
  function askConfirm(opts) { state.ui.confirmDialog = opts; rerender(); }
  function closeConfirm() { state.ui.confirmDialog = null; rerender(); }
  function runConfirm() {
    const c = state.ui.confirmDialog;
    state.ui.confirmDialog = null;
    if (!c) return;
    if (c.action === "migrate") migrateLocalData();
    else if (c.action === "block") block(c.payload.userId);
    else if (c.action === "delete-account") requestDeletion();
    else if (c.action === "delete-post") deletePost(c.payload.postId);
    else if (c.action === "publish") publishWorkout(c.payload.type, c.payload.id, c.payload.visibility, c.payload.file);
    else if (c.action === "admin-grant-coach") adminGrantCoach(c.payload.userId);
    else if (c.action === "admin-set-role") adminSetRole(c.payload.userId, c.payload.role);
    else if (c.action === "admin-remove-member") adminRemoveMember(c.payload.userId);
    else if (c.action === "admin-reset-password") adminResetPassword(c.payload.userId);
    else if (c.action === "admin-invite-revoke") revokeInvite(c.payload.inviteId);
    else if (c.action === "post-delete-rpc") postDeleteViaMenu(c.payload.postId);
    else if (c.action === "delete-comment") deleteComment(c.payload.commentId, c.payload.postId);
    else if (c.action === "composer-discard") closeComposer();
    else if (c.action === "leave-challenge") leaveChallenge(c.payload.challengeId);
    else if (c.action === "challenge-delete-draft") deleteChallengeDraft(c.payload.challengeId);
    else if (c.action === "challenge-team-delete-confirm") deleteChallengeTeam(c.payload.teamId);
    else if (c.action === "event-cancel") cancelEvent(c.payload.eventId);
    else rerender();
  }

  // Splices aria-invalid/aria-describedby onto an already-built <input>/
  // <textarea> string when that field has a live validation error, and
  // renders the matching visible error text right under the field — the
  // same error, not a duplicate message, so a screen reader and a sighted
  // user learn the same thing at the same place.
  function field(formId, name, labelText, inputHtml) {
    const err = (state.ui.fieldErrors[formId] || {})[name];
    const errId = `err-${formId}-${name}`;
    const tagged = err ? inputHtml.replace(/^<(input|textarea)/, `<$1 aria-invalid="true" aria-describedby="${errId}"`) : inputHtml;
    return `<label class="field"><span class="field-label">${labelText}</span>${tagged}${err ? `<span class="field-error" id="${errId}" role="alert">${esc(err)}</span>` : ""}</label>`;
  }
  function renderConfirmSheet() {
    const c = state.ui.confirmDialog;
    if (!c) return "";
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="communityConfirmTitle" style="align-items:center;padding:0 20px;">
      <div class="modal-sheet" style="border-radius:22px;border-bottom:1px solid var(--border);max-height:none;">
        <div style="padding:24px 22px calc(env(safe-area-inset-bottom,0px) + 20px);">
          <div id="communityConfirmTitle" style="color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:8px;">${esc(c.title || "אישור פעולה")}</div>
          <div style="color:var(--steel);font-size:13.5px;line-height:1.6;margin-bottom:20px;">${esc(c.message)}</div>
          <div class="chip-row" style="margin-top:0;">
            <button class="chip-btn" data-community-action="confirm-no">ביטול</button>
            <button class="chip-btn primary${c.destructive ? " danger" : ""}" data-community-action="confirm-yes">${esc(c.confirmLabel || "אישור")}</button>
          </div>
        </div>
      </div>
    </div>`;
  }
  function sectionHead(color, title, adminTag) {
    return `<div class="ach-section-head"><span class="ach-section-dot" style="background:${color};"></span><h2 class="ach-section-title">${title}</h2>${adminTag ? `<span class="admin-tag">ניהול</span>` : ""}</div>`;
  }
  // Top 3 in full, then — if the viewer isn't in the top 3 — a divider and
  // their own row, instead of one long ranked list past the leaders. Same
  // underlying data, friendlier framing (principle: scoped/small-cohort
  // competition motivates more than "you're #18 of 40").
  function renderRankedList(items, selfKeyOf, formatValue) {
    if (!items.length) return `<div class="empty">אין נתונים עדיין</div>`;
    const selfId = state.user && state.user.id;
    // A screen whose whole job is "who is winning" gave emphasis only to
    // the viewer's own row - rank 1 rendered exactly like rank 40. The
    // leader gets a trophy and a brass tint; isSelf still owns the border
    // color when the two coincide, since "this is you" is the more useful
    // thing to confirm at a glance.
    const rowHtml = (it, index, isSelf) => {
      const isLeader = index === 0;
      const style = isSelf ? ' style="border-color:var(--energy);"' : (isLeader ? ' style="border-color:var(--brass);background:linear-gradient(90deg, color-mix(in srgb, var(--brass) 14%, transparent), transparent);"' : "");
      return `<div class="log-row"${style}><span>${isLeader ? "🏆 " : ""}${index + 1}. ${nameHtml(it.display_name, it.handle)}${isSelf ? " (את/ה)" : ""}</span><span class="mono" style="color:var(--brass);font-weight:${isLeader ? "800" : "400"};">${formatValue(it)}</span></div>`;
    };
    const top = items.slice(0, 3).map((it, i) => rowHtml(it, i, selfKeyOf(it) === selfId));
    const selfIndex = items.findIndex((it) => selfKeyOf(it) === selfId);
    const rows = selfIndex >= 3 ? [...top, `<div class="empty" style="padding:4px 0;font-size:16px;">···</div>`, rowHtml(items[selfIndex], selfIndex, true)] : top;
    return `<div class="log-list">${rows.join("")}</div>`;
  }

  // ==========================================================================
  // COMM-210 / COMM-211 / COMM-212 - feed_leaderboard, both modes, both scopes
  // ==========================================================================
  // One server function (202608290015) backs every board here, so the client
  // has exactly one fetch path, one row renderer and one set of states. The
  // rows come back already ranked, already tie-broken and already filtered on
  // in_leaderboards / visible_to_club / block edges; nothing below re-sorts,
  // re-ranks or re-filters them. `rank` is read off the row, never derived
  // from the array index, because the caller's own row is appended after the
  // visible cutoff and its index is therefore not its position.
  //
  // Three contract details drive the code below and are easy to get wrong:
  //
  // 1. Zero is a real ranked value, not "no data". Every eligible member is
  //    ranked including a 0-week streak, so "not enough data yet" is "no rows
  //    OR every value is 0", not "no rows".
  // 2. The caller's row is ALWAYS returned, appended last with its real rank
  //    when it fell outside p_limit. That is what makes "where do I stand"
  //    free; splitLeaderboardRows() below is what tells the two apart.
  // 3. "Hide my result" is a render choice on top of that row - never a
  //    parameter, never a privacy setting. See state.leaderboard.hideMine.
  // Post-Phase-3 Hebrew copy fix: "עוקבים" (followed), not "חברים" (club
  // members) - the app uses חברים everywhere else to mean club membership,
  // and labeling "people you follow" the same word was a real homonym
  // collision. visibilityLabel() below already uses עוקבים correctly for
  // the identical concept on posts; this scope now matches it.
  const LEADERBOARD_SCOPES = [
    { id: "club", label: "כל המועדון" },
    { id: "friends", label: "עוקבים" },
  ];
  // COMM-210 asks for 50, COMM-211's in-panel board for 20 with a full board
  // at 50. The server clamps to 1..100 regardless; these are what we request.
  const CONSISTENCY_BOARD_LIMIT = 50;
  const CHALLENGE_BOARD_LIMIT = 20;
  const CHALLENGE_BOARD_FULL_LIMIT = 50;
  const HIDE_MY_RESULT_KEY = "haimunia-demo:hideMyLeaderboardResult";
  const LEADERBOARD_ERROR_TEXT = "לא ניתן היה לטעון את הטבלה. נסו שוב.";

  function leaderboardRows(board) { return Array.isArray(board && board.rows) ? board.rows : []; }
  // Detail 1 above. A board of members who have all logged nothing yet is
  // "not enough data", even though every one of them carries a real rank.
  function leaderboardHasNoData(rows) {
    return !rows.length || rows.every((r) => Number((r && r.value) || 0) === 0);
  }
  // COMM-212's empty friends state is "no mutual follows yet", which on the
  // wire is "the only row is my own" - the caller is always included whatever
  // the scope, so an empty friends board is one row, not zero.
  function leaderboardHasNoFriends(rows) {
    return !rows.some((r) => r && !r.is_self);
  }
  // Detail 2 above. Only the LAST row can be the appended self row, and only
  // when its rank fell outside the limit we asked for. Everything before it is
  // the contiguous top block.
  function splitLeaderboardRows(rows, limit) {
    const last = rows[rows.length - 1];
    if (last && last.is_self && Number(last.rank) > Number(limit)) {
      return { top: rows.slice(0, -1), self: last };
    }
    return { top: rows, self: null };
  }
  function setHideMyLeaderboardResult(next) {
    state.leaderboard.hideMine = !!next;
    try { localStorage.setItem(HIDE_MY_RESULT_KEY, next ? "1" : "0"); } catch (e) { /* private mode */ }
    rerender();
  }

  // ---- Fetch: consistency board (COMM-210), club or friends (COMM-212) -----
  async function loadConsistencyLeaderboard() {
    // The profiles row is only written when the member saves the
    // "השלמת פרופיל" step, and feed_leaderboard() gates on my_role_code(),
    // which is null until it exists - so between redeeming the code and
    // finishing the profile this raised 'not authorized' on every render,
    // for a board the profile-completion card is covering anyway.
    if (!client || !state.user || !state.profile) return;
    const b = state.leaderboard;
    const scope = b.scope;
    b.loading = true; b.error = false;
    rerender();
    const { data, error } = await client.rpc("feed_leaderboard", {
      p_mode: "consistency", p_challenge_id: null, p_scope: scope, p_limit: CONSISTENCY_BOARD_LIMIT,
    });
    // A scope switch while this was in flight wins; the stale answer is
    // dropped rather than briefly painting the previous scope's rows.
    if (b.scope !== scope) return;
    b.loading = false; b.loaded = true;
    if (error) { b.error = true; b.rows = []; return rerender(); }
    b.rows = Array.isArray(data) ? data : [];
    track(A.LEADERBOARD_VIEWED, { board: "consistency", rows: b.rows.length, source: "boards" });
    rerender();
  }
  function setLeaderboardScope(scope) {
    if (!scope || state.leaderboard.scope === scope) return;
    // COMM-212: a scope change is a re-fetch of the same surface, never a
    // reload. The previous rows stay on screen under the skeleton gate below
    // only until the new ones land.
    state.leaderboard.scope = scope;
    state.leaderboard.rows = [];
    state.leaderboard.error = false;
    loadConsistencyLeaderboard();
  }

  // ---- Fetch: challenge progress board (COMM-211) --------------------------
  // Lives on the open challenge detail so it dies with it. Called from inside
  // refreshChallengeView() before the dialog drops its loading flag, so the
  // board and the rest of the detail appear together rather than the board
  // popping in a frame later.
  async function loadChallengeBoard(id, opts) {
    if (!client || !state.user) return;
    const v = state.challenges.view;
    if (!v || v.id !== id || !v.board) return;
    const b = v.board;
    const scope = b.scope, limit = b.limit;
    b.loading = true; b.error = false;
    if (opts && opts.rerender) rerender();
    const { data, error } = await client.rpc("feed_leaderboard", {
      p_mode: "progress", p_challenge_id: id, p_scope: scope, p_limit: limit,
    });
    const cur = state.challenges.view;
    if (!cur || cur.id !== id || cur.board !== b || b.scope !== scope || b.limit !== limit) return;
    b.loading = false; b.loaded = true;
    if (error) { b.error = true; b.rows = []; }
    else {
      b.rows = Array.isArray(data) ? data : [];
      track(A.LEADERBOARD_VIEWED, { board: "challenge_progress", rows: b.rows.length, source: "challenge" });
    }
    if (opts && opts.rerender) rerender();
  }
  function setChallengeBoardScope(scope) {
    const v = state.challenges.view;
    if (!v || !v.board || !scope || v.board.scope === scope) return;
    v.board.scope = scope;
    v.board.rows = [];
    v.board.error = false;
    loadChallengeBoard(v.id, { rerender: true });
  }
  // COMM-211's "50 on a dedicated full leaderboard screen if one is opened".
  // Rather than a second screen with a second fetch path, the same panel
  // re-asks for the full 50 in place - one code path, one set of states.
  function expandChallengeBoard() {
    const v = state.challenges.view;
    if (!v || !v.board || v.board.limit >= CHALLENGE_BOARD_FULL_LIMIT) return;
    v.board.limit = CHALLENGE_BOARD_FULL_LIMIT;
    v.board.rows = [];
    v.board.error = false;
    loadChallengeBoard(v.id, { rerender: true });
  }

  // ---- Render ---------------------------------------------------------------
  function leaderboardScopeSwitchHtml(action, active) {
    return `<div class="chip-row" role="group" aria-label="היקף הטבלה" style="margin:0 0 8px;">${LEADERBOARD_SCOPES.map((s) => `<button class="chip-btn${s.id === active ? " selected" : ""}" data-community-action="${action}" data-scope="${s.id}" aria-pressed="${s.id === active ? "true" : "false"}">${s.label}</button>`).join("")}</div>`;
  }
  // Deliberately worded so it cannot be mistaken for the server-enforced
  // opt-out: this hides a row from this device's view of the table, it does
  // not remove anyone from the table. The real opt-out is in_leaderboards,
  // reachable from the Privacy panel and from the link on the weekly board.
  function leaderboardHideToggleHtml() {
    return `<label class="log-row" style="justify-content:space-between;gap:12px;cursor:pointer;margin-top:8px;"><span style="font-size:13px;">הסתרת השורה שלי בתצוגה הזו<span style="color:var(--steel);display:block;font-size:11px;">במכשיר הזה בלבד. אינה משנה את הגדרת הפרטיות.</span></span><input type="checkbox" data-leaderboard-hide-self="1"${state.leaderboard.hideMine ? " checked" : ""} aria-label="הסתרת השורה שלי בתצוגה הזו"/></label>`;
  }
  function leaderboardSkeletonHtml(n) {
    const row = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:52%;background:var(--border);border-radius:6px;display:inline-block;"></span><span style="height:12px;width:18%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
    return `<div class="log-list" aria-busy="true" data-leaderboard-skeleton="1">${row.repeat(n || 4)}</div>`;
  }
  // Same "you" marking convention the challenge board and renderRankedList
  // already use: the energy border plus a "(את/ה)" suffix. Reused rather than
  // reinvented so one member reads the same on every ranked surface.
  function leaderboardRowHtml(row, formatValue) {
    const isSelf = !!row.is_self;
    const isLeader = Number(row.rank) === 1;
    const name = row.display_name || (row.handle ? "@" + row.handle : "חבר/ה");
    // Same leader emphasis as renderRankedList's rowHtml - isSelf still owns
    // the border color when the two coincide.
    const style = isSelf ? ` style="border-color:var(--energy);"` : (isLeader ? ` style="border-color:var(--brass);background:linear-gradient(90deg, color-mix(in srgb, var(--brass) 14%, transparent), transparent);"` : "");
    return `<div class="log-row" data-leaderboard-user="${esc(row.user_id)}"${isSelf ? ` data-leaderboard-self="1"` : ""}${style}><span>${isLeader ? "🏆 " : ""}${Number(row.rank)}. ${esc(name)}${isSelf ? " (את/ה)" : ""}</span><span class="mono" style="color:var(--brass);font-weight:${isLeader ? "800" : "400"};">${formatValue(row)}</span></div>`;
  }
  // COMM-212 / COMM-231. The friends empty state points at the members
  // directory, which is now the real people-finding surface (it ships its
  // own search, reusing COMM-228, so nothing is lost by pointing here
  // instead of the Account tab's search box).
  function leaderboardFriendsEmptyHtml() {
    return `<div class="empty" data-leaderboard-empty="friends">עקבו אחרי חברים כדי להשוות תוצאות.<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="leaderboard-find-people">חיפוש אנשים</button></div></div>`;
  }
  function renderLeaderboardBody(board, opts) {
    const rows = leaderboardRows(board);
    if (board.loading && !rows.length) return leaderboardSkeletonHtml(4);
    if (board.error) {
      return `<div class="empty" role="alert" data-leaderboard-empty="error">${LEADERBOARD_ERROR_TEXT}<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="${opts.retryAction}">ניסיון חוזר</button></div></div>`;
    }
    if (board.scope === "friends" && leaderboardHasNoFriends(rows)) return leaderboardFriendsEmptyHtml();
    if (leaderboardHasNoData(rows)) return `<div class="empty" data-leaderboard-empty="no-data">${opts.emptyText}</div>`;
    const { top, self } = splitLeaderboardRows(rows, opts.limit);
    const hide = state.leaderboard.hideMine;
    const topHtml = top.filter((r) => !(hide && r.is_self)).map((r) => leaderboardRowHtml(r, opts.formatValue)).join("");
    // The divider marks the gap between the visible top and the caller's own
    // standing below it - the same "···" renderRankedList already uses.
    const selfHtml = (self && !hide)
      ? `<div class="empty" style="padding:4px 0;font-size:16px;">···</div>` + leaderboardRowHtml(self, opts.formatValue)
      : "";
    return `<div class="log-list" style="max-height:420px;overflow:auto;">${topHtml}${selfHtml}</div>`;
  }
  // COMM-210. The club-wide consistency board on the Boards sub-tab. Replaces
  // the older "רצפי התמדה" strip, which read community_streaks directly and
  // therefore ranked without the in_leaderboards / block filtering, without a
  // stable tie-break and without the caller's own row when they were outside
  // the top three. Same figure, same source of truth as community_profile's
  // current_streak - see consistency_week_streaks() in contracts.md - now
  // resolved server-side. loadStreaks()/state.club.streaks stay for the coach
  // Welcome surface, which reuses the same number per member.
  function renderConsistencyLeaderboardSection() {
    // COMM-321. feed_leaderboard() itself raises once this module is off
    // (a real RLS-equivalent enforcement point, not just a client hide) -
    // this guard only keeps the section shell/empty-card from flashing an
    // error-shaped state a member has no way to act on.
    if (!isModuleEnabled("leaderboards")) return "";
    const b = state.leaderboard;
    const body = renderLeaderboardBody(b, {
      limit: CONSISTENCY_BOARD_LIMIT,
      emptyText: "עדיין אין מספיק נתונים לטבלת עקביות.",
      retryAction: "leaderboard-retry",
      formatValue: (r) => `🔥 ${Number(r.value || 0)}`,
    });
    return `<div class="ach-section" data-leaderboard="consistency">${sectionHead("var(--purple)", "טבלת עקביות")}
      ${leaderboardScopeSwitchHtml("leaderboard-scope", b.scope)}
      ${body}
      ${leaderboardHideToggleHtml()}
      <!-- COMM-317 (Phase 3 QA sweep): this footer note dated back to
      COMM-210 (Phase 2), when the board was still ranking
      workout_posts-derived streaks and this line was an accurate
      "coming later" promise. COMM-306 (Phase 3) already replaced
      consistency_week_streaks()'s body with attendance_log - the board has
      been ranking real, trigger-derived training-log attendance since that
      ticket shipped, and the old copy was left unchanged, so it told every
      member the exact feature already under their feet was still pending.
      Corrected to describe what the board actually measures now, using
      COMM-300's own "verified means self-reported, not physically
      verified" framing: derived from the member's own private training
      log, not from a public feed post - never a claim of a physical
      check-in. -->
      <div class="footer-note" style="margin-top:8px;">הרצף מבוסס על אימונים שתועדו ביומן האימונים האישי, לא על פרסום בפיד.</div>
    </div>`;
  }

  // ==========================================================================
  // COMM-232 - "אנשים שאולי תכירו"
  // ==========================================================================
  // PLACEMENT NOTE. COMM-232 named the members directory (COMM-231) as this
  // strip's real home; it rendered on the Account sub-tab only as a stand-in
  // until that screen existed. Now that COMM-231 has shipped,
  // renderPeopleSuggestions() is called from renderDirectorySection() only -
  // moved, not duplicated, since a member who has already followed everyone
  // suggested on one surface should not see the same cards again on another.
  //
  // The error state is unusual on purpose: the strip is omitted entirely
  // rather than showing a retry, because this is a secondary surface and a
  // broken recommendation row is worse than no recommendation row.
  const PEOPLE_SUGGESTIONS_LIMIT = 10;
  const SUGGESTION_REASONS = {
    challenge: "אתגר משותף",
    interaction: "פעילות משותפת בפיד",
    event: "אירוע משותף",
  };
  async function loadPeopleSuggestions() {
    // Same pre-profile guard as loadConsistencyLeaderboard: people_suggestions()
    // gates on my_role_code() too.
    if (!client || !state.user || !state.profile) return;
    const s = state.members.suggestions;
    s.loading = true; s.error = false;
    rerender();
    const { data, error } = await client.rpc("people_suggestions", { p_limit: PEOPLE_SUGGESTIONS_LIMIT });
    s.loading = false; s.loaded = true;
    if (error) { s.error = true; s.items = []; return rerender(); }
    // Rendered in the order returned: people_suggestions() already ranks by
    // strongest signal (a shared live challenge outranks any number of shared
    // reactions), and re-sorting here would throw that away.
    s.items = (Array.isArray(data) ? data : []).filter(Boolean);
    rerender();
  }
  // Reuses follow() - the same insert-or-delete path the search UI's follow
  // button uses - rather than a second write. COMM-230's following surface is
  // not built yet; when it is, this stays pointed at the same action.
  // The card is dropped locally afterwards because the server already excludes
  // a follow edge in either direction, so a refetch would drop it anyway.
  async function followSuggestion(userId) {
    if (!userId) return;
    const s = state.members.suggestions;
    s.busy[userId] = true;
    rerender();
    await follow(userId);
    delete s.busy[userId];
    s.items = s.items.filter((it) => it && it.user_id !== userId);
    rerender();
  }
  function suggestionCardHtml(item) {
    const name = item.display_name || (item.handle ? "@" + item.handle : "חבר/ה");
    const reason = SUGGESTION_REASONS[item.reason] || "";
    const busy = !!state.members.suggestions.busy[item.user_id];
    return `<div class="chart-card" data-suggestion-user="${esc(item.user_id)}" style="flex:0 0 auto;min-width:148px;max-width:170px;text-align:center;margin:0;">
      ${avatarHtml(name, 44, item.avatar_url)}
      <div style="font-weight:700;margin-top:6px;font-size:13px;">${esc(name)}</div>
      ${item.handle ? `<div style="color:var(--steel);font-size:12px;"><bdi>@${esc(item.handle)}</bdi></div>` : ""}
      ${reason ? `<div style="color:var(--steel);font-size:11px;margin-top:4px;">${esc(reason)}</div>` : ""}
      <div class="chip-row" style="justify-content:center;margin-top:6px;">
        <button class="chip-btn primary" data-community-action="suggestion-follow" data-id="${esc(item.user_id)}"${busy ? " disabled" : ""}>${busy ? "…" : "מעקב"}</button>
        <button class="chip-btn" data-community-action="view-profile" data-id="${esc(item.user_id)}">פרופיל</button>
      </div>
    </div>`;
  }
  function renderPeopleSuggestions() {
    const s = state.members.suggestions;
    // COMM-232: on error the strip is not rendered at all - no heading, no
    // empty state, no retry. Nothing tells the member a thing failed.
    if (s.error) return "";
    const head = sectionHead("var(--teal)", "אנשים שאולי תכירו");
    if (!s.loaded) {
      const card = `<div class="chart-card" aria-hidden="true" style="flex:0 0 auto;min-width:148px;height:118px;margin:0;"></div>`;
      return `<div class="ach-section" style="margin-top:18px;" data-people-suggestions="loading">${head}<div class="flex gap-10" aria-busy="true" style="overflow-x:auto;padding-bottom:4px;">${card.repeat(3)}</div></div>`;
    }
    if (!s.items.length) {
      return `<div class="ach-section" style="margin-top:18px;" data-people-suggestions="empty">${head}<div class="empty">עדיין אין המלצות. התחילו לבלות בקהילה כדי לקבל הצעות.</div></div>`;
    }
    return `<div class="ach-section" style="margin-top:18px;" data-people-suggestions="ready">${head}
      <div class="flex gap-10" style="overflow-x:auto;padding-bottom:4px;align-items:stretch;">${s.items.map(suggestionCardHtml).join("")}</div>
    </div>`;
  }

  // ==========================================================================
  // COMM-231 - members directory
  // ==========================================================================
  // A browsable, alphabetical roster of every club member with
  // visible_to_club on - what search never was (search only ever answers
  // "is there a member named X"; this answers "who is in this club").
  // Paginated by display_name, page size DIRECTORY_PAGE_SIZE, cursor = the
  // last row's own display_name (COMM-113's convention: the audit log's
  // cursor is its last row's created_at the same way, with the same
  // accepted duplicate-value edge case - this is not a new risk, it is the
  // existing one, on a different column). The caller's own row is excluded,
  // matching community_search's own convention: a member finds their own
  // profile through the Account tab, not a roster of "everyone including
  // me". A blocked member never appears - profiles_read_authenticated
  // already drops a block edge in either direction, same as every other
  // profiles read in this file.
  const DIRECTORY_PAGE_SIZE = 40;
  const DIRECTORY_ERROR_TEXT = "לא ניתן היה לטעון את רשימת החברים. נסו שוב.";
  const DIRECTORY_EMPTY_TEXT = "אין חברים להצגה.";
  async function loadDirectory(reset) {
    if (!state.user) return;
    const d = state.members.directory;
    if (reset) { d.items = []; d.cursor = null; d.end = false; d.loaded = false; }
    if (d.loading || d.loadingMore) return;
    if (reset) d.loading = true; else d.loadingMore = true;
    d.error = false;
    rerender();
    let q = client.from("profiles").select("id,handle,display_name,avatar_url,allow_follows,visible_to_club")
      .neq("id", state.user.id).order("display_name", { ascending: true }).limit(DIRECTORY_PAGE_SIZE);
    if (d.cursor) q = q.gt("display_name", d.cursor);
    const { data, error } = await q;
    d.loading = false; d.loadingMore = false;
    // Set before the error check, same as loadAuditLog's own cursor read:
    // a failed load still counts as "the first attempt happened", so the
    // afterRenderCommunity() lazy-load trigger (gated on !d.loaded) does not
    // re-fire this on every render and loop forever retrying a failure the
    // member has not asked to retry yet.
    d.loaded = true;
    if (error) { d.error = true; rerender(); return; }
    const raw = Array.isArray(data) ? data : [];
    // Defence in depth, not a second real gate: profiles_read_authenticated
    // already lets the caller's own row through regardless of
    // visible_to_club (dropped above by neq()) and a real admin's read
    // through regardless of the target's visible_to_club (is_admin() OR in
    // the policy) - a roster of "everyone visible to the club" is not the
    // right surface for an admin's widened read, so this filters strictly
    // on the column itself rather than trusting the policy's own reason for
    // returning the row.
    const visible = raw.filter((r) => r && r.visible_to_club);
    d.items = d.items.concat(visible);
    d.cursor = raw.length ? raw[raw.length - 1].display_name : d.cursor;
    d.end = raw.length < DIRECTORY_PAGE_SIZE;
    rerender();
    loadMemberRoles(visible.map((r) => r.id)).then(() => rerender());
  }
  let directorySearchToken = 0;
  // Reuses community_search (COMM-228) for two characters or more - the
  // same members group, the same sanitization, the same result shape
  // searchMemberRowHtml already renders - rather than inventing a second
  // search path. Below that threshold community_search would answer empty
  // anyway (its own documented floor), so this falls back to a client-side
  // substring filter over whatever page of the roster is already loaded,
  // per the ticket's own "falling back to the existing client-side filter"
  // clause. Clearing the box returns to the plain paginated roster.
  async function directorySearch(query) {
    const d = state.members.directory;
    d.query = String(query || "");
    const q = sanitizeSearchQuery(query);
    const token = ++directorySearchToken;
    if (q.length < SEARCH_MIN_CHARS) { cancelSearchTracking(); d.searchResults = null; d.searchLoading = false; return rerender(); }
    d.searchLoading = true;
    rerender();
    const { data, error } = await client.rpc("community_search", { p_query: q, p_limit: DIRECTORY_PAGE_SIZE });
    if (token !== directorySearchToken) return; // a slower earlier keystroke must not overwrite a later one's results
    d.searchLoading = false;
    if (error) { d.searchResults = []; return rerender(); }
    const members = (data && Array.isArray(data.members)) ? data.members : [];
    d.searchResults = members;
    // The roster's box asks community_search for the members group only, so
    // the other two counts are absent rather than zero - an absent prop and
    // a zero prop mean different things and the difference is worth keeping.
    trackSearchPerformed({ source: "directory", query_length: q.length, member_count: members.length });
    rerender();
    loadMemberRoles(members.map((m) => m.id)).then(() => rerender());
  }
  function directoryRows() {
    const d = state.members.directory;
    const q = String(d.query || "").trim();
    if (!q) return d.items;
    if (Array.isArray(d.searchResults)) return d.searchResults;
    const needle = q.toLowerCase();
    return d.items.filter((m) => (m.display_name || "").toLowerCase().indexOf(needle) >= 0 || (m.handle || "").toLowerCase().indexOf(needle) >= 0);
  }
  function directorySkeletonHtml(n) {
    const row = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:52%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
    return `<div class="log-list" aria-busy="true" data-directory-skeleton="1">${row.repeat(n || 6)}</div>`;
  }
  // Coach/head_coach members split to their own group above everyone else
  // (COMM-160's badge, reused, not reinvented) - each group keeps the
  // alphabetical order the roster (or the search result) already came back
  // in, so splitting never re-sorts anything.
  function splitDirectoryStaff(rows) {
    const staff = [], rest = [];
    rows.forEach((m) => (isCoachRole(memberRole(m.id)) ? staff : rest).push(m));
    return { staff, rest };
  }
  function renderDirectorySection() {
    const d = state.members.directory;
    const q = String(d.query || "").trim();
    const searchBox = `<input class="text-input" id="communityDirectorySearch" placeholder="חיפוש לפי שם" value="${esc(d.query || "")}" aria-label="חיפוש חברים" style="margin-bottom:10px;"/>`;
    const stillSearching = !!q && q.length >= SEARCH_MIN_CHARS && d.searchLoading && d.searchResults == null;
    let body;
    if (d.loading && !d.items.length) body = directorySkeletonHtml(6);
    else if (d.error && !d.items.length) {
      body = `<div class="empty" role="alert" data-directory-empty="error">${DIRECTORY_ERROR_TEXT}<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="directory-retry">ניסיון חוזר</button></div></div>`;
    } else if (stillSearching) {
      body = directorySkeletonHtml(3);
    } else {
      const rows = directoryRows();
      if (!rows.length) {
        body = `<div class="empty" data-directory-empty="empty">${DIRECTORY_EMPTY_TEXT}</div>`;
      } else {
        const { staff, rest } = splitDirectoryStaff(rows);
        const staffHtml = staff.length ? `<div class="log-list" data-directory-group="staff">${staff.map(searchMemberRowHtml).join("")}</div>` : "";
        const restHtml = rest.length ? `<div class="log-list" data-directory-group="members"${staff.length ? ' style="margin-top:10px;"' : ""}>${rest.map(searchMemberRowHtml).join("")}</div>` : "";
        // Paging only applies to the plain roster - a search result set
        // (community_search or the client-side filter) is already the whole
        // answer for that query, not a page of one.
        const moreHtml = (!q && !d.end) ? `<div class="chip-row" style="justify-content:center;margin-top:8px;"><button class="chip-btn" data-community-action="directory-more"${d.loadingMore ? " disabled" : ""}>${d.loadingMore ? "טוען…" : "טעינת עוד"}</button></div>` : "";
        body = staffHtml + restHtml + moreHtml;
      }
    }
    // COMM-232's suggestions strip lives here now - see the PLACEMENT NOTE
    // above renderPeopleSuggestions(): this is the surface COMM-232 always
    // named as its real home, the Account tab was only ever the stand-in
    // until this screen existed.
    return `<div class="ach-section">${sectionHead("var(--blue)", "חברי המועדון")}${searchBox}${body}</div>${renderPeopleSuggestions()}`;
  }

  // ---- COMM-228 grouped search -------------------------------------------
  // One box, three labeled groups, never interleaved: a member row is not
  // comparable to an event row, and mixing them would force an ordering
  // (relevance across types) the RPC deliberately does not compute.
  function searchGroupHtml(label, rowsHtml) {
    return `<div class="search-group" data-search-group="${label}" style="margin-top:10px;">
      <div class="field-label" style="margin-bottom:6px;">${searchGroupTitle(label)}</div>
      ${rowsHtml ? `<div class="log-list">${rowsHtml}</div>` : `<div class="empty" style="padding:6px 0;">אין תוצאות</div>`}
    </div>`;
  }
  // Post-Phase-3 Hebrew copy fix: "חברים" (members), matching the term used
  // everywhere else in the app (200+ instances) - "מתאמנים" (trainees) was
  // a one-off outlier only in this search grouping.
  function searchGroupTitle(key) {
    return { members: "חברים", events: "אירועים", challenges: "אתגרים" }[key] || key;
  }
  function searchMemberRowHtml(person) {
    return `<div class="log-row"><div class="flex gap-10" style="align-items:center;">${avatarHtml(person.display_name || person.handle, 32, person.avatar_url)}<div><div style="font-weight:700;">${nameHtml(person.display_name, person.handle)}${isCoachRole(memberRole(person.id)) ? " " + coachBadgeHtml(memberRole(person.id)) : ""}</div><div style="color:var(--steel);font-size:12px;"><bdi>@${esc(person.handle)}</bdi> ${esc(person.bio || "")}</div></div></div><div class="chip-row" style="margin-top:0;"><button class="chip-btn" data-community-action="view-profile" data-id="${esc(person.id)}">פרופיל</button>${person.allow_follows === false ? "" : `<button class="chip-btn" data-community-action="follow" data-id="${esc(person.id)}">מעקב</button>`}<button class="chip-btn" data-community-action="block" data-id="${esc(person.id)}">חסימה</button></div></div>`;
  }
  function searchEventRowHtml(ev) {
    // No event detail surface exists yet (COMM-213 builds it), so the row
    // records the view and says what it knows. It does not pretend to
    // navigate somewhere that is not built.
    const when = ev.start_at ? String(ev.start_at).slice(0, 16).replace("T", " ") : "";
    const meta = [when, ev.status === "draft" ? "טיוטה" : ev.status === "cancelled" ? "בוטל" : ""].filter(Boolean);
    return `<div class="log-row" data-search-event-id="${esc(ev.id)}"><div><div style="font-weight:700;">📅 ${esc(ev.title || "אירוע")}</div>${meta.length ? `<div style="color:var(--steel);font-size:12px;">${meta.map(esc).join(" · ")}</div>` : ""}</div><div class="chip-row" style="margin-top:0;"><button class="chip-btn" data-community-action="open-event" data-id="${esc(ev.id)}" data-source="search">פרטים</button></div></div>`;
  }
  function searchChallengeRowHtml(c) {
    const meta = [challengeTypeDef(c.challenge_type).label, challengeStatusLabel(c), c.end_at ? `עד ${formatChallengeDate(c.end_at)}` : ""].filter(Boolean);
    return `<div class="log-row" data-search-challenge-id="${esc(c.id)}"><div><div style="font-weight:700;">${esc(challengeTypeDef(c.challenge_type).icon)} ${esc(c.title || "אתגר")}</div><div style="color:var(--steel);font-size:12px;">${meta.map(esc).join(" · ")}</div></div><div class="chip-row" style="margin-top:0;"><button class="chip-btn" data-community-action="open-challenge" data-id="${esc(c.id)}" data-source="search">פרטים</button></div></div>`;
  }
  function renderCommunitySearch() {
    const box = `<div class="search-box"><input id="communityPeopleSearch" placeholder="חיפוש חברים, אירועים ואתגרים" aria-label="חיפוש בקהילה" value="${esc(state.search.query || "")}"/></div>`;
    let body;
    if (sanitizeSearchQuery(state.search.query).length < SEARCH_MIN_CHARS) {
      // Under the threshold there is nothing to show and nothing was asked
      // of the server - not an error, and not an empty-results claim.
      body = `<div class="footer-note" style="margin:6px 0 0;">הקלידו לפחות ${SEARCH_MIN_CHARS} תווים</div>`;
    } else if (state.search.loading) {
      body = `<div class="empty" role="status" style="padding:8px 0;">מחפש...</div>`;
    } else {
      body = searchGroupHtml("members", state.members.people.map(searchMemberRowHtml).join(""))
        + searchGroupHtml("events", state.search.events.map(searchEventRowHtml).join(""))
        + searchGroupHtml("challenges", state.search.challenges.map(searchChallengeRowHtml).join(""));
    }
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--steel)", "חיפוש בקהילה")}${box}${body}</div>`;
  }
  // COMM-120. The reactor avatar strip and total. Rendered inside the
  // engagement slot so the card markup itself is untouched; shown whenever a
  // post has reactions or its thread is open.
  function reactionStripHtml(post) {
    const pid = post && post.id;
    if (!pid) return "";
    const base = reactionState(pid);
    if (base.count > 0 || state.engagement.openComments[pid]) ensureReactionsLoaded(pid);
    const rs = reactionState(pid);
    const reactors = (rs.list || []).filter((r) => !isBlockedUser(r.id));
    const total = Number(rs.count || 0);
    if (!total && !reactors.length) return "";
    const avatars = reactors.slice(0, REACTOR_AVATARS_SHOWN)
      .map((r) => `<span style="display:inline-flex;margin-inline-start:-6px;">${avatarHtml(r.name || "?", 22, r.avatar_url)}</span>`).join("");
    const label = rs.mine
      ? (total <= 1 ? "הגבתם" : `הגבתם ועוד ${total - 1}`)
      : `${total} הגבות`;
    return `<div class="reaction-strip">${avatars ? `<span class="flex" style="padding-inline-start:6px;">${avatars}</span>` : ""}<span style="color:var(--steel);font-size:11.5px;">${esc(label)}</span></div>`;
  }
  // COMM-124. Text carries the meaning, not colour alone.
  function coachBadgeHtml(role) {
    const label = role === "head_coach" ? "מאמן/ת ראשי/ת" : role === "coach" ? "מאמן/ת" : "";
    if (!label) return "";
    return `<span class="coach-badge badge-tag">${label}</span>`;
  }
  function commentPlaceholder(text, reply) {
    return `<div class="comment-row" style="${reply ? "margin-inline-start:26px;" : ""}"><div style="flex:1;min-width:0;color:var(--steel);font-size:12px;font-style:italic;padding:4px 0;">${esc(text)}</div></div>`;
  }
  function renderCommentBubble(post, c, opts) {
    opts = opts || {};
    const meId = state.user && state.user.id;
    const removed = !!c.deleted_at || (!!c.status && c.status !== "active");
    if (isBlockedUser(c.author_id)) return commentPlaceholder("תגובה מוסתרת", opts.reply);
    if (removed) return commentPlaceholder("התגובה נמחקה", opts.reply);
    const role = memberRole(c.author_id);
    const isCoach = isCoachRole(role);
    const name = c.profiles ? (c.profiles.display_name || "@" + c.profiles.handle) : "חבר/ה";
    const own = c.author_id === meId;
    const editing = state.engagement.commentEdit && state.engagement.commentEdit.commentId === c.id;
    const wrapStyle = (opts.reply ? "margin-inline-start:26px;" : "")
      + (isCoach ? "border-inline-start:3px solid var(--brass);padding-inline-start:8px;background:color-mix(in srgb, var(--brass) 6%, transparent);border-radius:8px;" : "");
    let bodyHtml;
    if (editing) {
      const e = state.engagement.commentEdit;
      bodyHtml = `<div class="comment-edit" style="margin-top:4px;">
        <textarea class="text-input" data-comment-edit-input maxlength="${COMMENT_BODY_MAX}" rows="2" aria-label="עריכת תגובה">${esc(e.body || "")}</textarea>
        ${e.error ? `<div class="field-error" role="alert" style="margin-top:4px;">${esc(e.error)}</div>` : ""}
        <div class="chip-row" style="margin-top:6px;"><button class="chip-btn" data-community-action="comment-edit-cancel">ביטול</button><button class="chip-btn primary" data-community-action="comment-edit-save"${e.saving ? " disabled" : ""}>${e.saving ? "שומר…" : "שמירה"}</button></div>
      </div>`;
    } else {
      bodyHtml = `<div style="font-size:12.5px;line-height:1.55;"><b>${esc(name)}</b> ${isCoach ? coachBadgeHtml(role) + " " : ""}${mentionMarkersToHtml(c.body)}</div>`;
    }
    const edited = c.edited_at ? ` <span style="color:var(--steel);font-size:10.5px;" title="${esc(relativeTime(c.edited_at))}">(נערך)</span>` : "";
    const actions = [];
    if (!opts.reply) actions.push(`<button class="link-btn" data-community-action="comment-reply" data-post="${esc(post.id)}" data-id="${esc(c.id)}">תגובה</button>`);
    if (own && !editing) {
      actions.push(`<button class="link-btn" data-community-action="comment-edit" data-post="${esc(post.id)}" data-id="${esc(c.id)}">עריכה</button>`);
      actions.push(`<button class="link-btn" data-community-action="delete-comment" data-id="${esc(c.id)}" data-post="${esc(post.id)}" aria-label="מחיקת תגובה">מחיקה</button>`);
    }
    if (!own) actions.push(`<button class="link-btn" data-community-action="report-comment" data-id="${esc(c.id)}">דיווח</button>`);
    return `<div class="comment-row${isCoach ? " comment-coach" : ""}" style="${wrapStyle}">${avatarHtml(name, 24, c.profiles && c.profiles.avatar_url)}<div style="flex:1;min-width:0;">
      ${bodyHtml}
      <div class="flex gap-10" style="margin-top:2px;align-items:center;flex-wrap:wrap;"><span style="color:var(--steel);font-size:11px;">${esc(relativeTime(c.created_at))}</span>${edited}${actions.join("")}</div>
    </div></div>`;
  }
  function mentionPickerHtml(key) {
    const p = state.engagement.mentionPicker;
    if (!p || p.key !== key) return "";
    const items = p.results || [];
    const inner = p.loading
      ? `<div style="padding:8px 10px;color:var(--steel);font-size:12px;">מחפש חברים…</div>`
      : (items.length
        ? items.map((m, i) => `<button type="button" class="mention-option" role="option" data-community-action="mention-pick" data-key="${esc(key)}" data-id="${esc(m.id)}" data-name="${esc(m.display_name || m.handle)}" aria-selected="${i === (p.index || 0) ? "true" : "false"}" style="display:block;width:100%;text-align:right;padding:8px 10px;background:${i === (p.index || 0) ? "var(--surface2)" : "none"};border:0;color:var(--chalk);font-size:12.5px;cursor:pointer;">${nameHtml(m.display_name, m.handle)} <span style="color:var(--steel);"><bdi>@${esc(m.handle)}</bdi></span></button>`).join("")
        : `<div style="padding:8px 10px;color:var(--steel);font-size:12px;">אין התאמות</div>`);
    return `<div class="mention-picker" role="listbox" style="position:absolute;z-index:40;top:100%;inset-inline-start:0;margin-top:4px;min-width:220px;background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.25);max-height:180px;overflow-y:auto;">${inner}</div>`;
  }
  function commentComposerHtml(postId, parentId) {
    const key = commentKey(postId, parentId || null);
    const draft = state.engagement.commentDrafts[key] || "";
    const err = state.engagement.commentErrors[key];
    const sending = state.engagement.commentSending === key;
    const reply = !!parentId;
    return `${err ? `<div class="field-error" role="alert" style="margin:6px 0 4px;">${esc(err)} <button class="link-btn" data-community-action="comment-retry" data-post="${esc(postId)}"${reply ? ` data-parent="${esc(parentId)}"` : ""}>ניסיון חוזר</button></div>` : ""}
      <form data-comment-post-id="${esc(postId)}"${reply ? ` data-comment-parent-id="${esc(parentId)}"` : ""} class="flex gap-6" style="margin-top:8px;position:relative;flex-wrap:wrap;">
        <input class="text-input" name="body" data-comment-input data-comment-key="${esc(key)}" autocomplete="off" maxlength="${COMMENT_BODY_MAX}" placeholder="${reply ? "השבה לתגובה" : "הוספת תגובה"}" aria-label="${reply ? "השבה לתגובה" : "הוספת תגובה"}" value="${esc(draft)}"/>
        <button class="chip-btn primary" type="submit"${sending ? " disabled" : ""}>${sending ? "שולח…" : reply ? "השבה" : "שליחה"}</button>
        ${mentionPickerHtml(key)}
      </form>`;
  }
  function renderComments(post) {
    const pid = post && post.id;
    if (!pid) return "";
    const strip = reactionStripHtml(post);
    if (!state.engagement.openComments[pid]) return strip;

    const all = state.engagement.comments[pid] || [];
    const byId = {};
    for (const c of all) byId[c.id] = c;
    const tops = [];
    const repliesByParent = {};
    for (const c of all) {
      if (!c.parent_comment_id) { tops.push(c); continue; }
      (repliesByParent[c.parent_comment_id] = repliesByParent[c.parent_comment_id] || []).push(c);
    }
    const sortByTime = (a, b) => (a.created_at > b.created_at ? 1 : a.created_at < b.created_at ? -1 : 0);

    const nodeFor = (c) => {
      const kids = (repliesByParent[c.id] || []).slice().sort(sortByTime);
      const repliesOpen = !!state.engagement.openReplies[c.id];
      const hidden = isBlockedUser(c.author_id) || !!c.deleted_at || (!!c.status && c.status !== "active");
      let html = renderCommentBubble(post, c, { reply: false });
      if (kids.length) {
        html += `<div class="flex gap-10" style="margin:2px 0 2px 26px;"><button class="link-btn" data-community-action="toggle-replies" data-id="${esc(c.id)}">${repliesOpen ? "הסתרת תשובות" : `${kids.length} תשובות`}</button></div>`;
        if (repliesOpen) html += kids.map((k) => renderCommentBubble(post, k, { reply: true })).join("");
      }
      if (!hidden && state.engagement.replyTo[pid] === c.id) {
        html += `<div style="margin-inline-start:26px;">${commentComposerHtml(pid, c.id)}</div>`;
      }
      return html;
    };

    // COMM-121 / COMM-122. A reply whose parent is not in the returned set
    // means the parent was removed (RLS hides it). The reply still carries
    // parent_comment_id, so render a placeholder parent to hang it under.
    const orphanHtml = Object.keys(repliesByParent).filter((k) => !byId[k]).map((k) => {
      const kids = repliesByParent[k].slice().sort(sortByTime);
      return commentPlaceholder("התגובה נמחקה", false) + kids.map((x) => renderCommentBubble(post, x, { reply: true })).join("");
    }).join("");

    const listHtml = (tops.slice().sort(sortByTime).map(nodeFor).join("") + orphanHtml)
      || `<div class="empty" style="padding:6px 0;">התחילו את השיחה</div>`;

    return `${strip}<div style="margin-top:10px;"><div class="log-list">${listHtml}</div>${commentComposerHtml(pid, null)}</div>`;
  }
  // COMM-152/153. The moderation queue. Visible to a community.comment.moderate
  // holder or a real admin; mod_queue() enforces both and is the only path
  // that can resolve the reporter identities. Each row carries the content,
  // the reported member, the reporter count, the reason, the date and the
  // status. Actions (COMM-153) all open a sheet that calls mod_review().
  function renderModeration() {
    if (!(hasPerm(PERM.COMMENT_MODERATE) || isAdmin())) return "";
    const filters = `<div class="chip-row" style="margin:0 0 10px;">${MOD_QUEUE_STATUSES.map((s) =>
      `<button class="chip-btn${state.admin.modQueueStatus === s.id ? " selected" : ""}" data-community-action="mod-queue-status" data-status="${s.id}">${s.label}</button>`).join("")}</div>`;
    let body;
    if (state.admin.modQueueLoading && !state.admin.modQueue.length) {
      body = `<div class="log-list" aria-busy="true">${`<div class="log-row" aria-hidden="true"><span style="height:12px;width:60%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`.repeat(3)}</div>`;
    } else if (state.admin.modQueueError) {
      body = `<div class="empty">לא ניתן היה לטעון את התור.<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="mod-queue-retry">ניסיון חוזר</button></div></div>`;
    } else if (!state.admin.modQueue.length) {
      body = `<div class="empty">אין מה לבדוק.</div>`;
    } else {
      const rowHtml = (r) => {
        const done = r.status === "action_taken" || r.status === "dismissed";
        const reasons = Array.isArray(r.reasons) && r.reasons.length ? r.reasons : (r.latest_reason ? [r.latest_reason] : []);
        return `<div class="chart-card" style="margin-bottom:10px;" data-mod-report-id="${esc(r.report_id)}">
          <div class="flex" style="justify-content:space-between;align-items:flex-start;gap:10px;">
            <div style="min-width:0;">
              <div style="font-weight:800;">${esc(r.target_type === "comment" ? "תגובה" : "פוסט")} · ${esc(r.content_author_name || "חבר/ה שהוסר/ה")}</div>
              <div style="color:var(--steel);font-size:12.5px;margin-top:4px;white-space:pre-wrap;">${esc(String(r.content_excerpt || "התוכן הוסר").slice(0, 240))}</div>
            </div>
            <span class="admin-tag" style="${r.status === "open" ? "background:rgba(194,57,44,.12);border-color:var(--red);color:var(--red);" : ""}">${esc(MOD_STATUS_LABEL[r.status] || r.status)}</span>
          </div>
          <div style="color:var(--steel);font-size:12px;margin-top:8px;">
            ${Number(r.reporter_count || 0)} דיווחים · ${reasons.map(reportReasonLabel).map(esc).join(", ") || "—"} · ${relativeTime(r.created_at)}
          </div>
          ${r.note ? `<div style="color:var(--steel);font-size:12px;margin-top:4px;">״${esc(String(r.note).slice(0, 240))}״</div>` : ""}
          <div class="chip-row" style="margin-top:10px;">
            <button class="chip-btn" data-community-action="mod-context" data-id="${esc(r.report_id)}">צפייה בהקשר</button>
            ${done ? "" : MOD_DECISIONS.map((d) =>
              `<button class="chip-btn${d.destructive ? " danger" : ""}" data-community-action="mod-action" data-id="${esc(r.report_id)}" data-decision="${d.id}">${d.label}</button>`).join("")}
          </div>
        </div>`;
      };
      body = state.admin.modQueue.map(rowHtml).join("");
    }
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--red)", "תור מודרציה", true)}${filters}${body}</div>`;
  }
  // COMM-154. Read-only admin audit view, gated on community.analytics.view.
  function auditActionLabel(t) {
    return {
      content_delete: "הסרת תוכן", content_hide: "הסתרת תוכן", member_restrict: "הגבלת חבר/ה",
      member_unrestrict: "ביטול הגבלה", role_change: "שינוי הרשאה", challenge_edit: "עריכת אתגר",
      achievement_edit: "עריכת עיטור", privacy_config: "הגדרת פרטיות", content_pin: "הצמדת תוכן",
      content_unpin: "ביטול הצמדה", report_review: "בדיקת דיווח",
      // The three action types added after COMM-154. Without these the log
      // rendered the raw English action_type ("club_feature_toggle · club")
      // in an otherwise all-Hebrew list, and the filter row had no chip to
      // narrow by them at all.
      member_of_week_publish: "פרסום חבר/ת השבוע", monthly_recap_publish: "פרסום סיכום חודשי",
      club_feature_toggle: "שינוי מודול מועדון",
    }[t] || t;
  }
  // The other half of an audit row's headline. admin_actions.target_type is
  // a closed 13-value list (202608280002 and the migrations that widened it);
  // rendering it raw put English next to the Hebrew action label on every
  // row. Same shape as pinTargetLabel() further down.
  function auditTargetLabel(t) {
    return {
      post: "פוסט", comment: "תגובה", member: "חבר/ה", role: "הרשאה", challenge: "אתגר",
      achievement: "עיטור", event: "אירוע", announcement: "הודעה", report: "דיווח",
      club: "מועדון", monthly_club_recap: "סיכום חודשי",
      challenge_participant: "משתתף/ת באתגר", challenge_team: "קבוצה באתגר",
    }[t] || t;
  }
  const AUDIT_ACTION_TYPES = ["content_delete", "content_hide", "member_restrict", "member_unrestrict", "role_change", "challenge_edit", "achievement_edit", "privacy_config", "content_pin", "content_unpin", "report_review", "member_of_week_publish", "monthly_recap_publish", "club_feature_toggle"];
  function renderAuditLog() {
    if (!hasPerm(PERM.ANALYTICS_VIEW)) return "";
    const filterChips = `<div class="chip-row" style="margin:0 0 10px;">
      <button class="chip-btn${!state.admin.auditFilters.action_type ? " selected" : ""}" data-community-action="audit-filter" data-type="">הכול</button>
      ${AUDIT_ACTION_TYPES.map((t) => `<button class="chip-btn${state.admin.auditFilters.action_type === t ? " selected" : ""}" data-community-action="audit-filter" data-type="${t}">${auditActionLabel(t)}</button>`).join("")}
    </div>`;
    let body;
    if (state.admin.auditLoading && !state.admin.auditLog.length) {
      body = `<div class="log-list" aria-busy="true">${`<div class="log-row" aria-hidden="true"><span style="height:12px;width:55%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`.repeat(4)}</div>`;
    } else if (state.admin.auditError) {
      body = `<div class="empty">לא ניתן היה לטעון את היומן.<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="audit-retry">ניסיון חוזר</button></div></div>`;
    } else if (!state.admin.auditLog.length) {
      body = `<div class="empty">עדיין לא נרשמו פעולות ניהול.</div>`;
    } else {
      body = `<div class="log-list">${state.admin.auditLog.map((a) => `<div class="log-row" style="flex-direction:column;align-items:flex-start;gap:3px;">
        <div style="font-weight:700;">${esc(auditActionLabel(a.action_type))} · ${esc(auditTargetLabel(a.target_type))}</div>
        <div style="color:var(--steel);font-size:11px;">מנהל/ת ${esc(String(a.admin_id || "").slice(0, 8))} · ${relativeTime(a.created_at)}</div>
      </div>`).join("")}</div>${state.admin.auditEnd ? "" : `<div class="chip-row" style="justify-content:center;margin-top:8px;"><button class="chip-btn" data-community-action="audit-more"${state.admin.auditLoading ? " disabled" : ""}>${state.admin.auditLoading ? "טוען…" : "טעינת עוד"}</button></div>`}`;
    }
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--steel)", "יומן פעולות ניהול", true)}${filterChips}${body}</div>`;
  }
  function memberRoleLabel(m) {
    if (m.is_admin) return "מנהל/ת";
    return roleCodeLabel(m.role) || (m.role === "member" ? "חבר/ה" : "לא הצטרפ/ה עדיין");
  }
  // COMM-156. member -> coach and coach -> member keep the original
  // dedicated controls. head_coach is the added selectable role. `readOnly`
  // (COMM-377) renders the exact same buttons, disabled, with a tooltip -
  // for a staff viewer who is not a real admin, browsing the roster - rather
  // than a second control set: the server-side boundary (admin_grant_coach/
  // admin_revoke_coach's own inline is_admin()) is unchanged either way,
  // this only decides whether the control looks clickable.
  function memberRoleButtonsHtml(m, readOnly) {
    const role = m.role || "member";
    const dis = readOnly ? ' disabled title="שינוי הרשאה זמין למנהל/ת בלבד"' : "";
    const btns = [];
    if (role === "coach" || role === "head_coach") {
      btns.push(`<button class="chip-btn"${dis} data-community-action="admin-revoke-coach" data-id="${esc(m.id)}">ביטול הרשאת מאמן/ת</button>`);
    } else {
      btns.push(`<button class="chip-btn"${dis} data-community-action="admin-grant-coach" data-id="${esc(m.id)}">הענקת הרשאת מאמן/ת</button>`);
    }
    if (role !== "head_coach") {
      btns.push(`<button class="chip-btn"${dis} data-community-action="admin-set-role" data-id="${esc(m.id)}" data-role="head_coach">הפיכה למאמן/ת ראשי/ת</button>`);
    } else {
      btns.push(`<button class="chip-btn"${dis} data-community-action="admin-set-role" data-id="${esc(m.id)}" data-role="coach">הורדה למאמן/ת</button>`);
    }
    return btns.join("");
  }
  // COMM-377. The exact row shape and renderer admin_search_members'
  // results already use, shared verbatim with the roster's own rows
  // (admin_member_roster returns the identical eight columns, pgTAP 0060's
  // own assertion) - no second row template. `opts.readOnly` disables the
  // role buttons (a staff-but-not-admin roster viewer); `opts.showRemove`
  // (default true) hides the destructive remove-member control on the
  // roster row, which this ticket's own acceptance criteria never asks for
  // there - only the dedicated search-based panel below offers it.
  function memberManagementRowHtml(m, opts) {
    opts = opts || {};
    const readOnly = !!opts.readOnly;
    const showRemove = opts.showRemove !== false;
    return `<div class="log-row" style="align-items:flex-start;flex-direction:column;gap:6px;">
      <div class="flex gap-10" style="align-items:center;">${avatarHtml(m.display_name || m.handle, 32, m.avatar_url)}<div><div style="font-weight:700;">${nameHtml(m.display_name, m.handle)}${isCoachRole(m.role) ? " " + coachBadgeHtml(m.role) : ""}</div><div style="color:var(--steel);font-size:11px;"><bdi>@${esc(m.handle)}</bdi> · ${memberRoleLabel(m)}</div></div></div>
      <div style="color:var(--steel);font-size:11px;">הצטרפ/ה: ${m.redeemed_at ? esc(String(m.redeemed_at).slice(0, 10)) : "—"} · פעילות אחרונה: ${m.last_activity_on ? esc(m.last_activity_on) : "מעולם לא"}</div>
      <div class="footer-note" style="margin:0;font-size:10.5px;">${esc(m.id)}</div>
      ${m.is_admin ? "" : `<div class="chip-row" style="margin-top:0;">
        ${memberRoleButtonsHtml(m, readOnly)}
        ${showRemove ? `<button class="chip-btn danger" data-community-action="admin-remove-member" data-id="${esc(m.id)}">הסרת חבר/ה</button>` : ""}
      </div>`}
      <div class="chip-row" style="margin-top:0;">
        <button class="chip-btn"${readOnly ? ' disabled title="זמין למנהל/ת בלבד"' : ""} data-community-action="admin-reset-password" data-id="${esc(m.id)}">איפוס סיסמה</button>
      </div>
    </div>`;
  }
  function renderMemberManagement() {
    if (!isAdmin()) return "";
    const results = state.members.results;
    const pr = state.admin.passwordResetResult;
    const passwordResetHtml = pr ? `<div class="chart-card" style="margin-bottom:10px;border:1px solid var(--brass);" data-password-reset-created="1">
      <div class="field-label" style="margin-bottom:4px;">הסיסמה אופסה - זו הפעם היחידה שהיא תוצג. מסרו אותה לחבר/ה ישירות.</div>
      <div class="flex gap-10" style="align-items:center;flex-wrap:wrap;">
        <code class="mono" style="font-size:15px;">${esc(pr.tempPassword)}</code>
        <button class="chip-btn" data-community-action="copy-invite-code" data-code="${esc(pr.tempPassword)}">העתקה</button>
        <button class="link-btn" data-community-action="close-password-reset-result">סגירה</button>
      </div>
    </div>` : "";
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--purple)", "ניהול חברים", true)}
      ${passwordResetHtml}
      <div class="search-box"><input id="adminMemberSearch" placeholder="חיפוש לפי handle, שם, או הדבקת מזהה משתמש" aria-label="חיפוש חברים לניהול" value="${esc(state.members.search)}"/></div>
      ${results.length ? `<div class="log-list">${results.map((m) => memberManagementRowHtml(m, { readOnly: false, showRemove: true })).join("")}</div>` : state.members.search.trim().length >= 2 ? `<div class="empty">לא נמצאו חברים תואמים</div>` : `<div class="empty">חיפוש לפי handle, שם, או מזהה משתמש (UUID)</div>`}
    </div>`;
  }
  // ---- COMM-377. Member roster -------------------------------------------
  // A new browse entry point onto the SAME member-management area
  // renderMemberManagement() already offers by search - not a second
  // implementation. Read gate is is_staff() (admin_member_roster's own
  // AUTH), deliberately looser than renderMemberManagement()'s is_admin():
  // a coach may browse every row and act on none, via the readOnly role
  // buttons above.
  const ROSTER_PAGE_SIZE = 25;
  async function loadRoster(reset) {
    if (!state.user || !isStaff()) { state.admin.roster.items = []; return; }
    const r = state.admin.roster;
    if (reset) { r.items = []; r.cursor = null; r.end = false; r.loading = true; } else { r.loadingMore = true; }
    r.error = false; rerender();
    const { data, error } = await client.rpc("admin_member_roster", { p_cursor: r.cursor, p_limit: ROSTER_PAGE_SIZE });
    r.loading = false; r.loadingMore = false; r.loaded = true;
    if (error) { r.error = true; rerender(); return; }
    const page = Array.isArray(data) ? data : [];
    r.items = reset ? page : r.items.concat(page);
    const last = page[page.length - 1];
    // GAP flagged in docs/community/backlog.md's COMM-377 paragraph:
    // admin_member_roster sorts and pages on coalesce(invite_redemptions.
    // redeemed_at, profiles.created_at), but only ever returns redeemed_at -
    // a profile with no invite_redemptions row (mid-signup, or a pre-invite-
    // gate legacy account) sorts on a created_at value this client never
    // sees, so there is no correct next cursor once such a row is the last
    // one on a page. Resending a null cursor would not skip it - the RPC
    // reads a null p_cursor as "no bound at all" and restarts from the very
    // top, looping the same rows forever - so pagination simply stops one
    // page early there instead. Every row already fetched is real and
    // correctly ordered; the only cost is not reaching further into a
    // club's legacy tail in one browsing session.
    r.end = page.length < ROSTER_PAGE_SIZE || !last || last.redeemed_at == null;
    r.cursor = last ? last.redeemed_at : r.cursor;
    rerender();
  }
  function renderMemberRoster() {
    if (!isStaff()) return "";
    const r = state.admin.roster;
    let body;
    if (r.loading && !r.items.length) {
      const skRow = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:55%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
      body = `<div class="log-list" aria-busy="true" data-member-roster-skeleton="1">${skRow.repeat(4)}</div>`;
    } else if (r.error) {
      body = `<div class="empty">לא ניתן היה לטעון את רשימת החברים.<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="roster-retry">ניסיון חוזר</button></div></div>`;
    } else {
      const readOnly = !isAdmin();
      body = `<div class="log-list">${r.items.map((m) => memberManagementRowHtml(m, { readOnly, showRemove: false })).join("")}</div>${r.end ? "" : `<div class="chip-row" style="justify-content:center;margin-top:8px;"><button class="chip-btn" data-community-action="roster-more"${r.loadingMore ? " disabled" : ""}>${r.loadingMore ? "טוען…" : "טעינת עוד"}</button></div>`}`;
    }
    return `<div class="ach-section" style="margin-top:18px;" data-member-roster-section="1">${sectionHead("var(--teal)", "רשימת חברים", true)}${body}</div>`;
  }
  // COMM-321 Club Modules. Same gating idiom the other four admin-only
  // account sections already use (renderModeration, renderMemberManagement,
  // renderAdminAnalyticsDashboard, renderAuditLog): `if (!allowed) return ""`
  // at the top, unconditionally appended into accountTab - no dedicated
  // sub-tab, matching this codebase's own precedent that a single admin
  // screen never gets one (only "coach", a whole role tier's toolset, does).
  function renderClubModulesPanel() {
    if (!(hasPerm(PERM.CLUB_MANAGE_MODULES) || isAdmin())) return "";
    // toggleClubFeature() is single-flight (it returns early while
    // state.club.moduleBusy is set), so EVERY row has to be disabled while a
    // write is in flight, not just the one being written: leaving the other
    // five live let a second tap flip a checkbox that the guard then dropped
    // with no message, and the next rerender silently put it back - which is
    // exactly "the toggles don't work". Same busy/anyBusy split
    // renderMemberOfWeekPickForm already uses: `busy` still labels only the
    // row actually saving.
    const anyBusy = !!state.club.moduleBusy;
    const rows = CLUB_MODULE_TOGGLES.map((m) => {
      const row = state.club.features[m.key] || { enabled: true, config: {} };
      const busy = state.club.moduleBusy === m.key;
      return `<label class="log-row" style="justify-content:space-between;gap:12px;cursor:pointer;">
        <span style="font-size:13px;">${esc(m.label)}${busy ? " (שומר…)" : ""}</span>
        <input type="checkbox" data-club-feature="${m.key}"${row.enabled ? " checked" : ""}${anyBusy ? " disabled" : ""} aria-label="${esc(m.label)}"/>
      </label>`;
    }).join("");
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--green)", "מודולים למועדון", true)}
      <div style="color:var(--steel);font-size:12px;line-height:1.6;margin-bottom:8px;">כיבוי מודול מסתיר אותו לגמרי מכל חברי המועדון - אין טאב, כרטיס, כפתור או התראה - ואוכף בשרת, לא רק בתצוגה.</div>
      <div class="log-list">${rows}</div>
    </div>`;
  }
  // ==========================================================================
  // COMM-310. Admin community analytics dashboard - render half.
  //
  // Small shared building blocks first (period selector, value formatters,
  // a plain metric-card wrapper), then one render function per metric - 5
  // for "core", 13 for "additional", named and grouped exactly the way
  // analytics_dashboard()'s own response and docs/community/metrics.md's
  // own section headers are, so a reviewer can match a render function to
  // its metrics.md bullet without re-deriving the mapping. THE SHELL a
  // later ticket (COMM-311/312/313) extends is renderAdminAnalyticsDashboard()
  // itself: append a call to a new section-render function after the two
  // metrics.md groups, inside the same populated branch, reusing the same
  // state.analytics.dashboard.start/end and the same period selector - not a
  // second nav entry, not a second RPC-driven load cycle.
  // ==========================================================================
  function renderAdminAnalyticsPeriodSelector() {
    const a = state.analytics.dashboard;
    const modeBtn = (id, label) => `<button class="chip-btn${a.mode === id ? " selected" : ""}" data-community-action="admin-analytics-mode" data-mode="${id}">${label}</button>`;
    return `<div class="chip-row" style="margin:0 0 10px;align-items:center;">
      ${modeBtn("week", "שבוע")}${modeBtn("month", "חודש")}
      <button class="chip-btn" data-community-action="admin-analytics-shift" data-dir="-1" aria-label="התקופה הקודמת">‹ קודם</button>
      <span style="color:var(--steel);font-size:12px;white-space:nowrap;">${esc(a.start || "")} — ${esc(a.end || "")}</span>
      <button class="chip-btn" data-community-action="admin-analytics-shift" data-dir="1" aria-label="התקופה הבאה">הבא ›</button>
    </div>`;
  }
  // null/undefined (the RPC's own "ratio over a zero denominator" convention,
  // analytics_ratio() in 202609010006) renders as an em dash, never a false
  // "0" or "0%" - COMM-310's own rule, quoted in the migration's comments.
  function adminAnalyticsRatioText(v, asPercent) {
    if (v === null || v === undefined) return "—";
    const n = Number(v);
    if (!isFinite(n)) return "—";
    return asPercent ? (Math.round(n * 1000) / 10) + "%" : String(n);
  }
  function adminAnalyticsCount(v) { return (v === null || v === undefined) ? "—" : esc(v); }
  function adminAnalyticsRow(label, value) {
    return `<div class="log-row"><span>${esc(label)}</span><span class="mono" style="color:var(--brass);">${value}</span></div>`;
  }
  // A jsonb {key: count} breakdown - ten of the eighteen metrics carry one,
  // per analytics_breakdown()'s own "count by one prop" shape - rendered
  // largest-first. The keys are enum-shaped values a member's own client
  // wrote (scope, source, tab, reason...), rendered verbatim rather than
  // translated: a raw string here is more honest than a label table this
  // file would have to keep in sync with every producer's own prop values.
  function adminAnalyticsBreakdownList(obj) {
    const entries = Object.entries(obj || {}).sort((x, y) => Number(y[1]) - Number(x[1]));
    if (!entries.length) return `<div class="empty" style="padding:4px 0;">אין נתונים בתקופה זו</div>`;
    return `<div class="log-list">${entries.map(([k, v]) => adminAnalyticsRow(k, adminAnalyticsCount(v))).join("")}</div>`;
  }
  function adminAnalyticsCard(title, bodyHtml) {
    return `<div class="chart-card" style="margin-bottom:10px;"><h3 class="field-label" style="margin-bottom:6px;">${esc(title)}</h3>${bodyHtml}</div>`;
  }
  // ---- Core metrics (metrics.md "## Core metrics", 5) --------------------
  function renderAdminAnalyticsWcam(core) {
    const w = core.wcam || {};
    const share = core.wcam_share || {};
    const weeks = Array.isArray(w.weeks) ? w.weeks : [];
    const weeksHtml = weeks.length
      ? `<div class="log-list">${weeks.map((wk) => adminAnalyticsRow(`${esc(wk.week_start)}${wk.partial ? " (חלקי)" : ""}`, adminAnalyticsCount(wk.active_members))).join("")}</div>`
      : `<div class="empty" style="padding:4px 0;">אין נתונים בתקופה זו</div>`;
    return adminAnalyticsCard("חברים פעילים שבועית (WCAM)",
      weeksHtml
      + adminAnalyticsRow("ממוצע שבועי", adminAnalyticsCount(w.average_weekly))
      + adminAnalyticsRow("שיא שבועי", adminAnalyticsCount(w.peak_weekly))
      + adminAnalyticsRow("נתח מהחברים (ממוצע שבועי, לא WCAM עצמו)", adminAnalyticsRatioText(share.average_share, true))
      + adminAnalyticsRow("סה״כ פעילים בתקופה כולה (לא WCAM)", adminAnalyticsCount(w.period_active_members)));
  }
  function renderAdminAnalyticsPosting(core) {
    const p = core.posting_members || {};
    const weeks = Array.isArray(p.weeks) ? p.weeks : [];
    const weeksHtml = weeks.length
      ? `<div class="log-list">${weeks.map((wk) => adminAnalyticsRow(`${esc(wk.week_start)}${wk.partial ? " (חלקי)" : ""}`, adminAnalyticsCount(wk.posting_members))).join("")}</div>`
      : `<div class="empty" style="padding:4px 0;">אין נתונים בתקופה זו</div>`;
    return adminAnalyticsCard("חברים שפרסמו, לפי שבוע",
      weeksHtml
      + adminAnalyticsRow("ממוצע שבועי", adminAnalyticsCount(p.average_weekly))
      + adminAnalyticsRow("סה״כ מפרסמים בתקופה כולה", adminAnalyticsCount(p.period_posting_members)));
  }
  function renderAdminAnalyticsEngagement(core) {
    const e = core.engagement_per_post || {};
    const period = e.period || {};
    const cross = e.table_cross_check || {};
    return adminAnalyticsCard("מעורבות לפוסט",
      adminAnalyticsRow("פוסטים בתקופה", adminAnalyticsCount(period.posts))
      + adminAnalyticsRow("עידודים", adminAnalyticsCount(period.reactions))
      + adminAnalyticsRow("תגובות", adminAnalyticsCount(period.comments))
      + adminAnalyticsRow("מעורבות לפוסט (מהאירועים)", adminAnalyticsRatioText(period.engagement_per_post))
      + adminAnalyticsRow("מעורבות לפוסט (בקרת הצלבה מהטבלאות)", adminAnalyticsRatioText(cross.engagement_per_post)));
  }
  function renderAdminAnalyticsFeedReach(core) {
    const f = core.feed_reach || {};
    return adminAnalyticsCard("חשיפה בפיד",
      adminAnalyticsRow("פוסטים שפורסמו", adminAnalyticsCount(f.posts_published))
      + adminAnalyticsRow("פוסטים שקיבלו חשיפה", adminAnalyticsCount(f.posts_with_impressions))
      + adminAnalyticsRow("נתח פוסטים שנחשפו", adminAnalyticsRatioText(f.reach_share, true))
      + adminAnalyticsRow("סה״כ הופעות בפיד", adminAnalyticsCount(f.impressions_total))
      + adminAnalyticsRow("הופעות לפוסט שנחשף", adminAnalyticsRatioText(f.impressions_per_reached_post)));
  }
  function renderAdminAnalyticsCoreGroup(data) {
    const core = data.core || {};
    return `<div class="field-label" style="margin:4px 0 8px;">מדדי ליבה</div>`
      + renderAdminAnalyticsWcam(core)
      + renderAdminAnalyticsPosting(core)
      + renderAdminAnalyticsEngagement(core)
      + renderAdminAnalyticsFeedReach(core);
  }
  // ---- Additional metrics (metrics.md "## Additional metrics", 13) -------
  function renderAdminAnalyticsOpenRate(add) {
    const obj = add.open_rate || {};
    const keys = Object.keys(obj);
    const body = keys.length
      ? `<div class="log-list">${keys.map((k) => adminAnalyticsRow(k, `${adminAnalyticsCount(obj[k].opens)}/${adminAnalyticsCount(obj[k].impressions)} · ${adminAnalyticsRatioText(obj[k].open_rate, true)}`)).join("")}</div>`
      : `<div class="empty" style="padding:4px 0;">אין נתונים בתקופה זו</div>`;
    return adminAnalyticsCard("אחוז פתיחה לפי סוג פוסט", body);
  }
  function renderAdminAnalyticsFilterUse(add) {
    const fu = add.filter_use || {};
    const sessions = fu.sessions || {};
    return adminAnalyticsCard("שימוש בסינון הפיד",
      `<div class="field-label" style="margin:6px 0 4px;font-size:11px;">לפי scope</div>${adminAnalyticsBreakdownList(fu.by_scope)}`
      + `<div class="field-label" style="margin:8px 0 4px;font-size:11px;">לפי מקור</div>${adminAnalyticsBreakdownList(fu.by_source)}`
      + adminAnalyticsRow("שיעור שינוי סינון (בבסיס חבר/יום, ראו הערה)", adminAnalyticsRatioText(sessions.scope_change_share, true))
      + `<div class="footer-note" style="margin-top:4px;">הבסיס הוא זוג (חבר/ה, יום קלנדרי) ולא סשן ממשי - ראו תיעוד המדד.</div>`);
  }
  function renderAdminAnalyticsSubTab(add) {
    const s = add.sub_tab_split || {};
    return adminAnalyticsCard("פילוח תת-לשוניות (Club Tab)",
      adminAnalyticsRow("סה״כ צפיות", adminAnalyticsCount(s.total)) + adminAnalyticsBreakdownList(s.by_tab));
  }
  function renderAdminAnalyticsNotifEff(add) {
    const obj = add.notification_effectiveness || {};
    const keys = Object.keys(obj);
    const body = keys.length
      ? `<div class="log-list">${keys.map((k) => adminAnalyticsRow(k, `${adminAnalyticsCount(obj[k].opened_unread)}/${adminAnalyticsCount(obj[k].delivered)} · ${adminAnalyticsRatioText(obj[k].open_rate, true)}`)).join("")}</div>`
      : `<div class="empty" style="padding:4px 0;">אין נתונים בתקופה זו</div>`;
    return adminAnalyticsCard("אפקטיביות התראות (פתיחה שלא-חוזרת / נמסרו)", body);
  }
  function renderAdminAnalyticsSocial(add) {
    const s = add.social_graph_growth || {};
    const mf = s.member_followed || {};
    const po = s.profile_opened || {};
    return adminAnalyticsCard("צמיחת הגרף החברתי",
      adminAnalyticsRow("עוקבים חדשים (סה״כ בתקופה)", adminAnalyticsCount(mf.total))
      + adminAnalyticsRow("עוקבים חדשים (ממוצע לשבוע)", adminAnalyticsRatioText(mf.per_week))
      + adminAnalyticsRow("צפיות בפרופיל של חבר/ה אחר/ת", adminAnalyticsCount(po.other))
      + adminAnalyticsRow("צפיות בפרופיל העצמי", adminAnalyticsCount(po.self))
      + adminAnalyticsRow("שיעור המרה לצפייה←מעקב", adminAnalyticsRatioText(s.follow_conversion, true)));
  }
  function renderAdminAnalyticsChallengePull(add) {
    const c = add.challenge_leaderboard_pull || {};
    const cv = c.challenge_viewed || {}, lv = c.leaderboard_viewed || {}, cj = c.challenge_joined || {};
    return adminAnalyticsCard("משיכת אתגרים ולוחות מובילים",
      adminAnalyticsRow("צפיות באתגר", adminAnalyticsCount(cv.total))
      + adminAnalyticsRow("צפיות בלוח מובילים", adminAnalyticsCount(lv.total))
      + adminAnalyticsRow("הצטרפויות לאתגר", adminAnalyticsCount(cj.total))
      + adminAnalyticsRow("שיעור המרה: צפייה←הצטרפות", adminAnalyticsRatioText(c.join_rate, true)));
  }
  function renderAdminAnalyticsModerationLoad(add) {
    const m = add.moderation_load || {};
    const rs = m.reports_submitted || {};
    const q = m.queue || {};
    return adminAnalyticsCard("עומס מודרציה",
      adminAnalyticsRow("דיווחים שנשלחו (אירועים)", adminAnalyticsCount(rs.total))
      + adminAnalyticsRow("שורות שנוצרו בתור בתקופה", adminAnalyticsCount(q.rows_created_in_period))
      + adminAnalyticsRow("פתוחים בתור כרגע (לא מוגבל לתקופה)", adminAnalyticsCount(q.open_now)));
  }
  function renderAdminAnalyticsShareIntent(add) {
    const s = add.share_intent_split || {};
    const ws = s.workout_shared || {}, ach = s.achievement_shared || {};
    return adminAnalyticsCard("כוונת שיתוף",
      adminAnalyticsRow("שיתופי אימון", adminAnalyticsCount(ws.total))
      + adminAnalyticsRow("שיתופי הישג", adminAnalyticsCount(ach.total)));
  }
  function renderAdminAnalyticsRecap(add) {
    const r = add.recap_pull_through || {};
    const opened = r.opened || {}, shared = r.shared || {};
    return adminAnalyticsCard("חדירת התקציר השבועי",
      adminAnalyticsRow("פתיחות תקציר", adminAnalyticsCount(opened.total))
      + adminAnalyticsRow("התראות תקציר שנשלחו", adminAnalyticsCount(r.notifications_sent))
      + adminAnalyticsRow("שיעור פתיחה (יכול לעבור 100%, ראו הערה)", adminAnalyticsRatioText(r.open_rate, true))
      + adminAnalyticsRow("שיתופי תקציר", adminAnalyticsCount(shared.total))
      + adminAnalyticsRow("שיעור שיתוף", adminAnalyticsRatioText(r.share_rate, true)));
  }
  function renderAdminAnalyticsDiscovery(add) {
    const d = add.discovery_split || {};
    const sp = d.search_performed || {}, dir = d.directory_opened || {};
    return adminAnalyticsCard("פילוח גילוי (חיפוש מול מדריך חברים)",
      adminAnalyticsRow("חיפושים", adminAnalyticsCount(sp.total))
      + adminAnalyticsRow("חיפושים ללא תוצאות", adminAnalyticsCount(sp.zero_member_result))
      + adminAnalyticsRow("שיעור אפס תוצאות", adminAnalyticsRatioText(sp.zero_member_rate, true))
      + adminAnalyticsRow("פתיחות מדריך חברים", adminAnalyticsCount(dir.total))
      + adminAnalyticsRow("חיפוש מול מדריך (יחס)", adminAnalyticsRatioText(d.search_vs_directory)));
  }
  function renderAdminAnalyticsCoachReach(add) {
    const c = add.coach_reach || {};
    const cong = c.congratulations || {};
    return adminAnalyticsCard("היקף פניות מאמנים",
      adminAnalyticsRow("ברכות שנשלחו", adminAnalyticsCount(cong.total))
      + adminAnalyticsRow("פריטים זכאים לברכה (סף עליון, לא שידור מדויק)", adminAnalyticsCount(c.celebrate_items_eligible))
      + adminAnalyticsRow("כיסוי (סף תחתון)", adminAnalyticsRatioText(c.coverage, true)));
  }
  function renderAdminAnalyticsPush(add) {
    const p = add.push_adoption || {};
    const oi = p.opt_in_events || {}, subs = p.subscriptions || {};
    return adminAnalyticsCard("אימוץ התראות Push",
      adminAnalyticsRow("הצטרפויות ל-push (אירועים בתקופה)", adminAnalyticsCount(oi.total))
      + adminAnalyticsRow("מנויים פעילים כרגע (לא מוגבל לתקופה)", adminAnalyticsCount(subs.active_now))
      + adminAnalyticsRow("מנויים שבוטלו", adminAnalyticsCount(subs.revoked_now))
      + adminAnalyticsRow("חברים ברי-הגעה כרגע", adminAnalyticsCount(subs.members_reachable_now)));
  }
  function renderAdminAnalyticsClassmates(add) {
    const c = add.trained_with_you_reach || {};
    const cv = c.card_views || {};
    return adminAnalyticsCard("חשיפת ״התאמנו איתך״",
      adminAnalyticsRow("צפיות בכרטיס", adminAnalyticsCount(cv.total))
      + adminAnalyticsRow("סה״כ חברי אימון שהוצגו", adminAnalyticsCount(c.classmates_shown_total))
      + adminAnalyticsRow("ממוצע חברי אימון לכרטיס", adminAnalyticsRatioText(c.classmates_per_card))
      + adminAnalyticsRow("שיעור הופעת כרטיס מתוך אימונים שנרשמו", adminAnalyticsRatioText(c.card_rate, true))
      // The server ships this caveat as an English `note`; every other
      // footer-note in this dashboard is client-side Hebrew copy
      // (renderAdminAnalyticsFilterUse just above does the same), so the
      // Hebrew is written here rather than echoing the server string.
      + `<div class="footer-note" style="margin-top:4px;">שיעור ההופעה מוגבל מלכתחילה באימוץ של הגדרת ״נוכחות בשיעורים גלויה״: שני הצדדים בכל זוג חייבים להפעיל אותה, וברירת המחדל היא כבוי. ערך נמוך מעיד על אימוץ, לא על כרטיס תקול.</div>`);
  }
  function renderAdminAnalyticsAdditionalGroup(data) {
    const add = data.additional || {};
    return `<div class="field-label" style="margin:14px 0 8px;">מדדים נוספים</div>`
      + renderAdminAnalyticsOpenRate(add)
      + renderAdminAnalyticsFilterUse(add)
      + renderAdminAnalyticsSubTab(add)
      + renderAdminAnalyticsNotifEff(add)
      + renderAdminAnalyticsSocial(add)
      + renderAdminAnalyticsChallengePull(add)
      + renderAdminAnalyticsModerationLoad(add)
      + renderAdminAnalyticsShareIntent(add)
      + renderAdminAnalyticsRecap(add)
      + renderAdminAnalyticsDiscovery(add)
      + renderAdminAnalyticsCoachReach(add)
      + renderAdminAnalyticsPush(add)
      + renderAdminAnalyticsClassmates(add);
  }
  // ---- Member engagement segmentation (COMM-311) --------------------------
  // Renders as a new section appended INSIDE renderAdminAnalyticsDashboard()'s
  // own populated branch (see that function, below), after the two
  // metrics.md groups - not a second nav destination, not a second period
  // selector. member_segments()'s six buckets, in the SAME precedence order
  // the migration's CASE expression uses (new > declining > highly_active >
  // steady > occasional > dormant) - display order mirrors decision order on
  // purpose, so a reviewer reading top-to-bottom sees the same priority the
  // server actually applied. Hebrew labels and one-line descriptions are
  // written to match those definitions exactly, not loosely.
  const MEMBER_SEGMENT_ORDER = ["new", "declining", "highly_active", "steady", "occasional", "dormant"];
  const MEMBER_SEGMENT_LABELS = {
    new: "חדשים/ות", declining: "בירידה", highly_active: "פעילים/ות מאוד",
    steady: "יציבים/ות", occasional: "מזדמנים/ות", dormant: "רדומים/ות",
  };
  const MEMBER_SEGMENT_DESCRIPTIONS = {
    new: "בתוך 30 הימים הראשונים לחברות",
    declining: "יש דגל ירידה בהגעה פתוח (COMM-304)",
    highly_active: "פעילים בכל אחד מ-4 השבועות המלאים האחרונים",
    steady: "פעילים בלפחות 4 מתוך 8 השבועות המלאים האחרונים",
    occasional: "פעילים ב-1 עד 3 מתוך 8 השבועות המלאים האחרונים",
    dormant: "ללא פעילות ב-8 השבועות המלאים האחרונים",
  };
  // One row per club member, grouped by its own `segment` field - never
  // re-derived or re-sorted client-side, and every one of the six named
  // buckets is pre-seeded with an empty array so a segment with nobody in it
  // still renders "0" (COMM-311's own Empty state) rather than being an
  // omitted card. An unrecognised segment string (a future tuning pass that
  // added a seventh bucket without a client update) still gets its own
  // group rather than being silently dropped, so a count can never go
  // missing from the total.
  function groupMemberSegments(rows) {
    const groups = {};
    for (const key of MEMBER_SEGMENT_ORDER) groups[key] = [];
    for (const row of rows || []) {
      const seg = row && row.segment;
      if (!groups[seg]) groups[seg] = [];
      groups[seg].push(row);
    }
    return groups;
  }
  // A member with visible_to_club = false comes back with user_id,
  // display_name AND handle all null TOGETHER (the migration's own "the
  // three identifying fields are nulled together, never separately" rule) -
  // and handle is `not null unique` on profiles, so a real, visible member
  // row can never carry a null handle. user_id == null is therefore an exact
  // test for "this row was redacted for privacy", not a heuristic.
  function memberSegmentIsRedacted(row) { return !row || row.user_id == null; }
  function memberSegmentName(row) {
    if (memberSegmentIsRedacted(row)) return "חבר/ה (פרופיל מוסתר)";
    return row.display_name || (row.handle ? "@" + row.handle : "חבר/ה");
  }
  function renderMemberSegmentCard(segmentKey, rows, total, isExpanded) {
    const count = rows.length;
    const share = total > 0 ? adminAnalyticsRatioText(count / total, true) : "—";
    const label = MEMBER_SEGMENT_LABELS[segmentKey] || segmentKey;
    const desc = MEMBER_SEGMENT_DESCRIPTIONS[segmentKey] || "";
    const listHtml = !isExpanded ? "" : (count
      ? `<div class="log-list">${rows.map((r) => `<div class="log-row"><span>${esc(memberSegmentName(r))}</span></div>`).join("")}</div>`
      : `<div class="empty" style="padding:4px 0;">אין חברים בפילוח זה</div>`);
    return `<div class="chart-card" style="margin-bottom:10px;" data-member-segment-card="${esc(segmentKey)}">
      <button type="button" class="log-row" style="width:100%;background:none;border:none;cursor:pointer;text-align:inherit;padding:0;" data-community-action="member-segments-toggle" data-segment="${esc(segmentKey)}" aria-expanded="${isExpanded ? "true" : "false"}">
        <span>${esc(label)}</span>
        <span class="mono" style="color:var(--brass);">${count} · ${share}</span>
      </button>
      <div class="footer-note" style="margin:2px 0 0;">${esc(desc)}</div>
      ${listHtml}
    </div>`;
  }
  // Frontend states, COMM-311's own list: loading is a skeleton
  // (data-member-segments-skeleton, six blank rows for the six buckets);
  // error is the ticket's own copy unless the server named one of the two
  // real refusals; empty (a segment with nobody in it) is not a separate
  // branch - every one of the six cards always renders, honest "0" and all,
  // because groupMemberSegments() pre-seeds every bucket.
  function renderMemberSegments() {
    if (!(hasPerm(PERM.ANALYTICS_VIEW) || isAdmin())) return "";
    const ms = state.analytics.segments;
    let body;
    if (ms.loading && !ms.data) {
      const skRow = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:45%;background:var(--border);border-radius:6px;display:inline-block;"></span><span style="height:12px;width:20%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
      const skCard = `<div class="chart-card" style="margin-bottom:10px;">${skRow}</div>`;
      body = `<div aria-busy="true" data-member-segments-skeleton="1">${skCard.repeat(6)}</div>`;
    } else if (ms.error) {
      body = `<div class="empty">${esc(ms.errorText || "לא ניתן היה לטעון את הפילוח.")}<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="member-segments-retry">ניסיון חוזר</button></div></div>`;
    } else if (!ms.data) {
      body = `<div class="empty">אין עדיין נתונים לתצוגה.</div>`;
    } else {
      const groups = groupMemberSegments(ms.data);
      const total = ms.data.length;
      body = `<div class="footer-note" style="margin:0 0 8px;">סה״כ חברי מועדון: ${total}${ms.asOf ? ` · נכון לתאריך ${esc(ms.asOf)}` : ""}</div>`
        + MEMBER_SEGMENT_ORDER.map((key) => renderMemberSegmentCard(key, groups[key] || [], total, !!ms.expanded[key])).join("");
    }
    return `<div style="margin-top:14px;" data-member-segments-section="1"><div class="field-label" style="margin:4px 0 8px;">פילוח מעורבות חברים</div>${body}</div>`;
  }
  // ---- COMM-379. Registration funnel analytics ---------------------------
  // Same "appended inside the shell's own populated branch" shape as
  // renderMemberSegments() just above - reuses COMM-310's own period
  // selector and load cycle, carries its own independent loading/error/
  // populated switch on state.analytics.registrationFunnel.
  function renderRegistrationFunnel() {
    const rf = state.analytics.registrationFunnel;
    let body;
    if (rf.loading && !rf.data) {
      const skRow = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:55%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
      const skCard = `<div class="chart-card" style="margin-bottom:10px;">${skRow}</div>`;
      body = `<div aria-busy="true" data-registration-funnel-skeleton="1">${skCard.repeat(3)}</div>`;
    } else if (rf.error) {
      body = `<div class="empty">${esc(rf.errorText || "לא ניתן היה לטעון את נתוני ההרשמה.")}<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="registration-funnel-retry">ניסיון חוזר</button></div></div>`;
    } else if (!rf.data) {
      body = `<div class="empty">אין עדיין נתונים לתצוגה.</div>`;
    } else {
      const d = rf.data;
      const sc = d.shared_codes || {};
      const pp = d.per_person_invites || {};
      const f = d.funnel || {};
      // An ORDERED set of steps, each with its own count and, from the
      // second step on, a real percentage of the PREVIOUS step - not four
      // independent counters (COMM-379's own acceptance criterion). The
      // three rate fields are already computed step-over-previous-step
      // server-side (202609030006: redeemed_rate = redeemed/invites_issued,
      // profile_completed_rate = profile_completed/redeemed, verified_rate =
      // verified/profile_completed), so this only has to render them in
      // order, never re-derive them.
      // `hasRate: false` marks the FIRST step, which structurally has no
      // previous step to compare against - true `null` from a step's own
      // rate field (a zero denominator, e.g. no redemptions this period)
      // still renders through adminAnalyticsRatioText, which is what turns
      // it into an em dash rather than omitting the rate entirely - the
      // two are different claims and must not look the same as "no rate at
      // all" the way the first step's own blank rightly does.
      const steps = [
        { label: "הזמנות אישיות שהופצו", value: f.invites_issued, hasRate: false, rate: null },
        { label: "מומשו", value: f.redeemed, hasRate: true, rate: f.redeemed_rate },
        { label: "השלימו פרופיל", value: f.profile_completed, hasRate: true, rate: f.profile_completed_rate },
        { label: "אומתו", value: f.verified, hasRate: true, rate: f.verified_rate },
      ];
      const funnelHtml = `<div class="log-list">${steps.map((s) =>
        adminAnalyticsRow(s.label, adminAnalyticsCount(s.value) + (s.hasRate ? " · " + adminAnalyticsRatioText(s.rate, true) : ""))).join("")}</div>`;
      const sharedHtml = adminAnalyticsCard("קודי הצטרפות משותפים (כרגע)",
        adminAnalyticsRow("קודים פעילים", adminAnalyticsCount(sc.active_count))
        + adminAnalyticsRow("מימושים בתקופה", adminAnalyticsCount(sc.redemptions_in_period)));
      const personHtml = adminAnalyticsCard("הזמנות אישיות",
        adminAnalyticsRow("נוצרו בתקופה", adminAnalyticsCount(pp.created_in_period))
        + adminAnalyticsRow("מומשו בתקופה", adminAnalyticsCount(pp.redeemed_in_period))
        + adminAnalyticsRow("בוטלו בתקופה", adminAnalyticsCount(pp.revoked_in_period))
        + adminAnalyticsRow("ממתינות כרגע", adminAnalyticsCount(pp.pending_now))
        + adminAnalyticsRow("פגות תוקף ולא מומשו, כרגע", adminAnalyticsCount(pp.expired_unredeemed_now)));
      body = `<div class="footer-note" style="margin-bottom:8px;">״הזמנות שהופצו״ סופר רק הזמנות אישיות - מי שהצטרפ/ה דרך קוד משותף לא נספר/ת כאן, ולכן סה״כ המומשים יכול לעלות על מספר ההזמנות שהופצו.</div>`
        + adminAnalyticsCard("משפך הרשמה", funnelHtml)
        + sharedHtml + personHtml;
    }
    return `<div style="margin-top:14px;" data-registration-funnel-section="1"><div class="field-label" style="margin:4px 0 8px;">משפך הרשמה</div>${body}</div>`;
  }
  // ---- The shell itself ---------------------------------------------------
  // Frontend states (COMM-310's own "Frontend states" list): loading is a
  // skeleton (data-admin-analytics-skeleton, the same aria-busy skeleton
  // shape every other lazy admin panel in this cluster uses); error is the
  // ticket's own copy unless the server named one of the four real refusals,
  // in which case that refusal's own short Hebrew shows instead; empty (a
  // genuinely quiet period) is not a separate branch at all - it is the
  // populated branch, rendering honest zeros and em-dashes, because
  // analytics_dashboard() always returns the same 18 keys whether the
  // period was busy or quiet.
  function renderAdminAnalyticsDashboard() {
    if (!(hasPerm(PERM.ANALYTICS_VIEW) || isAdmin())) return "";
    const a = state.analytics.dashboard;
    let body;
    if (a.loading && !a.data) {
      const skRow = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:55%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
      const skCard = `<div class="chart-card" style="margin-bottom:10px;"><div class="log-list">${skRow.repeat(3)}</div></div>`;
      body = `<div aria-busy="true" data-admin-analytics-skeleton="1">${skCard.repeat(3)}</div>`;
    } else if (a.error) {
      body = `<div class="empty">${esc(a.errorText || "לא ניתן היה לטעון את הנתונים.")}<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="admin-analytics-retry">ניסיון חוזר</button></div></div>`;
    } else if (!a.data) {
      body = `<div class="empty">אין עדיין נתונים לתצוגה.</div>`;
    } else {
      // COMM-311 appends here, inside this same populated branch, per
      // COMM-310's own commit message: "a later ticket's own section is
      // meant to be a new render function appended inside the same
      // populated branch ... not a second nav destination or a second date
      // picker." renderMemberSegments() carries its own independent
      // loading/error/populated switch on state.analytics.segments, so it is
      // not itself gated on a.data beyond appearing here.
      body = renderAdminAnalyticsCoreGroup(a.data) + renderAdminAnalyticsAdditionalGroup(a.data) + renderMemberSegments() + renderRegistrationFunnel();
    }
    return `<div class="ach-section" style="margin-top:18px;" data-admin-analytics-dashboard="1">${sectionHead("var(--energy)", "לוח בקרה: אנליטיקת קהילה", true)}${renderAdminAnalyticsPeriodSelector()}${body}</div>`;
  }
  // ---- Retention correlation views (COMM-313) --------------------------
  //
  // WHY A SEPARATE TOP-LEVEL SECTION, NOT APPENDED INSIDE
  // renderAdminAnalyticsDashboard() THE WAY COMM-311's renderMemberSegments()
  // WAS.
  //
  // COMM-310's own shell is gated on `hasPerm(PERM.ANALYTICS_VIEW) ||
  // isAdmin()`, and every section appended inside it so far (COMM-311's
  // segments) shares exactly that gate - there was never a reason to check
  // again. COMM-313 is the first ticket in this cluster whose own gate is a
  // STRICT SUBSET of the shell's: real is_admin() alone, no
  // community.analytics.view alternative (the migration's own "THE GATE IS
  // is_admin() ALONE" header, and the ticket's own acceptance criterion,
  // "matching COMM-312's narrower bar"). A community.analytics.view holder
  // who is not an admin is meant to see the dashboard and the segments and
  // NOT this - the one negative case COMM-313 calls out as genuinely
  // different from COMM-310/311.
  //
  // Nesting this section inside renderAdminAnalyticsDashboard()'s own
  // populated branch and re-gating just this call would still be CORRECT
  // (the inner isAdmin()-only check below would still hide it from that
  // permission holder), but it would bury a narrower permission boundary
  // inside a container whose own header and period selector belong to a
  // broader one - a reviewer skimming renderAdminAnalyticsDashboard() would
  // reasonably assume everything inside it shares its gate, and the next
  // person to add a section there could copy that assumption straight into
  // a real bug. Keeping it as its own ach-section, with its own isAdmin()
  // check at the very top (the same standalone `if (!isAdmin()) return "";`
  // shape renderMemberManagement() already uses, not the OR-with-permission
  // shape), makes the boundary visible at the call site instead of implicit
  // inside a shared container. It still lives in the same admin-moderation
  // cluster, right next to the dashboard in the account tab, and it reuses
  // every rendering building block (adminAnalyticsCard/Row/RatioText,
  // sectionHead, the aria-busy skeleton shape) COMM-310 already built - nothing
  // here is a new visual language, only a new permission boundary.
  //
  // RENDERING APPROACH: reuses COMM-310's own "weeks" pattern
  // (renderAdminAnalyticsWcam/Posting: a log-list of one row per week,
  // adminAnalyticsRow(label, value)) rather than inventing a chart. Each
  // series (a cohort month, or one side of a correlation cut) is its own
  // adminAnalyticsCard with a log-list of "שבוע N: share% (מתוך n חברים)"
  // rows - a "standard retention curve" read top-to-bottom instead of drawn,
  // which is what COMM-310's own precedent already does for a single series
  // and this section does once per series. Correctness over visual polish,
  // per the ticket's own instruction for an internal admin tool.
  const RETENTION_ONBOARDING_STEPS = [
    { id: "welcomed_at", label: "ברכת פתיחה" },
    { id: "first_week_shown_at", label: "סיכום שבוע ראשון" },
    { id: "first_month_shown_at", label: "סיכום חודש ראשון" },
    { id: "first_class_shown_at", label: "שיעור ראשון" },
    { id: "third_class_shown_at", label: "שיעור שלישי" },
  ];
  // The correlation-not-causation caveat, stated once and shown PERSISTENTLY
  // next to the two overlay toggles (not in a tooltip) - the ticket's own
  // wording. Carries no "effect"/"impact"/"lift"/"uplift" word, the same
  // restraint 202609010008's own field naming keeps (see that migration's
  // "CORRELATION, NOT CAUSATION" header): a stamped onboarding step or a
  // coach Welcome both partly just measure whether the member came back or
  // was around to be reached at all, so the gap between the two curves is a
  // ceiling on anything causal, never proof of one.
  const RETENTION_CORRELATION_NOTE = "זהו מתאם, לא סיבתיות. שלב הכוונה מסומן רק כשהחבר/ה פותח/ת את האפליקציה ורואה אותו, ופנייה של מאמן/ת נוטה להגיע דווקא למי שממילא נמצא/ת בסביבה - כך שחלק ניכר מהפער בין שתי העקומות פשוט משקף מי חזר/ה להיות פעיל/ה בכלל, לא רק את הצעד עצמו. הפער בין העקומות הוא לכל היותר תקרה עליונה למשהו סיבתי, לא הוכחה לו.";
  // One row per week, sorted, for a single series (a cohort month, or one
  // side of a correlation cut). A suppressed tail (this section's rows never
  // gap - see 202609010008's own "TRUNCATES A LINE, NEVER PUNCHES A HOLE"
  // note) simply means the log-list stops short; nothing here bridges it or
  // draws a placeholder for a week that was never emitted.
  function retentionWeekRows(rows) {
    const sorted = (rows || []).slice().sort((x, y) => Number(x.week_number) - Number(y.week_number));
    if (!sorted.length) return `<div class="empty" style="padding:4px 0;">אין מספיק חברים לתצוגה יציבה</div>`;
    return `<div class="log-list">${sorted.map((r) => adminAnalyticsRow(`שבוע ${esc(r.week_number)}`, `${adminAnalyticsRatioText(r.retained_share, true)} (מתוך ${adminAnalyticsCount(r.member_count)})`)).join("")}</div>`;
  }
  // cohort_month is 'YYYY-MM' or the literal 'other' (202609010008's own
  // rule - a real month key can never collide with that string); 'other'
  // sorts last, named months sort chronologically, exactly the order the
  // RPC itself already returns them in - this re-sort is defensive, not a
  // correction of the server's own ordering.
  function retentionCohortSortKey(a, b) {
    if (a === "other" && b !== "other") return 1;
    if (b === "other" && a !== "other") return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  function renderRetentionCohortCurves(cohortRows) {
    const byMonth = new Map();
    for (const row of cohortRows || []) {
      const key = row && row.cohort_month;
      if (key == null) continue;
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key).push(row);
    }
    const months = Array.from(byMonth.keys()).sort(retentionCohortSortKey);
    if (!months.length) return `<div class="empty">אין עדיין נתוני שימור לתצוגה.</div>`;
    return months.map((m) => adminAnalyticsCard(
      `קבוצת הצטרפות: ${m === "other" ? "קבוצות קטנות (מאוחדות)" : esc(m)}`,
      retentionWeekRows(byMonth.get(m)),
    )).join("");
  }
  function renderRetentionOverlayToggles() {
    const r = state.analytics.retention;
    return `<div class="chip-row" style="margin:10px 0;" data-retention-overlay-toggles="1">
      <button class="chip-btn${r.showOnboarding ? " selected" : ""}" data-community-action="retention-toggle-onboarding" aria-pressed="${r.showOnboarding ? "true" : "false"}">שכבת-על: שלבי הכוונה</button>
      <button class="chip-btn${r.showWelcome ? " selected" : ""}" data-community-action="retention-toggle-welcome" aria-pressed="${r.showWelcome ? "true" : "false"}">שכבת-על: פניית מאמן/ת ראשונית</button>
    </div>`;
  }
  // stamped=true is rendered first (matching the RPC's own `order by ...
  // stamped desc`), stamped=false second - "did the member ever see this
  // step" vs. "never did", for whichever step the chip row currently
  // selects. A step nobody has ever been stamped with (both COMM-316 columns
  // right after deploy, since 202609010003 does not backfill them) returns
  // only the false side from the server; the true side then falls through to
  // retentionWeekRows()'s own empty state rather than a missing card, so a
  // reviewer sees "not enough members yet" instead of a card that silently
  // vanished.
  function renderRetentionOnboardingOverlay() {
    const r = state.analytics.retention;
    if (!r.showOnboarding) return "";
    const stepChips = RETENTION_ONBOARDING_STEPS.map((s) => `<button class="chip-btn${r.onboardingStep === s.id ? " selected" : ""}" data-community-action="retention-onboarding-step" data-step="${s.id}">${esc(s.label)}</button>`).join("");
    const stepRows = (r.onboarding || []).filter((row) => row && row.step === r.onboardingStep);
    const stamped = stepRows.filter((row) => row.stamped === true);
    const notStamped = stepRows.filter((row) => row.stamped === false);
    return `<div style="margin-top:6px;" data-retention-onboarding-overlay="1">
      <div class="chip-row" style="margin:0 0 8px;">${stepChips}</div>
      ${adminAnalyticsCard("השלב סומן (stamped)", retentionWeekRows(stamped))}
      ${adminAnalyticsCard("השלב לא סומן", retentionWeekRows(notStamped))}
    </div>`;
  }
  // contacted=true first (matching the RPC's own `order by contacted desc`),
  // false second. No step selector here - retention_welcome_correlation()
  // has only the one cut.
  function renderRetentionWelcomeOverlay() {
    const r = state.analytics.retention;
    if (!r.showWelcome) return "";
    const contacted = (r.welcome || []).filter((row) => row && row.contacted === true);
    const notContacted = (r.welcome || []).filter((row) => row && row.contacted === false);
    return `<div style="margin-top:6px;" data-retention-welcome-overlay="1">
      ${adminAnalyticsCard("פנייה מאמן/ת ב-14 הימים הראשונים", retentionWeekRows(contacted))}
      ${adminAnalyticsCard("ללא פנייה כזו", retentionWeekRows(notContacted))}
    </div>`;
  }
  // Frontend states, COMM-313's own list: loading is a skeleton
  // (data-retention-skeleton); error is the ticket's own copy unless the
  // server named the one real refusal ('not authorized'), in which case that
  // refusal's own short Hebrew shows instead; a cohort folded into 'other'
  // for being under the 5-member floor is not a separate branch - it is just
  // one more card in the populated branch, labelled as pooled rather than
  // omitted (renderRetentionCohortCurves' own 'other' handling); populated is
  // the cohort curves plus the two toggle-able overlays, with the
  // correlation-not-causation note shown persistently above the toggles
  // (not hidden inside either overlay, since it applies to both, and not a
  // tooltip).
  function renderRetentionCorrelations() {
    if (!isAdmin()) return "";
    const r = state.analytics.retention;
    let body;
    if (r.loading && !r.loaded) {
      const skRow = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:55%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
      const skCard = `<div class="chart-card" style="margin-bottom:10px;"><div class="log-list">${skRow.repeat(3)}</div></div>`;
      body = `<div aria-busy="true" data-retention-skeleton="1">${skCard.repeat(3)}</div>`;
    } else if (r.error) {
      body = `<div class="empty">${esc(r.errorText || "לא ניתן היה לטעון את נתוני השימור.")}<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="retention-retry">ניסיון חוזר</button></div></div>`;
    } else if (!r.loaded) {
      body = `<div class="empty">אין עדיין נתונים לתצוגה.</div>`;
    } else {
      body = renderRetentionCohortCurves(r.cohorts)
        + `<div class="footer-note" data-retention-correlation-note="1" style="margin:12px 0 0;">${esc(RETENTION_CORRELATION_NOTE)}</div>`
        + renderRetentionOverlayToggles()
        + renderRetentionOnboardingOverlay()
        + renderRetentionWelcomeOverlay();
    }
    return `<div class="ach-section" style="margin-top:18px;" data-retention-correlations="1">${sectionHead("var(--purple)", "מתאמי שימור (מנהלים בלבד)", true)}${body}</div>`;
  }
  // ---- Community health score rendering (COMM-312) -----------------------
  // Deliberately simpler than COMM-313's cohort curves, per the ticket's own
  // "just one score per week, one line": one score card for the latest
  // computed week, its four-component breakdown, and a trend line that is a
  // plain week-by-week list of scores (this codebase draws every other trend
  // - see renderAdminAnalyticsWcam's own weeks list - the same way; there is
  // no charting library here to reach for).
  //
  // Key order matches components' own jsonb_build_object key order in
  // 202609010009 (wcam_share, engagement_per_post, moderation_load,
  // retention) rather than the weights' narrative order in that migration's
  // comments, or AC1's prose order - the stored row is the one definition.
  const COMMUNITY_HEALTH_COMPONENT_ORDER = ["wcam_share", "engagement_per_post", "moderation_load", "retention"];
  const COMMUNITY_HEALTH_COMPONENT_LABELS = {
    wcam_share: "נוכחות שבועית (WCAM)",
    engagement_per_post: "מעורבות לפוסט",
    moderation_load: "עומס דיווחים (הפוך)",
    retention: "שימור",
  };
  // `value` is in the component's own units (a share, a per-post ratio, a
  // per-100-members rate) - never the 0..1 sub_score, which is an internal
  // mapping this card does not surface. null/undefined (component
  // unavailable - community_health_component()'s own null rule) renders as
  // an em dash, the same convention adminAnalyticsRatioText() uses.
  function communityHealthComponentValueText(key, comp) {
    const v = comp && comp.value;
    if (v === null || v === undefined) return "—";
    const n = Number(v);
    if (!isFinite(n)) return "—";
    if (key === "wcam_share" || key === "retention") return (Math.round(n * 1000) / 10) + "%";
    if (key === "moderation_load") return (Math.round(n * 10) / 10) + " דיווחים ל-100 חברים";
    return (Math.round(n * 100) / 100) + " לפוסט";
  }
  // THE CAVEAT. community_health_component()'s own comment: weight_applied
  // is 0 "when the component had no data" and the migration's own composite
  // block says a partial-component score "does not announce that on its
  // face" unless a reader is told. So a weight_applied of 0 (or a null
  // sub_score - the same condition, restated defensively) renders a visible
  // "not included this week" line INSTEAD OF a 0% weight, rather than next
  // to it - 0% read on its own looks like a rounding artefact, not an
  // exclusion.
  function communityHealthComponentDropped(comp) {
    if (!comp) return true;
    if (comp.sub_score === null || comp.sub_score === undefined) return true;
    const wa = Number(comp.weight_applied);
    return !isFinite(wa) || wa === 0;
  }
  function renderCommunityHealthComponents(components) {
    if (!components || typeof components !== "object") return "";
    const rows = COMMUNITY_HEALTH_COMPONENT_ORDER.map((key) => {
      const comp = components[key];
      if (!comp) return "";
      const dropped = communityHealthComponentDropped(comp);
      const valueText = communityHealthComponentValueText(key, comp);
      const weightHtml = dropped
        ? `<span data-community-health-dropped="1" style="color:var(--red);">לא נכלל בציון השבוע</span>`
        : `<span style="color:var(--steel);">במשקל ${Math.round(Number(comp.weight_applied) * 1000) / 10}%</span>`;
      return `<div class="log-row" data-community-health-component="${key}">
        <span>${esc(COMMUNITY_HEALTH_COMPONENT_LABELS[key] || key)}</span>
        <span class="mono" style="color:var(--brass);text-align:left;">${esc(valueText)}<br/>${weightHtml}</span>
      </div>`;
    }).join("");
    return `<div class="log-list" data-community-health-components="1">${rows}</div>`;
  }
  function communityHealthScoreText(row) {
    const s = row && row.score;
    if (s === null || s === undefined) return "—";
    const n = Number(s);
    return isFinite(n) ? String(Math.round(n * 10) / 10) : "—";
  }
  function renderCommunityHealthScoreCard(row) {
    if (!row) return "";
    return `<div class="chart-card" style="margin-bottom:10px;" data-community-health-score-card="1">
      <div style="font-size:12px;color:var(--steel);margin-bottom:4px;">שבוע ${esc(row.week_start || "")}</div>
      <div style="font-size:34px;font-weight:800;color:var(--brass);" data-community-health-score-value="1">${esc(communityHealthScoreText(row))}</div>
      <div style="font-size:12px;color:var(--steel);margin-bottom:8px;">מתוך 100</div>
      ${renderCommunityHealthComponents(row.components)}
    </div>`;
  }
  // ONE ROW: no trend line at all, per the ticket's own empty-state wording
  // ("fewer than 2 computed weeks shows the latest score with no trend line
  // rather than a broken chart") - the caller does not even call this
  // helper below that count. TWO OR MORE: every stored week, oldest first
  // (community_health_history()'s own return order - no re-sort here),
  // rendered as a plain log-list the same shape renderAdminAnalyticsWcam()
  // already uses for a weekly series.
  function renderCommunityHealthTrend(weeks) {
    const rows = (weeks || []).map((w) => adminAnalyticsRow(w.week_start || "", communityHealthScoreText(w))).join("");
    return adminAnalyticsCard("מגמת ציון הקהילה", `<div class="log-list" data-community-health-trend="1">${rows}</div>`);
  }
  // Frontend states, COMM-312's own list: loading is a skeleton
  // (data-community-health-skeleton); error is the ticket's own exact copy
  // ("לא ניתן היה לטעון את הציון.") unless the server named the one real
  // refusal ('not authorized'); 0 computed weeks is a true empty state
  // (data-community-health-empty, "no scheduler wired yet" is the expected
  // common case until one exists, same as several other Phase 3 schema
  // halves); 1 week shows the score card with no trend line; 2+ weeks shows
  // the score card plus the trend line.
  function renderCommunityHealthScore() {
    if (!isAdmin()) return "";
    const h = state.analytics.health;
    let body;
    if (h.loading && !h.loaded) {
      const skRow = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:55%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
      body = `<div class="chart-card" style="margin-bottom:10px;" aria-busy="true" data-community-health-skeleton="1">
        <div style="height:34px;width:90px;background:var(--border);border-radius:8px;margin-bottom:10px;"></div>
        <div class="log-list">${skRow.repeat(4)}</div>
      </div>`;
    } else if (h.error) {
      body = `<div class="empty">${esc(h.errorText || "לא ניתן היה לטעון את הציון.")}<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="community-health-retry">ניסיון חוזר</button></div></div>`;
    } else if (!h.loaded) {
      body = `<div class="empty">אין עדיין נתונים לתצוגה.</div>`;
    } else if (!h.weeks.length) {
      body = `<div class="empty" data-community-health-empty="1">טרם חושב ציון קהילה עבור המועדון.</div>`;
    } else {
      const latest = h.weeks[h.weeks.length - 1];
      body = renderCommunityHealthScoreCard(latest) + (h.weeks.length >= 2 ? renderCommunityHealthTrend(h.weeks) : "");
    }
    return `<div class="ach-section" style="margin-top:18px;" data-community-health-score="1">${sectionHead("var(--brass)", "ציון בריאות הקהילה (מנהלים בלבד)", true)}${body}</div>`;
  }
  // COMM-155. The pinned strip at the very top of the Club home, above the
  // club top card. Up to three chips; staff with community.content.pin get
  // an unpin control on each.
  function pinTargetLabel(t) { return { announcement: "הודעה", challenge: "אתגר", event: "אירוע", post: "פוסט" }[t] || t; }
  function renderPinnedStrip() {
    const canPin = hasPerm(PERM.CONTENT_PIN);
    if (!state.admin.pins.length && !state.admin.pinError) return "";
    const chips = state.admin.pins.slice(0, 3).map((p) => `<div class="chip-btn" style="cursor:default;gap:6px;align-items:center;">
      📌 <span>${esc(p.note || pinTargetLabel(p.target_type))}</span>
      ${canPin ? `<button class="link-btn" data-community-action="unpin" data-type="${esc(p.target_type)}" data-id="${esc(p.target_id)}" aria-label="ביטול הצמדה" style="margin:0;padding:0 4px;">✕</button>` : ""}
    </div>`).join("");
    return `<div class="chart-card" id="communityPinnedStrip" style="margin-bottom:12px;">
      <div style="font-weight:800;font-size:13px;margin-bottom:8px;">מוצמד</div>
      <div class="chip-row" style="margin:0;">${chips}</div>
      ${state.admin.pinError ? `<div class="footer-note" role="alert" style="color:var(--red);margin-top:6px;">${esc(state.admin.pinError)}</div>` : ""}
    </div>`;
  }

  // ==========================================================================
  // COMM-101..108, COMM-180  posts cluster.
  // Structured post_type cards, the composer, the per-post action menu, the PR
  // share prompt, and the member profile community section. Everything here is
  // card RENDER and post COMPOSE only. Feed ranking and pagination (COMM-110),
  // reaction and comment internals (COMM-120..125), the achievement engine
  // (COMM-130..134) and notifications are owned elsewhere and only consumed.
  // The card markup contract for feed and engagement is in
  // docs/community/contracts.md, "Client card contract (renderPostCard)".
  // ==========================================================================

  // The five visibility labels the schema keeps (contracts.md "Phase 0 schema
  // notes"). club / friends / only_me is the model going forward; public and
  // followers are legacy read aliases the current client still writes.
  // Post-Phase-3 Hebrew copy fix: "עוקבים" (followed), matching
  // visibilityLabel()'s own "followers" -> עוקבים mapping two lines below -
  // "חברים" was the same homonym collision LEADERBOARD_SCOPES had (this app
  // uses חברים everywhere else to mean club membership, not "who follows
  // me").
  const POST_VISIBILITY_OPTIONS = [
    { value: "club", label: "כל המועדון" },
    { value: "friends", label: "עוקבים" },
    { value: "only_me", label: "רק אני" },
  ];
  function normalizeVisibility(v) { return v === "public" ? "club" : v === "followers" ? "friends" : (v || "club"); }
  function visibilityLabel(v) {
    if (v === "followers") return "עוקבים";
    const opt = POST_VISIBILITY_OPTIONS.find((o) => o.value === normalizeVisibility(v));
    return opt ? opt.label : "כל המועדון";
  }
  const POST_BODY_MAX = 1000;
  const POST_MEDIA_MAX = 4;
  const ALT_TEXT_MAX = 200;
  // COMM-102 "control characters stripped, leading and trailing whitespace
  // trimmed". The server re-trims to POST_BODY_MAX, this is only the client
  // guard and the counter source.
  function cleanPostBody(raw) {
    return String(raw == null ? "" : raw)
      .replace(/\r\n?/g, "\n")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
      .trim()
      .slice(0, POST_BODY_MAX);
  }

  function postIsOwn(post) {
    return !!(post && post.author_id && state.user && post.author_id === state.user.id);
  }
  function postAuthorName(post) {
    const a = post && post.author;
    if (a && (a.display_name || a.handle)) return a.display_name || ("@" + a.handle);
    if (post && (post.display_name || post.handle)) return post.display_name || ("@" + post.handle);
    return "";
  }
  function postTimestamp(post) {
    return (post && (post.created_at || post.published_at || post.occurred_on)) || null;
  }
  function findFeedPost(id) { return Array.isArray(state.feed.items) ? state.feed.items.find((p) => p && p.id === id) : null; }
  // Authorless posts render the club mark, never a broken avatar (COMM-107).
  const CLUB_MARK_HTML = `<span aria-hidden="true" class="avatar-badge" style="width:36px;height:36px;font-size:15px;background:var(--brass);">ח</span>`;

  function postHeadHtml(post, opts) {
    opts = opts || {};
    const authorless = !!opts.authorless;
    const name = authorless ? (opts.clubName || "המועדון") : (postAuthorName(post) || "חבר/ה");
    const avatar = authorless ? CLUB_MARK_HTML : avatarHtml(name, 36, post && post.author ? post.author.avatar_url : (post && post.avatar_url));
    const authorId = !authorless && post && post.author_id;
    // COMM-160. Same coach badge the comments carry, on the post author.
    const roleBadge = authorId ? coachBadgeHtml(memberRole(authorId)) : "";
    const nameInner = `${esc(name)}${roleBadge ? " " + roleBadge : ""}`;
    const nameHtml = authorId
      ? `<button class="post-author link-btn" data-community-action="view-profile" data-id="${esc(authorId)}" style="padding:0;font:inherit;color:inherit;font-weight:800;">${nameInner}</button>`
      : `<div class="post-author">${nameInner}</div>`;
    return `<div class="post-head">${avatar}<div class="post-head-text">${nameHtml}<div class="post-time">${esc(relativeTime(postTimestamp(post)))}${opts.badge ? ` · ${esc(opts.badge)}` : ""}</div></div>${opts.hideMenu ? "" : postMenuHtml(post)}</div>`;
  }

  function postMenuHtml(post) {
    if (!post || !post.id) return "";
    const id = esc(post.id);
    const own = postIsOwn(post);
    const open = state.posts.openMenu === post.id;
    const mi = (action, label, dataId, danger) =>
      `<button class="post-menu-item${danger ? " danger" : ""}" role="menuitem" data-community-action="${action}" data-id="${esc(dataId)}">${esc(label)}</button>`;
    let items = "";
    if (own) {
      items += mi("post-edit-caption", "עריכת כיתוב", post.id);
      items += mi("post-change-visibility", "שינוי נראוּת", post.id);
      items += mi("post-delete", "מחיקה", post.id, true);
    } else {
      const saved = !!(state.posts.savedIds && state.posts.savedIds[post.id]);
      items += mi("post-save", saved ? "הסרה מהשמורים" : "שמירה", post.id);
      items += mi("post-hide", "הסתרת הפוסט", post.id);
      items += mi("report", "דיווח", post.id);
      if (post.author_id) items += mi("block", "חסימת החבר/ה", post.author_id, true);
    }
    return `<div class="post-menu-wrap">
      <button class="chip-btn" data-community-action="toggle-post-menu" data-id="${id}" aria-haspopup="true" aria-expanded="${open ? "true" : "false"}" aria-label="עוד פעולות">⋯</button>
      ${open ? `<div class="post-menu" role="menu">${items}</div>` : ""}
    </div>`;
  }

  function postActionsHtml(post, opts) {
    opts = opts || {};
    const id = esc(post && post.id);
    const reactions = Number((post && (post.reaction_count != null ? post.reaction_count : post.cheer_count)) || 0);
    const comments = Number((post && post.comment_count) || 0);
    return `<div class="chip-row post-actions">
      <button class="chip-btn" data-community-action="cheer" data-id="${id}" aria-label="עידוד, ${reactions} עידודים">🔥 ${reactions}</button>
      <button class="chip-btn" data-community-action="toggle-comments" data-id="${id}" aria-label="תגובות, ${comments}">💬 ${comments}</button>
      ${opts.extra || ""}
    </div>`;
  }

  function postBodyHtml(post) {
    const body = post && post.body;
    if (!body) return "";
    return `<div class="post-body" style="white-space:pre-wrap;line-height:1.6;">${esc(String(body).slice(0, POST_BODY_MAX))}</div>`;
  }
  function postMediaHtml(post) {
    const media = (post && post.media) || [];
    if (!media.length) return "";
    const items = media.slice(0, POST_MEDIA_MAX).map((m) => {
      let url = m.url || "";
      if (!url && m.storage_path) {
        if (photoUrlCache[m.storage_path]) url = photoUrlCache[m.storage_path];
        else resolvePhotoUrl(m.storage_path);
      }
      const alt = m.decorative ? "" : esc(m.alt_text || "");
      if (!url) return `<div class="post-photo" aria-hidden="true" style="background:var(--border);min-height:120px;"></div>`;
      return `<img src="${esc(url)}" alt="${alt}" class="post-photo"/>`;
    }).join("");
    return media.length > 1 ? `<div class="post-media-grid">${items}</div>` : items;
  }

  function captionEditPanel() {
    const e = state.posts.captionEdit;
    return `<div class="post-inline-edit" style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px;">
      <label class="field"><span class="field-label">עריכת כיתוב</span>
        <textarea class="text-input" data-caption-edit maxlength="${POST_BODY_MAX}" rows="3">${esc(e.body || "")}</textarea></label>
      <div class="chip-row"><button class="chip-btn" data-community-action="caption-cancel">ביטול</button><button class="chip-btn primary" data-community-action="caption-save">שמירה</button></div>
    </div>`;
  }
  function visibilityEditPanel() {
    const e = state.posts.visibilityEdit;
    return `<div class="post-inline-edit" style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px;">
      <div class="field-label" style="margin-bottom:6px;">מי רואה את הפוסט</div>
      <div class="chip-row">${POST_VISIBILITY_OPTIONS.map((o) => `<button class="chip-btn${e.visibility === o.value ? " selected" : ""}" data-community-action="visibility-pick" data-value="${o.value}">${o.label}</button>`).join("")}</div>
      <button class="link-btn" data-community-action="visibility-cancel" style="margin-top:6px;display:inline-block;">ביטול</button>
    </div>`;
  }

  function postCardShell(post, inner, opts) {
    opts = opts || {};
    const pid = post && post.id;
    return `<article class="chart-card post-card" data-post-type="${esc((post && post.post_type) || "UNKNOWN")}"${opts.unknown ? ' data-post-unknown="1"' : ""}${pid ? ` data-post-id="${esc(pid)}"` : ""}>
      ${postHeadHtml(post, opts)}
      ${inner || ""}
      ${opts.engagementDisabled ? "" : postActionsHtml(post, opts)}
      ${state.posts.captionEdit && pid && state.posts.captionEdit.postId === pid ? captionEditPanel() : ""}
      ${state.posts.visibilityEdit && pid && state.posts.visibilityEdit.postId === pid ? visibilityEditPanel() : ""}
      ${!opts.engagementDisabled && pid && typeof renderComments === "function" ? renderComments(post) : ""}
    </article>`;
  }

  function renderTextPostCard(post) { return postCardShell(post, postBodyHtml(post) + postMediaHtml(post)); }
  function renderPhotoPostCard(post) { return postCardShell(post, postMediaHtml(post) + postBodyHtml(post)); }

  function renderWorkoutPostCard(post) {
    const m = post.metadata || {};
    const name = m.workout_name || post.title || "אימון";
    const when = m.workout_date || post.occurred_on || "";
    const result = m.result_text || post.result_text || "";
    const scoreType = m.score_type || post.score_type || "";
    const effort = m.effort || (post.rx === true ? "rx" : post.rx === false ? "scaled" : m.level ? "level" : "");
    const effortLabel = effort === "rx" ? "Rx" : effort === "scaled" ? "מותאם" : effort === "level" ? ("רמה " + (m.level || "")) : "";
    const isPr = !!(m.is_pr || post.is_pr);
    const prBadge = isPr ? ` <span class="pr-badge badge-tag">PR</span>` : "";
    const detail = `<div class="post-title">${esc(name)}${prBadge}</div>
      ${when ? `<div style="color:var(--steel);font-size:12px;">${esc(String(when).slice(0, 10))}</div>` : ""}
      ${result ? `<div class="mono post-result">${esc(result)}</div>` : ""}
      ${(scoreType || effortLabel) ? `<div style="color:var(--steel);font-size:12px;">${[scoreType, effortLabel].filter(Boolean).map(esc).join(" · ")}</div>` : ""}`;
    const caption = post.body ? `<div class="post-body" style="white-space:pre-wrap;margin-top:6px;">${esc(String(post.body).slice(0, POST_BODY_MAX))}</div>` : "";
    const src = m.source_id || post.source_id || post.source_record_id;
    const extra = src ? `<button class="chip-btn" data-community-action="open-source" data-source-type="${esc(m.source_type || post.source_type || "workout")}" data-source-id="${esc(src)}">פתיחת האימון</button>` : "";
    return postCardShell(post, detail + caption + postMediaHtml(post), { extra });
  }

  function renderPrPostCard(post) {
    const m = post.metadata || {};
    const movement = m.movement || m.movement_name || post.title || "שיא אישי";
    const rows = [
      ["תוצאה חדשה", m.new_result || m.new_value],
      ["תוצאה קודמת", m.previous_result || m.previous_value],
      ["שיפור", m.improvement],
      ["תאריך", (m.achieved_on || post.occurred_on) ? String(m.achieved_on || post.occurred_on).slice(0, 10) : ""],
    ].filter((r) => r[1] != null && r[1] !== "");
    const inner = `<div class="post-title">${esc(movement)} <span class="pr-badge badge-tag">PR</span></div>
      <div class="log-list" style="margin-top:6px;">${rows.map((r) => `<div class="log-row"><span>${esc(r[0])}</span><span class="mono" style="color:var(--brass);">${esc(r[1])}</span></div>`).join("")}</div>
      ${post.body ? `<div class="post-body" style="white-space:pre-wrap;margin-top:6px;">${esc(String(post.body).slice(0, POST_BODY_MAX))}</div>` : ""}`;
    return postCardShell(post, inner + postMediaHtml(post));
  }

  function renderAchievementPostCard(post) {
    const m = post.metadata || {};
    const title = m.title || post.title || "הישג";
    const icon = m.badge_icon || "🏅";
    const when = m.earned_on || post.occurred_on || "";
    const why = m.explanation || post.result_text || "";
    const inner = `<div class="flex gap-10" style="align-items:center;">
        <span aria-hidden="true" style="font-size:26px;">${esc(icon)}</span>
        <div><div class="post-title" style="margin:0;">${esc(title)}</div>${when ? `<div style="color:var(--steel);font-size:12px;">${esc(String(when).slice(0, 10))}</div>` : ""}</div>
      </div>
      ${why ? `<div style="color:var(--steel);font-size:13px;margin-top:6px;">${esc(why)}</div>` : ""}
      ${post.body ? `<div class="post-body" style="white-space:pre-wrap;margin-top:6px;">${esc(String(post.body).slice(0, POST_BODY_MAX))}</div>` : ""}`;
    return postCardShell(post, inner + postMediaHtml(post));
  }

  // COMM-101: the renderer exists so the dispatch is total, but attendance
  // milestones are parked until an attendance source lands, so the feed never
  // actually produces one yet.
  function renderAttendanceMilestonePostCard(post) {
    const m = post.metadata || {};
    const label = m.milestone_label || post.title || "אבן דרך בנוכחות";
    const inner = `<div class="post-title">🎯 ${esc(label)}</div>${m.count != null ? `<div class="mono post-result">${esc(m.count)}</div>` : ""}${post.body ? `<div class="post-body" style="white-space:pre-wrap;margin-top:6px;">${esc(String(post.body).slice(0, POST_BODY_MAX))}</div>` : ""}`;
    return postCardShell(post, inner);
  }

  // COMM-201/203/207: a real challenge card, not the COMM-101 fallback link
  // card. `renderPostCard` never has to know whether a POST_CHALLENGE row is
  // the authorless cooperative-milestone post `challenge_progress_apply`
  // writes (metadata carries milestone/club_total/target_value, no author)
  // or a member's own Share Progress post (metadata carries the type-shaped
  // snapshot buildChallengeShareMetadata() took at share time) - both read
  // through the same fields, each rendered only when present.
  function renderChallengeLinkCard(post) {
    const m = post.metadata || {};
    const rows = [];
    if (m.milestone != null) {
      rows.push(`<div class="mono post-result" style="color:var(--brass);">${esc(m.milestone)}% מהיעד הושלמו</div>`);
      if (m.club_total != null && m.target_value != null) rows.push(`<div style="color:var(--steel);font-size:12px;">${esc(m.club_total)} מתוך ${esc(m.target_value)}</div>`);
    } else if (m.my_progress != null) {
      const pct = m.target_value ? Math.min(100, Math.round((Number(m.my_progress) / Number(m.target_value)) * 100)) : null;
      rows.push(`<div class="mono post-result" style="color:var(--brass);">${esc(m.my_progress)}${m.target_value != null ? ` / ${esc(m.target_value)}` : ""}</div>`);
      if (pct != null) rows.push(`<div class="progress-track"><div style="width:${pct}%;"></div></div>`);
    }
    const inner = `<div class="post-title">🏆 ${esc(m.challenge_title || post.title || "אתגר")}</div>
      ${rows.join("")}
      ${post.body ? `<div class="post-body" style="white-space:pre-wrap;margin-top:4px;">${esc(String(post.body).slice(0, POST_BODY_MAX))}</div>` : ""}
      <div class="chip-row"><button class="chip-btn" data-community-action="open-challenge" data-id="${esc(m.challenge_id || post.source_id || "")}">פתיחת האתגר</button></div>`;
    return postCardShell(post, inner, { authorless: !postAuthorName(post) });
  }
  // COMM-213: upgraded from the COMM-101 fallback link card to a real event
  // card, once the events cluster's own state.events.byId has the live row
  // (it is loaded in the same Promise.all as the feed, so this is the
  // common case). Falls back to the original metadata-only link card when
  // the event is not in cache yet (a cold feed load racing loadEvents()) or
  // no longer exists - a truthful degrade, never a broken render.
  function renderEventLinkCard(post) {
    const m = post.metadata || {};
    const ev = m.event_id ? state.events.byId[m.event_id] : null;
    if (ev) {
      const going = eventGoingCount(ev.id);
      const meta = [eventTypeBadge(ev.event_type), formatEventDate(ev.start_at), formatEventTime(ev.start_at)];
      if (ev.location) meta.push(ev.location);
      meta.push(`${going} משתתפים`);
      if (ev.status === "cancelled") meta.push("בוטל");
      const image = ev.image_url ? `<img src="${esc(ev.image_url)}" alt="" style="width:100%;max-height:160px;object-fit:cover;border-radius:10px;margin-top:6px;"/>` : "";
      const inner = `<div class="post-title">📅 ${esc(ev.title)}</div>
        <div style="color:var(--steel);font-size:12px;">${meta.map(esc).join(" · ")}</div>
        ${image}
        ${post.body ? `<div class="post-body" style="white-space:pre-wrap;margin-top:6px;">${esc(String(post.body).slice(0, POST_BODY_MAX))}</div>` : ""}
        <div class="chip-row"><button class="chip-btn" data-community-action="open-event" data-id="${esc(ev.id)}">פתיחת האירוע</button></div>`;
      return postCardShell(post, inner, { authorless: !postAuthorName(post) });
    }
    const when = m.starts_at ? String(m.starts_at).slice(0, 16).replace("T", " ") : "";
    const inner = `<div class="post-title">📅 ${esc(m.event_title || post.title || "אירוע")}</div>
      ${when ? `<div style="color:var(--steel);font-size:12px;">${esc(when)}</div>` : ""}
      ${post.body ? `<div class="post-body" style="white-space:pre-wrap;margin-top:4px;">${esc(String(post.body).slice(0, POST_BODY_MAX))}</div>` : ""}
      <div class="chip-row"><button class="chip-btn" data-community-action="open-event" data-id="${esc(m.event_id || post.source_id || "")}">פתיחת האירוע</button></div>`;
    return postCardShell(post, inner, { authorless: !postAuthorName(post) });
  }

  function renderAnnouncementPostCard(post) {
    const m = post.metadata || {};
    const title = m.title || post.title || "";
    const inner = `${title ? `<div class="post-title" style="color:var(--brass);">📣 ${esc(title)}</div>` : ""}${postBodyHtml(post)}${postMediaHtml(post)}`;
    return postCardShell(post, inner, { badge: "הודעת מועדון", authorless: !postAuthorName(post) });
  }
  function renderCoachPostCard(post) {
    return postCardShell(post, postBodyHtml(post) + postMediaHtml(post), { badge: "מאמן/ת" });
  }

  function renderNewMemberPostCard(post) {
    const m = post.metadata || {};
    const memberId = m.member_id || post.author_id || "";
    const memberName = m.member_name || postAuthorName(post) || "חבר/ה חדש/ה";
    const joined = m.joined_on || post.occurred_on || postTimestamp(post);
    const inner = `<div class="post-title">👋 ברוך/ה הבא/ה למועדון</div>
      <div class="flex gap-10" style="align-items:center;margin-top:6px;">
        ${/* COMM-318: no avatar_url available here on purpose - post_new_member_on_join's metadata is stamped at redemption time, before the profile row usually even exists, so a photo could never be threaded through without a second live lookup for a rarely-seen card. Initials only, matching the club-logo exception. */ avatarHtml(memberName, 40)}
        <div>
          ${memberId ? `<button class="link-btn" data-community-action="view-profile" data-id="${esc(memberId)}" style="padding:0;font-weight:800;color:inherit;">${esc(memberName)}</button>` : `<div style="font-weight:800;">${esc(memberName)}</div>`}
          ${joined ? `<div style="color:var(--steel);font-size:12px;">${esc(String(joined).slice(0, 10))}</div>` : ""}
        </div>
      </div>`;
    const extra = `${memberId ? `<button class="chip-btn" data-community-action="follow" data-id="${esc(memberId)}">מעקב</button>` : ""}<button class="chip-btn" data-community-action="welcome-member" data-id="${esc(post.id)}">ברכה</button>`;
    return postCardShell(post, inner, { extra, authorless: true, clubName: "המועדון", hideMenu: true });
  }

  // COMM-107: system notices read as club voice. No profile link, muted, no
  // More menu, reactions and comments disabled.
  function renderSystemPostCard(post) {
    return postCardShell(post, postBodyHtml(post), { authorless: true, clubName: "המועדון", hideMenu: true, engagementDisabled: true });
  }

  function renderUnknownPostCard(post) {
    return postCardShell(post, postBodyHtml(post) + postMediaHtml(post), { unknown: true });
  }
  function renderErrorPostCard(post) {
    const authorId = post && post.author_id;
    return `<article class="chart-card post-card" data-post-type="${esc((post && post.post_type) || "UNKNOWN")}" data-post-error="1">
      <div class="empty">לא ניתן להציג את הפוסט הזה</div>
      ${authorId ? `<div class="chip-row"><button class="chip-btn" data-community-action="view-profile" data-id="${esc(authorId)}">מעבר לפרופיל</button></div>` : ""}
    </article>`;
  }
  function renderPostCardSkeleton() {
    return `<article class="chart-card post-card" aria-hidden="true"><div class="post-head"><span class="avatar-badge" style="width:36px;height:36px;background:var(--border);"></span><div class="post-head-text"><div class="post-author" style="width:90px;height:12px;background:var(--border);border-radius:6px;"></div><div class="post-time" style="width:60px;height:10px;background:var(--border);border-radius:6px;margin-top:4px;"></div></div></div><div style="height:40px;background:var(--border);border-radius:8px;margin-top:10px;"></div></article>`;
  }

  const POST_CARD_RENDERERS = {
    POST_TEXT: renderTextPostCard,
    POST_PHOTO: renderPhotoPostCard,
    POST_WORKOUT: renderWorkoutPostCard,
    POST_PR: renderPrPostCard,
    POST_ACHIEVEMENT: renderAchievementPostCard,
    POST_ATTENDANCE_MILESTONE: renderAttendanceMilestonePostCard,
    POST_CHALLENGE: renderChallengeLinkCard,
    POST_EVENT: renderEventLinkCard,
    POST_ANNOUNCEMENT: renderAnnouncementPostCard,
    POST_NEW_MEMBER: renderNewMemberPostCard,
    POST_COACH: renderCoachPostCard,
    POST_SYSTEM: renderSystemPostCard,
  };
  // COMM-101. One dispatch. Unknown type -> a minimal safe text card plus a
  // warning, never a throw. A renderer that throws -> an error card.
  function renderPostCard(post) {
    if (!post || typeof post !== "object") return renderErrorPostCard(null);
    try {
      const renderer = POST_CARD_RENDERERS[post.post_type];
      if (!renderer) {
        if (typeof console !== "undefined" && console.warn) console.warn("[posts] unknown post_type, using a plain text card:", post.post_type);
        return renderUnknownPostCard(post);
      }
      return renderer(post);
    } catch (err) {
      if (typeof console !== "undefined" && console.error) console.error("[posts] renderPostCard failed for", post && post.post_type, err);
      return renderErrorPostCard(post);
    }
  }
  window.renderPostCard = renderPostCard;
  window.renderPostCardSkeleton = renderPostCardSkeleton;

  // ---- Challenges (COMM-201..207) -----------------------------------------
  // Generalizes the old single hardcoded weekly challenge (loadWeeklyChallenge
  // / setWeeklyChallenge / weeklyLeaderboard, still above, still serving the
  // legacy weekly_challenges table read-only) into the six challenge_type
  // model. Nothing here reads or writes weekly_challenges; the two systems
  // sit side by side, which is what COMM-201 asks for ("stop being the write
  // and read path for new challenges", not "delete the historical board").
  const CHALLENGE_TYPES = [
    { id: "individual_target", label: "יעד אישי", icon: "🎯" },
    { id: "individual_performance", label: "ביצוע אישי", icon: "📈" },
    { id: "cooperative", label: "שיתופי", icon: "🤝" },
    { id: "team", label: "קבוצתי", icon: "🏳️" },
    { id: "consistency", label: "עקביות", icon: "📅" },
    { id: "coach", label: "מותאם אישית", icon: "🏋️" },
  ];
  function challengeTypeDef(id) { return CHALLENGE_TYPES.find((t) => t.id === id) || { id, label: id || "", icon: "🏆" }; }
  function challengeStatusLabel(c) { return { draft: "טיוטה", active: "פעיל", completed: "הושלם", archived: "בארכיון" }[c && c.status] || (c && c.status) || ""; }
  function formatChallengeDate(iso) { return iso ? String(iso).slice(0, 10) : ""; }
  function daysRemaining(endAt) {
    if (!endAt) return null;
    return Math.max(0, Math.ceil((new Date(endAt).getTime() - Date.now()) / 86400000));
  }
  function challengeProgressBarHtml(pct) {
    const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
    return `<div class="progress-track"><div style="width:${clamped}%;"></div></div>`;
  }

  async function loadChallenges() {
    if (!state.user) { state.challenges.items = []; state.challenges.participation = {}; state.challenges.aggregates = {}; state.challenges.loaded = false; return; }
    state.challenges.loading = true;
    rerender();
    const { data, error } = await client.from("challenges").select("*").order("end_at", { ascending: true });
    if (error) { state.challenges.loading = false; state.challenges.error = true; return rerender(); }
    state.challenges.items = data || [];
    state.challenges.error = false;
    const { data: myRows, error: myErr } = await client.from("challenge_participants").select("*").eq("user_id", state.user.id);
    state.challenges.participation = {};
    if (!myErr) for (const row of (myRows || [])) state.challenges.participation[row.challenge_id] = row;
    // chal_progress() is fetched for every active challenge, not lazily per
    // card: this is a single small club, active challenges are few, and the
    // list card needs a real participant_count and (for cooperative/team) a
    // real aggregate rather than a stale one, per COMM-207's card contract.
    const active = state.challenges.items.filter((c) => c.status === "active");
    await Promise.all(active.map(async (c) => {
      const { data: p, error: pErr } = await client.rpc("chal_progress", { challenge_id: c.id });
      if (!pErr && p) state.challenges.aggregates[c.id] = p;
    }));
    state.challenges.loading = false;
    state.challenges.loaded = true;
    rerender();
  }

  // ---- Detail (COMM-207) --------------------------------------------------
  async function openChallenge(id, source) {
    if (!id) return;
    track(A.CHALLENGE_VIEWED, { challenge_id: id, challenge_key: null, source: source || "boards" });
    state.challenges.view = {
      id, loading: true, error: false, challenge: null, progress: null, teams: [], participants: [], contributors: [], myParticipant: null,
      joining: false, leaving: false, teamJoining: null, sharing: false,
      logForm: { delta: "", note: "", busy: false, error: "" },
      coachEntry: { drafts: {}, busy: {}, error: "" },
      // COMM-211/212. feed_leaderboard(mode='progress') rows for this
      // challenge, fetched only for the two types whose panel shows a board.
      // Starts `loading` so the first paint is the skeleton, not an empty
      // state we have not asked the server about yet.
      board: { scope: "club", limit: CHALLENGE_BOARD_LIMIT, rows: [], loading: true, loaded: false, error: false },
      // COMM-308. A community.challenge.create holder's team management
      // block inside the `team` panel - create/rename/delete challenge_teams
      // rows, move a participant (chal_reassign_team) and set/clear a
      // captain (chal_set_captain). `loading` is this block's own skeleton
      // flag, set only around a refetch this block itself triggers (a
      // mutation here can change team_totals, participants and captains all
      // at once, so the whole detail is re-read rather than patched by
      // hand) - separate from the dialog-level `loading` above, which only
      // ever covers the very first open. Untouched by anything a plain
      // member does; nothing here is ever visible to one.
      teamMgmt: { createName: "", createBusy: false, createError: "", renameDrafts: {}, renameBusy: {}, deleteBusy: {}, captainBusy: {}, reassignBusy: {}, loading: false, error: "" },
    };
    rerender();
    await refreshChallengeView(id);
  }
  // COMM-209. Leaving the detail closes its two channels immediately rather
  // than waiting for the next render to notice, so a member who opens and
  // closes several challenges never holds more than one pair open.
  function closeChallengeView() { state.challenges.view = null; ensureChallengeRealtime(); rerender(); }
  async function refreshChallengeView(id) {
    const v = state.challenges.view;
    if (!v || v.id !== id) return;
    const [{ data: challenge, error: cErr }, { data: progress, error: pErr }] = await Promise.all([
      client.from("challenges").select("*").eq("id", id).maybeSingle(),
      client.rpc("chal_progress", { challenge_id: id }),
    ]);
    if (!state.challenges.view || state.challenges.view.id !== id) return;
    if (cErr || !challenge) { state.challenges.view.loading = false; state.challenges.view.error = true; return rerender(); }
    state.challenges.view.challenge = challenge;
    state.challenges.view.progress = pErr ? null : progress;
    if (challenge.status === "active" && !pErr && progress) state.challenges.aggregates[id] = progress;
    const { data: participants } = await client.from("challenge_participants")
      .select("*, profiles(display_name,handle,avatar_url,visible_to_club)")
      .eq("challenge_id", id).order("joined_at", { ascending: true });
    state.challenges.view.participants = participants || [];
    const mine = (participants || []).find((p) => p.user_id === (state.user && state.user.id)) || null;
    state.challenges.view.myParticipant = mine;
    if (state.user) { if (mine) state.challenges.participation[id] = mine; else delete state.challenges.participation[id]; }
    if (challenge.challenge_type === "team") {
      const { data: teams } = await client.from("challenge_teams").select("*").eq("challenge_id", id).order("name", { ascending: true });
      state.challenges.view.teams = teams || [];
    }
    if (challenge.challenge_type === "cooperative") {
      const { data: contrib } = await client.from("challenge_progress")
        // Names the foreign key for the same reason loadCommentsFor() does:
        // challenge_progress references profiles twice (user_id and
        // entered_by), so a bare `profiles(...)` is PGRST201-ambiguous and
        // the contributor list came back empty every time.
        .select("user_id,delta,created_at,profiles!challenge_progress_user_id_fkey(display_name,handle,avatar_url,visible_to_club)")
        .eq("challenge_id", id).gt("delta", 0).order("created_at", { ascending: false }).limit(30);
      const seen = new Set();
      const list = [];
      for (const row of (contrib || [])) {
        if (seen.has(row.user_id)) continue;
        seen.add(row.user_id);
        // COMM-203. A contributor who turned visible_to_club off still
        // counts toward club_total (that sum is chal_progress's, computed
        // server-side over every row) but is omitted from this named list.
        if (row.profiles && row.profiles.visible_to_club === false) continue;
        list.push(row);
        if (list.length >= 10) break;
      }
      state.challenges.view.contributors = list;
    }
    // COMM-211. Awaited before the dialog drops its loading flag so the board
    // and the rest of the detail land in the same paint. Only the two types
    // whose panel is a leaderboard ask for it; nothing else touches
    // feed_leaderboard from the challenge detail at all.
    if (challenge.challenge_type === "individual_performance" || challenge.challenge_type === "coach") {
      await loadChallengeBoard(id, { rerender: false });
      if (!state.challenges.view || state.challenges.view.id !== id) return;
    } else if (state.challenges.view.board) {
      state.challenges.view.board.loading = false;
    }
    state.challenges.view.loading = false;
    rerender();
  }

  // ---- Join / leave / team pick (COMM-204, COMM-207) -----------------------
  async function joinChallenge(id, source) {
    if (!state.user) return;
    const v = state.challenges.view;
    const c = (v && v.challenge) || state.challenges.items.find((x) => x.id === id);
    if (v && v.id === id) { v.joining = true; rerender(); }
    const { error } = await client.from("challenge_participants").insert({ challenge_id: id, user_id: state.user.id });
    if (v && v.id === id) v.joining = false;
    if (error) { setMessage("לא ניתן היה להצטרף לאתגר. נסו שוב."); return rerender(); }
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.CHALLENGE_JOINED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.CHALLENGE_JOINED, { challenge_id: id, challenge_type: c && c.challenge_type }); } catch (e) {}
    }
    setMessage("הצטרפת לאתגר");
    if (c && c.challenge_type === "team" && c.join_mode === "auto") await autoAssignChallengeTeam(id);
    await loadChallenges();
    if (state.challenges.view && state.challenges.view.id === id) await refreshChallengeView(id);
    rerender();
  }
  async function autoAssignChallengeTeam(id) {
    if (!state.user) return;
    const { data: teams } = await client.from("challenge_teams").select("*").eq("challenge_id", id);
    const { data: parts } = await client.from("challenge_participants").select("team_id,status").eq("challenge_id", id);
    if (!teams || !teams.length) return;
    const counts = {};
    for (const t of teams) counts[t.id] = 0;
    for (const p of (parts || [])) if (p.status !== "withdrawn" && p.team_id) counts[p.team_id] = (counts[p.team_id] || 0) + 1;
    const chosen = teams.slice().sort((a, b) => (counts[a.id] || 0) - (counts[b.id] || 0))[0];
    if (!chosen) return;
    await client.from("challenge_participants").update({ team_id: chosen.id }).eq("challenge_id", id).eq("user_id", state.user.id);
  }
  async function pickChallengeTeam(challengeId, teamId) {
    if (!state.user) return;
    const v = state.challenges.view;
    if (v) { v.teamJoining = teamId; rerender(); }
    const { error } = await client.from("challenge_participants").update({ team_id: teamId }).eq("challenge_id", challengeId).eq("user_id", state.user.id);
    if (v) v.teamJoining = null;
    if (error) { setMessage("לא ניתן היה להצטרף לקבוצה. נסו שוב."); return rerender(); }
    if (state.challenges.view && state.challenges.view.id === challengeId) await refreshChallengeView(challengeId);
    rerender();
  }

  // ---- Team management (COMM-308) ------------------------------------------
  // A community.challenge.create holder only, layered onto the `team` panel
  // COMM-204 already shipped. Team creation/rename/delete stay the same
  // direct-RLS write COMM-006/COMM-204 always used (challenge_teams'
  // policies are unchanged by the schema half); moving a participant and
  // naming a captain are the two new security-definer RPCs
  // (chal_reassign_team, chal_set_captain), the same coach-past-RLS shape
  // chal_record_progress already established. Every mutation here re-reads
  // the whole detail through refreshChallengeView rather than patching state
  // by hand, because a single reassignment can move a team_totals number, a
  // participant's team_id AND (via challenge_teams_release_captain, schema
  // half) a captain_id all in one server transaction - the client should
  // show what the server actually did, not what it assumes happened.
  //
  // The nine real Postgres errors chal_reassign_team/chal_set_captain raise
  // (verbatim, schema half), mapped to short Hebrew - the same
  // setMessage()-surfaced pattern memberOfWeekErrorText/monthlyRecapErrorText
  // already use for a failed staff action. Any other error (network, a
  // failed direct challenge_teams write) falls back to the ticket's own
  // generic copy, "הפעולה נכשלה. נסו שוב.".
  const CHALLENGE_TEAM_MGMT_ERROR_LABELS = {
    "not authorized": "אין הרשאה לבצע פעולה זו.",
    "challenge and target participant are required": "חסרים פרטים לביצוע ההעברה.",
    "challenge not found": "האתגר לא נמצא.",
    "not a team challenge": "האתגר הזה אינו אתגר קבוצתי.",
    "not an active participant": "המשתתפ/ת אינו/ה פעיל/ה באתגר.",
    "team does not belong to this challenge": "הקבוצה אינה שייכת לאתגר הזה.",
    "team is required": "יש לבחור קבוצה.",
    "team not found": "הקבוצה לא נמצאה.",
    "captain must be an active participant on this team": "הקפטן/ית חייב/ת להיות משתתפ/ת פעיל/ה בקבוצה.",
    "team not empty": "יש לפנות את הקבוצה מחברים לפני מחיקתה.",
  };
  function challengeTeamMgmtErrorText(error) {
    const msg = error && error.message;
    return (msg && CHALLENGE_TEAM_MGMT_ERROR_LABELS[msg]) || "הפעולה נכשלה. נסו שוב.";
  }
  // Re-reads the whole detail after a team-management write, with its own
  // skeleton flag around just that (state.challenges.view.teamMgmt.loading),
  // not the dialog-level one refreshChallengeView() itself never sets after
  // the first open - see the state comment in openChallenge().
  async function refreshAfterTeamMgmt(id) {
    const v = state.challenges.view;
    if (!v || v.id !== id) return;
    v.teamMgmt.loading = true;
    rerender();
    await refreshChallengeView(id);
    const after = state.challenges.view;
    if (after && after.id === id) { after.teamMgmt.loading = false; rerender(); }
  }
  async function createChallengeTeam() {
    const v = state.challenges.view;
    if (!v || !v.challenge || v.teamMgmt.createBusy) return;
    const name = String(v.teamMgmt.createName || "").trim();
    if (!name || name.length > 80) { v.teamMgmt.createError = "יש להזין שם קבוצה, עד 80 תווים"; return rerender(); }
    v.teamMgmt.createBusy = true; v.teamMgmt.createError = ""; rerender();
    const { error } = await client.from("challenge_teams").insert({ id: newFeedId(), challenge_id: v.id, name });
    v.teamMgmt.createBusy = false;
    if (error) { v.teamMgmt.createError = "הפעולה נכשלה. נסו שוב."; return rerender(); }
    v.teamMgmt.createName = "";
    setMessage("הקבוצה נוצרה");
    await refreshAfterTeamMgmt(v.id);
  }
  async function renameChallengeTeam(teamId) {
    const v = state.challenges.view;
    if (!v || !v.challenge || v.teamMgmt.renameBusy[teamId]) return;
    const existing = (v.teams || []).find((t) => t.id === teamId);
    const draft = v.teamMgmt.renameDrafts[teamId];
    const name = String(draft != null ? draft : (existing ? existing.name : "")).trim();
    if (!name || name.length > 80) { v.teamMgmt.error = "יש להזין שם קבוצה, עד 80 תווים"; return rerender(); }
    v.teamMgmt.renameBusy[teamId] = true; v.teamMgmt.error = ""; rerender();
    const { error } = await client.from("challenge_teams").update({ name }).eq("id", teamId);
    v.teamMgmt.renameBusy[teamId] = false;
    if (error) { v.teamMgmt.error = challengeTeamMgmtErrorText(error); return rerender(); }
    delete v.teamMgmt.renameDrafts[teamId];
    setMessage("שם הקבוצה עודכן");
    await refreshAfterTeamMgmt(v.id);
  }
  // COMM-308's own rule: a team with an active (non-withdrawn) participant
  // refuses deletion server-side ('team not empty'). The delete control is
  // disabled client-side whenever this client already knows the team has a
  // member (renderTeamManagementPanel), so this call only ever reaches the
  // server for a genuinely empty team from this client's own point of view -
  // the error mapping stays as a defensive fallback for the race a second
  // coach's tab can create, not the primary guard.
  function confirmDeleteChallengeTeam(teamId) {
    askConfirm({ title: "מחיקת קבוצה", message: "למחוק את הקבוצה? הפעולה אינה ניתנת לביטול.", confirmLabel: "מחיקה", destructive: true, action: "challenge-team-delete-confirm", payload: { teamId } });
  }
  async function deleteChallengeTeam(teamId) {
    const v = state.challenges.view;
    if (!v || !v.challenge || v.teamMgmt.deleteBusy[teamId]) return;
    v.teamMgmt.deleteBusy[teamId] = true; v.teamMgmt.error = ""; rerender();
    const { error } = await client.from("challenge_teams").delete().eq("id", teamId);
    v.teamMgmt.deleteBusy[teamId] = false;
    if (error) { v.teamMgmt.error = challengeTeamMgmtErrorText(error); return rerender(); }
    setMessage("הקבוצה נמחקה");
    await refreshAfterTeamMgmt(v.id);
  }
  async function reassignChallengeParticipant(challengeId, userId, teamId) {
    const v = state.challenges.view;
    if (!v || v.teamMgmt.reassignBusy[userId]) return;
    v.teamMgmt.reassignBusy[userId] = true; v.teamMgmt.error = ""; rerender();
    const { error } = await client.rpc("chal_reassign_team", { p_challenge_id: challengeId, p_user_id: userId, p_team_id: teamId || null });
    v.teamMgmt.reassignBusy[userId] = false;
    if (error) { v.teamMgmt.error = challengeTeamMgmtErrorText(error); return rerender(); }
    setMessage("המשתתפ/ת הועבר/ה לקבוצה");
    await refreshAfterTeamMgmt(v.id);
  }
  async function setChallengeTeamCaptain(teamId, userId) {
    const v = state.challenges.view;
    if (!v || v.teamMgmt.captainBusy[teamId]) return;
    v.teamMgmt.captainBusy[teamId] = true; v.teamMgmt.error = ""; rerender();
    const { error } = await client.rpc("chal_set_captain", { p_team_id: teamId, p_user_id: userId || null });
    v.teamMgmt.captainBusy[teamId] = false;
    if (error) { v.teamMgmt.error = challengeTeamMgmtErrorText(error); return rerender(); }
    setMessage(userId ? "הקפטן/ית עודכנ/ה" : "הקפטן/ית הוסר/ה");
    await refreshAfterTeamMgmt(v.id);
  }

  function confirmLeaveChallenge(id) {
    askConfirm({ title: "עזיבת אתגר", message: "לעזוב את האתגר? ההתקדמות שכבר נרשמה תישאר בסטטיסטיקות המועדון.", confirmLabel: "עזיבה", destructive: true, action: "leave-challenge", payload: { challengeId: id } });
  }
  async function leaveChallenge(id) {
    if (!state.user) return;
    const v = state.challenges.view;
    if (v && v.id === id) { v.leaving = true; rerender(); }
    const { error } = await client.from("challenge_participants").delete().eq("challenge_id", id).eq("user_id", state.user.id);
    if (v && v.id === id) v.leaving = false;
    if (error) { setMessage("לא ניתן היה לעזוב את האתגר. נסו שוב."); return rerender(); }
    delete state.challenges.participation[id];
    setMessage("עזבת את האתגר");
    await loadChallenges();
    if (state.challenges.view && state.challenges.view.id === id) await refreshChallengeView(id);
    rerender();
  }

  // ---- Self-logged progress (COMM-202, COMM-203, COMM-204, COMM-205) ------
  function maybeCelebrateChallengeCompletion(challengeType, challengeId, wasStatus, isStatus) {
    if (wasStatus === "completed" || isStatus !== "completed") return;
    setMessage("כל הכבוד! השלמת את האתגר");
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.CHALLENGE_COMPLETED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.CHALLENGE_COMPLETED, { challenge_id: challengeId, challenge_type: challengeType }); } catch (e) {}
    }
  }
  async function submitChallengeLog() {
    const v = state.challenges.view;
    if (!v || !v.challenge || v.logForm.busy) return;
    const raw = String(v.logForm.delta || "").trim();
    const delta = Number(raw);
    if (!raw || !Number.isFinite(delta) || delta === 0) { v.logForm.error = "יש להזין ערך מספרי"; return rerender(); }
    v.logForm.busy = true; v.logForm.error = ""; rerender();
    const wasStatus = v.myParticipant && v.myParticipant.status;
    const note = String(v.logForm.note || "").trim().slice(0, 500) || null;
    const { error } = await client.from("challenge_progress").insert({ challenge_id: v.id, user_id: state.user.id, delta, source_type: "manual", note });
    v.logForm.busy = false;
    if (error) { v.logForm.error = "לא ניתן היה לעדכן את ההתקדמות."; return rerender(); }
    v.logForm.delta = ""; v.logForm.note = "";
    await refreshChallengeView(v.id);
    await loadChallenges();
    const after = state.challenges.view && state.challenges.view.myParticipant;
    if (after) maybeCelebrateChallengeCompletion(v.challenge.challenge_type, v.id, wasStatus, after.status);
    rerender();
  }
  // COMM-205. Consistency has no numeric delta from the member: one tap logs
  // exactly one "week hit" once a week's target is reached. Detail-only, no
  // dedicated dialog.
  async function logConsistencyWeekHit() {
    const v = state.challenges.view;
    if (!v) return;
    const challengeId = v.id;
    v.logForm.delta = "1";
    v.logForm.note = "";
    await submitChallengeLog();
    // challenge_progress_apply (contracts.md, "Needs from schema,
    // challenges") deliberately excludes consistency and team from its
    // auto-complete list - my_status there stays whatever the participant
    // row already carried. COMM-205 still asks for "completing all required
    // weeks marks the participant completed", so the client does that one
    // direct-RLS status update itself: challenge_participants_update_self
    // already allows a self-row update with no column restriction, so this
    // needs no new policy or function, matching COMM-201's "no new write
    // RPC" rule.
    const after = state.challenges.view;
    if (!after || after.id !== challengeId || !after.myParticipant || !after.challenge) return;
    const weeks = Number((after.challenge.config && after.challenge.config.weeks) || 0);
    if (after.myParticipant.status !== "completed" && weeks > 0 && Number(after.myParticipant.progress_value || 0) >= weeks) {
      const { error } = await client.from("challenge_participants")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("challenge_id", challengeId).eq("user_id", state.user.id);
      if (!error) {
        maybeCelebrateChallengeCompletion("consistency", challengeId, "active", "completed");
        await refreshChallengeView(challengeId);
        await loadChallenges();
        rerender();
      }
    }
  }

  // ---- Coach manual entry (COMM-206) ---------------------------------------
  async function submitCoachEntry(userId) {
    const v = state.challenges.view;
    if (!v || !v.challenge || !userId) return;
    const d = v.coachEntry.drafts[userId] || {};
    const delta = Number(String(d.delta || "").trim());
    if (!d.delta || !Number.isFinite(delta) || delta === 0) { v.coachEntry.error = "יש להזין ערך מספרי"; return rerender(); }
    v.coachEntry.busy[userId] = true; v.coachEntry.error = ""; rerender();
    const targetParticipant = v.participants.find((p) => p.user_id === userId);
    const wasStatus = targetParticipant && targetParticipant.status;
    const note = String(d.note || "").trim().slice(0, 500) || null;
    const { error } = await client.rpc("chal_record_progress", { p_challenge_id: v.id, p_user_id: userId, p_delta: delta, p_note: note });
    v.coachEntry.busy[userId] = false;
    if (error) { v.coachEntry.error = "לא ניתן היה לשמור את העדכון."; return rerender(); }
    v.coachEntry.drafts[userId] = { delta: "", note: "" };
    await refreshChallengeView(v.id);
    const after = state.challenges.view && state.challenges.view.participants.find((p) => p.user_id === userId);
    if (after) maybeCelebrateChallengeCompletion(v.challenge.challenge_type, v.id, wasStatus, after.status);
    rerender();
  }

  // ---- Share Progress (COMM-207) -------------------------------------------
  async function shareChallengeProgress() {
    const v = state.challenges.view;
    if (!v || !v.challenge || v.sharing) return;
    v.sharing = true; rerender();
    const c = v.challenge, p = v.progress || {};
    const lines = [c.title];
    if (c.challenge_type === "cooperative" && p.club_total != null) lines.push(`${p.club_total}${c.target_value != null ? ` / ${c.target_value}` : ""}`);
    else if (p.my_progress != null) lines.push(`${p.my_progress}${c.target_value != null ? ` / ${c.target_value}` : ""}`);
    const body = lines.join("\n");
    // COMM-207 asks Share Progress to call post_create with links.challenge_id
    // set, producing a POST_CHALLENGE post. post_create's shipped signature
    // (202608280023) only merges workout_id/achievement_id/event_id out of
    // `links` into metadata and only ever writes POST_TEXT or POST_PHOTO -
    // there is no server path yet that turns a member's own share into a
    // POST_CHALLENGE row with challenge_id/progress in its metadata. Sending
    // challenge_id anyway costs nothing (an unknown links key is dropped, not
    // rejected) and is exactly what a follow-up post_create migration needs
    // to start honouring; until then this still produces a real, truthful
    // POST_TEXT post carrying the same progress line in its body. Recorded
    // as an open gap in the handoff notes, not silently worked around.
    const { data, error } = await client.rpc("post_create", { body, visibility: "club", media: [], links: { challenge_id: c.id } });
    v.sharing = false;
    if (error || !data) { setMessage("שיתוף ההתקדמות נכשל, אפשר לנסות שוב"); return rerender(); }
    setMessage("ההתקדמות שותפה לקהילה");
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.POST_CREATED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.POST_CREATED, { post_id: data, post_type: "POST_TEXT" }); } catch (e) {}
    }
    rerender();
  }

  // ---- Create / edit form (COMM-201) ---------------------------------------
  function openChallengeForm(existing) {
    state.challenges.form = existing ? {
      mode: "edit", id: existing.id, status: existing.status, challengeType: existing.challenge_type,
      title: existing.title, description: existing.description || "",
      metricType: existing.metric_type, targetValue: existing.target_value != null ? String(existing.target_value) : "",
      startAt: formatChallengeDate(existing.start_at), endAt: formatChallengeDate(existing.end_at),
      rulesText: (existing.config && existing.config.rules_text) || "",
      metricLabel: (existing.config && existing.config.metric_label) || "",
      timesPerWeek: (existing.config && existing.config.times_per_week) || "",
      weeks: (existing.config && existing.config.weeks) || "",
      teamNames: "", saving: false, error: "",
    } : {
      mode: "create", id: null, status: "draft", challengeType: "individual_target",
      title: "", description: "", metricType: "", targetValue: "", startAt: "", endAt: "",
      rulesText: "", metricLabel: "", timesPerWeek: "", weeks: "", teamNames: "", saving: false, error: "",
    };
    rerender();
  }
  function closeChallengeForm() { state.challenges.form = null; setFieldErrors("communityChallengeForm", {}); rerender(); }
  function setChallengeFormType(type) { if (state.challenges.form && state.challenges.form.mode !== "edit") { state.challenges.form.challengeType = type; rerender(); } }
  async function submitChallengeForm(form) {
    const f = state.challenges.form;
    if (!f || f.saving) return;
    const fd = new FormData(form);
    const title = String(fd.get("title") || "").trim();
    const description = String(fd.get("description") || "").trim();
    const metricType = String(fd.get("metricType") || "").trim();
    const targetRaw = String(fd.get("targetValue") || "").trim();
    const startAt = String(fd.get("startAt") || "");
    const endAt = String(fd.get("endAt") || "");
    const errors = {};
    if (title.length < 1 || title.length > 120) errors.title = "כותרת נדרשת, עד 120 תווים";
    if (description.length > 2000) errors.description = "עד 2000 תווים";
    if (!metricType || metricType.length > 60) errors.metricType = "שדה נדרש, עד 60 תווים";
    if (!startAt) errors.startAt = "יש לבחור תאריך התחלה";
    if (!endAt) errors.endAt = "יש לבחור תאריך סיום";
    if (startAt && endAt && !(new Date(endAt).getTime() > new Date(startAt).getTime())) errors.endAt = "תאריך הסיום חייב להיות אחרי ההתחלה";
    const config = {};
    let teamNames = [];
    if (f.challengeType === "coach") {
      const rulesText = String(fd.get("rulesText") || "").trim().slice(0, 1000);
      const metricLabel = String(fd.get("metricLabel") || "").trim();
      if (!rulesText) errors.rulesText = "יש לתאר את חוקי האתגר";
      config.rules_text = rulesText;
      if (metricLabel) config.metric_label = metricLabel;
    }
    if (f.challengeType === "consistency") {
      const timesPerWeek = Number(fd.get("timesPerWeek"));
      const weeks = Number(fd.get("weeks"));
      if (!Number.isInteger(timesPerWeek) || timesPerWeek < 1) errors.timesPerWeek = "מספר שלם חיובי נדרש";
      if (!Number.isInteger(weeks) || weeks < 1) errors.weeks = "מספר שלם חיובי נדרש";
      config.times_per_week = timesPerWeek;
      config.weeks = weeks;
    }
    if (f.challengeType === "team" && f.mode === "create") {
      teamNames = String(fd.get("teamNames") || "").split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 20);
      if (teamNames.length < 2) errors.teamNames = "יש להזין לפחות שתי קבוצות";
    }
    if (Object.keys(errors).length) return setFieldErrors("communityChallengeForm", errors);
    setFieldErrors("communityChallengeForm", {});
    f.saving = true; f.error = ""; rerender();
    const payload = {
      title, description, metric_type: metricType,
      target_value: targetRaw ? Number(targetRaw) : null,
      start_at: new Date(startAt).toISOString(), end_at: new Date(endAt).toISOString(),
      visibility: "club", config,
    };
    let error;
    if (f.mode === "create") {
      payload.id = newFeedId();
      payload.challenge_type = f.challengeType;
      payload.created_by = state.user.id;
      payload.status = fd.get("publishNow") ? "active" : "draft";
      payload.join_mode = f.challengeType === "team" ? (fd.get("teamAuto") ? "auto" : "open") : "open";
      ({ error } = await client.from("challenges").insert(payload));
      if (!error && f.challengeType === "team" && teamNames.length) {
        await client.from("challenge_teams").insert(teamNames.map((name) => ({ id: newFeedId(), challenge_id: payload.id, name })));
      }
    } else {
      ({ error } = await client.from("challenges").update(payload).eq("id", f.id));
    }
    f.saving = false;
    if (error) { f.error = "לא ניתן היה לשמור את האתגר. נסו שוב."; return rerender(); }
    state.challenges.form = null;
    setMessage("האתגר נשמר");
    await loadChallenges();
    rerender();
  }
  async function archiveChallenge(id) {
    const { error } = await client.from("challenges").update({ status: "archived" }).eq("id", id);
    if (error) return setMessage("הפעולה נכשלה");
    state.challenges.form = null;
    setMessage("האתגר הועבר לארכיון");
    await loadChallenges();
    if (state.challenges.view && state.challenges.view.id === id) await refreshChallengeView(id);
    rerender();
  }
  async function publishChallengeDraft(id) {
    const { error } = await client.from("challenges").update({ status: "active" }).eq("id", id);
    if (error) return setMessage("הפעולה נכשלה");
    state.challenges.form = null;
    setMessage("האתגר פורסם");
    await loadChallenges();
    rerender();
  }
  async function deleteChallengeDraft(id) {
    const { error } = await client.from("challenges").delete().eq("id", id);
    if (error) return setMessage("הפעולה נכשלה");
    state.challenges.form = null;
    setMessage("הטיוטה נמחקה");
    await loadChallenges();
    rerender();
  }

  // ---- Automatic progress from the product event bus (COMM-202, COMM-205) -
  // Sourced from the same non-attendance signals the achievement engine
  // reacts to (COMM-130/132), never from attendance. WORKOUT_COMPLETED has no
  // producer anywhere in this codebase yet - only PR_CREATED and the
  // ach_claim path fire in production today - so this consumer is wired and
  // ready but dormant until a workout-logging surface starts emitting it; a
  // test exercises it by emitting the event directly on the bus.
  function activeChallengeParticipations(types) {
    if (!state.user) return [];
    return state.challenges.items.filter((c) => c.status === "active" && types.indexOf(c.challenge_type) >= 0
      && state.challenges.participation[c.id] && state.challenges.participation[c.id].status === "active");
  }
  async function logAutoChallengeProgress(challengeId, delta, sourceType, consistencyKey) {
    if (!state.user || !delta) return;
    const { error } = await client.from("challenge_progress").insert({ challenge_id: challengeId, user_id: state.user.id, delta, source_type: sourceType || "auto" });
    if (!error) {
      await loadChallenges();
      if (state.challenges.view && state.challenges.view.id === challengeId) await refreshChallengeView(challengeId);
      rerender();
    } else if (consistencyKey) {
      // The caller sets _consistencyWeekLogged[key] optimistically before
      // this insert resolves (COMM-205's in-memory guard, needed to avoid
      // double-counting from a fire-and-forget call). A failed write must
      // not permanently burn that week's consistency credit with no retry -
      // roll the flag back so the next qualifying session tries again.
      delete state.challenges._consistencyWeekLogged[consistencyKey];
    }
  }
  // ISO 8601 week, e.g. "2026-W35" - the same week boundary the achievement
  // engine's week-streak metric already uses.
  function isoWeekKey(when) {
    const date = new Date(when || Date.now());
    const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNr = (target.getUTCDay() + 6) % 7;
    target.setUTCDate(target.getUTCDate() - dayNr + 3);
    const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
    const weekNr = 1 + Math.round(((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
    return `${target.getUTCFullYear()}-W${String(weekNr).padStart(2, "0")}`;
  }
  function onWorkoutCompletedForChallenges() {
    if (!state.user) return;
    // individual_target: every logged session is one unit toward a
    // session-count target.
    for (const c of activeChallengeParticipations(["individual_target"])) {
      logAutoChallengeProgress(c.id, 1, "workout_completed");
    }
    // consistency: tally sessions per ISO week on this device and log one
    // "week hit" delta the first time this week crosses times_per_week -
    // never a second time for the same week on this device.
    const week = isoWeekKey();
    for (const c of activeChallengeParticipations(["consistency"])) {
      const key = c.id + ":" + week;
      state.challenges._consistencySessionCounts[key] = (state.challenges._consistencySessionCounts[key] || 0) + 1;
      const target = Number((c.config && c.config.times_per_week) || 0);
      if (target > 0 && state.challenges._consistencySessionCounts[key] >= target && !state.challenges._consistencyWeekLogged[key]) {
        state.challenges._consistencyWeekLogged[key] = true;
        logAutoChallengeProgress(c.id, 1, "workout_completed", key);
      }
    }
  }
  // Consumes the same PR_CREATED payload onPrCreated already reacts to. Only
  // a genuinely numeric result (a payload shape a future producer would need
  // to supply, e.g. `new_result_value`) drives an individual_performance
  // challenge - a formatted display string like '140 ק"ג" is deliberately
  // never parsed here, so a malformed or unexpected payload silently no-ops
  // instead of writing a wrong progress delta.
  function onPrCreatedForChallenges(payload) {
    if (!state.user) return;
    const record = payload && (payload.record || payload);
    const value = record && (record.new_result_value != null ? record.new_result_value : record.new_value_numeric);
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return;
    for (const c of activeChallengeParticipations(["individual_performance"])) {
      logAutoChallengeProgress(c.id, numeric, "pr_created");
    }
  }

  // ---- Rendering: list card (COMM-207) -------------------------------------
  function myChallengeCardProgressHtml(c) {
    const part = state.challenges.participation[c.id];
    if (!part) return "";
    if (c.challenge_type === "cooperative") {
      const agg = state.challenges.aggregates[c.id];
      if (!agg || agg.club_total == null) return "";
      const pct = c.target_value ? Math.round((agg.club_total / c.target_value) * 100) : null;
      return `<div class="mono" style="color:var(--brass);font-size:12px;">${esc(agg.club_total)}${c.target_value != null ? ` / ${esc(c.target_value)}` : ""}</div>${pct != null ? challengeProgressBarHtml(pct) : ""}`;
    }
    if (c.challenge_type === "team") {
      const agg = state.challenges.aggregates[c.id];
      const mine = agg && Array.isArray(agg.team_totals) ? agg.team_totals.find((t) => t.team_id === part.team_id) : null;
      return mine ? `<div class="mono" style="color:var(--brass);font-size:12px;">${esc(mine.name)}: ${esc(mine.total)}</div>` : (part.team_id ? "" : `<div style="color:var(--steel);font-size:12px;">טרם נבחרה קבוצה</div>`);
    }
    if (c.challenge_type === "consistency") {
      const weeks = Number((c.config && c.config.weeks) || 0);
      return `<div class="mono" style="color:var(--brass);font-size:12px;">${esc(part.progress_value)}${weeks ? ` / ${weeks} שבועות` : ""}</div>`;
    }
    const pct = c.target_value ? Math.round((Number(part.progress_value || 0) / c.target_value) * 100) : null;
    return `<div class="mono" style="color:var(--brass);font-size:12px;">${esc(part.progress_value)}${c.target_value != null ? ` / ${esc(c.target_value)}` : ""}</div>${pct != null ? challengeProgressBarHtml(pct) : ""}`;
  }
  function renderChallengeCard(c) {
    const def = challengeTypeDef(c.challenge_type);
    const part = state.challenges.participation[c.id];
    const agg = state.challenges.aggregates[c.id];
    const isPast = c.status === "completed" || c.status === "archived";
    const image = (c.config && c.config.image_url)
      ? `<img src="${esc(c.config.image_url)}" alt="" style="width:44px;height:44px;border-radius:12px;object-fit:cover;"/>`
      : `<span aria-hidden="true" style="width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px;background:var(--border);">${def.icon}</span>`;
    const meta = [def.label, `${formatChallengeDate(c.start_at)}–${formatChallengeDate(c.end_at)}`];
    if (agg && agg.participant_count != null) meta.push(`${agg.participant_count} משתתפים`);
    if (c.status === "draft") meta.push(challengeStatusLabel(c));
    return `<article class="chart-card" data-challenge-id="${esc(c.id)}" data-challenge-status="${esc(c.status)}" style="margin-bottom:10px;">
      <div class="flex gap-10" style="align-items:flex-start;">
        ${image}
        <div style="flex:1;min-width:0;">
          <button class="link-btn" data-community-action="open-challenge" data-id="${esc(c.id)}" data-source="boards" style="padding:0;text-align:right;font-weight:800;font-size:15px;color:inherit;display:block;">${esc(c.title)}</button>
          <div style="color:var(--steel);font-size:11.5px;margin-top:2px;">${meta.map(esc).join(" · ")}</div>
          ${myChallengeCardProgressHtml(c)}
        </div>
      </div>
      <div class="chip-row" style="margin-top:8px;">
        <button class="chip-btn" data-community-action="open-challenge" data-id="${esc(c.id)}" data-source="boards">פרטים</button>
        ${!isPast && c.status === "active" && !part ? `<button class="chip-btn primary" data-community-action="join-challenge" data-id="${esc(c.id)}">הצטרפות</button>` : ""}
        ${!isPast && part ? `<span class="tag tag-brass">נרשמת/ה</span>` : ""}
      </div>
    </article>`;
  }
  function renderChallengesListSection() {
    // COMM-321. RLS already makes challenges_read return nothing (including
    // a staff creator's own draft, per the migration's own OR-branch gate)
    // once this module is off - this keeps the shell/create-button from
    // showing beside an always-empty list.
    if (!isModuleEnabled("challenges")) return "";
    const staff = hasPerm(PERM.CHALLENGE_CREATE);
    const active = state.challenges.items.filter((c) => c.status === "active" || (staff && c.status === "draft"));
    const past = state.challenges.items.filter((c) => c.status === "completed" || c.status === "archived");
    const createBtn = staff ? `<button class="chip-btn primary" data-community-action="open-challenge-form" style="margin-bottom:10px;">אתגר חדש</button>` : "";
    const list = (state.challenges.loading && !state.challenges.loaded)
      ? `<div aria-busy="true">${`<div class="chart-card" style="height:64px;background:var(--border);opacity:.35;margin-bottom:10px;"></div>`.repeat(2)}</div>`
      : state.challenges.error
      ? `<div class="empty">לא ניתן היה לטעון את האתגר. נסו שוב.<div class="chip-row" style="justify-content:center;"><button class="chip-btn" data-community-action="challenges-retry">ניסיון חוזר</button></div></div>`
      : active.length ? active.map(renderChallengeCard).join("") : `<div class="empty">אין אתגרים פעילים כרגע.</div>`;
    const pastHtml = past.length ? `<div style="margin-top:16px;"><div class="field-label" style="margin-bottom:6px;">אתגרים שהסתיימו</div>${past.map(renderChallengeCard).join("")}</div>` : "";
    return `<div class="ach-section">${sectionHead("var(--energy)", "אתגרי המועדון")}${createBtn}${state.challenges.form ? renderChallengeForm() : ""}${list}${pastHtml}</div>`;
  }

  // ==========================================================================
  // COMM-223..226 coach-tools cluster rendering. renderCoachTab() is only
  // ever reached through the "coach" sub-tab, and that sub-tab is only ever
  // added to the tab bar for isStaff() (see the render function below) - so
  // nothing in here repeats a ternary staff-only render gate of its own; the
  // surrounding tab is the gate. A forced state.ui.tab = "coach" for
  // a non-staff caller still falls back to the feed tab there, since the
  // tab bar's own tabs array has no "coach" entry to find.
  // ==========================================================================
  function renderCoachCelebrateItem(item) {
    const key = celebrateItemKey(item);
    const done = !!state.coach.celebrate.congratulated[key];
    const busy = state.coach.celebrate.busy === key;
    const d = item.detail || {};
    const what = item.kind === "pr"
      ? `שיא חדש${d.movement ? ": " + d.movement : ""}${d.result ? " — " + d.result : ""}`
      : item.kind === "anniversary"
      ? `${Number(d.years) || ""} ${Number(d.years) === 1 ? "שנה" : "שנים"} במועדון`
      : item.kind === "challenge_completion"
      ? `השלים/ה את האתגר: ${d.title || ""}`
      : "";
    return `<div class="log-row" style="align-items:flex-start;flex-direction:column;gap:8px;">
      <div class="flex gap-10" style="align-items:center;">
        ${avatarHtml(item.display_name || item.handle, 32, item.avatar_url)}
        <div>
          <button class="link-btn" data-community-action="view-profile" data-id="${esc(item.user_id)}" style="padding:0;font-weight:800;color:inherit;">${nameHtml(item.display_name, item.handle)}</button>
          <div style="color:var(--steel);font-size:12px;">${esc(what)} · ${relativeTime(item.occurred_at)}</div>
        </div>
      </div>
      <button class="chip-btn${done ? "" : " primary"}" data-community-action="coach-congratulate" data-key="${esc(key)}"${done || busy ? " disabled" : ""}>${busy ? "שולח…" : done ? "ברכתם" : "ברכה"}</button>
    </div>`;
  }
  function renderCoachCelebrateSection() {
    const c = state.coach.celebrate;
    const body = (c.loading && !c.loaded)
      ? `<div aria-busy="true">${`<div class="chart-card" style="height:56px;background:var(--border);opacity:.35;margin-bottom:10px;"></div>`.repeat(2)}</div>`
      : c.error
      ? `<div class="empty">לא ניתן היה לטעון את לוח המאמנים. נסו שוב.<div class="chip-row" style="justify-content:center;"><button class="chip-btn" data-community-action="coach-celebrate-retry">ניסיון חוזר</button></div></div>`
      : c.items.length ? `<div class="log-list">${c.items.map(renderCoachCelebrateItem).join("")}</div>` : `<div class="empty">אין דבר לחגוג השבוע.</div>`;
    return `<div class="ach-section">${sectionHead("var(--energy)", "לחגוג")}${body}</div>`;
  }
  function renderCoachWelcomeRow(m) {
    const days = Math.max(0, Math.floor((Date.now() - new Date(m.created_at).getTime()) / 86400000));
    const streakRow = state.club.streaks.find((s) => s.user_id === m.id);
    const streakCount = streakRow ? Number(streakRow.current_streak) : 0;
    const contacted = !!state.coach.welcome.contactedIds[m.id];
    const busy = state.coach.welcome.busy === m.id;
    const assignDraft = (state.coach.welcome.assignDrafts || {})[m.id] || "";
    const contactDraft = (state.coach.welcome.contactDrafts || {})[m.id] || "";
    return `<div class="log-row" style="align-items:flex-start;flex-direction:column;gap:8px;">
      <div class="flex gap-10" style="align-items:center;">
        ${avatarHtml(m.display_name || m.handle, 32, m.avatar_url)}
        <div>
          <div style="font-weight:700;">${nameHtml(m.display_name, m.handle)}</div>
          <div style="color:var(--steel);font-size:12px;">${days === 0 ? "הצטרפ/ה היום" : `לפני ${days} ימים`} · רצף נוכחי: ${streakCount} · ${contacted ? "נוצר קשר" : "טרם נוצר קשר"}</div>
        </div>
      </div>
      <div class="chip-row">
        <button class="chip-btn" data-community-action="coach-welcome-member" data-id="${esc(m.id)}"${busy ? " disabled" : ""}>ברכה</button>
        <button class="chip-btn" data-community-action="view-profile" data-id="${esc(m.id)}">צפייה בפרופיל</button>
        ${m.assigned_coach_id
          ? `<button class="chip-btn" data-community-action="coach-assign-clear" data-id="${esc(m.id)}"${busy ? " disabled" : ""}>ביטול שיוך מאמן/ת</button>`
          : `<button class="chip-btn" data-community-action="coach-assign-self" data-id="${esc(m.id)}"${busy ? " disabled" : ""}>שיוך אליי</button>`}
        <button class="chip-btn${contacted ? "" : " primary"}" data-community-action="coach-mark-contacted" data-id="${esc(m.id)}"${busy ? " disabled" : ""}>סימון כנוצר קשר</button>
      </div>
      ${!m.assigned_coach_id ? `<div class="flex gap-6" style="align-items:center;">
        <input class="text-input" style="max-width:160px;" placeholder="שם משתמש מאמן/ת אחר/ת" dir="ltr" data-coach-assign-handle="${esc(m.id)}" value="${esc(assignDraft)}"/>
        <button class="chip-btn" data-community-action="coach-assign-handle" data-id="${esc(m.id)}"${busy ? " disabled" : ""}>שיוך</button>
      </div>` : ""}
      <input class="text-input" placeholder="הערה קצרה לגבי הקשר (אופציונלי)" data-coach-contact-note="${esc(m.id)}" value="${esc(contactDraft)}"/>
    </div>`;
  }
  function renderCoachWelcomeSection() {
    const w = state.coach.welcome;
    const body = (w.loading && !w.loaded)
      ? `<div aria-busy="true">${`<div class="chart-card" style="height:56px;background:var(--border);opacity:.35;margin-bottom:10px;"></div>`.repeat(2)}</div>`
      : w.error
      ? `<div class="empty">לא ניתן היה לבצע את הפעולה. נסו שוב.<div class="chip-row" style="justify-content:center;"><button class="chip-btn" data-community-action="coach-welcome-retry">ניסיון חוזר</button></div></div>`
      : w.members.length ? `<div class="log-list">${w.members.map(renderCoachWelcomeRow).join("")}</div>` : `<div class="empty">אין חברים חדשים בחודש האחרון.</div>`;
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--green)", "קבלת פנים")}${body}</div>`;
  }
  // ---- Member of the Week (COMM-315) ---------------------------------------
  // Category-shaped detail text, one branch per member_of_week_candidate_set()
  // shape (contracts.md pins these three: {streak_weeks, rank}, {pr_count},
  // {completions, titles}) - never a raw JSON dump, the same "translate the
  // shape, don't print it" rule ENGAGE_LEVEL_LABELS already applies to the
  // level enum above.
  function memberOfWeekCandidateDetailText(category, detail) {
    const d = detail || {};
    if (category === "consistency_streak") return `רצף של ${Number(d.streak_weeks) || 0} שבועות · דירוג #${d.rank != null ? esc(d.rank) : "?"}`;
    if (category === "most_prs") return `${Number(d.pr_count) || 0} שיאים אישיים השבוע`;
    if (category === "challenge_completion") {
      const titles = Array.isArray(d.titles) ? d.titles.filter(Boolean).join(", ") : "";
      return `${Number(d.completions) || 0} השלמות אתגר${titles ? `: ${titles}` : ""}`;
    }
    return "";
  }
  function renderMemberOfWeekCandidate(c, category) {
    const busy = state.coach.memberOfWeek.busy === c.user_id;
    return `<div class="log-row" style="align-items:flex-start;flex-direction:column;gap:8px;">
      <div class="flex gap-10" style="align-items:center;">
        ${avatarHtml(c.display_name || c.handle, 32, c.avatar_url)}
        <div>
          <button class="link-btn" data-community-action="view-profile" data-id="${esc(c.user_id)}" style="padding:0;font-weight:800;color:inherit;">${nameHtml(c.display_name, c.handle)}</button>
          <div style="color:var(--steel);font-size:12px;">${esc(memberOfWeekCandidateDetailText(category, c.detail))}</div>
        </div>
      </div>
      <button class="chip-btn primary" data-community-action="coach-mow-publish-candidate" data-id="${esc(c.user_id)}"${state.coach.memberOfWeek.busy ? " disabled" : ""}>${busy ? "מפרסמ/ת…" : "פרסום"}</button>
    </div>`;
  }
  // The free-selection ("coach's pick") form. Rendered whenever the week is
  // not yet published - alongside the computed candidates when the category
  // has any (COMM-315's own "Populated" frontend state names both the
  // suggestion list and this form together), alongside the empty message
  // when it does not (the ticket's own "staff can fall back to coach's pick"
  // empty state), and alone for the coachs_pick week itself (candidates is
  // always [] there by definition, so there is nothing to show beside it).
  // previous_week_user_id is named here, not merely disabled, because the
  // input is a free-text handle rather than a picker with real options to
  // greyed-out one of - so the greying out COMM-315's schema comments ask
  // for is expressed as a visible warning naming the ineligible member.
  function renderMemberOfWeekPickForm(env) {
    const s = state.coach.memberOfWeek;
    const busy = s.busy === "pick";
    const anyBusy = !!s.busy;
    const prevId = env.previous_week_user_id;
    const prevProfile = s.previousProfile;
    const prevName = prevProfile ? (prevProfile.display_name || "@" + prevProfile.handle) : "חבר/ה";
    const prevNote = prevId ? `<div class="footer-note" style="margin-top:4px;">לא ניתן לבחור שוב ב${esc(prevName)} — נבחר/ה כבר בשבוע שעבר.</div>` : "";
    return `<div class="chart-card" style="margin-top:8px;">
      <div class="field-label" style="margin-bottom:6px;">בחירת מאמן/ת</div>
      <label class="field"><span class="field-label">שם משתמש</span><input class="text-input" dir="ltr" placeholder="שם משתמש" data-mow-pick-handle value="${esc(s.pickHandle)}"${anyBusy ? " disabled" : ""}/></label>
      <label class="field"><span class="field-label">סיבה (חובה)</span><textarea class="text-input" rows="3" maxlength="500" data-mow-pick-reason placeholder="למה החבר/ה הזה/הזאת נבחר/ה השבוע"${anyBusy ? " disabled" : ""}>${esc(s.pickReason)}</textarea></label>
      <div data-mow-pick-counter style="text-align:left;font-size:11px;color:var(--steel);min-height:14px;">${s.pickReason.length}/500</div>
      ${s.publishErr ? `<div class="field-error" role="alert">${esc(s.publishErr)}</div>` : ""}
      ${prevNote}
      <button class="chip-btn primary" data-community-action="coach-mow-publish-pick"${anyBusy ? " disabled" : ""}>${busy ? "מפרסמ/ת…" : "פרסום בחירת המאמן/ת"}</button>
    </div>`;
  }
  // Once published is non-null the publish action is spent for the week -
  // this replaces the suggestion UI entirely rather than sitting beside it
  // (COMM-315's own "shows what/who was published instead" instruction).
  function renderMemberOfWeekPublished(env) {
    const pub = env.published;
    const p = state.coach.memberOfWeek.publishedProfile;
    const name = p ? (p.display_name || "@" + p.handle) : "חבר/ה";
    return `<div class="chart-card" style="margin-top:8px;">
      <div class="flex gap-10" style="align-items:center;">
        ${avatarHtml(p && (p.display_name || p.handle), 36, p && p.avatar_url)}
        <div>
          <button class="link-btn" data-community-action="view-profile" data-id="${esc(pub.user_id)}" style="padding:0;font-weight:800;color:inherit;">${esc(name)}</button>
          <div style="color:var(--steel);font-size:12px;">${esc(env.category_label)}</div>
        </div>
      </div>
      ${pub.reason ? `<div style="margin-top:8px;white-space:pre-wrap;">${esc(pub.reason)}</div>` : ""}
      <div style="color:var(--steel);font-size:11px;margin-top:6px;">פורסם ${relativeTime(pub.published_at)}</div>
    </div>`;
  }
  function renderCoachMemberOfWeekSection() {
    const s = state.coach.memberOfWeek;
    const head = sectionHead("var(--brass)", s.envelope ? `חבר/ת השבוע · ${esc(s.envelope.category_label)}` : "חבר/ת השבוע");
    if (s.loading && !s.loaded) {
      return `<div class="ach-section" style="margin-top:18px;">${head}<div aria-busy="true"><div class="chart-card" style="height:64px;background:var(--border);opacity:.35;"></div></div></div>`;
    }
    if (s.error || !s.envelope) {
      return `<div class="ach-section" style="margin-top:18px;">${head}<div class="empty">לא ניתן היה לטעון את המועמדים.<div class="chip-row" style="justify-content:center;"><button class="chip-btn" data-community-action="coach-mow-retry">ניסיון חוזר</button></div></div></div>`;
    }
    const env = s.envelope;
    let body;
    if (env.published) {
      body = renderMemberOfWeekPublished(env);
    } else if (env.free_selection) {
      body = renderMemberOfWeekPickForm(env);
    } else if (env.candidates && env.candidates.length) {
      body = `<div class="log-list">${env.candidates.map((c) => renderMemberOfWeekCandidate(c, env.category)).join("")}</div>${renderMemberOfWeekPickForm(env)}`;
    } else {
      body = `<div class="empty">אין מועמדים השבוע לקטגוריה זו</div>${renderMemberOfWeekPickForm(env)}`;
    }
    return `<div class="ach-section" style="margin-top:18px;">${head}${body}</div>`;
  }
  // ---- Monthly club recap (COMM-309) ----------------------------------------
  // The five aggregate figures, shared verbatim between the staff preview
  // (draft or published) and the member-facing card (published only) - same
  // shape, same labels, same order the migration lists them in. No member
  // name, handle or per-member figure anywhere in this row by table design
  // (monthly_club_recaps has no user_id column at all), so nothing here has
  // to filter anything out - rendering exactly what came back is already
  // aggregate-only.
  function renderMonthlyRecapFigures(r) {
    return `<div class="log-list">
      <div class="log-row"><span>אימונים שנרשמו</span><span class="mono" style="color:var(--brass);">${esc(r.sessions_logged)}</span></div>
      <div class="log-row"><span>פוסטים</span><span class="mono" style="color:var(--brass);">${esc(r.posts_created)}</span></div>
      <div class="log-row"><span>חברים חדשים</span><span class="mono" style="color:var(--brass);">${esc(r.new_members)}</span></div>
      <div class="log-row"><span>אתגרים שהושלמו</span><span class="mono" style="color:var(--brass);">${esc(r.challenges_completed)}</span></div>
      <div class="log-row"><span>אירועים שהתקיימו</span><span class="mono" style="color:var(--brass);">${esc(r.events_held)}</span></div>
    </div>`;
  }
  // The Coach Dashboard's sixth section: the staff preview + publish
  // control. Frontend states, in order, exactly as COMM-309 names them:
  // loading (skeleton, same shape renderCoachMemberOfWeekSection's own
  // skeleton uses), error ("לא ניתן היה לטעון את התקציר לתצוגה מקדימה." -
  // COMM-309's own copy, verbatim), no-row-yet (an honest empty state - see
  // loadCoachMonthlyRecap's own comment on why null is a real, expected
  // state here and not a load failure, since there is no scheduler yet),
  // populated-draft (figures + a gated "פרסם" control) and
  // populated-published (figures, read-only, no control at all - COMM-309's
  // own "a published recap cannot be un-published or edited").
  //
  // THE PERMISSION GATE. canPublish combines hasPerm(PERM.ANALYTICS_VIEW)
  // and isAdmin() with the same OR the moderation queue already uses for
  // its own two-permission gates (hasPerm(PERM.COMMENT_MODERATE) ||
  // isAdmin(), see loadModQueue/renderModQueue) - not a new mechanism, just
  // this ticket's own pair. It is the exact pair
  // recap_monthly_publish() itself requires server-side
  // (`has_perm('community.analytics.view') or is_admin()`). Deliberately
  // NOT isStaff(): the migration's own long comment on
  // monthly_club_recaps_staff_select spells out that a coach may PREVIEW a
  // draft (is_staff() is enough for the read policy) but may NOT publish
  // one (the function's check is narrower) - gating the button on
  // isStaff() would show a coach a control the database refuses.
  function renderCoachMonthlyRecapSection() {
    const s = state.coach.monthlyRecap;
    const head = sectionHead("var(--purple)", "סיכום חודשי למועדון");
    if (s.loading && !s.loaded) {
      return `<div class="ach-section" style="margin-top:18px;">${head}<div aria-busy="true"><div class="chart-card" style="height:120px;background:var(--border);opacity:.35;"></div></div></div>`;
    }
    if (s.error) {
      return `<div class="ach-section" style="margin-top:18px;">${head}<div class="empty">לא ניתן היה לטעון את התקציר לתצוגה מקדימה.<div class="chip-row" style="justify-content:center;"><button class="chip-btn" data-community-action="coach-monthly-recap-retry">ניסיון חוזר</button></div></div></div>`;
    }
    if (!s.row) {
      // No scheduler is built (the migration's own note): a draft only
      // exists once someone has run recap_monthly_generate() by hand, so a
      // clean "nothing yet" is a real state, not an error.
      return `<div class="ach-section" style="margin-top:18px;">${head}<div class="empty">עדיין לא נוצר תקציר חודשי.</div></div>`;
    }
    const r = s.row;
    const canPublish = hasPerm(PERM.ANALYTICS_VIEW) || isAdmin();
    const busy = s.busy === r.id;
    let control;
    if (r.published_at) {
      control = `<div style="color:var(--steel);font-size:11px;margin-top:8px;">פורסם ${relativeTime(r.published_at)}</div>`;
    } else if (canPublish) {
      control = `<div class="chip-row" style="margin-top:8px;"><button class="chip-btn primary" data-community-action="coach-monthly-recap-publish" data-id="${esc(r.id)}"${s.busy ? " disabled" : ""}>${busy ? "מפרסמ/ת…" : "פרסום"}</button></div>${s.publishErr ? `<div class="field-error" role="alert">${esc(s.publishErr)}</div>` : ""}`;
    } else {
      // A coach previewing a draft, per the asymmetry above - named rather
      // than simply omitted, so a coach understands why there is no button
      // rather than wondering if the draft is broken.
      control = `<div class="footer-note" style="margin-top:8px;">רק בעל/ת הרשאת אנליטיקה או מנהל/ת יכול/ה לפרסם.</div>`;
    }
    return `<div class="ach-section" style="margin-top:18px;">${head}<div class="chart-card"><div class="field-label" style="margin-bottom:6px;">${esc(r.month_start)}${r.published_at ? "" : " · טיוטה"}</div>${renderMonthlyRecapFigures(r)}${control}</div></div>`;
  }
  // The member-facing surface: an inline Account-tab card, sibling to the
  // COMM-221 "View Week" entry (recapEntry in the tab builder below), not a
  // new nav destination and not a dialog - there is one club-wide row to
  // show, not a per-member history to browse. Renders nothing at all - not
  // a skeleton, not an empty-state card - until state.recaps.monthly.row is
  // actually populated: COMM-309's own "Empty (member view)" frontend state
  // is explicit that the surface simply does not show a monthly recap entry
  // before a month is published, and loadMonthlyRecap's own query already
  // guarantees row is only ever a published row.
  function renderMonthlyRecapMemberSection() {
    const r = state.recaps.monthly.row;
    if (!r) return "";
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--purple)", "סיכום החודש של הקהילה")}<div class="chart-card"><div class="field-label" style="margin-bottom:6px;">${esc(r.month_start)}</div>${renderMonthlyRecapFigures(r)}</div></div>`;
  }
  // COMM-226 built this absent entirely (not merely styled hidden) unless
  // the flag is on; COMM-304 flips that flag default-on and gives it real
  // rows, but the same absent-when-off gate stays exactly as it was, for
  // whichever future ticket needs to turn it back off again.
  function renderCoachEngageRow(it) {
    const busy = !!(state.coach.engage.busy && state.coach.engage.busy.id === it.id);
    const reachBusy = busy && state.coach.engage.busy.action === "reach-out";
    const reached = !!state.coach.engage.reachedOut[it.id];
    const name = engageMemberName(it.user_id);
    const prof = state.coach.engage.profiles[it.user_id];
    return `<div class="log-row" style="align-items:flex-start;flex-direction:column;gap:8px;">
      <div class="flex gap-10" style="align-items:center;">
        ${avatarHtml(prof && (prof.display_name || prof.handle), 32, prof && prof.avatar_url)}
        <div>
          <button class="link-btn" data-community-action="view-profile" data-id="${esc(it.user_id)}" style="padding:0;font-weight:800;color:inherit;">${esc(name)}</button>
          <div style="margin-top:2px;"><span class="admin-tag" style="background:${engageLevelColor(it.level)};">${esc(engageLevelLabel(it.level))}</span></div>
        </div>
      </div>
      <div class="chip-row">
        <button class="chip-btn${reached ? "" : " primary"}" data-community-action="coach-engage-reach-out" data-id="${esc(it.id)}"${reached || busy ? " disabled" : ""}>${reachBusy ? "שולח…" : reached ? "פנייה נשלחה" : "פנייה"}</button>
        <button class="chip-btn" data-community-action="coach-engage-review" data-id="${esc(it.id)}"${busy ? " disabled" : ""}>סימון כנבדק</button>
        <button class="chip-btn" data-community-action="coach-engage-dismiss" data-id="${esc(it.id)}"${busy ? " disabled" : ""}>דחייה</button>
      </div>
    </div>`;
  }
  function renderCoachEngageSection() {
    if (!state.featureFlags.coachEngage) return "";
    const e = state.coach.engage;
    const body = (e.loading && !e.loaded)
      ? `<div aria-busy="true"><div class="log-row" style="height:40px;background:var(--border);opacity:.35;"></div></div>`
      : e.error
      ? `<div class="empty">לא ניתן היה לטעון את הנתונים.<div class="chip-row" style="justify-content:center;"><button class="chip-btn" data-community-action="coach-engage-retry">ניסיון חוזר</button></div></div>`
      : e.items.length
      ? `<div class="log-list">${e.items.map(renderCoachEngageRow).join("")}</div>`
      : `<div class="empty">אין חברים שדורשים תשומת לב</div>`;
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--red)", "מעקב מעורבות")}${body}</div>`;
  }
  function renderCoachTab() {
    return renderCoachCelebrateSection() + renderCoachMemberOfWeekSection() + renderCoachWelcomeSection() + renderChallengesListSection() + renderCoachEngageSection() + renderCoachMonthlyRecapSection();
  }

  // ---- Rendering: create/edit form (COMM-201) ------------------------------
  function renderChallengeForm() {
    const f = state.challenges.form;
    const typePicker = `<div class="chip-row" role="group" aria-label="סוג אתגר" style="margin-bottom:10px;">${CHALLENGE_TYPES.map((t) => `<button type="button" class="chip-btn${f.challengeType === t.id ? " selected" : ""}" data-community-action="challenge-form-type" data-type="${t.id}"${f.mode === "edit" ? " disabled" : ""}>${t.icon} ${esc(t.label)}</button>`).join("")}</div>`;
    const typeFields = f.challengeType === "coach" ? `
        ${field("communityChallengeForm", "rulesText", "חוקי האתגר", `<textarea class="text-input" name="rulesText" maxlength="1000" required>${esc(f.rulesText)}</textarea>`)}
        ${field("communityChallengeForm", "metricLabel", "יחידת מדידה (לתצוגה)", `<input class="text-input" name="metricLabel" value="${esc(f.metricLabel)}" placeholder="למשל בורפיז"/>`)}`
      : f.challengeType === "consistency" ? `
        <div class="flex gap-16 field">
          ${field("communityChallengeForm", "timesPerWeek", "אימונים בשבוע", `<input class="text-input" name="timesPerWeek" type="number" min="1" value="${esc(f.timesPerWeek)}" required/>`)}
          ${field("communityChallengeForm", "weeks", "מספר שבועות", `<input class="text-input" name="weeks" type="number" min="1" value="${esc(f.weeks)}" required/>`)}
        </div>`
      : (f.challengeType === "team" && f.mode === "create") ? `
        ${field("communityChallengeForm", "teamNames", "שמות הקבוצות (שורה לכל קבוצה)", `<textarea class="text-input" name="teamNames" placeholder="קבוצת בוקר&#10;קבוצת ערב">${esc(f.teamNames)}</textarea>`)}
        <label class="field flex gap-6" style="align-items:center;"><input type="checkbox" name="teamAuto"/><span style="font-size:12.5px;color:var(--steel);">שיבוץ אוטומטי לקבוצה עם פחות משתתפים</span></label>`
      : "";
    const showTarget = f.challengeType !== "coach";
    return `<form id="communityChallengeForm" class="chart-card admin-card" style="margin-top:10px;">
      <div style="font-weight:800;margin-bottom:10px;">${f.mode === "edit" ? "עריכת אתגר" : "אתגר חדש"}<span class="admin-tag">ניהול</span></div>
      ${typePicker}
      ${field("communityChallengeForm", "title", "שם האתגר", `<input class="text-input" name="title" value="${esc(f.title)}" maxlength="120" required/>`)}
      ${field("communityChallengeForm", "description", "תיאור", `<textarea class="text-input" name="description" maxlength="2000">${esc(f.description)}</textarea>`)}
      ${field("communityChallengeForm", "metricType", "מדד", `<input class="text-input" name="metricType" value="${esc(f.metricType)}" placeholder="למשל session_count" required/>`)}
      ${showTarget ? field("communityChallengeForm", "targetValue", "יעד", `<input class="text-input" name="targetValue" type="number" step="any" value="${esc(f.targetValue)}"/>`) : ""}
      <div class="flex gap-16 field">
        ${field("communityChallengeForm", "startAt", "תאריך התחלה", `<input class="text-input" name="startAt" type="date" value="${esc(f.startAt)}" required/>`)}
        ${field("communityChallengeForm", "endAt", "תאריך סיום", `<input class="text-input" name="endAt" type="date" value="${esc(f.endAt)}" required/>`)}
      </div>
      ${typeFields}
      ${f.mode === "create" ? `<label class="field flex gap-6" style="align-items:center;"><input type="checkbox" name="publishNow"/><span style="font-size:12.5px;color:var(--steel);">פרסום מיידי (אחרת יישמר כטיוטה)</span></label>` : ""}
      ${f.error ? `<div class="field-error" role="alert">${esc(f.error)}</div>` : ""}
      <div class="chip-row" style="margin-top:10px;">
        <button class="chip-btn primary" type="submit"${f.saving ? " disabled" : ""}>${f.saving ? "שומר…" : "שמירה"}</button>
        <button class="chip-btn" type="button" data-community-action="challenge-form-cancel">ביטול</button>
        ${f.mode === "edit" && f.status === "draft" ? `<button class="chip-btn" type="button" data-community-action="challenge-publish" data-id="${esc(f.id)}">פרסום</button>` : ""}
        ${f.mode === "edit" && f.status === "draft" ? `<button class="chip-btn danger" type="button" data-community-action="challenge-delete" data-id="${esc(f.id)}">מחיקת טיוטה</button>` : ""}
        ${f.mode === "edit" && (f.status === "active" || f.status === "completed") ? `<button class="chip-btn" type="button" data-community-action="challenge-archive" data-id="${esc(f.id)}">העברה לארכיון</button>` : ""}
      </div>
    </form>`;
  }

  // ---- Rendering: detail dialog (COMM-202..207) ----------------------------
  function renderChallengeActions(v) {
    const c = v.challenge;
    if (c.status === "completed" || c.status === "archived") return "";
    if (c.status === "draft") return `<div class="footer-note" style="margin-bottom:10px;">האתגר עדיין בטיוטה ואינו פתוח להצטרפות.</div>`;
    if (v.myParticipant) {
      return `<div class="chip-row" style="margin-bottom:10px;"><button class="chip-btn" data-community-action="leave-challenge" data-id="${esc(c.id)}"${v.leaving ? " disabled" : ""}>${v.leaving ? "עוזב/ת…" : "עזיבת האתגר"}</button></div>`;
    }
    return `<div class="chip-row" style="margin-bottom:10px;"><button class="chip-btn primary" data-community-action="join-challenge" data-id="${esc(c.id)}"${v.joining ? " disabled" : ""}>${v.joining ? "מצטרפ/ת…" : "הצטרפות לאתגר"}</button></div>`;
  }
  function renderChallengeLogForm(v) {
    const lf = v.logForm;
    return `<div class="chart-card" style="margin-bottom:10px;">
      <div class="field-label" style="margin-bottom:6px;">עדכון התקדמות</div>
      <div class="flex gap-10" style="align-items:flex-end;">
        <label class="field" style="flex:1;margin-bottom:0;"><span class="field-label">כמות</span><input class="text-input" type="number" step="any" data-challenge-log-delta value="${esc(lf.delta)}"/></label>
        <button class="chip-btn primary" data-community-action="challenge-log-submit"${lf.busy ? " disabled" : ""}>${lf.busy ? "שומר…" : "עדכון"}</button>
      </div>
      ${lf.error ? `<div class="field-error" role="alert" style="margin-top:6px;">${esc(lf.error)}</div>` : ""}
    </div>`;
  }
  function renderMyChallengeProgress(v) {
    const c = v.challenge, part = v.myParticipant;
    if (!part || c.challenge_type === "cooperative" || c.challenge_type === "team" || c.challenge_type === "consistency") return "";
    const completed = part.status === "completed";
    const pct = c.target_value ? (Number(part.progress_value || 0) / c.target_value) * 100 : null;
    return `<div class="chart-card" style="margin-bottom:10px;">
      <div class="field-label" style="margin-bottom:4px;">ההתקדמות שלי</div>
      ${part.progress_value ? `<div class="mono" style="color:var(--brass);font-size:16px;">${esc(part.progress_value)}${c.target_value != null ? ` / ${esc(c.target_value)}` : ""}</div>` : `<div class="empty">עדיין לא נרשמה התקדמות.</div>`}
      ${pct != null ? challengeProgressBarHtml(pct) : ""}
      ${completed ? `<div style="color:var(--brass);font-weight:800;margin-top:6px;">האתגר הושלם 🎉</div>` : ""}
    </div>${(!completed && c.challenge_type !== "coach") ? renderChallengeLogForm(v) : ""}`;
  }
  function renderCooperativePanel(v) {
    const c = v.challenge, p = v.progress || {};
    if (p.club_total == null) return `<div class="empty">לא ניתן היה לטעון את התקדמות האתגר.</div>`;
    const pct = c.target_value ? (p.club_total / c.target_value) * 100 : 0;
    const days = daysRemaining(c.end_at);
    const contributors = v.contributors || [];
    const contributorsHtml = contributors.length
      ? `<div class="log-list" style="margin-top:8px;">${contributors.map((row) => {
          const prof = row.profiles || {};
          const name = prof.display_name || (prof.handle ? "@" + prof.handle : "חבר/ה");
          return `<div class="log-row"><span>${esc(name)}</span><span class="mono" style="color:var(--brass);">+${esc(row.delta)}</span></div>`;
        }).join("")}</div>`
      : `<div class="empty">עדיין לא נאספה התקדמות משותפת.</div>`;
    return `<div class="chart-card" style="margin-bottom:10px;">
      <div class="field-label" style="margin-bottom:4px;">התקדמות המועדון</div>
      <div class="mono" style="color:var(--brass);font-size:18px;">${esc(p.club_total)}${c.target_value != null ? ` / ${esc(c.target_value)}` : ""}</div>
      ${challengeProgressBarHtml(pct)}
      <div style="color:var(--steel);font-size:12px;margin-top:4px;">${Math.round(Math.min(100, pct))}% מהיעד${days != null ? ` · ${days} ימים נותרו` : ""}</div>
      <div class="field-label" style="margin:10px 0 4px;">תורמים אחרונים</div>
      ${contributorsHtml}
    </div>${v.myParticipant ? renderChallengeLogForm(v) : ""}`;
  }
  // COMM-308. Loading skeleton for just the team-management block - not the
  // whole dialog, which already has its own ("טוען את האתגר…") for the very
  // first open. Shown only while refreshAfterTeamMgmt() is re-reading the
  // detail after a mutation this block itself made.
  function challengeTeamMgmtSkeletonHtml() {
    const row = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:60%;background:var(--border);border-radius:6px;display:inline-block;"></span><span style="height:12px;width:20%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
    return `<div class="chart-card" style="margin-bottom:10px;" data-team-mgmt="1">
      <div class="field-label" style="margin-bottom:6px;">ניהול קבוצות</div>
      <div class="log-list" aria-busy="true" data-team-mgmt-skeleton="1">${row.repeat(3)}</div>
    </div>`;
  }
  // COMM-308. A community.challenge.create holder's team-management block:
  // rename/delete each existing team, create a new one, set/clear a captain
  // per team, and reassign any active participant to another team (or to no
  // team at all). Entirely separate markup from the member-visible columns
  // renderTeamPanel already builds above - so a plain member's view (the
  // ONLY thing COMM-204 shipped) is untouched byte-for-byte, exactly what
  // this ticket's "a plain member's view is unchanged from COMM-204" line
  // asks for. Never called for a non-holder (renderTeamPanel gates the call).
  function renderTeamManagementPanel(v) {
    const tm = v.teamMgmt;
    if (tm.loading) return challengeTeamMgmtSkeletonHtml();
    const rawTeams = v.teams || [];
    const totalsByTeam = {};
    (Array.isArray(v.progress && v.progress.team_totals) ? v.progress.team_totals : []).forEach((t) => { totalsByTeam[t.team_id] = t.total; });
    const activeParticipants = (v.participants || []).filter((p) => p.status !== "withdrawn");
    const countByTeam = {};
    for (const p of activeParticipants) if (p.team_id) countByTeam[p.team_id] = (countByTeam[p.team_id] || 0) + 1;

    const teamRows = rawTeams.map((t) => {
      const memberCount = countByTeam[t.id] || 0;
      const total = totalsByTeam[t.id] != null ? totalsByTeam[t.id] : 0;
      const teamMembers = activeParticipants.filter((p) => p.team_id === t.id);
      const captain = t.captain_id ? teamMembers.find((p) => p.user_id === t.captain_id) : null;
      const captainProf = captain ? (captain.profiles || {}) : null;
      const captainName = captainProf ? (captainProf.display_name || (captainProf.handle ? "@" + captainProf.handle : "חבר/ה")) : null;
      const captainOptions = `<option value="">ללא קפטן/ית</option>` + teamMembers.map((p) => {
        const prof = p.profiles || {};
        const name = prof.display_name || (prof.handle ? "@" + prof.handle : "חבר/ה");
        return `<option value="${esc(p.user_id)}"${t.captain_id === p.user_id ? " selected" : ""}>${esc(name)}</option>`;
      }).join("");
      const renameBusy = !!tm.renameBusy[t.id], deleteBusy = !!tm.deleteBusy[t.id], captainBusy = !!tm.captainBusy[t.id];
      const nameValue = tm.renameDrafts[t.id] != null ? tm.renameDrafts[t.id] : t.name;
      return `<div class="log-row" style="flex-direction:column;align-items:stretch;gap:6px;" data-team-mgmt-row="${esc(t.id)}">
        <div class="flex gap-6" style="align-items:center;">
          <input class="text-input" type="text" data-challenge-team-rename-name="${esc(t.id)}" value="${esc(nameValue)}" maxlength="80" style="flex:1;" aria-label="שם הקבוצה"/>
          <button class="chip-btn" data-community-action="challenge-team-rename" data-id="${esc(t.id)}"${renameBusy ? " disabled" : ""}>${renameBusy ? "שומר…" : "שמירה"}</button>
          <button class="chip-btn" data-community-action="challenge-team-delete" data-id="${esc(t.id)}"${(deleteBusy || memberCount > 0) ? " disabled" : ""}${memberCount > 0 ? ` title="יש לפנות את הקבוצה מחברים לפני מחיקתה"` : ""}>${deleteBusy ? "מוחק…" : "מחיקה"}</button>
        </div>
        <div style="font-size:12px;color:var(--steel);">${memberCount} משתתפים · ${esc(total)} סה״כ${captainName ? ` · 👑 ${esc(captainName)}` : ""}</div>
        <div class="flex gap-6" style="align-items:center;">
          <select class="text-input" data-challenge-team-captain-select="${esc(t.id)}" style="flex:1;"${(captainBusy || !teamMembers.length) ? " disabled" : ""} aria-label="קפטן/ית הקבוצה">${captainOptions}</select>
        </div>
      </div>`;
    }).join("");

    const reassignHtml = rawTeams.length ? `<div style="margin-top:10px;">
      <div class="field-label" style="margin-bottom:6px;">העברת משתתפים בין קבוצות</div>
      <div class="log-list">${activeParticipants.map((p) => {
        const prof = p.profiles || {};
        const name = prof.display_name || (prof.handle ? "@" + prof.handle : "חבר/ה");
        const busy = !!tm.reassignBusy[p.user_id];
        const options = `<option value="">ללא קבוצה</option>` + rawTeams.map((t) => `<option value="${esc(t.id)}"${p.team_id === t.id ? " selected" : ""}>${esc(t.name)}</option>`).join("");
        return `<div class="log-row" style="justify-content:space-between;gap:8px;">
          <span>${esc(name)}</span>
          <select class="text-input" data-challenge-team-reassign-select="${esc(p.user_id)}"${busy ? " disabled" : ""} style="max-width:160px;" aria-label="קבוצה של ${esc(name)}">${options}</select>
        </div>`;
      }).join("")}</div>
    </div>` : "";

    return `<div class="chart-card" style="margin-bottom:10px;" data-team-mgmt="1">
      <div class="field-label" style="margin-bottom:6px;">ניהול קבוצות<span class="admin-tag">ניהול</span></div>
      ${teamRows ? `<div class="log-list">${teamRows}</div>` : ""}
      <div class="flex gap-6" style="align-items:flex-end;margin-top:8px;">
        <label class="field" style="flex:1;margin-bottom:0;"><span class="field-label">קבוצה חדשה</span><input class="text-input" type="text" data-challenge-team-create-name value="${esc(tm.createName)}" maxlength="80"/></label>
        <button class="chip-btn primary" data-community-action="challenge-team-create"${tm.createBusy ? " disabled" : ""}>${tm.createBusy ? "יוצר…" : "צור קבוצה"}</button>
      </div>
      ${tm.createError ? `<div class="field-error" role="alert" style="margin-top:6px;">${esc(tm.createError)}</div>` : ""}
      ${tm.error ? `<div class="field-error" role="alert" style="margin-top:6px;">${esc(tm.error)}</div>` : ""}
      ${reassignHtml}
    </div>`;
  }
  function renderTeamPanel(v) {
    const c = v.challenge, p = v.progress || {};
    const teams = Array.isArray(p.team_totals) ? p.team_totals : [];
    const staff = hasPerm(PERM.CHALLENGE_CREATE);
    if (!teams.length) return `<div class="empty">המאמן/ת עדיין לא הגדיר/ה קבוצות.</div>${staff ? renderTeamManagementPanel(v) : ""}`;
    const myTeamId = v.myParticipant && v.myParticipant.team_id;
    const canPick = v.myParticipant && !myTeamId;
    const cols = teams.map((t) => `<div class="chart-card" style="flex:1;min-width:130px;${t.team_id === myTeamId ? "border-color:var(--energy);" : ""}">
        <div style="font-weight:800;font-size:13px;">${esc(t.name)}${t.team_id === myTeamId ? " · הקבוצה שלי" : ""}</div>
        <div class="mono" style="color:var(--brass);font-size:16px;margin-top:4px;">${esc(t.total)}</div>
        ${canPick ? `<button class="chip-btn" data-community-action="challenge-pick-team" data-id="${esc(c.id)}" data-team="${esc(t.team_id)}"${v.teamJoining === t.team_id ? " disabled" : ""} style="margin-top:6px;">${v.teamJoining === t.team_id ? "מצטרפ/ת…" : "הצטרפות לקבוצה"}</button>` : ""}
      </div>`).join("");
    return `<div class="flex gap-10" style="flex-wrap:wrap;margin-bottom:10px;">${cols}</div>${staff ? renderTeamManagementPanel(v) : ""}${(v.myParticipant && myTeamId) ? renderChallengeLogForm(v) : ""}`;
  }
  function renderConsistencyPanel(v) {
    const c = v.challenge, part = v.myParticipant;
    const weeks = Number((c.config && c.config.weeks) || 0);
    const timesPerWeek = Number((c.config && c.config.times_per_week) || 0);
    if (!part) return `<div style="color:var(--steel);font-size:12px;margin-bottom:10px;">${weeks} שבועות · ${timesPerWeek} אימונים בשבוע</div>`;
    const hit = Number(part.progress_value || 0);
    const boxes = Array.from({ length: weeks }, (_, i) => `<span aria-hidden="true" style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;margin:2px;font-size:11px;font-weight:800;${i < hit ? "background:var(--brass);color:#0c0c0c;" : "background:var(--border);color:var(--steel);"}">${i + 1}</span>`).join("");
    const emptyMsg = hit === 0 ? `<div class="empty">השבוע הראשון בעיצומו.</div>` : "";
    const completeMsg = part.status === "completed" ? `<div style="color:var(--brass);font-weight:800;margin-top:6px;">האתגר הושלם 🎉</div>` : "";
    return `<div class="chart-card" style="margin-bottom:10px;">
      <div class="field-label" style="margin-bottom:6px;">${hit} מתוך ${weeks} שבועות · ${timesPerWeek} אימונים בשבוע</div>
      <div>${boxes}</div>
      ${emptyMsg}${completeMsg}
      ${part.status !== "completed" ? `<button class="chip-btn" data-community-action="challenge-log-week-hit" style="margin-top:8px;"${v.logForm.busy ? " disabled" : ""}>${v.logForm.busy ? "שומר…" : "סימון שבוע שהושלם"}</button>` : ""}
      ${v.logForm.error ? `<div class="field-error" role="alert" style="margin-top:6px;">${esc(v.logForm.error)}</div>` : ""}
    </div>`;
  }
  // COMM-211. This panel used to rank chal_progress()'s own simpler
  // `leaderboard` key (202608290003), which numbers rows by array index and
  // applies neither in_leaderboards nor a stable tie-break, and which drops
  // the caller entirely once they are past the twentieth row. It now reads
  // feed_leaderboard(mode='progress') instead - same panel, same slot, same
  // 20-row cap, but the server's rank, the server's privacy filtering and the
  // caller's own row always present. chal_progress's key is left untouched
  // (contracts.md calls widening it an additive follow-up, not a break); this
  // client just no longer reads it. In progress mode a caller who never
  // joined the challenge has no row at all, which is correct: there is no
  // standing in a challenge you did not enter.
  function renderChallengeLeaderboardPanel(v) {
    const b = v.board || { scope: "club", limit: CHALLENGE_BOARD_LIMIT, rows: [], loading: true, error: false };
    const body = renderLeaderboardBody(b, {
      limit: b.limit,
      emptyText: "עדיין אין תוצאות לדירוג.",
      retryAction: "challenge-board-retry",
      formatValue: (r) => esc(r.value),
    });
    const canExpand = !b.loading && !b.error && leaderboardRows(b).length && b.limit < CHALLENGE_BOARD_FULL_LIMIT;
    const expand = canExpand ? `<div class="chip-row" style="margin-top:6px;"><button class="chip-btn" data-community-action="challenge-board-full">צפייה בטבלה המלאה</button></div>` : "";
    return `<div class="chart-card" style="margin-bottom:10px;" data-leaderboard="challenge">
      <div class="field-label" style="margin-bottom:6px;">דירוג${b.limit >= CHALLENGE_BOARD_FULL_LIMIT ? " מלא" : ""}</div>
      ${leaderboardScopeSwitchHtml("challenge-board-scope", b.scope)}
      ${body}${expand}
      ${leaderboardHideToggleHtml()}
    </div>`;
  }
  function renderCoachEntryPanel(v) {
    const active = (v.participants || []).filter((p) => p.status === "active");
    const rosterHtml = active.length ? active.map((p) => {
      const prof = p.profiles || {};
      const name = prof.display_name || (prof.handle ? "@" + prof.handle : "חבר/ה");
      const d = v.coachEntry.drafts[p.user_id] || { delta: "", note: "" };
      const busy = !!v.coachEntry.busy[p.user_id];
      return `<div class="log-row" style="flex-direction:column;align-items:stretch;gap:6px;">
        <div class="flex" style="justify-content:space-between;"><span>${esc(name)}</span><span class="mono" style="color:var(--brass);">${esc(p.progress_value)}</span></div>
        <div class="flex gap-6">
          <input class="text-input" type="number" step="any" data-challenge-coach-delta="${esc(p.user_id)}" value="${esc(d.delta)}" placeholder="כמות" style="flex:1;"/>
          <button class="chip-btn primary" data-community-action="challenge-coach-submit" data-id="${esc(p.user_id)}"${busy ? " disabled" : ""}>${busy ? "שומר…" : "עדכון"}</button>
        </div>
      </div>`;
    }).join("") : `<div class="empty">אף אחד עדיין לא הצטרף לאתגר.</div>`;
    return `<div class="chart-card" style="margin-bottom:10px;">
      <div class="field-label" style="margin-bottom:6px;">עדכון התקדמות משתתפים</div>
      <div class="log-list">${rosterHtml}</div>
      ${v.coachEntry.error ? `<div class="field-error" role="alert" style="margin-top:6px;">${esc(v.coachEntry.error)}</div>` : ""}
    </div>`;
  }
  function renderChallengeParticipants(v) {
    const list = (v.participants || []).filter((p) => p.status !== "withdrawn").slice(0, 30);
    if (!list.length) return "";
    const count = (v.progress && v.progress.participant_count != null) ? v.progress.participant_count : list.length;
    return `<div style="margin-top:12px;">
      <div class="field-label" style="margin-bottom:6px;">משתתפים (${esc(count)})</div>
      <div class="log-list">${list.map((p) => {
        const prof = p.profiles || {};
        const name = prof.display_name || (prof.handle ? "@" + prof.handle : "חבר/ה");
        return `<div class="log-row"><span>${esc(name)}</span>${p.status === "completed" ? `<span class="tag tag-brass">הושלם</span>` : ""}</div>`;
      }).join("")}</div>
    </div>`;
  }
  function renderChallengeViewBody(v) {
    const c = v.challenge;
    const def = challengeTypeDef(c.challenge_type);
    const staff = hasPerm(PERM.CHALLENGE_CREATE);
    const meta = `<div style="color:var(--steel);font-size:12px;margin-bottom:10px;">${esc(def.label)} · ${formatChallengeDate(c.start_at)}–${formatChallengeDate(c.end_at)} · ${esc(challengeStatusLabel(c))}</div>`;
    const description = c.description ? `<div style="font-size:13.5px;line-height:1.6;margin-bottom:10px;white-space:pre-wrap;">${esc(c.description)}</div>` : "";
    const rules = (c.config && c.config.rules_text) ? `<div class="chart-card" style="margin-bottom:10px;"><div class="field-label" style="margin-bottom:4px;">חוקי האתגר</div><div style="font-size:13px;white-space:pre-wrap;">${esc(c.config.rules_text)}</div></div>` : "";
    const staffToolbar = staff ? `<div class="chip-row" style="margin-bottom:10px;"><button class="chip-btn" data-community-action="challenge-edit" data-id="${esc(c.id)}">עריכה</button></div>` : "";
    const myProgress = renderMyChallengeProgress(v);
    const typePanel = c.challenge_type === "cooperative" ? renderCooperativePanel(v)
      : c.challenge_type === "team" ? renderTeamPanel(v)
      : c.challenge_type === "consistency" ? renderConsistencyPanel(v)
      : (c.challenge_type === "individual_performance" || c.challenge_type === "coach") ? renderChallengeLeaderboardPanel(v)
      : "";
    const coachPanel = (c.challenge_type === "coach" && staff) ? renderCoachEntryPanel(v) : "";
    const actions = renderChallengeActions(v);
    const shareBtn = v.myParticipant ? `<div class="chip-row" style="margin-top:8px;"><button class="chip-btn" data-community-action="share-challenge-progress"${v.sharing ? " disabled" : ""}>${v.sharing ? "משתף…" : "שיתוף התקדמות"}</button></div>` : "";
    const participantsHtml = renderChallengeParticipants(v);
    // Comments (COMM-207) reuse the engagement component, which threads off
    // a real post id - the milestone/share POST_CHALLENGE rows the trigger
    // and shareChallengeProgress() write. There is no dedicated companion
    // post created at challenge-creation time (unlike POST_EVENT for
    // events), so there is no single thread to open until one of those
    // exists; a pointer to the feed is what's shown instead. See the
    // handoff notes for the schema follow-up this needs.
    const commentsNote = `<div class="footer-note" style="margin-top:12px;">עדכונים ותגובות על האתגר מופיעים בפיד המועדון בכל שיתוף שקשור אליו.</div>`;
    return `${meta}${staffToolbar}${description}${rules}${actions}${myProgress}${typePanel}${coachPanel}${shareBtn}${participantsHtml}${commentsNote}`;
  }
  function renderChallengeViewOverlay() {
    const v = state.challenges.view;
    if (!v) return "";
    const bodyHtml = v.loading ? `<div class="empty">טוען את האתגר…</div>`
      : (v.error || !v.challenge) ? `<div class="empty">לא ניתן היה לטעון את האתגר. נסו שוב.</div>`
      : renderChallengeViewBody(v);
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="challengeViewTitle" data-cloud-dialog="challengeView" style="align-items:flex-start;padding:20px 12px;">
      <div class="modal-sheet" style="border-radius:20px;max-height:88vh;overflow:auto;width:100%;max-width:560px;">
        <div style="padding:18px 18px calc(env(safe-area-inset-bottom,0px) + 16px);">
          <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div id="challengeViewTitle" style="font-weight:800;font-size:17px;">${v.challenge ? esc(v.challenge.title) : "אתגר"}</div>
            <button class="chip-btn" data-community-action="close-challenge-view" aria-label="סגירה">✕</button>
          </div>
          ${bodyHtml}
        </div>
      </div>
    </div>`;
  }

  // ---- Events (COMM-213..217) ----------------------------------------------
  // Generalizes the COMM-101 fallback (a plain link card pointing nowhere
  // real) into the full events module: Upcoming/Past list, a create/edit
  // form gated on community.event.manage, a detail dialog with
  // server-enforced RSVP (event_rsvp, 202608280010), type badges, a
  // client-built .ics download, and a comment thread that reuses the whole
  // engagement stack through a companion POST_EVENT post - see
  // ensureEventCompanionPost() below and "Needs from schema, events" in
  // docs/community/contracts.md for the design decision.
  const EVENT_TYPES = [
    { id: "workshop", label: "סדנה", icon: "🛠️" },
    { id: "competition", label: "תחרות", icon: "🏆" },
    { id: "social_night", label: "ערב חברתי", icon: "🎉" },
    { id: "outdoor_workout", label: "אימון בחוץ", icon: "🌳" },
    { id: "running_meetup", label: "מפגש ריצה", icon: "🏃" },
    { id: "holiday_event", label: "אירוע חג", icon: "🎊" },
    { id: "seminar", label: "הרצאה", icon: "🎓" },
    { id: "community_event", label: "אירוע קהילתי", icon: "🤝" },
    { id: "other", label: "אחר", icon: "📌" },
  ];
  function eventTypeDef(id) { return EVENT_TYPES.find((t) => t.id === id) || { id, label: id || "", icon: "📅" }; }
  function eventTypeBadge(id) { const d = eventTypeDef(id); return `${d.icon} ${d.label}`; }
  // Deliberately a bare string slice, not a Date().toLocaleString() call:
  // the value already carries no timezone ambiguity worth resolving here
  // (matches formatChallengeDate's same choice) and stays deterministic
  // under test.
  function formatEventDate(iso) { return iso ? String(iso).slice(0, 10) : ""; }
  function formatEventTime(iso) { return iso ? String(iso).slice(11, 16) : ""; }
  function eventStatusLabel(e) { return { draft: "טיוטה", published: "פורסם", cancelled: "בוטל", past: "הסתיים" }[e && e.status] || ""; }
  // Upcoming/Past split (COMM-213): "split on status and start_at" means
  // both together, not either alone - a published event whose start_at has
  // passed reads as Past even though nothing ever flips its status, and a
  // cancelled event always reads as Past regardless of when it was to
  // start, per the ticket's "moves out of Upcoming, stays visible in Past
  // marked cancelled".
  function isUpcomingEvent(e) { return !!e && e.status === "published" && !!e.start_at && new Date(e.start_at).getTime() > Date.now(); }
  function isPastEvent(e) { return !!e && (e.status === "past" || e.status === "cancelled" || (e.status === "published" && !isUpcomingEvent(e))); }
  function eventAttendeeRows(id) { return state.events.attendees[id] || []; }
  // COMM-213/214. Read straight off the event_attendees rows RLS actually
  // handed back for the caller - event_attendees_read (202608280010)
  // already excludes another member's row when they opted out of
  // show_in_attendee_lists, so a going count computed here can undercount
  // relative to the server's own capacity trigger for a plain member. That
  // is an accepted, schema-owned trade-off (informational count vs. the
  // trigger's own authoritative, unfiltered count), not something this
  // cluster papers over.
  function eventGoingCount(id) { return eventAttendeeRows(id).filter((r) => r.response === "going").length; }
  function myEventResponse(id) {
    const row = eventAttendeeRows(id).find((r) => r.user_id === (state.user && state.user.id));
    return row ? row.response : null;
  }
  function eventRegistrationClosed(e) { return !!(e && e.registration_deadline && new Date(e.registration_deadline).getTime() < Date.now()); }
  // A going->going update on a full event stays enabled (COMM-214's
  // idempotence rule): only disable Going for someone who is not already
  // going.
  function eventIsFull(e) { return !!(e && e.capacity != null && eventGoingCount(e.id) >= e.capacity && myEventResponse(e.id) !== "going"); }

  async function loadEvents() {
    if (!state.user) { state.events.items = []; state.events.byId = {}; state.events.attendees = {}; state.events.loaded = false; return; }
    state.events.loading = true;
    rerender();
    const { data, error } = await client.from("events").select("*").order("start_at", { ascending: true });
    if (error) { state.events.loading = false; state.events.error = true; return rerender(); }
    state.events.items = data || [];
    state.events.byId = {};
    for (const e of state.events.items) state.events.byId[e.id] = e;
    state.events.error = false;
    const ids = state.events.items.map((e) => e.id);
    state.events.attendees = {};
    if (ids.length) {
      const { data: rows, error: aErr } = await client.from("event_attendees")
        .select("event_id,user_id,response,registered_at,profiles(display_name,handle,avatar_url)")
        .in("event_id", ids);
      if (!aErr) for (const row of (rows || [])) (state.events.attendees[row.event_id] = state.events.attendees[row.event_id] || []).push(row);
    }
    state.events.loading = false;
    state.events.loaded = true;
    rerender();
  }

  // ---- List (COMM-213) ------------------------------------------------------
  function eventCardImageHtml(e) {
    return e.image_url
      ? `<img src="${esc(e.image_url)}" alt="" style="width:56px;height:56px;border-radius:12px;object-fit:cover;"/>`
      : `<span aria-hidden="true" style="width:56px;height:56px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:24px;background:var(--border);">${eventTypeDef(e.event_type).icon}</span>`;
  }
  function renderEventCard(e) {
    const going = eventGoingCount(e.id);
    const mine = myEventResponse(e.id);
    const cancelled = e.status === "cancelled";
    const meta = [eventTypeBadge(e.event_type), formatEventDate(e.start_at), formatEventTime(e.start_at)];
    if (e.location) meta.push(e.location);
    meta.push(`${going} משתתפים`);
    if (e.status === "draft") meta.push(eventStatusLabel(e));
    if (cancelled) meta.push("בוטל");
    const mineLabel = mine === "going" ? "הולכ/ת" : mine === "interested" ? "מעוניינ/ת" : mine === "not_going" ? "לא הולכ/ת" : "";
    return `<article class="chart-card" data-event-id="${esc(e.id)}" data-event-status="${esc(e.status)}" style="margin-bottom:10px;${cancelled ? "opacity:.7;" : ""}">
      <div class="flex gap-10" style="align-items:flex-start;">
        ${eventCardImageHtml(e)}
        <div style="flex:1;min-width:0;">
          <button class="link-btn" data-community-action="open-event" data-id="${esc(e.id)}" data-source="boards" style="padding:0;text-align:right;font-weight:800;font-size:15px;color:inherit;display:block;">${esc(e.title)}</button>
          <div style="color:var(--steel);font-size:11.5px;margin-top:2px;">${meta.map(esc).join(" · ")}</div>
        </div>
      </div>
      <div class="chip-row" style="margin-top:8px;">
        <button class="chip-btn" data-community-action="open-event" data-id="${esc(e.id)}" data-source="boards">פרטים</button>
        ${mineLabel ? `<span class="tag tag-brass">${mineLabel}</span>` : ""}
      </div>
    </article>`;
  }
  function renderEventsListSection() {
    // COMM-321. Same reasoning as renderChallengesListSection's own guard
    // just above - events_read already returns nothing for anyone, staff
    // included, once this module is off.
    if (!isModuleEnabled("events")) return "";
    const staff = hasPerm(PERM.EVENT_MANAGE);
    const upcoming = state.events.items.filter((e) => isUpcomingEvent(e) || (staff && e.status === "draft"));
    const past = state.events.items.filter(isPastEvent).slice().sort((a, b) => (a.start_at < b.start_at ? 1 : -1));
    const createBtn = staff ? `<button class="chip-btn primary" data-community-action="open-event-form" style="margin-bottom:10px;">אירוע חדש</button>` : "";
    const list = (state.events.loading && !state.events.loaded)
      ? `<div aria-busy="true">${`<div class="chart-card" style="height:64px;background:var(--border);opacity:.35;margin-bottom:10px;"></div>`.repeat(2)}</div>`
      : state.events.error
      ? `<div class="empty">לא ניתן היה לטעון את האירוע. נסו שוב.<div class="chip-row" style="justify-content:center;"><button class="chip-btn" data-community-action="events-retry">ניסיון חוזר</button></div></div>`
      : upcoming.length ? upcoming.map(renderEventCard).join("") : `<div class="empty">אין אירועים קרובים כרגע.</div>`;
    const pastHtml = past.length ? `<div style="margin-top:16px;"><div class="field-label" style="margin-bottom:6px;">אירועים שהסתיימו</div>${past.map(renderEventCard).join("")}</div>` : "";
    return `<div class="ach-section">${sectionHead("var(--blue)", "אירועי המועדון")}${createBtn}${state.events.form ? renderEventForm() : ""}${list}${pastHtml}</div>`;
  }

  // ---- Create/edit form (COMM-213) ------------------------------------------
  function openEventForm(existing) {
    state.events.form = existing ? {
      mode: "edit", id: existing.id, status: existing.status, eventType: existing.event_type,
      title: existing.title, description: existing.description || "",
      imageUrl: existing.image_url || "", location: existing.location || "", mapLink: existing.map_link || "",
      startAt: existing.start_at ? String(existing.start_at).slice(0, 16) : "",
      endAt: existing.end_at ? String(existing.end_at).slice(0, 16) : "",
      capacity: existing.capacity != null ? String(existing.capacity) : "",
      registrationDeadline: existing.registration_deadline ? String(existing.registration_deadline).slice(0, 16) : "",
      saving: false, error: "",
    } : {
      mode: "create", id: null, status: "draft", eventType: "workshop",
      title: "", description: "", imageUrl: "", location: "", mapLink: "",
      startAt: "", endAt: "", capacity: "", registrationDeadline: "",
      saving: false, error: "",
    };
    rerender();
  }
  function closeEventForm() { state.events.form = null; setFieldErrors("communityEventForm", {}); rerender(); }
  function setEventFormType(type) { if (state.events.form && EVENT_TYPES.some((t) => t.id === type)) { state.events.form.eventType = type; rerender(); } }
  async function submitEventForm(form) {
    const f = state.events.form;
    if (!f || f.saving) return;
    const fd = new FormData(form);
    const title = String(fd.get("title") || "").trim();
    const description = String(fd.get("description") || "").trim();
    const imageUrl = String(fd.get("imageUrl") || "").trim();
    const location = String(fd.get("location") || "").trim();
    const mapLink = String(fd.get("mapLink") || "").trim();
    const startAt = String(fd.get("startAt") || "");
    const endAt = String(fd.get("endAt") || "");
    const capacityRaw = String(fd.get("capacity") || "").trim();
    const deadlineRaw = String(fd.get("registrationDeadline") || "");
    const errors = {};
    if (title.length < 1 || title.length > 120) errors.title = "כותרת נדרשת, עד 120 תווים";
    if (description.length > 4000) errors.description = "עד 4000 תווים";
    if (location.length > 240) errors.location = "עד 240 תווים";
    // esc() at render time only prevents this from breaking the page - it
    // does not stop a javascript: URI from sitting in an href. Length was
    // the only real check before this.
    if (mapLink && !/^https?:\/\//i.test(mapLink)) errors.mapLink = "הקישור חייב להתחיל ב-http:// או https://";
    if (!startAt) errors.startAt = "יש לבחור תאריך ושעת התחלה";
    if (endAt && startAt && new Date(endAt).getTime() < new Date(startAt).getTime()) errors.endAt = "תאריך הסיום חייב להיות אחרי ההתחלה";
    if (capacityRaw && (!Number.isInteger(Number(capacityRaw)) || Number(capacityRaw) <= 0)) errors.capacity = "מספר שלם חיובי נדרש";
    if (Object.keys(errors).length) return setFieldErrors("communityEventForm", errors);
    setFieldErrors("communityEventForm", {});
    f.saving = true; f.error = ""; rerender();
    const payload = {
      title, description, event_type: f.eventType,
      image_url: imageUrl || null, location: location || null, map_link: mapLink || null,
      start_at: new Date(startAt).toISOString(), end_at: endAt ? new Date(endAt).toISOString() : null,
      capacity: capacityRaw ? Number(capacityRaw) : null,
      registration_deadline: deadlineRaw ? new Date(deadlineRaw).toISOString() : null,
    };
    let error;
    let publishNow = false;
    if (f.mode === "create") {
      payload.id = newFeedId();
      payload.created_by = state.user.id;
      publishNow = !!fd.get("publishNow");
      payload.status = publishNow ? "published" : "draft";
      ({ error } = await client.from("events").insert(payload));
    } else {
      ({ error } = await client.from("events").update(payload).eq("id", f.id));
    }
    f.saving = false;
    if (error) { f.error = "לא ניתן היה לשמור את האירוע. נסו שוב."; return rerender(); }
    // COMM-216. The companion post is created at the moment an event first
    // becomes published, whether that is "publish now" on create or a later
    // draft-to-published toggle (publishEventDraft, below) - never at draft
    // save, since a draft has no attendees to discuss it with yet.
    if (publishNow) await ensureEventCompanionPost(Object.assign({}, payload));
    state.events.form = null;
    setMessage("האירוע נשמר");
    await loadEvents();
    rerender();
  }
  async function publishEventDraft(id) {
    const { error } = await client.from("events").update({ status: "published" }).eq("id", id);
    if (error) return setMessage("הפעולה נכשלה");
    const event = state.events.byId[id];
    if (event) await ensureEventCompanionPost(Object.assign({}, event, { status: "published" }));
    state.events.form = null;
    setMessage("האירוע פורסם");
    await loadEvents();
    if (state.events.view && state.events.view.id === id) await refreshEventView(id);
    rerender();
  }
  function confirmCancelEvent(id) {
    askConfirm({ title: "ביטול אירוע", message: "כל מי שנרשם לאירוע (הולכים ומעוניינים) יקבל התראה על הביטול. הפעולה אינה ניתנת לביטול.", confirmLabel: "ביטול האירוע", destructive: true, action: "event-cancel", payload: { eventId: id } });
  }
  // The event_cancelled notification fan-out (notif_on_event_cancelled,
  // 202608290009) is a server trigger on this exact UPDATE - nothing further
  // to call from here.
  async function cancelEvent(id) {
    const { error } = await client.from("events").update({ status: "cancelled" }).eq("id", id);
    if (error) return setMessage("הפעולה נכשלה");
    setMessage("האירוע בוטל");
    await loadEvents();
    if (state.events.view && state.events.view.id === id) await refreshEventView(id);
    rerender();
  }

  // ---- Companion post for comments (COMM-216) --------------------------------
  // post_create's shipped signature (202608280023) already merges
  // links.event_id into the new post's metadata, but it always writes
  // POST_TEXT or POST_PHOTO - it has no "make this a POST_EVENT" switch
  // (the same class of gap the challenges cluster found and documented for
  // links.challenge_id, which post_create does not even carry a key for).
  // event_id is different: the key genuinely IS merged into metadata
  // today, so closing this gap does not need a schema change. The row
  // post_create just inserted is authored by the caller
  // (posts_insert_self requires author_id = auth.uid()), and
  // posts_update_self (202608260001) already lets that same author update
  // ANY column of their own row with no restriction - so the follow-up
  // own-row RLS update below, from the post_create defaults straight to
  // the POST_EVENT shape, is a legitimate use of an existing policy, not a
  // bypass of one. contracts.md commits this cluster to zero schema
  // change for events; this is how that commitment is kept while still
  // giving the event a real POST_EVENT card instead of a plain POST_TEXT
  // one.
  //
  // Guards against a duplicate post on a cancel -> republish -> cancel
  // round trip or a double click on Publish: looks for an existing
  // POST_EVENT row carrying this event_id before creating a second one.
  // `events` itself carries no post_id column by design (see
  // "Needs from schema, events" in contracts.md), so this lookup - not a
  // stored pointer - is the source of truth for "does one already exist".
  async function findEventCompanionPost(eventId) {
    const { data, error } = await client.from("workout_posts").select("id,post_type,metadata").eq("post_type", "POST_EVENT");
    if (error) return null;
    return (data || []).find((r) => r.metadata && r.metadata.event_id === eventId) || null;
  }
  async function ensureEventCompanionPost(event) {
    if (!event || !event.id) return null;
    const existing = await findEventCompanionPost(event.id);
    if (existing) return existing.id;
    const body = (event.description ? String(event.description) : String(event.title || "")).slice(0, 1000);
    const { data: postId, error } = await client.rpc("post_create", {
      body, visibility: "club", media: [], links: { event_id: event.id },
    });
    if (error || !postId) return null;
    await client.from("workout_posts").update({
      post_type: "POST_EVENT",
      metadata: { event_id: event.id, event_title: event.title, starts_at: event.start_at },
    }).eq("id", postId);
    return postId;
  }

  // ---- Detail (COMM-213/214/215/216) -----------------------------------------
  async function openEvent(id, source) {
    if (!id) return;
    track(A.EVENT_VIEWED, { event_id: id, source: source || "events" });
    state.events.view = { id, loading: true, error: false, event: null, attendees: [], organizer: null, companionPostId: null, rsvpBusy: null, rsvpError: "", icsBusy: false, icsError: "" };
    rerender();
    await refreshEventView(id);
  }
  function closeEventView() { state.events.view = null; rerender(); }
  async function refreshEventView(id) {
    const v = state.events.view;
    if (!v || v.id !== id) return;
    const { data: event, error } = await client.from("events").select("*").eq("id", id).maybeSingle();
    if (!state.events.view || state.events.view.id !== id) return;
    if (error || !event) { state.events.view.loading = false; state.events.view.error = true; return rerender(); }
    state.events.view.event = event;
    state.events.byId[id] = event;
    const { data: attendees } = await client.from("event_attendees")
      .select("user_id,response,registered_at,profiles(display_name,handle,avatar_url)")
      .eq("event_id", id).order("registered_at", { ascending: true });
    state.events.view.attendees = attendees || [];
    state.events.view.organizer = null;
    if (event.created_by) {
      const { data: organizer } = await client.from("profiles").select("id,display_name,handle").eq("id", event.created_by).maybeSingle();
      state.events.view.organizer = organizer || null;
    }
    // COMM-216. Opens the companion post's thread by default - there is no
    // separate "toggle comments" affordance on an event, the thread IS the
    // event's discussion.
    const companion = await findEventCompanionPost(id);
    state.events.view.companionPostId = companion ? companion.id : null;
    if (state.events.view.companionPostId) {
      state.engagement.openComments[state.events.view.companionPostId] = true;
      await loadCommentsFor(state.events.view.companionPostId);
    }
    state.events.view.loading = false;
    rerender();
  }
  function eventRsvpErrorMessage(msg) {
    if (msg === "event_full") return "האירוע מלא";
    if (msg === "registration_closed") return "ההרשמה נסגרה";
    return "לא ניתן היה לעדכן את ההרשמה. נסו שוב.";
  }
  // COMM-214. Called both from the detail dialog's three buttons and from
  // the feed top-area quick actions (COMM-217) - event_rsvp() and the
  // server-side capacity/deadline trigger are the same for both, so this is
  // the one client path for either. A rejection (event_full,
  // registration_closed, or anything else) surfaces on the open detail
  // dialog when there is one, else as a toast, so a quick action from the
  // feed still tells the member why it failed.
  async function rsvpEvent(eventId, response) {
    if (!state.user || !eventId || !response) return;
    const v = state.events.view && state.events.view.id === eventId ? state.events.view : null;
    if (v) { v.rsvpBusy = response; v.rsvpError = ""; }
    rerender();
    const { error } = await client.rpc("event_rsvp", { p_event_id: eventId, p_response: response });
    if (v) v.rsvpBusy = null;
    if (error) {
      const msg = eventRsvpErrorMessage(error.message);
      if (v) v.rsvpError = msg; else setMessage(msg);
      rerender();
      return;
    }
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.EVENT_REGISTERED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.EVENT_REGISTERED, { event_id: eventId, rsvp_status: response }); } catch (e) {}
    }
    setMessage(response === "going" ? "נרשמת/ה לאירוע" : response === "interested" ? "סומנת/ה כמעוניינ/ת" : "עודכן כלא משתתפ/ת");
    await loadEvents();
    if (state.events.view && state.events.view.id === eventId) await refreshEventView(eventId);
    rerender();
  }
  function renderEventActions(v) {
    const e = v.event;
    if (e.status !== "published") return "";
    const closed = eventRegistrationClosed(e);
    const full = eventIsFull(e);
    const mine = myEventResponse(e.id);
    const btn = (response, label) => {
      const disabled = closed || !!v.rsvpBusy || (response === "going" && full);
      const active = mine === response;
      return `<button class="chip-btn${active ? " selected" : ""}" data-community-action="event-rsvp" data-id="${esc(e.id)}" data-response="${response}"${disabled ? " disabled" : ""}>${v.rsvpBusy === response ? "מעדכנ/ת…" : label}</button>`;
    };
    const notes = [];
    // COMM-214: "past its registration deadline disables any RSVP change".
    // Full only disables Going (Interested and Not Going stay open), and a
    // going->going update stays enabled on a full event (eventIsFull()
    // already excludes that case).
    if (closed) notes.push("ההרשמה נסגרה");
    else if (full) notes.push("האירוע מלא");
    return `<div class="chip-row" style="margin-bottom:6px;">${btn("going", "משתתפ/ת")}${btn("interested", "מעוניינ/ת")}${btn("not_going", "לא משתתפ/ת")}</div>
      ${notes.length ? `<div class="footer-note" style="margin-bottom:8px;">${notes.map(esc).join(" · ")}</div>` : ""}
      ${v.rsvpError ? `<div class="field-error" role="alert" style="margin-bottom:8px;">${esc(v.rsvpError)}</div>` : ""}`;
  }
  function renderEventAttendees(v) {
    const rows = v.attendees || [];
    if (!rows.length) return `<div class="empty">אין עדיין נרשמים.</div>`;
    const going = rows.filter((r) => r.response === "going").length;
    const rowHtml = (r) => {
      const prof = r.profiles || {};
      const name = prof.display_name || (prof.handle ? "@" + prof.handle : "חבר/ה");
      const label = r.response === "going" ? "הולכ/ת" : r.response === "interested" ? "מעוניינ/ת" : "לא הולכ/ת";
      return `<div class="log-row"><span>${esc(name)}</span><span style="color:var(--steel);font-size:12px;">${esc(label)}</span></div>`;
    };
    // Already scoped by event_attendees_read (202608280010) to rows the
    // caller may see: their own, every row if they hold
    // community.event.manage, and everyone else's only when
    // show_in_attendee_lists (and its club-wide override) allows it - no
    // extra client-side filtering needed to honour that rule.
    return `<div class="field-label" style="margin:10px 0 4px;">משתתפים (${going})</div><div class="log-list">${rows.map(rowHtml).join("")}</div>`;
  }

  // ---- Add to calendar (COMM-215) --------------------------------------------
  function icsEscape(text) {
    return String(text == null ? "" : text)
      .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  }
  function icsDateStamp(iso) {
    const d = new Date(iso);
    return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  }
  // Pure and exported on window (below) so a test can check the exact
  // iCalendar content without depending on jsdom's Blob/URL support, which
  // it does not have (the same gap composerAddPhoto already works around
  // with a try/catch around URL.createObjectURL).
  function buildEventIcs(event, appUrl) {
    const start = event.start_at;
    // COMM-215: end_at null defaults to start_at plus one hour.
    const end = event.end_at || new Date(new Date(event.start_at).getTime() + 3600000).toISOString();
    const lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Haimunia//Events//HE", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
      "UID:" + event.id + "@haimunia-events",
      "DTSTAMP:" + icsDateStamp(new Date().toISOString()),
      "DTSTART:" + icsDateStamp(start),
      "DTEND:" + icsDateStamp(end),
      "SUMMARY:" + icsEscape(event.title),
    ];
    if (event.location) lines.push("LOCATION:" + icsEscape(event.location));
    const descParts = [];
    if (event.description) descParts.push(event.description);
    if (appUrl) descParts.push(appUrl);
    if (descParts.length) lines.push("DESCRIPTION:" + icsEscape(descParts.join("\n\n")));
    lines.push("END:VEVENT", "END:VCALENDAR");
    return lines.join("\r\n");
  }
  function eventAppLink(eventId) {
    return String((window.location && window.location.origin) || "") + "/community/feed?event=" + eventId;
  }
  // COMM-215: no external service call, no server round trip - built
  // entirely from the event row already on state, and works offline once
  // the detail has loaded, per the ticket.
  function downloadEventIcs(eventId) {
    const v = state.events.view && state.events.view.id === eventId ? state.events.view : null;
    const event = (v && v.event) || state.events.byId[eventId];
    if (!event) return;
    if (v) { v.icsBusy = true; v.icsError = ""; }
    rerender();
    try {
      const ics = buildEventIcs(event, eventAppLink(eventId));
      const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = String(event.title || "event").replace(/[^\w\-א-ת ]+/g, "_").slice(0, 60) + ".ics";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 1000);
    } catch (err) {
      // Defensive only, per the ticket - a malformed date should not occur
      // given the table CHECKs. Also the path jsdom's missing
      // Blob/URL.createObjectURL takes under test.
      if (v) v.icsError = "לא ניתן היה ליצור קובץ יומן.";
    }
    if (v) v.icsBusy = false;
    rerender();
  }
  window.buildEventIcs = buildEventIcs;

  function renderEventViewBody(v) {
    const e = v.event;
    const staff = hasPerm(PERM.EVENT_MANAGE);
    const meta = [eventTypeBadge(e.event_type), formatEventDate(e.start_at), formatEventTime(e.start_at)];
    if (e.end_at) meta.push("עד " + formatEventTime(e.end_at));
    const statusLabel = eventStatusLabel(e);
    if (statusLabel) meta.push(statusLabel);
    const metaHtml = `<div style="color:var(--steel);font-size:12px;margin-bottom:10px;">${meta.map(esc).join(" · ")}</div>`;
    const image = e.image_url ? `<img src="${esc(e.image_url)}" alt="" style="width:100%;max-height:200px;object-fit:cover;border-radius:12px;margin-bottom:10px;"/>` : "";
    const description = e.description ? `<div style="font-size:13.5px;line-height:1.6;margin-bottom:10px;white-space:pre-wrap;">${esc(e.description)}</div>` : "";
    const locationHtml = e.location ? `<div style="font-size:13px;color:var(--steel);margin-bottom:4px;">📍 ${esc(e.location)}${e.map_link ? ` · <a class="link-btn" href="${esc(e.map_link)}" target="_blank" rel="noopener noreferrer">מפה</a>` : ""}</div>` : "";
    const going = eventGoingCount(e.id);
    const capacityHtml = `<div style="font-size:13px;color:var(--steel);margin-bottom:4px;">${e.capacity != null ? `${going} / ${e.capacity} משתתפים` : `${going} משתתפים`}</div>`;
    const deadlineHtml = e.registration_deadline ? `<div style="font-size:12px;color:var(--steel);margin-bottom:4px;">מועד אחרון להרשמה: ${esc(formatEventDate(e.registration_deadline))} ${esc(formatEventTime(e.registration_deadline))}</div>` : "";
    const organizerName = v.organizer ? (v.organizer.display_name || (v.organizer.handle ? "@" + v.organizer.handle : "")) : "";
    const organizerHtml = organizerName ? `<div style="font-size:12px;color:var(--steel);margin-bottom:10px;">מארגנ/ת: ${esc(organizerName)}</div>` : "";
    const staffToolbar = staff ? `<div class="chip-row" style="margin-bottom:10px;">
        <button class="chip-btn" data-community-action="event-edit" data-id="${esc(e.id)}">עריכה</button>
        ${e.status === "draft" ? `<button class="chip-btn" data-community-action="event-publish" data-id="${esc(e.id)}">פרסום</button>` : ""}
        ${e.status === "published" ? `<button class="chip-btn danger" data-community-action="event-cancel-confirm" data-id="${esc(e.id)}">ביטול האירוע</button>` : ""}
      </div>` : "";
    const actions = renderEventActions(v);
    const icsBtn = `<div class="chip-row" style="margin:8px 0;"><button class="chip-btn" data-community-action="event-ics" data-id="${esc(e.id)}"${v.icsBusy ? " disabled" : ""}>${v.icsBusy ? "יוצר…" : "הוספה ליומן"}</button></div>${v.icsError ? `<div class="field-error" role="alert">${esc(v.icsError)}</div>` : ""}`;
    const attendeesHtml = renderEventAttendees(v);
    // COMM-216: the companion post's own thread, reusing renderComments()
    // untouched - same empty state, same loading skeleton, same retry
    // affordance every other comment thread already has. A post object
    // this thin is enough: renderComments()/reactionStripHtml() only ever
    // read post.id.
    const commentsHtml = v.companionPostId ? renderComments({ id: v.companionPostId }) : "";
    return `${metaHtml}${staffToolbar}${image}${description}${locationHtml}${capacityHtml}${deadlineHtml}${organizerHtml}${actions}${icsBtn}${attendeesHtml}<div style="margin-top:14px;">${commentsHtml}</div>`;
  }
  function renderEventViewOverlay() {
    const v = state.events.view;
    if (!v) return "";
    const bodyHtml = v.loading ? `<div class="empty">טוען את האירוע…</div>`
      : (v.error || !v.event) ? `<div class="empty">לא ניתן היה לטעון את האירוע. נסו שוב.</div>`
      : renderEventViewBody(v);
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="eventViewTitle" data-cloud-dialog="eventView" style="align-items:flex-start;padding:20px 12px;">
      <div class="modal-sheet" style="border-radius:20px;max-height:88vh;overflow:auto;width:100%;max-width:560px;">
        <div style="padding:18px 18px calc(env(safe-area-inset-bottom,0px) + 16px);">
          <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div id="eventViewTitle" style="font-weight:800;font-size:17px;">${v.event ? esc(v.event.title) : "אירוע"}</div>
            <button class="chip-btn" data-community-action="close-event-view" aria-label="סגירה">✕</button>
          </div>
          ${bodyHtml}
        </div>
      </div>
    </div>`;
  }

  // ---- Create/edit form markup (COMM-213) ------------------------------------
  function renderEventForm() {
    const f = state.events.form;
    const typePicker = `<div class="chip-row" role="group" aria-label="סוג אירוע" style="margin-bottom:10px;flex-wrap:wrap;">${EVENT_TYPES.map((t) => `<button type="button" class="chip-btn${f.eventType === t.id ? " selected" : ""}" data-community-action="event-form-type" data-type="${t.id}">${t.icon} ${esc(t.label)}</button>`).join("")}</div>`;
    return `<form id="communityEventForm" class="chart-card admin-card" style="margin-top:10px;">
      <div style="font-weight:800;margin-bottom:10px;">${f.mode === "edit" ? "עריכת אירוע" : "אירוע חדש"}<span class="admin-tag">ניהול</span></div>
      ${typePicker}
      ${field("communityEventForm", "title", "שם האירוע", `<input class="text-input" name="title" value="${esc(f.title)}" maxlength="120" required/>`)}
      ${field("communityEventForm", "description", "תיאור", `<textarea class="text-input" name="description" maxlength="4000">${esc(f.description)}</textarea>`)}
      ${field("communityEventForm", "imageUrl", "קישור לתמונה", `<input class="text-input" name="imageUrl" value="${esc(f.imageUrl)}" maxlength="500" placeholder="https://..."/>`)}
      ${field("communityEventForm", "location", "מיקום", `<input class="text-input" name="location" value="${esc(f.location)}" maxlength="240"/>`)}
      ${field("communityEventForm", "mapLink", "קישור למפה", `<input class="text-input" name="mapLink" value="${esc(f.mapLink)}" maxlength="500" placeholder="https://..."/>`)}
      <div class="flex gap-16 field">
        ${field("communityEventForm", "startAt", "התחלה", `<input class="text-input" name="startAt" type="datetime-local" value="${esc(f.startAt)}" required/>`)}
        ${field("communityEventForm", "endAt", "סיום", `<input class="text-input" name="endAt" type="datetime-local" value="${esc(f.endAt)}"/>`)}
      </div>
      <div class="flex gap-16 field">
        ${field("communityEventForm", "capacity", "מקומות (ריק = ללא הגבלה)", `<input class="text-input" name="capacity" type="number" min="1" value="${esc(f.capacity)}"/>`)}
        ${field("communityEventForm", "registrationDeadline", "מועד אחרון להרשמה", `<input class="text-input" name="registrationDeadline" type="datetime-local" value="${esc(f.registrationDeadline)}"/>`)}
      </div>
      ${f.mode === "create" ? `<label class="field flex gap-6" style="align-items:center;"><input type="checkbox" name="publishNow"/><span style="font-size:12.5px;color:var(--steel);">פרסום מיידי (אחרת יישמר כטיוטה)</span></label>` : ""}
      ${f.error ? `<div class="field-error" role="alert">${esc(f.error)}</div>` : ""}
      <div class="chip-row" style="margin-top:10px;">
        <button class="chip-btn primary" type="submit"${f.saving ? " disabled" : ""}>${f.saving ? "שומר…" : "שמירה"}</button>
        <button class="chip-btn" type="button" data-community-action="event-form-cancel">ביטול</button>
      </div>
    </form>`;
  }

  // ---- Upcoming-event card in the feed top area (COMM-217) -------------------
  // The soonest published, non-cancelled event with start_at > now(), or
  // nothing at all - never an empty placeholder. state.events.items is loaded
  // alongside the feed (loadEvents() sits in the same Promise.all as
  // loadFeed()), so this needs no realtime subscription of its own: it
  // refreshes exactly when the rest of the feed top area does.
  function upcomingFeedEvent() {
    // state.events.items is sorted start_at ascending by the query itself
    // (loadEvents()'s order()), so the first match is the soonest one.
    return state.events.items.find(isUpcomingEvent) || null;
  }
  function renderUpcomingEventCard() {
    const e = upcomingFeedEvent();
    if (!e) return "";
    const going = eventGoingCount(e.id);
    const mine = myEventResponse(e.id);
    const closed = eventRegistrationClosed(e);
    const full = eventIsFull(e);
    return `<div class="chart-card" style="margin-top:10px;" data-event-id="${esc(e.id)}">
      <button class="link-btn" data-community-action="open-event" data-id="${esc(e.id)}" data-source="club_top" style="padding:0;text-align:right;display:block;width:100%;">
        <div style="font-weight:800;font-size:14px;">📅 ${esc(e.title)}</div>
        <div style="color:var(--steel);font-size:12px;margin-top:2px;">${esc(formatEventDate(e.start_at))} ${esc(formatEventTime(e.start_at))} · ${going} משתתפים</div>
      </button>
      <div class="chip-row" style="margin-top:8px;">
        <button class="chip-btn${mine === "going" ? " selected" : ""}" data-community-action="event-rsvp" data-id="${esc(e.id)}" data-response="going"${closed || full ? " disabled" : ""}>משתתפ/ת</button>
        <button class="chip-btn${mine === "interested" ? " selected" : ""}" data-community-action="event-rsvp" data-id="${esc(e.id)}" data-response="interested"${closed ? " disabled" : ""}>מעוניינ/ת</button>
      </div>
    </div>`;
  }

  // ---- Trained-with-you-today card in the feed top area (COMM-307) -----------
  // The client half of COMM-307, closing COMM-P05. The schema half shipped as
  // 202608310005; read its header and contracts.md's
  // "attendance_classmates_today(p_limit int default 6)" entry before changing
  // anything here, because three of the decisions below are only correct
  // because of what that function already guarantees.
  //
  // WHAT THIS CARD SAYS, and nothing more: these members logged a session on
  // the same day you did. No count, no streak, no time of day, no "trained 2
  // hours ago" - attendance_log records a day, not a time, and the function
  // deliberately returns four keys and no fifth. Anything more would be the
  // client inventing a claim the data does not make.
  //
  // THE OMISSION IS THE WHOLE DESIGN. An empty result renders NOTHING - no
  // heading, no empty state, no retry - which is COMM-232's "on no signal,
  // show nothing" precedent adopted by name in COMM-307's acceptance criteria.
  // The server returns an empty set in three indistinguishable cases: the
  // caller did not train today, the caller trained but nobody else did, and
  // the caller's own show_attendance is off (a direct profiles column read
  // inside the function - it is a reciprocity rule, and it is enforced there
  // rather than here because every boundary in this module is server-side).
  // Nothing in this file tries to tell those three apart. It cannot, by
  // design, and the card would look identical if it could.
  //
  // NO CLIENT-SIDE "TODAY". `current_date` is the server's UTC day, the same
  // day attendance_log's trigger compares against when it writes the row this
  // card reads. A client-side date check for "did I train today" would drift
  // from that by up to a timezone and gate the card on a different day than
  // the one that produced it, so there is no date arithmetic here at all: the
  // client calls, and renders what comes back.
  //
  // NO "MESSAGE" AFFORDANCE, per the phase's standing no-messaging
  // resolution. Direct messaging was removed from scope entirely; there is no
  // Message button anywhere in this file and this card does not add the first.
  //
  // LIMIT. 6, the function's own default, passed explicitly rather than
  // relied on: the clamp range (1..20) is the server's and is fixed, but
  // 202608310005 records that "the default inside it is the client half's to
  // revisit", so the number the card actually wants lives here, at the card.
  // Six is two rows of three or six list rows - a card in COMM-115's feed top
  // area, where people_suggestions' 10 is a horizontally scrolling strip.
  const CLASSMATES_TODAY_LIMIT = 6;
  // COMM-307. One classmates_card_viewed per feed-session load of this card,
  // never one per re-render - the same shape as lastClubTabView above. A
  // cheer, a comment arriving over realtime or a photo URL resolving all
  // re-render the feed, and none of them is a second view of this card.
  // Cleared when a fresh load starts (a new session, or a scope change that
  // re-enters the feed), so the next real render counts again.
  let classmatesCardViewLogged = false;
  async function loadClassmatesToday() {
    // Same anonymous-signup-session guard as pingActivity():
    // attendance_classmates_today() raises 'not authorized' for a session
    // with no profile row, which the signup screens were hitting.
    if (!client || !state.user || !state.profile) return;
    const s = state.members.classmatesToday;
    s.loading = true; s.error = false;
    classmatesCardViewLogged = false;
    rerender();
    const { data, error } = await client.rpc("attendance_classmates_today", { p_limit: CLASSMATES_TODAY_LIMIT });
    s.loading = false; s.loaded = true;
    // Silently omitted on a failed fetch, the same choice people_suggestions
    // makes for its own strip: a secondary surface that failed is worse than
    // a surface that is not there, and a retry button on a card most members
    // will never see is a permanent fixture built out of an error path.
    if (error) { s.error = true; s.items = []; return rerender(); }
    // Rendered in the order returned. attendance_classmates_today() orders by
    // recorded_at desc then display name then id - a total order, so the cut
    // at p_limit is the server's and re-sorting here would throw away the one
    // ordering decision the function actually made.
    s.items = (Array.isArray(data) ? data : []).filter(Boolean);
    rerender();
  }
  function classmateRowHtml(item) {
    const name = item.display_name || (item.handle ? "@" + item.handle : "חבר/ה");
    // THE FOLLOW CONTROL IS ALWAYS RENDERED, and that is the one place this
    // row deliberately differs from memberRowHtml()/followListRowHtml(),
    // which both write `allow_follows === false ? "" : button`. Those two read
    // profiles directly and get the column; attendance_classmates_today()
    // returns four keys and allow_follows is not one of them, on purpose -
    // contracts.md: "this is not a follow strip, it is 'who trained today',
    // and hiding a classmate who simply does not want followers would be
    // wrong." Copying the guard here would compare undefined to false, never
    // hide anything, and read as if it were doing something. So the control
    // is shown for everyone and a refusal is the server's to make:
    // follows_insert_self (202608280003) enforces allow_follows on the
    // insert, and follow() already turns a rejected write into the same
    // "עדכון המעקב נכשל" message every other follow button in this file
    // produces. No new follow mechanism, no new error path, no pre-filter
    // that would leak another member's setting into the card.
    return `<div class="log-row" data-classmate-user="${esc(item.user_id)}">
      <button class="link-btn" data-community-action="view-profile" data-id="${esc(item.user_id)}" style="padding:0;display:flex;gap:10px;align-items:center;color:inherit;text-align:right;">
        ${avatarHtml(name, 32, item.avatar_url)}
        <span style="min-width:0;"><span style="font-weight:700;display:block;">${esc(name)}</span>${item.handle ? `<span style="color:var(--steel);font-size:12px;"><bdi>@${esc(item.handle)}</bdi></span>` : ""}</span>
      </button>
      <div class="chip-row" style="margin-top:0;"><button class="chip-btn" data-community-action="follow" data-id="${esc(item.user_id)}">מעקב</button></div>
    </div>`;
  }
  function renderClassmatesTodayCard() {
    const s = state.members.classmatesToday;
    // The three no-card branches, all of which return the same empty string:
    // a failed fetch, a load that has not answered yet, and an answer with no
    // rows. The middle one is why there is no skeleton here - see below.
    //
    // This first line is belt-and-braces and says so: loadClassmatesToday()
    // already empties items on an error, so the `!s.items.length` check below
    // would catch it anyway. It is written out because "error omits the card"
    // is one of COMM-307's four named frontend states, and a state that is
    // only satisfied as a side effect of another branch is one refactor away
    // from becoming a retry button.
    if (s.error) return "";
    // LOADING RENDERS NOTHING, deliberately, and this is the one frontend
    // state where COMM-307's wording and COMM-115's actual slot disagree, so
    // it is written down rather than left to a reader to notice. The other
    // card in this slot (renderUpcomingEventCard, COMM-217) has no skeleton
    // either: a card that is omitted entirely more often than it renders
    // cannot hold a placeholder open, because the placeholder would then be
    // the thing most members see - a grey box that appears on every visit to
    // the Feed sub-tab and vanishes. show_attendance defaults to FALSE, so
    // out of the box this card is empty for every member of the club, which
    // makes "usually nothing" the common case and not the edge one. Reusing
    // the log-list skeleton the directory and the boards use would be reusing
    // the wrong pattern for this slot; the pattern this slot actually has is
    // the upcoming-event card's, and it is to show nothing until there is
    // something. A reload with rows already on screen keeps them (the
    // condition is `!s.items.length`), the same way the leaderboard holds its
    // previous rows under a refresh.
    if (!s.items.length) return "";
    return `<div class="chart-card" style="margin-top:10px;margin-bottom:10px;" data-classmates-today="ready">
      <div style="font-weight:800;font-size:14px;">💪 התאמנו היום גם</div>
      <div class="log-list" style="margin-top:8px;">${s.items.map(classmateRowHtml).join("")}</div>
    </div>`;
  }
  // COMM-307's analytics, called from afterRenderCommunity() for the same
  // reason noteClubTabView() is: that hook is the only place cloud.js learns
  // the card is actually on screen, rather than merely fetched. It is
  // recorded once per load of the card (the guard above), it carries the row
  // count and the surface and nothing member-identifying, and it does NOT
  // count for WCAM - see ACTIVE_MEMBER_EVENTS in src/analytics.js and the
  // reasoning leaderboard_viewed already uses: viewing is not participation.
  function noteClassmatesCardView() {
    if (classmatesCardViewLogged) return;
    if (!state.user || !state.profile) return;
    if (!document.querySelector('[data-classmates-today="ready"]')) return;
    classmatesCardViewLogged = true;
    track(A.CLASSMATES_CARD_VIEWED, { rows: state.members.classmatesToday.items.length, source: "feed" });
  }

  // ---- COMM-221 weekly recap surface + share ---------------------------
  // Reachable from (a) the weekly_recap notification's deep link
  // (resolveNotifTarget below) and (b) the "View Week" entry point in the
  // Account tab. weekStart === null means "the member's most recent
  // available week"; the notification always supplies an explicit one.
  // RLS is what actually enforces "only my own recaps" - weekly_recaps has
  // an own-row select policy and nothing else, so there is nothing for a
  // client-side check to add here beyond that enforced boundary.
  async function openRecap(weekStart, source) {
    if (!state.user || !client) return;
    // COMM-233. Recorded at the moment of the open, before the row is
    // fetched, for the same reason profile_opened is: the member asked to
    // see their week whether or not the read behind it answers. Which week,
    // and what was in it, is not a prop - the recap row itself is the
    // record of that, and the figures are the member's own numbers.
    track(A.WEEKLY_RECAP_OPENED, { source: source || "account" });
    state.recaps.view = { weekStart: weekStart || null, loading: true, error: false, row: null, olderWeekStart: null, newerWeekStart: null, sharing: null };
    rerender();
    await refreshRecapView(weekStart || null);
  }
  function closeRecapView() { state.recaps.view = null; rerender(); }
  // weekStart === null asks for the most recent row; otherwise a specific
  // ISO week. Either way, once the row is known, the two adjacent-week
  // existence checks (COMM-221: "past weeks are browsable") run off its
  // real week_start, not the possibly-null argument this call started
  // with.
  async function refreshRecapView(weekStart) {
    const v = state.recaps.view;
    if (!v) return;
    v.loading = true; v.error = false; rerender();
    let row = null, err = null;
    if (weekStart) {
      const res = await client.from("weekly_recaps").select("*").eq("user_id", state.user.id).eq("week_start", weekStart).maybeSingle();
      row = res.data; err = res.error;
    } else {
      const res = await client.from("weekly_recaps").select("*").eq("user_id", state.user.id).order("week_start", { ascending: false });
      err = res.error;
      row = (!err && Array.isArray(res.data) && res.data.length) ? res.data[0] : null;
    }
    if (!state.recaps.view || state.recaps.view !== v) return; // closed/reopened mid-flight
    if (err) { v.loading = false; v.error = true; return rerender(); }
    v.row = row;
    v.weekStart = row ? row.week_start : weekStart;
    v.olderWeekStart = null; v.newerWeekStart = null;
    if (row) {
      const [olderRes, newerRes] = await Promise.all([
        client.from("weekly_recaps").select("week_start").eq("user_id", state.user.id).lt("week_start", row.week_start).order("week_start", { ascending: false }),
        client.from("weekly_recaps").select("week_start").eq("user_id", state.user.id).gt("week_start", row.week_start).order("week_start", { ascending: true }),
      ]);
      if (!state.recaps.view || state.recaps.view !== v) return;
      v.olderWeekStart = (!olderRes.error && olderRes.data && olderRes.data[0]) ? olderRes.data[0].week_start : null;
      v.newerWeekStart = (!newerRes.error && newerRes.data && newerRes.data[0]) ? newerRes.data[0].week_start : null;
    }
    v.loading = false;
    rerender();
  }
  function recapGoOlder() { const v = state.recaps.view; if (v && v.olderWeekStart) refreshRecapView(v.olderWeekStart); }
  function recapGoNewer() { const v = state.recaps.view; if (v && v.newerWeekStart) refreshRecapView(v.newerWeekStart); }
  function recapWeekRangeLabel(weekStart) {
    if (!weekStart) return "";
    const start = new Date(weekStart + "T00:00:00Z");
    const end = new Date(start.getTime() + 6 * 86400000);
    const fmt = (d) => d.toISOString().slice(0, 10);
    return `${fmt(start)} – ${fmt(end)}`;
  }
  // "Pick one figure" (COMM-221) - a small, fixed set of true, already-
  // generated figures from this exact row, never anything invented on the
  // client. Sessions and streak are always offered; a PR or an
  // achievement is only offered when the week actually produced one.
  function recapShareOptions(row) {
    const opts = [
      { key: "sessions", label: "מספר האימונים", body: `התאמנתי ${row.sessions_completed} פעם${row.sessions_completed === 1 ? "" : "ים"} השבוע! 💪` },
      { key: "streak", label: "רצף האימונים", body: `הרצף שלי עומד על ${row.streak} ${row.streak === 1 ? "יום" : "ימים"} ברצף! 🔥` },
    ];
    if (Array.isArray(row.prs) && row.prs.length) {
      const pr = row.prs[0];
      opts.push({ key: "pr", label: "שיא חדש", body: `שיא חדש השבוע${pr.movement ? " ב" + pr.movement : ""}${pr.result ? ": " + pr.result : ""}! 🏆` });
    }
    if (Array.isArray(row.achievements) && row.achievements.length) {
      const ach = row.achievements[0];
      opts.push({ key: "achievement", label: "הישג חדש", body: `פתחתי השבוע הישג חדש: ${ach.title || ""}${ach.badge_icon ? " " + ach.badge_icon : ""}`.trim() });
    }
    return opts;
  }
  async function shareRecapFigure(key) {
    const v = state.recaps.view;
    if (!v || !v.row || v.sharing) return;
    const opt = recapShareOptions(v.row).find((o) => o.key === key);
    if (!opt) return;
    v.sharing = key; rerender();
    // post_create itself enforces the 1000-char cap and the post rate
    // limit (COMM-221) - every generated figure body here is a short,
    // fixed template, well under the cap either way.
    const { data, error } = await client.rpc("post_create", { body: opt.body, visibility: "club", media: [], links: null });
    v.sharing = null;
    if (error || !data) { setMessage("שיתוף הסיכום נכשל, אפשר לנסות שוב"); return rerender(); }
    setMessage("הסיכום שותף לקהילה");
    // COMM-233. After the write, like every other write-backed event: a
    // failed share is not a share. `figure` is the option key, one of a
    // fixed four - never the generated sentence, which carries the member's
    // own PR movement and achievement title. post_created rides the bus off
    // the same action; two names for one action is not double counting.
    track(A.WEEKLY_RECAP_SHARED, { figure: key, post_id: data });
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.POST_CREATED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.POST_CREATED, { post_id: data, post_type: "POST_TEXT" }); } catch (e) {}
    }
    rerender();
  }
  function renderRecapBody(v) {
    const row = v.row;
    const isQuiet = Number(row.sessions_completed) === 0 && Number(row.streak) === 0
      && !(Array.isArray(row.prs) && row.prs.length) && !(Array.isArray(row.achievements) && row.achievements.length);
    const quietNote = isQuiet ? `<div class="empty">שבוע שקט - בלי אימונים שנרשמו. השבוע הבא הוא הזדמנות חדשה.</div>` : "";
    const prsHtml = Array.isArray(row.prs) && row.prs.length
      ? `<div class="log-list">${row.prs.map((pr) => `<div class="log-row"><span>${esc(pr.movement)}</span><span class="mono" style="color:var(--brass);">${esc(pr.result)}</span></div>`).join("")}</div>`
      : `<div class="empty">אין שיאים חדשים השבוע</div>`;
    const achHtml = Array.isArray(row.achievements) && row.achievements.length
      ? `<div class="log-list">${row.achievements.map((a) => `<div class="log-row"><span>${esc(a.badge_icon || "🏅")} ${esc(a.title)}</span></div>`).join("")}</div>`
      : `<div class="empty">אין הישגים חדשים השבוע</div>`;
    const challengeHtml = Array.isArray(row.challenge_progress) && row.challenge_progress.length
      ? `<div class="log-list">${row.challenge_progress.map((c) => `<div class="log-row"><span>${esc(c.title)}</span><span class="mono" style="color:var(--brass);">${esc(c.progress)}${c.target != null ? ` / ${esc(c.target)}` : ""}</span></div>`).join("")}</div>`
      : `<div class="empty">לא נרשמה השתתפות באתגר השבוע</div>`;
    // COMM-316 (closing COMM-P06). weekly_recaps.classmates is up to 5
    // {user_id, display_name, handle, avatar_url} objects, already fully
    // privacy-gated server-side by recap_weekly_classmates() (both this
    // row's own show_attendance AND each named candidate's) - nothing here
    // re-filters or re-sorts, the same "render in the order returned"
    // discipline classmateRowHtml() uses for attendance_classmates_today().
    // A recap is an own-row surface (weekly_recaps' only RLS policy is
    // own-row SELECT), which is exactly why naming individuals is safe HERE
    // and never in the club-wide monthly recap (COMM-309).
    //
    // QUIET-WEEK CHOICE, this ticket's own call: an empty array renders a
    // message rather than being omitted. Every other section in this
    // function (PRs, achievements, challenge progress, the upcoming event)
    // already renders an `.empty` line instead of disappearing when there
    // is nothing to show, and a recap that is browsed week to week (COMM-
    // 221's prev/next) would otherwise look inconsistent - some weeks with
    // six labelled sections, some with five and no visible reason why.
    const classmatesList = Array.isArray(row.classmates) ? row.classmates : [];
    const classmatesHtml = classmatesList.length
      ? `<div data-recap-classmates="ready">${classmatesList.map((m) => {
          const name = m.display_name || (m.handle ? "@" + m.handle : "חבר/ה");
          return `<button class="link-btn" data-community-action="view-profile" data-id="${esc(m.user_id)}" style="padding:0;color:inherit;font-weight:700;text-decoration:underline;">${esc(name)}</button>`;
        }).join(", ")} התאמנו איתכם השבוע.</div>`
      : `<div class="empty" data-recap-classmates="empty">אין חברים משותפים השבוע</div>`;
    const club = row.club_challenge_progress && row.club_challenge_progress.title
      ? `<div class="chart-card" style="margin-bottom:10px;"><div class="field-label" style="margin-bottom:4px;">${esc(row.club_challenge_progress.title)}</div><div class="mono" style="color:var(--brass);">${esc(row.club_challenge_progress.total)}${row.club_challenge_progress.target != null ? ` / ${esc(row.club_challenge_progress.target)}` : ""}</div>${row.club_challenge_progress.participants != null ? `<div style="color:var(--steel);font-size:12px;">${esc(row.club_challenge_progress.participants)} משתתפים</div>` : ""}</div>`
      : "";
    const event = row.upcoming_event
      ? `<div class="chart-card" style="margin-bottom:10px;"><div class="field-label" style="margin-bottom:4px;">האירוע הקרוב</div><button class="link-btn" data-community-action="open-event" data-id="${esc(row.upcoming_event.id)}" data-source="recap" style="padding:0;text-align:right;display:block;">${esc(row.upcoming_event.title)}</button>${row.upcoming_event.start_at ? `<div style="color:var(--steel);font-size:12px;">${esc(formatChallengeDate(row.upcoming_event.start_at))}</div>` : ""}</div>`
      : `<div class="empty">אין אירוע קרוב לציין</div>`;
    const shareOptions = recapShareOptions(row);
    const shareHtml = `<div class="field-label" style="margin:10px 0 4px;">שיתוף הסיכום</div><div class="chip-row" style="flex-wrap:wrap;">${shareOptions.map((o) => `<button class="chip-btn" data-community-action="share-recap" data-figure="${o.key}"${v.sharing === o.key ? " disabled" : ""}>${v.sharing === o.key ? "משתף…" : "שיתוף " + esc(o.label)}</button>`).join("")}</div>`;
    return `${quietNote}
      <div class="chart-card" style="margin-bottom:10px;"><div class="field-label" style="margin-bottom:4px;">אימונים השבוע</div><div class="mono" style="color:var(--brass);font-size:18px;">${esc(row.sessions_completed)}</div></div>
      <div class="chart-card" style="margin-bottom:10px;"><div class="field-label" style="margin-bottom:4px;">רצף נוכחי</div><div class="mono" style="color:var(--brass);font-size:18px;">🔥 ${esc(row.streak)}</div></div>
      <div class="field-label" style="margin:10px 0 4px;">שיאים</div>${prsHtml}
      <div class="field-label" style="margin:10px 0 4px;">הישגים</div>${achHtml}
      <div class="field-label" style="margin:10px 0 4px;">ההתקדמות שלי באתגר</div>${challengeHtml}
      <div class="field-label" style="margin:10px 0 4px;">מי עוד התאמן איתכם השבוע</div>${classmatesHtml}
      ${club}
      ${event}
      ${shareHtml}`;
  }
  function renderRecapViewOverlay() {
    const v = state.recaps.view;
    if (!v) return "";
    const weekLabel = v.weekStart ? recapWeekRangeLabel(v.weekStart) : "";
    // COMM-221 frontend states: empty ("אין עדיין סיכום שבועי"), loading
    // skeleton, error ("לא ניתן היה לטעון את הסיכום השבועי. נסו שוב."),
    // populated (renderRecapBody, including the quiet-week variant it
    // renders inline off the same row).
    const bodyHtml = v.loading ? `<div class="log-list" aria-busy="true">${`<div class="chart-card" style="height:56px;background:var(--border);opacity:.35;margin-bottom:10px;"></div>`.repeat(2)}</div>`
      : v.error ? `<div class="empty">לא ניתן היה לטעון את הסיכום השבועי. נסו שוב.<div class="chip-row" style="justify-content:center;"><button class="chip-btn" data-community-action="recap-retry">ניסיון חוזר</button></div></div>`
      : !v.row ? `<div class="empty">אין עדיין סיכום שבועי.</div>`
      : renderRecapBody(v);
    const nav = (v.row && !v.loading && !v.error) ? `<div class="chip-row" style="margin-bottom:10px;">
        <button class="chip-btn" data-community-action="recap-older"${v.olderWeekStart ? "" : " disabled"}>שבוע קודם</button>
        <button class="chip-btn" data-community-action="recap-newer"${v.newerWeekStart ? "" : " disabled"}>שבוע הבא</button>
      </div>` : "";
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="recapViewTitle" data-cloud-dialog="recapView" style="align-items:flex-start;padding:20px 12px;">
      <div class="modal-sheet" style="border-radius:20px;max-height:88vh;overflow:auto;width:100%;max-width:560px;">
        <div style="padding:18px 18px calc(env(safe-area-inset-bottom,0px) + 16px);">
          <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div id="recapViewTitle" style="font-weight:800;font-size:17px;">${weekLabel ? "סיכום השבוע · " + esc(weekLabel) : "סיכום שבועי"}</div>
            <button class="chip-btn" data-community-action="close-recap-view" aria-label="סגירה">✕</button>
          </div>
          ${nav}
          ${bodyHtml}
        </div>
      </div>
    </div>`;
  }

  // ---- Composer (COMM-102, COMM-103) --------------------------------------
  function openComposer(triggerEl) {
    state.posts.composerTrigger = triggerEl || null;
    state.posts.composer = { body: "", visibility: "club", photos: [], links: {}, error: "", publishing: false };
    state.posts.openMenu = null;
    rerender();
    setTimeout(() => { const t = document.querySelector("[data-composer-body]"); if (t && t.focus) t.focus(); }, 0);
  }
  window.openPostComposer = openComposer;
  function closeComposer() {
    const trigger = state.posts.composerTrigger;
    state.posts.composer = null;
    state.posts.composerTrigger = null;
    rerender();
    if (trigger && trigger.focus) setTimeout(() => trigger.focus(), 0);
  }
  function tryCloseComposer() {
    if (state.posts.composer && (cleanPostBody(state.posts.composer.body) || state.posts.composer.photos.length)) {
      askConfirm({ title: "לבטל את הפוסט?", message: "מה שכתבתם לא יישמר.", confirmLabel: "ביטול הפוסט", destructive: true, action: "composer-discard" });
    } else {
      closeComposer();
    }
  }
  function composerSetBody(v) {
    if (!state.posts.composer) return;
    state.posts.composer.body = v;
    const dlg = document.getElementById("postComposer");
    if (!dlg) return;
    const btn = dlg.querySelector('[data-community-action="composer-publish"]');
    if (btn) btn.disabled = !composerCanPublish();
    const c = dlg.querySelector("[data-composer-counter]");
    if (c) { const n = cleanPostBody(v).length; c.textContent = n >= 900 ? `${n}/${POST_BODY_MAX}` : ""; }
  }
  function composerSetAlt(id, v) {
    if (!state.posts.composer) return;
    const p = state.posts.composer.photos.find((x) => x.id === id);
    if (p) p.altText = v;
    const dlg = document.getElementById("postComposer");
    if (dlg) { const btn = dlg.querySelector('[data-community-action="composer-publish"]'); if (btn) btn.disabled = !composerCanPublish(); }
  }
  function composerToggleDecorative(id, checked) {
    if (!state.posts.composer) return;
    const p = state.posts.composer.photos.find((x) => x.id === id);
    if (p) { p.decorative = !!checked; if (checked) p.altText = ""; }
    rerender();
  }
  function composerSetVisibility(v) {
    if (state.posts.composer && POST_VISIBILITY_OPTIONS.some((o) => o.value === v)) state.posts.composer.visibility = v;
  }
  function composerRemovePhoto(id) {
    if (!state.posts.composer) return;
    state.posts.composer.photos = state.posts.composer.photos.filter((p) => p.id !== id);
    rerender();
  }
  function composerRetryPhoto(id) {
    if (!state.posts.composer) return;
    const p = state.posts.composer.photos.find((x) => x.id === id);
    const file = p && p._file;
    composerRemovePhoto(id);
    if (file) composerAddPhoto(file);
  }
  // COMM-103. Every photo goes through prepareImage (COMM-015) before upload.
  async function composerAddPhoto(file) {
    if (!state.posts.composer) return;
    if (state.posts.composer.photos.length >= POST_MEDIA_MAX) { state.posts.composer.error = `אפשר לצרף עד ${POST_MEDIA_MAX} תמונות`; return rerender(); }
    const id = "ph" + Date.now() + Math.random().toString(36).slice(2, 6);
    const photo = { id, status: "processing", altText: "", decorative: false, storagePath: null, previewUrl: null, error: null, width: null, height: null, _file: file };
    state.posts.composer.photos.push(photo);
    state.posts.composer.error = "";
    rerender();
    try {
      const prepared = await window.HaimuniaImage.prepareImage(file);
      try {
        if (prepared.thumbnail && prepared.thumbnail.blob && typeof URL !== "undefined" && URL.createObjectURL) photo.previewUrl = URL.createObjectURL(prepared.thumbnail.blob);
      } catch (e) { photo.previewUrl = null; }
      const path = await uploadPreparedPhoto(prepared);
      if (!path) throw new Error("upload_failed");
      photo.storagePath = path;
      photo.width = (prepared.render && prepared.render.width) || null;
      photo.height = (prepared.render && prepared.render.height) || null;
      photo.status = "ready";
    } catch (err) {
      photo.status = "failed";
      photo.error = err && err.code === "not_an_image" ? "הקובץ אינו תמונה" : "העלאת התמונה נכשלה";
    }
    rerender();
  }
  async function uploadPreparedPhoto(prepared) {
    if (!state.user || !prepared || !prepared.render || !prepared.render.blob) return null;
    const type = prepared.render.type || "image/webp";
    const ext = type === "image/png" ? "png" : type === "image/jpeg" ? "jpg" : "webp";
    const path = `${state.user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await client.storage.from("post-photos").upload(path, prepared.render.blob, { contentType: type, upsert: false });
    return error ? null : path;
  }
  // COMM-318. Extracts the storage path ({uid}/avatar.{ext}) from a stored,
  // cache-busted avatar_url so a re-upload can best-effort remove the old
  // object when the resolved extension changed. Best-effort only: a parse
  // miss (unfamiliar URL shape, no match) is not an error, it just skips
  // the cleanup - the new upload has already succeeded either way.
  function avatarPathFromUrl(url) {
    const m = /\/avatar-photos\/([^?]+)/.exec(String(url || ""));
    return m ? m[1] : null;
  }
  // Avatar-sized, not the composer's 1600px feed-photo default: maxEdge 320,
  // no separate thumbnail (thumbEdges:[] - the render itself is already
  // small), a 60KB target with a 300KB hard cap. Deterministic overwrite
  // path (upsert:true) rather than post-photos' unique-per-upload pattern -
  // an avatar is one-per-member by convention, nothing accumulates.
  async function uploadAvatarPhoto(file) {
    if (!state.user) return null;
    const prepared = await window.HaimuniaImage.prepareImage(file, {
      maxEdge: 320, thumbEdges: [], targetBytes: 60 * 1024, hardCapBytes: 300 * 1024,
    });
    if (!prepared || !prepared.render || !prepared.render.blob) return null;
    const type = prepared.render.type || "image/webp";
    const ext = type === "image/png" ? "png" : type === "image/jpeg" ? "jpg" : "webp";
    const prevPath = state.profile ? avatarPathFromUrl(state.profile.avatar_url) : null;
    const path = `${state.user.id}/avatar.${ext}`;
    const { error } = await client.storage.from("avatar-photos").upload(path, prepared.render.blob, { contentType: type, upsert: true });
    if (error) return null;
    // Best-effort: only reached when the extension actually changed (a
    // same-extension re-upload already overwrote the object in place via
    // upsert:true above, there is nothing stale to remove).
    if (prevPath && prevPath !== path) client.storage.from("avatar-photos").remove([prevPath]).catch(() => {});
    const { data } = client.storage.from("avatar-photos").getPublicUrl(path);
    // Cache-busting belongs on the STORED url, not the bare getPublicUrl()
    // result - overwriting the same storage path means a re-upload could
    // otherwise silently fail to visibly update anywhere without it.
    return (data && data.publicUrl) ? `${data.publicUrl}?t=${Date.now()}` : null;
  }
  // Fires immediately on upload success or remove, matching
  // savePrivacyField's immediate-save pattern (a photo change is already a
  // committed action the moment the bytes are in Storage) rather than
  // saveProfile's bundled-into-form-submit pattern.
  async function saveAvatarUrl(url) {
    if (!state.user || !state.profile) return false;
    const prev = state.profile.avatar_url;
    state.profile.avatar_url = url || null;
    rerender();
    const { error } = await client.from("profiles").upsert({ id: state.user.id, avatar_url: url || null });
    if (error) { state.profile.avatar_url = prev; setMessage("שמירת התמונה נכשלה"); rerender(); return false; }
    return true;
  }
  async function avatarPhotoSelected(file) {
    if (!file || !state.user) return;
    state.avatarUpload = { status: "processing", error: "" };
    rerender();
    let url;
    try {
      url = await uploadAvatarPhoto(file);
    } catch (err) {
      state.avatarUpload = { status: "idle", error: (err && err.code === "not_an_image") ? "הקובץ אינו תמונה" : "העלאת התמונה נכשלה" };
      return rerender();
    }
    if (!url) { state.avatarUpload = { status: "idle", error: "העלאת התמונה נכשלה" }; return rerender(); }
    const ok = await saveAvatarUrl(url);
    state.avatarUpload = { status: "idle", error: ok ? "" : "" };
    rerender();
  }
  async function removeAvatarPhoto() {
    if (!state.user || !state.profile || !state.profile.avatar_url || state.avatarUpload.status === "processing") return;
    const path = avatarPathFromUrl(state.profile.avatar_url);
    state.avatarUpload = { status: "processing", error: "" };
    rerender();
    const ok = await saveAvatarUrl(null);
    if (ok && path) client.storage.from("avatar-photos").remove([path]).catch(() => {});
    state.avatarUpload = { status: "idle", error: "" };
    rerender();
  }
  function composerReadyPhotos() { return state.posts.composer ? state.posts.composer.photos.filter((p) => p.status === "ready") : []; }
  function composerCanPublish() {
    const c = state.posts.composer;
    if (!c || c.publishing) return false;
    if (c.photos.some((p) => p.status === "processing" || p.status === "failed")) return false;
    if (c.photos.length > POST_MEDIA_MAX) return false;
    const ready = composerReadyPhotos();
    const hasText = cleanPostBody(c.body).length > 0;
    if (!hasText && ready.length === 0) return false;
    if (ready.some((p) => !p.decorative && !String(p.altText || "").trim())) return false;
    return true;
  }
  function composerBlockReason() {
    const c = state.posts.composer;
    if (!c) return "";
    if (c.photos.some((p) => p.status === "processing")) return "יש להמתין לסיום עיבוד התמונות";
    if (c.photos.some((p) => p.status === "failed")) return "יש להסיר או לנסות שוב תמונה שנכשלה";
    if (composerReadyPhotos().some((p) => !p.decorative && !String(p.altText || "").trim())) return "יש להוסיף תיאור לכל תמונה או לסמן אותה כדקורטיבית";
    return "צריך טקסט או לפחות תמונה אחת";
  }
  async function publishComposer() {
    const c = state.posts.composer;
    if (!c || c.publishing) return;
    if (!composerCanPublish()) { c.error = composerBlockReason(); return rerender(); }
    c.publishing = true;
    c.error = "";
    rerender();
    const body = cleanPostBody(c.body);
    const media = composerReadyPhotos().map((p, i) => ({
      storage_path: p.storagePath,
      alt_text: p.decorative ? "" : String(p.altText || "").slice(0, ALT_TEXT_MAX),
      decorative: !!p.decorative,
      position: i,
      width: p.width || null,
      height: p.height || null,
    }));
    const links = {};
    if (c.links) {
      if (c.links.workout_id) links.workout_id = c.links.workout_id;
      if (c.links.achievement_id) links.achievement_id = c.links.achievement_id;
      if (c.links.event_id) links.event_id = c.links.event_id;
    }
    const { data, error } = await client.rpc("post_create", {
      body,
      visibility: c.visibility,
      media,
      links: Object.keys(links).length ? links : null,
    });
    if (error || !data) {
      c.publishing = false;
      c.error = "פרסום הפוסט נכשל, אפשר לנסות שוב";
      return rerender();
    }
    // COMM-102 optimistic insert. feed_page (COMM-110) is authoritative on the
    // next refresh; the legacy community_feed view does not carry post_type,
    // so we do not reload it here.
    const optimistic = {
      id: data,
      post_type: media.length && !body ? "POST_PHOTO" : "POST_TEXT",
      author_id: state.user.id,
      author: { display_name: state.profile && state.profile.display_name, handle: state.profile && state.profile.handle, avatar_url: state.profile && state.profile.avatar_url },
      body,
      visibility: c.visibility,
      created_at: new Date().toISOString(),
      media: media.map((m) => ({ ...m, url: null })),
      reaction_count: 0,
      comment_count: 0,
    };
    if (Array.isArray(state.feed.items)) state.feed.items.unshift(optimistic);
    state.posts.composer = null;
    state.posts.composerTrigger = null;
    setMessage("הפוסט פורסם");
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.POST_CREATED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.POST_CREATED, { post_id: data, post_type: optimistic.post_type }); } catch (e) {}
    }
    rerender();
  }
  function renderPostComposer() {
    const c = state.posts.composer;
    if (!c) return "";
    const bodyLen = cleanPostBody(c.body).length;
    const canPublish = composerCanPublish();
    const tiles = c.photos.map((p) => `
      <div class="composer-photo-tile" data-photo-id="${esc(p.id)}" style="border:1px solid var(--border);border-radius:12px;padding:8px;margin-bottom:8px;">
        <div class="flex" style="justify-content:space-between;align-items:center;gap:8px;">
          <span style="font-size:12px;color:var(--steel);">${p.status === "processing" ? "מעבד תמונה…" : p.status === "failed" ? esc(p.error || "נכשל") : "תמונה מוכנה"}</span>
          <button class="link-btn" data-community-action="composer-remove-photo" data-id="${esc(p.id)}" aria-label="הסרת תמונה">הסרה</button>
        </div>
        ${p.previewUrl ? `<img src="${esc(p.previewUrl)}" alt="" style="max-width:100%;border-radius:8px;margin:6px 0;"/>` : ""}
        ${p.status === "failed" ? `<button class="chip-btn" data-community-action="composer-retry-photo" data-id="${esc(p.id)}">ניסיון חוזר</button>` : ""}
        <label class="field" style="margin-top:6px;"><span class="field-label">תיאור לקורא מסך</span>
          <input class="text-input" type="text" maxlength="${ALT_TEXT_MAX}" data-composer-alt="${esc(p.id)}" value="${esc(p.altText || "")}"${p.decorative ? " disabled" : ""} placeholder="תיאור קצר של התמונה"/></label>
        <label class="flex gap-6" style="align-items:center;font-size:12px;color:var(--steel);margin-top:4px;">
          <input type="checkbox" data-composer-decorative="${esc(p.id)}"${p.decorative ? " checked" : ""}/> התמונה דקורטיבית, אין צורך בתיאור
        </label>
      </div>`).join("");
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="postComposerTitle" data-composer-overlay data-cloud-dialog="composer" style="align-items:center;padding:0 16px;">
      <div class="modal-sheet" id="postComposer" style="border-radius:22px;max-height:90vh;overflow:auto;">
        <div style="padding:22px 20px calc(env(safe-area-inset-bottom,0px) + 18px);">
          <div id="postComposerTitle" style="color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:12px;">פוסט חדש</div>
          <label class="field"><span class="field-label">מה תרצו לשתף?</span>
            <textarea class="text-input" data-composer-body maxlength="${POST_BODY_MAX}" rows="4" placeholder="כתבו משהו לקהילה" aria-describedby="postComposerCounter">${esc(c.body || "")}</textarea></label>
          <div id="postComposerCounter" data-composer-counter style="text-align:left;font-size:11px;color:var(--steel);min-height:14px;">${bodyLen >= 900 ? `${bodyLen}/${POST_BODY_MAX}` : ""}</div>
          <div style="margin-top:8px;">${tiles}</div>
          ${c.photos.length < POST_MEDIA_MAX
            ? `<label class="chip-btn" style="cursor:pointer;display:inline-block;">הוספת תמונה<input type="file" accept="image/*" data-composer-file style="display:none;"/></label>`
            : `<div style="font-size:12px;color:var(--steel);">הגעתם למקסימום ${POST_MEDIA_MAX} תמונות</div>`}
          <label class="field" style="margin-top:12px;"><span class="field-label">מי רואה את הפוסט</span>
            <select class="text-input" data-composer-visibility>
              ${POST_VISIBILITY_OPTIONS.map((o) => `<option value="${o.value}"${c.visibility === o.value ? " selected" : ""}>${o.label}</option>`).join("")}
            </select></label>
          ${c.error ? `<div class="field-error" role="alert" style="margin-top:8px;">${esc(c.error)}</div>` : ""}
          <div class="chip-row" style="margin-top:16px;">
            <button class="chip-btn" data-community-action="composer-cancel">ביטול</button>
            <button class="chip-btn primary" data-community-action="composer-publish"${canPublish ? "" : " disabled"}>${c.publishing ? "מפרסם…" : "פרסום"}</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  // ---- Per-post action menu (COMM-108) ----------------------------------
  function togglePostMenu(id) {
    state.posts.openMenu = state.posts.openMenu === id ? null : id;
    rerender();
  }
  async function postSaveToggle(postId) {
    if (!state.user) return;
    state.posts.openMenu = null;
    state.posts.savedIds = state.posts.savedIds || {};
    const wasSaved = !!state.posts.savedIds[postId];
    if (wasSaved) {
      delete state.posts.savedIds[postId];
      rerender();
      const { error } = await client.from("saved_posts").delete().eq("user_id", state.user.id).eq("post_id", postId);
      if (error) { state.posts.savedIds[postId] = true; setMessage("לא ניתן לעדכן את השמורים"); rerender(); }
      else setMessage("הוסר מהשמורים");
    } else {
      state.posts.savedIds[postId] = true;
      rerender();
      const { error } = await client.from("saved_posts").insert({ user_id: state.user.id, post_id: postId });
      if (error && error.code !== "23505") { delete state.posts.savedIds[postId]; setMessage("לא ניתן לשמור את הפוסט"); rerender(); }
      else setMessage("הפוסט נשמר");
    }
  }
  async function postHide(postId) {
    if (!state.user) return;
    state.posts.openMenu = null;
    if (Array.isArray(state.feed.items)) state.feed.items = state.feed.items.filter((p) => p && p.id !== postId);
    rerender();
    const { error } = await client.from("hidden_posts").insert({ user_id: state.user.id, post_id: postId });
    if (error && error.code !== "23505") setMessage("לא ניתן להסתיר את הפוסט");
    else setMessage("הפוסט הוסתר מהפיד שלך");
  }
  function postStartCaptionEdit(postId) {
    state.posts.openMenu = null;
    const post = findFeedPost(postId);
    state.posts.captionEdit = { postId, body: (post && post.body) || "" };
    state.posts.visibilityEdit = null;
    rerender();
  }
  async function postSaveCaption() {
    const e = state.posts.captionEdit;
    if (!e) return;
    const body = cleanPostBody(e.body);
    const { error } = await client.rpc("post_edit_caption", { post_id: e.postId, body });
    if (error) { setMessage("עריכת הכיתוב נכשלה"); return; }
    const post = findFeedPost(e.postId);
    if (post) post.body = body;
    state.posts.captionEdit = null;
    setMessage("הכיתוב עודכן");
    rerender();
  }
  function postStartVisibilityEdit(postId) {
    state.posts.openMenu = null;
    const post = findFeedPost(postId);
    state.posts.visibilityEdit = { postId, visibility: normalizeVisibility(post && post.visibility) };
    state.posts.captionEdit = null;
    rerender();
  }
  async function postApplyVisibility(visibility) {
    const e = state.posts.visibilityEdit;
    if (!e || !POST_VISIBILITY_OPTIONS.some((o) => o.value === visibility)) return;
    const { error } = await client.rpc("post_set_visibility", { post_id: e.postId, visibility });
    if (error) { setMessage("שינוי הנראוּת נכשל"); return; }
    const post = findFeedPost(e.postId);
    if (post) post.visibility = visibility;
    state.posts.visibilityEdit = null;
    setMessage("הנראוּת עודכנה");
    rerender();
  }
  async function postDeleteViaMenu(postId) {
    const { error } = await client.rpc("post_delete", { post_id: postId });
    if (error) { setMessage("מחיקת הפוסט נכשלה"); return; }
    if (Array.isArray(state.feed.items)) state.feed.items = state.feed.items.filter((p) => p && p.id !== postId);
    setMessage("הפוסט נמחק");
    rerender();
  }
  async function welcomeNewMember(postId) {
    if (!state.user) return;
    const { error } = await client.rpc("add_post_comment", { p_post_id: postId, p_body: "ברוך/ה הבא/ה למועדון! 💪" });
    setMessage(error ? "שליחת הברכה נכשלה" : "הברכה נשלחה");
    if (!error && typeof loadCommentsFor === "function") loadCommentsFor(postId);
  }

  // ---- PR share prompt (COMM-105) --------------------------------------
  const PR_PROMPT_DISMISSED_KEY = "haimunia-demo:prPromptDismissed";
  function prPromptDismissedSet() {
    try { return new Set(JSON.parse(localStorage.getItem(PR_PROMPT_DISMISSED_KEY) || "[]")); } catch (e) { return new Set(); }
  }
  function rememberPrDismissed(recordId) {
    try {
      const s = prPromptDismissedSet();
      s.add(String(recordId));
      localStorage.setItem(PR_PROMPT_DISMISSED_KEY, JSON.stringify(Array.from(s).slice(-200)));
    } catch (e) {}
  }
  // Consumes PR_CREATED from the event bus (COMM-012). Detection itself is the
  // achievements agent's COMM-132; this only reacts to the record it passes.
  function onPrCreated(payload) {
    const record = payload && (payload.record || payload);
    if (!record) return;
    const recordId = record.record_id || record.id;
    if (!recordId) return;
    if (prPromptDismissedSet().has(String(recordId))) return;
    if (!window.isCommunitySignedIn || !window.isCommunitySignedIn()) return;
    state.posts.prPrompt = { record: Object.assign({}, record, { record_id: recordId }), note: "", showNote: false, photo: null, publishing: false, error: "" };
    rerender();
  }
  function dismissPrPrompt() {
    if (state.posts.prPrompt) rememberPrDismissed(state.posts.prPrompt.record.record_id);
    state.posts.prPrompt = null;
    rerender();
  }
  async function prPromptAddPhoto(file) {
    const p = state.posts.prPrompt;
    if (!p) return;
    p.photo = { status: "processing", altText: "", decorative: false, storagePath: null, error: null, width: null, height: null, _file: file };
    rerender();
    try {
      const prepared = await window.HaimuniaImage.prepareImage(file);
      const path = await uploadPreparedPhoto(prepared);
      if (!path) throw new Error("upload_failed");
      p.photo.storagePath = path;
      p.photo.width = (prepared.render && prepared.render.width) || null;
      p.photo.height = (prepared.render && prepared.render.height) || null;
      p.photo.status = "ready";
    } catch (err) {
      p.photo.status = "failed";
      p.photo.error = err && err.code === "not_an_image" ? "הקובץ אינו תמונה" : "העלאת התמונה נכשלה";
    }
    rerender();
  }
  async function sharePrPrompt() {
    const p = state.posts.prPrompt;
    if (!p || p.publishing) return;
    if (p.photo && p.photo.status === "processing") return;
    p.publishing = true;
    p.error = "";
    rerender();
    const media = p.photo && p.photo.status === "ready" && p.photo.storagePath
      ? [{ storage_path: p.photo.storagePath, alt_text: p.photo.decorative ? "" : String(p.photo.altText || "").slice(0, ALT_TEXT_MAX), decorative: !!p.photo.decorative, position: 0, width: p.photo.width || null, height: p.photo.height || null }]
      : [];
    const { data, error } = await client.rpc("pr_share", { record_id: p.record.record_id, note: cleanPostBody(p.note), media });
    if (error || !data) { p.publishing = false; p.error = "השיתוף נכשל, אפשר לנסות שוב"; return rerender(); }
    rememberPrDismissed(p.record.record_id);
    state.posts.prPrompt = null;
    setMessage("השיא שותף לקהילה");
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.POST_CREATED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.POST_CREATED, { post_id: data, post_type: "POST_PR" }); } catch (e) {}
    }
    rerender();
  }
  function renderPrSharePrompt() {
    const p = state.posts.prPrompt;
    if (!p) return "";
    const r = p.record;
    const line = (label, val) => (val != null && val !== "") ? `<div style="font-size:12.5px;color:var(--steel);">${esc(label)}: <span class="mono" style="color:var(--brass);">${esc(val)}</span></div>` : "";
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="prPromptTitle" data-cloud-dialog="prPrompt" style="align-items:center;padding:0 16px;">
      <div class="modal-sheet" id="prPrompt" style="border-radius:22px;max-height:90vh;overflow:auto;">
        <div style="padding:22px 20px calc(env(safe-area-inset-bottom,0px) + 18px);">
          <div id="prPromptTitle" style="color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:6px;">שיא חדש זוהה. לשתף עם המועדון?</div>
          <div style="display:inline-block;font-size:11px;font-weight:800;color:#0c0c0c;background:var(--brass);border-radius:999px;padding:2px 8px;margin-bottom:8px;">PR</div>
          ${line("תרגיל", r.movement || r.movement_name)}
          ${line("תוצאה חדשה", r.new_result || r.new_value)}
          ${line("תוצאה קודמת", r.previous_result || r.previous_value)}
          ${line("שיפור", r.improvement)}
          ${p.photo ? `<div style="font-size:12px;color:var(--steel);margin-top:6px;">${p.photo.status === "ready" ? "תמונה צורפה" : p.photo.status === "processing" ? "מעבד תמונה…" : esc(p.photo.error || "העלאת התמונה נכשלה")}</div>` : ""}
          ${p.photo && p.photo.status === "ready" && !p.photo.decorative ? `<label class="field" style="margin-top:6px;"><span class="field-label">תיאור התמונה לקורא מסך</span><input class="text-input" data-pr-alt maxlength="${ALT_TEXT_MAX}" value="${esc(p.photo.altText || "")}"/></label>` : ""}
          ${p.showNote ? `<label class="field" style="margin-top:8px;"><span class="field-label">הערה</span><textarea class="text-input" data-pr-note maxlength="${POST_BODY_MAX}" rows="3">${esc(p.note || "")}</textarea></label>` : ""}
          ${p.error ? `<div class="field-error" role="alert" style="margin-top:8px;">${esc(p.error)}</div>` : ""}
          <div class="chip-row" style="margin-top:14px;">
            <button class="chip-btn primary" data-community-action="pr-share"${p.publishing || (p.photo && p.photo.status === "processing") ? " disabled" : ""}>${p.publishing ? "משתף…" : "שיתוף"}</button>
            ${p.photo ? "" : `<label class="chip-btn" style="cursor:pointer;">הוספת תמונה<input type="file" accept="image/*" data-pr-file style="display:none;"/></label>`}
            ${p.showNote ? "" : `<button class="chip-btn" data-community-action="pr-add-note">הוספת הערה</button>`}
            <button class="chip-btn" data-community-action="pr-not-now">לא עכשיו</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  // ---- Achievement engine client wiring + unlock celebration ----------
  // COMM-130/131/134. The offline app detects non-attendance milestones
  // (session count, week streak, PR count, first Rx, tenure) and hands the
  // crossed codes to claimCommunityAchievements(). That records them with the
  // ach_claim RPC (service-role ach_evaluate is unreachable from the browser
  // and never fires for a privately logged lift), then announces each row it
  // actually wrote on the product bus. onAchievementUnlocked() turns that
  // into a small in-app celebration with an optional share through ach_share.
  // Nothing here ever auto-posts.

  // Hebrew display copy for the celebration, keyed by definition code. The
  // canonical seed is docs/community/achievement-seed.md; keep this in step.
  const COMMUNITY_ACHIEVEMENT_META = {
    first_workout: { title: "האימון הראשון", explanation: "רשמת אימון ראשון ביומן.", icon: "🔥" },
    sessions_10: { title: "10 אימונים", explanation: "10 ימי אימון מתועדים.", icon: "🔥" },
    sessions_25: { title: "25 אימונים", explanation: "25 ימי אימון מתועדים.", icon: "🔥" },
    sessions_50: { title: "50 אימונים", explanation: "50 ימי אימון מתועדים.", icon: "🥉" },
    sessions_100: { title: "100 אימונים", explanation: "100 ימי אימון מתועדים.", icon: "🥈" },
    sessions_250: { title: "250 אימונים", explanation: "250 ימי אימון מתועדים.", icon: "🥇" },
    consistency_weeks_4: { title: "חודש ברצף", explanation: "רשמת אימון בכל שבוע, ארבעה שבועות ברצף.", icon: "📅" },
    consistency_weeks_12: { title: "רבעון ברצף", explanation: "רשמת אימון בכל שבוע, שנים עשר שבועות ברצף.", icon: "📅" },
    consistency_weeks_26: { title: "חצי שנה ברצף", explanation: "רשמת אימון בכל שבוע, עשרים ושישה שבועות ברצף.", icon: "📆" },
    consistency_weeks_52: { title: "שנה ברצף", explanation: "רשמת אימון בכל שבוע, חמישים ושניים שבועות ברצף.", icon: "🏆" },
    first_pr: { title: "השיא הראשון", explanation: "שיא אישי ראשון.", icon: "⭐" },
    pr_10: { title: "10 שיאים", explanation: "10 שיאים אישיים.", icon: "⭐" },
    pr_25: { title: "25 שיאים", explanation: "25 שיאים אישיים.", icon: "🌟" },
    pr_50: { title: "50 שיאים", explanation: "50 שיאים אישיים.", icon: "🌟" },
    pr_100: { title: "100 שיאים", explanation: "100 שיאים אישיים.", icon: "💫" },
    first_rx: { title: "Rx ראשון", explanation: "רשמת אימון ראשון כ-Rx.", icon: "🏋️" },
    well_rounded: { title: "אתלט שלם", explanation: "שיא לפחות בכל אחת מחמש קבוצות התרגילים.", icon: "🧩" },
    anniversary_year_1: { title: "שנה במועדון", explanation: "שנה מתאריך ההצטרפות.", icon: "🎉" },
    anniversary_year_2: { title: "שנתיים במועדון", explanation: "שנתיים מתאריך ההצטרפות.", icon: "🎉" },
    anniversary_year_3: { title: "שלוש שנים במועדון", explanation: "שלוש שנים מתאריך ההצטרפות.", icon: "🎉" },
    anniversary_year_5: { title: "חמש שנים במועדון", explanation: "חמש שנים מתאריך ההצטרפות.", icon: "🎖️" },
    first_cheer: { title: "עידוד ראשון", explanation: "שלחת עידוד ראשון לחבר/ה.", icon: "👏" },
    first_comment: { title: "תגובה ראשונה", explanation: "כתבת תגובה ראשונה.", icon: "💬" },
    supportive_10: { title: "10 עידודים", explanation: "10 עידודים ותגובות תומכות.", icon: "🤝" },
    welcomed_member: { title: "קבלת פנים", explanation: "עזרת לקבל חבר/ה חדש/ה במועדון.", icon: "🙌" },
    challenge_finisher: { title: "סיום אתגר", explanation: "השלמת אתגר מועדון.", icon: "🏁" },
    challenge_winner: { title: "מנצח/ת אתגר", explanation: "מקום ראשון באתגר מועדון.", icon: "🥇" },
  };
  function achMeta(code) { return COMMUNITY_ACHIEVEMENT_META[code] || { title: code || "עיטור חדש", explanation: "", icon: "🏅" }; }
  function achCodeOf(row) { return row && (row.code || (row.achievement_definitions && row.achievement_definitions.code)) || ""; }

  async function loadMyAchievements() {
    if (!state.user) return;
    const { data, error } = await client.from("member_achievements")
      .select("id,visibility,shared_at,unlocked_at,achievement_id,achievement_definitions(code,name,icon)")
      .eq("user_id", state.user.id)
      .order("unlocked_at", { ascending: false });
    state.achievements.mine = error ? [] : (data || []);
  }

  // Called from app.js (window.claimCommunityAchievements) with the codes it
  // just saw cross their threshold on this device. Returns the rows ach_claim
  // actually wrote, and fans each out as an ACHIEVEMENT_UNLOCKED product
  // event so the celebration and the notifications consumer both see it.
  async function claimCommunityAchievements(codes) {
    if (!state.user || !state.profile) return [];
    const list = Array.from(new Set((codes || []).map((c) => String(c)).filter(Boolean))).slice(0, 50);
    if (!list.length) return [];
    const { data, error } = await client.rpc("ach_claim", { p_codes: list });
    if (error) return [];
    const written = Array.isArray(data) ? data : (data ? [data] : []);
    if (written.length && Array.isArray(state.achievements.mine)) {
      for (const r of written) {
        if (!state.achievements.mine.some((x) => x.id === r.member_achievement_id)) {
          state.achievements.mine.unshift({ id: r.member_achievement_id, visibility: r.visibility, shared_at: null, unlocked_at: new Date().toISOString(), achievement_definitions: { code: r.code } });
        }
      }
    }
    for (const r of written) {
      if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.ACHIEVEMENT_UNLOCKED) {
        try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.ACHIEVEMENT_UNLOCKED, { code: r.code, member_achievement_id: r.member_achievement_id, visibility: r.visibility }); } catch (e) {}
      }
    }
    if (written.length) rerender();
    return written;
  }
  window.claimCommunityAchievements = claimCommunityAchievements;

  function onAchievementUnlocked(payload) {
    const code = payload && payload.code;
    if (!code) return;
    const meta = achMeta(code);
    state.achievements.unlock = {
      code,
      memberAchievementId: (payload && payload.member_achievement_id) || null,
      visibility: (payload && payload.visibility) || "club",
      title: meta.title,
      explanation: meta.explanation,
      icon: meta.icon,
      sharing: false,
      error: "",
      showNote: false,
      note: "",
    };
    rerender();
  }
  function dismissAchievementUnlock() { state.achievements.unlock = null; rerender(); }
  async function shareAchievementUnlock() {
    const a = state.achievements.unlock;
    if (!a || a.sharing) return;
    if (!a.memberAchievementId || a.visibility === "only_me") { a.error = "לא ניתן לשתף. נסו שוב."; return rerender(); }
    a.sharing = true;
    a.error = "";
    rerender();
    const { data, error } = await client.rpc("ach_share", { member_achievement_id: a.memberAchievementId, caption: cleanPostBody(a.note), media: [] });
    if (error || !data) { a.sharing = false; a.error = "לא ניתן לשתף. נסו שוב."; return rerender(); }
    if (Array.isArray(state.achievements.mine)) {
      const row = state.achievements.mine.find((r) => r.id === a.memberAchievementId);
      if (row) row.shared_at = new Date().toISOString();
    }
    // COMM-170. Sharing an achievement is a WCAM-qualifying action in its
    // own right, which is why it is tracked here and not left to the
    // POST_CREATED bridge below: the bus event records that a post exists,
    // this records that a member chose to share a decoration.
    track(A.ACHIEVEMENT_SHARED, { member_achievement_id: a.memberAchievementId, code: a.code || null, source: "unlock_sheet" });
    state.achievements.unlock = null;
    setMessage("העיטור שותף למועדון");
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.POST_CREATED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.POST_CREATED, { post_id: data, post_type: "POST_ACHIEVEMENT" }); } catch (e) {}
    }
    rerender();
  }
  function shareEarnedAchievement(memberAchievementId, code) {
    const row = (state.achievements.mine || []).find((r) => r.id === memberAchievementId);
    onAchievementUnlocked({ code: code || achCodeOf(row), member_achievement_id: memberAchievementId, visibility: row ? row.visibility : "club" });
  }

  function renderAchievementUnlockCelebration() {
    const a = state.achievements.unlock;
    if (!a) return "";
    const canShare = !!a.memberAchievementId && a.visibility !== "only_me";
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="achUnlockTitle" data-cloud-dialog="achUnlock" style="align-items:center;padding:0 16px;">
      <div class="modal-sheet" id="achUnlock" style="border-radius:22px;max-height:90vh;overflow:auto;">
        <div style="padding:22px 20px calc(env(safe-area-inset-bottom,0px) + 18px);text-align:center;">
          <div style="font-size:44px;line-height:1;margin-bottom:8px;" aria-hidden="true">${esc(a.icon)}</div>
          <div id="achUnlockTitle" style="color:var(--chalk);font-weight:800;font-size:18px;margin-bottom:4px;">עיטור חדש נפתח</div>
          <div style="color:var(--brass);font-weight:800;font-size:15px;">${esc(a.title)}</div>
          ${a.explanation ? `<div style="color:var(--steel);font-size:12.5px;margin-top:6px;">${esc(a.explanation)}</div>` : ""}
          ${a.showNote ? `<label class="field" style="margin-top:10px;text-align:right;"><span class="field-label">הערה</span><textarea class="text-input" data-ach-note maxlength="${POST_BODY_MAX}" rows="3">${esc(a.note || "")}</textarea></label>` : ""}
          ${a.error ? `<div class="field-error" role="alert" style="margin-top:8px;">${esc(a.error)}</div>` : ""}
          <div class="chip-row" style="margin-top:14px;justify-content:center;">
            ${canShare ? `<button class="chip-btn primary" data-community-action="ach-share"${a.sharing ? " disabled" : ""}>${a.sharing ? "משתף…" : "שיתוף למועדון"}</button>` : ""}
            ${canShare && !a.showNote ? `<button class="chip-btn" data-community-action="ach-add-note">הוספת הערה</button>` : ""}
            <button class="chip-btn" data-community-action="ach-not-now">לא עכשיו</button>
          </div>
        </div>
      </div>
    </div>`;
  }
  function renderMyAchievements() {
    if (!state.user || !state.profile) return "";
    // COMM-321. member_achievements_read already empties this to nothing
    // queryable once the module is off (including the caller's own past
    // unlocks, on purpose) - this keeps the section shell/header from
    // showing beside an always-empty list.
    if (!isModuleEnabled("achievements")) return "";
    const list = Array.isArray(state.achievements.mine) ? state.achievements.mine : [];
    const rowsHtml = list.map((r) => {
      const code = achCodeOf(r);
      const meta = achMeta(code);
      const share = r.shared_at
        ? `<span style="color:var(--steel);font-size:12px;">שותף</span>`
        : r.visibility === "only_me"
          ? ""
          : `<button class="chip-btn" data-community-action="ach-share-later" data-id="${esc(r.id)}" data-code="${esc(code)}">שיתוף</button>`;
      return `<div class="log-row"><span>${esc(meta.icon)} ${esc(meta.title)}</span>${share}</div>`;
    }).join("");
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--brass)", "ההישגים שלי")}${list.length ? `<div class="log-list">${rowsHtml}</div>` : `<div class="empty">אין עדיין הישגים במועדון</div>`}</div>`;
  }

  // ---- Member profile community section (COMM-180) --------------------
  async function viewCommunityProfile(userId) {
    if (!userId) return;
    state.posts.openMenu = null;
    // COMM-170. Counted on the open, not on the RPC answering: a member who
    // opened a profile that then failed to load still opened it. The
    // overlay is torn down and rebuilt on each open, so a re-render of an
    // already-open profile does not reach this line.
    track(A.PROFILE_OPENED, { user_id: userId, self: userId === (state.user && state.user.id) });
    // COMM-230. followLists holds the follower/following expand state for
    // this open profile: one entry per side, each independently
    // collapsed/loaded/erroring. Reset on every open, same as the rest of
    // profileView, so a stale expanded list from a previously viewed member
    // never bleeds into the next one.
    state.members.profileView = {
      userId, loading: true, tab: "overview", data: null, error: false,
      followLists: {
        followers: { open: false, loading: false, loaded: false, error: false, items: [] },
        // actionError is separate from error: error means the list itself
        // failed to load (the whole section falls back to the error state);
        // actionError means the list loaded fine but the last unfollow tap
        // failed, in which case the restored row stays visible and only a
        // banner is added above it - tapping "הפסקת מעקב" again is the retry.
        following: { open: false, loading: false, loaded: false, error: false, actionError: false, items: [] },
      },
    };
    rerender();
    const { data, error } = await client.rpc("community_profile", { user_id: userId });
    if (!state.members.profileView || state.members.profileView.userId !== userId) return;
    state.members.profileView.loading = false;
    if (error || !data) state.members.profileView.error = true;
    else {
      state.members.profileView.data = data;
      // COMM-160. community_profile already returns the server role; seed the
      // shared cache so the same badge shows here and on any surface opened
      // next, and resolve the roles of the authors on the Posts tab.
      if (data.role != null) state.members.roles[userId] = data.role;
      loadMemberRoles((Array.isArray(data.posts) ? data.posts : []).map((p) => p && p.author_id)).then(() => rerender());
    }
    rerender();
  }
  function closeCommunityProfile() { state.members.profileView = null; rerender(); }
  function setProfileViewTab(tab) { if (state.members.profileView) { state.members.profileView.tab = tab; rerender(); } }
  const PROFILE_ROLE_LABELS = { owner: "בעלים", admin: "מנהל/ת", staff: "צוות", head_coach: "מאמן/ת ראשי/ת", coach: "מאמן/ת", member: "חבר/ה" };

  // ==========================================================================
  // COMM-230 - following surface (follower/following lists on a profile)
  // ==========================================================================
  // The counts (follower_count/following_count) already come back from
  // community_profile, gated by the same visible_to_club check the RPC
  // applies to every other optional key - present on the caller's own
  // profile, present on another member's only when it passes, absent
  // otherwise, in which case this section renders nothing at all.
  //
  // The actual list of who is on each side is a *different* read: a direct
  // RLS select on `follows`, per the ticket's own contract (no new RPC).
  // follows_visible (202608260001) is `follower_id = auth.uid() or
  // followed_id = auth.uid()` - it returns a row only when the caller is one
  // of its two ends. For the caller's own profile that is exactly the two
  // queries below (my followers = followed_id = me, who I follow =
  // follower_id = me), so the list is complete and correct. For another
  // member's profile it is not: RLS would silently narrow "their followers"
  // down to "the one row that happens to also be me", which is not their
  // follower list, it is a coin flip that looks like one. Rather than render
  // a list that is quietly wrong, EXPAND is only offered on the caller's own
  // profile; another member's profile keeps the plain count it already had
  // pre-COMM-230. This is a deliberate scope call, not a partial
  // implementation - enumerating a third party's real follower list would
  // need a new definer RPC, which is out of this ticket's stated scope.
  const FOLLOW_LIST_ERROR_TEXT = "לא ניתן היה לעדכן את המעקב. נסו שוב.";
  const FOLLOW_LIST_EMPTY_TEXT = { followers: "עדיין אין עוקבים", following: "עדיין לא עוקבים אחרי אף אחד." };
  function followListCanExpand(pv) { return !!(pv && state.user && pv.userId === state.user.id); }
  async function loadFollowList(pv, side) {
    const st = pv.followLists[side];
    st.loading = true; st.error = false;
    rerender();
    const matchCol = side === "followers" ? "followed_id" : "follower_id";
    const idCol = side === "followers" ? "follower_id" : "followed_id";
    const { data, error } = await client.from("follows").select(idCol + ",created_at").eq(matchCol, pv.userId).order("created_at", { ascending: false });
    if (state.members.profileView !== pv) return; // the profile closed or moved on while this was in flight
    st.loading = false;
    if (error) { st.error = true; st.items = []; rerender(); return; }
    const ids = (Array.isArray(data) ? data : []).map((r) => r[idCol]).filter(Boolean);
    if (!ids.length) { st.items = []; st.loaded = true; rerender(); return; }
    const { map: byId, error: perr } = await loadProfilesById(ids, "allow_follows");
    if (state.members.profileView !== pv) return;
    if (perr) { st.error = true; st.items = []; rerender(); return; }
    // Preserve the follows-table order (most recent edge first); a member
    // hidden from this caller by RLS (blocked, or - not applicable to self,
    // but kept for symmetry - visible_to_club) simply drops out rather than
    // rendering a blank row.
    st.items = ids.map((id) => byId[id]).filter(Boolean);
    st.loaded = true;
    rerender();
    loadMemberRoles(st.items.map((m) => m.id)).then(() => rerender());
  }
  function toggleFollowListSection(side) {
    const pv = state.members.profileView;
    if (!followListCanExpand(pv) || (side !== "followers" && side !== "following")) return;
    const st = pv.followLists[side];
    st.open = !st.open;
    if (st.open && !st.loaded && !st.loading) loadFollowList(pv, side);
    rerender();
  }
  function retryFollowList(side) {
    const pv = state.members.profileView;
    if (!followListCanExpand(pv) || (side !== "followers" && side !== "following")) return;
    loadFollowList(pv, side);
  }
  // The "following" list is the one place a plain tap really does remove a
  // row: everyone in it is, by definition, someone the caller already
  // follows, so this always means unfollow, and it is a real unfollow -
  // follow() itself decides insert vs. delete. No confirmation dialog per
  // the ticket (low-stakes, reversible). Optimistic: the row disappears
  // immediately and is put back with the shared error copy if the write
  // failed - never a silent drop.
  async function unfollowFromFollowingList(userId) {
    const pv = state.members.profileView;
    if (!pv || !userId) return;
    const st = pv.followLists.following;
    const idx = st.items.findIndex((m) => m && m.id === userId);
    if (idx < 0) return;
    const removed = st.items[idx];
    st.items = st.items.slice(0, idx).concat(st.items.slice(idx + 1));
    st.actionError = false;
    rerender();
    const result = await follow(userId); // same single toggle every follow control uses
    if (state.members.profileView !== pv) return;
    if (result && result.error) {
      // Put the row back exactly where it was and say so - the list itself
      // is fine (st.error stays false), only this one tap failed, so tapping
      // "הפסקת מעקב" again on the restored row is the retry: no separate
      // control needed.
      st.items = st.items.slice(0, idx).concat([removed], st.items.slice(idx));
      st.actionError = true;
    } else {
      st.actionError = false;
    }
    rerender();
  }
  function followListSkeletonHtml() {
    const row = `<div class="log-row" aria-hidden="true"><span style="height:12px;width:52%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`;
    return `<div class="log-list" aria-busy="true" data-follow-list-skeleton="1">${row.repeat(3)}</div>`;
  }
  function followListRowHtml(m, side) {
    const name = m.display_name || (m.handle ? "@" + m.handle : "חבר/ה");
    const badge = isCoachRole(memberRole(m.id)) ? " " + coachBadgeHtml(memberRole(m.id)) : "";
    const actionBtn = side === "following"
      ? `<button class="chip-btn" data-community-action="following-unfollow" data-id="${esc(m.id)}">הפסקת מעקב</button>`
      : (m.allow_follows === false ? "" : `<button class="chip-btn" data-community-action="follow" data-id="${esc(m.id)}">מעקב</button>`);
    return `<div class="log-row"><button class="link-btn" data-community-action="view-profile" data-id="${esc(m.id)}" style="padding:0;display:flex;gap:10px;align-items:center;color:inherit;text-align:right;">${avatarHtml(name, 32, m.avatar_url)}<span style="font-weight:700;">${esc(name)}${badge}</span></button><div class="chip-row" style="margin-top:0;">${actionBtn}</div></div>`;
  }
  function followListSectionHtml(pv, side, label, count) {
    if (count == null) return "";
    if (!followListCanExpand(pv)) {
      return `<div class="log-row"><span>${esc(label)}</span><span class="mono" style="color:var(--brass);">${Number(count) || 0}</span></div>`;
    }
    const st = pv.followLists[side];
    const toggleBtn = `<button class="chip-btn" data-community-action="following-toggle" data-side="${side}" aria-expanded="${st.open ? "true" : "false"}">${esc(label)} (${Number(count) || 0})${st.open ? " ▲" : " ▼"}</button>`;
    if (!st.open) return `<div style="margin-bottom:8px;">${toggleBtn}</div>`;
    let body;
    if (st.loading && !st.loaded) body = followListSkeletonHtml();
    else if (st.error) {
      body = `<div class="empty" role="alert" data-follow-list-error="${side}">${FOLLOW_LIST_ERROR_TEXT}<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="following-retry" data-side="${side}">ניסיון חוזר</button></div></div>`;
    } else if (!st.items.length) {
      body = `<div class="empty" data-follow-list-empty="${side}">${FOLLOW_LIST_EMPTY_TEXT[side]}</div>`;
    } else {
      // A failed unfollow (following side only) keeps the list on screen
      // and restores the row - the banner is additive, never a replacement.
      const actionBanner = (side === "following" && st.actionError)
        ? `<div class="empty" role="alert" data-follow-list-action-error="1">${FOLLOW_LIST_ERROR_TEXT}</div>` : "";
      body = actionBanner + `<div class="log-list">${st.items.map((m) => followListRowHtml(m, side)).join("")}</div>`;
    }
    return `<div style="margin-bottom:14px;">${toggleBtn}<div style="margin-top:8px;">${body}</div></div>`;
  }
  // The whole "Following" tab. Absent entirely (no tab shown at all) when
  // neither count came back from community_profile - the same "an absent
  // key means the field is hidden" rule every other optional section here
  // already follows.
  function followingTabAvailable(d) { return d.follower_count != null || d.following_count != null; }
  function renderFollowingTab(pv, d) {
    return followListSectionHtml(pv, "followers", "עוקבים", d.follower_count)
      + followListSectionHtml(pv, "following", "עוקב/ת אחרי", d.following_count);
  }
  function renderCommunityProfileOverlay() {
    const pv = state.members.profileView;
    if (!pv) return "";
    const d = pv.data || {};
    const name = [d.first_name, d.last_name].filter(Boolean).join(" ") || d.display_name || (d.handle ? "@" + d.handle : "חבר/ה");
    const roleLabel = PROFILE_ROLE_LABELS[d.role] || (d.role ? esc(d.role) : "");
    const profileTabs = [
      { id: "overview", label: "סקירה" },
      { id: "progress", label: "התקדמות" },
      { id: "achievements", label: "הישגים" },
      { id: "posts", label: "פוסטים" },
    ];
    // COMM-230. Present only when community_profile actually returned at
    // least one of the two counts - the caller's own profile always has it,
    // another member's only when their visible_to_club passes, matching the
    // gating community_profile already applies to these two keys.
    if (followingTabAvailable(d)) profileTabs.push({ id: "following", label: "עוקבים" });
    const active = pv.tab || "overview";
    let bodyHtml;
    if (pv.loading) bodyHtml = `<div class="empty">טוען פרופיל…</div>`;
    else if (pv.error) bodyHtml = `<div class="empty">לא ניתן לטעון את הפרופיל.</div>`;
    else if (active === "overview") {
      const rows = [];
      if (d.training_frequency != null) rows.push(["תדירות אימונים", d.training_frequency]);
      if (d.current_streak != null) rows.push(["רצף נוכחי", "🔥 " + d.current_streak]);
      if (d.active_challenge) rows.push(["אתגר פעיל", d.active_challenge.title || d.active_challenge]);
      if (d.recent_achievement) rows.push(["הישג אחרון", d.recent_achievement.title || d.recent_achievement]);
      const recent = Array.isArray(d.recent_workouts) ? d.recent_workouts : [];
      const rowsHtml = rows.length ? `<div class="log-list">${rows.map(([k, v]) => `<div class="log-row"><span>${esc(k)}</span><span class="mono" style="color:var(--brass);">${esc(v)}</span></div>`).join("")}</div>` : "";
      const recentHtml = recent.length ? `<div class="log-list" style="margin-top:8px;">${recent.map((w) => `<div class="log-row"><span>${esc(w.title || w.name || "")}</span><span style="color:var(--steel);font-size:12px;">${esc(String(w.date || w.occurred_on || "").slice(0, 10))}</span></div>`).join("")}</div>` : "";
      bodyHtml = (rowsHtml + recentHtml) || `<div class="empty">אין מידע להצגה</div>`;
    } else if (active === "progress") {
      const prs = Array.isArray(d.prs) ? d.prs : null;
      bodyHtml = prs == null ? `<div class="empty">ההתקדמות מוסתרת</div>`
        : prs.length ? `<div class="log-list">${prs.map((x) => `<div class="log-row"><span>${esc(x.movement || x.title || "")}</span><span class="mono" style="color:var(--brass);">${esc(x.result || x.value || "")}</span></div>`).join("")}</div>`
        : `<div class="empty">אין עדיין שיאים</div>`;
    } else if (active === "achievements") {
      const ach = Array.isArray(d.achievements) ? d.achievements : null;
      bodyHtml = ach == null ? `<div class="empty">ההישגים מוסתרים</div>`
        : ach.length ? `<div class="badge-grid">${ach.map((a) => `<div class="chart-card" style="flex:0 0 auto;padding:8px 10px;">${esc(a.badge_icon || "🏅")} ${esc(a.title || "")}</div>`).join("")}</div>`
        : `<div class="empty">אין עדיין הישגים</div>`;
    } else if (active === "posts") {
      const posts = Array.isArray(d.posts) ? d.posts : [];
      bodyHtml = posts.length ? `<div class="log-list">${posts.map((pp) => renderPostCard(pp)).join("")}</div>` : `<div class="empty">אין עדיין פוסטים</div>`;
    } else {
      // COMM-230's "following" tab, only reachable when followingTabAvailable(d)
      // pushed it above.
      bodyHtml = renderFollowingTab(pv, d);
    }
    const followBtn = d.allow_follows === false ? "" : `<button class="chip-btn" data-community-action="follow" data-id="${esc(pv.userId)}">מעקב</button>`;
    // 2026-09-05. A member's bio/display name were reportable nowhere - only
    // posts and comments were. Own profile has no report button.
    const reportProfileBtn = (state.user && pv.userId === state.user.id) ? "" : `<button class="chip-btn" data-community-action="report-profile" data-id="${esc(pv.userId)}">דיווח</button>`;
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="profileViewTitle" data-cloud-dialog="profileView" style="align-items:flex-start;padding:20px 12px;">
      <div class="modal-sheet" style="border-radius:20px;max-height:88vh;overflow:auto;width:100%;max-width:520px;">
        <div style="padding:18px 18px calc(env(safe-area-inset-bottom,0px) + 16px);">
          <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div class="flex gap-10" style="align-items:center;min-width:0;">
              ${avatarHtml(name, 44, d.avatar_url)}
              <div style="min-width:0;">
                <div id="profileViewTitle" style="font-weight:800;font-size:16px;">${esc(name)}${isCoachRole(d.role) ? " " + coachBadgeHtml(d.role) : ""}</div>
                <div style="color:var(--steel);font-size:12px;">${roleLabel ? esc(roleLabel) : ""}${d.member_since ? ` · חבר/ה מאז ${esc(String(d.member_since).slice(0, 10))}` : ""}</div>
              </div>
            </div>
            <button class="link-btn" data-community-action="close-profile" aria-label="סגירה">סגירה</button>
          </div>
          <div class="chip-row" style="margin-top:0;">${followBtn}${reportProfileBtn}</div>
          <div class="subtabbar" style="margin-top:12px;">${profileTabs.map((t) => `<button class="subtabbtn${t.id === active ? " active" : ""}" data-community-action="profile-tab" data-tab="${t.id}">${t.label}</button>`).join("")}</div>
          <div style="margin-top:12px;">${bodyHtml}</div>
        </div>
      </div>
    </div>`;
  }

  // ==== COMM-140..144 notifications ====================================
  //
  // The client renders and marks read. Every notification row is created
  // server-side by a trigger or an event-bus consumer (the table has no
  // insert grant) - the full trigger set is documented in
  // docs/community/contracts.md under "Needs from schema, notifications".
  // Web push (COMM-229) is behind state.featureFlags.notifPush, default
  // off (see the state literal above): the Push option renders disabled,
  // no push_subscriptions write happens, and a stored channel of "push" is
  // read as "in_app" - see notifPushEnabled() and the web push block below
  // renderNotifPrefsPanel().
  function notifPushEnabled() { return !!(state.featureFlags && state.featureFlags.notifPush); }
  const NOTIF_PAGE_SIZE = 20;
  // COMM-141. Rows older than this are not walked by default.
  const NOTIF_RECENT_DAYS = 90;

  // The five categories, in display order, with the Hebrew heading each
  // shows in the centre.
  const NOTIF_CATEGORIES = [
    { id: "community", label: "קהילה" },
    { id: "training", label: "אימונים" },
    { id: "challenges", label: "אתגרים" },
    { id: "events", label: "אירועים" },
    { id: "club", label: "מועדון" },
  ];

  // Every notification type the server can send in V1. `mode` is how the
  // centre renders it: an immediate row stands alone, a batched row is one
  // collapsed group that expands. `pref` is the notification_preferences
  // key its delivery is gated on (COMM-144). `operational: true` means it
  // always lands in-app regardless of that preference. `icon` and `title`
  // are the client copy; the server fills `body` and `deep_link`.
  // `serverTitle: true` is the one exception: for an announcement the row's
  // stored title IS the announcement's own headline (notif_announcement_fanout
  // passes v_row.title), so it has to win over the generic client label.
  // Every OTHER type gets a hardcoded English string from notif_create -
  // 'Achievement unlocked', 'New comment on your post', 'Event cancelled' -
  // which is why the client label is preferred everywhere else. The
  // immediate/batched split here MUST match the server trigger set - see
  // the routing table in contracts.md.
  const NOTIF_TYPES = {
    comment_reply:         { category: "community",  mode: "immediate", pref: "replies",             icon: "↩️", title: "תגובה חדשה לתגובה שלך" },
    comment_on_post:       { category: "community",  mode: "immediate", pref: "comments",            icon: "💬", title: "תגובה חדשה על הפוסט שלך" },
    comment_also:          { category: "community",  mode: "batched",   pref: "comments",            icon: "💬", title: "תגובות חדשות בשיחה שהשתתפת בה" },
    mention:               { category: "community",  mode: "immediate", pref: "mentions",            icon: "@",  title: "תייגו אותך בתגובה" },
    coach_mention:         { category: "community",  mode: "immediate", pref: "mentions",            icon: "@",  title: "מאמן/ת תייג/ה אותך" },
    reaction:              { category: "community",  mode: "batched",   pref: "reactions",           icon: "🔥", title: "עידודים חדשים על הפוסט שלך" },
    feed_activity:         { category: "community",  mode: "batched",   pref: "comments",            icon: "📣", title: "פעילות חדשה בפיד" },
    achievement_unlocked:  { category: "training",   mode: "immediate", pref: "achievements",        icon: "🏅", title: "פתחת הישג חדש" },
    friend_achievement:    { category: "training",   mode: "batched",   pref: "friend_achievements", icon: "🎉", title: "חברים פתחו הישגים" },
    challenge_ending_soon: { category: "challenges", mode: "immediate", pref: "challenges",          icon: "⏳", title: "אתגר מסתיים בקרוב" },
    challenge_update:      { category: "challenges", mode: "batched",   pref: "challenges",          icon: "🏆", title: "עדכונים באתגר" },
    event_cancelled:       { category: "events",     mode: "immediate", pref: "events",              icon: "🚫", title: "אירוע בוטל" },
    announcement:          { category: "club",       mode: "immediate", pref: "announcements", operational: true, serverTitle: true, icon: "📢", title: "הודעה חשובה מהמועדון" },
    weekly_recap:          { category: "club",       mode: "batched",   pref: "weekly_recap",        icon: "📅", title: "הסיכום השבועי שלך" },
  };
  function notifTypeDef(type) { return NOTIF_TYPES[type] || null; }

  // The Preferences panel in Account lists exactly these, in this order
  // (COMM-144). Defaults: everything in_app (a missing row means in_app).
  // `note`, when present, is a short caveat rendered under the row's label -
  // used by COMM-219 so "כבוי" on `announcements` does not read as "silences
  // everything": important/urgent announcements are operational
  // (`notif_is_operational`) and always land in-app regardless of this row.
  const NOTIF_PREF_TYPES = [
    { key: "comments",            label: "תגובות על הפוסטים שלי" },
    { key: "replies",             label: "תגובות לתגובות שלי" },
    { key: "mentions",            label: "תיוגים" },
    { key: "reactions",           label: "עידודים" },
    { key: "achievements",        label: "הישגים שנפתחו" },
    { key: "friend_achievements", label: "הישגים של חברים" },
    { key: "challenges",          label: "אתגרים" },
    { key: "events",              label: "אירועים" },
    { key: "announcements",       label: "הודעות מהמועדון", note: "הודעות ברמת ❗ חשוב ו-🚨 דחוף יגיעו אליכם גם כשזה כבוי." },
    { key: "weekly_recap",        label: "סיכום שבועי" },
  ];
  const NOTIF_PREF_KEYS = new Set(NOTIF_PREF_TYPES.map((t) => t.key));
  const NOTIF_CHANNELS = ["push", "in_app", "off"];

  // The one place that says how a type is delivered given the member's
  // stored preferences. The server trigger set applies the same rule
  // (documented in contracts.md); this copy lets the centre explain a
  // type and a test pin the mapping. Returns { channel, mode, suppressed }.
  function notifRoute(type, prefs) {
    const def = NOTIF_TYPES[type];
    if (!def) return { channel: "off", mode: "immediate", suppressed: true };
    let channel = (prefs && prefs[def.pref]) || "in_app";
    if (NOTIF_CHANNELS.indexOf(channel) < 0) channel = "in_app";
    if (channel === "push" && !notifPushEnabled()) channel = "in_app";
    // Operational announcements always land in-app, muted or not.
    if (channel === "off" && def.operational) return { channel: "in_app", mode: def.mode, suppressed: false };
    return { channel: channel, mode: def.mode, suppressed: channel === "off" };
  }
  function classifyNotification(row) {
    const def = notifTypeDef(row && row.type);
    return def ? def.mode : "immediate";
  }

  function notifCutoffIso() {
    return new Date(Date.now() - NOTIF_RECENT_DAYS * 86400000).toISOString();
  }

  // --- COMM-141 unread badge -------------------------------------------
  async function loadNotifUnread() {
    if (!state.user || !client) return;
    const { data, error } = await client.rpc("notif_unread_count");
    if (!error) { state.notif.unread = Number(data) || 0; state.notif.unreadLoaded = true; rerender(); }
  }

  // --- COMM-144 per-type preferences (direct own-row RLS upsert) -------
  async function loadNotifPrefs() {
    if (!state.user || !client) return;
    const { data, error } = await client.from("notification_preferences")
      .select("type,channel").eq("user_id", state.user.id);
    const next = {};
    if (!error && Array.isArray(data)) for (const r of data) next[r.type] = r.channel;
    state.notif.prefs = next;
    state.notif.prefsLoaded = !error;
    rerender();
  }
  // --- COMM-229 web push (behind state.featureFlags.notifPush) ---------
  //
  // A browser has exactly one PushSubscription per device, shared by every
  // notification type - the per-type preference above only decides
  // whether that type routes through it (notifRoute). This block is what
  // actually asks for permission, registers the subscription with the
  // browser's push service, and writes {endpoint, keys} to
  // push_subscriptions (own-row RLS, table already shipped in
  // 202608280008 - no schema change). Actually sending a push from the
  // server is explicitly out of scope; see notif_push_send in
  // contracts.md.
  const NOTIF_PUSH_ENDPOINT_KEY = "haimunia-demo:notifPushEndpoint";

  // iOS Safari does not implement the Push API unless the app is installed
  // to the home screen (Safari 16.4+ once installed is accepted product
  // scope, per the 2026-08-30 decision - a plain browser tab is not).
  function isIOSDevice() {
    const ua = String(navigator.userAgent || "");
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }
  function isStandalonePwa() {
    return !!(navigator.standalone || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches));
  }
  // null when push can be offered in this browser context right now; a
  // Hebrew explanation otherwise, rendered as visible text under the Push
  // option (not just a title attribute) so a member on an unsupported
  // browser sees why, rather than a control that silently does nothing.
  function notifPushUnsupportedReason() {
    if (isIOSDevice() && !isStandalonePwa()) {
      return "כדי לקבל התראות דחיפה ב-iPhone/iPad יש קודם להוסיף את האפליקציה למסך הבית ולפתוח אותה משם.";
    }
    const hasApi = ("serviceWorker" in navigator) && (typeof window.PushManager !== "undefined") && (typeof Notification !== "undefined");
    if (!hasApi) return "הדפדפן הזה לא תומך בהתראות דחיפה.";
    return null;
  }
  // The VAPID public key ships base64url (cloud-config.js), the
  // uncompressed EC point PushManager.subscribe's applicationServerKey
  // expects raw bytes for.
  function vapidKeyToUint8Array(base64urlString) {
    const padding = "=".repeat((4 - (base64urlString.length % 4)) % 4);
    const base64 = (base64urlString + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }
  // Confirms whether THIS device already has a live, unrevoked
  // subscription. Checked lazily the first time a member with the flag on
  // lands on the Account tab (window.afterRenderCommunity below), never on
  // every session - the same lazy-load pattern the other flag-gated
  // Phase 2 reads use (coachEngage).
  async function loadNotifPushStatus() {
    state.notif.pushChecked = true;
    if (!state.user || !client || !notifPushEnabled() || notifPushUnsupportedReason()) { state.notif.pushSub = null; return; }
    try {
      const hasSw = "serviceWorker" in navigator;
      const reg = hasSw ? await navigator.serviceWorker.ready : null;
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        const { data, error } = await client.from("push_subscriptions")
          .select("id,endpoint").eq("endpoint", sub.endpoint).is("revoked_at", null).maybeSingle();
        state.notif.pushSub = (!error && data) ? { endpoint: sub.endpoint } : null;
        if (state.notif.pushSub) { try { localStorage.setItem(NOTIF_PUSH_ENDPOINT_KEY, sub.endpoint); } catch (e) {} }
      } else {
        state.notif.pushSub = null;
        // The browser has no live subscription right now. If this device
        // previously had one - permission revoked outside the app, or the
        // browser otherwise dropped it - the endpoint is gone for good
        // (there is no API to recover a discarded PushSubscription), so
        // the last endpoint this app itself wrote is the only thing left
        // to mark revoked_at on, matching the acceptance criterion that a
        // revoke never leaves a stale unrevoked row.
        let stale = null;
        try { stale = localStorage.getItem(NOTIF_PUSH_ENDPOINT_KEY); } catch (e) {}
        if (stale) {
          await client.from("push_subscriptions").update({ revoked_at: new Date().toISOString() }).eq("endpoint", stale).is("revoked_at", null);
          try { localStorage.removeItem(NOTIF_PUSH_ENDPOINT_KEY); } catch (e) {}
        }
      }
    } catch (err) {
      state.notif.pushSub = null;
    }
    rerender();
  }
  // Triggers the browser permission prompt - the ticket's own "loading
  // state is the prompt itself", no spinner needed. On grant, registers a
  // PushSubscription and writes {endpoint, keys}; only returns true once
  // that write has actually succeeded, which is what setNotifPref below
  // gates the preference write itself on. On denial or any failure, shows
  // the exact Hebrew copy the ticket specifies and leaves the stored
  // preference untouched, so the toggle reads whatever it already was
  // (in_app by default) - "reverts to In-app".
  async function enableNotifPush(source, prefType) {
    const reason = notifPushUnsupportedReason();
    if (reason) { setMessage(reason); return false; }
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") { setMessage("לא אושרה הרשאת התראות"); return false; }
        const pubKey = (window.HAIMUNIA_CONFIG && window.HAIMUNIA_CONFIG.notifPushVapidPublicKey) || "";
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKeyToUint8Array(pubKey) });
      }
      const json = sub.toJSON ? sub.toJSON() : sub;
      const { error } = await client.from("push_subscriptions").upsert(
        { user_id: state.user.id, endpoint: json.endpoint, keys: json.keys || {}, revoked_at: null },
        { onConflict: "endpoint" });
      if (error) { setMessage("לא אושרה הרשאת התראות"); return false; }
      state.notif.pushSub = { endpoint: json.endpoint };
      try { localStorage.setItem(NOTIF_PUSH_ENDPOINT_KEY, json.endpoint); } catch (e) {}
      // COMM-233. Only once the subscription row is actually written -
      // a granted browser permission whose upsert then failed is not an
      // opt-in, and the every-return-path-above branches leave it unsent.
      // The endpoint is a device secret and never a prop: what is measured
      // is that a member turned push on, and which control asked them to.
      track(A.PUSH_OPT_IN, { source: source || "notif_pref", pref_type: prefType || null });
      rerender();
      return true;
    } catch (err) {
      setMessage("לא אושרה הרשאת התראות");
      return false;
    }
  }
  // Explicit "turn off on this device" control (renderNotifPrefsPanel).
  // Revoking sets revoked_at rather than deleting the row, matching the
  // existing partial index `where revoked_at is null`.
  async function disableNotifPush() {
    if (!state.user || !client) return;
    try {
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          const endpoint = sub.endpoint;
          await sub.unsubscribe().catch(() => {});
          await client.from("push_subscriptions").update({ revoked_at: new Date().toISOString() }).eq("endpoint", endpoint).is("revoked_at", null);
        }
      }
    } catch (err) { /* best-effort; the device just no longer reports itself active */ }
    try { localStorage.removeItem(NOTIF_PUSH_ENDPOINT_KEY); } catch (e) {}
    state.notif.pushSub = null;
    rerender();
  }

  async function setNotifPref(type, channel) {
    if (!state.user || !NOTIF_PREF_KEYS.has(type)) return;          // unknown type is ignored
    if (NOTIF_CHANNELS.indexOf(channel) < 0) return;
    if (channel === "push") {
      if (!notifPushEnabled()) return;                              // push is disabled in V1 default
      if (notifPushUnsupportedReason()) return;                     // the control itself renders disabled for this case
      if (!state.notif.pushSub) {
        const ok = await enableNotifPush("notif_pref", type);
        if (!ok) return;                                            // permission denied/failed: leaves the stored channel untouched
      }
    }
    const prev = state.notif.prefs[type];
    if (prev === channel) return;
    state.notif.prefs[type] = channel;
    state.notif.prefSaving[type] = true;
    rerender();
    const { error } = await client.from("notification_preferences").upsert(
      { user_id: state.user.id, type: type, channel: channel, updated_at: new Date().toISOString() },
      { onConflict: "user_id,type" });
    delete state.notif.prefSaving[type];
    if (error) {
      if (prev == null) delete state.notif.prefs[type]; else state.notif.prefs[type] = prev;
      setMessage("לא ניתן לשמור העדפה זו");
      return;
    }
    rerender();
  }

  // --- COMM-140 the centre: open, page, mark read --------------------
  async function openNotifCenter() {
    if (!state.user || !client) return;
    state.notif.center = {
      loading: true, error: false, rows: [], cursor: null, end: false, hasOlder: false,
      loadingMore: false, moreError: false, expanded: {}, showOlder: false, _focused: false,
      returnFocus: "feed-notifications",
    };
    rerender();
    await fetchNotifPage(true);
  }
  function closeNotifCenter() {
    const back = state.notif.center && state.notif.center.returnFocus;
    state.notif.center = null;
    rerender();
    if (back) {
      const el = document.querySelector('[data-community-action="' + back + '"]');
      if (el && el.focus) el.focus();
    }
  }
  async function fetchNotifPage(first) {
    const c = state.notif.center;
    if (!c) return;
    if (!first && (c.loadingMore || c.end)) return;
    if (first) { c.loading = true; c.error = false; } else { c.loadingMore = true; c.moreError = false; }
    rerender();
    const { data, error } = await client.rpc("notif_list", { p_cursor: c.cursor, p_limit: NOTIF_PAGE_SIZE });
    if (!state.notif.center || state.notif.center !== c) return;
    if (error) {
      if (first) { c.loading = false; c.error = true; } else { c.loadingMore = false; c.moreError = true; }
      rerender();
      return;
    }
    const raw = Array.isArray(data) ? data : [];
    let rows = raw.slice();
    let hitOld = false;
    if (!c.showOlder) {
      const cut = notifCutoffIso();
      const keep = [];
      for (const r of rows) { if (r.created_at && r.created_at < cut) { hitOld = true; break; } keep.push(r); }
      rows = keep;
    }
    for (const r of rows) { r._wasUnread = !r.read_at; c.rows.push(r); }
    if (rows.length) c.cursor = rows[rows.length - 1].created_at;
    c.end = hitOld || raw.length < NOTIF_PAGE_SIZE;
    c.hasOlder = hitOld;
    c.loading = false; c.loadingMore = false;
    rerender();
    // COMM-140. Opening the centre marks the rows it just showed as seen.
    if (first) markNotifsSeen(rows);
  }
  async function loadMoreNotifs() { await fetchNotifPage(false); }
  async function notifShowOlder() {
    const c = state.notif.center;
    if (!c) return;
    c.showOlder = true; c.end = false; c.hasOlder = false;
    await fetchNotifPage(false);
  }
  async function markNotifsSeen(rows) {
    const targets = (rows || []).filter((r) => !r.read_at);
    if (!targets.length) return;
    const ids = targets.map((r) => r.id);
    const stamp = new Date().toISOString();
    for (const r of targets) r.read_at = stamp;
    const prevUnread = Number(state.notif.unread) || 0;
    state.notif.unread = Math.max(0, prevUnread - ids.length);
    rerender();
    for (let i = 0; i < ids.length; i += 100) {
      const { error } = await client.rpc("notif_mark_read", { p_ids: ids.slice(i, i + 100) });
      if (error) { for (const r of targets) r.read_at = null; state.notif.unread = prevUnread; rerender(); return; }
    }
  }
  async function markAllNotifsRead() {
    const c = state.notif.center;
    if (!c) return;
    const targets = c.rows.filter((r) => !r.read_at);
    if (!targets.length) return;
    const ids = targets.map((r) => r.id);
    const stamp = new Date().toISOString();
    for (const r of targets) r.read_at = stamp;
    const prevUnread = Number(state.notif.unread) || 0;
    state.notif.unread = Math.max(0, prevUnread - ids.length);
    rerender();
    for (let i = 0; i < ids.length; i += 100) {
      const { error } = await client.rpc("notif_mark_read", { p_ids: ids.slice(i, i + 100) });
      if (error) { for (const r of targets) r.read_at = null; state.notif.unread = prevUnread; loadNotifUnread(); rerender(); return; }
    }
  }
  async function markNotifRead(id) {
    const c = state.notif.center;
    const row = c && c.rows.find((r) => r.id === id);
    if (!row || row.read_at) return;
    // Optimistic with rollback (COMM-141).
    row.read_at = new Date().toISOString();
    state.notif.unread = Math.max(0, (Number(state.notif.unread) || 0) - 1);
    rerender();
    const { error } = await client.rpc("notif_mark_read", { p_ids: [id] });
    if (error) {
      row.read_at = null;
      state.notif.unread = (Number(state.notif.unread) || 0) + 1;
      setMessage("לא ניתן לסמן כנקרא");
      rerender();
    }
  }

  // --- COMM-140/141 deep links ---------------------------------------
  // The one place that turns a stored in-app route into a real
  // navigation. The route convention is documented in contracts.md;
  // source_type/source_id is the fallback when deep_link is absent.
  function resolveNotifTarget(row) {
    const link = String((row && row.deep_link) || "");
    const qi = link.indexOf("?");
    const path = (qi >= 0 ? link.slice(0, qi) : link).replace(/\/+$/, "");
    const q = {};
    if (qi >= 0) for (const part of link.slice(qi + 1).split("&")) {
      const eqp = part.indexOf("=");
      if (eqp < 0) continue;
      q[decodeURIComponent(part.slice(0, eqp))] = decodeURIComponent(part.slice(eqp + 1));
    }
    const st = row && row.source_type;
    const sid = row && row.source_id;
    // COMM-214/COMM-140. q.event has to be checked before the generic
    // /feed path fallback, the same way q.announcement already is one line
    // below: an event_cancelled notification's deep link is
    // /community/feed?event=<id>, which matches /\/feed(\/|$)/ just as
    // much as a plain feed link does. Without this guard it always fell
    // into the first branch and opened plain feed instead of the event -
    // found by the schema agent while building the cancellation trigger
    // (202608290009).
    if (q.post || st === "post" || st === "comment" || /\/feed(\/|$)/.test(path) && !q.announcement && !q.event) {
      return { tab: "feed", post: q.post || (st === "post" ? sid : null), comment: q.comment || (st === "comment" ? sid : null) };
    }
    if (q.user || st === "profile") return { tab: "account", profile: q.user || sid };
    if (q.challenge || st === "challenge" || /\/boards(\/|$)/.test(path)) return { tab: "boards", challenge: q.challenge || sid };
    if (q.ma || q.achievement || st === "achievement" || /\/achievements(\/|$)/.test(path)) return { tab: "account", achievement: q.ma || q.achievement || sid };
    if (q.announcement || st === "announcement" || /\/announcement/.test(path)) return { tab: "feed", announcement: q.announcement || sid };
    if (q.event || st === "event" || /\/events(\/|$)/.test(path)) return { tab: "feed", event: q.event || sid };
    // COMM-220/221. weekly_recap's own deep link is /community/recap?week=<monday>.
    if (q.week || st === "weekly_recap" || /\/recap(\/|$)/.test(path)) return { tab: "account", recapWeek: q.week || null };
    return { tab: "feed" };
  }
  // COMM-140/COMM-229. The one place that actually navigates once a target
  // has been resolved - shared by tapping a row in the centre (openNotif,
  // which additionally marks it read first) and by a push notification's
  // click (communityHandlePushDeepLink below, which has no stored row to
  // mark read). Pulled out as its own function rather than duplicated so
  // there is exactly one navigation path to keep correct.
  function navigateToNotifTarget(target) {
    setCommunityTab(target.tab || "feed");
    if (target.post) {
      state.engagement.openComments[target.post] = true;
      if (target.comment) state.engagement.openReplies[target.comment] = true;
      rerender();
      setTimeout(() => {
        const sel = '[data-post-id="' + String(target.post).replace(/"/g, '\\"') + '"]';
        const node = document.querySelector(sel);
        if (node && node.scrollIntoView) node.scrollIntoView({ block: "center" });
      }, 60);
    } else if (target.event) {
      openEvent(target.event, "notification");
    } else if (target.profile) {
      viewCommunityProfile(target.profile);
    } else if (target.recapWeek !== undefined) {
      openRecap(target.recapWeek || null, "notification");
    } else {
      rerender();
    }
  }
  async function openNotif(id) {
    const c = state.notif.center;
    const row = c && c.rows.find((r) => r.id === id);
    if (!row) return;
    const target = resolveNotifTarget(row);
    // COMM-170. Before the await, so a slow mark-read cannot lose the
    // event, and once per row because the centre closes right after.
    // was_unread reads the flag the fetch stamped, not read_at: opening
    // the centre already marks every row it showed as seen, so read_at is
    // false for everything by the time a member taps one.
    track(A.NOTIFICATION_OPENED, { notification_id: id, type: row.type || null, target: target.tab || null, was_unread: !!row._wasUnread });
    await markNotifRead(id);
    closeNotifCenter();
    navigateToNotifTarget(target);
  }
  // COMM-229. Reached from two places: sw.js's notificationclick handler
  // posting back to an already-open window (see app.js's serviceWorker
  // "message" listener), and window.__pendingPushDeepLink - a ?notif=
  // query param app.js captures at boot for the "no window was open, the
  // service worker opened a fresh one" cold-start case, consumed once the
  // session is ready (refreshSession below). Both hand back the same
  // deep_link string notifications.deep_link already uses, so this reuses
  // resolveNotifTarget - the one place that turns a route into a
  // navigation - rather than a second parser. There is no notification id
  // to mark read here: a real push payload is not necessarily backed by a
  // row the centre has ever loaded.
  function communityHandlePushDeepLink(deepLink) {
    if (!deepLink || !state.user) return;
    // The Community sub-tab (setCommunityTab, inside navigateToNotifTarget)
    // is not the same as app.js's own top-level tab bar (add/history/
    // calendar/wod/community) - a push notification can arrive while a
    // completely different top-level tab is open. cloud.js has no direct
    // reference into app.js's own `tab`/`render` (they are two separate
    // <script> evaluations in the test harness, and reaching past
    // window.* into another script's bare bindings is not a pattern used
    // anywhere else in this codebase - see window.renderCommunityApp for
    // the actual convention: app.js calls INTO cloud.js through window,
    // never the reverse). A real click on the existing tab button is the
    // same DOM-level bridge every other cross-file test in this repo
    // already relies on.
    const topBtn = document.getElementById("tabCommunityBtn");
    if (topBtn && !topBtn.classList.contains("active")) topBtn.click();
    navigateToNotifTarget(resolveNotifTarget({ deep_link: deepLink }));
  }
  window.communityHandlePushDeepLink = communityHandlePushDeepLink;

  // --- COMM-209 / COMM-227 realtime wiring ---------------------------
  // Every channel below is opened through HaimuniaRealtime (COMM-014), never
  // by reaching past it to the raw client, so setCommunityTab's single
  // teardownAll() closes all of them on a view change. Each handler
  // re-fetches through the surface's existing load path instead of applying
  // the payload row: the payload is one raw table row with no profile join,
  // no block filtering and no server-side aggregation, so applying it
  // directly would render a different (and sometimes wrong) view than a
  // manual refresh of the same screen. Re-fetching keeps exactly one
  // rendering path per surface.
  //
  // Every re-fetch is debounced, so a burst of rows (a coach entering ten
  // members' progress, a post getting twenty reactions) costs one query,
  // not one per row.
  const REALTIME_DEBOUNCE_MS = 400;
  const realtimeTimers = {};
  function realtimeDebounce(key, fn, wait) {
    if (realtimeTimers[key]) clearTimeout(realtimeTimers[key]);
    realtimeTimers[key] = setTimeout(function () {
      delete realtimeTimers[key];
      try { fn(); } catch (err) { console.error("[realtime] refresh failed for " + key, err); }
    }, wait == null ? REALTIME_DEBOUNCE_MS : wait);
  }
  // Teardown has to cancel pending refreshes too. A timer that survives a
  // view change would fire a query against a screen nobody is looking at,
  // which is the same leak the channel registry exists to prevent.
  function clearRealtimeDebounces() {
    for (const key of Object.keys(realtimeTimers)) { clearTimeout(realtimeTimers[key]); delete realtimeTimers[key]; }
  }
  function realtimeChannelOpen(name) {
    if (!window.HaimuniaRealtime || typeof window.HaimuniaRealtime.list !== "function") return false;
    return window.HaimuniaRealtime.list().some((ch) => ch.name === name);
  }

  // COMM-209. Two channels per open challenge detail, both filtered to that
  // challenge id (postgres_changes supports eq filters, and a detail screen
  // is one id), well under MAX_SUBSCRIPTIONS = 10. Closing the detail or
  // opening a different one closes the previous pair.
  function challengeRealtimeNames(id) { return ["chal-progress-" + id, "chal-participants-" + id]; }
  function ensureChallengeRealtime() {
    if (!state.user || !client || !window.HaimuniaRealtime) return;
    const openId = state.challenges.view && state.challenges.view.id;
    if (state.challenges._rtId && state.challenges._rtId !== openId) {
      for (const name of challengeRealtimeNames(state.challenges._rtId)) window.HaimuniaRealtime.unsubscribe(name);
      state.challenges._rtId = null;
    }
    if (!openId) return;
    const [progressName, participantsName] = challengeRealtimeNames(openId);
    // Re-arm after teardownAll() the same way the notification channel
    // does: the registry, not a local flag, is the source of truth for
    // whether a channel is actually open.
    if (state.challenges._rtId === openId && realtimeChannelOpen(progressName) && realtimeChannelOpen(participantsName)) return;
    window.HaimuniaRealtime.subscribe(progressName,
      { table: "challenge_progress", event: "INSERT", filter: "challenge_id=eq." + openId },
      function () { onChallengeRealtime(openId); });
    window.HaimuniaRealtime.subscribe(participantsName,
      { table: "challenge_participants", event: "UPDATE", filter: "challenge_id=eq." + openId },
      function () { onChallengeRealtime(openId); });
    state.challenges._rtId = openId;
  }
  function onChallengeRealtime(id) {
    realtimeDebounce("chal-" + id, function () {
      // The detail may have closed between the event and this timer.
      if (!state.challenges.view || state.challenges.view.id !== id) return;
      // chal_progress() is the server's aggregation; re-reading it is what
      // keeps the bar and the leaderboard equal to what a refresh shows,
      // rather than a client-side sum of deltas that drifts.
      refreshChallengeView(id);
    });
  }

  // COMM-227. Two shared channels per feed session, not one per card:
  // postgres_changes filters only support eq, and a feed page is twenty
  // posts, so twenty filtered channels would blow the ten-channel cap.
  // Incoming rows are filtered here against what is actually rendered.
  //
  // Re-checked for a 200-user launch: a server-side `filter` on club_id
  // was considered and rejected, not overlooked. Neither table carries a
  // club_id column (reactions/post_comments only have post_id, user_id,
  // kind/body, created_at), and this product is one club by deliberate
  // decision (docs/community/backlog.md, "Club model... approved. Keep
  // club_id, one club row, no multi-tenant") - every one of the 200 users
  // is in the same club, so a club-level filter would not reduce fanout at
  // all even if the column existed. There is no column on either table
  // that both exists and would narrow broadcast without recreating the
  // per-post-channel problem this comment already rejected. The real lever
  // here is confirming the actual Supabase plan's realtime message-volume
  // and concurrent-connection limits against real usage, not a code change -
  // see 2026-09-05 launch-readiness audit.
  function ensureFeedRealtime() {
    if (!state.user || !client || !window.HaimuniaRealtime) return;
    if (state.ui.tab !== "feed") return;
    if (!realtimeChannelOpen("feed-comments")) {
      window.HaimuniaRealtime.subscribe("feed-comments", { table: "post_comments", event: "INSERT" }, onFeedCommentRealtime);
    }
    if (!realtimeChannelOpen("feed-reactions")) {
      window.HaimuniaRealtime.subscribe("feed-reactions", { table: "reactions", event: "*" }, onFeedReactionRealtime);
    }
  }
  // A postgres_changes payload carries `new` on INSERT/UPDATE and `old` on
  // DELETE; a reaction removal is a DELETE, so both are read here.
  function realtimePostId(payload) {
    const rec = payload && (payload.new || payload.record || payload.old || payload.old_record);
    const postId = rec && rec.post_id;
    return postId && findFeedPost(postId) ? postId : null;
  }
  function onFeedCommentRealtime(payload) {
    const postId = realtimePostId(payload);
    // Only a thread the member has open. A closed thread has nothing to
    // append to and re-fetching it would be a query nobody asked for.
    if (!postId || !state.engagement.openComments[postId]) return;
    realtimeDebounce("comments-" + postId, function () {
      if (!state.engagement.openComments[postId] || !findFeedPost(postId)) return;
      // loadCommentsFor() is the initial load path, so the new rows get the
      // same block-edge and moderation-status handling (and the same author
      // profile join and coach-role lookup) the first render applied.
      loadCommentsFor(postId);
    });
  }
  function onFeedReactionRealtime(payload) {
    const postId = realtimePostId(payload);
    if (!postId) return;
    realtimeDebounce("reactions-" + postId, function () {
      if (!findFeedPost(postId)) return;
      // A card whose strip was never loaded (no reactions yet) needs the
      // first load; one already loaded needs a re-read of the same query.
      if (state.engagement.reactions[postId]) loadReactionsFor(postId);
      else ensureReactionsLoaded(postId);
    });
  }

  // --- COMM-141 realtime own-row refresh ----------------------------
  function ensureNotifRealtime() {
    if (!state.user || !client || !window.HaimuniaRealtime) return;
    const name = "notif-" + state.user.id;
    const listed = typeof window.HaimuniaRealtime.list === "function"
      ? window.HaimuniaRealtime.list().some((ch) => ch.name === name) : false;
    if (state.notif._rtUid === state.user.id && listed) return;
    window.HaimuniaRealtime.subscribe(name,
      { table: "notifications", event: "*", filter: "user_id=eq." + state.user.id },
      onNotifRealtime);
    state.notif._rtUid = state.user.id;
  }
  function onNotifRealtime(payload) {
    const evt = payload && (payload.eventType || payload.type);
    const rec = payload && (payload.new || payload.record);
    if (evt === "INSERT" && rec) {
      if (!rec.read_at) state.notif.unread = (Number(state.notif.unread) || 0) + 1;
      const c = state.notif.center;
      if (c && !c.rows.some((r) => r.id === rec.id)) { rec._wasUnread = !rec.read_at; c.rows.unshift(rec); }
      rerender();
      return;
    }
    // UPDATE or DELETE or an unknown shape: reconcile against the server.
    loadNotifUnread();
  }

  // --- COMM-140/142 rendering --------------------------------------
  function renderNotifRow(r) {
    const def = notifTypeDef(r.type) || { icon: "🔔", title: r.title || "התראה" };
    const emphasise = !!r._wasUnread;
    // The client label wins over the stored one. notif_create() is called
    // with a hardcoded ENGLISH title for every immediate type except
    // announcement ('Achievement unlocked', 'New comment on your post',
    // 'Event cancelled', ...), so taking r.title first leaked English into
    // an otherwise all-Hebrew centre. announcement is the one type whose
    // stored title is real per-row content rather than a type label, and
    // NOTIF_TYPES marks it serverTitle. r.title remains the last resort for
    // a future type this client does not know, the same fallback
    // renderNotifBatchGroup already relies on.
    const title = esc((def.serverTitle && r.title) || def.title || r.title || "");
    const bodyHtml = r.body ? `<span style="display:block;color:var(--steel);font-size:12.5px;margin-top:2px;">${esc(r.body)}</span>` : "";
    return `<button class="log-row" data-community-action="notif-open" data-id="${esc(r.id)}" data-notif-mode="${esc(def.mode || "immediate")}" style="width:100%;text-align:right;background:none;border:0;border-inline-start:3px solid ${emphasise ? "var(--energy)" : "transparent"};padding:8px 10px;cursor:pointer;display:flex;gap:10px;align-items:flex-start;">
      <span aria-hidden="true" style="font-size:18px;line-height:1.2;">${esc(def.icon)}</span>
      <span style="flex:1;min-width:0;">
        <span style="display:block;font-weight:${emphasise ? "800" : "600"};font-size:13px;">${title}</span>
        ${bodyHtml}
        <span style="display:block;color:var(--steel);font-size:11px;margin-top:3px;">${esc(relativeTime(r.created_at))}</span>
      </span>
    </button>`;
  }
  // COMM-142. A batched notification renders as one collapsed row that
  // expands. Consecutive rows of the same batched type fold into one
  // group. Windows are server-side; this only renders what came back.
  function renderNotifBatchGroup(group, c) {
    const def = notifTypeDef(group[0].type) || { icon: "🔔", title: group[0].title || "התראה" };
    const key = group[0].type + ":" + group[0].id;
    const open = !!c.expanded[key];
    const emphasise = group.some((g) => g._wasUnread);
    return `<div class="notif-group${emphasise ? " emphasise" : ""}" data-notif-group="${esc(key)}">
      <button class="link-btn" data-community-action="notif-toggle-group" data-key="${esc(key)}" aria-expanded="${open ? "true" : "false"}" style="display:flex;gap:10px;align-items:center;width:100%;text-align:right;padding:8px 10px;">
        <span aria-hidden="true" style="font-size:18px;">${esc(def.icon)}</span>
        <span style="flex:1;min-width:0;">
          <span style="display:block;font-weight:${emphasise ? "800" : "600"};font-size:13px;">${esc(def.title)}${group.length > 1 ? " · " + group.length : ""}</span>
          <span style="display:block;color:var(--steel);font-size:11px;margin-top:3px;">${esc(relativeTime(group[0].created_at))}</span>
        </span>
        <span aria-hidden="true">${open ? "▲" : "▼"}</span>
      </button>
      ${open ? `<div class="notif-group-body">${group.map(renderNotifRow).join("")}</div>` : ""}
    </div>`;
  }
  function renderNotifCategoryRows(rows, c) {
    const out = [];
    let i = 0;
    while (i < rows.length) {
      const r = rows[i];
      if (classifyNotification(r) !== "batched") { out.push(renderNotifRow(r)); i++; continue; }
      const group = [r];
      let j = i + 1;
      while (j < rows.length && rows[j].type === r.type) { group.push(rows[j]); j++; }
      i = j;
      out.push(renderNotifBatchGroup(group, c));
    }
    return out.join("");
  }
  function notifRowCategory(r) {
    const def = notifTypeDef(r.type);
    return (def && def.category) || r.category || "community";
  }
  function renderNotificationCenter() {
    const c = state.notif.center;
    if (!c) return "";
    let body;
    if (c.loading && !c.rows.length) {
      body = `<div class="log-list" aria-busy="true">${`<div class="log-row" aria-hidden="true"><span style="height:12px;width:70%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`.repeat(5)}</div>`;
    } else if (c.error && !c.rows.length) {
      body = `<div class="empty">לא ניתן לטעון התראות.<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="notif-retry">ניסיון חוזר</button></div></div>`;
    } else if (!c.rows.length) {
      body = `<div class="empty">אין עדיין התראות.</div>`;
    } else {
      body = NOTIF_CATEGORIES.map((cat) => {
        const rows = c.rows.filter((r) => notifRowCategory(r) === cat.id);
        if (!rows.length) return "";
        return `<div class="ach-section" style="margin-top:14px;">${sectionHead("var(--blue)", cat.label)}<div class="log-list">${renderNotifCategoryRows(rows, c)}</div></div>`;
      }).join("");
    }
    const moreHtml = c.rows.length && !c.end
      ? `<div class="chip-row" style="justify-content:center;margin-top:10px;"><button class="chip-btn" data-community-action="notif-load-more"${c.loadingMore ? " disabled" : ""}>${c.loadingMore ? "טוען…" : c.moreError ? "ניסיון חוזר" : "טעינת עוד"}</button></div>`
      : "";
    const olderHtml = c.end && c.hasOlder && !c.showOlder
      ? `<div class="chip-row" style="justify-content:center;margin-top:6px;"><button class="link-btn" data-community-action="notif-show-older">הצגת התראות ישנות יותר</button></div>`
      : "";
    const canMarkAll = c.rows.some((r) => !r.read_at);
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="notifCenterTitle" data-notif-center data-cloud-dialog="notifCenter" style="align-items:flex-start;padding:20px 12px;">
      <div class="modal-sheet" style="border-radius:20px;max-height:88vh;overflow:auto;width:100%;max-width:520px;">
        <div style="padding:18px 18px calc(env(safe-area-inset-bottom,0px) + 16px);">
          <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:6px;">
            <div id="notifCenterTitle" style="font-weight:800;font-size:16px;">התראות</div>
            <button class="link-btn" data-community-action="notif-close" aria-label="סגירה">סגירה</button>
          </div>
          <div class="chip-row" style="margin-top:0;margin-bottom:4px;"><button class="link-btn" data-community-action="notif-mark-all"${canMarkAll ? "" : " disabled"}>סימון הכול כנקרא</button></div>
          ${body}
          ${moreHtml}
          ${olderHtml}
        </div>
      </div>
    </div>`;
  }

  // COMM-144/229. The Preferences panel, rendered in the Account tab.
  function renderNotifPrefsPanel() {
    // COMM-229. pushOn mirrors the state.featureFlags.notifPush check every
    // other push code path uses; pushReason is null when push can actually
    // be offered right now, "בקרוב" when the flag itself is off (the V1
    // default - unchanged copy/behavior from before this ticket), and a
    // real Hebrew explanation (unsupported browser, or iOS Safari without
    // an installed PWA) when the flag is on but this browser can't do it -
    // rendered as visible text, not just a title, so it is never a
    // silent failed prompt.
    const pushOn = notifPushEnabled();
    const pushReason = pushOn ? notifPushUnsupportedReason() : "בקרוב";
    const pushDisabled = !!pushReason;
    const rowFor = (t) => {
      const stored = state.notif.prefs[t.key] || "in_app";
      const eff = (stored === "push" && !pushOn) ? "in_app" : stored;
      const saving = !!state.notif.prefSaving[t.key];
      const btn = (ch, label, disabled, title) =>
        `<button type="button" class="chip-btn${eff === ch ? " selected" : ""}" data-community-action="notif-pref" data-type="${t.key}" data-channel="${ch}"${(disabled || saving) ? " disabled" : ""}${disabled && title ? ` aria-disabled="true" title="${esc(title)}"` : ""}>${label}</button>`;
      const noteHtml = t.note ? `<span style="color:var(--steel);font-size:11px;">${esc(t.note)}</span>` : "";
      // Populated (COMM-229 frontend states): an active subscription on
      // THIS device shows "פעיל" next to the push option, only for a row
      // whose effective channel actually is push. Empty (push never opted
      // into) renders no badge at all - the row looks exactly like any
      // other channel, per the ticket's own wording.
      const pushBadge = (pushOn && eff === "push" && state.notif.pushSub)
        ? `<span style="color:var(--green);font-size:11px;">פעיל</span>` : "";
      // Explanatory text, visible (not just a tooltip), only when the flag
      // is on but this browser genuinely cannot do push right now.
      const explainHtml = (pushOn && pushDisabled)
        ? `<span style="color:var(--steel);font-size:11px;">${esc(pushReason)}</span>` : "";
      return `<div class="log-row" style="flex-direction:column;align-items:stretch;gap:6px;">
        <span style="font-size:13px;">${esc(t.label)}</span>
        ${noteHtml}
        <div class="chip-row" role="group" aria-label="${esc(t.label)}" style="margin-top:0;">
          ${btn("push", pushOn ? "התראת דחיפה" : "התראת דחיפה · בקרוב", pushDisabled, pushDisabled ? pushReason : null)}
          ${pushBadge}
          ${btn("in_app", "באפליקציה", false)}
          ${btn("off", "כבוי", false)}
        </div>
        ${explainHtml}
      </div>`;
    };
    const rows = state.notif.prefsLoaded
      ? NOTIF_PREF_TYPES.map(rowFor).join("")
      : `<div class="log-row" aria-hidden="true"><span style="height:12px;width:60%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`.repeat(4);
    // COMM-229. One device-level control, not one per row: a
    // PushSubscription is per browser/device, so "turn push off" is a
    // single action here rather than duplicated ten times. Shown only once
    // the flag is on and this device actually has an active subscription.
    const deviceStatusHtml = (pushOn && state.notif.pushSub)
      ? `<div class="chip-row" style="margin-top:0;margin-bottom:8px;align-items:center;"><span style="font-size:12px;color:var(--steel);">התראות דחיפה פעילות במכשיר זה.</span><button type="button" class="link-btn" data-community-action="notif-push-disable">כיבוי במכשיר זה</button></div>`
      : "";
    const introHtml = pushOn
      ? "בחרו איך כל סוג התראה מגיע אליכם. הודעות תפעוליות מהמועדון תמיד יופיעו כאן, גם אם כיביתם אותן."
      : "בחרו איך כל סוג התראה מגיע אליכם. התראות דחיפה יגיעו בגרסה הבאה. הודעות תפעוליות מהמועדון תמיד יופיעו כאן, גם אם כיביתם אותן.";
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--brass)", "העדפות התראות")}
      <div style="color:var(--steel);font-size:12px;line-height:1.6;margin-bottom:8px;">${introHtml}</div>
      ${deviceStatusHtml}
      <div class="log-list">${rows}</div>
    </div>`;
  }

  window.notifRoute = notifRoute;
  window.classifyNotification = classifyNotification;
  window.notifResolveTarget = resolveNotifTarget;

  // Composed cloud overlay: the confirm sheet plus every posts-cluster dialog,
  // rendered by app.js after every tab so a PR prompt or an open composer is
  // not tied to the Community tab being active.
  // COMM-234 QA sweep: renderConfirmSheet() used to be concatenated FIRST
  // here, which put it EARLIER in DOM order than every other overlay this
  // function renders. All of them share the same .modal-overlay class and
  // the same fixed z-index:50 (index.html), so two open at once stack by
  // DOM order, not by which one is logically "on top" - a later sibling
  // paints over an earlier one. askConfirm() is meant to be a modal-on-modal
  // confirmation nested inside whatever triggered it (leave-challenge fires
  // it while challengeView is still open, event-cancel while eventView is
  // still open, composer-discard while the post composer is still open,
  // etc.), so it has to render LAST, not first - a real Chromium browser
  // check caught this (jsdom's programmatic .click() has no hit-testing, so
  // every existing node test clicked straight through the invisible overlap
  // and never noticed a real user cannot reach the confirm button at all in
  // this state). See scripts/browser-check/community-challenge-lifecycle.mjs.
  function renderConfirmDialog() {
    return renderPostComposer() + renderPrSharePrompt() + renderAchievementUnlockCelebration() + renderCommunityProfileOverlay() + renderNotificationCenter()
      + renderReportSheet() + renderModActionSheet() + renderModContextOverlay() + renderChallengeViewOverlay() + renderEventViewOverlay() + renderRecapViewOverlay()
      + renderConfirmSheet();
  }
  // COMM-151. The report reason sheet. Reasons are a fixed list, an optional
  // capped free-text note, and a plain acknowledgement that discloses
  // nothing about what happens next.
  function renderReportSheet() {
    const s = state.admin.reportSheet;
    if (!s) return "";
    if (s.done) {
      return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="reportSheetTitle" data-cloud-dialog="reportSheet" style="align-items:center;padding:0 20px;">
        <div class="modal-sheet" style="border-radius:22px;max-height:none;">
          <div style="padding:24px 22px calc(env(safe-area-inset-bottom,0px) + 20px);">
            <div id="reportSheetTitle" style="color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:8px;">הדיווח התקבל.</div>
            <div class="chip-row" style="margin-top:8px;"><button class="chip-btn primary" data-community-action="report-close">סגירה</button></div>
          </div>
        </div>
      </div>`;
    }
    const reasons = REPORT_REASONS.map((r) => `<label class="log-row" style="justify-content:space-between;gap:12px;cursor:pointer;">
      <span style="font-size:13px;">${r.label}</span>
      <input type="radio" name="reportReason" data-report-reason="${r.id}"${s.reason === r.id ? " checked" : ""} aria-label="${esc(r.label)}"/>
    </label>`).join("");
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="reportSheetTitle" data-cloud-dialog="reportSheet" style="align-items:center;padding:0 20px;">
      <div class="modal-sheet" style="border-radius:22px;max-height:none;">
        <div style="padding:24px 22px calc(env(safe-area-inset-bottom,0px) + 20px);">
          <div id="reportSheetTitle" style="color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:12px;">דיווח על ${s.targetType === "comment" ? "תגובה" : "פוסט"}</div>
          <div class="log-list">${reasons}</div>
          <label class="field" style="margin-top:12px;"><span class="field-label">פרטים נוספים (רשות)</span>
            <textarea class="text-input" data-report-note maxlength="500" placeholder="אפשר להוסיף הקשר">${esc(s.note || "")}</textarea></label>
          ${s.error ? `<div class="footer-note" role="alert" style="color:var(--red);">${esc(s.error)}</div>` : ""}
          <div class="chip-row" style="margin-top:12px;">
            <button class="chip-btn" data-community-action="report-close">ביטול</button>
            <button class="chip-btn primary" data-community-action="report-submit"${s.saving ? " disabled" : ""}>${s.saving ? "שולח…" : "שליחת דיווח"}</button>
          </div>
        </div>
      </div>
    </div>`;
  }
  // COMM-153. The queue action sheet: a confirm with an optional note, plus
  // a duration picker for a temporary restriction. Every decision here is
  // handed to mod_review().
  function renderModActionSheet() {
    const a = state.admin.modAction;
    if (!a) return "";
    const def = MOD_DECISIONS.find((d) => d.id === a.decision) || { label: a.decision };
    const days = a.decision === "restrict_temp" ? `<label class="field" style="margin-top:10px;"><span class="field-label">משך ההגבלה</span>
      <div class="chip-row" style="margin:0;">${RESTRICT_TEMP_DAYS.map((d) => `<button class="chip-btn${a.days === d ? " selected" : ""}" data-community-action="mod-action-days" data-days="${d}">${d} ימים</button>`).join("")}</div></label>` : "";
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="modActionTitle" data-cloud-dialog="modAction" style="align-items:center;padding:0 20px;">
      <div class="modal-sheet" style="border-radius:22px;max-height:none;">
        <div style="padding:24px 22px calc(env(safe-area-inset-bottom,0px) + 20px);">
          <div id="modActionTitle" style="color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:8px;">${esc(def.label)}</div>
          ${days}
          <label class="field" style="margin-top:10px;"><span class="field-label">הערה (רשות)</span>
            <textarea class="text-input" data-mod-note maxlength="500" placeholder="נרשמת ביומן">${esc(a.note || "")}</textarea></label>
          ${a.error ? `<div class="footer-note" role="alert" style="color:var(--red);">${esc(a.error)}</div>` : ""}
          <div class="chip-row" style="margin-top:12px;">
            <button class="chip-btn" data-community-action="mod-action-cancel">ביטול</button>
            <button class="chip-btn primary${def.destructive ? " danger" : ""}" data-community-action="mod-action-run"${a.saving ? " disabled" : ""}>${a.saving ? "מבצע…" : "אישור"}</button>
          </div>
        </div>
      </div>
    </div>`;
  }
  // COMM-152. "View context" opens the reported content in place. Light by
  // design: the excerpt the queue row already carries plus a shortcut into
  // the feed for a post.
  function renderModContextOverlay() {
    const c = state.admin.modContext;
    if (!c) return "";
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="modContextTitle" data-cloud-dialog="modContext" style="align-items:center;padding:0 20px;">
      <div class="modal-sheet" style="border-radius:22px;max-height:none;">
        <div style="padding:24px 22px calc(env(safe-area-inset-bottom,0px) + 20px);">
          <div id="modContextTitle" style="color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:8px;">הקשר הדיווח</div>
          <div style="color:var(--steel);font-size:12.5px;">${esc(c.target_type === "comment" ? "תגובה" : "פוסט")} מאת ${esc(c.content_author_name || "חבר/ה שהוסר/ה")}</div>
          <div class="chart-card" style="margin-top:8px;white-space:pre-wrap;">${esc(String(c.content_excerpt || "התוכן הוסר"))}</div>
          ${Array.isArray(c.reporters) && c.reporters.length ? `<div style="color:var(--steel);font-size:12px;margin-top:8px;">דווח ע״י: ${c.reporters.map((r) => esc(r.name || r.id)).join(", ")}</div>` : ""}
          <div class="chip-row" style="margin-top:12px;">
            <button class="chip-btn" data-community-action="mod-context-close">סגירה</button>
            ${c.target_type === "post" ? `<button class="chip-btn primary" data-community-action="mod-context-open-feed">פתיחה בפיד</button>` : ""}
          </div>
        </div>
      </div>
    </div>`;
  }

  window.renderCommunityApp = function () {
    if (!configured) return `<div class="chart-card"><div style="font-weight:800;font-size:18px;margin-bottom:8px;">הקהילה מוכנה לחיבור</div><div style="color:var(--steel);font-size:13px;line-height:1.7;">יש ליצור פרויקט Supabase, להריץ את קובץ המיגרציה ולהכניס URL ומפתח publishable בקובץ cloud-config.js. אין להכניס מפתח secret.</div></div>`;
    if (!state.user || (state.user.is_anonymous && !state.signupStarted)) {
      // Two real entry points, both visible at once: log into an existing
      // account (any device, same identity), or start fresh with a club
      // invite code. Nothing happens silently *from this screen* — but
      // state.user can already be a real (anonymous) session by the time
      // anyone opens this tab: maybeAutoStartBackup() (Settings > protect
      // my data) may have already created a backup-only session off the
      // back of a saved set, with no invite code and no Community
      // involvement at all. The is_anonymous + !signupStarted check keeps
      // that person on this same neutral login-or-start choice instead of
      // skipping straight to "enter your invite code" as if they had
      // clicked start-signup — ensureAnonymousSession() below still
      // no-ops for them since a session already exists.
      if (!state.signupStarted) return `<div class="chart-card"><div style="font-weight:800;font-size:18px;margin-bottom:6px;">כניסה לקהילה</div><div style="color:var(--steel);font-size:12.5px;line-height:1.7;margin-bottom:14px;">התחברות עם שם המשתמש והסיסמה משחזרת את הפרופיל, העוקבים, הסנכרון הפרטי והרשאות הצוות — גם ממכשיר חדש או אחרי מחיקת נתונים.</div><form id="communityLogin">${field("communityLogin", "username", "שם משתמש", `<input class="text-input" name="username" dir="ltr" autocapitalize="off" autocomplete="username" placeholder="שם משתמש" required/>`)}${field("communityLogin", "password", "סיסמה", `<input class="text-input" name="password" type="password" dir="ltr" autocomplete="current-password" placeholder="סיסמה" required/>`)}<button class="save-btn" type="submit" style="margin-top:12px;">התחברות ושחזור החשבון</button></form><button class="link-btn" data-community-action="start-signup" style="display:block;margin:18px auto 0;">חבר/ה חדש/ה? התחלת הרשמה עם קוד הזמנה</button>${state.ui.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${esc(state.ui.message)}</div>` : ""}</div>`;
      ensureAnonymousSession();
      return `<div class="chart-card"><div style="font-weight:800;font-size:18px;margin-bottom:6px;">מתחברים לקהילה…</div><div style="color:var(--steel);font-size:13px;">שנייה אחת.</div>${state.ui.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${esc(state.ui.message)}</div>` : ""}</div>`;
    }
    if (!state.redemption) return `<div class="chart-card"><div style="font-weight:800;font-size:18px;margin-bottom:6px;">קוד הזמנה למועדון</div><div style="color:var(--steel);font-size:13px;margin-bottom:14px;">הקהילה פתוחה רק למי שקיבל/ה קוד הזמנה מהמאמן/ת. הקוד לא נוגע לרישום האימונים עצמו — הוא רק פותח את לשונית הקהילה.</div><form id="communityInviteCode">${field("communityInviteCode", "code", "קוד הזמנה", `<input class="text-input" name="code" dir="ltr" placeholder="קוד הזמנה" required/>`)}<button class="save-btn" type="submit" style="margin-top:12px;">אישור קוד</button></form>${state.ui.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${esc(state.ui.message)}</div>` : ""}</div>`;
    // Right after the code, before anything else — this is what turns the
    // bootstrap anonymous session into a real, log-in-from-any-device
    // account. state.user.is_anonymous flips to false the moment
    // setCredentials() succeeds, so a returning user (who logged in with
    // real credentials to begin with) never sees this screen at all.
    if (state.user.is_anonymous) return `<div class="chart-card"><div style="font-weight:800;font-size:18px;margin-bottom:6px;">יצירת חשבון</div><div style="color:var(--steel);font-size:13px;margin-bottom:14px;">שם משתמש וסיסמה — כדי שתוכלו להתחבר שוב מכל מכשיר.</div><form id="communityCredentials">${field("communityCredentials", "username", "שם משתמש", `<input class="text-input" name="username" dir="ltr" autocapitalize="off" autocomplete="username" placeholder="אותיות אנגליות, ספרות או קו תחתון" required/>`)}${field("communityCredentials", "password", "סיסמה", `<input class="text-input" name="password" type="password" dir="ltr" autocomplete="new-password" placeholder="לפחות 8 תווים" required/>`)}${field("communityCredentials", "passwordConfirm", "אימות סיסמה", `<input class="text-input" name="passwordConfirm" type="password" dir="ltr" autocomplete="new-password" placeholder="הקלידו שוב" required/>`)}<button class="save-btn" type="submit" style="margin-top:12px;">יצירת חשבון</button></form>${state.ui.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${esc(state.ui.message)}</div>` : ""}</div>`;
    // Without this gate, a fresh code-redeemer landed straight on the Feed
    // sub-tab — mostly empty, nothing prompting them to the profile form
    // buried in Account — with no clear signal anything had actually been
    // saved. Now profile creation is unskippable, same pattern as the
    // gates above it: this screen is all there is until a profile exists,
    // and the whole screen changing to the real tabbed UI afterward is the
    // confirmation, not just a toast that's easy to miss.
    if (!state.profile) return `<div class="chart-card"><div style="font-weight:800;font-size:18px;margin-bottom:6px;">השלמת פרופיל</div><div style="color:var(--steel);font-size:13px;margin-bottom:14px;">כמעט סיימתם — עוד רגע אחד ותהיו בפנים.</div><form id="communityProfile">${field("communityProfile", "handle", "שם משתמש (handle)", `<input class="text-input" name="handle" dir="auto" placeholder="למשל דנה_כהן" required/>`)}<label class="field"><span class="field-label">שם תצוגה</span><input class="text-input" name="displayName" placeholder="שם תצוגה"/></label><label class="field"><span class="field-label">קצת עליי</span><textarea class="text-input" name="bio" maxlength="160" placeholder="כמה מילים עליי"></textarea></label><button class="save-btn" type="submit" style="margin-top:12px;">שמירת פרופיל</button></form>${state.ui.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${esc(state.ui.message)}</div>` : ""}</div>`;
    // COMM-016. Credentials are set and the profile row exists, but the
    // account has not been stamped recoverable yet, so is_community_member()
    // still blocks every write. Try once automatically (guarded inside
    // verifyRecovery so it cannot loop), then leave a manual retry. The
    // invite is already redeemed here and is never re-attempted, so a
    // failed verification does not consume it - the member can retry or
    // sign in again later on any device.
    if (!state.profile.recovery_verified_at) {
      verifyRecovery();
      return `<div class="chart-card"><div style="font-weight:800;font-size:18px;margin-bottom:6px;">אבטחת החשבון</div>
        <div style="color:var(--steel);font-size:13px;line-height:1.7;margin-bottom:14px;">כדי להשתתף בקהילה — לפרסם, להגיב, לעודד ולהצטרף לאתגרים — נדרש חשבון שאפשר לשחזר. שם המשתמש והסיסמה שהגדרתם הם דרך השחזור: הם מאפשרים להתחבר לאותו פרופיל מכל מכשיר, גם אחרי החלפת טלפון או מחיקת נתונים. עד להשלמת האימות אפשר לצפות בקהילה בלבד.</div>
        <button class="save-btn" data-community-action="verify-recovery" style="margin-top:2px;">אימות והמשך</button>
        ${state.ui.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${esc(state.ui.message)}</div>` : ""}</div>`;
    }
    const p = state.profile || {};
    const staff = isStaff();

    // ---- Feed tab: announcements (+ today's pinned note), the social
    // feed with comments, sharing, comparisons ----
    // COMM-218. Defensive mirror of announcements_read's expiry predicate -
    // see isAnnouncementExpired(). RLS is the real boundary; this only
    // keeps a long-open session from showing a since-expired row without a
    // refetch.
    const liveAnnouncements = state.club.announcements.filter((a) => !isAnnouncementExpired(a));
    const pinnedToday = liveAnnouncements.find((a) => a.pinned_date === todayIso());
    const pinnedHtml = pinnedToday ? `<div class="chart-card admin-card" style="margin-bottom:12px;${announcementAccentStyle(pinnedToday)}"><div style="font-weight:800;margin-bottom:6px;display:flex;align-items:center;flex-wrap:wrap;gap:6px;">📌 הערת האימון להיום${announcementPriorityBadge(pinnedToday)}</div><div style="font-weight:700;">${esc(pinnedToday.title)}</div><div style="color:var(--steel);font-size:13px;margin-top:4px;">${esc(pinnedToday.body)}</div></div>` : "";
    // COMM-321. announcements_read already empties liveAnnouncements above
    // once the module is off; the composer form has no data of its own to
    // fall silent through, so it needs its own explicit gate.
    const announceComposer = staff ? (!isModuleEnabled("announcements") ? "" : `<form id="communityAnnouncement" class="chart-card admin-card" style="margin-top:10px;"><div style="font-weight:800;margin-bottom:10px;">הודעה חדשה למועדון<span class="admin-tag">ניהול</span></div>${field("communityAnnouncement", "title", "כותרת", `<input class="text-input" name="title" placeholder="כותרת" required/>`)}${field("communityAnnouncement", "body", "תוכן", `<textarea class="text-input" name="body" maxlength="2000" placeholder="תוכן ההודעה" required></textarea>`)}<label class="field"><span class="field-label">רמת חשיבות</span><select class="text-input" name="priority">${ANNOUNCEMENT_PRIORITY_OPTIONS.map((o) => `<option value="${o.value}"${o.value === "normal" ? " selected" : ""}>${o.label}</option>`).join("")}</select></label>${field("communityAnnouncement", "expiresAt", "תפוגה (אופציונלי)", `<input class="text-input" name="expiresAt" type="datetime-local" placeholder="ללא תפוגה"/>`)}<label class="field flex gap-6" style="align-items:center;"><input type="checkbox" name="pinToday"/><span style="font-size:12.5px;color:var(--steel);">סמן כהערת האימון להיום</span></label><button class="chip-btn primary" type="submit"${state.club.announcementSaving ? " disabled" : ""} style="margin-top:10px;">${state.club.announcementSaving ? "מפרסם…" : "פרסום הודעה"}</button></form>`) : "";
    const otherAnnouncements = liveAnnouncements.filter((a) => a !== pinnedToday);
    // COMM-155. A staff holder of community.content.pin gets a pin toggle on
    // each announcement. Post, challenge and event pin affordances live on
    // their own surfaces (posts and Phase 2 clusters); the strip and unpin
    // control render for every one of the four target types.
    const canPinContent = hasPerm(PERM.CONTENT_PIN);
    const isPinned = (type, id) => state.admin.pins.some((p) => p.target_type === type && p.target_id === id);
    const announcementsList = otherAnnouncements.length ? `<div class="log-list">${otherAnnouncements.map((a) => `<div class="log-row" style="align-items:flex-start;flex-direction:column;gap:4px;${announcementAccentStyle(a)}"><div style="font-weight:700;display:flex;align-items:center;flex-wrap:wrap;gap:6px;">${esc(a.title)}${announcementPriorityBadge(a)}</div><div style="color:var(--steel);font-size:13px;">${esc(a.body)}</div><div style="color:var(--steel);font-size:11px;">${esc(a.profiles ? (a.profiles.display_name || "@" + a.profiles.handle) : "")}</div>${canPinContent ? `<button class="link-btn" data-community-action="${isPinned("announcement", a.id) ? "unpin" : "pin"}" data-type="announcement" data-id="${esc(a.id)}" data-note="${esc(a.title)}" style="margin:2px 0 0;">${isPinned("announcement", a.id) ? "ביטול הצמדה" : "הצמדה למעלה"}</button>` : ""}</div>`).join("")}</div>` : (pinnedToday ? "" : `<div class="empty">אין הודעות חדשות</div>`);
    const announcementsHtml = `<div class="ach-section">${sectionHead("var(--brass)", "הודעות מהמועדון")}${pinnedHtml}${announcementsList}${announceComposer}</div>`;

    // Sharing itself no longer lives here - it was a standing list of the
    // 8 most recent shareable results eating vertical space at the top of
    // the feed you open to see *other* people's posts. It's now
    // triggered from wherever a specific result actually lives (Calendar,
    // Progress) via renderShareControl(), collapsed to a single icon
    // until tapped.

    // COMM-115. The club strip: mark, name, member count, the active
    // challenge shortcut and the notification bell. Every value comes from
    // club_summary(); a failed read degrades to the compose button alone,
    // which is why this whole block is behind `state.club.row`.
    const club = state.club.row || null;
    const clubMark = club && club.image_url
      ? `<img src="${esc(club.image_url)}" alt="" style="width:44px;height:44px;border-radius:14px;object-fit:cover;"/>`
      : avatarHtml((club && club.name) || "המועדון", 44);
    const activeChallenge = club && club.active_challenge ? club.active_challenge : null;
    // COMM-141. notif_unread_count() drives the badge; club_summary's
    // count is only a first-paint fallback until that RPC resolves.
    const unread = state.notif.unreadLoaded
      ? Number(state.notif.unread) || 0
      : Number((club && club.unread_notifications) || 0);
    // COMM-140. The bell opens the notification centre.
    const bellHtml = `<button class="chip-btn" data-community-action="feed-notifications" aria-label="התראות${unread ? `, ${unread} חדשות` : ""}" aria-haspopup="dialog" style="position:relative;">🔔${unread ? `<span class="tab-badge" aria-hidden="true">${unread}</span>` : ""}</button>`;
    const clubTopHtml = club ? `<div class="chart-card" id="communityClubTop" style="margin-bottom:12px;">
      <div class="flex" style="justify-content:space-between;align-items:center;gap:10px;">
        <div class="flex gap-10" style="align-items:center;min-width:0;">
          ${clubMark}
          <div style="min-width:0;">
            <div style="font-weight:800;font-size:16px;">${esc(club.name || "המועדון")}</div>
            <div style="color:var(--steel);font-size:12px;">${Number(club.member_count || 0)} חברי מועדון</div>
          </div>
        </div>
        ${bellHtml}
      </div>
      ${activeChallenge ? `<div class="chip-row" style="margin-top:10px;"><button class="chip-btn primary" data-community-action="open-active-challenge" data-id="${esc(activeChallenge.id || "")}">🏆 ${esc(activeChallenge.title || "אתגר פעיל")}</button></div>` : ""}
    </div>` : "";
    // COMM-217: the soonest published, non-cancelled upcoming event, or
    // nothing at all - never an empty placeholder.
    const upcomingEventHtml = renderUpcomingEventCard();
    // COMM-307: who else logged a session today, or - far more often -
    // nothing at all. Same chart-card shell and same "renders nothing"
    // omission style as the upcoming-event card above; it sits ABOVE the feed
    // list rather than beside that card because it is a post-class moment
    // ("right after logging a session, a member sees who else trained today")
    // and a moment buried under twenty ranked posts is not a moment.
    // renderClassmatesTodayCard() is the only thing that decides whether it
    // exists, so there is no branch here.
    const classmatesTodayHtml = renderClassmatesTodayCard();

    // COMM-111 filter chips. My Classes is rendered disabled, tied to
    // COMM-P01, and setFeedScope refuses it on the way in as well.
    const filterHtml = `<div class="chip-row" id="communityFeedFilters" role="tablist" aria-label="סינון הפיד" style="margin:0 0 10px;">${FEED_SCOPES.map((s) => s.parked
      ? `<button class="chip-btn" data-community-action="feed-scope" data-scope="${s.id}" disabled aria-disabled="true" title="בקרוב, ממתין למודול הנוכחות">${esc(s.label)} · בקרוב</button>`
      : `<button class="chip-btn${state.feed.scope === s.id ? " selected" : ""}" data-community-action="feed-scope" data-scope="${s.id}" role="tab" aria-selected="${state.feed.scope === s.id ? "true" : "false"}" tabindex="${state.feed.scope === s.id ? "0" : "-1"}">${esc(s.label)}</button>`).join("")}</div>`;

    const feed = state.feed.loading && !state.feed.items.length
      ? `<div class="log-list" aria-busy="true">${renderPostCardSkeleton().repeat(3)}</div>`
      : state.feed.error && !state.feed.items.length
      ? `<div class="empty">לא ניתן לטעון את פיד המועדון.<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="feed-retry">ניסיון חוזר</button></div></div>`
      : state.feed.items.length ? `<div class="log-list" id="communityFeedList">${state.feed.items.map((post) => post && post.post_type ? renderPostCard(post) : `<article class="chart-card post-card">
      <div class="post-head">${avatarHtml(post.display_name || post.handle, 36, (post.author && post.author.avatar_url) || post.avatar_url)}<div class="post-head-text"><div class="post-author">${nameHtml(post.display_name, post.handle)}</div><div class="post-time">${relativeTime(post.published_at)}</div></div></div>
      <div class="post-title">${esc(post.title)}</div>
      <div class="mono post-result">${esc(post.result_text)}</div>
      ${post.photo_path && photoUrlCache[post.photo_path] ? `<img src="${photoUrlCache[post.photo_path]}" alt="" class="post-photo"/>` : ""}
      <div class="chip-row post-actions">
        <button class="chip-btn" data-community-action="cheer" data-id="${esc(post.id)}" aria-label="עידוד, ${Number(post.cheer_count || 0)} עידודים">🔥 ${Number(post.cheer_count || 0)}</button>
        <button class="chip-btn" data-community-action="toggle-comments" data-id="${esc(post.id)}" aria-label="תגובות, ${Number(post.comment_count || 0)}">💬 ${Number(post.comment_count || 0)}</button>
        ${post.comparison_key ? `<button class="chip-btn${state.posts.comparisonForPostId === post.id ? " selected" : ""}" data-community-action="compare" data-key="${esc(post.comparison_key)}" data-id="${esc(post.id)}">השוואה</button>` : ""}
        ${post.author_id === (state.user && state.user.id) ? `<button class="chip-btn" data-community-action="delete-post" data-id="${esc(post.id)}">הסרה</button>` : `<button class="chip-btn" data-community-action="report" data-id="${esc(post.id)}">דיווח</button>`}
      </div>
      ${state.posts.comparisonForPostId === post.id ? `<div class="log-list" style="margin-top:10px;">${state.posts.comparison.length ? state.posts.comparison.map((item, index) => `<div class="log-row"><span>${index + 1}. ${nameHtml(item.display_name, item.handle)}</span><span class="mono" style="color:var(--brass);">${esc(item.result_text)}</span></div>`).join("") : `<div class="empty">אין עדיין תוצאות להשוואה</div>`}</div>` : ""}
      ${renderComments(post)}</article>`).join("")}</div>` : `<div class="empty">${esc(feedScopeDef(state.feed.scope).empty || "פעילות המועדון תופיע כאן.")}</div>`;
    // COMM-113. The sentinel is what IntersectionObserver watches; the
    // button under it is the same call for keyboard and for anywhere the
    // observer is unavailable. Reaching the end is a quiet marker, never an
    // error.
    const feedMoreHtml = !state.feed.items.length ? ""
      : state.feed.end ? `<div class="footer-note" style="text-align:center;margin-top:10px;">הגעתם לסוף. הכול מעודכן.</div>`
      : `<div id="communityFeedSentinel" style="height:1px;"></div>
        ${state.feed.moreError ? `<div class="footer-note" role="alert" style="text-align:center;color:var(--red);">לא ניתן היה לטעון עוד.</div>` : ""}
        <div class="chip-row" style="justify-content:center;margin-top:8px;"><button class="chip-btn" data-community-action="feed-load-more"${state.feed.loadingMore ? " disabled" : ""}>${state.feed.loadingMore ? "טוען…" : state.feed.moreError ? "ניסיון חוזר" : "טעינת עוד"}</button></div>`;
    const composeBtn = `<button class="chip-btn primary" data-community-action="open-composer" style="margin:0 0 10px;">כתיבת פוסט</button>`;
    const feedHtml = `<div class="ach-section">${sectionHead("var(--blue)", "הפיד שלי")}${composeBtn}${filterHtml}${classmatesTodayHtml}${feed}${upcomingEventHtml}${feedMoreHtml}</div>`;

    // COMM-155. The pinned strip sits above everything else on the Club home.
    const feedTab = renderPinnedStrip() + renderOnboardingStep() + clubTopHtml + announcementsHtml + feedHtml;

    // ---- Boards tab: weekly challenge + streaks, top-3-plus-your-rank ----
    const challengeSetter = staff ? `<form id="communityWeeklyChallenge" class="chart-card admin-card" style="margin-top:10px;"><div style="font-weight:800;margin-bottom:10px;">קביעת אתגר שבועי<span class="admin-tag">ניהול</span></div>${field("communityWeeklyChallenge", "title", "שם האתגר", `<input class="text-input" name="title" placeholder="שם האתגר" required/>`)}${field("communityWeeklyChallenge", "comparisonKey", "מפתח השוואה", `<input class="text-input" name="comparisonKey" dir="ltr" placeholder="movement:back-squat:est1rm" required/>`)}<div style="color:var(--steel);font-size:11px;margin:-6px 0 10px;">חייב להתחיל ב-movement: (תרגיל) או wod: (אימון) — בדיוק כמו שהוא נשמר בשיתופים, למשל movement:back-squat:est1rm או wod:fran:time:rx</div><div class="flex gap-16 field">${field("communityWeeklyChallenge", "startsOn", "תאריך התחלה", `<input class="text-input" name="startsOn" type="date" required/>`)}${field("communityWeeklyChallenge", "endsOn", "תאריך סיום", `<input class="text-input" name="endsOn" type="date" required/>`)}</div><button class="chip-btn primary" type="submit" style="margin-top:10px;">קביעת אתגר</button></form>` : "";
    const weeklyLeaderboardList = state.club.weeklyChallenge ? renderRankedList(state.club.weeklyLeaderboard, (it) => it.author_id, (it) => esc(it.result_text)) : `<div class="empty">אין אתגר פעיל כרגע</div>`;
    // COMM-018. A quick "hide my result" affordance right on the board.
    // It flips in_leaderboards, the same column the Privacy panel toggles;
    // full removal from the ranked views is enforced server-side once the
    // leaderboard views filter on the column (see report notes).
    const hideMyResult = state.profile && state.profile.in_leaderboards
      ? `<button class="link-btn" data-community-action="hide-my-leaderboard-result" style="display:block;margin:8px auto 0;">הסתרת התוצאה שלי מהטבלאות</button>`
      : (state.profile ? `<div class="footer-note" style="margin:8px 0 0;">התוצאה שלך מוסתרת מהטבלאות. אפשר להחזיר אותה בהגדרות הפרטיות.</div>` : "");
    const weeklyChallengeHtml = `<div class="ach-section">${sectionHead("var(--teal)", state.club.weeklyChallenge ? `אתגר השבוע: ${esc(state.club.weeklyChallenge.title)}` : "אתגר השבוע")}${weeklyLeaderboardList}${hideMyResult}${challengeSetter}</div>`;

    // COMM-210/212. The consistency board, server-ranked through
    // feed_leaderboard, replaces the old community_streaks strip that used to
    // sit here (see renderConsistencyLeaderboardSection for why).
    const streaksHtml = renderConsistencyLeaderboardSection();

    const boardsTab = renderChallengesListSection() + renderEventsListSection() + weeklyChallengeHtml + streaksHtml;

    // ---- Account tab: profile, member search, admin member management ----
    // COMM-318. Uploading/failed states mirror the composer photo-attach
    // flow's own state machine and error copy - not a new pattern.
    const au = state.avatarUpload;
    const avatarBusy = au.status === "processing";
    const avatarControl = `<div class="flex gap-10" style="align-items:center;margin-bottom:14px;">
      ${avatarHtml(p.display_name || p.handle, 56, p.avatar_url)}
      <div class="flex gap-6" style="align-items:center;flex-wrap:wrap;">
        <label class="chip-btn" style="cursor:pointer;display:inline-block;${avatarBusy ? "opacity:.6;pointer-events:none;" : ""}">${avatarBusy ? "מעלה…" : "העלאת תמונה"}<input type="file" accept="image/*" data-avatar-file style="display:none;"${avatarBusy ? " disabled" : ""}/></label>
        ${p.avatar_url ? `<button class="chip-btn" type="button" data-community-action="avatar-remove"${avatarBusy ? " disabled" : ""}>הסרת תמונה</button>` : ""}
      </div>
    </div>
    ${au.error ? `<div class="field-error" role="alert" style="margin-bottom:10px;">${esc(au.error)}</div>` : ""}`;
    const account = `<form id="communityProfile" class="chart-card"><div style="font-weight:800;font-size:16px;margin-bottom:12px;">הפרופיל שלי</div>
      ${avatarControl}
      ${field("communityProfile", "handle", "שם משתמש (handle)", `<input class="text-input" name="handle" dir="auto" value="${esc(p.handle || "")}" placeholder="למשל דנה_כהן" required/>`)}
      <label class="field"><span class="field-label">שם תצוגה</span><input class="text-input" name="displayName" value="${esc(p.display_name || "")}" placeholder="שם תצוגה"/></label>
      <label class="field"><span class="field-label">קצת עליי</span><textarea class="text-input" name="bio" maxlength="160" placeholder="כמה מילים עליי">${esc(p.bio || "")}</textarea></label>
      <div class="chip-row"><button class="chip-btn primary" type="submit">שמירת פרופיל</button><button class="chip-btn" type="button" data-community-action="migrate">סנכרון היסטוריה פרטית</button></div>
    </form>`;

    // COMM-018 Privacy panel. Values render straight off state.profile;
    // each toggle change is persisted by savePrivacyField() as a direct
    // own-row RLS upsert (listener wired in afterRenderCommunity). The
    // skeleton branch is a formality - the gates above guarantee a loaded
    // profile before this tab renders.
    const privacyRows = state.profile
      ? PRIVACY_FIELDS.map((f) => `<label class="log-row" style="justify-content:space-between;gap:12px;cursor:pointer;"><span style="font-size:13px;">${f.label}</span><input type="checkbox" data-privacy-field="${f.key}"${state.profile[f.key] ? " checked" : ""} aria-label="${esc(f.label)}"/></label>`).join("")
      : `<div class="log-row" aria-hidden="true"><span style="height:12px;width:62%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`.repeat(4);
    const privacyPanel = `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--blue)", "פרטיות")}
      <div style="color:var(--steel);font-size:12px;line-height:1.6;margin-bottom:8px;">כל שינוי נשמר מיד ונאכף בשרת. הגדרות הנוכחות והרישום לשיעור ייכנסו לתוקף כשמודול הנוכחות יעלה.</div>
      <div class="log-list">${privacyRows}</div>
    </div>`;

    // COMM-221. The "View Week" entry point into the recap surface.
    const recapEntry = `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--teal)", "הסיכום השבועי שלי")}<button class="chip-btn primary" data-community-action="open-recap">צפייה בשבוע</button></div>`;
    // COMM-309. The monthly club recap's member-facing card, right beside
    // its weekly sibling above - see renderMonthlyRecapMemberSection's own
    // comment for why this is an inline card rather than a new dialog or a
    // wholly new nav destination. Renders to "" (nothing at all) until a
    // published month actually exists.
    const monthlyRecapEntry = renderMonthlyRecapMemberSection();

    // COMM-228. One box, three labeled groups (members, events, challenges).
    const people = renderCommunitySearch();

    // Post-Phase-3 Hebrew copy fix: "חברים חדשים" - the exact phrase COMM-107's
    // welcome post and the coach-tools "Welcome" section already use for the
    // same concept (מתאמנים was this list's own one-off).
    const newMembersHtml = staff ? `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--green)", "חברים חדשים", true)}${state.club.newMembers.length ? `<div class="log-list">${state.club.newMembers.map((m) => `<div class="log-row"><span>${nameHtml(m.display_name, m.handle)}</span><span style="color:var(--steel);font-size:12px;">${esc(m.first_activity_on)}</span></div>`).join("")}</div>` : `<div class="empty">אין חברים חדשים לאחרונה</div>`}</div>` : "";
    const inactiveHtml = staff ? `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--red)", "מי לא התאמן לאחרונה", true)}${state.club.inactiveMembers.length ? `<div class="log-list">${state.club.inactiveMembers.map((m) => `<div class="log-row"><span>${nameHtml(m.display_name, m.handle)}</span><span style="color:var(--steel);font-size:12px;">${m.last_activity_on ? esc(m.last_activity_on) : "מעולם לא"}</span></div>`).join("")}</div>` : `<div class="empty">כולם פעילים</div>`}</div>` : "";

    const accountTab = account + recapEntry + monthlyRecapEntry + privacyPanel + people + newMembersHtml + inactiveHtml + renderModeration() + renderMemberManagement() + renderMemberRoster() + renderInviteManagement() + renderOnboardingContentEditor() + renderClubModulesPanel() + renderAdminAnalyticsDashboard() + renderRetentionCorrelations() + renderCommunityHealthScore() + renderAuditLog() + renderMyAchievements() + renderNotifPrefsPanel()
      + `<button class="link-btn" data-community-action="sign-out" style="display:block;margin:20px auto 0;">התנתקות</button>`
      + `<button class="link-btn" data-community-action="delete-account" style="display:block;margin:10px auto 8px;color:var(--red);">בקשת מחיקת חשבון</button>`;

    // ---- Directory tab: the club roster (COMM-231) -----------------------
    const directoryTab = renderDirectorySection();

    // COMM-152. The badge counts open queue items for a holder of the
    // moderation permission (or a real admin), not the legacy reports list.
    const pendingReports = (hasPerm(PERM.COMMENT_MODERATE) || isAdmin())
      ? state.admin.modQueue.filter((r) => r.status === "open").length : 0;
    const tabs = [
      { id: "feed", label: "פיד", html: feedTab },
      { id: "boards", label: "לוחות", html: boardsTab },
      { id: "directory", label: "חברים", html: directoryTab },
      { id: "account", label: "חשבון", html: accountTab, badge: pendingReports },
    ];
    // COMM-223. A dedicated 4th sub-tab, added only for isStaff(), as an
    // `if (staff)` push rather than an inline ternary render gate (that
    // literal ternary pattern is what community-coach-tier.test.mjs counts
    // as "the 4 staff-only render gates"; this is a whole sub-tab rather
    // than a slice of one, so it stays out of that count on purpose) - so a
    // non-staff caller's tabs array has no "coach" entry at all, and the
    // activeTab lookup below falls back to the feed tab even if something
    // forced state.ui.tab to "coach" directly.
    if (staff) tabs.push({ id: "coach", label: "לוח מאמנים", html: renderCoachTab() });
    const activeTab = tabs.find((t) => t.id === state.ui.tab) || tabs[0];
    const tabBar = `<div class="subtabbar">${tabs.map((t) => `<button class="subtabbtn${t.id === activeTab.id ? " active" : ""}" data-community-action="set-tab" data-tab="${t.id}">${t.label}${t.badge ? `<span class="tab-badge" aria-label="${t.badge} דיווחים ממתינים">${t.badge}</span>` : ""}</button>`).join("")}</div>`;

    // COMM-329 (remaining scope). The Community tab was the one solo tab
    // with no top-level <h1> of its own - it never calls renderTabHeader(),
    // the shared function the other 4 solo tabs already use. "קהילה" is the
    // same label getNavItems() already gives this tab everywhere else
    // (bottom-bar/nav-menu icon caption); this just reads that one
    // registry entry instead of inventing a second name (e.g. the club's
    // own name, which is a per-club value, not this screen's identity).
    // renderTabHeader lives in app.js, loaded after cloud.js in index.html -
    // safe here since this whole function body only runs on an actual
    // render(), well after both scripts have executed.
    return renderTabHeader("community")
      + tabBar
      + (state.ui.message ? `<div class="footer-note" role="status" style="color:var(--brass);margin-bottom:14px;">${esc(state.ui.message)}</div>` : "")
      + activeTab.html;
  };
  // Sharing (see renderShareControl) can now be triggered from the
  // Calendar and Progress tabs, not just the Community tab, so the
  // confirm dialog can no longer live only inside renderCommunityApp()'s
  // own output - it has to render regardless of which top-level tab is
  // active. app.js's own render() appends this unconditionally after
  // every tab's content (see index.html/app.js render()).
  window.renderCloudConfirmDialog = renderConfirmDialog;
  // app.js's stale-backup-export reminder (renderSettingsBody) reads this to
  // pick its threshold: someone already covered by automatic cloud sync
  // needs the local-export nudge far less urgently than someone who is not.
  window.cloudSyncActive = function () { return !!(state.user && state.syncEnabled); };
  window.cloudStorageStatusText = function () {
    if (!configured) return "נשמר במכשיר הזה בלבד, ללא שרת";
    if (backupOptedOut()) return "נשמר במכשיר הזה בלבד — גיבוי אוטומטי כבוי";
    if (!state.user) return "נשמר במכשיר; יגובה אוטומטית ופרטית עם השמירה הבאה";
    return state.syncEnabled ? "נשמר במכשיר ומגובה אוטומטית ופרטית לחשבון" : "נשמר במכשיר; סנכרון ענן ממתין לאישורכם";
  };
  // Settings > "נתונים וגיבוי" (window.renderSettingsBody in app.js embeds
  // this HTML directly, same cross-file pattern as cloudStorageStatusText
  // above and renderCloudConfirmDialog below). Deliberately outside the
  // Community tab's whole gated sequence - COMM-016 (invite code, profile,
  // recovery verification) never has to be reached just to keep a private
  // backup running. "join community" stays a fully separate, later,
  // optional decision on the Community tab, never blended into this one.
  window.renderBackupSettingsPanel = function () {
    if (!configured) return "";
    if (backupOptedOut()) {
      return `<div class="footer-note" style="margin-bottom:8px;">גיבוי אוטומטי לענן כבוי — האימונים נשמרים במכשיר הזה בלבד.</div><button class="link-btn" data-community-action="backup-enable">הפעלת גיבוי אוטומטי</button>`;
    }
    if (!state.user) {
      return `<div class="footer-note" style="margin-bottom:8px;">האימונים שלכם מתחילים להתגבות אוטומטית ופרטית לענן מהשמירה הראשונה — רק אתם רואים אותם. אפשר לכבות בכל שלב.</div><button class="link-btn" data-community-action="backup-optout">כיבוי גיבוי אוטומטי</button>`;
    }
    const credentialsCta = state.user.is_anonymous
      ? `<div style="margin-top:12px;"><div class="footer-note" style="margin-bottom:6px;">גישה לאותם נתונים ממכשיר אחר דורשת שם משתמש וסיסמה.</div><form id="backupCredentials">${field("backupCredentials", "username", "שם משתמש", `<input class="text-input" name="username" dir="ltr" autocapitalize="off" autocomplete="username" placeholder="אותיות אנגליות, ספרות או קו תחתון" required/>`)}${field("backupCredentials", "password", "סיסמה", `<input class="text-input" name="password" type="password" dir="ltr" autocomplete="new-password" placeholder="לפחות 8 תווים" required/>`)}${field("backupCredentials", "passwordConfirm", "אימות סיסמה", `<input class="text-input" name="passwordConfirm" type="password" dir="ltr" autocomplete="new-password" placeholder="הקלידו שוב" required/>`)}<button class="chip-btn primary" type="submit" style="margin-top:6px;">שמירת גישה ממכשיר אחר</button></form></div>`
      : "";
    return `<div class="footer-note" style="margin-bottom:8px;">${esc(state.syncEnabled ? "האימונים שלכם מגובים אוטומטית ופרטית לענן — רק אתם רואים אותם." : "גיבוי מוגדר אך טרם הופעל.")}</div><button class="link-btn" data-community-action="backup-optout">כיבוי גיבוי אוטומטי</button>${credentialsCta}${state.ui.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${esc(state.ui.message)}</div>` : ""}`;
  };
  // ---- Shared Phase 1 dialog focus + keyboard management (COMM-190) -----
  // Every Phase 1 overlay dialog behaves the same way: focus moves in on
  // open, Tab / Shift+Tab cycle within it, Escape and a backdrop click both
  // close it, and focus returns to whatever opened it. Per-dialog Escape
  // wiring lives in the document keydown handler; this block owns focus-in,
  // the Tab trap, the backdrop, and focus restoration. Registry order is the
  // stacking order used when more than one state flag is set at once. It
  // matches the Escape handler's precedence: a sheet stacked over another
  // dialog is the one that closes and the one that traps Tab.
  //
  // COMM-365. `key` is the DOM key (the data-cloud-dialog attribute value on
  // the overlay, and the key cloudDialogOpeners is keyed by) and is unchanged
  // by the state namespacing - it is markup, not a state path. `isOpen` is how
  // this registry now reads the flag: before namespacing it could do
  // state[key], which only worked because every dialog flag happened to be a
  // top-level sibling. A getter per entry keeps the registry the single place
  // that knows where a dialog's flag lives, so a dialog whose state moves
  // domains needs a change here and nowhere else.
  const CLOUD_DIALOGS = [
    { key: "reportSheet", isOpen: () => state.admin.reportSheet, close: function () { closeReportSheet(); } },
    { key: "modAction", isOpen: () => state.admin.modAction, close: function () { closeModAction(); } },
    { key: "modContext", isOpen: () => state.admin.modContext, close: function () { closeModContext(); } },
    { key: "notifCenter", isOpen: () => state.notif.center, close: function () { closeNotifCenter(); } },
    { key: "achUnlock", isOpen: () => state.achievements.unlock, close: function () { dismissAchievementUnlock(); } },
    { key: "prPrompt", isOpen: () => state.posts.prPrompt, close: function () { dismissPrPrompt(); } },
    { key: "composer", isOpen: () => state.posts.composer, close: function () { tryCloseComposer(); } },
    { key: "profileView", isOpen: () => state.members.profileView, close: function () { closeCommunityProfile(); } },
    { key: "challengeView", isOpen: () => state.challenges.view, close: function () { closeChallengeView(); } },
    { key: "eventView", isOpen: () => state.events.view, close: function () { closeEventView(); } },
    { key: "recapView", isOpen: () => state.recaps.view, close: function () { closeRecapView(); } },
  ];
  const cloudDialogOpeners = {};
  let cloudOpenDialogKey = null;
  // The control a click is currently on, captured in the capture phase -
  // i.e. before the bubble-phase handler that opens a dialog runs and
  // re-renders #content, which would otherwise destroy that exact button
  // (every dialog opener lives inside #content and gets replaced by the
  // very render its own click triggers). One-shot: cleared at the end of
  // every syncCloudDialogFocus() call so a stale earlier click is never
  // mistaken for the one that just opened a dialog.
  let cloudDialogClickCandidate = null;
  document.addEventListener("click", function (e) {
    const t = e.target;
    cloudDialogClickCandidate = (t && t.closest) ? t.closest("[data-community-action]") : null;
  }, true);
  // Real openers live inside #content and do not survive the render their
  // own click triggers, so what is remembered is a CSS selector built from
  // data-community-action plus every other data-* attribute the element
  // carries (id, decision, tab, status...) - specific enough in practice to
  // match exactly the one control that opened this dialog - re-resolved
  // against the live DOM when it is time to restore focus, rather than a
  // direct element reference that would already be detached by then.
  function cloudOpenerSelector(el) {
    if (!el || !el.getAttribute) return null;
    const action = el.getAttribute("data-community-action");
    if (!action) return null;
    let sel = '[data-community-action="' + action.replace(/"/g, '\\"') + '"]';
    Array.prototype.forEach.call(el.attributes, function (attr) {
      if (attr.name.indexOf("data-") === 0 && attr.name !== "data-community-action") {
        sel += "[" + attr.name + '="' + String(attr.value).replace(/"/g, '\\"') + '"]';
      }
    });
    return sel;
  }
  function cloudResolveOpener(info) {
    if (!info) return null;
    if (info.selector) {
      const bySel = document.querySelector(info.selector);
      if (bySel) return bySel;
    }
    return (info.el && document.contains(info.el)) ? info.el : null;
  }
  function cloudDialogEl(key) { return document.querySelector('[data-cloud-dialog="' + key + '"]'); }
  function cloudDialogFocusables(el) {
    if (!el) return [];
    return Array.prototype.slice.call(el.querySelectorAll(
      'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])'
    )).filter(function (n) {
      return !n.disabled
        && n.getAttribute("aria-hidden") !== "true"
        && !/display:\s*none/.test(n.getAttribute("style") || "");
    });
  }
  function currentCloudDialog() {
    for (let i = 0; i < CLOUD_DIALOGS.length; i++) {
      const spec = CLOUD_DIALOGS[i];
      if (spec.isOpen() && cloudDialogEl(spec.key)) return spec.key;
    }
    return null;
  }
  // Run after every community render. Moves focus into a dialog the first
  // time it appears and hands focus back to the opener once the last dialog
  // is gone. While the same dialog stays open across a re-render, focus is
  // left exactly where it is - so typing in a field that patches the DOM
  // directly instead of re-rendering is never disturbed - unless the
  // control that held it was itself removed by that re-render (e.g. an
  // "add a note" button swapped for a textarea), which would otherwise
  // silently drop focus to <body> and defeat the trap; that case falls
  // back to the dialog's first control rather than leaving the user
  // outside it.
  function syncCloudDialogFocus() {
    const openKey = currentCloudDialog();
    // One-shot: whatever was just clicked only ever explains *this* render
    // cycle's dialog transition, never a later one.
    const clickCandidate = cloudDialogClickCandidate;
    cloudDialogClickCandidate = null;
    if (openKey === cloudOpenDialogKey) {
      if (openKey) {
        const el = cloudDialogEl(openKey);
        const active = document.activeElement;
        if (el && !(active && el.contains(active))) {
          const f = cloudDialogFocusables(el);
          if (f.length) { try { f[0].focus(); } catch (e) {} }
        }
      }
      return;
    }
    if (!openKey) {
      const prev = cloudOpenDialogKey;
      cloudOpenDialogKey = null;
      const opener = cloudResolveOpener(cloudDialogOpeners[prev]);
      delete cloudDialogOpeners[prev];
      if (opener && typeof opener.focus === "function") {
        try { opener.focus(); } catch (e) {}
      }
      return;
    }
    const active = document.activeElement;
    if (!(openKey in cloudDialogOpeners)) {
      // Prefer the control that was just clicked (re-resolved by selector,
      // since the render this same click triggered may already have
      // destroyed it) over document.activeElement, which for a click-driven
      // open has usually already reverted to <body> by the time this runs.
      // An event-bus-triggered dialog (a PR or achievement celebration) has
      // no click to go on, so activeElement - whatever the member had
      // focused when the celebration appeared - is the right fallback.
      const activeCandidate = (active && active !== document.body && document.contains(active)) ? active : null;
      const primary = clickCandidate || activeCandidate;
      cloudDialogOpeners[openKey] = { el: primary, selector: cloudOpenerSelector(primary) };
    }
    cloudOpenDialogKey = openKey;
    const el = cloudDialogEl(openKey);
    if (!(el && active && el.contains(active))) {
      const f = cloudDialogFocusables(el);
      if (f.length) { try { f[0].focus(); } catch (e) {} }
    }
  }
  window.syncCloudDialogFocus = syncCloudDialogFocus;

  window.afterRenderCommunity = function () {
    // COMM-331. The one place the deferred feed/streaks/etc. cascade gets
    // kicked off - the first time the Community tab actually renders (boot
    // straight into it, or navigating to it later), not on every cold
    // boot. See ensureCommunityDataLoaded()'s own comment for what it does
    // and does not cover.
    ensureCommunityDataLoaded();
    const input = document.getElementById("communityPeopleSearch");
    if (input) input.addEventListener("input", () => searchPeople(input.value));
    // COMM-228. A render replaces the box the member is typing into, which
    // drops focus and the caret. Restoring is safe only when nothing else
    // holds focus (a render triggered by the search itself leaves
    // activeElement on <body>), so this can never steal focus from another
    // control on the same tab.
    if (input && input.value && (!document.activeElement || document.activeElement === document.body)) {
      try { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* not a text input in this browser */ }
    }
    const adminInput = document.getElementById("adminMemberSearch");
    if (adminInput) adminInput.addEventListener("input", () => searchMembers(adminInput.value));
    // COMM-231. Same restore-focus-and-caret pattern as communityPeopleSearch
    // above, for the directory's own search box.
    const dirInput = document.getElementById("communityDirectorySearch");
    if (dirInput) dirInput.addEventListener("input", () => directorySearch(dirInput.value));
    if (dirInput && dirInput.value && (!document.activeElement || document.activeElement === document.body)) {
      try { dirInput.focus(); dirInput.setSelectionRange(dirInput.value.length, dirInput.value.length); } catch (e) { /* not a text input in this browser */ }
    }
    // COMM-154. The audit view is lazy: fetched the first time an analytics
    // holder lands on the Account tab, not on every session.
    if (state.ui.tab === "account" && hasPerm(PERM.ANALYTICS_VIEW) && !state.admin.auditLoaded && !state.admin.auditLoading) loadAuditLog(true);
    // COMM-310. Same lazy pattern as the audit view just above: the
    // dashboard's default period (this ISO week) is fetched the first time
    // an analytics holder or real admin lands on the Account tab.
    if (state.ui.tab === "account" && (hasPerm(PERM.ANALYTICS_VIEW) || isAdmin()) && !state.analytics.dashboard.loaded && !state.analytics.dashboard.loading) loadAdminAnalyticsDashboard();
    // COMM-313. Same lazy pattern, its OWN gate: real is_admin() alone, not
    // the ANALYTICS_VIEW-or-admin pair the two lazy loads just above use -
    // so a community.analytics.view holder who is not an admin never even
    // triggers the three retention RPCs, matching that this section must not
    // render for them at all.
    if (state.ui.tab === "account" && isAdmin() && !state.analytics.retention.loaded && !state.analytics.retention.loading) loadRetentionCorrelations();
    // COMM-312. Same lazy pattern and same is_admin()-only gate as COMM-313's
    // load just above, its own independent trigger (not piggybacked on
    // loadRetentionCorrelations() even though the two sections sit side by
    // side and share a gate) - the two RPCs have nothing to do with each
    // other from the client's point of view.
    if (state.ui.tab === "account" && isAdmin() && !state.analytics.health.loaded && !state.analytics.health.loading) loadCommunityHealth();
    // COMM-376. Same lazy pattern, each panel gated on the exact permission
    // its own RPC needs - a coach who only holds community.member.invite
    // triggers the per-person load and never the shared-code one.
    if (state.ui.tab === "account" && (hasPerm(PERM.INVITE_MANAGE_CODES) || isAdmin()) && !state.admin.inviteCodes.loaded && !state.admin.inviteCodes.loading) loadInviteCodes();
    if (state.ui.tab === "account" && (hasPerm(PERM.MEMBER_INVITE) || isAdmin()) && !state.admin.invites.loaded && !state.admin.invites.loading) loadInvites(true);
    // COMM-377. is_staff(), matching admin_member_roster's own looser AUTH.
    if (state.ui.tab === "account" && isStaff() && !state.admin.roster.loaded && !state.admin.roster.loading) loadRoster(true);
    // COMM-309. The monthly club recap's member-facing card: fetched the
    // first time a member lands on the Account tab, same lazy pattern as
    // the audit view just above (and every other tab-scoped load in this
    // block) rather than in refreshSession()'s boot Promise.all - most
    // months this answers "nothing published yet", so it is not worth a
    // boot round-trip for every session.
    if (state.ui.tab === "account" && state.user && !state.recaps.monthly.loaded && !state.recaps.monthly.loading) loadMonthlyRecap();
    // COMM-229. Same lazy pattern: this device's push subscription status
    // is only worth checking once the flag is on and a member actually
    // lands on the Account tab where the preferences panel lives - never
    // on every session, and never at all while the flag is off (the V1
    // default), so no serviceWorker.ready wait is introduced for anyone
    // who cannot act on it anyway.
    if (state.ui.tab === "account" && state.user && notifPushEnabled() && !state.notif.pushChecked) loadNotifPushStatus();
    // COMM-210. Same lazy pattern for the consistency board: one
    // feed_leaderboard() call the first time a member lands on the Boards
    // sub-tab, not on every session boot.
    if (state.ui.tab === "boards" && state.user && !state.leaderboard.loaded && !state.leaderboard.loading) loadConsistencyLeaderboard();
    // COMM-231. The directory's own paginated roster, fetched the first time
    // a member lands on the Directory sub-tab.
    if (state.ui.tab === "directory" && state.user && !state.members.directory.loaded && !state.members.directory.loading) loadDirectory(true);
    // COMM-232. The suggestions strip now renders on the Directory sub-tab -
    // see the PLACEMENT NOTE above renderPeopleSuggestions().
    if (state.ui.tab === "directory" && state.user && !state.members.suggestions.loaded && !state.members.suggestions.loading) loadPeopleSuggestions();
    // COMM-307. The trained-with-you card, on the same lazy sub-tab pattern
    // as the four loads above rather than in refreshSession()'s boot
    // Promise.all beside loadEvents(). Three reasons, all of them about this
    // particular call: show_attendance defaults to false, so for most of the
    // club the answer is an empty set and a boot round-trip buys nothing;
    // the boot batch is what first paint waits on, and this card is not
    // first-paint content; and the member's own attendance row for today is
    // written by the private_records trigger behind flushOutbox(), which
    // runs AFTER that batch, so asking during boot could ask before the row
    // that anchors the whole join exists. Asking when the Feed sub-tab is
    // actually on screen asks once, late enough, and only of members looking
    // at the surface the card lives on.
    if (state.ui.tab === "feed" && state.user && !state.members.classmatesToday.loaded && !state.members.classmatesToday.loading) loadClassmatesToday();
    // COMM-316. Same lazy, same-subtab, same after-boot-batch pattern as
    // loadClassmatesToday just above, and for the identical reason: this
    // reads the member's own attendance_log rows, which the private_records
    // trigger behind flushOutbox() only finishes writing after the boot
    // Promise.all. Only the two attendance-tied onboarding steps depend on
    // this; welcome/first_week/first_month never look at it.
    if (state.ui.tab === "feed" && state.user && !state.onboarding.attendance.loaded && !state.onboarding.attendance.loading) loadOnboardingAttendance();
    // COMM-212. The hide-my-result checkbox persists per device on change,
    // the same no-save-button pattern the privacy toggles below use - except
    // this one writes localStorage, never the server.
    document.querySelectorAll("[data-leaderboard-hide-self]").forEach((el) => {
      el.addEventListener("change", () => setHideMyLeaderboardResult(el.checked));
    });
    // COMM-223..226. Same lazy pattern for the Coach Dashboard's own three
    // loads: fetched the first time a staff member actually lands on the
    // sub-tab, not on every session, and Engage only once its flag is on
    // too (COMM-226: no code path reaches coach_engagement_flags outside
    // the flag-gated staff surface).
    if (state.ui.tab === "coach" && isStaff()) {
      if (!state.coach.celebrate.loaded && !state.coach.celebrate.loading) loadCoachCelebrate();
      if (!state.coach.welcome.loaded && !state.coach.welcome.loading) loadCoachWelcome();
      if (!state.coach.memberOfWeek.loaded && !state.coach.memberOfWeek.loading) loadCoachMemberOfWeek();
      // COMM-309. The staff preview, same lazy sub-tab pattern as the three
      // loads above it - no flag gate, since this section renders for every
      // isStaff() caller (the button inside it is what is permission-gated,
      // not the section itself).
      if (!state.coach.monthlyRecap.loaded && !state.coach.monthlyRecap.loading) loadCoachMonthlyRecap();
      if (state.featureFlags.coachEngage && !state.coach.engage.loaded && !state.coach.engage.loading) loadCoachEngageFlags();
    }
    // COMM-224. The assign-by-handle and mark-contacted note fields are
    // read only at click time (coachAssignByHandle/coachMarkContacted), so
    // this only stores the draft - never rerenders - which is what keeps
    // typing from losing focus or the caret on every keystroke.
    document.querySelectorAll("[data-coach-assign-handle]").forEach((el) => {
      el.addEventListener("input", () => { state.coach.welcome.assignDrafts[el.dataset.coachAssignHandle] = el.value; });
    });
    document.querySelectorAll("[data-coach-contact-note]").forEach((el) => {
      el.addEventListener("input", () => { state.coach.welcome.contactDrafts[el.dataset.coachContactNote] = el.value; });
    });
    // COMM-315. Same no-rerender-on-input shape as the two listeners just
    // above. The reason field's live 500-char counter is DOM-patched
    // directly on the same input event, the same way composerSetBody's own
    // counter is - a full rerender here would cost the textarea its focus
    // and caret position on every keystroke, exactly what those two
    // listeners already avoid.
    document.querySelectorAll("[data-mow-pick-handle]").forEach((el) => {
      el.addEventListener("input", () => { state.coach.memberOfWeek.pickHandle = el.value; });
    });
    document.querySelectorAll("[data-mow-pick-reason]").forEach((el) => {
      el.addEventListener("input", () => {
        state.coach.memberOfWeek.pickReason = el.value;
        const counter = document.querySelector("[data-mow-pick-counter]");
        if (counter) counter.textContent = `${el.value.length}/500`;
      });
    });
    // COMM-222. Same lazy pattern: the first-month summary is only worth
    // fetching once that onboarding step is actually due.
    if (currentOnboardingStep() === "first_month" && !state.onboarding.firstMonth) loadOnboardingFirstMonthSummary();
    // COMM-018. Each privacy toggle persists on change, no save button.
    document.querySelectorAll("[data-privacy-field]").forEach((el) => {
      el.addEventListener("change", () => savePrivacyField(el.dataset.privacyField, el.checked));
    });
    // COMM-321. Same per-element wiring shape as the privacy toggles just
    // above - persists on change, no save button.
    document.querySelectorAll("[data-club-feature]").forEach((el) => {
      el.addEventListener("change", () => toggleClubFeature(el.dataset.clubFeature, el.checked));
    });
    // COMM-113/114. Both observers are rebuilt here because rerender()
    // replaces every card element, so the previous ones point at nodes that
    // are no longer in the document.
    observeFeedImpressions();
    observeFeedSentinel();
    // COMM-170. This hook is the only place cloud.js learns that the
    // Community tab is actually on screen, so the club_tab_viewed event is
    // recorded from here rather than from setCommunityTab - which also
    // runs when a notification routes to a tab the member never looked at.
    // noteClubTabView() de-dupes, so running on every render is harmless.
    noteClubTabView();
    // COMM-307. Same hook, same reason, same de-duping shape: the card is
    // "viewed" when it is in the document with rows in it, which is a fact
    // only this hook can see. Runs on every render and records at most once
    // per load of the card.
    noteClassmatesCardView();
    // COMM-141. Re-arm the own-row notification channel; setCommunityTab
    // tears every channel down, so this self-heals the same way the feed
    // observers above do.
    ensureNotifRealtime();
    // COMM-209 / COMM-227. Same self-healing arm point for the challenge
    // detail's two filtered channels and the feed's two shared ones. Both
    // are idempotent: they check the registry before subscribing, so
    // running on every render costs nothing.
    ensureChallengeRealtime();
    ensureFeedRealtime();
    // COMM-190. Shared dialog focus management for every Phase 1 overlay:
    // focus-in on open, focus restored to the opener on close. Replaces the
    // notification centre's one-off focus-in.
    syncCloudDialogFocus();
  };
  window.handleCommunityClick = function (el) {
    const action = el.dataset.communityAction;
    // COMM-114. Measured before the action runs, so a click that navigates
    // away or re-renders the card still records. Nothing here can throw into
    // the action itself and nothing awaits it.
    trackFeedClick(el);
    if (action === "migrate") askConfirm({ title: "סנכרון היסטוריה", message: "להעלות את היסטוריית האימונים הפרטית לחשבון? שום נתון לא יפורסם בקהילה.", confirmLabel: "העלאה", action: "migrate" });
    // Settings > "protect my data" (window.renderBackupSettingsPanel) - fully
    // separate from Community's own join flow: no invite code, no feed, no
    // profile. "enable" clears the opt-out and starts (or resumes) a
    // backup-only anonymous session; "optout" stops future syncing and
    // remembers the choice so maybeAutoStartBackup() leaves it alone.
    else if (action === "backup-enable") {
      localStorage.removeItem(BACKUP_OPTOUT_KEY);
      if (!state.user) ensureAnonymousSession();
      else enableSyncIfAllowed();
      rerender();
    }
    else if (action === "backup-optout") {
      localStorage.setItem(BACKUP_OPTOUT_KEY, "1");
      if (state.syncEnabled) { state.syncEnabled = false; localStorage.setItem("haimunia-demo:cloudSyncEnabled", "0"); }
      rerender();
    }
    else if (action === "avatar-remove") removeAvatarPhoto();
    else if (action === "cheer") react(el.dataset.id);
    else if (action === "report") report(el.dataset.id);
    else if (action === "publish") {
      const fileInput = document.getElementById("photo-" + el.dataset.id);
      const file = fileInput && fileInput.files && fileInput.files[0];
      const item = typeof window.communityShareCandidateFor === "function" ? window.communityShareCandidateFor(el.dataset.type, el.dataset.id) : null;
      const audience = el.dataset.visibility === "public" ? "לכולם, פומבי" : "לעוקבים שלכם בלבד";
      const preview = item ? `"${item.title}" — ${item.resultText}${file ? " (כולל תמונה)" : ""}` : "";
      askConfirm({ title: "פרסום תוצאה", message: `לפרסם ${audience}?${preview ? " " + preview : ""}`, confirmLabel: "פרסום", action: "publish", payload: { type: el.dataset.type, id: el.dataset.id, visibility: el.dataset.visibility, file } });
    }
    else if (action === "follow") follow(el.dataset.id);
    // COMM-231 members directory.
    else if (action === "directory-retry") loadDirectory(true);
    else if (action === "directory-more") loadDirectory(false);
    else if (action === "block") askConfirm({ title: "חסימת משתמש", message: "לחסום את המשתמש? לא תראו זה את זה בקהילה.", confirmLabel: "חסימה", destructive: true, action: "block", payload: { userId: el.dataset.id } });
    else if (action === "delete-post") askConfirm({ title: "הסרת שיתוף", message: "להסיר את השיתוף מהפיד? הפעולה לא ניתנת לביטול.", confirmLabel: "הסרה", destructive: true, action: "delete-post", payload: { postId: el.dataset.id } });
    else if (action === "compare") compare(el.dataset.key, el.dataset.id);
    else if (action === "delete-account") askConfirm({ title: "מחיקת חשבון", message: "הפרופיל והשיתופים יוסרו מיד. המחיקה הסופית תתבצע לאחר 30 יום. להמשיך?", confirmLabel: "מחיקה", destructive: true, action: "delete-account" });
    else if (action === "share-achievement") publishAchievement(el.dataset.id, el.dataset.title, el.dataset.rule);
    else if (action === "toggle-comments") toggleComments(el.dataset.id);
    else if (action === "delete-comment") askConfirm({ title: "מחיקת תגובה", message: "למחוק את התגובה? הפעולה לא ניתנת לביטול.", confirmLabel: "מחיקה", destructive: true, action: "delete-comment", payload: { commentId: el.dataset.id, postId: el.dataset.post } });
    else if (action === "comment-reply") { const p = el.dataset.post; state.engagement.replyTo[p] = state.engagement.replyTo[p] === el.dataset.id ? null : el.dataset.id; if (state.engagement.replyTo[p]) state.engagement.openReplies[el.dataset.id] = true; rerender(); }
    else if (action === "toggle-replies") { const id = el.dataset.id; if (state.engagement.openReplies[id]) delete state.engagement.openReplies[id]; else state.engagement.openReplies[id] = true; rerender(); }
    else if (action === "comment-edit") startCommentEdit(el.dataset.id, el.dataset.post);
    else if (action === "comment-edit-save") saveCommentEdit();
    else if (action === "comment-edit-cancel") cancelCommentEdit();
    else if (action === "comment-retry") retryComment(el.dataset.post, el.dataset.parent || null);
    else if (action === "report-comment") reportComment(el.dataset.id);
    else if (action === "report-profile") reportProfile(el.dataset.id);
    else if (action === "mention-pick") mentionPick(el.dataset.key, el.dataset.id, el.dataset.name);
    else if (action === "set-tab") setCommunityTab(el.dataset.tab);
    else if (action === "verify-recovery") verifyRecovery({ force: true });
    else if (action === "hide-my-leaderboard-result") savePrivacyField("in_leaderboards", false);
    // COMM-210/211/212 leaderboards. Note the deliberate split from the line
    // above: that one is the real, server-enforced opt-out (in_leaderboards);
    // these only change what this device fetches and draws.
    else if (action === "leaderboard-scope") setLeaderboardScope(el.dataset.scope);
    else if (action === "leaderboard-retry") loadConsistencyLeaderboard();
    else if (action === "challenge-board-scope") setChallengeBoardScope(el.dataset.scope);
    else if (action === "challenge-board-retry") { if (state.challenges.view) loadChallengeBoard(state.challenges.view.id, { rerender: true }); }
    else if (action === "challenge-board-full") expandChallengeBoard();
    // COMM-212 / COMM-231. The friends-scope empty state routes to the
    // members directory now that it exists, rather than the Account tab's
    // bare search box.
    else if (action === "leaderboard-find-people") { directoryEntrySource = "leaderboard"; setCommunityTab("directory"); }
    // COMM-232 suggestions strip.
    else if (action === "suggestion-follow") followSuggestion(el.dataset.id);
    else if (action === "confirm-yes") runConfirm();
    else if (action === "confirm-no") closeConfirm();
    else if (action === "start-signup") startSignup();
    else if (action === "sign-out") client.auth.signOut();
    // COMM-151 report sheet.
    else if (action === "report-close") closeReportSheet();
    else if (action === "report-submit") submitReportSheet();
    // COMM-152/153 moderation queue.
    else if (action === "mod-queue-status") setModQueueStatus(el.dataset.status);
    else if (action === "mod-queue-retry") loadModQueue();
    else if (action === "mod-context") openModContext(el.dataset.id);
    else if (action === "mod-context-close") closeModContext();
    else if (action === "mod-context-open-feed") { closeModContext(); setCommunityTab("feed"); }
    else if (action === "mod-action") openModAction(el.dataset.id, el.dataset.decision);
    else if (action === "mod-action-cancel") closeModAction();
    else if (action === "mod-action-run") runModAction();
    else if (action === "mod-action-days") { if (state.admin.modAction) { state.admin.modAction.days = Number(el.dataset.days) || 7; rerender(); } }
    // COMM-154 audit view.
    else if (action === "audit-filter") setAuditFilter("action_type", el.dataset.type || "");
    else if (action === "audit-more") loadAuditLog(false);
    else if (action === "audit-retry") loadAuditLog(true);
    // COMM-310 admin community analytics dashboard.
    else if (action === "admin-analytics-mode") setAdminAnalyticsMode(el.dataset.mode);
    else if (action === "admin-analytics-shift") shiftAdminAnalyticsPeriod(Number(el.dataset.dir) || 1);
    else if (action === "admin-analytics-retry") loadAdminAnalyticsDashboard();
    // COMM-311 member engagement segmentation.
    else if (action === "member-segments-toggle") toggleMemberSegment(el.dataset.segment);
    else if (action === "member-segments-retry") loadMemberSegments();
    // COMM-313 retention correlation views.
    else if (action === "retention-retry") loadRetentionCorrelations();
    else if (action === "retention-toggle-onboarding") toggleRetentionOnboardingOverlay();
    else if (action === "retention-toggle-welcome") toggleRetentionWelcomeOverlay();
    else if (action === "retention-onboarding-step") setRetentionOnboardingStep(el.dataset.step);
    // COMM-312 community health score.
    else if (action === "community-health-retry") loadCommunityHealth();
    // COMM-379 registration funnel analytics.
    else if (action === "registration-funnel-retry") loadRegistrationFunnel();
    // COMM-378 onboarding step content editor.
    else if (action === "onboarding-content-retry") loadOnboardingStepContent().then(rerender);
    else if (action === "onboarding-content-save") saveOnboardingContent(el.dataset.step);
    // COMM-376 invite and code management.
    else if (action === "invite-code-toggle-active") setInviteCodeActive(el.dataset.id, el.dataset.active === "1");
    else if (action === "copy-invite-code") copyInviteCode(el.dataset.code);
    else if (action === "dismiss-invite-code-created") dismissInviteCodeCreated();
    else if (action === "dismiss-invite-created") dismissInviteCreated();
    else if (action === "invite-status-filter") setInviteStatusFilter(el.dataset.status);
    else if (action === "invite-list-retry") loadInvites(true);
    else if (action === "invite-list-more") loadInvites(false);
    else if (action === "invite-revoke") askConfirm({ title: "ביטול הזמנה", message: "ההזמנה תבוטל ולא תהיה ניתנת עוד למימוש. להמשיך?", confirmLabel: "ביטול ההזמנה", destructive: true, action: "admin-invite-revoke", payload: { inviteId: el.dataset.id } });
    // COMM-377 member roster.
    else if (action === "roster-retry") loadRoster(true);
    else if (action === "roster-more") loadRoster(false);
    // COMM-155 pins.
    else if (action === "unpin") unpinTarget(el.dataset.type, el.dataset.id);
    else if (action === "pin") pinTarget(el.dataset.type, el.dataset.id, el.dataset.note || "");
    // COMM-156 role management.
    else if (action === "admin-set-role") {
      const role = el.dataset.role;
      const label = { member: "חבר/ה", coach: "מאמן/ת", head_coach: "מאמן/ת ראשי/ת" }[role] || role;
      if (role === "member") adminRevokeCoach(el.dataset.id);
      else askConfirm({ title: "שינוי הרשאה", message: `להעניק הרשאת ${label} למשתמש/ת זה/ו?`, confirmLabel: "הענקה", action: "admin-set-role", payload: { userId: el.dataset.id, role } });
    }
    else if (action === "admin-grant-coach") askConfirm({ title: "הענקת הרשאת מאמן/ת", message: "להעניק הרשאת מאמן/ת למשתמש/ת זה/ו?", confirmLabel: "הענקה", action: "admin-grant-coach", payload: { userId: el.dataset.id } });
    else if (action === "admin-revoke-coach") adminRevokeCoach(el.dataset.id);
    else if (action === "admin-remove-member") askConfirm({ title: "הסרת חבר/ה", message: "הפרופיל והשיתופים של המשתמש/ת יוסרו מיד. המחיקה הסופית תתבצע לאחר 30 יום. להמשיך?", confirmLabel: "הסרה", destructive: true, action: "admin-remove-member", payload: { userId: el.dataset.id } });
    else if (action === "admin-reset-password") askConfirm({ title: "איפוס סיסמה", message: "ייווצרו סיסמה זמנית חדשה שתוצג פעם אחת בלבד. יש למסור אותה לחבר/ה ישירות (לא דרך האפליקציה).", confirmLabel: "איפוס", action: "admin-reset-password", payload: { userId: el.dataset.id } });
    else if (action === "close-password-reset-result") { state.admin.passwordResetResult = null; rerender(); }
    else if (action === "toggle-share") toggleShare(el.dataset.type, el.dataset.id);
    else if (action === "open-composer") openComposer(el);
    else if (action === "composer-cancel") tryCloseComposer();
    else if (action === "composer-publish") publishComposer();
    else if (action === "composer-remove-photo") composerRemovePhoto(el.dataset.id);
    else if (action === "composer-retry-photo") composerRetryPhoto(el.dataset.id);
    else if (action === "toggle-post-menu") togglePostMenu(el.dataset.id);
    else if (action === "post-save") postSaveToggle(el.dataset.id);
    else if (action === "post-hide") postHide(el.dataset.id);
    else if (action === "post-edit-caption") postStartCaptionEdit(el.dataset.id);
    else if (action === "caption-cancel") { state.posts.captionEdit = null; rerender(); }
    else if (action === "caption-save") postSaveCaption();
    else if (action === "post-change-visibility") postStartVisibilityEdit(el.dataset.id);
    else if (action === "visibility-pick") postApplyVisibility(el.dataset.value);
    else if (action === "visibility-cancel") { state.posts.visibilityEdit = null; rerender(); }
    else if (action === "post-delete") askConfirm({ title: "מחיקת פוסט", message: "הפוסט יוסר מהפיד. הפעולה אינה ניתנת לביטול מיידי.", confirmLabel: "מחיקה", destructive: true, action: "post-delete-rpc", payload: { postId: el.dataset.id } });
    else if (action === "welcome-member") welcomeNewMember(el.dataset.id);
    else if (action === "view-profile") viewCommunityProfile(el.dataset.id);
    else if (action === "close-profile") closeCommunityProfile();
    else if (action === "profile-tab") setProfileViewTab(el.dataset.tab);
    // COMM-230 following surface.
    else if (action === "following-toggle") toggleFollowListSection(el.dataset.side);
    else if (action === "following-retry") retryFollowList(el.dataset.side);
    else if (action === "following-unfollow") unfollowFromFollowingList(el.dataset.id);
    else if (action === "pr-share") sharePrPrompt();
    else if (action === "pr-not-now") dismissPrPrompt();
    else if (action === "pr-add-note") { if (state.posts.prPrompt) { state.posts.prPrompt.showNote = true; rerender(); } }
    else if (action === "ach-share") shareAchievementUnlock();
    else if (action === "ach-not-now") dismissAchievementUnlock();
    else if (action === "ach-add-note") { if (state.achievements.unlock) { state.achievements.unlock.showNote = true; rerender(); } }
    else if (action === "ach-share-later") shareEarnedAchievement(el.dataset.id, el.dataset.code);
    else if (action === "feed-scope") setFeedScope(el.dataset.scope);
    else if (action === "feed-load-more") loadMoreFeed();
    else if (action === "feed-retry") { state.feed.pagesLoaded = 0; loadFeed().then(rerender); rerender(); }
    // COMM-140..142 notification centre.
    else if (action === "feed-notifications") openNotifCenter();
    else if (action === "notif-close") closeNotifCenter();
    else if (action === "notif-retry") fetchNotifPage(true);
    else if (action === "notif-load-more") loadMoreNotifs();
    else if (action === "notif-show-older") notifShowOlder();
    else if (action === "notif-mark-all") markAllNotifsRead();
    else if (action === "notif-open") openNotif(el.dataset.id);
    else if (action === "notif-toggle-group") { const c = state.notif.center; if (c) { c.expanded[el.dataset.key] = !c.expanded[el.dataset.key]; rerender(); } }
    else if (action === "notif-pref") setNotifPref(el.dataset.type, el.dataset.channel);
    else if (action === "notif-push-disable") disableNotifPush();
    // COMM-201/207. The club-top shortcut opens the real challenge detail
    // when club_summary handed back an id; a missing id (an older/failed
    // club_summary read) still lands the member on the Boards sub-tab
    // rather than a broken dialog.
    else if (action === "open-active-challenge") { if (el.dataset.id) openChallenge(el.dataset.id, "club_top"); else setCommunityTab("boards"); }
    // COMM-201/207. openChallenge() itself records CHALLENGE_VIEWED, so the
    // POST_CHALLENGE link card's own tap passes "post_card" through.
    // COMM-228. A search result carries data-source="search" so the same
    // action records where the member came from; anything without one is
    // the POST_CHALLENGE link card it was written for.
    // COMM-233. Which is why the Boards list cards now carry an explicit
    // data-source="boards": they had none, so every challenge opened from
    // the Boards sub-tab was recorded as a post_card open. Only the link
    // card inside a feed post is allowed to rely on the default.
    else if (action === "open-challenge") { if (el.dataset.id) openChallenge(el.dataset.id, el.dataset.source || "post_card"); }
    else if (action === "close-challenge-view") closeChallengeView();
    else if (action === "join-challenge") joinChallenge(el.dataset.id, "boards");
    else if (action === "leave-challenge") confirmLeaveChallenge(el.dataset.id);
    else if (action === "challenge-pick-team") pickChallengeTeam(el.dataset.id, el.dataset.team);
    // COMM-308. Team management: create/rename/delete direct-RLS on
    // challenge_teams (renameChallengeTeam/deleteChallengeTeam read the
    // team id off data-id, the same shape challenge-coach-submit already
    // uses to pick one row out of a roster). Reassign and set-captain are
    // wired off the "change" listener below (their controls are <select>s,
    // not buttons), the same immediate-on-change shape composerVisibility
    // already uses for its own <select>.
    else if (action === "challenge-team-create") createChallengeTeam();
    else if (action === "challenge-team-rename") renameChallengeTeam(el.dataset.id);
    else if (action === "challenge-team-delete") confirmDeleteChallengeTeam(el.dataset.id);
    else if (action === "challenge-log-submit") submitChallengeLog();
    else if (action === "challenge-log-week-hit") logConsistencyWeekHit();
    else if (action === "challenge-coach-submit") submitCoachEntry(el.dataset.id);
    else if (action === "share-challenge-progress") shareChallengeProgress();
    else if (action === "challenges-retry") loadChallenges();
    else if (action === "open-challenge-form") openChallengeForm(null);
    else if (action === "challenge-edit") { const existing = state.challenges.items.find((x) => x.id === el.dataset.id) || (state.challenges.view && state.challenges.view.challenge); openChallengeForm(existing); }
    else if (action === "challenge-form-cancel") closeChallengeForm();
    else if (action === "challenge-form-type") setChallengeFormType(el.dataset.type);
    else if (action === "challenge-publish") publishChallengeDraft(el.dataset.id);
    else if (action === "challenge-archive") archiveChallenge(el.dataset.id);
    else if (action === "challenge-delete") askConfirm({ title: "מחיקת טיוטה", message: "למחוק את הטיוטה? הפעולה אינה ניתנת לביטול.", confirmLabel: "מחיקה", destructive: true, action: "challenge-delete-draft", payload: { challengeId: el.dataset.id } });
    // COMM-213/217/228. openEvent() itself records EVENT_VIEWED (source
    // defaults to "post_card", and COMM-233 labelled the Boards list cards
    // explicitly for the same reason the challenge ones needed it), the
    // same pattern openChallenge() uses -
    // this used to only track and never actually open anything (the gap
    // the realtime+search cluster's handoff notes flagged for COMM-228's
    // search result), now closed by COMM-213's detail dialog existing.
    else if (action === "open-event") { if (el.dataset.id) openEvent(el.dataset.id, el.dataset.source || "post_card"); }
    else if (action === "close-event-view") closeEventView();
    else if (action === "event-rsvp") rsvpEvent(el.dataset.id, el.dataset.response);
    else if (action === "events-retry") loadEvents();
    else if (action === "open-event-form") openEventForm(null);
    else if (action === "event-edit") { const existing = state.events.byId[el.dataset.id] || (state.events.view && state.events.view.event); openEventForm(existing); }
    else if (action === "event-form-cancel") closeEventForm();
    else if (action === "event-form-type") setEventFormType(el.dataset.type);
    else if (action === "event-publish") publishEventDraft(el.dataset.id);
    else if (action === "event-cancel-confirm") confirmCancelEvent(el.dataset.id);
    else if (action === "event-ics") downloadEventIcs(el.dataset.id);
    // COMM-222 onboarding sequence.
    else if (action === "onboarding-dismiss") dismissOnboardingStep(el.dataset.step);
    // COMM-221 weekly recap surface + share.
    else if (action === "open-recap") openRecap(el.dataset.week || null, el.dataset.source || "account");
    else if (action === "close-recap-view") closeRecapView();
    else if (action === "recap-older") recapGoOlder();
    else if (action === "recap-newer") recapGoNewer();
    else if (action === "recap-retry") refreshRecapView(state.recaps.view && state.recaps.view.weekStart);
    else if (action === "share-recap") shareRecapFigure(el.dataset.figure);
    // COMM-223..226 coach-tools cluster.
    else if (action === "coach-celebrate-retry") loadCoachCelebrate();
    else if (action === "coach-congratulate") {
      const item = state.coach.celebrate.items.find((it) => celebrateItemKey(it) === el.dataset.key);
      if (item) congratulateCelebrateItem(item);
    }
    else if (action === "coach-welcome-retry") loadCoachWelcome();
    else if (action === "coach-welcome-member") coachWelcomeMember(el.dataset.id);
    else if (action === "coach-assign-self") coachAssignCoach(el.dataset.id, state.user && state.user.id);
    else if (action === "coach-assign-clear") coachAssignCoach(el.dataset.id, null);
    else if (action === "coach-assign-handle") coachAssignByHandle(el.dataset.id);
    else if (action === "coach-mark-contacted") coachMarkContacted(el.dataset.id);
    // COMM-315 member of the week.
    else if (action === "coach-mow-retry") loadCoachMemberOfWeek();
    else if (action === "coach-mow-publish-candidate") memberOfWeekPublishCandidate(el.dataset.id);
    else if (action === "coach-mow-publish-pick") memberOfWeekPublishPick();
    else if (action === "coach-engage-retry") loadCoachEngageFlags();
    else if (action === "coach-engage-reach-out") coachEngageReachOut(el.dataset.id);
    else if (action === "coach-engage-review") coachEngageResolveFlag(el.dataset.id, "reviewed");
    else if (action === "coach-engage-dismiss") coachEngageResolveFlag(el.dataset.id, "dismissed");
    // COMM-309 monthly club recap.
    else if (action === "coach-monthly-recap-retry") loadCoachMonthlyRecap();
    else if (action === "coach-monthly-recap-publish") publishMonthlyRecap(el.dataset.id);
  };
  window.isCommunitySignedIn = function () { return !!(state.user && state.profile); };
  window.shareAchievementToCommunity = function (achievementId, title, rule) { publishAchievement(achievementId, title, rule); };
  // Exported for app.js's Community sub-nav (the UI-restructuring track) so
  // it can switch cloud.js's own sub-tab without re-deriving any of the
  // teardown/analytics logic setCommunityTab already does internally.
  window.setCommunityTab = setCommunityTab;
  // Same track, same reason: the four/five sub-tab ids, labels and badge
  // counts a non-staff/staff caller actually sees, without app.js
  // re-deriving the staff gate or the moderation-queue badge count itself.
  // Mirrors the real `tabs` array built inline in renderCommunityApp() -
  // same ids, same order, same "coach" entry only when isStaff() - but
  // computed standalone (no render bodies) so it is cheap to call on every
  // nav-menu open, not just once per Community render.
  window.getCommunityNavPreview = function () {
    const staff = isStaff();
    const pendingReports = (hasPerm(PERM.COMMENT_MODERATE) || isAdmin())
      ? state.admin.modQueue.filter((r) => r.status === "open").length : 0;
    const tabs = [
      { id: "feed", label: "פיד" },
      { id: "boards", label: "לוחות" },
      { id: "directory", label: "חברים" },
      { id: "account", label: "חשבון", badge: pendingReports },
    ];
    if (staff) tabs.push({ id: "coach", label: "לוח מאמנים" });
    return tabs;
  };
  document.addEventListener("submit", (event) => {
    if (event.target.id === "communityProfile") { event.preventDefault(); saveProfile(event.target); }
    else if (event.target.id === "communityAnnouncement") { event.preventDefault(); postAnnouncement(event.target); }
    else if (event.target.id === "communityWeeklyChallenge") { event.preventDefault(); setWeeklyChallenge(event.target); }
    else if (event.target.id === "communityInviteCodeCreate") { event.preventDefault(); createInviteCode(event.target); }
    else if (event.target.id === "communityInviteCreate") { event.preventDefault(); createInvite(event.target); }
    else if (event.target.id === "communityChallengeForm") { event.preventDefault(); submitChallengeForm(event.target); }
    else if (event.target.id === "communityEventForm") { event.preventDefault(); submitEventForm(event.target); }
    else if (event.target.id === "communityInviteCode") { event.preventDefault(); redeemCode(event.target); }
    else if (event.target.id === "communityLogin") { event.preventDefault(); login(event.target); }
    else if (event.target.id === "communityCredentials") { event.preventDefault(); setCredentials(event.target); }
    else if (event.target.id === "backupCredentials") { event.preventDefault(); setCredentials(event.target); }
    else if (event.target.dataset && event.target.dataset.commentPostId) {
      event.preventDefault();
      // COMM-114. The comment interaction is recorded here rather than
      // inside addComment(), which belongs to the engagement cluster.
      // COMM-121. A reply form carries data-comment-parent-id.
      trackFeedInteraction(event.target.dataset.commentPostId, "comment");
      addComment(event.target.dataset.commentPostId, event.target, event.target.dataset.commentParentId || null);
    }
  });
  // COMM-114. "flushed once per feed session, or on view change, whichever
  // comes first" - backgrounding the app is the last chance to write.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushFeedImpressions();
    // COMM-141. The unread count refreshes on app focus.
    else if (document.visibilityState === "visible" && state.user) loadNotifUnread();
  });
  window.addEventListener("focus", () => { if (state.user) loadNotifUnread(); });
  // COMM-170. Leaving the Community tab ends the current club_tab_viewed,
  // so returning to the same sub-tab later counts as a new view instead of
  // being swallowed by the de-dupe. Capture phase, because app.js's own
  // click handler re-renders and this has to have run first. It reads two
  // stable ids and never touches the event.
  document.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest ? e.target.closest(".tabbtn") : null;
    if (btn && btn.id !== "tabCommunityBtn") resetClubTabView();
  }, true);
  window.addEventListener("pagehide", flushFeedImpressions);
  window.addEventListener("online", flushOutbox);
  window.addEventListener("haimunia-sync-needed", () => { maybeAutoStartBackup(); flushOutbox(); pingActivity(); });
  if (client) {
    client.auth.onAuthStateChange((_event, session) => {
      state.user = session ? session.user : null;
      if (state.user) {
        enableSyncIfAllowed();
        // COMM-170. Same reason as refreshSession: configure before the
        // first track(). Idempotent, so whichever path arrives first wins.
        ensureAnalyticsConfigured();
        // COMM-331. A fresh sign-in only happens from within the Community
        // tab's own auth UI, so - unlike refreshSession()'s boot path -
        // this loads community data immediately via ensureCommunityDataLoaded()
        // rather than waiting for another afterRenderCommunity() pass; the
        // member is already looking at it. communityDataLoaded is cleared
        // first so a new session's sign-in isn't skipped by a stale flag
        // left over from whoever was signed in before (or from a
        // not-yet-loaded boot). loadProfile()/loadChallenges() stay eager
        // here too, same reasoning as refreshSession().
        loadRedemption()
          .then(() => Promise.all([loadProfile(), loadChallenges(), loadClubFeatures(), flushOutbox()]))
          .then(pullPrivateRecords)
          .then(pingActivity)
          .then(() => { if (typeof window.syncCommunityMilestones === "function") window.syncCommunityMilestones(); })
          .then(() => { state.communityDataLoaded = false; return ensureCommunityDataLoaded(); })
          .then(rerender);
      } else {
        // COMM-114. Whatever the signed-out member had seen is written
        // before the session id is dropped, not discarded with it.
        flushFeedImpressions();
        // COMM-170. The next session starts its own club_tab_viewed.
        resetClubTabView();
        // COMM-233. A search whose debounce window had not closed when the
        // session ended is dropped rather than written against whoever
        // signs in next (or against no one at all).
        cancelSearchTracking();
        // COMM-209 / COMM-227. Sign-out closes every open channel, the
        // other half of the teardown contract src/realtime.js documents.
        // Until this cluster there was nothing live to close; now the
        // own-row notification channel and the feed's shared channels
        // would otherwise outlive the session that opened them.
        if (window.HaimuniaRealtime) window.HaimuniaRealtime.teardownAll();
        clearRealtimeDebounces();
        state.feed.scope = "for_you"; state.feed.cursor = null; state.feed.end = false; state.feed.pagesLoaded = 0;
        state.feed.sessionId = null; state.feed.seen = {}; state.feed.pending = []; state.club.row = null;
        state.feed.loading = false; state.feed.error = false; state.feed.loadingMore = false; state.feed.moreError = false;
        state.communityDataLoaded = false; state.communityDataLoading = false;
        // The sign-out reset, one namespace per group since COMM-365 (it was
        // one 2.4KB line before). Deliberately NOT a wholesale
        // `state.<ns> = { ...defaults }` per namespace: this list is not the
        // full state literal, and several keys are meant to SURVIVE a sign-out
        // (state.ui.tab, state.leaderboard.hideMine, the two localStorage-
        // backed switches, featureFlags). Assign leaves, never a namespace.
        state.profile = null; state.redemption = null; state.signupStarted = false;
        state.avatarUpload = { status: "idle", error: "" }; state.permissions = []; state.permissionsLoaded = false;
        state.ui.fieldErrors = {}; state.ui.confirmDialog = null;
        // hideMine is per-device and outlives the session - see the literal.
        state.leaderboard.scope = "club"; state.leaderboard.rows = []; state.leaderboard.loading = false;
        state.leaderboard.loaded = false; state.leaderboard.error = false;
        state.feed.items = [];
        state.posts.openShare = {}; state.posts.comparisonForPostId = null; state.posts.comparison = [];
        state.posts.composer = null; state.posts.composerTrigger = null; state.posts.openMenu = null; state.posts.savedIds = {};
        state.posts.captionEdit = null; state.posts.visibilityEdit = null; state.posts.prPrompt = null;
        state.engagement.comments = {}; state.engagement.openComments = {}; state.engagement.commentDrafts = {};
        state.engagement.commentErrors = {}; state.engagement.commentSending = null; state.engagement.commentEdit = null;
        state.engagement.openReplies = {}; state.engagement.replyTo = {}; state.engagement.reactions = {};
        state.engagement.reactionError = null; state.engagement.mentionPicker = null;
        state.members.search = ""; state.members.results = []; state.members.profileView = null; state.members.roles = {};
        state.members.blockedIds = []; state.members.blocksLoaded = false;
        state.members.suggestions = { items: [], loading: false, loaded: false, error: false, busy: {} };
        state.members.directory = { items: [], loading: false, loadingMore: false, loaded: false, error: false, end: false, cursor: null, query: "", searchResults: null, searchLoading: false };
        state.members.classmatesToday = { items: [], loading: false, loaded: false, error: false };
        state.club.streaks = []; state.club.announcements = []; state.club.announcementSaving = false;
        state.club.weeklyChallenge = null; state.club.weeklyLeaderboard = []; state.club.inactiveMembers = [];
        state.club.newMembers = []; state.club.moduleBusy = null; state.club.features = {}; state.club.featuresLoaded = false;
        state.admin.reports = []; state.admin.modQueue = []; state.admin.modQueueLoaded = false;
        state.admin.modQueueStatus = "open"; state.admin.modQueueLoading = false; state.admin.modQueueError = false;
        state.admin.modAction = null; state.admin.modContext = null; state.admin.reportSheet = null; state.admin.pins = [];
        state.admin.pinsLoaded = false; state.admin.pinError = ""; state.admin.auditLog = []; state.admin.auditCursor = null;
        state.admin.auditLoaded = false; state.admin.auditLoading = false; state.admin.auditError = false;
        state.admin.auditEnd = false; state.admin.auditFilters = {};
        // COMM-376/377. The next session on this device (a different member
        // signing in) gets fresh panels, never a stale one-time code reveal
        // or another admin's roster page left on screen.
        state.admin.invites = { items: [], status: "all", cursor: null, loading: false, loadingMore: false, loaded: false, error: false, end: false, created: null, revoking: null };
        state.admin.inviteCodes = { items: [], loading: false, loaded: false, error: false, created: null, busy: null };
        state.admin.roster = { items: [], cursor: null, loading: false, loadingMore: false, loaded: false, error: false, end: false };
        state.challenges.items = []; state.challenges.loaded = false; state.challenges.loading = false;
        state.challenges.error = false; state.challenges.participation = {}; state.challenges.aggregates = {};
        state.challenges.view = null; state.challenges.form = null; state.challenges._rtId = null;
        state.challenges._consistencyWeekLogged = {}; state.challenges._consistencySessionCounts = {};
        state.events.items = []; state.events.byId = {}; state.events.loaded = false; state.events.loading = false;
        state.events.error = false; state.events.attendees = {}; state.events.view = null; state.events.form = null;
        state.search.events = []; state.search.challenges = []; state.search.query = ""; state.search.loading = false;
        state.achievements.mine = []; state.achievements.unlock = null;
        state.notif.center = null; state.notif.unread = 0; state.notif.prefs = {}; state.notif.prefsLoaded = false;
        state.notif.prefSaving = {}; state.notif._rtUid = null; state.notif.pushSub = null; state.notif.pushChecked = false;
        state.onboarding.progress = null; state.onboarding.firstMonth = null;
        state.onboarding.attendance = { count: 0, loading: false, loaded: false, error: false }; /* COMM-316: same reset reasoning as members.classmatesToday above - the next member on this device gets a fresh count, never the previous member's. */
        state.onboarding.stepContent = {}; state.onboarding.stepContentLoaded = false; state.onboarding.stepContentError = false;
        state.onboarding.editor = { drafts: {}, saving: {}, saved: {} };
        state.analytics.registrationFunnel = { loading: false, loaded: false, error: false, errorText: "", data: null };
        state.recaps.view = null; state.recaps.monthly = { loading: false, loaded: false, error: false, row: null };
        state.coach.celebrate = { items: [], loading: false, loaded: false, error: false, congratulated: {}, busy: null };
        state.coach.welcome = { members: [], loading: false, loaded: false, error: false, contactedIds: {}, assignDrafts: {}, contactDrafts: {}, busy: null };
        state.coach.engage = { items: [], loading: false, loaded: false, error: false, profiles: {}, reachedOut: {}, busy: null };
        state.coach.memberOfWeek = { loading: false, loaded: false, error: false, envelope: null, publishedProfile: null, previousProfile: null, pickHandle: "", pickReason: "", busy: null, publishErr: "" };
        state.coach.monthlyRecap = { loading: false, loaded: false, error: false, row: null, busy: null, publishErr: "" };
        classmatesCardViewLogged = false; /* COMM-307: the next member to sign in on this device gets a fresh card and a fresh classmates_card_viewed, never the previous session's rows or its already-counted view. */
        anonSignInAttempted = false;
        recoveryVerifyAttempted = false;
        rerender();
      }
    });
    refreshSession();
  }

  // COMM-102/103/105. The composer, caption editor and PR prompt render in the
  // global cloud overlay (renderCloudConfirmDialog), which is outside the
  // Community tab's afterRenderCommunity() hook, so their inputs are wired here
  // by delegation instead.
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (!t || !t.dataset) return;
    if ("composerBody" in t.dataset) composerSetBody(t.value);
    else if ("commentInput" in t.dataset) onCommentInput(t);
    else if ("commentEditInput" in t.dataset && state.engagement.commentEdit) state.engagement.commentEdit.body = t.value;
    else if ("composerAlt" in t.dataset) composerSetAlt(t.dataset.composerAlt, t.value);
    else if ("captionEdit" in t.dataset && state.posts.captionEdit) state.posts.captionEdit.body = t.value;
    else if ("prNote" in t.dataset && state.posts.prPrompt) state.posts.prPrompt.note = t.value;
    else if ("prAlt" in t.dataset && state.posts.prPrompt && state.posts.prPrompt.photo) state.posts.prPrompt.photo.altText = t.value;
    else if ("achNote" in t.dataset && state.achievements.unlock) state.achievements.unlock.note = t.value;
    // COMM-151 / COMM-153. Free-text notes on the report and moderation
    // sheets. Kept in state, not read off the DOM at submit, so a rerender
    // never drops what was typed.
    else if ("reportNote" in t.dataset && state.admin.reportSheet) state.admin.reportSheet.note = t.value;
    else if ("modNote" in t.dataset && state.admin.modAction) state.admin.modAction.note = t.value;
    // COMM-378. onboardingEditorDraft() lazily seeds the draft the first
    // time either field is touched, same "kept in state, not read off the
    // DOM at submit" reasoning as every note/body field above - a rerender
    // triggered by a sibling row's own save never drops what was typed here.
    else if ("onboardingEditTitle" in t.dataset) onboardingEditorDraft(t.dataset.onboardingEditTitle).title = t.value;
    else if ("onboardingEditBody" in t.dataset) onboardingEditorDraft(t.dataset.onboardingEditBody).body = t.value;
    // COMM-202..206. The manual progress form and the coach entry roster,
    // both inside the challenge detail dialog. Kept in state, not read off
    // the DOM at submit, same reasoning as every other note/body field
    // above: a rerender (a progress refresh, a sibling row's own submit)
    // never drops what was already typed here.
    else if ("challengeLogDelta" in t.dataset && state.challenges.view) state.challenges.view.logForm.delta = t.value;
    else if ("challengeLogNote" in t.dataset && state.challenges.view) state.challenges.view.logForm.note = t.value;
    else if ("challengeCoachDelta" in t.dataset && state.challenges.view) {
      const uid = t.dataset.challengeCoachDelta;
      const d = state.challenges.view.coachEntry.drafts[uid] || (state.challenges.view.coachEntry.drafts[uid] = { delta: "", note: "" });
      d.delta = t.value;
    }
    else if ("challengeCoachNote" in t.dataset && state.challenges.view) {
      const uid = t.dataset.challengeCoachNote;
      const d = state.challenges.view.coachEntry.drafts[uid] || (state.challenges.view.coachEntry.drafts[uid] = { delta: "", note: "" });
      d.note = t.value;
    }
    // COMM-308. The team-rename text input's own draft, same shape as
    // challengeLogDelta/challengeCoachDelta above - kept in state so a
    // sibling row's own save (which re-renders the whole management block)
    // never drops what was already typed here.
    else if ("challengeTeamRenameName" in t.dataset && state.challenges.view) {
      state.challenges.view.teamMgmt.renameDrafts[t.dataset.challengeTeamRenameName] = t.value;
    }
    else if ("challengeTeamCreateName" in t.dataset && state.challenges.view) {
      state.challenges.view.teamMgmt.createName = t.value;
    }
  });
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (!t || !t.dataset) return;
    if ("composerFile" in t.dataset) { const f = t.files && t.files[0]; if (f) composerAddPhoto(f); try { t.value = ""; } catch (err) {} }
    else if ("avatarFile" in t.dataset) { const f = t.files && t.files[0]; if (f) avatarPhotoSelected(f); try { t.value = ""; } catch (err) {} }
    else if ("composerDecorative" in t.dataset) composerToggleDecorative(t.dataset.composerDecorative, t.checked);
    else if ("composerVisibility" in t.dataset) composerSetVisibility(t.value);
    else if ("prFile" in t.dataset) { const f = t.files && t.files[0]; if (f) prPromptAddPhoto(f); }
    // COMM-151. The report reason radio.
    else if ("reportReason" in t.dataset && t.checked) setReportReason(t.dataset.reportReason);
    // COMM-308. The captain and reassign <select>s act immediately on
    // change, the same shape composerVisibility already uses above - no
    // extra "save" button, since a <select> only fires change when its
    // value actually moved.
    else if ("challengeTeamCaptainSelect" in t.dataset) setChallengeTeamCaptain(t.dataset.challengeTeamCaptainSelect, t.value || null);
    else if ("challengeTeamReassignSelect" in t.dataset && state.challenges.view && state.challenges.view.challenge) {
      reassignChallengeParticipant(state.challenges.view.challenge.id, t.dataset.challengeTeamReassignSelect, t.value || null);
    }
  });
  document.addEventListener("keydown", (e) => {
    // COMM-123. Mention picker keyboard navigation while a comment input has
    // focus and its picker is open.
    if (state.engagement.mentionPicker) {
      const t = e.target;
      if (t && t.dataset && "commentInput" in t.dataset && t.dataset.commentKey === state.engagement.mentionPicker.key) {
        const items = state.engagement.mentionPicker.results || [];
        if (e.key === "ArrowDown") { e.preventDefault(); state.engagement.mentionPicker.index = Math.min(Math.max(items.length - 1, 0), (state.engagement.mentionPicker.index || 0) + 1); rerender(); restoreCommentFocus(state.engagement.mentionPicker.key, t.selectionStart); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); state.engagement.mentionPicker.index = Math.max(0, (state.engagement.mentionPicker.index || 0) - 1); rerender(); restoreCommentFocus(state.engagement.mentionPicker.key, t.selectionStart); return; }
        if (e.key === "Enter" && items.length) { e.preventDefault(); const m = items[state.engagement.mentionPicker.index || 0]; mentionPick(state.engagement.mentionPicker.key, m.id, m.display_name || m.handle); return; }
        if (e.key === "Escape") { e.preventDefault(); const k = state.engagement.mentionPicker.key; state.engagement.mentionPicker = null; rerender(); restoreCommentFocus(k, t.selectionStart); return; }
      }
    }
    // COMM-190. Every Phase 1 overlay dialog traps Tab within itself.
    if (e.key === "Tab") {
      const dk = currentCloudDialog();
      if (dk) {
        const dlg = cloudDialogEl(dk);
        const nodes = cloudDialogFocusables(dlg);
        if (nodes.length) {
          const first = nodes[0], last = nodes[nodes.length - 1];
          const a = document.activeElement;
          if (e.shiftKey && (a === first || !dlg.contains(a))) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && (a === last || !dlg.contains(a))) { e.preventDefault(); first.focus(); }
        }
      }
      return;
    }
    if (e.key !== "Escape") return;
    if (state.admin.reportSheet) { e.preventDefault(); closeReportSheet(); return; }
    if (state.admin.modAction) { e.preventDefault(); closeModAction(); return; }
    if (state.admin.modContext) { e.preventDefault(); closeModContext(); return; }
    if (state.notif.center) { e.preventDefault(); closeNotifCenter(); return; }
    if (state.achievements.unlock) { e.preventDefault(); dismissAchievementUnlock(); return; }
    if (state.posts.prPrompt) { e.preventDefault(); dismissPrPrompt(); return; }
    if (state.posts.composer) { e.preventDefault(); tryCloseComposer(); return; }
    if (state.members.profileView) { e.preventDefault(); closeCommunityProfile(); return; }
    if (state.challenges.view) { e.preventDefault(); closeChallengeView(); return; }
    if (state.events.view) { e.preventDefault(); closeEventView(); return; }
    if (state.recaps.view) { e.preventDefault(); closeRecapView(); return; }
    if (state.posts.openMenu) { state.posts.openMenu = null; rerender(); }
  });
  // COMM-190. A click on the dim backdrop - the overlay element itself, not
  // its sheet or any control inside - closes the dialog, same as Escape.
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!t || typeof t.getAttribute !== "function") return;
    const key = t.getAttribute("data-cloud-dialog");
    if (!key) return;
    const spec = CLOUD_DIALOGS.find((d) => d.key === key);
    if (spec) spec.close();
  });
  // Consume PR_CREATED from the product event bus (COMM-012). Detection is the
  // achievements agent's COMM-132; this only reacts to the record it passes.
  if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.PR_CREATED) {
    window.HaimuniaEvents.on(window.PRODUCT_EVENTS.PR_CREATED, onPrCreated);
    // COMM-202. A second, independent handler on the same event: an
    // individual_performance challenge the caller has joined logs a delta
    // from the same PR, alongside (not instead of) the Share This PR prompt.
    window.HaimuniaEvents.on(window.PRODUCT_EVENTS.PR_CREATED, onPrCreatedForChallenges);
  }
  // COMM-202/205. WORKOUT_COMPLETED has no producer anywhere in this
  // codebase yet (see the comment on onWorkoutCompletedForChallenges) - the
  // subscription is wired now so a future workout-logging surface needs no
  // client change to start feeding individual_target and consistency
  // challenges the moment it starts emitting this event.
  if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.WORKOUT_COMPLETED) {
    window.HaimuniaEvents.on(window.PRODUCT_EVENTS.WORKOUT_COMPLETED, onWorkoutCompletedForChallenges);
  }
  // COMM-134. Consume ACHIEVEMENT_UNLOCKED from the product bus (COMM-012).
  // The producer is claimCommunityAchievements() above for client-detected
  // milestones, or ach_evaluate server-side for community and challenge
  // unlocks once that path lands. Either way this shows one celebration.
  if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.ACHIEVEMENT_UNLOCKED) {
    window.HaimuniaEvents.on(window.PRODUCT_EVENTS.ACHIEVEMENT_UNLOCKED, onAchievementUnlocked);
  }
  // COMM-222. A fresh redemption in this same tab should not have to wait
  // for a reload before its onboarding_progress row (seeded server-side by
  // the same invite_redemptions insert) is fetched and the welcome step
  // can render.
  if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.MEMBER_JOINED) {
    window.HaimuniaEvents.on(window.PRODUCT_EVENTS.MEMBER_JOINED, () => { loadOnboardingProgress().then(rerender); });
  }
})();
