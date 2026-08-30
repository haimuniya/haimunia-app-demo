(function () {
  "use strict";
  const cfg = window.HAIMUNIA_CONFIG || {};
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(cfg.supabaseUrl || "") && !!cfg.supabasePublishableKey;
  const client = configured && window.supabase ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  }) : null;
  const state = { configured, client, user: null, profile: null, feed: [], people: [], comparison: [], comparisonForPostId: null, loading: false, message: "", syncEnabled: localStorage.getItem("haimunia-demo:cloudSyncEnabled") === "1",
    streaks: [], announcements: [], weeklyChallenge: null, weeklyLeaderboard: [], inactiveMembers: [], newMembers: [], redemption: null,
    communityTab: "feed", comments: {}, openComments: {}, fieldErrors: {}, reports: [], confirmDialog: null, signupStarted: false, memberSearch: "", memberResults: [], openShare: {},
    // COMM-120..125 engagement cluster.
    commentDrafts: {}, commentErrors: {}, commentSending: null, commentEdit: null, openReplies: {}, replyTo: {},
    // COMM-124 / COMM-160. One batched, cached user-id -> server role map,
    // shared by the comment coach emphasis and the coach badge on every
    // other surface a member is shown.
    memberRoles: {},
    reactions: {}, reactionError: null, blockedIds: [], blocksLoaded: false, mentionPicker: null,
    composer: null, composerTrigger: null, openPostMenu: null, savedPostIds: {}, captionEdit: null, visibilityEdit: null, prPrompt: null, profileView: null,
    // COMM-130/134 achievements cluster.
    myAchievements: [], achUnlock: null,
    // COMM-140..144 notifications cluster.
    notifCenter: null, notifUnread: 0, notifUnreadLoaded: false, notifPrefs: {}, notifPrefsLoaded: false, notifPrefSaving: {}, _notifRtUid: null,
    // COMM-110..115 feed cluster. state.feed holds feed_page() rows in the
    // exact order the function returned them and is never re-sorted here.
    feedScope: "for_you", feedCursor: null, feedLoading: false, feedError: false,
    feedLoadingMore: false, feedMoreError: false, feedEnd: false, feedPagesLoaded: 0,
    feedSessionId: null, feedSeen: {}, feedPending: [], club: null,
    // COMM-150..156 admin-moderation cluster. permissions is the caller's
    // permission set from my_permissions(), cached once per session and read
    // through hasPerm(); the server policy behind each control is the real
    // authority. modQueue holds mod_queue() rows. pins holds pin rows for
    // the club strip. auditLog holds admin_actions_page() rows.
    permissions: [], permissionsLoaded: false,
    modQueue: [], modQueueStatus: "open", modQueueLoading: false, modQueueError: false, modQueueLoaded: false,
    modAction: null, modContext: null, reportSheet: null,
    pins: [], pinsLoaded: false, pinError: "",
    auditLog: [], auditCursor: null, auditLoading: false, auditError: false, auditLoaded: false, auditEnd: false, auditFilters: {},
    // COMM-201..207 challenges cluster. state.challenges holds every
    // `challenges` row the caller may see (challenges_read already scopes
    // out a draft that is not theirs), sorted soonest end_at first.
    // challengeParticipation is the caller's own challenge_participants row
    // per challenge_id, loaded alongside the list so a card can show
    // Join/Joined without a per-card round trip. challengeAggregates is
    // chal_progress() output cached per challenge_id, fetched only for the
    // types whose card needs an aggregate figure (cooperative, team) - every
    // other type's card reads straight off challengeParticipation. challengeView
    // is the open detail dialog (COMM-207); challengeForm is the staff
    // create/edit dialog (COMM-201).
    challenges: [], challengesLoaded: false, challengesLoading: false, challengesError: false,
    challengeParticipation: {}, challengeAggregates: {},
    challengeView: null, challengeForm: null,
    // COMM-209. The challenge id whose realtime channels are currently open,
    // so re-arming after a teardown is idempotent and switching challenges
    // closes the previous pair rather than stacking a second one.
    _chalRtId: null,
    // COMM-228 search cluster. One community_search() call fills all three
    // groups. state.people keeps its name and its exact row shape - it is
    // still the members group and still what the follow/block/profile
    // controls read - so widening the search did not change the existing
    // caller. searchQuery is what the member typed, kept verbatim so a
    // re-render can put it back in the box; only the request is sanitized.
    searchEvents: [], searchChallenges: [], searchQuery: "", searchLoading: false,
    // In-memory only (COMM-205): which ISO week a consistency challenge has
    // already logged a "week hit" delta for on this device this session, so
    // a repeated WORKOUT_COMPLETED burst within the same week cannot log
    // twice. Never persisted - a real attendance source replaces this
    // client-side tally entirely (COMM-306, Phase 3).
    _consistencyWeekLogged: {}, _consistencySessionCounts: {},
    // COMM-213..217 events cluster. state.events holds every `events` row
    // the caller may see (events_read already scopes out a draft that is
    // not theirs), sorted soonest start_at first. eventsById is the same
    // rows keyed by id, read both by the POST_EVENT card upgrade and by the
    // feed top-area card. eventAttendees is every event_attendees row the
    // caller may see (event_attendees_read's own show_in_attendee_lists
    // filter already applies), keyed by event_id, which is what both the
    // going count and the attendee list read. eventView is the open detail
    // dialog; eventForm is the staff create/edit dialog.
    events: [], eventsById: {}, eventsLoaded: false, eventsLoading: false, eventsError: false,
    eventAttendees: {}, eventView: null, eventForm: null };
  const photoUrlCache = {};

  // COMM-141. The notification badge refreshes on a realtime own-row
  // event. That subscription was written before public.notifications was
  // in the supabase_realtime publication, so it was a working no-op until
  // 202608290007 landed; COMM-227 is the ticket that made it live, with no
  // change to the subscription itself.
  if (client && window.HaimuniaRealtime && typeof window.HaimuniaRealtime.configure === "function") {
    window.HaimuniaRealtime.configure({ client });
  }

  // --- COMM-170 analytics ------------------------------------------------
  // The tracked event names (COMM-013) and the one call into the helper.
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

  function safeText(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
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
  };
  function hasPerm(code) { return !!state.permissions && state.permissions.indexOf(code) >= 0; }
  async function loadPermissions() {
    if (!state.user) { state.permissions = []; state.permissionsLoaded = false; return; }
    const { data, error } = await client.rpc("my_permissions");
    state.permissions = error ? [] : (data || []);
    state.permissionsLoaded = !error;
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
  function setMessage(message) { state.message = message || ""; rerender(); }
  function todayIso() { return new Date().toISOString().slice(0, 10); }
  function setFieldErrors(formId, errors) {
    if (errors && Object.keys(errors).length) state.fieldErrors[formId] = errors;
    else delete state.fieldErrors[formId];
    rerender();
  }
  // Compact, deterministic per-identity color so the same person always
  // gets the same avatar color across the feed, comments and search.
  const AVATAR_PALETTE = ["var(--energy)", "var(--blue)", "var(--teal)", "var(--purple)", "var(--green)", "var(--brass)"];
  function avatarHtml(name, size) {
    const label = String(name || "?").trim();
    const initial = label ? label[0].toUpperCase() : "?";
    let hash = 0;
    for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
    const color = AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
    const px = size || 36;
    return `<span aria-hidden="true" class="avatar-badge" style="width:${px}px;height:${px}px;font-size:${Math.round(px * 0.42)}px;background:${color};">${safeText(initial)}</span>`;
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

  async function refreshSession() {
    if (!client) return;
    const { data } = await client.auth.getSession();
    state.user = data.session ? data.session.user : null;
    if (state.user) {
      // COMM-170. First thing in the session-ready path, so every track()
      // below it writes instead of dropping.
      ensureAnalyticsConfigured();
      await loadRedemption();
      await Promise.all([loadProfile(), loadPermissions(), loadFeed(), loadStreaks(), loadAnnouncements(), loadWeeklyChallenge(), loadClubSummary(), loadBlockedIds(), loadMyAchievements(), loadNotifUnread(), loadNotifPrefs(), loadPins(), loadChallenges(), loadEvents()]);
      if (isStaff()) await Promise.all([loadInactiveMembers(), loadNewMembers()]);
      if (hasPerm(PERM.COMMENT_MODERATE) || isAdmin()) await loadModQueue();
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
      // COMM-141. Arm the own-row notification channel for this session.
      ensureNotifRealtime();
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
    if (data !== "member") return setFieldErrors("communityInviteCode", { code: "קוד ההזמנה שגוי, פג תוקף או נוצל" });
    setFieldErrors("communityInviteCode", {});
    await loadRedemption();
    setMessage("קוד אושר, אפשר להשלים פרופיל");
    rerender();
  }
  // One row per user per day they had the app open — the raw dates stay
  // private (activity_pings RLS is self-only); this only ever records
  // today, so a missed day just isn't there rather than being backfilled.
  async function pingActivity() {
    if (!client || !state.user) return;
    await client.from("activity_pings").upsert({ user_id: state.user.id, activity_date: todayIso() }, { onConflict: "user_id,activity_date", ignoreDuplicates: true }).catch(() => {});
  }
  async function loadStreaks() {
    if (!state.user) return;
    const { data, error } = await client.from("community_streaks").select("user_id,handle,display_name,current_streak,last_activity_on").order("current_streak", { ascending: false }).limit(50);
    state.streaks = error ? [] : (data || []).filter((r) => r.current_streak > 0);
  }
  async function loadAnnouncements() {
    if (!state.user) return;
    const { data, error } = await client.from("announcements").select("id,title,body,created_at,pinned_date,profiles(handle,display_name)").order("created_at", { ascending: false }).limit(20);
    state.announcements = error ? [] : (data || []);
  }
  async function postAnnouncement(form) {
    if (!state.user || !isStaff()) return;
    const title = String(form.elements.title.value || "").trim().slice(0, 120);
    const body = String(form.elements.body.value || "").trim().slice(0, 2000);
    const errors = {};
    if (!title) errors.title = "יש למלא כותרת";
    if (!body) errors.body = "יש למלא תוכן להודעה";
    if (Object.keys(errors).length) return setFieldErrors("communityAnnouncement", errors);
    setFieldErrors("communityAnnouncement", {});
    const payload = { author_id: state.user.id, title, body };
    if (form.elements.pinToday && form.elements.pinToday.checked) payload.pinned_date = todayIso();
    const { error } = await client.from("announcements").insert(payload);
    if (error) return setMessage("פרסום ההודעה נכשל");
    form.reset(); await loadAnnouncements(); setMessage("ההודעה פורסמה"); rerender();
  }
  async function loadWeeklyChallenge() {
    if (!state.user) return;
    const { data, error } = await client.from("weekly_challenge_leaderboard").select("*").limit(50);
    if (error || !data || !data.length) { state.weeklyChallenge = null; state.weeklyLeaderboard = []; return; }
    state.weeklyChallenge = { title: data[0].title, comparisonKey: data[0].comparison_key, startsOn: data[0].starts_on, endsOn: data[0].ends_on };
    state.weeklyLeaderboard = data.sort((a, b) => a.score_direction === "lower" ? Number(a.score_value) - Number(b.score_value) : Number(b.score_value) - Number(a.score_value));
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
    state.inactiveMembers = error ? [] : (data || []);
  }
  async function loadNewMembers() {
    if (!state.user || !isStaff()) return;
    const { data, error } = await client.rpc("coach_new_members");
    state.newMembers = error ? [] : (data || []);
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
    if (!state.user || !(hasPerm(PERM.COMMENT_MODERATE) || isAdmin())) { state.modQueue = []; return; }
    state.modQueueLoading = true; state.modQueueError = false; rerender();
    const { data, error } = await client.rpc("mod_queue", { p_status: state.modQueueStatus, p_cursor: null, p_limit: 50 });
    state.modQueueLoading = false;
    state.modQueueLoaded = true;
    if (error) { state.modQueueError = true; state.modQueue = []; rerender(); return; }
    state.modQueue = data || [];
    rerender();
  }
  function setModQueueStatus(status) {
    if (!MOD_QUEUE_STATUSES.some((s) => s.id === status) || state.modQueueStatus === status) return;
    state.modQueueStatus = status;
    loadModQueue();
  }
  function openModContext(reportId) {
    const item = (state.modQueue || []).find((r) => r.report_id === reportId);
    if (!item) return;
    state.modContext = item;
    rerender();
  }
  function closeModContext() { state.modContext = null; rerender(); }
  function openModAction(reportId, decision) {
    const item = (state.modQueue || []).find((r) => r.report_id === reportId);
    if (!item || !MOD_DECISIONS.some((d) => d.id === decision)) return;
    state.modAction = { reportId, decision, note: "", days: 7, saving: false, error: "", targetType: item.target_type };
    rerender();
  }
  function closeModAction() { state.modAction = null; rerender(); }
  async function runModAction() {
    const a = state.modAction;
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
    state.modAction = null;
    // The card carried a post that was removed - drop it from the feed too.
    if (a.decision === "remove" && a.targetType === "post") {
      const it = (state.modQueue || []).find((r) => r.report_id === a.reportId);
      if (it && Array.isArray(state.feed)) state.feed = state.feed.filter((p) => p && p.id !== it.target_id);
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
    state.memberSearch = query;
    const q = String(query || "").trim();
    if (q.length < 2) { state.memberResults = []; return rerender(); }
    const { data, error } = await client.rpc("admin_search_members", { p_query: q });
    state.memberResults = error ? [] : (data || []);
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
    await searchMembers(state.memberSearch);
  }
  async function adminSetRole(userId, roleCode) {
    if (!state.user || !isAdmin()) return;
    if (roleCode === "member") return adminRevokeCoach(userId);
    if (roleCode === "coach") return adminGrantCoach(userId);
    if (roleCode !== "head_coach") return;
    const { error } = await client.rpc("admin_grant_coach", { p_user_id: userId, p_role: "head_coach" });
    if (error) return setMessage("שינוי ההרשאה נכשל");
    setMessage("ההרשאה עודכנה ל" + roleCodeLabel(roleCode));
    await searchMembers(state.memberSearch);
  }
  async function adminRevokeCoach(userId) {
    if (!state.user || !isAdmin()) return;
    const { error } = await client.rpc("admin_revoke_coach", { p_user_id: userId });
    if (error) return setMessage("ביטול ההרשאה נכשל");
    setMessage("הרשאת מאמן/ת בוטלה");
    await searchMembers(state.memberSearch);
  }
  // ---- Pinned content (COMM-155) --------------------------------------
  // Read is open to every member; pin_set / pin_clear are the only write
  // paths and both check community.content.pin and write admin_actions in
  // one transaction. The cap of 3 is a slot column server-side, so a fourth
  // pin_set raises pin_limit_reached rather than silently succeeding.
  async function loadPins() {
    if (!state.user) { state.pins = []; return; }
    const { data, error } = await client.from("pins")
      .select("id,target_type,target_id,slot,note,created_at")
      .order("slot", { ascending: true });
    state.pins = error ? [] : (data || []);
    state.pinsLoaded = !error;
  }
  async function pinTarget(targetType, targetId, note) {
    if (!state.user || !hasPerm(PERM.CONTENT_PIN)) return;
    state.pinError = "";
    const { error } = await client.rpc("pin_set", { p_target_type: targetType, p_target_id: targetId, p_note: String(note || "").slice(0, 200) });
    if (error) {
      state.pinError = (error.message || "") === "pin_limit_reached"
        ? "אפשר להצמיד עד שלושה פריטים. יש לבטל הצמדה קיימת קודם."
        : "לא ניתן היה לעדכן את ההצמדות.";
      return rerender();
    }
    await loadPins();
    setMessage("הפריט הוצמד");
  }
  async function unpinTarget(targetType, targetId) {
    if (!state.user || !hasPerm(PERM.CONTENT_PIN)) return;
    state.pinError = "";
    const { error } = await client.rpc("pin_clear", { p_target_type: targetType, p_target_id: targetId });
    if (error) { state.pinError = "לא ניתן היה לעדכן את ההצמדות."; return rerender(); }
    await loadPins();
    setMessage("ההצמדה בוטלה");
  }
  // ---- Admin audit view (COMM-154) -----------------------------------
  // Read-only, gated on community.analytics.view. admin_actions_page checks
  // the same permission again inside the function and once more via the
  // table's own select policy, so a client-only gate here changes nothing.
  async function loadAuditLog(reset) {
    if (!state.user || !hasPerm(PERM.ANALYTICS_VIEW)) { state.auditLog = []; return; }
    if (state.auditLoading) return;
    state.auditLoading = true; state.auditError = false;
    if (reset) { state.auditLog = []; state.auditCursor = null; state.auditEnd = false; }
    rerender();
    const filters = {};
    if (state.auditFilters.action_type) filters.action_type = state.auditFilters.action_type;
    if (state.auditFilters.admin_id) filters.admin_id = state.auditFilters.admin_id;
    const { data, error } = await client.rpc("admin_actions_page", { p_cursor: state.auditCursor, p_limit: 25, p_filters: filters });
    state.auditLoading = false;
    state.auditLoaded = true;
    if (error) { state.auditError = true; rerender(); return; }
    const rows = data || [];
    state.auditLog = reset ? rows : state.auditLog.concat(rows);
    state.auditCursor = rows.length ? rows[rows.length - 1].created_at : state.auditCursor;
    state.auditEnd = rows.length < 25;
    rerender();
  }
  function setAuditFilter(key, value) {
    state.auditFilters = Object.assign({}, state.auditFilters);
    if (value) state.auditFilters[key] = value; else delete state.auditFilters[key];
    loadAuditLog(true);
  }
  // ---- Report flow (COMM-151) --------------------------------------
  // A member reports a post or a comment, picks a reason, optionally adds
  // detail, and gets a plain acknowledgement. Nothing about what follows is
  // disclosed. Duplicate reports on the same target by the same member
  // collapse server-side; the reporter count still moves once.
  function openReportSheet(targetType, targetId) {
    if (!state.user) return;
    state.reportSheet = { targetType, targetId, reason: "", note: "", saving: false, error: "", done: false };
    rerender();
  }
  function closeReportSheet() { state.reportSheet = null; rerender(); }
  function setReportReason(reason) { if (state.reportSheet) { state.reportSheet.reason = reason; state.reportSheet.error = ""; rerender(); } }
  async function submitReportSheet() {
    const s = state.reportSheet;
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
  async function adminRemoveMember(userId) {
    if (!state.user || !isAdmin()) return;
    const { error } = await client.rpc("admin_remove_member", { p_user_id: userId });
    if (error) return setMessage("הסרת החבר/ה נכשלה");
    setMessage("החבר/ה הוסר/ה");
    await searchMembers(state.memberSearch);
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
    state.feedSessionId = newFeedId();
    state.feedSeen = {};
  }

  // COMM-110/113. One page. The cursor is opaque: the client stores it and
  // hands it back, it never parses or derives one.
  async function fetchFeedPage() {
    const { data, error } = await client.rpc("feed_page", {
      p_cursor: state.feedCursor,
      p_limit: FEED_PAGE_SIZE,
      p_scope: state.feedScope,
    });
    if (error) return false;
    const rows = Array.isArray(data) ? data : (data ? [data] : []);
    // Appended in the order feed_page returned them. No sort, no filter, no
    // re-ordering of any kind on this side.
    for (const row of rows) state.feed.push(row);
    state.feedPagesLoaded += 1;
    const next = rows.length ? rows[rows.length - 1].next_cursor : null;
    state.feedCursor = next || null;
    state.feedEnd = !next;
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
    const pages = Math.max(1, state.feedPagesLoaded || 1);
    startFeedSession();
    state.loading = true;
    state.feedLoading = true;
    state.feedError = false;
    state.feedMoreError = false;
    state.feed = [];
    state.feedCursor = null;
    state.feedEnd = false;
    state.feedPagesLoaded = 0;
    let ok = true;
    for (let i = 0; i < pages; i++) {
      ok = await fetchFeedPage();
      if (!ok || state.feedEnd) break;
    }
    state.feedError = !ok;
    state.message = ok ? "" : "לא ניתן לטעון את הקהילה כרגע";
    state.feedLoading = false;
    state.loading = false;
  }

  // COMM-113. The "load more" control and the intersection sentinel both
  // land here. Earlier items are kept on failure, per the ticket.
  async function loadMoreFeed() {
    if (!state.user || state.feedLoadingMore || state.feedEnd || !state.feedCursor) return;
    state.feedLoadingMore = true;
    state.feedMoreError = false;
    rerender();
    const ok = await fetchFeedPage();
    state.feedMoreError = !ok;
    state.feedLoadingMore = false;
    rerender();
  }

  // COMM-111. Switching a filter is a new feed session, not a re-filter of
  // what is already in memory: the ranking is per scope and only the server
  // knows it.
  function setFeedScope(scope) {
    const def = FEED_SCOPES.find((s) => s.id === scope);
    if (!def || def.parked || def.id === state.feedScope) return;
    state.feedScope = def.id;
    state.feedPagesLoaded = 0;
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
    state.club = error ? null : (data || null);
  }

  // --- COMM-114 impressions and interactions --------------------------------
  // A card counts as seen once it has been at least half visible for a
  // second. Rows queue up and are written in one batched call per feed
  // session (or per 50 rows, which is the server's cap), never on the render
  // path - nothing here is awaited by anything that draws.
  function noteFeedImpression(postId, position) {
    if (!postId || !state.feedSessionId) return;
    if (state.feedSeen[postId]) return;
    state.feedSeen[postId] = true;
    // COMM-170. The ranking pipeline reads feed_impressions (COMM-114);
    // the product metric reads analytics_events. Two tables, two consumers,
    // one trigger - and the state.feedSeen guard above is what makes both
    // of them exactly once per post per feed session.
    track(A.POST_IMPRESSION, { post_id: postId, position: Math.max(0, Number(position) || 0), feed_session_id: state.feedSessionId });
    state.feedPending.push({
      post_id: postId,
      position: Math.max(0, Number(position) || 0),
      feed_session_id: state.feedSessionId,
      shown_at: new Date().toISOString(),
    });
    if (state.feedPending.length >= FEED_IMPRESSION_BATCH) flushFeedImpressions();
  }
  function flushFeedImpressions() {
    if (!client || !state.user || !state.feedPending.length) return;
    const rows = state.feedPending;
    state.feedPending = [];
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
    if (!state.user || !state.feedSessionId) return;
    if (feedObserver) { try { feedObserver.disconnect(); } catch (e) {} feedObserver = null; }
    const cards = Array.prototype.slice.call(document.querySelectorAll("#communityFeedList [data-post-id]"));
    if (!cards.length) return;
    const positionOf = (el) => {
      const id = el.getAttribute("data-post-id");
      const idx = state.feed.findIndex((p) => p && String(p.id) === id);
      return idx < 0 ? 0 : idx;
    };
    if (typeof window.IntersectionObserver !== "function") {
      for (const el of cards) {
        const id = el.getAttribute("data-post-id");
        if (state.feedSeen[id] || feedDwellTimers[id]) continue;
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
          if (state.feedSeen[id] || feedDwellTimers[id]) continue;
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
    return safeText(String(body == null ? "" : body)).replace(new RegExp(MENTION_MARKER_RE.source, "g"),
      function (full, name, id) {
        return '<button type="button" class="link-btn mention-chip" data-community-action="view-profile" data-id="' + id + '" style="padding:0;font-weight:700;color:var(--blue);">@' + name + "</button>";
      });
  }

  // COMM-125. A block edge in EITHER direction hides that member's comments
  // and reaction avatars from the viewer. feed_page already anti-joins blocked
  // authors server-side; this is the comment and reaction read half, a client
  // echo of the same rule rather than the enforcement point.
  async function loadBlockedIds() {
    if (!state.user) { state.blockedIds = []; state.blocksLoaded = true; return; }
    const ids = {};
    const a = await client.from("blocks").select("blocked_id").eq("blocker_id", state.user.id);
    for (const r of (a.data || [])) ids[r.blocked_id] = true;
    const b = await client.from("blocks").select("blocker_id").eq("blocked_id", state.user.id);
    for (const r of (b.data || [])) ids[r.blocker_id] = true;
    state.blockedIds = Object.keys(ids);
    state.blocksLoaded = true;
  }
  function isBlockedUser(userId) { return !!userId && state.blockedIds.indexOf(userId) >= 0; }

  // ---- Reactions (COMM-120) ----------------------------------------------

  function reactionState(postId) {
    if (state.reactions[postId]) return state.reactions[postId];
    const row = findFeedPost(postId);
    const count = row ? Number((row.reaction_count != null ? row.reaction_count : row.cheer_count) || 0) : 0;
    return { loaded: false, mine: false, list: [], count: count };
  }
  function ensureReactionsLoaded(postId) {
    if (!postId || state.reactions[postId]) return;
    state.reactions[postId] = { loaded: false, loading: true, mine: false, list: [], count: reactionState(postId).count };
    loadReactionsFor(postId);
  }
  async function loadReactionsFor(postId) {
    const { data, error } = await client.from("reactions")
      .select("user_id,profiles(handle,display_name,avatar_url)")
      .eq("post_id", postId).eq("kind", "cheer").order("created_at", { ascending: true }).limit(200);
    if (error) { delete state.reactions[postId]; return; }
    const rows = data || [];
    state.reactions[postId] = {
      loaded: true,
      mine: !!(state.user && rows.some((r) => r.user_id === state.user.id)),
      list: rows.map((r) => ({ id: r.user_id, name: r.profiles ? (r.profiles.display_name || "@" + r.profiles.handle) : "" })),
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
    state.reactions[postId] = optimistic;
    syncFeedReactionCount(postId, optimistic.count);
    state.reactionError = null;
    rerender();
    const { error } = await client.rpc("toggle_reaction", { p_post_id: postId });
    if (error) {
      state.reactions[postId] = before;
      syncFeedReactionCount(postId, before.count);
      state.reactionError = postId;
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
    const { data, error } = await client.from("post_comments")
      .select("id,body,created_at,edited_at,deleted_at,status,author_id,parent_comment_id,profiles(handle,display_name,avatar_url)")
      .eq("post_id", postId).order("created_at", { ascending: true }).limit(400);
    const rows = error ? [] : (data || []);
    state.comments[postId] = rows;
    await loadMemberRoles(rows.map((c) => c.author_id));
    rerender();
  }
  // COMM-124 / COMM-160. The coach badge on every surface a member is shown
  // (comment, feed post author, profile header, people search, member
  // directory) is driven by the server role set, never a client guess:
  // invite_redemptions.role for each user id, looked up once and cached.
  // Batched so a feed page or a comment thread is a single query.
  function memberRole(userId) { return (userId && state.memberRoles[userId]) || null; }
  function isCoachRole(role) { return role === "coach" || role === "head_coach"; }
  async function loadMemberRoles(ids) {
    const need = [];
    for (const id of ids || []) if (id && !(id in state.memberRoles)) need.push(id);
    if (!need.length) return;
    for (const id of need) state.memberRoles[id] = null;
    const { data } = await client.from("invite_redemptions").select("user_id,role").in("user_id", need);
    for (const r of (data || [])) state.memberRoles[r.user_id] = r.role || null;
  }
  function toggleComments(postId) {
    if (state.openComments[postId]) { delete state.openComments[postId]; rerender(); return; }
    state.openComments[postId] = true;
    // COMM-170. Opening the thread is what "opened a post" means on this
    // feed - there is no separate post detail view in V1. The early return
    // above is what keeps a close from counting as a second open.
    const opened = findFeedPost(postId);
    track(A.POST_OPENED, { post_id: postId, post_type: (opened && opened.post_type) || null, source: "feed" });
    if (!state.blocksLoaded) loadBlockedIds().then(rerender);
    if (!state.comments[postId]) loadCommentsFor(postId); else rerender();
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
    state.commentDrafts[key] = raw;
    delete state.commentErrors[key];
    state.commentSending = key;
    state.mentionPicker = null;
    rerender();

    const resolved = await resolveCommentMentions(body);
    const { data, error } = await client.rpc("add_post_comment", { p_post_id: postId, p_body: resolved.stored, p_parent_comment_id: parentCommentId || null });
    state.commentSending = null;
    if (error) {
      state.commentErrors[key] = commentErrorMessage(error);
      rerender();
      return;
    }
    delete state.commentDrafts[key];
    delete state.commentErrors[key];
    if (parentCommentId) { state.openReplies[parentCommentId] = true; state.replyTo[postId] = null; }
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
    const draft = state.commentDrafts[key];
    if (draft == null) return;
    addComment(postId, { elements: { body: { value: draft } }, reset: function () {} }, parentId || null);
  }
  async function deleteComment(commentId, postId) {
    if (!state.user) return;
    const list = state.comments[postId] || [];
    const target = list.find((c) => c.id === commentId);
    // post_comments_delete_self is author-only. A moderator removal is a
    // status change through mod_review (COMM-153), not a client delete, so it
    // is not offered here.
    if (target && target.author_id !== state.user.id) return;
    const snapshot = list.slice();
    state.comments[postId] = list.filter((c) => c.id !== commentId);
    rerender();
    const { error } = await client.from("post_comments").delete().eq("id", commentId).eq("author_id", state.user.id);
    if (error) {
      state.comments[postId] = snapshot;
      setMessage("מחיקת התגובה נכשלה");
      rerender();
      return;
    }
    await loadCommentsFor(postId);
    await loadFeed();
  }
  function startCommentEdit(commentId, postId) {
    const list = state.comments[postId] || [];
    const c = list.find((x) => x.id === commentId);
    if (!c || c.author_id !== (state.user && state.user.id)) return;
    state.commentEdit = { commentId: commentId, postId: postId, body: String(c.body || ""), saving: false, error: "" };
    state.mentionPicker = null;
    rerender();
  }
  function cancelCommentEdit() { state.commentEdit = null; rerender(); }
  async function saveCommentEdit() {
    const e = state.commentEdit;
    if (!e || e.saving) return;
    const body = String(e.body || "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").trim().slice(0, COMMENT_BODY_MAX);
    if (!body) { e.error = "אי אפשר לשמור תגובה ריקה"; rerender(); return; }
    const resolved = await resolveCommentMentions(body);
    e.saving = true; e.error = ""; rerender();
    const list = state.comments[e.postId] || [];
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
    state.commentEdit = null;
    await loadCommentsFor(e.postId);
  }
  // COMM-151. Opens the reason sheet for a comment. The write goes through
  // the same report() RPC as a post, with p_target_type 'comment'.
  function reportComment(commentId) { openReportSheet("comment", commentId); }

  // ---- Mention picker (COMM-123) ---------------------------------------

  function onCommentInput(input) {
    const key = input.dataset.commentKey;
    state.commentDrafts[key] = input.value;
    const caret = input.selectionStart == null ? input.value.length : input.selectionStart;
    const m = /(?:^|\s)@([^\s@]{0,30})$/.exec(input.value.slice(0, caret));
    if (m) {
      const q = m[1];
      const active = state.mentionPicker && state.mentionPicker.key === key;
      if (active && state.mentionPicker.query === q) return;
      state.mentionPicker = { key: key, query: q, results: active ? state.mentionPicker.results : [], loading: true, index: 0 };
      searchMentionPeople(key, q);
      rerender();
      restoreCommentFocus(key, caret);
    } else if (state.mentionPicker && state.mentionPicker.key === key) {
      state.mentionPicker = null;
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
    if (state.mentionPicker && state.mentionPicker.key === key) {
      state.mentionPicker.results = results;
      state.mentionPicker.loading = false;
      rerender();
      restoreCommentFocus(key, null);
    }
  }
  function mentionPick(key, id, name) {
    const cur = state.commentDrafts[key] || "";
    const replaced = cur.replace(/(^|\s)@([^\s@]*)$/, function (full, pre) { return pre + "@[" + name + "](" + id + ") "; });
    state.commentDrafts[key] = replaced === cur ? cur + "@[" + name + "](" + id + ") " : replaced;
    state.mentionPicker = null;
    rerender();
    restoreCommentFocus(key, state.commentDrafts[key].length);
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
  let anonSignInAttempted = false;
  async function ensureAnonymousSession() {
    if (!client || state.user || anonSignInAttempted) return;
    anonSignInAttempted = true;
    const { error } = await client.auth.signInAnonymously();
    if (error) { setMessage("לא ניתן להתחבר לקהילה כרגע, נסו לרענן את הדף"); return; }
    // onAuthStateChange below picks up the new session and loads everything.
  }
  function startSignup() { state.signupStarted = true; ensureAnonymousSession(); rerender(); }

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
    const username = String(form.elements.username.value || "").trim().toLowerCase();
    const password = String(form.elements.password.value || "");
    const passwordConfirm = String(form.elements.passwordConfirm.value || "");
    const errors = {};
    if (!USERNAME_RE.test(username)) errors.username = "שם משתמש: 3–24 תווים, אותיות אנגליות קטנות, ספרות או קו תחתון";
    if (password.length < 8) errors.password = "הסיסמה חייבת להכיל לפחות 8 תווים";
    if (password !== passwordConfirm) errors.passwordConfirm = "הסיסמאות לא תואמות";
    if (Object.keys(errors).length) return setFieldErrors("communityCredentials", errors);
    const { data, error } = await client.auth.updateUser({ email: usernameToEmail(username), password });
    if (error) return setFieldErrors("communityCredentials", { username: /registered|exists|taken/i.test(error.message || "") ? "שם המשתמש כבר תפוס" : "השמירה נכשלה, נסו שוב" });
    state.user = data.user;
    setFieldErrors("communityCredentials", {});
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
  async function flushOutbox() {
    if (!client || !state.user || !state.syncEnabled || typeof window.dbLoadSyncOutbox !== "function") return;
    const rows = await window.dbLoadSyncOutbox();
    for (const row of rows) {
      const payload = { user_id: state.user.id, record_type: row.recordType, record_id: row.recordId, payload: row.payload || {}, deleted_at: row.deleted ? new Date(row.queuedAt).toISOString() : null, updated_at: new Date(row.queuedAt).toISOString() };
      const { error } = await client.from("private_records").upsert(payload, { onConflict: "user_id,record_type,record_id" });
      if (!error) await window.dbDeleteSyncOutbox(row.id);
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
  function clearSearchResults() { state.people = []; state.searchEvents = []; state.searchChallenges = []; }
  async function communitySearch(query) {
    if (!state.user) return;
    // state.searchQuery keeps what the member typed, so a re-render does not
    // rewrite the box under their cursor; only the request is sanitized.
    state.searchQuery = String(query || "");
    const q = sanitizeSearchQuery(query);
    const token = ++searchToken;
    // Under two characters is empty results, no request and no error -
    // the same threshold the RPC re-applies for a caller that skips it.
    if (q.length < SEARCH_MIN_CHARS) { clearSearchResults(); state.searchLoading = false; return rerender(); }
    state.searchLoading = true;
    rerender();
    const { data, error } = await client.rpc("community_search", { p_query: q, p_limit: SEARCH_GROUP_LIMIT });
    // A slower earlier keystroke must not overwrite a later one's results.
    if (token !== searchToken) return;
    state.searchLoading = false;
    // Failure clears rather than showing a broken state, matching what the
    // members-only search did before this ticket widened it.
    const groups = (!error && data && typeof data === "object") ? data : {};
    // allow_follows comes back in the members group so the follow button can
    // be hidden for a member who turned follows off. The server still
    // rejects the insert (follows_insert_self checks the same column plus
    // block edges), this is only so the button does not lie.
    state.people = Array.isArray(groups.members) ? groups.members : [];
    state.searchEvents = Array.isArray(groups.events) ? groups.events : [];
    state.searchChallenges = Array.isArray(groups.challenges) ? groups.challenges : [];
    rerender();
    // COMM-160. Resolve the coach badge for the result set from the shared
    // server role cache, then re-render.
    loadMemberRoles(state.people.map((p) => p.id)).then(() => rerender());
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
  async function follow(userId) {
    if (!state.user) return;
    const { error } = await client.from("follows").insert({ follower_id: state.user.id, followed_id: userId });
    if (error && error.code === "23505") await client.from("follows").delete().eq("follower_id", state.user.id).eq("followed_id", userId);
    // COMM-170. This control toggles: the 23505 branch above is an
    // unfollow, and a rejected insert is neither. Only a real new follow
    // edge is tracked, and there is no member_unfollowed in the event set.
    else if (!error) track(A.MEMBER_FOLLOWED, { user_id: userId });
    await loadFeed(); setMessage(error && error.code !== "23505" ? "עדכון המעקב נכשל" : "המעקב עודכן");
  }
  async function block(userId) {
    if (!state.user) return;
    const { error } = await client.from("blocks").upsert({ blocker_id: state.user.id, blocked_id: userId });
    if (error) { setMessage("לא ניתן היה לחסום. נסו שוב"); return; }
    await client.from("follows").delete().eq("follower_id", state.user.id).eq("followed_id", userId);
    state.people = state.people.filter((person) => person.id !== userId);
    // COMM-125. Refresh the block set so comments and reaction avatars from
    // the newly blocked member drop out of the current view too.
    await loadBlockedIds();
    state.comments = {}; state.reactions = {};
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
      photoPath = await uploadPostPhoto(photoFile);
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
    delete state.openShare[shareKey(type, id)];
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
    if (state.openShare[key]) delete state.openShare[key]; else state.openShare[key] = true;
    rerender();
  }
  window.renderShareControl = function (type, id) {
    if (!window.isCommunitySignedIn || !window.isCommunitySignedIn()) return "";
    const key = shareKey(type, id);
    if (!state.openShare[key]) return `<button data-community-action="toggle-share" data-type="${safeText(type)}" data-id="${safeText(id)}" aria-label="שיתוף לקהילה" style="color:var(--steel);padding:4px;">📤</button>`;
    return `<div class="flex items-center gap-6" style="flex-wrap:wrap;">
      <input type="file" id="photo-${safeText(id)}" accept="image/jpeg,image/png,image/webp" style="display:none;"/>
      <label class="chip-btn" for="photo-${safeText(id)}" style="cursor:pointer;padding:5px 9px;font-size:11px;">📷</label>
      <button class="chip-btn" data-community-action="publish" data-type="${safeText(type)}" data-id="${safeText(id)}" data-visibility="followers" style="padding:5px 9px;font-size:11px;">לעוקבים</button>
      <button class="chip-btn primary" data-community-action="publish" data-type="${safeText(type)}" data-id="${safeText(id)}" data-visibility="public" style="padding:5px 9px;font-size:11px;">לכולם</button>
      <button class="link-btn" data-community-action="toggle-share" data-type="${safeText(type)}" data-id="${safeText(id)}" aria-label="ביטול שיתוף" style="padding:5px;">✕</button>
    </div>`;
  };
  // Renders directly under the post whose "השוואה" button was tapped
  // (see feed rendering below) instead of in one spot at the top of the
  // whole feed - tapping compare on a post scrolled far down used to
  // produce a result the viewer had to scroll back up to find, with no
  // visual link back to which post triggered it. A second tap on the
  // same post's button closes it again.
  async function compare(comparisonKey, postId) {
    if (state.comparisonForPostId === postId) { state.comparisonForPostId = null; state.comparison = []; return rerender(); }
    if (!comparisonKey) return;
    const { data, error } = await client.from("community_feed").select("id,handle,display_name,result_text,score_value,score_direction,occurred_on").eq("comparison_key", comparisonKey).limit(50);
    state.comparison = error ? [] : (data || []).sort((a, b) => a.score_direction === "lower" ? Number(a.score_value) - Number(b.score_value) : Number(b.score_value) - Number(a.score_value));
    state.comparisonForPostId = postId;
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
    if (state.communityTab !== tab) {
      // COMM-209. The challenge detail belongs to the view that opened it.
      // Leaving that view closes it, so its two channels stay closed after
      // the teardown below instead of being re-armed by the next render
      // for a dialog nobody can see behind the new tab.
      state.challengeView = null;
      if (window.HaimuniaRealtime) window.HaimuniaRealtime.teardownAll();
      // Both flags describe channels that no longer exist. Clearing them
      // is what lets the arm points above open a fresh channel instead of
      // trusting a stale "already subscribed" memory.
      state._chalRtId = null;
      state._notifRtUid = null;
      clearRealtimeDebounces();
    }
    // COMM-114: "flushed once per feed session, or on view change, whichever
    // comes first". Leaving the Feed sub-tab is a view change.
    if (state.communityTab !== tab) flushFeedImpressions();
    state.communityTab = tab;
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
  function resetClubTabView() { lastClubTabView = null; }
  function noteClubTabView() {
    if (!state.user || !state.profile) return;
    const tab = state.communityTab || "feed";
    if (lastClubTabView === tab) return;
    lastClubTabView = tab;
    track(A.CLUB_TAB_VIEWED, { tab });
    // The feed and the boards are surfaces in their own right, measured
    // separately from the tab that happens to contain them. Two different
    // event names on one action is not double counting.
    if (tab === "feed") track(A.FEED_VIEWED, { scope: state.feedScope, source: "club_tab" });
    if (tab === "boards") {
      // Only when there is one. An empty board is not a challenge view.
      if (state.weeklyChallenge) {
        track(A.CHALLENGE_VIEWED, { challenge_id: null, challenge_key: state.weeklyChallenge.comparisonKey || null, source: "boards" });
      }
      track(A.LEADERBOARD_VIEWED, { board: "weekly_challenge", rows: (state.weeklyLeaderboard || []).length, source: "boards" });
    }
  }

  // A single in-app confirm dialog, replacing three different patterns
  // that used to exist for comparably serious actions: the native browser
  // confirm dialog (broke out of the app's entire custom visual language), an inline
  // footer swap (app.js's clear-all-data), and no confirmation at all
  // (publishing to the community feed, which — unlike blocking someone —
  // used to fire immediately). Every destructive or broadcast-to-others
  // action now goes through this same path.
  function askConfirm(opts) { state.confirmDialog = opts; rerender(); }
  function closeConfirm() { state.confirmDialog = null; rerender(); }
  function runConfirm() {
    const c = state.confirmDialog;
    state.confirmDialog = null;
    if (!c) return;
    if (c.action === "migrate") migrateLocalData();
    else if (c.action === "block") block(c.payload.userId);
    else if (c.action === "delete-account") requestDeletion();
    else if (c.action === "delete-post") deletePost(c.payload.postId);
    else if (c.action === "publish") publishWorkout(c.payload.type, c.payload.id, c.payload.visibility, c.payload.file);
    else if (c.action === "admin-grant-coach") adminGrantCoach(c.payload.userId);
    else if (c.action === "admin-set-role") adminSetRole(c.payload.userId, c.payload.role);
    else if (c.action === "admin-remove-member") adminRemoveMember(c.payload.userId);
    else if (c.action === "post-delete-rpc") postDeleteViaMenu(c.payload.postId);
    else if (c.action === "delete-comment") deleteComment(c.payload.commentId, c.payload.postId);
    else if (c.action === "composer-discard") closeComposer();
    else if (c.action === "leave-challenge") leaveChallenge(c.payload.challengeId);
    else if (c.action === "challenge-delete-draft") deleteChallengeDraft(c.payload.challengeId);
    else if (c.action === "event-cancel") cancelEvent(c.payload.eventId);
    else rerender();
  }

  // Splices aria-invalid/aria-describedby onto an already-built <input>/
  // <textarea> string when that field has a live validation error, and
  // renders the matching visible error text right under the field — the
  // same error, not a duplicate message, so a screen reader and a sighted
  // user learn the same thing at the same place.
  function field(formId, name, labelText, inputHtml) {
    const err = (state.fieldErrors[formId] || {})[name];
    const errId = `err-${formId}-${name}`;
    const tagged = err ? inputHtml.replace(/^<(input|textarea)/, `<$1 aria-invalid="true" aria-describedby="${errId}"`) : inputHtml;
    return `<label class="field"><span class="field-label">${labelText}</span>${tagged}${err ? `<span class="field-error" id="${errId}" role="alert">${safeText(err)}</span>` : ""}</label>`;
  }
  function renderConfirmSheet() {
    const c = state.confirmDialog;
    if (!c) return "";
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="communityConfirmTitle" style="align-items:center;padding:0 20px;">
      <div class="modal-sheet" style="border-radius:22px;border-bottom:1px solid var(--border);max-height:none;">
        <div style="padding:24px 22px calc(env(safe-area-inset-bottom,0px) + 20px);">
          <div id="communityConfirmTitle" style="color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:8px;">${safeText(c.title || "אישור פעולה")}</div>
          <div style="color:var(--steel);font-size:13.5px;line-height:1.6;margin-bottom:20px;">${safeText(c.message)}</div>
          <div class="chip-row" style="margin-top:0;">
            <button class="chip-btn" data-community-action="confirm-no">ביטול</button>
            <button class="chip-btn primary" data-community-action="confirm-yes" style="${c.destructive ? "background:var(--red);border-color:var(--red);color:#fff;" : ""}">${safeText(c.confirmLabel || "אישור")}</button>
          </div>
        </div>
      </div>
    </div>`;
  }
  function sectionHead(color, title, adminTag) {
    return `<div class="ach-section-head"><span class="ach-section-dot" style="background:${color};"></span><span class="ach-section-title">${title}</span>${adminTag ? `<span class="admin-tag">ניהול</span>` : ""}</div>`;
  }
  // Top 3 in full, then — if the viewer isn't in the top 3 — a divider and
  // their own row, instead of one long ranked list past the leaders. Same
  // underlying data, friendlier framing (principle: scoped/small-cohort
  // competition motivates more than "you're #18 of 40").
  function renderRankedList(items, selfKeyOf, formatValue) {
    if (!items.length) return `<div class="empty">אין נתונים עדיין</div>`;
    const selfId = state.user && state.user.id;
    const rowHtml = (it, index, isSelf) => `<div class="log-row"${isSelf ? ' style="border-color:var(--energy);"' : ""}><span>${index + 1}. ${safeText(it.display_name || "@" + it.handle)}${isSelf ? " (את/ה)" : ""}</span><span class="mono" style="color:var(--brass);">${formatValue(it)}</span></div>`;
    const top = items.slice(0, 3).map((it, i) => rowHtml(it, i, selfKeyOf(it) === selfId));
    const selfIndex = items.findIndex((it) => selfKeyOf(it) === selfId);
    const rows = selfIndex >= 3 ? [...top, `<div class="empty" style="padding:4px 0;font-size:16px;">···</div>`, rowHtml(items[selfIndex], selfIndex, true)] : top;
    return `<div class="log-list">${rows.join("")}</div>`;
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
  function searchGroupTitle(key) {
    return { members: "מתאמנים", events: "אירועים", challenges: "אתגרים" }[key] || key;
  }
  function searchMemberRowHtml(person) {
    return `<div class="log-row"><div class="flex gap-10" style="align-items:center;">${avatarHtml(person.display_name || person.handle, 32)}<div><div style="font-weight:700;">${safeText(person.display_name || "@" + person.handle)}${isCoachRole(memberRole(person.id)) ? " " + coachBadgeHtml(memberRole(person.id)) : ""}</div><div style="color:var(--steel);font-size:12px;">@${safeText(person.handle)} ${safeText(person.bio || "")}</div></div></div><div class="chip-row" style="margin-top:0;"><button class="chip-btn" data-community-action="view-profile" data-id="${safeText(person.id)}">פרופיל</button>${person.allow_follows === false ? "" : `<button class="chip-btn" data-community-action="follow" data-id="${safeText(person.id)}">מעקב</button>`}<button class="chip-btn" data-community-action="block" data-id="${safeText(person.id)}">חסימה</button></div></div>`;
  }
  function searchEventRowHtml(ev) {
    // No event detail surface exists yet (COMM-213 builds it), so the row
    // records the view and says what it knows. It does not pretend to
    // navigate somewhere that is not built.
    const when = ev.start_at ? String(ev.start_at).slice(0, 16).replace("T", " ") : "";
    const meta = [when, ev.status === "draft" ? "טיוטה" : ev.status === "cancelled" ? "בוטל" : ""].filter(Boolean);
    return `<div class="log-row" data-search-event-id="${safeText(ev.id)}"><div><div style="font-weight:700;">📅 ${safeText(ev.title || "אירוע")}</div>${meta.length ? `<div style="color:var(--steel);font-size:12px;">${meta.map(safeText).join(" · ")}</div>` : ""}</div><div class="chip-row" style="margin-top:0;"><button class="chip-btn" data-community-action="open-event" data-id="${safeText(ev.id)}" data-source="search">פרטים</button></div></div>`;
  }
  function searchChallengeRowHtml(c) {
    const meta = [challengeTypeDef(c.challenge_type).label, challengeStatusLabel(c), c.end_at ? `עד ${formatChallengeDate(c.end_at)}` : ""].filter(Boolean);
    return `<div class="log-row" data-search-challenge-id="${safeText(c.id)}"><div><div style="font-weight:700;">${safeText(challengeTypeDef(c.challenge_type).icon)} ${safeText(c.title || "אתגר")}</div><div style="color:var(--steel);font-size:12px;">${meta.map(safeText).join(" · ")}</div></div><div class="chip-row" style="margin-top:0;"><button class="chip-btn" data-community-action="open-challenge" data-id="${safeText(c.id)}" data-source="search">פרטים</button></div></div>`;
  }
  function renderCommunitySearch() {
    const box = `<div class="search-box"><input id="communityPeopleSearch" placeholder="חיפוש מתאמנים, אירועים ואתגרים" aria-label="חיפוש בקהילה" value="${safeText(state.searchQuery || "")}"/></div>`;
    let body;
    if (sanitizeSearchQuery(state.searchQuery).length < SEARCH_MIN_CHARS) {
      // Under the threshold there is nothing to show and nothing was asked
      // of the server - not an error, and not an empty-results claim.
      body = `<div class="footer-note" style="margin:6px 0 0;">הקלידו לפחות ${SEARCH_MIN_CHARS} תווים</div>`;
    } else if (state.searchLoading) {
      body = `<div class="empty" role="status" style="padding:8px 0;">מחפש...</div>`;
    } else {
      body = searchGroupHtml("members", state.people.map(searchMemberRowHtml).join(""))
        + searchGroupHtml("events", state.searchEvents.map(searchEventRowHtml).join(""))
        + searchGroupHtml("challenges", state.searchChallenges.map(searchChallengeRowHtml).join(""));
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
    if (base.count > 0 || state.openComments[pid]) ensureReactionsLoaded(pid);
    const rs = reactionState(pid);
    const reactors = (rs.list || []).filter((r) => !isBlockedUser(r.id));
    const total = Number(rs.count || 0);
    if (!total && !reactors.length) return "";
    const avatars = reactors.slice(0, REACTOR_AVATARS_SHOWN)
      .map((r) => `<span style="display:inline-flex;margin-inline-start:-6px;">${avatarHtml(r.name || "?", 22)}</span>`).join("");
    const label = rs.mine
      ? (total <= 1 ? "הגבתם" : `הגבתם ועוד ${total - 1}`)
      : `${total} הגבות`;
    return `<div class="reaction-strip flex gap-6" style="align-items:center;margin-top:8px;">${avatars ? `<span class="flex" style="padding-inline-start:6px;">${avatars}</span>` : ""}<span style="color:var(--steel);font-size:11.5px;">${safeText(label)}</span></div>`;
  }
  // COMM-124. Text carries the meaning, not colour alone.
  function coachBadgeHtml(role) {
    const label = role === "head_coach" ? "מאמן/ת ראשי/ת" : role === "coach" ? "מאמן/ת" : "";
    if (!label) return "";
    return `<span class="coach-badge" style="font-size:10px;font-weight:800;color:#0c0c0c;background:var(--brass);border-radius:999px;padding:1px 7px;">${label}</span>`;
  }
  function commentPlaceholder(text, reply) {
    return `<div class="comment-row" style="${reply ? "margin-inline-start:26px;" : ""}"><div style="flex:1;min-width:0;color:var(--steel);font-size:12px;font-style:italic;padding:4px 0;">${safeText(text)}</div></div>`;
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
    const editing = state.commentEdit && state.commentEdit.commentId === c.id;
    const wrapStyle = (opts.reply ? "margin-inline-start:26px;" : "")
      + (isCoach ? "border-inline-start:3px solid var(--brass);padding-inline-start:8px;background:rgba(191,167,106,.06);border-radius:8px;" : "");
    let bodyHtml;
    if (editing) {
      const e = state.commentEdit;
      bodyHtml = `<div class="comment-edit" style="margin-top:4px;">
        <textarea class="text-input" data-comment-edit-input maxlength="${COMMENT_BODY_MAX}" rows="2" aria-label="עריכת תגובה">${safeText(e.body || "")}</textarea>
        ${e.error ? `<div class="field-error" role="alert" style="margin-top:4px;">${safeText(e.error)}</div>` : ""}
        <div class="chip-row" style="margin-top:6px;"><button class="chip-btn" data-community-action="comment-edit-cancel">ביטול</button><button class="chip-btn primary" data-community-action="comment-edit-save"${e.saving ? " disabled" : ""}>${e.saving ? "שומר…" : "שמירה"}</button></div>
      </div>`;
    } else {
      bodyHtml = `<div style="font-size:12.5px;line-height:1.55;"><b>${safeText(name)}</b> ${isCoach ? coachBadgeHtml(role) + " " : ""}${mentionMarkersToHtml(c.body)}</div>`;
    }
    const edited = c.edited_at ? ` <span style="color:var(--steel);font-size:10.5px;" title="${safeText(relativeTime(c.edited_at))}">(נערך)</span>` : "";
    const actions = [];
    if (!opts.reply) actions.push(`<button class="link-btn" data-community-action="comment-reply" data-post="${safeText(post.id)}" data-id="${safeText(c.id)}">תגובה</button>`);
    if (own && !editing) {
      actions.push(`<button class="link-btn" data-community-action="comment-edit" data-post="${safeText(post.id)}" data-id="${safeText(c.id)}">עריכה</button>`);
      actions.push(`<button class="link-btn" data-community-action="delete-comment" data-id="${safeText(c.id)}" data-post="${safeText(post.id)}" aria-label="מחיקת תגובה">מחיקה</button>`);
    }
    if (!own) actions.push(`<button class="link-btn" data-community-action="report-comment" data-id="${safeText(c.id)}">דיווח</button>`);
    return `<div class="comment-row${isCoach ? " comment-coach" : ""}" style="${wrapStyle}">${avatarHtml(name, 24)}<div style="flex:1;min-width:0;">
      ${bodyHtml}
      <div class="flex gap-10" style="margin-top:2px;align-items:center;flex-wrap:wrap;"><span style="color:var(--steel);font-size:11px;">${safeText(relativeTime(c.created_at))}</span>${edited}${actions.join("")}</div>
    </div></div>`;
  }
  function mentionPickerHtml(key) {
    const p = state.mentionPicker;
    if (!p || p.key !== key) return "";
    const items = p.results || [];
    const inner = p.loading
      ? `<div style="padding:8px 10px;color:var(--steel);font-size:12px;">מחפש חברים…</div>`
      : (items.length
        ? items.map((m, i) => `<button type="button" class="mention-option" role="option" data-community-action="mention-pick" data-key="${safeText(key)}" data-id="${safeText(m.id)}" data-name="${safeText(m.display_name || m.handle)}" aria-selected="${i === (p.index || 0) ? "true" : "false"}" style="display:block;width:100%;text-align:right;padding:8px 10px;background:${i === (p.index || 0) ? "rgba(255,255,255,.06)" : "none"};border:0;color:var(--chalk);font-size:12.5px;cursor:pointer;">${safeText(m.display_name || "@" + m.handle)} <span style="color:var(--steel);">@${safeText(m.handle)}</span></button>`).join("")
        : `<div style="padding:8px 10px;color:var(--steel);font-size:12px;">אין התאמות</div>`);
    return `<div class="mention-picker" role="listbox" style="position:absolute;z-index:40;top:100%;inset-inline-start:0;margin-top:4px;min-width:220px;background:#1f2023;border:1px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.4);max-height:180px;overflow-y:auto;">${inner}</div>`;
  }
  function commentComposerHtml(postId, parentId) {
    const key = commentKey(postId, parentId || null);
    const draft = state.commentDrafts[key] || "";
    const err = state.commentErrors[key];
    const sending = state.commentSending === key;
    const reply = !!parentId;
    return `${err ? `<div class="field-error" role="alert" style="margin:6px 0 4px;">${safeText(err)} <button class="link-btn" data-community-action="comment-retry" data-post="${safeText(postId)}"${reply ? ` data-parent="${safeText(parentId)}"` : ""}>ניסיון חוזר</button></div>` : ""}
      <form data-comment-post-id="${safeText(postId)}"${reply ? ` data-comment-parent-id="${safeText(parentId)}"` : ""} class="flex gap-6" style="margin-top:8px;position:relative;flex-wrap:wrap;">
        <input class="text-input" name="body" data-comment-input data-comment-key="${safeText(key)}" autocomplete="off" maxlength="${COMMENT_BODY_MAX}" placeholder="${reply ? "השבה לתגובה" : "הוספת תגובה"}" aria-label="${reply ? "השבה לתגובה" : "הוספת תגובה"}" value="${safeText(draft)}"/>
        <button class="chip-btn primary" type="submit"${sending ? " disabled" : ""}>${sending ? "שולח…" : reply ? "השבה" : "שליחה"}</button>
        ${mentionPickerHtml(key)}
      </form>`;
  }
  function renderComments(post) {
    const pid = post && post.id;
    if (!pid) return "";
    const strip = reactionStripHtml(post);
    if (!state.openComments[pid]) return strip;

    const all = state.comments[pid] || [];
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
      const repliesOpen = !!state.openReplies[c.id];
      const hidden = isBlockedUser(c.author_id) || !!c.deleted_at || (!!c.status && c.status !== "active");
      let html = renderCommentBubble(post, c, { reply: false });
      if (kids.length) {
        html += `<div class="flex gap-10" style="margin:2px 0 2px 26px;"><button class="link-btn" data-community-action="toggle-replies" data-id="${safeText(c.id)}">${repliesOpen ? "הסתרת תשובות" : `${kids.length} תשובות`}</button></div>`;
        if (repliesOpen) html += kids.map((k) => renderCommentBubble(post, k, { reply: true })).join("");
      }
      if (!hidden && state.replyTo[pid] === c.id) {
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
      `<button class="chip-btn${state.modQueueStatus === s.id ? " primary" : ""}" data-community-action="mod-queue-status" data-status="${s.id}">${s.label}</button>`).join("")}</div>`;
    let body;
    if (state.modQueueLoading && !state.modQueue.length) {
      body = `<div class="log-list" aria-busy="true">${`<div class="log-row" aria-hidden="true"><span style="height:12px;width:60%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`.repeat(3)}</div>`;
    } else if (state.modQueueError) {
      body = `<div class="empty">לא ניתן היה לטעון את התור.<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="mod-queue-retry">ניסיון חוזר</button></div></div>`;
    } else if (!state.modQueue.length) {
      body = `<div class="empty">אין מה לבדוק.</div>`;
    } else {
      const rowHtml = (r) => {
        const done = r.status === "action_taken" || r.status === "dismissed";
        const reasons = Array.isArray(r.reasons) && r.reasons.length ? r.reasons : (r.latest_reason ? [r.latest_reason] : []);
        return `<div class="chart-card" style="margin-bottom:10px;" data-mod-report-id="${safeText(r.report_id)}">
          <div class="flex" style="justify-content:space-between;align-items:flex-start;gap:10px;">
            <div style="min-width:0;">
              <div style="font-weight:800;">${safeText(r.target_type === "comment" ? "תגובה" : "פוסט")} · ${safeText(r.content_author_name || "חבר/ה שהוסר/ה")}</div>
              <div style="color:var(--steel);font-size:12.5px;margin-top:4px;white-space:pre-wrap;">${safeText(String(r.content_excerpt || "התוכן הוסר").slice(0, 240))}</div>
            </div>
            <span class="admin-tag" style="${r.status === "open" ? "background:rgba(194,57,44,.12);border-color:var(--red);color:var(--red);" : ""}">${safeText(MOD_STATUS_LABEL[r.status] || r.status)}</span>
          </div>
          <div style="color:var(--steel);font-size:12px;margin-top:8px;">
            ${Number(r.reporter_count || 0)} דיווחים · ${reasons.map(reportReasonLabel).map(safeText).join(", ") || "—"} · ${relativeTime(r.created_at)}
          </div>
          ${r.note ? `<div style="color:var(--steel);font-size:12px;margin-top:4px;">״${safeText(String(r.note).slice(0, 240))}״</div>` : ""}
          <div class="chip-row" style="margin-top:10px;">
            <button class="chip-btn" data-community-action="mod-context" data-id="${safeText(r.report_id)}">צפייה בהקשר</button>
            ${done ? "" : MOD_DECISIONS.map((d) =>
              `<button class="chip-btn" data-community-action="mod-action" data-id="${safeText(r.report_id)}" data-decision="${d.id}"${d.destructive ? ' style="color:var(--red);"' : ""}>${d.label}</button>`).join("")}
          </div>
        </div>`;
      };
      body = state.modQueue.map(rowHtml).join("");
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
    }[t] || t;
  }
  const AUDIT_ACTION_TYPES = ["content_delete", "content_hide", "member_restrict", "member_unrestrict", "role_change", "challenge_edit", "achievement_edit", "privacy_config", "content_pin", "content_unpin", "report_review"];
  function renderAuditLog() {
    if (!hasPerm(PERM.ANALYTICS_VIEW)) return "";
    const filterChips = `<div class="chip-row" style="margin:0 0 10px;">
      <button class="chip-btn${!state.auditFilters.action_type ? " primary" : ""}" data-community-action="audit-filter" data-type="">הכול</button>
      ${AUDIT_ACTION_TYPES.map((t) => `<button class="chip-btn${state.auditFilters.action_type === t ? " primary" : ""}" data-community-action="audit-filter" data-type="${t}">${auditActionLabel(t)}</button>`).join("")}
    </div>`;
    let body;
    if (state.auditLoading && !state.auditLog.length) {
      body = `<div class="log-list" aria-busy="true">${`<div class="log-row" aria-hidden="true"><span style="height:12px;width:55%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`.repeat(4)}</div>`;
    } else if (state.auditError) {
      body = `<div class="empty">לא ניתן היה לטעון את היומן.<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="audit-retry">ניסיון חוזר</button></div></div>`;
    } else if (!state.auditLog.length) {
      body = `<div class="empty">עדיין לא נרשמו פעולות ניהול.</div>`;
    } else {
      body = `<div class="log-list">${state.auditLog.map((a) => `<div class="log-row" style="flex-direction:column;align-items:flex-start;gap:3px;">
        <div style="font-weight:700;">${safeText(auditActionLabel(a.action_type))} · ${safeText(a.target_type)}</div>
        <div style="color:var(--steel);font-size:11px;">מנהל/ת ${safeText(String(a.admin_id || "").slice(0, 8))} · ${relativeTime(a.created_at)}</div>
      </div>`).join("")}</div>${state.auditEnd ? "" : `<div class="chip-row" style="justify-content:center;margin-top:8px;"><button class="chip-btn" data-community-action="audit-more"${state.auditLoading ? " disabled" : ""}>${state.auditLoading ? "טוען…" : "טעינת עוד"}</button></div>`}`;
    }
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--steel)", "יומן פעולות ניהול", true)}${filterChips}${body}</div>`;
  }
  function memberRoleLabel(m) {
    if (m.is_admin) return "מנהל/ת";
    return roleCodeLabel(m.role) || (m.role === "member" ? "חבר/ה" : "לא הצטרפ/ה עדיין");
  }
  function renderMemberManagement() {
    if (!isAdmin()) return "";
    const results = state.memberResults;
    // COMM-156. member -> coach and coach -> member keep the original
    // dedicated controls. head_coach is the added selectable role.
    const roleButtons = (m) => {
      const role = m.role || "member";
      const btns = [];
      if (role === "coach" || role === "head_coach") {
        btns.push(`<button class="chip-btn" data-community-action="admin-revoke-coach" data-id="${safeText(m.id)}">ביטול הרשאת מאמן/ת</button>`);
      } else {
        btns.push(`<button class="chip-btn" data-community-action="admin-grant-coach" data-id="${safeText(m.id)}">הענקת הרשאת מאמן/ת</button>`);
      }
      if (role !== "head_coach") {
        btns.push(`<button class="chip-btn" data-community-action="admin-set-role" data-id="${safeText(m.id)}" data-role="head_coach">הפיכה למאמן/ת ראשי/ת</button>`);
      } else {
        btns.push(`<button class="chip-btn" data-community-action="admin-set-role" data-id="${safeText(m.id)}" data-role="coach">הורדה למאמן/ת</button>`);
      }
      return btns.join("");
    };
    const rowHtml = (m) => `<div class="log-row" style="align-items:flex-start;flex-direction:column;gap:6px;">
      <div class="flex gap-10" style="align-items:center;">${avatarHtml(m.display_name || m.handle, 32)}<div><div style="font-weight:700;">${safeText(m.display_name || "@" + m.handle)}${isCoachRole(m.role) ? " " + coachBadgeHtml(m.role) : ""}</div><div style="color:var(--steel);font-size:11px;">@${safeText(m.handle)} · ${memberRoleLabel(m)}</div></div></div>
      <div style="color:var(--steel);font-size:11px;">הצטרפ/ה: ${m.redeemed_at ? safeText(String(m.redeemed_at).slice(0, 10)) : "—"} · פעילות אחרונה: ${m.last_activity_on ? safeText(m.last_activity_on) : "מעולם לא"}</div>
      <div class="footer-note" style="margin:0;font-size:10.5px;">${safeText(m.id)}</div>
      ${m.is_admin ? "" : `<div class="chip-row" style="margin-top:0;">
        ${roleButtons(m)}
        <button class="chip-btn" data-community-action="admin-remove-member" data-id="${safeText(m.id)}" style="color:var(--red);">הסרת חבר/ה</button>
      </div>`}
    </div>`;
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--purple)", "ניהול חברים", true)}
      <div class="search-box"><input id="adminMemberSearch" placeholder="חיפוש לפי handle, שם, או הדבקת מזהה משתמש" aria-label="חיפוש חברים לניהול" value="${safeText(state.memberSearch)}"/></div>
      ${results.length ? `<div class="log-list">${results.map(rowHtml).join("")}</div>` : state.memberSearch.trim().length >= 2 ? `<div class="empty">לא נמצאו חברים תואמים</div>` : `<div class="empty">חיפוש לפי handle, שם, או מזהה משתמש (UUID)</div>`}
    </div>`;
  }
  // COMM-155. The pinned strip at the very top of the Club home, above the
  // club top card. Up to three chips; staff with community.content.pin get
  // an unpin control on each.
  function pinTargetLabel(t) { return { announcement: "הודעה", challenge: "אתגר", event: "אירוע", post: "פוסט" }[t] || t; }
  function renderPinnedStrip() {
    const canPin = hasPerm(PERM.CONTENT_PIN);
    if (!state.pins.length && !state.pinError) return "";
    const chips = state.pins.slice(0, 3).map((p) => `<div class="chip-btn" style="cursor:default;gap:6px;align-items:center;">
      📌 <span>${safeText(p.note || pinTargetLabel(p.target_type))}</span>
      ${canPin ? `<button class="link-btn" data-community-action="unpin" data-type="${safeText(p.target_type)}" data-id="${safeText(p.target_id)}" aria-label="ביטול הצמדה" style="margin:0;padding:0 4px;">✕</button>` : ""}
    </div>`).join("");
    return `<div class="chart-card" id="communityPinnedStrip" style="margin-bottom:12px;">
      <div style="font-weight:800;font-size:13px;margin-bottom:8px;">מוצמד</div>
      <div class="chip-row" style="margin:0;">${chips}</div>
      ${state.pinError ? `<div class="footer-note" role="alert" style="color:var(--red);margin-top:6px;">${safeText(state.pinError)}</div>` : ""}
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
  const POST_VISIBILITY_OPTIONS = [
    { value: "club", label: "כל המועדון" },
    { value: "friends", label: "חברים" },
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
  function findFeedPost(id) { return Array.isArray(state.feed) ? state.feed.find((p) => p && p.id === id) : null; }
  // Authorless posts render the club mark, never a broken avatar (COMM-107).
  const CLUB_MARK_HTML = `<span aria-hidden="true" class="avatar-badge" style="width:36px;height:36px;font-size:15px;background:var(--brass);">ח</span>`;

  function postHeadHtml(post, opts) {
    opts = opts || {};
    const authorless = !!opts.authorless;
    const name = authorless ? (opts.clubName || "המועדון") : (postAuthorName(post) || "חבר/ה");
    const avatar = authorless ? CLUB_MARK_HTML : avatarHtml(name);
    const authorId = !authorless && post && post.author_id;
    // COMM-160. Same coach badge the comments carry, on the post author.
    const roleBadge = authorId ? coachBadgeHtml(memberRole(authorId)) : "";
    const nameInner = `${safeText(name)}${roleBadge ? " " + roleBadge : ""}`;
    const nameHtml = authorId
      ? `<button class="post-author link-btn" data-community-action="view-profile" data-id="${safeText(authorId)}" style="padding:0;font:inherit;color:inherit;font-weight:800;">${nameInner}</button>`
      : `<div class="post-author">${nameInner}</div>`;
    return `<div class="post-head">${avatar}<div class="post-head-text">${nameHtml}<div class="post-time">${safeText(relativeTime(postTimestamp(post)))}${opts.badge ? ` · ${safeText(opts.badge)}` : ""}</div></div>${opts.hideMenu ? "" : postMenuHtml(post)}</div>`;
  }

  function postMenuHtml(post) {
    if (!post || !post.id) return "";
    const id = safeText(post.id);
    const own = postIsOwn(post);
    const open = state.openPostMenu === post.id;
    const mi = (action, label, dataId, danger) =>
      `<button class="post-menu-item" role="menuitem" data-community-action="${action}" data-id="${safeText(dataId)}" style="display:block;width:100%;text-align:right;padding:9px 12px;background:none;border:0;color:${danger ? "var(--red)" : "var(--chalk)"};font-size:13px;cursor:pointer;">${safeText(label)}</button>`;
    let items = "";
    if (own) {
      items += mi("post-edit-caption", "עריכת כיתוב", post.id);
      items += mi("post-change-visibility", "שינוי נראוּת", post.id);
      items += mi("post-delete", "מחיקה", post.id, true);
    } else {
      const saved = !!(state.savedPostIds && state.savedPostIds[post.id]);
      items += mi("post-save", saved ? "הסרה מהשמורים" : "שמירה", post.id);
      items += mi("post-hide", "הסתרת הפוסט", post.id);
      items += mi("report", "דיווח", post.id);
      if (post.author_id) items += mi("block", "חסימת החבר/ה", post.author_id, true);
    }
    return `<div class="post-menu-wrap" style="position:relative;margin-inline-start:auto;">
      <button class="chip-btn" data-community-action="toggle-post-menu" data-id="${id}" aria-haspopup="true" aria-expanded="${open ? "true" : "false"}" aria-label="עוד פעולות">⋯</button>
      ${open ? `<div class="post-menu" role="menu" style="position:absolute;inset-inline-start:0;top:100%;z-index:30;min-width:150px;background:#1f2023;border:1px solid var(--border);border-radius:12px;padding:4px;box-shadow:0 10px 30px rgba(0,0,0,.4);">${items}</div>` : ""}
    </div>`;
  }

  function postActionsHtml(post, opts) {
    opts = opts || {};
    const id = safeText(post && post.id);
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
    return `<div class="post-body" style="white-space:pre-wrap;line-height:1.6;">${safeText(String(body).slice(0, POST_BODY_MAX))}</div>`;
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
      const alt = m.decorative ? "" : safeText(m.alt_text || "");
      if (!url) return `<div class="post-photo" aria-hidden="true" style="background:var(--border);min-height:120px;"></div>`;
      return `<img src="${safeText(url)}" alt="${alt}" class="post-photo"${media.length > 1 ? ' style="margin-bottom:6px;"' : ""}/>`;
    }).join("");
    return media.length > 1 ? `<div class="post-media-grid">${items}</div>` : items;
  }

  function captionEditPanel() {
    const e = state.captionEdit;
    return `<div class="post-inline-edit" style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px;">
      <label class="field"><span class="field-label">עריכת כיתוב</span>
        <textarea class="text-input" data-caption-edit maxlength="${POST_BODY_MAX}" rows="3">${safeText(e.body || "")}</textarea></label>
      <div class="chip-row"><button class="chip-btn" data-community-action="caption-cancel">ביטול</button><button class="chip-btn primary" data-community-action="caption-save">שמירה</button></div>
    </div>`;
  }
  function visibilityEditPanel() {
    const e = state.visibilityEdit;
    return `<div class="post-inline-edit" style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px;">
      <div class="field-label" style="margin-bottom:6px;">מי רואה את הפוסט</div>
      <div class="chip-row">${POST_VISIBILITY_OPTIONS.map((o) => `<button class="chip-btn${e.visibility === o.value ? " primary" : ""}" data-community-action="visibility-pick" data-value="${o.value}">${o.label}</button>`).join("")}</div>
      <button class="link-btn" data-community-action="visibility-cancel" style="margin-top:6px;display:inline-block;">ביטול</button>
    </div>`;
  }

  function postCardShell(post, inner, opts) {
    opts = opts || {};
    const pid = post && post.id;
    return `<article class="chart-card post-card" data-post-type="${safeText((post && post.post_type) || "UNKNOWN")}"${opts.unknown ? ' data-post-unknown="1"' : ""}${pid ? ` data-post-id="${safeText(pid)}"` : ""}>
      ${postHeadHtml(post, opts)}
      ${inner || ""}
      ${opts.engagementDisabled ? "" : postActionsHtml(post, opts)}
      ${state.captionEdit && pid && state.captionEdit.postId === pid ? captionEditPanel() : ""}
      ${state.visibilityEdit && pid && state.visibilityEdit.postId === pid ? visibilityEditPanel() : ""}
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
    const prBadge = isPr ? ` <span class="pr-badge" style="display:inline-block;font-size:10px;font-weight:800;color:#0c0c0c;background:var(--brass);border-radius:999px;padding:1px 7px;vertical-align:middle;">PR</span>` : "";
    const detail = `<div class="post-title">${safeText(name)}${prBadge}</div>
      ${when ? `<div style="color:var(--steel);font-size:12px;">${safeText(String(when).slice(0, 10))}</div>` : ""}
      ${result ? `<div class="mono post-result">${safeText(result)}</div>` : ""}
      ${(scoreType || effortLabel) ? `<div style="color:var(--steel);font-size:12px;">${[scoreType, effortLabel].filter(Boolean).map(safeText).join(" · ")}</div>` : ""}`;
    const caption = post.body ? `<div class="post-body" style="white-space:pre-wrap;margin-top:6px;">${safeText(String(post.body).slice(0, POST_BODY_MAX))}</div>` : "";
    const src = m.source_id || post.source_id || post.source_record_id;
    const extra = src ? `<button class="chip-btn" data-community-action="open-source" data-source-type="${safeText(m.source_type || post.source_type || "workout")}" data-source-id="${safeText(src)}">פתיחת האימון</button>` : "";
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
    const inner = `<div class="post-title">${safeText(movement)} <span class="pr-badge" style="display:inline-block;font-size:10px;font-weight:800;color:#0c0c0c;background:var(--brass);border-radius:999px;padding:1px 7px;vertical-align:middle;">PR</span></div>
      <div class="log-list" style="margin-top:6px;">${rows.map((r) => `<div class="log-row"><span>${safeText(r[0])}</span><span class="mono" style="color:var(--brass);">${safeText(r[1])}</span></div>`).join("")}</div>
      ${post.body ? `<div class="post-body" style="white-space:pre-wrap;margin-top:6px;">${safeText(String(post.body).slice(0, POST_BODY_MAX))}</div>` : ""}`;
    return postCardShell(post, inner + postMediaHtml(post));
  }

  function renderAchievementPostCard(post) {
    const m = post.metadata || {};
    const title = m.title || post.title || "הישג";
    const icon = m.badge_icon || "🏅";
    const when = m.earned_on || post.occurred_on || "";
    const why = m.explanation || post.result_text || "";
    const inner = `<div class="flex gap-10" style="align-items:center;">
        <span aria-hidden="true" style="font-size:26px;">${safeText(icon)}</span>
        <div><div class="post-title" style="margin:0;">${safeText(title)}</div>${when ? `<div style="color:var(--steel);font-size:12px;">${safeText(String(when).slice(0, 10))}</div>` : ""}</div>
      </div>
      ${why ? `<div style="color:var(--steel);font-size:13px;margin-top:6px;">${safeText(why)}</div>` : ""}
      ${post.body ? `<div class="post-body" style="white-space:pre-wrap;margin-top:6px;">${safeText(String(post.body).slice(0, POST_BODY_MAX))}</div>` : ""}`;
    return postCardShell(post, inner + postMediaHtml(post));
  }

  // COMM-101: the renderer exists so the dispatch is total, but attendance
  // milestones are parked until an attendance source lands, so the feed never
  // actually produces one yet.
  function renderAttendanceMilestonePostCard(post) {
    const m = post.metadata || {};
    const label = m.milestone_label || post.title || "אבן דרך בנוכחות";
    const inner = `<div class="post-title">🎯 ${safeText(label)}</div>${m.count != null ? `<div class="mono post-result">${safeText(m.count)}</div>` : ""}${post.body ? `<div class="post-body" style="white-space:pre-wrap;margin-top:6px;">${safeText(String(post.body).slice(0, POST_BODY_MAX))}</div>` : ""}`;
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
      rows.push(`<div class="mono post-result" style="color:var(--brass);">${safeText(m.milestone)}% מהיעד הושלמו</div>`);
      if (m.club_total != null && m.target_value != null) rows.push(`<div style="color:var(--steel);font-size:12px;">${safeText(m.club_total)} מתוך ${safeText(m.target_value)}</div>`);
    } else if (m.my_progress != null) {
      const pct = m.target_value ? Math.min(100, Math.round((Number(m.my_progress) / Number(m.target_value)) * 100)) : null;
      rows.push(`<div class="mono post-result" style="color:var(--brass);">${safeText(m.my_progress)}${m.target_value != null ? ` / ${safeText(m.target_value)}` : ""}</div>`);
      if (pct != null) rows.push(`<div class="progress-track" style="background:var(--border);border-radius:999px;height:6px;overflow:hidden;margin-top:4px;"><div style="width:${pct}%;height:100%;background:var(--brass);"></div></div>`);
    }
    const inner = `<div class="post-title">🏆 ${safeText(m.challenge_title || post.title || "אתגר")}</div>
      ${rows.join("")}
      ${post.body ? `<div class="post-body" style="white-space:pre-wrap;margin-top:4px;">${safeText(String(post.body).slice(0, POST_BODY_MAX))}</div>` : ""}
      <div class="chip-row"><button class="chip-btn" data-community-action="open-challenge" data-id="${safeText(m.challenge_id || post.source_id || "")}">פתיחת האתגר</button></div>`;
    return postCardShell(post, inner, { authorless: !postAuthorName(post) });
  }
  // COMM-213: upgraded from the COMM-101 fallback link card to a real event
  // card, once the events cluster's own state.eventsById has the live row
  // (it is loaded in the same Promise.all as the feed, so this is the
  // common case). Falls back to the original metadata-only link card when
  // the event is not in cache yet (a cold feed load racing loadEvents()) or
  // no longer exists - a truthful degrade, never a broken render.
  function renderEventLinkCard(post) {
    const m = post.metadata || {};
    const ev = m.event_id ? state.eventsById[m.event_id] : null;
    if (ev) {
      const going = eventGoingCount(ev.id);
      const meta = [eventTypeBadge(ev.event_type), formatEventDate(ev.start_at), formatEventTime(ev.start_at)];
      if (ev.location) meta.push(ev.location);
      meta.push(`${going} משתתפים`);
      if (ev.status === "cancelled") meta.push("בוטל");
      const image = ev.image_url ? `<img src="${safeText(ev.image_url)}" alt="" style="width:100%;max-height:160px;object-fit:cover;border-radius:10px;margin-top:6px;"/>` : "";
      const inner = `<div class="post-title">📅 ${safeText(ev.title)}</div>
        <div style="color:var(--steel);font-size:12px;">${meta.map(safeText).join(" · ")}</div>
        ${image}
        ${post.body ? `<div class="post-body" style="white-space:pre-wrap;margin-top:6px;">${safeText(String(post.body).slice(0, POST_BODY_MAX))}</div>` : ""}
        <div class="chip-row"><button class="chip-btn" data-community-action="open-event" data-id="${safeText(ev.id)}">פתיחת האירוע</button></div>`;
      return postCardShell(post, inner, { authorless: !postAuthorName(post) });
    }
    const when = m.starts_at ? String(m.starts_at).slice(0, 16).replace("T", " ") : "";
    const inner = `<div class="post-title">📅 ${safeText(m.event_title || post.title || "אירוע")}</div>
      ${when ? `<div style="color:var(--steel);font-size:12px;">${safeText(when)}</div>` : ""}
      ${post.body ? `<div class="post-body" style="white-space:pre-wrap;margin-top:4px;">${safeText(String(post.body).slice(0, POST_BODY_MAX))}</div>` : ""}
      <div class="chip-row"><button class="chip-btn" data-community-action="open-event" data-id="${safeText(m.event_id || post.source_id || "")}">פתיחת האירוע</button></div>`;
    return postCardShell(post, inner, { authorless: !postAuthorName(post) });
  }

  function renderAnnouncementPostCard(post) {
    const m = post.metadata || {};
    const title = m.title || post.title || "";
    const inner = `${title ? `<div class="post-title" style="color:var(--brass);">📣 ${safeText(title)}</div>` : ""}${postBodyHtml(post)}${postMediaHtml(post)}`;
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
        ${avatarHtml(memberName, 40)}
        <div>
          ${memberId ? `<button class="link-btn" data-community-action="view-profile" data-id="${safeText(memberId)}" style="padding:0;font-weight:800;color:inherit;">${safeText(memberName)}</button>` : `<div style="font-weight:800;">${safeText(memberName)}</div>`}
          ${joined ? `<div style="color:var(--steel);font-size:12px;">${safeText(String(joined).slice(0, 10))}</div>` : ""}
        </div>
      </div>`;
    const extra = `${memberId ? `<button class="chip-btn" data-community-action="follow" data-id="${safeText(memberId)}">מעקב</button>` : ""}<button class="chip-btn" data-community-action="welcome-member" data-id="${safeText(post.id)}">ברכה</button>`;
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
    return `<article class="chart-card post-card" data-post-type="${safeText((post && post.post_type) || "UNKNOWN")}" data-post-error="1">
      <div class="empty">לא ניתן להציג את הפוסט הזה</div>
      ${authorId ? `<div class="chip-row"><button class="chip-btn" data-community-action="view-profile" data-id="${safeText(authorId)}">מעבר לפרופיל</button></div>` : ""}
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
    return `<div class="progress-track" style="background:var(--border);border-radius:999px;height:6px;overflow:hidden;margin-top:4px;"><div style="width:${clamped}%;height:100%;background:var(--brass);"></div></div>`;
  }

  async function loadChallenges() {
    if (!state.user) { state.challenges = []; state.challengeParticipation = {}; state.challengeAggregates = {}; state.challengesLoaded = false; return; }
    state.challengesLoading = true;
    rerender();
    const { data, error } = await client.from("challenges").select("*").order("end_at", { ascending: true });
    if (error) { state.challengesLoading = false; state.challengesError = true; return rerender(); }
    state.challenges = data || [];
    state.challengesError = false;
    const { data: myRows, error: myErr } = await client.from("challenge_participants").select("*").eq("user_id", state.user.id);
    state.challengeParticipation = {};
    if (!myErr) for (const row of (myRows || [])) state.challengeParticipation[row.challenge_id] = row;
    // chal_progress() is fetched for every active challenge, not lazily per
    // card: this is a single small club, active challenges are few, and the
    // list card needs a real participant_count and (for cooperative/team) a
    // real aggregate rather than a stale one, per COMM-207's card contract.
    const active = state.challenges.filter((c) => c.status === "active");
    await Promise.all(active.map(async (c) => {
      const { data: p, error: pErr } = await client.rpc("chal_progress", { challenge_id: c.id });
      if (!pErr && p) state.challengeAggregates[c.id] = p;
    }));
    state.challengesLoading = false;
    state.challengesLoaded = true;
    rerender();
  }

  // ---- Detail (COMM-207) --------------------------------------------------
  async function openChallenge(id, source) {
    if (!id) return;
    track(A.CHALLENGE_VIEWED, { challenge_id: id, challenge_key: null, source: source || "boards" });
    state.challengeView = {
      id, loading: true, error: false, challenge: null, progress: null, teams: [], participants: [], contributors: [], myParticipant: null,
      joining: false, leaving: false, teamJoining: null, sharing: false,
      logForm: { delta: "", note: "", busy: false, error: "" },
      coachEntry: { drafts: {}, busy: {}, error: "" },
    };
    rerender();
    await refreshChallengeView(id);
  }
  // COMM-209. Leaving the detail closes its two channels immediately rather
  // than waiting for the next render to notice, so a member who opens and
  // closes several challenges never holds more than one pair open.
  function closeChallengeView() { state.challengeView = null; ensureChallengeRealtime(); rerender(); }
  async function refreshChallengeView(id) {
    const v = state.challengeView;
    if (!v || v.id !== id) return;
    const [{ data: challenge, error: cErr }, { data: progress, error: pErr }] = await Promise.all([
      client.from("challenges").select("*").eq("id", id).maybeSingle(),
      client.rpc("chal_progress", { challenge_id: id }),
    ]);
    if (!state.challengeView || state.challengeView.id !== id) return;
    if (cErr || !challenge) { state.challengeView.loading = false; state.challengeView.error = true; return rerender(); }
    state.challengeView.challenge = challenge;
    state.challengeView.progress = pErr ? null : progress;
    if (challenge.status === "active" && !pErr && progress) state.challengeAggregates[id] = progress;
    const { data: participants } = await client.from("challenge_participants")
      .select("*, profiles(display_name,handle,avatar_url,visible_to_club)")
      .eq("challenge_id", id).order("joined_at", { ascending: true });
    state.challengeView.participants = participants || [];
    const mine = (participants || []).find((p) => p.user_id === (state.user && state.user.id)) || null;
    state.challengeView.myParticipant = mine;
    if (state.user) { if (mine) state.challengeParticipation[id] = mine; else delete state.challengeParticipation[id]; }
    if (challenge.challenge_type === "team") {
      const { data: teams } = await client.from("challenge_teams").select("*").eq("challenge_id", id).order("name", { ascending: true });
      state.challengeView.teams = teams || [];
    }
    if (challenge.challenge_type === "cooperative") {
      const { data: contrib } = await client.from("challenge_progress")
        .select("user_id,delta,created_at,profiles(display_name,handle,avatar_url,visible_to_club)")
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
      state.challengeView.contributors = list;
    }
    state.challengeView.loading = false;
    rerender();
  }

  // ---- Join / leave / team pick (COMM-204, COMM-207) -----------------------
  async function joinChallenge(id, source) {
    if (!state.user) return;
    const v = state.challengeView;
    const c = (v && v.challenge) || state.challenges.find((x) => x.id === id);
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
    if (state.challengeView && state.challengeView.id === id) await refreshChallengeView(id);
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
    const v = state.challengeView;
    if (v) { v.teamJoining = teamId; rerender(); }
    const { error } = await client.from("challenge_participants").update({ team_id: teamId }).eq("challenge_id", challengeId).eq("user_id", state.user.id);
    if (v) v.teamJoining = null;
    if (error) { setMessage("לא ניתן היה להצטרף לקבוצה. נסו שוב."); return rerender(); }
    if (state.challengeView && state.challengeView.id === challengeId) await refreshChallengeView(challengeId);
    rerender();
  }
  function confirmLeaveChallenge(id) {
    askConfirm({ title: "עזיבת אתגר", message: "לעזוב את האתגר? ההתקדמות שכבר נרשמה תישאר בסטטיסטיקות המועדון.", confirmLabel: "עזיבה", destructive: true, action: "leave-challenge", payload: { challengeId: id } });
  }
  async function leaveChallenge(id) {
    if (!state.user) return;
    const v = state.challengeView;
    if (v && v.id === id) { v.leaving = true; rerender(); }
    const { error } = await client.from("challenge_participants").delete().eq("challenge_id", id).eq("user_id", state.user.id);
    if (v && v.id === id) v.leaving = false;
    if (error) { setMessage("לא ניתן היה לעזוב את האתגר. נסו שוב."); return rerender(); }
    delete state.challengeParticipation[id];
    setMessage("עזבת את האתגר");
    await loadChallenges();
    if (state.challengeView && state.challengeView.id === id) await refreshChallengeView(id);
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
    const v = state.challengeView;
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
    const after = state.challengeView && state.challengeView.myParticipant;
    if (after) maybeCelebrateChallengeCompletion(v.challenge.challenge_type, v.id, wasStatus, after.status);
    rerender();
  }
  // COMM-205. Consistency has no numeric delta from the member: one tap logs
  // exactly one "week hit" once a week's target is reached. Detail-only, no
  // dedicated dialog.
  async function logConsistencyWeekHit() {
    const v = state.challengeView;
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
    const after = state.challengeView;
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
    const v = state.challengeView;
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
    const after = state.challengeView && state.challengeView.participants.find((p) => p.user_id === userId);
    if (after) maybeCelebrateChallengeCompletion(v.challenge.challenge_type, v.id, wasStatus, after.status);
    rerender();
  }

  // ---- Share Progress (COMM-207) -------------------------------------------
  async function shareChallengeProgress() {
    const v = state.challengeView;
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
    state.challengeForm = existing ? {
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
  function closeChallengeForm() { state.challengeForm = null; setFieldErrors("communityChallengeForm", {}); rerender(); }
  function setChallengeFormType(type) { if (state.challengeForm && state.challengeForm.mode !== "edit") { state.challengeForm.challengeType = type; rerender(); } }
  async function submitChallengeForm(form) {
    const f = state.challengeForm;
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
    state.challengeForm = null;
    setMessage("האתגר נשמר");
    await loadChallenges();
    rerender();
  }
  async function archiveChallenge(id) {
    const { error } = await client.from("challenges").update({ status: "archived" }).eq("id", id);
    if (error) return setMessage("הפעולה נכשלה");
    state.challengeForm = null;
    setMessage("האתגר הועבר לארכיון");
    await loadChallenges();
    if (state.challengeView && state.challengeView.id === id) await refreshChallengeView(id);
    rerender();
  }
  async function publishChallengeDraft(id) {
    const { error } = await client.from("challenges").update({ status: "active" }).eq("id", id);
    if (error) return setMessage("הפעולה נכשלה");
    state.challengeForm = null;
    setMessage("האתגר פורסם");
    await loadChallenges();
    rerender();
  }
  async function deleteChallengeDraft(id) {
    const { error } = await client.from("challenges").delete().eq("id", id);
    if (error) return setMessage("הפעולה נכשלה");
    state.challengeForm = null;
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
    return state.challenges.filter((c) => c.status === "active" && types.indexOf(c.challenge_type) >= 0
      && state.challengeParticipation[c.id] && state.challengeParticipation[c.id].status === "active");
  }
  async function logAutoChallengeProgress(challengeId, delta, sourceType) {
    if (!state.user || !delta) return;
    const { error } = await client.from("challenge_progress").insert({ challenge_id: challengeId, user_id: state.user.id, delta, source_type: sourceType || "auto" });
    if (!error) {
      await loadChallenges();
      if (state.challengeView && state.challengeView.id === challengeId) await refreshChallengeView(challengeId);
      rerender();
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
      state._consistencySessionCounts[key] = (state._consistencySessionCounts[key] || 0) + 1;
      const target = Number((c.config && c.config.times_per_week) || 0);
      if (target > 0 && state._consistencySessionCounts[key] >= target && !state._consistencyWeekLogged[key]) {
        state._consistencyWeekLogged[key] = true;
        logAutoChallengeProgress(c.id, 1, "workout_completed");
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
    const part = state.challengeParticipation[c.id];
    if (!part) return "";
    if (c.challenge_type === "cooperative") {
      const agg = state.challengeAggregates[c.id];
      if (!agg || agg.club_total == null) return "";
      const pct = c.target_value ? Math.round((agg.club_total / c.target_value) * 100) : null;
      return `<div class="mono" style="color:var(--brass);font-size:12px;">${safeText(agg.club_total)}${c.target_value != null ? ` / ${safeText(c.target_value)}` : ""}</div>${pct != null ? challengeProgressBarHtml(pct) : ""}`;
    }
    if (c.challenge_type === "team") {
      const agg = state.challengeAggregates[c.id];
      const mine = agg && Array.isArray(agg.team_totals) ? agg.team_totals.find((t) => t.team_id === part.team_id) : null;
      return mine ? `<div class="mono" style="color:var(--brass);font-size:12px;">${safeText(mine.name)}: ${safeText(mine.total)}</div>` : (part.team_id ? "" : `<div style="color:var(--steel);font-size:12px;">טרם נבחרה קבוצה</div>`);
    }
    if (c.challenge_type === "consistency") {
      const weeks = Number((c.config && c.config.weeks) || 0);
      return `<div class="mono" style="color:var(--brass);font-size:12px;">${safeText(part.progress_value)}${weeks ? ` / ${weeks} שבועות` : ""}</div>`;
    }
    const pct = c.target_value ? Math.round((Number(part.progress_value || 0) / c.target_value) * 100) : null;
    return `<div class="mono" style="color:var(--brass);font-size:12px;">${safeText(part.progress_value)}${c.target_value != null ? ` / ${safeText(c.target_value)}` : ""}</div>${pct != null ? challengeProgressBarHtml(pct) : ""}`;
  }
  function renderChallengeCard(c) {
    const def = challengeTypeDef(c.challenge_type);
    const part = state.challengeParticipation[c.id];
    const agg = state.challengeAggregates[c.id];
    const isPast = c.status === "completed" || c.status === "archived";
    const image = (c.config && c.config.image_url)
      ? `<img src="${safeText(c.config.image_url)}" alt="" style="width:44px;height:44px;border-radius:12px;object-fit:cover;"/>`
      : `<span aria-hidden="true" style="width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:20px;background:var(--border);">${def.icon}</span>`;
    const meta = [def.label, `${formatChallengeDate(c.start_at)}–${formatChallengeDate(c.end_at)}`];
    if (agg && agg.participant_count != null) meta.push(`${agg.participant_count} משתתפים`);
    if (c.status === "draft") meta.push(challengeStatusLabel(c));
    return `<article class="chart-card" data-challenge-id="${safeText(c.id)}" data-challenge-status="${safeText(c.status)}" style="margin-bottom:10px;">
      <div class="flex gap-10" style="align-items:flex-start;">
        ${image}
        <div style="flex:1;min-width:0;">
          <button class="link-btn" data-community-action="open-challenge" data-id="${safeText(c.id)}" style="padding:0;text-align:right;font-weight:800;font-size:15px;color:inherit;display:block;">${safeText(c.title)}</button>
          <div style="color:var(--steel);font-size:11.5px;margin-top:2px;">${meta.map(safeText).join(" · ")}</div>
          ${myChallengeCardProgressHtml(c)}
        </div>
      </div>
      <div class="chip-row" style="margin-top:8px;">
        <button class="chip-btn" data-community-action="open-challenge" data-id="${safeText(c.id)}">פרטים</button>
        ${!isPast && c.status === "active" && !part ? `<button class="chip-btn primary" data-community-action="join-challenge" data-id="${safeText(c.id)}">הצטרפות</button>` : ""}
        ${!isPast && part ? `<span class="admin-tag" style="background:var(--brass);">נרשמת/ה</span>` : ""}
      </div>
    </article>`;
  }
  function renderChallengesListSection() {
    const staff = hasPerm(PERM.CHALLENGE_CREATE);
    const active = state.challenges.filter((c) => c.status === "active" || (staff && c.status === "draft"));
    const past = state.challenges.filter((c) => c.status === "completed" || c.status === "archived");
    const createBtn = staff ? `<button class="chip-btn primary" data-community-action="open-challenge-form" style="margin-bottom:10px;">אתגר חדש</button>` : "";
    const list = (state.challengesLoading && !state.challengesLoaded)
      ? `<div aria-busy="true">${`<div class="chart-card" style="height:64px;background:var(--border);opacity:.35;margin-bottom:10px;"></div>`.repeat(2)}</div>`
      : state.challengesError
      ? `<div class="empty">לא ניתן היה לטעון את האתגר. נסו שוב.<div class="chip-row" style="justify-content:center;"><button class="chip-btn" data-community-action="challenges-retry">ניסיון חוזר</button></div></div>`
      : active.length ? active.map(renderChallengeCard).join("") : `<div class="empty">אין אתגרים פעילים כרגע.</div>`;
    const pastHtml = past.length ? `<div style="margin-top:16px;"><div class="field-label" style="margin-bottom:6px;">אתגרים שהסתיימו</div>${past.map(renderChallengeCard).join("")}</div>` : "";
    return `<div class="ach-section">${sectionHead("var(--energy)", "אתגרי המועדון")}${createBtn}${state.challengeForm ? renderChallengeForm() : ""}${list}${pastHtml}</div>`;
  }

  // ---- Rendering: create/edit form (COMM-201) ------------------------------
  function renderChallengeForm() {
    const f = state.challengeForm;
    const typePicker = `<div class="chip-row" role="group" aria-label="סוג אתגר" style="margin-bottom:10px;">${CHALLENGE_TYPES.map((t) => `<button type="button" class="chip-btn${f.challengeType === t.id ? " primary" : ""}" data-community-action="challenge-form-type" data-type="${t.id}"${f.mode === "edit" ? " disabled" : ""}>${t.icon} ${safeText(t.label)}</button>`).join("")}</div>`;
    const typeFields = f.challengeType === "coach" ? `
        ${field("communityChallengeForm", "rulesText", "חוקי האתגר", `<textarea class="text-input" name="rulesText" maxlength="1000" required>${safeText(f.rulesText)}</textarea>`)}
        ${field("communityChallengeForm", "metricLabel", "יחידת מדידה (לתצוגה)", `<input class="text-input" name="metricLabel" value="${safeText(f.metricLabel)}" placeholder="למשל בורפיז"/>`)}`
      : f.challengeType === "consistency" ? `
        <div class="flex gap-10 field">
          ${field("communityChallengeForm", "timesPerWeek", "אימונים בשבוע", `<input class="text-input" name="timesPerWeek" type="number" min="1" value="${safeText(f.timesPerWeek)}" required/>`)}
          ${field("communityChallengeForm", "weeks", "מספר שבועות", `<input class="text-input" name="weeks" type="number" min="1" value="${safeText(f.weeks)}" required/>`)}
        </div>`
      : (f.challengeType === "team" && f.mode === "create") ? `
        ${field("communityChallengeForm", "teamNames", "שמות הקבוצות (שורה לכל קבוצה)", `<textarea class="text-input" name="teamNames" placeholder="קבוצת בוקר&#10;קבוצת ערב">${safeText(f.teamNames)}</textarea>`)}
        <label class="field flex gap-6" style="align-items:center;"><input type="checkbox" name="teamAuto"/><span style="font-size:12.5px;color:var(--steel);">שיבוץ אוטומטי לקבוצה עם פחות משתתפים</span></label>`
      : "";
    const showTarget = f.challengeType !== "coach";
    return `<form id="communityChallengeForm" class="chart-card admin-card" style="margin-top:10px;">
      <div style="font-weight:800;margin-bottom:10px;">${f.mode === "edit" ? "עריכת אתגר" : "אתגר חדש"}<span class="admin-tag">ניהול</span></div>
      ${typePicker}
      ${field("communityChallengeForm", "title", "שם האתגר", `<input class="text-input" name="title" value="${safeText(f.title)}" maxlength="120" required/>`)}
      ${field("communityChallengeForm", "description", "תיאור", `<textarea class="text-input" name="description" maxlength="2000">${safeText(f.description)}</textarea>`)}
      ${field("communityChallengeForm", "metricType", "מדד", `<input class="text-input" name="metricType" value="${safeText(f.metricType)}" placeholder="למשל session_count" required/>`)}
      ${showTarget ? field("communityChallengeForm", "targetValue", "יעד", `<input class="text-input" name="targetValue" type="number" step="any" value="${safeText(f.targetValue)}"/>`) : ""}
      <div class="flex gap-10 field">
        ${field("communityChallengeForm", "startAt", "תאריך התחלה", `<input class="text-input" name="startAt" type="date" value="${safeText(f.startAt)}" required/>`)}
        ${field("communityChallengeForm", "endAt", "תאריך סיום", `<input class="text-input" name="endAt" type="date" value="${safeText(f.endAt)}" required/>`)}
      </div>
      ${typeFields}
      ${f.mode === "create" ? `<label class="field flex gap-6" style="align-items:center;"><input type="checkbox" name="publishNow"/><span style="font-size:12.5px;color:var(--steel);">פרסום מיידי (אחרת יישמר כטיוטה)</span></label>` : ""}
      ${f.error ? `<div class="field-error" role="alert">${safeText(f.error)}</div>` : ""}
      <div class="chip-row" style="margin-top:10px;">
        <button class="chip-btn primary" type="submit"${f.saving ? " disabled" : ""}>${f.saving ? "שומר…" : "שמירה"}</button>
        <button class="chip-btn" type="button" data-community-action="challenge-form-cancel">ביטול</button>
        ${f.mode === "edit" && f.status === "draft" ? `<button class="chip-btn" type="button" data-community-action="challenge-publish" data-id="${safeText(f.id)}">פרסום</button>` : ""}
        ${f.mode === "edit" && f.status === "draft" ? `<button class="chip-btn" type="button" data-community-action="challenge-delete" data-id="${safeText(f.id)}" style="color:var(--red);">מחיקת טיוטה</button>` : ""}
        ${f.mode === "edit" && (f.status === "active" || f.status === "completed") ? `<button class="chip-btn" type="button" data-community-action="challenge-archive" data-id="${safeText(f.id)}">העברה לארכיון</button>` : ""}
      </div>
    </form>`;
  }

  // ---- Rendering: detail dialog (COMM-202..207) ----------------------------
  function renderChallengeActions(v) {
    const c = v.challenge;
    if (c.status === "completed" || c.status === "archived") return "";
    if (c.status === "draft") return `<div class="footer-note" style="margin-bottom:10px;">האתגר עדיין בטיוטה ואינו פתוח להצטרפות.</div>`;
    if (v.myParticipant) {
      return `<div class="chip-row" style="margin-bottom:10px;"><button class="chip-btn" data-community-action="leave-challenge" data-id="${safeText(c.id)}"${v.leaving ? " disabled" : ""}>${v.leaving ? "עוזב/ת…" : "עזיבת האתגר"}</button></div>`;
    }
    return `<div class="chip-row" style="margin-bottom:10px;"><button class="chip-btn primary" data-community-action="join-challenge" data-id="${safeText(c.id)}"${v.joining ? " disabled" : ""}>${v.joining ? "מצטרפ/ת…" : "הצטרפות לאתגר"}</button></div>`;
  }
  function renderChallengeLogForm(v) {
    const lf = v.logForm;
    return `<div class="chart-card" style="margin-bottom:10px;">
      <div class="field-label" style="margin-bottom:6px;">עדכון התקדמות</div>
      <div class="flex gap-10" style="align-items:flex-end;">
        <label class="field" style="flex:1;margin-bottom:0;"><span class="field-label">כמות</span><input class="text-input" type="number" step="any" data-challenge-log-delta value="${safeText(lf.delta)}"/></label>
        <button class="chip-btn primary" data-community-action="challenge-log-submit"${lf.busy ? " disabled" : ""}>${lf.busy ? "שומר…" : "עדכון"}</button>
      </div>
      ${lf.error ? `<div class="field-error" role="alert" style="margin-top:6px;">${safeText(lf.error)}</div>` : ""}
    </div>`;
  }
  function renderMyChallengeProgress(v) {
    const c = v.challenge, part = v.myParticipant;
    if (!part || c.challenge_type === "cooperative" || c.challenge_type === "team" || c.challenge_type === "consistency") return "";
    const completed = part.status === "completed";
    const pct = c.target_value ? (Number(part.progress_value || 0) / c.target_value) * 100 : null;
    return `<div class="chart-card" style="margin-bottom:10px;">
      <div class="field-label" style="margin-bottom:4px;">ההתקדמות שלי</div>
      ${part.progress_value ? `<div class="mono" style="color:var(--brass);font-size:16px;">${safeText(part.progress_value)}${c.target_value != null ? ` / ${safeText(c.target_value)}` : ""}</div>` : `<div class="empty">עדיין לא נרשמה התקדמות.</div>`}
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
          return `<div class="log-row"><span>${safeText(name)}</span><span class="mono" style="color:var(--brass);">+${safeText(row.delta)}</span></div>`;
        }).join("")}</div>`
      : `<div class="empty">עדיין לא נאספה התקדמות משותפת.</div>`;
    return `<div class="chart-card" style="margin-bottom:10px;">
      <div class="field-label" style="margin-bottom:4px;">התקדמות המועדון</div>
      <div class="mono" style="color:var(--brass);font-size:18px;">${safeText(p.club_total)}${c.target_value != null ? ` / ${safeText(c.target_value)}` : ""}</div>
      ${challengeProgressBarHtml(pct)}
      <div style="color:var(--steel);font-size:12px;margin-top:4px;">${Math.round(Math.min(100, pct))}% מהיעד${days != null ? ` · ${days} ימים נותרו` : ""}</div>
      <div class="field-label" style="margin:10px 0 4px;">תורמים אחרונים</div>
      ${contributorsHtml}
    </div>${v.myParticipant ? renderChallengeLogForm(v) : ""}`;
  }
  function renderTeamPanel(v) {
    const c = v.challenge, p = v.progress || {};
    const teams = Array.isArray(p.team_totals) ? p.team_totals : [];
    if (!teams.length) return `<div class="empty">המאמנת עדיין לא הגדירה קבוצות.</div>`;
    const myTeamId = v.myParticipant && v.myParticipant.team_id;
    const canPick = v.myParticipant && !myTeamId;
    const cols = teams.map((t) => `<div class="chart-card" style="flex:1;min-width:130px;${t.team_id === myTeamId ? "border-color:var(--energy);" : ""}">
        <div style="font-weight:800;font-size:13px;">${safeText(t.name)}${t.team_id === myTeamId ? " · הקבוצה שלי" : ""}</div>
        <div class="mono" style="color:var(--brass);font-size:16px;margin-top:4px;">${safeText(t.total)}</div>
        ${canPick ? `<button class="chip-btn" data-community-action="challenge-pick-team" data-id="${safeText(c.id)}" data-team="${safeText(t.team_id)}"${v.teamJoining === t.team_id ? " disabled" : ""} style="margin-top:6px;">${v.teamJoining === t.team_id ? "מצטרפ/ת…" : "הצטרפות לקבוצה"}</button>` : ""}
      </div>`).join("");
    return `<div class="flex gap-10" style="flex-wrap:wrap;margin-bottom:10px;">${cols}</div>${(v.myParticipant && myTeamId) ? renderChallengeLogForm(v) : ""}`;
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
      ${v.logForm.error ? `<div class="field-error" role="alert" style="margin-top:6px;">${safeText(v.logForm.error)}</div>` : ""}
    </div>`;
  }
  function renderChallengeLeaderboardPanel(v) {
    const p = v.progress || {};
    const board = Array.isArray(p.leaderboard) ? p.leaderboard : [];
    if (!board.length) return `<div class="empty">אין עדיין דירוג להצגה.</div>`;
    const selfId = state.user && state.user.id;
    return `<div class="log-list" style="margin-bottom:10px;">${board.map((row, i) => `<div class="log-row"${row.user_id === selfId ? ' style="border-color:var(--energy);"' : ""}><span>${i + 1}. ${safeText(row.name || (row.handle ? "@" + row.handle : "חבר/ה"))}${row.user_id === selfId ? " (את/ה)" : ""}</span><span class="mono" style="color:var(--brass);">${safeText(row.value)}</span></div>`).join("")}</div>`;
  }
  function renderCoachEntryPanel(v) {
    const active = (v.participants || []).filter((p) => p.status === "active");
    const rosterHtml = active.length ? active.map((p) => {
      const prof = p.profiles || {};
      const name = prof.display_name || (prof.handle ? "@" + prof.handle : "חבר/ה");
      const d = v.coachEntry.drafts[p.user_id] || { delta: "", note: "" };
      const busy = !!v.coachEntry.busy[p.user_id];
      return `<div class="log-row" style="flex-direction:column;align-items:stretch;gap:6px;">
        <div class="flex" style="justify-content:space-between;"><span>${safeText(name)}</span><span class="mono" style="color:var(--brass);">${safeText(p.progress_value)}</span></div>
        <div class="flex gap-6">
          <input class="text-input" type="number" step="any" data-challenge-coach-delta="${safeText(p.user_id)}" value="${safeText(d.delta)}" placeholder="כמות" style="flex:1;"/>
          <button class="chip-btn primary" data-community-action="challenge-coach-submit" data-id="${safeText(p.user_id)}"${busy ? " disabled" : ""}>${busy ? "שומר…" : "עדכון"}</button>
        </div>
      </div>`;
    }).join("") : `<div class="empty">אף אחד עדיין לא הצטרף לאתגר.</div>`;
    return `<div class="chart-card" style="margin-bottom:10px;">
      <div class="field-label" style="margin-bottom:6px;">עדכון התקדמות משתתפים</div>
      <div class="log-list">${rosterHtml}</div>
      ${v.coachEntry.error ? `<div class="field-error" role="alert" style="margin-top:6px;">${safeText(v.coachEntry.error)}</div>` : ""}
    </div>`;
  }
  function renderChallengeParticipants(v) {
    const list = (v.participants || []).filter((p) => p.status !== "withdrawn").slice(0, 30);
    if (!list.length) return "";
    const count = (v.progress && v.progress.participant_count != null) ? v.progress.participant_count : list.length;
    return `<div style="margin-top:12px;">
      <div class="field-label" style="margin-bottom:6px;">משתתפים (${safeText(count)})</div>
      <div class="log-list">${list.map((p) => {
        const prof = p.profiles || {};
        const name = prof.display_name || (prof.handle ? "@" + prof.handle : "חבר/ה");
        return `<div class="log-row"><span>${safeText(name)}</span>${p.status === "completed" ? `<span class="admin-tag" style="background:var(--brass);">הושלם</span>` : ""}</div>`;
      }).join("")}</div>
    </div>`;
  }
  function renderChallengeViewBody(v) {
    const c = v.challenge;
    const def = challengeTypeDef(c.challenge_type);
    const staff = hasPerm(PERM.CHALLENGE_CREATE);
    const meta = `<div style="color:var(--steel);font-size:12px;margin-bottom:10px;">${safeText(def.label)} · ${formatChallengeDate(c.start_at)}–${formatChallengeDate(c.end_at)} · ${safeText(challengeStatusLabel(c))}</div>`;
    const description = c.description ? `<div style="font-size:13.5px;line-height:1.6;margin-bottom:10px;white-space:pre-wrap;">${safeText(c.description)}</div>` : "";
    const rules = (c.config && c.config.rules_text) ? `<div class="chart-card" style="margin-bottom:10px;"><div class="field-label" style="margin-bottom:4px;">חוקי האתגר</div><div style="font-size:13px;white-space:pre-wrap;">${safeText(c.config.rules_text)}</div></div>` : "";
    const staffToolbar = staff ? `<div class="chip-row" style="margin-bottom:10px;"><button class="chip-btn" data-community-action="challenge-edit" data-id="${safeText(c.id)}">עריכה</button></div>` : "";
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
    const v = state.challengeView;
    if (!v) return "";
    const bodyHtml = v.loading ? `<div class="empty">טוען את האתגר…</div>`
      : (v.error || !v.challenge) ? `<div class="empty">לא ניתן היה לטעון את האתגר. נסו שוב.</div>`
      : renderChallengeViewBody(v);
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="challengeViewTitle" data-cloud-dialog="challengeView" style="align-items:flex-start;padding:20px 12px;">
      <div class="modal-sheet" style="border-radius:20px;max-height:88vh;overflow:auto;width:100%;max-width:560px;">
        <div style="padding:18px 18px calc(env(safe-area-inset-bottom,0px) + 16px);">
          <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div id="challengeViewTitle" style="font-weight:800;font-size:17px;">${v.challenge ? safeText(v.challenge.title) : "אתגר"}</div>
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
  function eventAttendeeRows(id) { return state.eventAttendees[id] || []; }
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
    if (!state.user) { state.events = []; state.eventsById = {}; state.eventAttendees = {}; state.eventsLoaded = false; return; }
    state.eventsLoading = true;
    rerender();
    const { data, error } = await client.from("events").select("*").order("start_at", { ascending: true });
    if (error) { state.eventsLoading = false; state.eventsError = true; return rerender(); }
    state.events = data || [];
    state.eventsById = {};
    for (const e of state.events) state.eventsById[e.id] = e;
    state.eventsError = false;
    const ids = state.events.map((e) => e.id);
    state.eventAttendees = {};
    if (ids.length) {
      const { data: rows, error: aErr } = await client.from("event_attendees")
        .select("event_id,user_id,response,registered_at,profiles(display_name,handle,avatar_url)")
        .in("event_id", ids);
      if (!aErr) for (const row of (rows || [])) (state.eventAttendees[row.event_id] = state.eventAttendees[row.event_id] || []).push(row);
    }
    state.eventsLoading = false;
    state.eventsLoaded = true;
    rerender();
  }

  // ---- List (COMM-213) ------------------------------------------------------
  function eventCardImageHtml(e) {
    return e.image_url
      ? `<img src="${safeText(e.image_url)}" alt="" style="width:56px;height:56px;border-radius:12px;object-fit:cover;"/>`
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
    return `<article class="chart-card" data-event-id="${safeText(e.id)}" data-event-status="${safeText(e.status)}" style="margin-bottom:10px;${cancelled ? "opacity:.7;" : ""}">
      <div class="flex gap-10" style="align-items:flex-start;">
        ${eventCardImageHtml(e)}
        <div style="flex:1;min-width:0;">
          <button class="link-btn" data-community-action="open-event" data-id="${safeText(e.id)}" style="padding:0;text-align:right;font-weight:800;font-size:15px;color:inherit;display:block;">${safeText(e.title)}</button>
          <div style="color:var(--steel);font-size:11.5px;margin-top:2px;">${meta.map(safeText).join(" · ")}</div>
        </div>
      </div>
      <div class="chip-row" style="margin-top:8px;">
        <button class="chip-btn" data-community-action="open-event" data-id="${safeText(e.id)}">פרטים</button>
        ${mineLabel ? `<span class="admin-tag" style="background:var(--brass);">${mineLabel}</span>` : ""}
      </div>
    </article>`;
  }
  function renderEventsListSection() {
    const staff = hasPerm(PERM.EVENT_MANAGE);
    const upcoming = state.events.filter((e) => isUpcomingEvent(e) || (staff && e.status === "draft"));
    const past = state.events.filter(isPastEvent).slice().sort((a, b) => (a.start_at < b.start_at ? 1 : -1));
    const createBtn = staff ? `<button class="chip-btn primary" data-community-action="open-event-form" style="margin-bottom:10px;">אירוע חדש</button>` : "";
    const list = (state.eventsLoading && !state.eventsLoaded)
      ? `<div aria-busy="true">${`<div class="chart-card" style="height:64px;background:var(--border);opacity:.35;margin-bottom:10px;"></div>`.repeat(2)}</div>`
      : state.eventsError
      ? `<div class="empty">לא ניתן היה לטעון את האירוע. נסו שוב.<div class="chip-row" style="justify-content:center;"><button class="chip-btn" data-community-action="events-retry">ניסיון חוזר</button></div></div>`
      : upcoming.length ? upcoming.map(renderEventCard).join("") : `<div class="empty">אין אירועים קרובים כרגע.</div>`;
    const pastHtml = past.length ? `<div style="margin-top:16px;"><div class="field-label" style="margin-bottom:6px;">אירועים שהסתיימו</div>${past.map(renderEventCard).join("")}</div>` : "";
    return `<div class="ach-section">${sectionHead("var(--blue)", "אירועי המועדון")}${createBtn}${state.eventForm ? renderEventForm() : ""}${list}${pastHtml}</div>`;
  }

  // ---- Create/edit form (COMM-213) ------------------------------------------
  function openEventForm(existing) {
    state.eventForm = existing ? {
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
  function closeEventForm() { state.eventForm = null; setFieldErrors("communityEventForm", {}); rerender(); }
  function setEventFormType(type) { if (state.eventForm && EVENT_TYPES.some((t) => t.id === type)) { state.eventForm.eventType = type; rerender(); } }
  async function submitEventForm(form) {
    const f = state.eventForm;
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
    state.eventForm = null;
    setMessage("האירוע נשמר");
    await loadEvents();
    rerender();
  }
  async function publishEventDraft(id) {
    const { error } = await client.from("events").update({ status: "published" }).eq("id", id);
    if (error) return setMessage("הפעולה נכשלה");
    const event = state.eventsById[id];
    if (event) await ensureEventCompanionPost(Object.assign({}, event, { status: "published" }));
    state.eventForm = null;
    setMessage("האירוע פורסם");
    await loadEvents();
    if (state.eventView && state.eventView.id === id) await refreshEventView(id);
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
    if (state.eventView && state.eventView.id === id) await refreshEventView(id);
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
    state.eventView = { id, loading: true, error: false, event: null, attendees: [], organizer: null, companionPostId: null, rsvpBusy: null, rsvpError: "", icsBusy: false, icsError: "" };
    rerender();
    await refreshEventView(id);
  }
  function closeEventView() { state.eventView = null; rerender(); }
  async function refreshEventView(id) {
    const v = state.eventView;
    if (!v || v.id !== id) return;
    const { data: event, error } = await client.from("events").select("*").eq("id", id).maybeSingle();
    if (!state.eventView || state.eventView.id !== id) return;
    if (error || !event) { state.eventView.loading = false; state.eventView.error = true; return rerender(); }
    state.eventView.event = event;
    state.eventsById[id] = event;
    const { data: attendees } = await client.from("event_attendees")
      .select("user_id,response,registered_at,profiles(display_name,handle,avatar_url)")
      .eq("event_id", id).order("registered_at", { ascending: true });
    state.eventView.attendees = attendees || [];
    state.eventView.organizer = null;
    if (event.created_by) {
      const { data: organizer } = await client.from("profiles").select("id,display_name,handle").eq("id", event.created_by).maybeSingle();
      state.eventView.organizer = organizer || null;
    }
    // COMM-216. Opens the companion post's thread by default - there is no
    // separate "toggle comments" affordance on an event, the thread IS the
    // event's discussion.
    const companion = await findEventCompanionPost(id);
    state.eventView.companionPostId = companion ? companion.id : null;
    if (state.eventView.companionPostId) {
      state.openComments[state.eventView.companionPostId] = true;
      await loadCommentsFor(state.eventView.companionPostId);
    }
    state.eventView.loading = false;
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
    const v = state.eventView && state.eventView.id === eventId ? state.eventView : null;
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
    if (state.eventView && state.eventView.id === eventId) await refreshEventView(eventId);
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
      return `<button class="chip-btn${active ? " primary" : ""}" data-community-action="event-rsvp" data-id="${safeText(e.id)}" data-response="${response}"${disabled ? " disabled" : ""}>${v.rsvpBusy === response ? "מעדכנ/ת…" : label}</button>`;
    };
    const notes = [];
    // COMM-214: "past its registration deadline disables any RSVP change".
    // Full only disables Going (Interested and Not Going stay open), and a
    // going->going update stays enabled on a full event (eventIsFull()
    // already excludes that case).
    if (closed) notes.push("ההרשמה נסגרה");
    else if (full) notes.push("האירוע מלא");
    return `<div class="chip-row" style="margin-bottom:6px;">${btn("going", "משתתפ/ת")}${btn("interested", "מעוניינ/ת")}${btn("not_going", "לא משתתפ/ת")}</div>
      ${notes.length ? `<div class="footer-note" style="margin-bottom:8px;">${notes.map(safeText).join(" · ")}</div>` : ""}
      ${v.rsvpError ? `<div class="field-error" role="alert" style="margin-bottom:8px;">${safeText(v.rsvpError)}</div>` : ""}`;
  }
  function renderEventAttendees(v) {
    const rows = v.attendees || [];
    if (!rows.length) return `<div class="empty">אין עדיין נרשמים.</div>`;
    const going = rows.filter((r) => r.response === "going").length;
    const rowHtml = (r) => {
      const prof = r.profiles || {};
      const name = prof.display_name || (prof.handle ? "@" + prof.handle : "חבר/ה");
      const label = r.response === "going" ? "הולכ/ת" : r.response === "interested" ? "מעוניינ/ת" : "לא הולכ/ת";
      return `<div class="log-row"><span>${safeText(name)}</span><span style="color:var(--steel);font-size:12px;">${safeText(label)}</span></div>`;
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
    const v = state.eventView && state.eventView.id === eventId ? state.eventView : null;
    const event = (v && v.event) || state.eventsById[eventId];
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
    const metaHtml = `<div style="color:var(--steel);font-size:12px;margin-bottom:10px;">${meta.map(safeText).join(" · ")}</div>`;
    const image = e.image_url ? `<img src="${safeText(e.image_url)}" alt="" style="width:100%;max-height:200px;object-fit:cover;border-radius:12px;margin-bottom:10px;"/>` : "";
    const description = e.description ? `<div style="font-size:13.5px;line-height:1.6;margin-bottom:10px;white-space:pre-wrap;">${safeText(e.description)}</div>` : "";
    const locationHtml = e.location ? `<div style="font-size:13px;color:var(--steel);margin-bottom:4px;">📍 ${safeText(e.location)}${e.map_link ? ` · <a class="link-btn" href="${safeText(e.map_link)}" target="_blank" rel="noopener noreferrer">מפה</a>` : ""}</div>` : "";
    const going = eventGoingCount(e.id);
    const capacityHtml = `<div style="font-size:13px;color:var(--steel);margin-bottom:4px;">${e.capacity != null ? `${going} / ${e.capacity} משתתפים` : `${going} משתתפים`}</div>`;
    const deadlineHtml = e.registration_deadline ? `<div style="font-size:12px;color:var(--steel);margin-bottom:4px;">מועד אחרון להרשמה: ${safeText(formatEventDate(e.registration_deadline))} ${safeText(formatEventTime(e.registration_deadline))}</div>` : "";
    const organizerName = v.organizer ? (v.organizer.display_name || (v.organizer.handle ? "@" + v.organizer.handle : "")) : "";
    const organizerHtml = organizerName ? `<div style="font-size:12px;color:var(--steel);margin-bottom:10px;">מארגנ/ת: ${safeText(organizerName)}</div>` : "";
    const staffToolbar = staff ? `<div class="chip-row" style="margin-bottom:10px;">
        <button class="chip-btn" data-community-action="event-edit" data-id="${safeText(e.id)}">עריכה</button>
        ${e.status === "draft" ? `<button class="chip-btn" data-community-action="event-publish" data-id="${safeText(e.id)}">פרסום</button>` : ""}
        ${e.status === "published" ? `<button class="chip-btn" data-community-action="event-cancel-confirm" data-id="${safeText(e.id)}" style="color:var(--red);">ביטול האירוע</button>` : ""}
      </div>` : "";
    const actions = renderEventActions(v);
    const icsBtn = `<div class="chip-row" style="margin:8px 0;"><button class="chip-btn" data-community-action="event-ics" data-id="${safeText(e.id)}"${v.icsBusy ? " disabled" : ""}>${v.icsBusy ? "יוצר…" : "הוספה ליומן"}</button></div>${v.icsError ? `<div class="field-error" role="alert">${safeText(v.icsError)}</div>` : ""}`;
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
    const v = state.eventView;
    if (!v) return "";
    const bodyHtml = v.loading ? `<div class="empty">טוען את האירוע…</div>`
      : (v.error || !v.event) ? `<div class="empty">לא ניתן היה לטעון את האירוע. נסו שוב.</div>`
      : renderEventViewBody(v);
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="eventViewTitle" data-cloud-dialog="eventView" style="align-items:flex-start;padding:20px 12px;">
      <div class="modal-sheet" style="border-radius:20px;max-height:88vh;overflow:auto;width:100%;max-width:560px;">
        <div style="padding:18px 18px calc(env(safe-area-inset-bottom,0px) + 16px);">
          <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div id="eventViewTitle" style="font-weight:800;font-size:17px;">${v.event ? safeText(v.event.title) : "אירוע"}</div>
            <button class="chip-btn" data-community-action="close-event-view" aria-label="סגירה">✕</button>
          </div>
          ${bodyHtml}
        </div>
      </div>
    </div>`;
  }

  // ---- Create/edit form markup (COMM-213) ------------------------------------
  function renderEventForm() {
    const f = state.eventForm;
    const typePicker = `<div class="chip-row" role="group" aria-label="סוג אירוע" style="margin-bottom:10px;flex-wrap:wrap;">${EVENT_TYPES.map((t) => `<button type="button" class="chip-btn${f.eventType === t.id ? " primary" : ""}" data-community-action="event-form-type" data-type="${t.id}">${t.icon} ${safeText(t.label)}</button>`).join("")}</div>`;
    return `<form id="communityEventForm" class="chart-card admin-card" style="margin-top:10px;">
      <div style="font-weight:800;margin-bottom:10px;">${f.mode === "edit" ? "עריכת אירוע" : "אירוע חדש"}<span class="admin-tag">ניהול</span></div>
      ${typePicker}
      ${field("communityEventForm", "title", "שם האירוע", `<input class="text-input" name="title" value="${safeText(f.title)}" maxlength="120" required/>`)}
      ${field("communityEventForm", "description", "תיאור", `<textarea class="text-input" name="description" maxlength="4000">${safeText(f.description)}</textarea>`)}
      ${field("communityEventForm", "imageUrl", "קישור לתמונה", `<input class="text-input" name="imageUrl" value="${safeText(f.imageUrl)}" maxlength="500" placeholder="https://..."/>`)}
      ${field("communityEventForm", "location", "מיקום", `<input class="text-input" name="location" value="${safeText(f.location)}" maxlength="240"/>`)}
      ${field("communityEventForm", "mapLink", "קישור למפה", `<input class="text-input" name="mapLink" value="${safeText(f.mapLink)}" maxlength="500" placeholder="https://..."/>`)}
      <div class="flex gap-10 field">
        ${field("communityEventForm", "startAt", "התחלה", `<input class="text-input" name="startAt" type="datetime-local" value="${safeText(f.startAt)}" required/>`)}
        ${field("communityEventForm", "endAt", "סיום", `<input class="text-input" name="endAt" type="datetime-local" value="${safeText(f.endAt)}"/>`)}
      </div>
      <div class="flex gap-10 field">
        ${field("communityEventForm", "capacity", "מקומות (ריק = ללא הגבלה)", `<input class="text-input" name="capacity" type="number" min="1" value="${safeText(f.capacity)}"/>`)}
        ${field("communityEventForm", "registrationDeadline", "מועד אחרון להרשמה", `<input class="text-input" name="registrationDeadline" type="datetime-local" value="${safeText(f.registrationDeadline)}"/>`)}
      </div>
      ${f.mode === "create" ? `<label class="field flex gap-6" style="align-items:center;"><input type="checkbox" name="publishNow"/><span style="font-size:12.5px;color:var(--steel);">פרסום מיידי (אחרת יישמר כטיוטה)</span></label>` : ""}
      ${f.error ? `<div class="field-error" role="alert">${safeText(f.error)}</div>` : ""}
      <div class="chip-row" style="margin-top:10px;">
        <button class="chip-btn primary" type="submit"${f.saving ? " disabled" : ""}>${f.saving ? "שומר…" : "שמירה"}</button>
        <button class="chip-btn" type="button" data-community-action="event-form-cancel">ביטול</button>
      </div>
    </form>`;
  }

  // ---- Upcoming-event card in the feed top area (COMM-217) -------------------
  // The soonest published, non-cancelled event with start_at > now(), or
  // nothing at all - never an empty placeholder. state.events is loaded
  // alongside the feed (loadEvents() sits in the same Promise.all as
  // loadFeed()), so this needs no realtime subscription of its own: it
  // refreshes exactly when the rest of the feed top area does.
  function upcomingFeedEvent() {
    // state.events is sorted start_at ascending by the query itself
    // (loadEvents()'s order()), so the first match is the soonest one.
    return state.events.find(isUpcomingEvent) || null;
  }
  function renderUpcomingEventCard() {
    const e = upcomingFeedEvent();
    if (!e) return "";
    const going = eventGoingCount(e.id);
    const mine = myEventResponse(e.id);
    const closed = eventRegistrationClosed(e);
    const full = eventIsFull(e);
    return `<div class="chart-card" style="margin-top:10px;" data-event-id="${safeText(e.id)}">
      <button class="link-btn" data-community-action="open-event" data-id="${safeText(e.id)}" data-source="club_top" style="padding:0;text-align:right;display:block;width:100%;">
        <div style="font-weight:800;font-size:14px;">📅 ${safeText(e.title)}</div>
        <div style="color:var(--steel);font-size:12px;margin-top:2px;">${safeText(formatEventDate(e.start_at))} ${safeText(formatEventTime(e.start_at))} · ${going} משתתפים</div>
      </button>
      <div class="chip-row" style="margin-top:8px;">
        <button class="chip-btn${mine === "going" ? " primary" : ""}" data-community-action="event-rsvp" data-id="${safeText(e.id)}" data-response="going"${closed || full ? " disabled" : ""}>משתתפ/ת</button>
        <button class="chip-btn${mine === "interested" ? " primary" : ""}" data-community-action="event-rsvp" data-id="${safeText(e.id)}" data-response="interested"${closed ? " disabled" : ""}>מעוניינ/ת</button>
      </div>
    </div>`;
  }

  // ---- Composer (COMM-102, COMM-103) --------------------------------------
  function openComposer(triggerEl) {
    state.composerTrigger = triggerEl || null;
    state.composer = { body: "", visibility: "club", photos: [], links: {}, error: "", publishing: false };
    state.openPostMenu = null;
    rerender();
    setTimeout(() => { const t = document.querySelector("[data-composer-body]"); if (t && t.focus) t.focus(); }, 0);
  }
  window.openPostComposer = openComposer;
  function closeComposer() {
    const trigger = state.composerTrigger;
    state.composer = null;
    state.composerTrigger = null;
    rerender();
    if (trigger && trigger.focus) setTimeout(() => trigger.focus(), 0);
  }
  function tryCloseComposer() {
    if (state.composer && (cleanPostBody(state.composer.body) || state.composer.photos.length)) {
      askConfirm({ title: "לבטל את הפוסט?", message: "מה שכתבתם לא יישמר.", confirmLabel: "ביטול הפוסט", destructive: true, action: "composer-discard" });
    } else {
      closeComposer();
    }
  }
  function composerSetBody(v) {
    if (!state.composer) return;
    state.composer.body = v;
    const dlg = document.getElementById("postComposer");
    if (!dlg) return;
    const btn = dlg.querySelector('[data-community-action="composer-publish"]');
    if (btn) btn.disabled = !composerCanPublish();
    const c = dlg.querySelector("[data-composer-counter]");
    if (c) { const n = cleanPostBody(v).length; c.textContent = n >= 900 ? `${n}/${POST_BODY_MAX}` : ""; }
  }
  function composerSetAlt(id, v) {
    if (!state.composer) return;
    const p = state.composer.photos.find((x) => x.id === id);
    if (p) p.altText = v;
    const dlg = document.getElementById("postComposer");
    if (dlg) { const btn = dlg.querySelector('[data-community-action="composer-publish"]'); if (btn) btn.disabled = !composerCanPublish(); }
  }
  function composerToggleDecorative(id, checked) {
    if (!state.composer) return;
    const p = state.composer.photos.find((x) => x.id === id);
    if (p) { p.decorative = !!checked; if (checked) p.altText = ""; }
    rerender();
  }
  function composerSetVisibility(v) {
    if (state.composer && POST_VISIBILITY_OPTIONS.some((o) => o.value === v)) state.composer.visibility = v;
  }
  function composerRemovePhoto(id) {
    if (!state.composer) return;
    state.composer.photos = state.composer.photos.filter((p) => p.id !== id);
    rerender();
  }
  function composerRetryPhoto(id) {
    if (!state.composer) return;
    const p = state.composer.photos.find((x) => x.id === id);
    const file = p && p._file;
    composerRemovePhoto(id);
    if (file) composerAddPhoto(file);
  }
  // COMM-103. Every photo goes through prepareImage (COMM-015) before upload.
  async function composerAddPhoto(file) {
    if (!state.composer) return;
    if (state.composer.photos.length >= POST_MEDIA_MAX) { state.composer.error = `אפשר לצרף עד ${POST_MEDIA_MAX} תמונות`; return rerender(); }
    const id = "ph" + Date.now() + Math.random().toString(36).slice(2, 6);
    const photo = { id, status: "processing", altText: "", decorative: false, storagePath: null, previewUrl: null, error: null, width: null, height: null, _file: file };
    state.composer.photos.push(photo);
    state.composer.error = "";
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
  function composerReadyPhotos() { return state.composer ? state.composer.photos.filter((p) => p.status === "ready") : []; }
  function composerCanPublish() {
    const c = state.composer;
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
    const c = state.composer;
    if (!c) return "";
    if (c.photos.some((p) => p.status === "processing")) return "יש להמתין לסיום עיבוד התמונות";
    if (c.photos.some((p) => p.status === "failed")) return "יש להסיר או לנסות שוב תמונה שנכשלה";
    if (composerReadyPhotos().some((p) => !p.decorative && !String(p.altText || "").trim())) return "יש להוסיף תיאור לכל תמונה או לסמן אותה כדקורטיבית";
    return "צריך טקסט או לפחות תמונה אחת";
  }
  async function publishComposer() {
    const c = state.composer;
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
      author: { display_name: state.profile && state.profile.display_name, handle: state.profile && state.profile.handle },
      body,
      visibility: c.visibility,
      created_at: new Date().toISOString(),
      media: media.map((m) => ({ ...m, url: null })),
      reaction_count: 0,
      comment_count: 0,
    };
    if (Array.isArray(state.feed)) state.feed.unshift(optimistic);
    state.composer = null;
    state.composerTrigger = null;
    setMessage("הפוסט פורסם");
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.POST_CREATED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.POST_CREATED, { post_id: data, post_type: optimistic.post_type }); } catch (e) {}
    }
    rerender();
  }
  function renderPostComposer() {
    const c = state.composer;
    if (!c) return "";
    const bodyLen = cleanPostBody(c.body).length;
    const canPublish = composerCanPublish();
    const tiles = c.photos.map((p) => `
      <div class="composer-photo-tile" data-photo-id="${safeText(p.id)}" style="border:1px solid var(--border);border-radius:12px;padding:8px;margin-bottom:8px;">
        <div class="flex" style="justify-content:space-between;align-items:center;gap:8px;">
          <span style="font-size:12px;color:var(--steel);">${p.status === "processing" ? "מעבד תמונה…" : p.status === "failed" ? safeText(p.error || "נכשל") : "תמונה מוכנה"}</span>
          <button class="link-btn" data-community-action="composer-remove-photo" data-id="${safeText(p.id)}" aria-label="הסרת תמונה">הסרה</button>
        </div>
        ${p.previewUrl ? `<img src="${safeText(p.previewUrl)}" alt="" style="max-width:100%;border-radius:8px;margin:6px 0;"/>` : ""}
        ${p.status === "failed" ? `<button class="chip-btn" data-community-action="composer-retry-photo" data-id="${safeText(p.id)}">ניסיון חוזר</button>` : ""}
        <label class="field" style="margin-top:6px;"><span class="field-label">תיאור לקורא מסך</span>
          <input class="text-input" type="text" maxlength="${ALT_TEXT_MAX}" data-composer-alt="${safeText(p.id)}" value="${safeText(p.altText || "")}"${p.decorative ? " disabled" : ""} placeholder="תיאור קצר של התמונה"/></label>
        <label class="flex gap-6" style="align-items:center;font-size:12px;color:var(--steel);margin-top:4px;">
          <input type="checkbox" data-composer-decorative="${safeText(p.id)}"${p.decorative ? " checked" : ""}/> התמונה דקורטיבית, אין צורך בתיאור
        </label>
      </div>`).join("");
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="postComposerTitle" data-composer-overlay data-cloud-dialog="composer" style="align-items:center;padding:0 16px;">
      <div class="modal-sheet" id="postComposer" style="border-radius:22px;max-height:90vh;overflow:auto;">
        <div style="padding:22px 20px calc(env(safe-area-inset-bottom,0px) + 18px);">
          <div id="postComposerTitle" style="color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:12px;">פוסט חדש</div>
          <label class="field"><span class="field-label">מה תרצו לשתף?</span>
            <textarea class="text-input" data-composer-body maxlength="${POST_BODY_MAX}" rows="4" placeholder="כתבו משהו לקהילה" aria-describedby="postComposerCounter">${safeText(c.body || "")}</textarea></label>
          <div id="postComposerCounter" data-composer-counter style="text-align:left;font-size:11px;color:var(--steel);min-height:14px;">${bodyLen >= 900 ? `${bodyLen}/${POST_BODY_MAX}` : ""}</div>
          <div style="margin-top:8px;">${tiles}</div>
          ${c.photos.length < POST_MEDIA_MAX
            ? `<label class="chip-btn" style="cursor:pointer;display:inline-block;">הוספת תמונה<input type="file" accept="image/*" data-composer-file style="display:none;"/></label>`
            : `<div style="font-size:12px;color:var(--steel);">הגעתם למקסימום ${POST_MEDIA_MAX} תמונות</div>`}
          <label class="field" style="margin-top:12px;"><span class="field-label">מי רואה את הפוסט</span>
            <select class="text-input" data-composer-visibility>
              ${POST_VISIBILITY_OPTIONS.map((o) => `<option value="${o.value}"${c.visibility === o.value ? " selected" : ""}>${o.label}</option>`).join("")}
            </select></label>
          ${c.error ? `<div class="field-error" role="alert" style="margin-top:8px;">${safeText(c.error)}</div>` : ""}
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
    state.openPostMenu = state.openPostMenu === id ? null : id;
    rerender();
  }
  async function postSaveToggle(postId) {
    if (!state.user) return;
    state.openPostMenu = null;
    state.savedPostIds = state.savedPostIds || {};
    const wasSaved = !!state.savedPostIds[postId];
    if (wasSaved) {
      delete state.savedPostIds[postId];
      rerender();
      const { error } = await client.from("saved_posts").delete().eq("user_id", state.user.id).eq("post_id", postId);
      if (error) { state.savedPostIds[postId] = true; setMessage("לא ניתן לעדכן את השמורים"); rerender(); }
      else setMessage("הוסר מהשמורים");
    } else {
      state.savedPostIds[postId] = true;
      rerender();
      const { error } = await client.from("saved_posts").insert({ user_id: state.user.id, post_id: postId });
      if (error && error.code !== "23505") { delete state.savedPostIds[postId]; setMessage("לא ניתן לשמור את הפוסט"); rerender(); }
      else setMessage("הפוסט נשמר");
    }
  }
  async function postHide(postId) {
    if (!state.user) return;
    state.openPostMenu = null;
    if (Array.isArray(state.feed)) state.feed = state.feed.filter((p) => p && p.id !== postId);
    rerender();
    const { error } = await client.from("hidden_posts").insert({ user_id: state.user.id, post_id: postId });
    if (error && error.code !== "23505") setMessage("לא ניתן להסתיר את הפוסט");
    else setMessage("הפוסט הוסתר מהפיד שלך");
  }
  function postStartCaptionEdit(postId) {
    state.openPostMenu = null;
    const post = findFeedPost(postId);
    state.captionEdit = { postId, body: (post && post.body) || "" };
    state.visibilityEdit = null;
    rerender();
  }
  async function postSaveCaption() {
    const e = state.captionEdit;
    if (!e) return;
    const body = cleanPostBody(e.body);
    const { error } = await client.rpc("post_edit_caption", { post_id: e.postId, body });
    if (error) { setMessage("עריכת הכיתוב נכשלה"); return; }
    const post = findFeedPost(e.postId);
    if (post) post.body = body;
    state.captionEdit = null;
    setMessage("הכיתוב עודכן");
    rerender();
  }
  function postStartVisibilityEdit(postId) {
    state.openPostMenu = null;
    const post = findFeedPost(postId);
    state.visibilityEdit = { postId, visibility: normalizeVisibility(post && post.visibility) };
    state.captionEdit = null;
    rerender();
  }
  async function postApplyVisibility(visibility) {
    const e = state.visibilityEdit;
    if (!e || !POST_VISIBILITY_OPTIONS.some((o) => o.value === visibility)) return;
    const { error } = await client.rpc("post_set_visibility", { post_id: e.postId, visibility });
    if (error) { setMessage("שינוי הנראוּת נכשל"); return; }
    const post = findFeedPost(e.postId);
    if (post) post.visibility = visibility;
    state.visibilityEdit = null;
    setMessage("הנראוּת עודכנה");
    rerender();
  }
  async function postDeleteViaMenu(postId) {
    const { error } = await client.rpc("post_delete", { post_id: postId });
    if (error) { setMessage("מחיקת הפוסט נכשלה"); return; }
    if (Array.isArray(state.feed)) state.feed = state.feed.filter((p) => p && p.id !== postId);
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
    state.prPrompt = { record: Object.assign({}, record, { record_id: recordId }), note: "", showNote: false, photo: null, publishing: false, error: "" };
    rerender();
  }
  function dismissPrPrompt() {
    if (state.prPrompt) rememberPrDismissed(state.prPrompt.record.record_id);
    state.prPrompt = null;
    rerender();
  }
  async function prPromptAddPhoto(file) {
    const p = state.prPrompt;
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
    const p = state.prPrompt;
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
    state.prPrompt = null;
    setMessage("השיא שותף לקהילה");
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.POST_CREATED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.POST_CREATED, { post_id: data, post_type: "POST_PR" }); } catch (e) {}
    }
    rerender();
  }
  function renderPrSharePrompt() {
    const p = state.prPrompt;
    if (!p) return "";
    const r = p.record;
    const line = (label, val) => (val != null && val !== "") ? `<div style="font-size:12.5px;color:var(--steel);">${safeText(label)}: <span class="mono" style="color:var(--brass);">${safeText(val)}</span></div>` : "";
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="prPromptTitle" data-cloud-dialog="prPrompt" style="align-items:center;padding:0 16px;">
      <div class="modal-sheet" id="prPrompt" style="border-radius:22px;max-height:90vh;overflow:auto;">
        <div style="padding:22px 20px calc(env(safe-area-inset-bottom,0px) + 18px);">
          <div id="prPromptTitle" style="color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:6px;">שיא חדש זוהה. לשתף עם המועדון?</div>
          <div style="display:inline-block;font-size:11px;font-weight:800;color:#0c0c0c;background:var(--brass);border-radius:999px;padding:2px 8px;margin-bottom:8px;">PR</div>
          ${line("תרגיל", r.movement || r.movement_name)}
          ${line("תוצאה חדשה", r.new_result || r.new_value)}
          ${line("תוצאה קודמת", r.previous_result || r.previous_value)}
          ${line("שיפור", r.improvement)}
          ${p.photo ? `<div style="font-size:12px;color:var(--steel);margin-top:6px;">${p.photo.status === "ready" ? "תמונה צורפה" : p.photo.status === "processing" ? "מעבד תמונה…" : safeText(p.photo.error || "העלאת התמונה נכשלה")}</div>` : ""}
          ${p.photo && p.photo.status === "ready" && !p.photo.decorative ? `<label class="field" style="margin-top:6px;"><span class="field-label">תיאור התמונה לקורא מסך</span><input class="text-input" data-pr-alt maxlength="${ALT_TEXT_MAX}" value="${safeText(p.photo.altText || "")}"/></label>` : ""}
          ${p.showNote ? `<label class="field" style="margin-top:8px;"><span class="field-label">הערה</span><textarea class="text-input" data-pr-note maxlength="${POST_BODY_MAX}" rows="3">${safeText(p.note || "")}</textarea></label>` : ""}
          ${p.error ? `<div class="field-error" role="alert" style="margin-top:8px;">${safeText(p.error)}</div>` : ""}
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
    state.myAchievements = error ? [] : (data || []);
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
    if (written.length && Array.isArray(state.myAchievements)) {
      for (const r of written) {
        if (!state.myAchievements.some((x) => x.id === r.member_achievement_id)) {
          state.myAchievements.unshift({ id: r.member_achievement_id, visibility: r.visibility, shared_at: null, unlocked_at: new Date().toISOString(), achievement_definitions: { code: r.code } });
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
    state.achUnlock = {
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
  function dismissAchievementUnlock() { state.achUnlock = null; rerender(); }
  async function shareAchievementUnlock() {
    const a = state.achUnlock;
    if (!a || a.sharing) return;
    if (!a.memberAchievementId || a.visibility === "only_me") { a.error = "לא ניתן לשתף. נסו שוב."; return rerender(); }
    a.sharing = true;
    a.error = "";
    rerender();
    const { data, error } = await client.rpc("ach_share", { member_achievement_id: a.memberAchievementId, caption: cleanPostBody(a.note), media: [] });
    if (error || !data) { a.sharing = false; a.error = "לא ניתן לשתף. נסו שוב."; return rerender(); }
    if (Array.isArray(state.myAchievements)) {
      const row = state.myAchievements.find((r) => r.id === a.memberAchievementId);
      if (row) row.shared_at = new Date().toISOString();
    }
    // COMM-170. Sharing an achievement is a WCAM-qualifying action in its
    // own right, which is why it is tracked here and not left to the
    // POST_CREATED bridge below: the bus event records that a post exists,
    // this records that a member chose to share a decoration.
    track(A.ACHIEVEMENT_SHARED, { member_achievement_id: a.memberAchievementId, code: a.code || null, source: "unlock_sheet" });
    state.achUnlock = null;
    setMessage("העיטור שותף למועדון");
    if (window.HaimuniaEvents && window.PRODUCT_EVENTS && window.PRODUCT_EVENTS.POST_CREATED) {
      try { window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.POST_CREATED, { post_id: data, post_type: "POST_ACHIEVEMENT" }); } catch (e) {}
    }
    rerender();
  }
  function shareEarnedAchievement(memberAchievementId, code) {
    const row = (state.myAchievements || []).find((r) => r.id === memberAchievementId);
    onAchievementUnlocked({ code: code || achCodeOf(row), member_achievement_id: memberAchievementId, visibility: row ? row.visibility : "club" });
  }

  function renderAchievementUnlockCelebration() {
    const a = state.achUnlock;
    if (!a) return "";
    const canShare = !!a.memberAchievementId && a.visibility !== "only_me";
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="achUnlockTitle" data-cloud-dialog="achUnlock" style="align-items:center;padding:0 16px;">
      <div class="modal-sheet" id="achUnlock" style="border-radius:22px;max-height:90vh;overflow:auto;">
        <div style="padding:22px 20px calc(env(safe-area-inset-bottom,0px) + 18px);text-align:center;">
          <div style="font-size:44px;line-height:1;margin-bottom:8px;" aria-hidden="true">${safeText(a.icon)}</div>
          <div id="achUnlockTitle" style="color:var(--chalk);font-weight:800;font-size:18px;margin-bottom:4px;">עיטור חדש נפתח</div>
          <div style="color:var(--brass);font-weight:800;font-size:15px;">${safeText(a.title)}</div>
          ${a.explanation ? `<div style="color:var(--steel);font-size:12.5px;margin-top:6px;">${safeText(a.explanation)}</div>` : ""}
          ${a.showNote ? `<label class="field" style="margin-top:10px;text-align:right;"><span class="field-label">הערה</span><textarea class="text-input" data-ach-note maxlength="${POST_BODY_MAX}" rows="3">${safeText(a.note || "")}</textarea></label>` : ""}
          ${a.error ? `<div class="field-error" role="alert" style="margin-top:8px;">${safeText(a.error)}</div>` : ""}
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
    const list = Array.isArray(state.myAchievements) ? state.myAchievements : [];
    const rowsHtml = list.map((r) => {
      const code = achCodeOf(r);
      const meta = achMeta(code);
      const share = r.shared_at
        ? `<span style="color:var(--steel);font-size:12px;">שותף</span>`
        : r.visibility === "only_me"
          ? ""
          : `<button class="chip-btn" data-community-action="ach-share-later" data-id="${safeText(r.id)}" data-code="${safeText(code)}">שיתוף</button>`;
      return `<div class="log-row"><span>${safeText(meta.icon)} ${safeText(meta.title)}</span>${share}</div>`;
    }).join("");
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--brass)", "ההישגים שלי")}${list.length ? `<div class="log-list">${rowsHtml}</div>` : `<div class="empty">אין עדיין הישגים במועדון</div>`}</div>`;
  }

  // ---- Member profile community section (COMM-180) --------------------
  async function viewCommunityProfile(userId) {
    if (!userId) return;
    state.openPostMenu = null;
    // COMM-170. Counted on the open, not on the RPC answering: a member who
    // opened a profile that then failed to load still opened it. The
    // overlay is torn down and rebuilt on each open, so a re-render of an
    // already-open profile does not reach this line.
    track(A.PROFILE_OPENED, { user_id: userId, self: userId === (state.user && state.user.id) });
    state.profileView = { userId, loading: true, tab: "overview", data: null, error: false };
    rerender();
    const { data, error } = await client.rpc("community_profile", { user_id: userId });
    if (!state.profileView || state.profileView.userId !== userId) return;
    state.profileView.loading = false;
    if (error || !data) state.profileView.error = true;
    else {
      state.profileView.data = data;
      // COMM-160. community_profile already returns the server role; seed the
      // shared cache so the same badge shows here and on any surface opened
      // next, and resolve the roles of the authors on the Posts tab.
      if (data.role != null) state.memberRoles[userId] = data.role;
      loadMemberRoles((Array.isArray(data.posts) ? data.posts : []).map((p) => p && p.author_id)).then(() => rerender());
    }
    rerender();
  }
  function closeCommunityProfile() { state.profileView = null; rerender(); }
  function setProfileViewTab(tab) { if (state.profileView) { state.profileView.tab = tab; rerender(); } }
  const PROFILE_ROLE_LABELS = { owner: "בעלים", admin: "מנהל/ת", staff: "צוות", head_coach: "מאמן/ת ראשי/ת", coach: "מאמן/ת", member: "חבר/ה" };
  function renderCommunityProfileOverlay() {
    const pv = state.profileView;
    if (!pv) return "";
    const d = pv.data || {};
    const name = [d.first_name, d.last_name].filter(Boolean).join(" ") || d.display_name || (d.handle ? "@" + d.handle : "חבר/ה");
    const roleLabel = PROFILE_ROLE_LABELS[d.role] || (d.role ? safeText(d.role) : "");
    const profileTabs = [
      { id: "overview", label: "סקירה" },
      { id: "progress", label: "התקדמות" },
      { id: "achievements", label: "הישגים" },
      { id: "posts", label: "פוסטים" },
    ];
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
      const rowsHtml = rows.length ? `<div class="log-list">${rows.map(([k, v]) => `<div class="log-row"><span>${safeText(k)}</span><span class="mono" style="color:var(--brass);">${safeText(v)}</span></div>`).join("")}</div>` : "";
      const recentHtml = recent.length ? `<div class="log-list" style="margin-top:8px;">${recent.map((w) => `<div class="log-row"><span>${safeText(w.title || w.name || "")}</span><span style="color:var(--steel);font-size:12px;">${safeText(String(w.date || w.occurred_on || "").slice(0, 10))}</span></div>`).join("")}</div>` : "";
      bodyHtml = (rowsHtml + recentHtml) || `<div class="empty">אין מידע להצגה</div>`;
    } else if (active === "progress") {
      const prs = Array.isArray(d.prs) ? d.prs : null;
      bodyHtml = prs == null ? `<div class="empty">ההתקדמות מוסתרת</div>`
        : prs.length ? `<div class="log-list">${prs.map((x) => `<div class="log-row"><span>${safeText(x.movement || x.title || "")}</span><span class="mono" style="color:var(--brass);">${safeText(x.result || x.value || "")}</span></div>`).join("")}</div>`
        : `<div class="empty">אין עדיין שיאים</div>`;
    } else if (active === "achievements") {
      const ach = Array.isArray(d.achievements) ? d.achievements : null;
      bodyHtml = ach == null ? `<div class="empty">ההישגים מוסתרים</div>`
        : ach.length ? `<div class="badge-grid" style="display:flex;flex-wrap:wrap;gap:8px;">${ach.map((a) => `<div class="chart-card" style="flex:0 0 auto;padding:8px 10px;">${safeText(a.badge_icon || "🏅")} ${safeText(a.title || "")}</div>`).join("")}</div>`
        : `<div class="empty">אין עדיין הישגים</div>`;
    } else {
      const posts = Array.isArray(d.posts) ? d.posts : [];
      bodyHtml = posts.length ? `<div class="log-list">${posts.map((pp) => renderPostCard(pp)).join("")}</div>` : `<div class="empty">אין עדיין פוסטים</div>`;
    }
    const followBtn = d.allow_follows === false ? "" : `<button class="chip-btn" data-community-action="follow" data-id="${safeText(pv.userId)}">מעקב</button>`;
    const counts = (d.follower_count != null || d.following_count != null)
      ? `<span style="font-size:11px;color:var(--steel);align-self:center;">${Number(d.follower_count || 0)} עוקבים · ${Number(d.following_count || 0)} עוקב/ת</span>` : "";
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="profileViewTitle" data-cloud-dialog="profileView" style="align-items:flex-start;padding:20px 12px;">
      <div class="modal-sheet" style="border-radius:20px;max-height:88vh;overflow:auto;width:100%;max-width:520px;">
        <div style="padding:18px 18px calc(env(safe-area-inset-bottom,0px) + 16px);">
          <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div class="flex gap-10" style="align-items:center;min-width:0;">
              ${avatarHtml(name, 44)}
              <div style="min-width:0;">
                <div id="profileViewTitle" style="font-weight:800;font-size:16px;">${safeText(name)}${isCoachRole(d.role) ? " " + coachBadgeHtml(d.role) : ""}</div>
                <div style="color:var(--steel);font-size:12px;">${roleLabel ? safeText(roleLabel) : ""}${d.member_since ? ` · חבר/ה מאז ${safeText(String(d.member_since).slice(0, 10))}` : ""}</div>
              </div>
            </div>
            <button class="link-btn" data-community-action="close-profile" aria-label="סגירה">סגירה</button>
          </div>
          <div class="chip-row" style="margin-top:0;">${followBtn}${counts}</div>
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
  // Web push is Phase 2 (COMM-229): NOTIF_PUSH_ENABLED stays false, the
  // Push option renders disabled, no push_subscriptions write happens, and
  // a stored channel of "push" is read as "in_app".
  const NOTIF_PUSH_ENABLED = false;
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
  // are the client copy; the server fills `body` and `deep_link`. The
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
    announcement:          { category: "club",       mode: "immediate", pref: "announcements", operational: true, icon: "📢", title: "הודעה חשובה מהמועדון" },
    weekly_recap:          { category: "club",       mode: "batched",   pref: "weekly_recap",        icon: "📅", title: "הסיכום השבועי שלך" },
  };
  function notifTypeDef(type) { return NOTIF_TYPES[type] || null; }

  // The Preferences panel in Account lists exactly these, in this order
  // (COMM-144). Defaults: everything in_app (a missing row means in_app).
  const NOTIF_PREF_TYPES = [
    { key: "comments",            label: "תגובות על הפוסטים שלי" },
    { key: "replies",             label: "תגובות לתגובות שלי" },
    { key: "mentions",            label: "תיוגים" },
    { key: "reactions",           label: "עידודים" },
    { key: "achievements",        label: "הישגים שנפתחו" },
    { key: "friend_achievements", label: "הישגים של חברים" },
    { key: "challenges",          label: "אתגרים" },
    { key: "events",              label: "אירועים" },
    { key: "announcements",       label: "הודעות מהמועדון" },
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
    if (channel === "push" && !NOTIF_PUSH_ENABLED) channel = "in_app";
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
    if (!error) { state.notifUnread = Number(data) || 0; state.notifUnreadLoaded = true; rerender(); }
  }

  // --- COMM-144 per-type preferences (direct own-row RLS upsert) -------
  async function loadNotifPrefs() {
    if (!state.user || !client) return;
    const { data, error } = await client.from("notification_preferences")
      .select("type,channel").eq("user_id", state.user.id);
    const next = {};
    if (!error && Array.isArray(data)) for (const r of data) next[r.type] = r.channel;
    state.notifPrefs = next;
    state.notifPrefsLoaded = !error;
    rerender();
  }
  async function setNotifPref(type, channel) {
    if (!state.user || !NOTIF_PREF_KEYS.has(type)) return;          // unknown type is ignored
    if (NOTIF_CHANNELS.indexOf(channel) < 0) return;
    if (channel === "push" && !NOTIF_PUSH_ENABLED) return;         // push is disabled in V1
    const prev = state.notifPrefs[type];
    if (prev === channel) return;
    state.notifPrefs[type] = channel;
    state.notifPrefSaving[type] = true;
    rerender();
    const { error } = await client.from("notification_preferences").upsert(
      { user_id: state.user.id, type: type, channel: channel, updated_at: new Date().toISOString() },
      { onConflict: "user_id,type" });
    delete state.notifPrefSaving[type];
    if (error) {
      if (prev == null) delete state.notifPrefs[type]; else state.notifPrefs[type] = prev;
      setMessage("לא ניתן לשמור העדפה זו");
      return;
    }
    rerender();
  }

  // --- COMM-140 the centre: open, page, mark read --------------------
  async function openNotifCenter() {
    if (!state.user || !client) return;
    state.notifCenter = {
      loading: true, error: false, rows: [], cursor: null, end: false, hasOlder: false,
      loadingMore: false, moreError: false, expanded: {}, showOlder: false, _focused: false,
      returnFocus: "feed-notifications",
    };
    rerender();
    await fetchNotifPage(true);
  }
  function closeNotifCenter() {
    const back = state.notifCenter && state.notifCenter.returnFocus;
    state.notifCenter = null;
    rerender();
    if (back) {
      const el = document.querySelector('[data-community-action="' + back + '"]');
      if (el && el.focus) el.focus();
    }
  }
  async function fetchNotifPage(first) {
    const c = state.notifCenter;
    if (!c) return;
    if (!first && (c.loadingMore || c.end)) return;
    if (first) { c.loading = true; c.error = false; } else { c.loadingMore = true; c.moreError = false; }
    rerender();
    const { data, error } = await client.rpc("notif_list", { p_cursor: c.cursor, p_limit: NOTIF_PAGE_SIZE });
    if (!state.notifCenter || state.notifCenter !== c) return;
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
    const c = state.notifCenter;
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
    const prevUnread = Number(state.notifUnread) || 0;
    state.notifUnread = Math.max(0, prevUnread - ids.length);
    rerender();
    for (let i = 0; i < ids.length; i += 100) {
      const { error } = await client.rpc("notif_mark_read", { p_ids: ids.slice(i, i + 100) });
      if (error) { for (const r of targets) r.read_at = null; state.notifUnread = prevUnread; rerender(); return; }
    }
  }
  async function markAllNotifsRead() {
    const c = state.notifCenter;
    if (!c) return;
    const targets = c.rows.filter((r) => !r.read_at);
    if (!targets.length) return;
    const ids = targets.map((r) => r.id);
    const stamp = new Date().toISOString();
    for (const r of targets) r.read_at = stamp;
    const prevUnread = Number(state.notifUnread) || 0;
    state.notifUnread = Math.max(0, prevUnread - ids.length);
    rerender();
    for (let i = 0; i < ids.length; i += 100) {
      const { error } = await client.rpc("notif_mark_read", { p_ids: ids.slice(i, i + 100) });
      if (error) { for (const r of targets) r.read_at = null; state.notifUnread = prevUnread; loadNotifUnread(); rerender(); return; }
    }
  }
  async function markNotifRead(id) {
    const c = state.notifCenter;
    const row = c && c.rows.find((r) => r.id === id);
    if (!row || row.read_at) return;
    // Optimistic with rollback (COMM-141).
    row.read_at = new Date().toISOString();
    state.notifUnread = Math.max(0, (Number(state.notifUnread) || 0) - 1);
    rerender();
    const { error } = await client.rpc("notif_mark_read", { p_ids: [id] });
    if (error) {
      row.read_at = null;
      state.notifUnread = (Number(state.notifUnread) || 0) + 1;
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
    return { tab: "feed" };
  }
  async function openNotif(id) {
    const c = state.notifCenter;
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
    setCommunityTab(target.tab || "feed");
    if (target.post) {
      state.openComments[target.post] = true;
      if (target.comment) state.openReplies[target.comment] = true;
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
    } else {
      rerender();
    }
  }

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
    const openId = state.challengeView && state.challengeView.id;
    if (state._chalRtId && state._chalRtId !== openId) {
      for (const name of challengeRealtimeNames(state._chalRtId)) window.HaimuniaRealtime.unsubscribe(name);
      state._chalRtId = null;
    }
    if (!openId) return;
    const [progressName, participantsName] = challengeRealtimeNames(openId);
    // Re-arm after teardownAll() the same way the notification channel
    // does: the registry, not a local flag, is the source of truth for
    // whether a channel is actually open.
    if (state._chalRtId === openId && realtimeChannelOpen(progressName) && realtimeChannelOpen(participantsName)) return;
    window.HaimuniaRealtime.subscribe(progressName,
      { table: "challenge_progress", event: "INSERT", filter: "challenge_id=eq." + openId },
      function () { onChallengeRealtime(openId); });
    window.HaimuniaRealtime.subscribe(participantsName,
      { table: "challenge_participants", event: "UPDATE", filter: "challenge_id=eq." + openId },
      function () { onChallengeRealtime(openId); });
    state._chalRtId = openId;
  }
  function onChallengeRealtime(id) {
    realtimeDebounce("chal-" + id, function () {
      // The detail may have closed between the event and this timer.
      if (!state.challengeView || state.challengeView.id !== id) return;
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
  function ensureFeedRealtime() {
    if (!state.user || !client || !window.HaimuniaRealtime) return;
    if (state.communityTab !== "feed") return;
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
    if (!postId || !state.openComments[postId]) return;
    realtimeDebounce("comments-" + postId, function () {
      if (!state.openComments[postId] || !findFeedPost(postId)) return;
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
      if (state.reactions[postId]) loadReactionsFor(postId);
      else ensureReactionsLoaded(postId);
    });
  }

  // --- COMM-141 realtime own-row refresh ----------------------------
  function ensureNotifRealtime() {
    if (!state.user || !client || !window.HaimuniaRealtime) return;
    const name = "notif-" + state.user.id;
    const listed = typeof window.HaimuniaRealtime.list === "function"
      ? window.HaimuniaRealtime.list().some((ch) => ch.name === name) : false;
    if (state._notifRtUid === state.user.id && listed) return;
    window.HaimuniaRealtime.subscribe(name,
      { table: "notifications", event: "*", filter: "user_id=eq." + state.user.id },
      onNotifRealtime);
    state._notifRtUid = state.user.id;
  }
  function onNotifRealtime(payload) {
    const evt = payload && (payload.eventType || payload.type);
    const rec = payload && (payload.new || payload.record);
    if (evt === "INSERT" && rec) {
      if (!rec.read_at) state.notifUnread = (Number(state.notifUnread) || 0) + 1;
      const c = state.notifCenter;
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
    const title = safeText(r.title || def.title || "");
    const bodyHtml = r.body ? `<span style="display:block;color:var(--steel);font-size:12.5px;margin-top:2px;">${safeText(r.body)}</span>` : "";
    return `<button class="log-row" data-community-action="notif-open" data-id="${safeText(r.id)}" data-notif-mode="${safeText(def.mode || "immediate")}" style="width:100%;text-align:right;background:none;border:0;border-inline-start:3px solid ${emphasise ? "var(--energy)" : "transparent"};padding:8px 10px;cursor:pointer;display:flex;gap:10px;align-items:flex-start;">
      <span aria-hidden="true" style="font-size:18px;line-height:1.2;">${safeText(def.icon)}</span>
      <span style="flex:1;min-width:0;">
        <span style="display:block;font-weight:${emphasise ? "800" : "600"};font-size:13px;">${title}</span>
        ${bodyHtml}
        <span style="display:block;color:var(--steel);font-size:11px;margin-top:3px;">${safeText(relativeTime(r.created_at))}</span>
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
    return `<div class="notif-group" data-notif-group="${safeText(key)}" style="border-inline-start:3px solid ${emphasise ? "var(--energy)" : "transparent"};">
      <button class="link-btn" data-community-action="notif-toggle-group" data-key="${safeText(key)}" aria-expanded="${open ? "true" : "false"}" style="display:flex;gap:10px;align-items:center;width:100%;text-align:right;padding:8px 10px;">
        <span aria-hidden="true" style="font-size:18px;">${safeText(def.icon)}</span>
        <span style="flex:1;min-width:0;">
          <span style="display:block;font-weight:${emphasise ? "800" : "600"};font-size:13px;">${safeText(def.title)}${group.length > 1 ? " · " + group.length : ""}</span>
          <span style="display:block;color:var(--steel);font-size:11px;margin-top:3px;">${safeText(relativeTime(group[0].created_at))}</span>
        </span>
        <span aria-hidden="true">${open ? "▲" : "▼"}</span>
      </button>
      ${open ? `<div class="notif-group-body" style="padding-inline-start:8px;">${group.map(renderNotifRow).join("")}</div>` : ""}
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
    const c = state.notifCenter;
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

  // COMM-144. The Preferences panel, rendered in the Account tab.
  function renderNotifPrefsPanel() {
    const rowFor = (t) => {
      const stored = state.notifPrefs[t.key] || "in_app";
      const eff = (stored === "push" && !NOTIF_PUSH_ENABLED) ? "in_app" : stored;
      const saving = !!state.notifPrefSaving[t.key];
      const btn = (ch, label, disabled) =>
        `<button type="button" class="chip-btn${eff === ch ? " primary" : ""}" data-community-action="notif-pref" data-type="${t.key}" data-channel="${ch}"${(disabled || saving) ? " disabled" : ""}${disabled ? ' aria-disabled="true" title="בקרוב"' : ""}>${label}</button>`;
      return `<div class="log-row" style="flex-direction:column;align-items:stretch;gap:6px;">
        <span style="font-size:13px;">${safeText(t.label)}</span>
        <div class="chip-row" role="group" aria-label="${safeText(t.label)}" style="margin-top:0;">
          ${btn("push", "התראת דחיפה · בקרוב", true)}
          ${btn("in_app", "באפליקציה", false)}
          ${btn("off", "כבוי", false)}
        </div>
      </div>`;
    };
    const rows = state.notifPrefsLoaded
      ? NOTIF_PREF_TYPES.map(rowFor).join("")
      : `<div class="log-row" aria-hidden="true"><span style="height:12px;width:60%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`.repeat(4);
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--brass)", "העדפות התראות")}
      <div style="color:var(--steel);font-size:12px;line-height:1.6;margin-bottom:8px;">בחרו איך כל סוג התראה מגיע אליכם. התראות דחיפה יגיעו בגרסה הבאה. הודעות תפעוליות מהמועדון תמיד יופיעו כאן, גם אם כיביתם אותן.</div>
      <div class="log-list">${rows}</div>
    </div>`;
  }

  window.notifRoute = notifRoute;
  window.classifyNotification = classifyNotification;
  window.notifResolveTarget = resolveNotifTarget;

  // Composed cloud overlay: the confirm sheet plus every posts-cluster dialog,
  // rendered by app.js after every tab so a PR prompt or an open composer is
  // not tied to the Community tab being active.
  function renderConfirmDialog() {
    return renderConfirmSheet() + renderPostComposer() + renderPrSharePrompt() + renderAchievementUnlockCelebration() + renderCommunityProfileOverlay() + renderNotificationCenter()
      + renderReportSheet() + renderModActionSheet() + renderModContextOverlay() + renderChallengeViewOverlay() + renderEventViewOverlay();
  }
  // COMM-151. The report reason sheet. Reasons are a fixed list, an optional
  // capped free-text note, and a plain acknowledgement that discloses
  // nothing about what happens next.
  function renderReportSheet() {
    const s = state.reportSheet;
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
      <input type="radio" name="reportReason" data-report-reason="${r.id}"${s.reason === r.id ? " checked" : ""} aria-label="${safeText(r.label)}"/>
    </label>`).join("");
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="reportSheetTitle" data-cloud-dialog="reportSheet" style="align-items:center;padding:0 20px;">
      <div class="modal-sheet" style="border-radius:22px;max-height:none;">
        <div style="padding:24px 22px calc(env(safe-area-inset-bottom,0px) + 20px);">
          <div id="reportSheetTitle" style="color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:12px;">דיווח על ${s.targetType === "comment" ? "תגובה" : "פוסט"}</div>
          <div class="log-list">${reasons}</div>
          <label class="field" style="margin-top:12px;"><span class="field-label">פרטים נוספים (רשות)</span>
            <textarea class="text-input" data-report-note maxlength="500" placeholder="אפשר להוסיף הקשר">${safeText(s.note || "")}</textarea></label>
          ${s.error ? `<div class="footer-note" role="alert" style="color:var(--red);">${safeText(s.error)}</div>` : ""}
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
    const a = state.modAction;
    if (!a) return "";
    const def = MOD_DECISIONS.find((d) => d.id === a.decision) || { label: a.decision };
    const days = a.decision === "restrict_temp" ? `<label class="field" style="margin-top:10px;"><span class="field-label">משך ההגבלה</span>
      <div class="chip-row" style="margin:0;">${RESTRICT_TEMP_DAYS.map((d) => `<button class="chip-btn${a.days === d ? " primary" : ""}" data-community-action="mod-action-days" data-days="${d}">${d} ימים</button>`).join("")}</div></label>` : "";
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="modActionTitle" data-cloud-dialog="modAction" style="align-items:center;padding:0 20px;">
      <div class="modal-sheet" style="border-radius:22px;max-height:none;">
        <div style="padding:24px 22px calc(env(safe-area-inset-bottom,0px) + 20px);">
          <div id="modActionTitle" style="color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:8px;">${safeText(def.label)}</div>
          ${days}
          <label class="field" style="margin-top:10px;"><span class="field-label">הערה (רשות)</span>
            <textarea class="text-input" data-mod-note maxlength="500" placeholder="נרשמת ביומן">${safeText(a.note || "")}</textarea></label>
          ${a.error ? `<div class="footer-note" role="alert" style="color:var(--red);">${safeText(a.error)}</div>` : ""}
          <div class="chip-row" style="margin-top:12px;">
            <button class="chip-btn" data-community-action="mod-action-cancel">ביטול</button>
            <button class="chip-btn primary" data-community-action="mod-action-run"${a.saving ? " disabled" : ""} style="${def.destructive ? "background:var(--red);border-color:var(--red);color:#fff;" : ""}">${a.saving ? "מבצע…" : "אישור"}</button>
          </div>
        </div>
      </div>
    </div>`;
  }
  // COMM-152. "View context" opens the reported content in place. Light by
  // design: the excerpt the queue row already carries plus a shortcut into
  // the feed for a post.
  function renderModContextOverlay() {
    const c = state.modContext;
    if (!c) return "";
    return `<div class="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="modContextTitle" data-cloud-dialog="modContext" style="align-items:center;padding:0 20px;">
      <div class="modal-sheet" style="border-radius:22px;max-height:none;">
        <div style="padding:24px 22px calc(env(safe-area-inset-bottom,0px) + 20px);">
          <div id="modContextTitle" style="color:var(--chalk);font-weight:800;font-size:17px;margin-bottom:8px;">הקשר הדיווח</div>
          <div style="color:var(--steel);font-size:12.5px;">${safeText(c.target_type === "comment" ? "תגובה" : "פוסט")} מאת ${safeText(c.content_author_name || "חבר/ה שהוסר/ה")}</div>
          <div class="chart-card" style="margin-top:8px;white-space:pre-wrap;">${safeText(String(c.content_excerpt || "התוכן הוסר"))}</div>
          ${Array.isArray(c.reporters) && c.reporters.length ? `<div style="color:var(--steel);font-size:12px;margin-top:8px;">דווח ע״י: ${c.reporters.map((r) => safeText(r.name || r.id)).join(", ")}</div>` : ""}
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
    if (!state.user) {
      // Two real entry points, both visible at once: log into an existing
      // account (any device, same identity), or start fresh with a club
      // invite code. Nothing happens silently here — the old
      // ensureAnonymousSession()-on-load only fires once "start-signup"
      // is actually chosen, below.
      if (!state.signupStarted) return `<div class="chart-card"><div style="font-weight:800;font-size:18px;margin-bottom:6px;">כניסה לקהילה</div><div style="color:var(--steel);font-size:12.5px;line-height:1.7;margin-bottom:14px;">התחברות עם שם המשתמש והסיסמה משחזרת את הפרופיל, העוקבים, הסנכרון הפרטי והרשאות הצוות — גם ממכשיר חדש או אחרי מחיקת נתונים.</div><form id="communityLogin">${field("communityLogin", "username", "שם משתמש", `<input class="text-input" name="username" dir="ltr" autocapitalize="off" autocomplete="username" placeholder="שם משתמש" required/>`)}${field("communityLogin", "password", "סיסמה", `<input class="text-input" name="password" type="password" dir="ltr" autocomplete="current-password" placeholder="סיסמה" required/>`)}<button class="save-btn" type="submit" style="margin-top:12px;">התחברות ושחזור החשבון</button></form><button class="link-btn" data-community-action="start-signup" style="display:block;margin:18px auto 0;">חבר/ה חדש/ה? התחלת הרשמה עם קוד הזמנה</button>${state.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${safeText(state.message)}</div>` : ""}</div>`;
      ensureAnonymousSession();
      return `<div class="chart-card"><div style="font-weight:800;font-size:18px;margin-bottom:6px;">מתחברים לקהילה…</div><div style="color:var(--steel);font-size:13px;">שנייה אחת.</div>${state.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${safeText(state.message)}</div>` : ""}</div>`;
    }
    if (!state.redemption) return `<div class="chart-card"><div style="font-weight:800;font-size:18px;margin-bottom:6px;">קוד הזמנה למועדון</div><div style="color:var(--steel);font-size:13px;margin-bottom:14px;">הקהילה פתוחה רק למי שקיבל/ה קוד הזמנה מהמאמן/ת. הקוד לא נוגע לרישום האימונים עצמו — הוא רק פותח את לשונית הקהילה.</div><form id="communityInviteCode">${field("communityInviteCode", "code", "קוד הזמנה", `<input class="text-input" name="code" dir="ltr" placeholder="קוד הזמנה" required/>`)}<button class="save-btn" type="submit" style="margin-top:12px;">אישור קוד</button></form>${state.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${safeText(state.message)}</div>` : ""}</div>`;
    // Right after the code, before anything else — this is what turns the
    // bootstrap anonymous session into a real, log-in-from-any-device
    // account. state.user.is_anonymous flips to false the moment
    // setCredentials() succeeds, so a returning user (who logged in with
    // real credentials to begin with) never sees this screen at all.
    if (state.user.is_anonymous) return `<div class="chart-card"><div style="font-weight:800;font-size:18px;margin-bottom:6px;">יצירת חשבון</div><div style="color:var(--steel);font-size:13px;margin-bottom:14px;">שם משתמש וסיסמה — כדי שתוכלו להתחבר שוב מכל מכשיר.</div><form id="communityCredentials">${field("communityCredentials", "username", "שם משתמש", `<input class="text-input" name="username" dir="ltr" autocapitalize="off" autocomplete="username" placeholder="אותיות אנגליות, ספרות או קו תחתון" required/>`)}${field("communityCredentials", "password", "סיסמה", `<input class="text-input" name="password" type="password" dir="ltr" autocomplete="new-password" placeholder="לפחות 8 תווים" required/>`)}${field("communityCredentials", "passwordConfirm", "אימות סיסמה", `<input class="text-input" name="passwordConfirm" type="password" dir="ltr" autocomplete="new-password" placeholder="הקלידו שוב" required/>`)}<button class="save-btn" type="submit" style="margin-top:12px;">יצירת חשבון</button></form>${state.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${safeText(state.message)}</div>` : ""}</div>`;
    // Without this gate, a fresh code-redeemer landed straight on the Feed
    // sub-tab — mostly empty, nothing prompting them to the profile form
    // buried in Account — with no clear signal anything had actually been
    // saved. Now profile creation is unskippable, same pattern as the
    // gates above it: this screen is all there is until a profile exists,
    // and the whole screen changing to the real tabbed UI afterward is the
    // confirmation, not just a toast that's easy to miss.
    if (!state.profile) return `<div class="chart-card"><div style="font-weight:800;font-size:18px;margin-bottom:6px;">השלמת פרופיל</div><div style="color:var(--steel);font-size:13px;margin-bottom:14px;">כמעט סיימתם — עוד רגע אחד ותהיו בפנים.</div><form id="communityProfile">${field("communityProfile", "handle", "שם משתמש (handle)", `<input class="text-input" name="handle" dir="auto" placeholder="למשל דנה_כהן" required/>`)}<label class="field"><span class="field-label">שם תצוגה</span><input class="text-input" name="displayName" placeholder="שם תצוגה"/></label><label class="field"><span class="field-label">קצת עליי</span><textarea class="text-input" name="bio" maxlength="160" placeholder="כמה מילים עליי"></textarea></label><button class="save-btn" type="submit" style="margin-top:12px;">שמירת פרופיל</button></form>${state.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${safeText(state.message)}</div>` : ""}</div>`;
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
        ${state.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${safeText(state.message)}</div>` : ""}</div>`;
    }
    const p = state.profile || {};
    const staff = isStaff();

    // ---- Feed tab: announcements (+ today's pinned note), the social
    // feed with comments, sharing, comparisons ----
    const pinnedToday = state.announcements.find((a) => a.pinned_date === todayIso());
    const pinnedHtml = pinnedToday ? `<div class="chart-card admin-card" style="margin-bottom:12px;"><div style="font-weight:800;margin-bottom:6px;">📌 הערת האימון להיום</div><div style="font-weight:700;">${safeText(pinnedToday.title)}</div><div style="color:var(--steel);font-size:13px;margin-top:4px;">${safeText(pinnedToday.body)}</div></div>` : "";
    const announceComposer = staff ? `<form id="communityAnnouncement" class="chart-card admin-card" style="margin-top:10px;"><div style="font-weight:800;margin-bottom:10px;">הודעה חדשה למועדון<span class="admin-tag">ניהול</span></div>${field("communityAnnouncement", "title", "כותרת", `<input class="text-input" name="title" placeholder="כותרת" required/>`)}${field("communityAnnouncement", "body", "תוכן", `<textarea class="text-input" name="body" maxlength="2000" placeholder="תוכן ההודעה" required></textarea>`)}<label class="field flex gap-6" style="align-items:center;"><input type="checkbox" name="pinToday"/><span style="font-size:12.5px;color:var(--steel);">סמן כהערת האימון להיום</span></label><button class="chip-btn primary" type="submit" style="margin-top:10px;">פרסום הודעה</button></form>` : "";
    const otherAnnouncements = state.announcements.filter((a) => a !== pinnedToday);
    // COMM-155. A staff holder of community.content.pin gets a pin toggle on
    // each announcement. Post, challenge and event pin affordances live on
    // their own surfaces (posts and Phase 2 clusters); the strip and unpin
    // control render for every one of the four target types.
    const canPinContent = hasPerm(PERM.CONTENT_PIN);
    const isPinned = (type, id) => state.pins.some((p) => p.target_type === type && p.target_id === id);
    const announcementsList = otherAnnouncements.length ? `<div class="log-list">${otherAnnouncements.map((a) => `<div class="log-row" style="align-items:flex-start;flex-direction:column;gap:4px;"><div style="font-weight:700;">${safeText(a.title)}</div><div style="color:var(--steel);font-size:13px;">${safeText(a.body)}</div><div style="color:var(--steel);font-size:11px;">${safeText(a.profiles ? (a.profiles.display_name || "@" + a.profiles.handle) : "")}</div>${canPinContent ? `<button class="link-btn" data-community-action="${isPinned("announcement", a.id) ? "unpin" : "pin"}" data-type="announcement" data-id="${safeText(a.id)}" data-note="${safeText(a.title)}" style="margin:2px 0 0;">${isPinned("announcement", a.id) ? "ביטול הצמדה" : "הצמדה למעלה"}</button>` : ""}</div>`).join("")}</div>` : (pinnedToday ? "" : `<div class="empty">אין הודעות חדשות</div>`);
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
    // which is why this whole block is behind `state.club`.
    const club = state.club || null;
    const clubMark = club && club.image_url
      ? `<img src="${safeText(club.image_url)}" alt="" style="width:44px;height:44px;border-radius:14px;object-fit:cover;"/>`
      : avatarHtml((club && club.name) || "המועדון", 44);
    const activeChallenge = club && club.active_challenge ? club.active_challenge : null;
    // COMM-141. notif_unread_count() drives the badge; club_summary's
    // count is only a first-paint fallback until that RPC resolves.
    const unread = state.notifUnreadLoaded
      ? Number(state.notifUnread) || 0
      : Number((club && club.unread_notifications) || 0);
    // COMM-140. The bell opens the notification centre.
    const bellHtml = `<button class="chip-btn" data-community-action="feed-notifications" aria-label="התראות${unread ? `, ${unread} חדשות` : ""}" aria-haspopup="dialog" style="position:relative;">🔔${unread ? `<span class="tab-badge" aria-hidden="true">${unread}</span>` : ""}</button>`;
    const clubTopHtml = club ? `<div class="chart-card" id="communityClubTop" style="margin-bottom:12px;">
      <div class="flex" style="justify-content:space-between;align-items:center;gap:10px;">
        <div class="flex gap-10" style="align-items:center;min-width:0;">
          ${clubMark}
          <div style="min-width:0;">
            <div style="font-weight:800;font-size:16px;">${safeText(club.name || "המועדון")}</div>
            <div style="color:var(--steel);font-size:12px;">${Number(club.member_count || 0)} חברי מועדון</div>
          </div>
        </div>
        ${bellHtml}
      </div>
      ${activeChallenge ? `<div class="chip-row" style="margin-top:10px;"><button class="chip-btn primary" data-community-action="open-active-challenge" data-id="${safeText(activeChallenge.id || "")}">🏆 ${safeText(activeChallenge.title || "אתגר פעיל")}</button></div>` : ""}
    </div>` : "";
    // COMM-217: the soonest published, non-cancelled upcoming event, or
    // nothing at all - never an empty placeholder.
    const upcomingEventHtml = renderUpcomingEventCard();

    // COMM-111 filter chips. My Classes is rendered disabled, tied to
    // COMM-P01, and setFeedScope refuses it on the way in as well.
    const filterHtml = `<div class="chip-row" id="communityFeedFilters" role="tablist" aria-label="סינון הפיד" style="margin:0 0 10px;">${FEED_SCOPES.map((s) => s.parked
      ? `<button class="chip-btn" data-community-action="feed-scope" data-scope="${s.id}" disabled aria-disabled="true" title="בקרוב, ממתין למודול הנוכחות">${safeText(s.label)} · בקרוב</button>`
      : `<button class="chip-btn${state.feedScope === s.id ? " primary" : ""}" data-community-action="feed-scope" data-scope="${s.id}" role="tab" aria-selected="${state.feedScope === s.id ? "true" : "false"}">${safeText(s.label)}</button>`).join("")}</div>`;

    const feed = state.feedLoading && !state.feed.length
      ? `<div class="log-list" aria-busy="true">${renderPostCardSkeleton().repeat(3)}</div>`
      : state.feedError && !state.feed.length
      ? `<div class="empty">לא ניתן לטעון את פיד המועדון.<div class="chip-row" style="justify-content:center;"><button class="chip-btn primary" data-community-action="feed-retry">ניסיון חוזר</button></div></div>`
      : state.feed.length ? `<div class="log-list" id="communityFeedList">${state.feed.map((post) => post && post.post_type ? renderPostCard(post) : `<article class="chart-card post-card">
      <div class="post-head">${avatarHtml(post.display_name || post.handle)}<div class="post-head-text"><div class="post-author">${safeText(post.display_name || "@" + post.handle)}</div><div class="post-time">${relativeTime(post.published_at)}</div></div></div>
      <div class="post-title">${safeText(post.title)}</div>
      <div class="mono post-result">${safeText(post.result_text)}</div>
      ${post.photo_path && photoUrlCache[post.photo_path] ? `<img src="${photoUrlCache[post.photo_path]}" alt="" class="post-photo"/>` : ""}
      <div class="chip-row post-actions">
        <button class="chip-btn" data-community-action="cheer" data-id="${safeText(post.id)}" aria-label="עידוד, ${Number(post.cheer_count || 0)} עידודים">🔥 ${Number(post.cheer_count || 0)}</button>
        <button class="chip-btn" data-community-action="toggle-comments" data-id="${safeText(post.id)}" aria-label="תגובות, ${Number(post.comment_count || 0)}">💬 ${Number(post.comment_count || 0)}</button>
        ${post.comparison_key ? `<button class="chip-btn${state.comparisonForPostId === post.id ? " primary" : ""}" data-community-action="compare" data-key="${safeText(post.comparison_key)}" data-id="${safeText(post.id)}">השוואה</button>` : ""}
        ${post.author_id === (state.user && state.user.id) ? `<button class="chip-btn" data-community-action="delete-post" data-id="${safeText(post.id)}">הסרה</button>` : `<button class="chip-btn" data-community-action="report" data-id="${safeText(post.id)}">דיווח</button>`}
      </div>
      ${state.comparisonForPostId === post.id ? `<div class="log-list" style="margin-top:10px;">${state.comparison.length ? state.comparison.map((item, index) => `<div class="log-row"><span>${index + 1}. ${safeText(item.display_name || "@" + item.handle)}</span><span class="mono" style="color:var(--brass);">${safeText(item.result_text)}</span></div>`).join("") : `<div class="empty">אין עדיין תוצאות להשוואה</div>`}</div>` : ""}
      ${renderComments(post)}</article>`).join("")}</div>` : `<div class="empty">${safeText(feedScopeDef(state.feedScope).empty || "פעילות המועדון תופיע כאן.")}</div>`;
    // COMM-113. The sentinel is what IntersectionObserver watches; the
    // button under it is the same call for keyboard and for anywhere the
    // observer is unavailable. Reaching the end is a quiet marker, never an
    // error.
    const feedMoreHtml = !state.feed.length ? ""
      : state.feedEnd ? `<div class="footer-note" style="text-align:center;margin-top:10px;">הגעתם לסוף. הכול מעודכן.</div>`
      : `<div id="communityFeedSentinel" style="height:1px;"></div>
        ${state.feedMoreError ? `<div class="footer-note" role="alert" style="text-align:center;color:var(--red);">לא ניתן היה לטעון עוד.</div>` : ""}
        <div class="chip-row" style="justify-content:center;margin-top:8px;"><button class="chip-btn" data-community-action="feed-load-more"${state.feedLoadingMore ? " disabled" : ""}>${state.feedLoadingMore ? "טוען…" : state.feedMoreError ? "ניסיון חוזר" : "טעינת עוד"}</button></div>`;
    const composeBtn = `<button class="chip-btn primary" data-community-action="open-composer" style="margin:0 0 10px;">כתיבת פוסט</button>`;
    const feedHtml = `<div class="ach-section">${sectionHead("var(--blue)", "הפיד שלי")}${composeBtn}${filterHtml}${feed}${upcomingEventHtml}${feedMoreHtml}</div>`;

    // COMM-155. The pinned strip sits above everything else on the Club home.
    const feedTab = renderPinnedStrip() + clubTopHtml + announcementsHtml + feedHtml;

    // ---- Boards tab: weekly challenge + streaks, top-3-plus-your-rank ----
    const challengeSetter = staff ? `<form id="communityWeeklyChallenge" class="chart-card admin-card" style="margin-top:10px;"><div style="font-weight:800;margin-bottom:10px;">קביעת אתגר שבועי<span class="admin-tag">ניהול</span></div>${field("communityWeeklyChallenge", "title", "שם האתגר", `<input class="text-input" name="title" placeholder="שם האתגר" required/>`)}${field("communityWeeklyChallenge", "comparisonKey", "מפתח השוואה", `<input class="text-input" name="comparisonKey" dir="ltr" placeholder="movement:back-squat:est1rm" required/>`)}<div style="color:var(--steel);font-size:11px;margin:-6px 0 10px;">חייב להתחיל ב-movement: (תרגיל) או wod: (אימון) — בדיוק כמו שהוא נשמר בשיתופים, למשל movement:back-squat:est1rm או wod:fran:time:rx</div><div class="flex gap-10 field">${field("communityWeeklyChallenge", "startsOn", "תאריך התחלה", `<input class="text-input" name="startsOn" type="date" required/>`)}${field("communityWeeklyChallenge", "endsOn", "תאריך סיום", `<input class="text-input" name="endsOn" type="date" required/>`)}</div><button class="chip-btn primary" type="submit" style="margin-top:10px;">קביעת אתגר</button></form>` : "";
    const weeklyLeaderboardList = state.weeklyChallenge ? renderRankedList(state.weeklyLeaderboard, (it) => it.author_id, (it) => safeText(it.result_text)) : `<div class="empty">אין אתגר פעיל כרגע</div>`;
    // COMM-018. A quick "hide my result" affordance right on the board.
    // It flips in_leaderboards, the same column the Privacy panel toggles;
    // full removal from the ranked views is enforced server-side once the
    // leaderboard views filter on the column (see report notes).
    const hideMyResult = state.profile && state.profile.in_leaderboards
      ? `<button class="link-btn" data-community-action="hide-my-leaderboard-result" style="display:block;margin:8px auto 0;">הסתרת התוצאה שלי מהטבלאות</button>`
      : (state.profile ? `<div class="footer-note" style="margin:8px 0 0;">התוצאה שלך מוסתרת מהטבלאות. אפשר להחזיר אותה בהגדרות הפרטיות.</div>` : "");
    const weeklyChallengeHtml = `<div class="ach-section">${sectionHead("var(--teal)", state.weeklyChallenge ? `אתגר השבוע: ${safeText(state.weeklyChallenge.title)}` : "אתגר השבוע")}${weeklyLeaderboardList}${hideMyResult}${challengeSetter}</div>`;

    const streaksHtml = state.streaks.length ? `<div class="ach-section">${sectionHead("var(--purple)", "רצפי התמדה")}${renderRankedList(state.streaks, (it) => it.user_id, (it) => `🔥 ${Number(it.current_streak)}`)}</div>` : "";

    const boardsTab = renderChallengesListSection() + renderEventsListSection() + weeklyChallengeHtml + streaksHtml;

    // ---- Account tab: profile, member search, admin member management ----
    const account = `<form id="communityProfile" class="chart-card"><div style="font-weight:800;font-size:16px;margin-bottom:12px;">הפרופיל שלי</div>
      ${field("communityProfile", "handle", "שם משתמש (handle)", `<input class="text-input" name="handle" dir="auto" value="${safeText(p.handle || "")}" placeholder="למשל דנה_כהן" required/>`)}
      <label class="field"><span class="field-label">שם תצוגה</span><input class="text-input" name="displayName" value="${safeText(p.display_name || "")}" placeholder="שם תצוגה"/></label>
      <label class="field"><span class="field-label">קצת עליי</span><textarea class="text-input" name="bio" maxlength="160" placeholder="כמה מילים עליי">${safeText(p.bio || "")}</textarea></label>
      <div class="chip-row"><button class="chip-btn primary" type="submit">שמירת פרופיל</button><button class="chip-btn" type="button" data-community-action="migrate">סנכרון היסטוריה פרטית</button></div>
    </form>`;

    // COMM-018 Privacy panel. Values render straight off state.profile;
    // each toggle change is persisted by savePrivacyField() as a direct
    // own-row RLS upsert (listener wired in afterRenderCommunity). The
    // skeleton branch is a formality - the gates above guarantee a loaded
    // profile before this tab renders.
    const privacyRows = state.profile
      ? PRIVACY_FIELDS.map((f) => `<label class="log-row" style="justify-content:space-between;gap:12px;cursor:pointer;"><span style="font-size:13px;">${f.label}</span><input type="checkbox" data-privacy-field="${f.key}"${state.profile[f.key] ? " checked" : ""} aria-label="${safeText(f.label)}"/></label>`).join("")
      : `<div class="log-row" aria-hidden="true"><span style="height:12px;width:62%;background:var(--border);border-radius:6px;display:inline-block;"></span></div>`.repeat(4);
    const privacyPanel = `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--blue)", "פרטיות")}
      <div style="color:var(--steel);font-size:12px;line-height:1.6;margin-bottom:8px;">כל שינוי נשמר מיד ונאכף בשרת. הגדרות הנוכחות והרישום לשיעור ייכנסו לתוקף כשמודול הנוכחות יעלה.</div>
      <div class="log-list">${privacyRows}</div>
    </div>`;

    // COMM-228. One box, three labeled groups (members, events, challenges).
    const people = renderCommunitySearch();

    const newMembersHtml = staff ? `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--green)", "מתאמנים חדשים", true)}${state.newMembers.length ? `<div class="log-list">${state.newMembers.map((m) => `<div class="log-row"><span>${safeText(m.display_name || "@" + m.handle)}</span><span style="color:var(--steel);font-size:12px;">${safeText(m.first_activity_on)}</span></div>`).join("")}</div>` : `<div class="empty">אין מתאמנים חדשים לאחרונה</div>`}</div>` : "";
    const inactiveHtml = staff ? `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--red)", "מי לא התאמן לאחרונה", true)}${state.inactiveMembers.length ? `<div class="log-list">${state.inactiveMembers.map((m) => `<div class="log-row"><span>${safeText(m.display_name || "@" + m.handle)}</span><span style="color:var(--steel);font-size:12px;">${m.last_activity_on ? safeText(m.last_activity_on) : "מעולם לא"}</span></div>`).join("")}</div>` : `<div class="empty">כולם פעילים</div>`}</div>` : "";

    const accountTab = account + privacyPanel + people + newMembersHtml + inactiveHtml + renderModeration() + renderMemberManagement() + renderAuditLog() + renderMyAchievements() + renderNotifPrefsPanel()
      + `<button class="link-btn" data-community-action="sign-out" style="display:block;margin:20px auto 0;">התנתקות</button>`
      + `<button class="link-btn" data-community-action="delete-account" style="display:block;margin:10px auto 8px;color:var(--red);">בקשת מחיקת חשבון</button>`;

    // COMM-152. The badge counts open queue items for a holder of the
    // moderation permission (or a real admin), not the legacy reports list.
    const pendingReports = (hasPerm(PERM.COMMENT_MODERATE) || isAdmin())
      ? state.modQueue.filter((r) => r.status === "open").length : 0;
    const tabs = [
      { id: "feed", label: "פיד", html: feedTab },
      { id: "boards", label: "לוחות", html: boardsTab },
      { id: "account", label: "חשבון", html: accountTab, badge: pendingReports },
    ];
    const activeTab = tabs.find((t) => t.id === state.communityTab) || tabs[0];
    const tabBar = `<div class="subtabbar">${tabs.map((t) => `<button class="subtabbtn${t.id === activeTab.id ? " active" : ""}" data-community-action="set-tab" data-tab="${t.id}">${t.label}${t.badge ? `<span class="tab-badge" aria-label="${t.badge} דיווחים ממתינים">${t.badge}</span>` : ""}</button>`).join("")}</div>`;

    return tabBar
      + (state.message ? `<div class="footer-note" role="status" style="color:var(--brass);margin-bottom:14px;">${safeText(state.message)}</div>` : "")
      + activeTab.html;
  };
  // Sharing (see renderShareControl) can now be triggered from the
  // Calendar and Progress tabs, not just the Community tab, so the
  // confirm dialog can no longer live only inside renderCommunityApp()'s
  // own output - it has to render regardless of which top-level tab is
  // active. app.js's own render() appends this unconditionally after
  // every tab's content (see index.html/app.js render()).
  window.renderCloudConfirmDialog = renderConfirmDialog;
  window.cloudStorageStatusText = function () {
    if (!configured) return "נשמר במכשיר הזה בלבד, ללא שרת";
    if (!state.user) return "נשמר במכשיר; התחברו כדי לסנכרן באופן פרטי";
    return state.syncEnabled ? "נשמר במכשיר ומסונכרן באופן פרטי לחשבון" : "נשמר במכשיר; סנכרון ענן ממתין לאישורכם";
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
  const CLOUD_DIALOGS = [
    { key: "reportSheet", close: function () { closeReportSheet(); } },
    { key: "modAction", close: function () { closeModAction(); } },
    { key: "modContext", close: function () { closeModContext(); } },
    { key: "notifCenter", close: function () { closeNotifCenter(); } },
    { key: "achUnlock", close: function () { dismissAchievementUnlock(); } },
    { key: "prPrompt", close: function () { dismissPrPrompt(); } },
    { key: "composer", close: function () { tryCloseComposer(); } },
    { key: "profileView", close: function () { closeCommunityProfile(); } },
    { key: "challengeView", close: function () { closeChallengeView(); } },
    { key: "eventView", close: function () { closeEventView(); } },
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
      const k = CLOUD_DIALOGS[i].key;
      if (state[k] && cloudDialogEl(k)) return k;
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
    // COMM-154. The audit view is lazy: fetched the first time an analytics
    // holder lands on the Account tab, not on every session.
    if (state.communityTab === "account" && hasPerm(PERM.ANALYTICS_VIEW) && !state.auditLoaded && !state.auditLoading) loadAuditLog(true);
    // COMM-018. Each privacy toggle persists on change, no save button.
    document.querySelectorAll("[data-privacy-field]").forEach((el) => {
      el.addEventListener("change", () => savePrivacyField(el.dataset.privacyField, el.checked));
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
    else if (action === "block") askConfirm({ title: "חסימת משתמש", message: "לחסום את המשתמש? לא תראו זה את זה בקהילה.", confirmLabel: "חסימה", destructive: true, action: "block", payload: { userId: el.dataset.id } });
    else if (action === "delete-post") askConfirm({ title: "הסרת שיתוף", message: "להסיר את השיתוף מהפיד? הפעולה לא ניתנת לביטול.", confirmLabel: "הסרה", destructive: true, action: "delete-post", payload: { postId: el.dataset.id } });
    else if (action === "compare") compare(el.dataset.key, el.dataset.id);
    else if (action === "delete-account") askConfirm({ title: "מחיקת חשבון", message: "הפרופיל והשיתופים יוסרו מיד. המחיקה הסופית תתבצע לאחר 30 יום. להמשיך?", confirmLabel: "מחיקה", destructive: true, action: "delete-account" });
    else if (action === "share-achievement") publishAchievement(el.dataset.id, el.dataset.title, el.dataset.rule);
    else if (action === "toggle-comments") toggleComments(el.dataset.id);
    else if (action === "delete-comment") askConfirm({ title: "מחיקת תגובה", message: "למחוק את התגובה? הפעולה לא ניתנת לביטול.", confirmLabel: "מחיקה", destructive: true, action: "delete-comment", payload: { commentId: el.dataset.id, postId: el.dataset.post } });
    else if (action === "comment-reply") { const p = el.dataset.post; state.replyTo[p] = state.replyTo[p] === el.dataset.id ? null : el.dataset.id; if (state.replyTo[p]) state.openReplies[el.dataset.id] = true; rerender(); }
    else if (action === "toggle-replies") { const id = el.dataset.id; if (state.openReplies[id]) delete state.openReplies[id]; else state.openReplies[id] = true; rerender(); }
    else if (action === "comment-edit") startCommentEdit(el.dataset.id, el.dataset.post);
    else if (action === "comment-edit-save") saveCommentEdit();
    else if (action === "comment-edit-cancel") cancelCommentEdit();
    else if (action === "comment-retry") retryComment(el.dataset.post, el.dataset.parent || null);
    else if (action === "report-comment") reportComment(el.dataset.id);
    else if (action === "mention-pick") mentionPick(el.dataset.key, el.dataset.id, el.dataset.name);
    else if (action === "set-tab") setCommunityTab(el.dataset.tab);
    else if (action === "verify-recovery") verifyRecovery({ force: true });
    else if (action === "hide-my-leaderboard-result") savePrivacyField("in_leaderboards", false);
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
    else if (action === "mod-action-days") { if (state.modAction) { state.modAction.days = Number(el.dataset.days) || 7; rerender(); } }
    // COMM-154 audit view.
    else if (action === "audit-filter") setAuditFilter("action_type", el.dataset.type || "");
    else if (action === "audit-more") loadAuditLog(false);
    else if (action === "audit-retry") loadAuditLog(true);
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
    else if (action === "caption-cancel") { state.captionEdit = null; rerender(); }
    else if (action === "caption-save") postSaveCaption();
    else if (action === "post-change-visibility") postStartVisibilityEdit(el.dataset.id);
    else if (action === "visibility-pick") postApplyVisibility(el.dataset.value);
    else if (action === "visibility-cancel") { state.visibilityEdit = null; rerender(); }
    else if (action === "post-delete") askConfirm({ title: "מחיקת פוסט", message: "הפוסט יוסר מהפיד. הפעולה אינה ניתנת לביטול מיידי.", confirmLabel: "מחיקה", destructive: true, action: "post-delete-rpc", payload: { postId: el.dataset.id } });
    else if (action === "welcome-member") welcomeNewMember(el.dataset.id);
    else if (action === "view-profile") viewCommunityProfile(el.dataset.id);
    else if (action === "close-profile") closeCommunityProfile();
    else if (action === "profile-tab") setProfileViewTab(el.dataset.tab);
    else if (action === "pr-share") sharePrPrompt();
    else if (action === "pr-not-now") dismissPrPrompt();
    else if (action === "pr-add-note") { if (state.prPrompt) { state.prPrompt.showNote = true; rerender(); } }
    else if (action === "ach-share") shareAchievementUnlock();
    else if (action === "ach-not-now") dismissAchievementUnlock();
    else if (action === "ach-add-note") { if (state.achUnlock) { state.achUnlock.showNote = true; rerender(); } }
    else if (action === "ach-share-later") shareEarnedAchievement(el.dataset.id, el.dataset.code);
    else if (action === "feed-scope") setFeedScope(el.dataset.scope);
    else if (action === "feed-load-more") loadMoreFeed();
    else if (action === "feed-retry") { state.feedPagesLoaded = 0; loadFeed().then(rerender); rerender(); }
    // COMM-140..142 notification centre.
    else if (action === "feed-notifications") openNotifCenter();
    else if (action === "notif-close") closeNotifCenter();
    else if (action === "notif-retry") fetchNotifPage(true);
    else if (action === "notif-load-more") loadMoreNotifs();
    else if (action === "notif-show-older") notifShowOlder();
    else if (action === "notif-mark-all") markAllNotifsRead();
    else if (action === "notif-open") openNotif(el.dataset.id);
    else if (action === "notif-toggle-group") { const c = state.notifCenter; if (c) { c.expanded[el.dataset.key] = !c.expanded[el.dataset.key]; rerender(); } }
    else if (action === "notif-pref") setNotifPref(el.dataset.type, el.dataset.channel);
    // COMM-201/207. The club-top shortcut opens the real challenge detail
    // when club_summary handed back an id; a missing id (an older/failed
    // club_summary read) still lands the member on the Boards sub-tab
    // rather than a broken dialog.
    else if (action === "open-active-challenge") { if (el.dataset.id) openChallenge(el.dataset.id, "club_top"); else setCommunityTab("boards"); }
    // COMM-201/207. openChallenge() itself records CHALLENGE_VIEWED (source
    // defaults to "boards"), so the POST_CHALLENGE link card's own tap
    // passes "post_card" through.
    // COMM-228. A search result carries data-source="search" so the same
    // action records where the member came from; anything without one is
    // the POST_CHALLENGE link card it was written for.
    else if (action === "open-challenge") { if (el.dataset.id) openChallenge(el.dataset.id, el.dataset.source || "post_card"); }
    else if (action === "close-challenge-view") closeChallengeView();
    else if (action === "join-challenge") joinChallenge(el.dataset.id, "boards");
    else if (action === "leave-challenge") confirmLeaveChallenge(el.dataset.id);
    else if (action === "challenge-pick-team") pickChallengeTeam(el.dataset.id, el.dataset.team);
    else if (action === "challenge-log-submit") submitChallengeLog();
    else if (action === "challenge-log-week-hit") logConsistencyWeekHit();
    else if (action === "challenge-coach-submit") submitCoachEntry(el.dataset.id);
    else if (action === "share-challenge-progress") shareChallengeProgress();
    else if (action === "challenges-retry") loadChallenges();
    else if (action === "open-challenge-form") openChallengeForm(null);
    else if (action === "challenge-edit") { const existing = state.challenges.find((x) => x.id === el.dataset.id) || (state.challengeView && state.challengeView.challenge); openChallengeForm(existing); }
    else if (action === "challenge-form-cancel") closeChallengeForm();
    else if (action === "challenge-form-type") setChallengeFormType(el.dataset.type);
    else if (action === "challenge-publish") publishChallengeDraft(el.dataset.id);
    else if (action === "challenge-archive") archiveChallenge(el.dataset.id);
    else if (action === "challenge-delete") askConfirm({ title: "מחיקת טיוטה", message: "למחוק את הטיוטה? הפעולה אינה ניתנת לביטול.", confirmLabel: "מחיקה", destructive: true, action: "challenge-delete-draft", payload: { challengeId: el.dataset.id } });
    // COMM-213/217/228. openEvent() itself records EVENT_VIEWED (source
    // defaults to "post_card"), the same pattern openChallenge() uses -
    // this used to only track and never actually open anything (the gap
    // the realtime+search cluster's handoff notes flagged for COMM-228's
    // search result), now closed by COMM-213's detail dialog existing.
    else if (action === "open-event") { if (el.dataset.id) openEvent(el.dataset.id, el.dataset.source || "post_card"); }
    else if (action === "close-event-view") closeEventView();
    else if (action === "event-rsvp") rsvpEvent(el.dataset.id, el.dataset.response);
    else if (action === "events-retry") loadEvents();
    else if (action === "open-event-form") openEventForm(null);
    else if (action === "event-edit") { const existing = state.eventsById[el.dataset.id] || (state.eventView && state.eventView.event); openEventForm(existing); }
    else if (action === "event-form-cancel") closeEventForm();
    else if (action === "event-form-type") setEventFormType(el.dataset.type);
    else if (action === "event-publish") publishEventDraft(el.dataset.id);
    else if (action === "event-cancel-confirm") confirmCancelEvent(el.dataset.id);
    else if (action === "event-ics") downloadEventIcs(el.dataset.id);
  };
  window.isCommunitySignedIn = function () { return !!(state.user && state.profile); };
  window.shareAchievementToCommunity = function (achievementId, title, rule) { publishAchievement(achievementId, title, rule); };
  document.addEventListener("submit", (event) => {
    if (event.target.id === "communityProfile") { event.preventDefault(); saveProfile(event.target); }
    else if (event.target.id === "communityAnnouncement") { event.preventDefault(); postAnnouncement(event.target); }
    else if (event.target.id === "communityWeeklyChallenge") { event.preventDefault(); setWeeklyChallenge(event.target); }
    else if (event.target.id === "communityChallengeForm") { event.preventDefault(); submitChallengeForm(event.target); }
    else if (event.target.id === "communityEventForm") { event.preventDefault(); submitEventForm(event.target); }
    else if (event.target.id === "communityInviteCode") { event.preventDefault(); redeemCode(event.target); }
    else if (event.target.id === "communityLogin") { event.preventDefault(); login(event.target); }
    else if (event.target.id === "communityCredentials") { event.preventDefault(); setCredentials(event.target); }
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
  window.addEventListener("haimunia-sync-needed", () => { flushOutbox(); pingActivity(); });
  if (client) {
    client.auth.onAuthStateChange((_event, session) => {
      state.user = session ? session.user : null;
      if (state.user) {
        // COMM-170. Same reason as refreshSession: configure before the
        // first track(). Idempotent, so whichever path arrives first wins.
        ensureAnalyticsConfigured();
        loadRedemption()
          .then(() => Promise.all([loadProfile(), loadPermissions(), loadFeed(), loadStreaks(), loadAnnouncements(), loadWeeklyChallenge(), loadClubSummary(), loadBlockedIds(), loadMyAchievements(), loadNotifUnread(), loadNotifPrefs(), loadPins(), loadEvents(), flushOutbox()]))
          .then(() => (isStaff() ? Promise.all([loadInactiveMembers(), loadNewMembers()]) : null))
          .then(() => (isAdmin() || hasPerm(PERM.COMMENT_MODERATE) ? loadModQueue() : null))
          .then(pullPrivateRecords)
          .then(pingActivity)
          .then(() => { if (typeof window.syncCommunityMilestones === "function") window.syncCommunityMilestones(); })
          .then(ensureNotifRealtime)
          .then(rerender);
      } else {
        // COMM-114. Whatever the signed-out member had seen is written
        // before the session id is dropped, not discarded with it.
        flushFeedImpressions();
        // COMM-170. The next session starts its own club_tab_viewed.
        resetClubTabView();
        // COMM-209 / COMM-227. Sign-out closes every open channel, the
        // other half of the teardown contract src/realtime.js documents.
        // Until this cluster there was nothing live to close; now the
        // own-row notification channel and the feed's shared channels
        // would otherwise outlive the session that opened them.
        if (window.HaimuniaRealtime) window.HaimuniaRealtime.teardownAll();
        clearRealtimeDebounces();
        state.feedScope = "for_you"; state.feedCursor = null; state.feedEnd = false; state.feedPagesLoaded = 0;
        state.feedSessionId = null; state.feedSeen = {}; state.feedPending = []; state.club = null;
        state.feedLoading = false; state.feedError = false; state.feedLoadingMore = false; state.feedMoreError = false;
        state.profile = null; state.feed = []; state.streaks = []; state.announcements = []; state.weeklyChallenge = null; state.weeklyLeaderboard = []; state.inactiveMembers = []; state.newMembers = []; state.redemption = null; state.reports = []; state.fieldErrors = {}; state.confirmDialog = null; state.signupStarted = false; state.memberSearch = ""; state.memberResults = []; state.openShare = {}; state.comparisonForPostId = null; state.comparison = []; state.composer = null; state.composerTrigger = null; state.openPostMenu = null; state.savedPostIds = {}; state.captionEdit = null; state.visibilityEdit = null; state.prPrompt = null; state.profileView = null; state.myAchievements = []; state.achUnlock = null; state.comments = {}; state.openComments = {}; state.commentDrafts = {}; state.commentErrors = {}; state.commentSending = null; state.commentEdit = null; state.openReplies = {}; state.replyTo = {}; state.memberRoles = {}; state.reactions = {}; state.reactionError = null; state.blockedIds = []; state.blocksLoaded = false; state.mentionPicker = null; state.notifCenter = null; state.notifUnread = 0; state.notifPrefs = {}; state.notifPrefsLoaded = false; state.notifPrefSaving = {}; state._notifRtUid = null; state.permissions = []; state.permissionsLoaded = false; state.modQueue = []; state.modQueueLoaded = false; state.modQueueStatus = "open"; state.modQueueLoading = false; state.modQueueError = false; state.modAction = null; state.modContext = null; state.reportSheet = null; state.pins = []; state.pinsLoaded = false; state.pinError = ""; state.auditLog = []; state.auditCursor = null; state.auditLoaded = false; state.auditLoading = false; state.auditError = false; state.auditEnd = false; state.auditFilters = {}; state.challenges = []; state.challengesLoaded = false; state.challengesLoading = false; state.challengesError = false; state.challengeParticipation = {}; state.challengeAggregates = {}; state.challengeView = null; state.challengeForm = null; state._chalRtId = null; state.searchEvents = []; state.searchChallenges = []; state.searchQuery = ""; state.searchLoading = false; state._consistencyWeekLogged = {}; state._consistencySessionCounts = {}; state.events = []; state.eventsById = {}; state.eventsLoaded = false; state.eventsLoading = false; state.eventsError = false; state.eventAttendees = {}; state.eventView = null; state.eventForm = null;
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
    else if ("commentEditInput" in t.dataset && state.commentEdit) state.commentEdit.body = t.value;
    else if ("composerAlt" in t.dataset) composerSetAlt(t.dataset.composerAlt, t.value);
    else if ("captionEdit" in t.dataset && state.captionEdit) state.captionEdit.body = t.value;
    else if ("prNote" in t.dataset && state.prPrompt) state.prPrompt.note = t.value;
    else if ("prAlt" in t.dataset && state.prPrompt && state.prPrompt.photo) state.prPrompt.photo.altText = t.value;
    else if ("achNote" in t.dataset && state.achUnlock) state.achUnlock.note = t.value;
    // COMM-151 / COMM-153. Free-text notes on the report and moderation
    // sheets. Kept in state, not read off the DOM at submit, so a rerender
    // never drops what was typed.
    else if ("reportNote" in t.dataset && state.reportSheet) state.reportSheet.note = t.value;
    else if ("modNote" in t.dataset && state.modAction) state.modAction.note = t.value;
    // COMM-202..206. The manual progress form and the coach entry roster,
    // both inside the challenge detail dialog. Kept in state, not read off
    // the DOM at submit, same reasoning as every other note/body field
    // above: a rerender (a progress refresh, a sibling row's own submit)
    // never drops what was already typed here.
    else if ("challengeLogDelta" in t.dataset && state.challengeView) state.challengeView.logForm.delta = t.value;
    else if ("challengeLogNote" in t.dataset && state.challengeView) state.challengeView.logForm.note = t.value;
    else if ("challengeCoachDelta" in t.dataset && state.challengeView) {
      const uid = t.dataset.challengeCoachDelta;
      const d = state.challengeView.coachEntry.drafts[uid] || (state.challengeView.coachEntry.drafts[uid] = { delta: "", note: "" });
      d.delta = t.value;
    }
    else if ("challengeCoachNote" in t.dataset && state.challengeView) {
      const uid = t.dataset.challengeCoachNote;
      const d = state.challengeView.coachEntry.drafts[uid] || (state.challengeView.coachEntry.drafts[uid] = { delta: "", note: "" });
      d.note = t.value;
    }
  });
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (!t || !t.dataset) return;
    if ("composerFile" in t.dataset) { const f = t.files && t.files[0]; if (f) composerAddPhoto(f); try { t.value = ""; } catch (err) {} }
    else if ("composerDecorative" in t.dataset) composerToggleDecorative(t.dataset.composerDecorative, t.checked);
    else if ("composerVisibility" in t.dataset) composerSetVisibility(t.value);
    else if ("prFile" in t.dataset) { const f = t.files && t.files[0]; if (f) prPromptAddPhoto(f); }
    // COMM-151. The report reason radio.
    else if ("reportReason" in t.dataset && t.checked) setReportReason(t.dataset.reportReason);
  });
  document.addEventListener("keydown", (e) => {
    // COMM-123. Mention picker keyboard navigation while a comment input has
    // focus and its picker is open.
    if (state.mentionPicker) {
      const t = e.target;
      if (t && t.dataset && "commentInput" in t.dataset && t.dataset.commentKey === state.mentionPicker.key) {
        const items = state.mentionPicker.results || [];
        if (e.key === "ArrowDown") { e.preventDefault(); state.mentionPicker.index = Math.min(Math.max(items.length - 1, 0), (state.mentionPicker.index || 0) + 1); rerender(); restoreCommentFocus(state.mentionPicker.key, t.selectionStart); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); state.mentionPicker.index = Math.max(0, (state.mentionPicker.index || 0) - 1); rerender(); restoreCommentFocus(state.mentionPicker.key, t.selectionStart); return; }
        if (e.key === "Enter" && items.length) { e.preventDefault(); const m = items[state.mentionPicker.index || 0]; mentionPick(state.mentionPicker.key, m.id, m.display_name || m.handle); return; }
        if (e.key === "Escape") { e.preventDefault(); const k = state.mentionPicker.key; state.mentionPicker = null; rerender(); restoreCommentFocus(k, t.selectionStart); return; }
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
    if (state.reportSheet) { e.preventDefault(); closeReportSheet(); return; }
    if (state.modAction) { e.preventDefault(); closeModAction(); return; }
    if (state.modContext) { e.preventDefault(); closeModContext(); return; }
    if (state.notifCenter) { e.preventDefault(); closeNotifCenter(); return; }
    if (state.achUnlock) { e.preventDefault(); dismissAchievementUnlock(); return; }
    if (state.prPrompt) { e.preventDefault(); dismissPrPrompt(); return; }
    if (state.composer) { e.preventDefault(); tryCloseComposer(); return; }
    if (state.profileView) { e.preventDefault(); closeCommunityProfile(); return; }
    if (state.challengeView) { e.preventDefault(); closeChallengeView(); return; }
    if (state.eventView) { e.preventDefault(); closeEventView(); return; }
    if (state.openPostMenu) { state.openPostMenu = null; rerender(); }
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
})();
