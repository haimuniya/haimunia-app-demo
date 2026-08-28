(function () {
  "use strict";
  const cfg = window.HAIMUNIA_CONFIG || {};
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(cfg.supabaseUrl || "") && !!cfg.supabasePublishableKey;
  const client = configured && window.supabase ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  }) : null;
  const state = { configured, client, user: null, profile: null, feed: [], people: [], comparison: [], comparisonForPostId: null, loading: false, message: "", syncEnabled: localStorage.getItem("haimunia-demo:cloudSyncEnabled") === "1",
    streaks: [], announcements: [], weeklyChallenge: null, weeklyLeaderboard: [], inactiveMembers: [], newMembers: [], redemption: null,
    communityTab: "feed", comments: {}, openComments: {}, fieldErrors: {}, reports: [], confirmDialog: null, signupStarted: false, memberSearch: "", memberResults: [], openShare: {} };
  const photoUrlCache = {};

  function safeText(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  // Coach and admin are both "staff" for the fixed set of powers every
  // coach gets (announcements, the weekly challenge, the new/inactive
  // member views) — matches public.is_staff() server-side, which is what
  // actually enforces this; this is only for deciding what to show.
  function isStaff() { return !!(state.profile && (state.profile.is_admin || (state.redemption && state.redemption.role === "coach"))); }
  // Narrower than isStaff() on purpose — review_report() and the RLS
  // bypass that lets a moderator see reported posts both check real
  // is_admin only, not a coach-code role, so the review queue must match.
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
      await loadRedemption();
      await Promise.all([loadProfile(), loadFeed(), loadStreaks(), loadAnnouncements(), loadWeeklyChallenge()]);
      if (isStaff()) await Promise.all([loadInactiveMembers(), loadNewMembers()]);
      if (isAdmin()) await loadReports();
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
  // Admin-only (see isAdmin()) — matches review_report()'s own
  // is_admin-only check and the posts_select_admin_review RLS policy that
  // lets this embed actually resolve the reported post's content.
  async function loadReports() {
    if (!state.user || !isAdmin()) return;
    const { data, error } = await client.from("reports")
      .select("id,reason,details,status,created_at,reviewed_at,resolution_notes,post_id,reporter_id,profiles!reports_reporter_id_fkey(handle,display_name),workout_posts(title,result_text,photo_path,profiles(handle,display_name))")
      .order("created_at", { ascending: false }).limit(100);
    state.reports = error ? [] : (data || []);
  }
  async function reviewReport(reportId, status) {
    if (!state.user || !isAdmin()) return;
    const { error } = await client.rpc("review_report", { p_report_id: reportId, p_status: status });
    if (error) return setMessage("עדכון הדיווח נכשל");
    await loadReports();
    setMessage("הדיווח עודכן");
    rerender();
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
  async function adminGrantCoach(userId) {
    if (!state.user || !isAdmin()) return;
    const { error } = await client.rpc("admin_grant_coach", { p_user_id: userId });
    if (error) return setMessage("הענקת ההרשאה נכשלה");
    setMessage("הרשאת מאמן/ת הוענקה");
    await searchMembers(state.memberSearch);
  }
  async function adminRevokeCoach(userId) {
    if (!state.user || !isAdmin()) return;
    const { error } = await client.rpc("admin_revoke_coach", { p_user_id: userId });
    if (error) return setMessage("ביטול ההרשאה נכשל");
    setMessage("הרשאת מאמן/ת בוטלה");
    await searchMembers(state.memberSearch);
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
  async function loadFeed() {
    if (!state.user) return;
    state.loading = true;
    const { data, error } = await client.from("community_feed").select("*").order("published_at", { ascending: false }).limit(50);
    state.feed = error ? [] : (data || []);
    state.message = error ? "לא ניתן לטעון את הקהילה כרגע" : "";
    state.loading = false;
    for (const post of state.feed) if (post.photo_path) resolvePhotoUrl(post.photo_path);
  }
  async function loadCommentsFor(postId) {
    const { data, error } = await client.from("post_comments").select("id,body,created_at,author_id,profiles(handle,display_name)").eq("post_id", postId).order("created_at", { ascending: true }).limit(200);
    state.comments[postId] = error ? [] : (data || []);
    rerender();
  }
  function toggleComments(postId) {
    if (state.openComments[postId]) { delete state.openComments[postId]; rerender(); return; }
    state.openComments[postId] = true;
    if (!state.comments[postId]) loadCommentsFor(postId); else rerender();
  }
  async function addComment(postId, form) {
    if (!state.user) return;
    const body = String(form.elements.body.value || "").trim();
    if (!body) return;
    const { error } = await client.rpc("add_post_comment", { p_post_id: postId, p_body: body });
    if (error) return setMessage(error.message === "rate_limited" ? "יותר מדי תגובות, נסו שוב בעוד כמה דקות" : "שליחת התגובה נכשלה");
    form.reset();
    await loadCommentsFor(postId);
    await loadFeed();
  }
  async function deleteComment(commentId, postId) {
    if (!state.user) return;
    await client.from("post_comments").delete().eq("id", commentId).eq("author_id", state.user.id);
    await loadCommentsFor(postId);
    await loadFeed();
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
  async function react(postId) {
    if (!state.user) return;
    // toggle_reaction() does the insert-or-delete atomically server-side
    // now, rate-limited - the old insert-then-delete-on-conflict here
    // used to leave a small race between the failed insert and the
    // follow-up delete.
    const { error } = await client.rpc("toggle_reaction", { p_post_id: postId });
    if (error && error.message === "rate_limited") setMessage("יותר מדי לחיצות, נסו שוב בעוד כמה דקות");
    await loadFeed(); rerender();
  }
  async function report(postId) {
    if (!state.user) return;
    const { error } = await client.rpc("submit_report", { p_post_id: postId });
    if (error && error.message === "rate_limited") return setMessage("יותר מדי דיווחים, נסו שוב בעוד כמה דקות");
    setMessage("הדיווח נשלח לבדיקה והתוכן הוסתר עבורך"); await loadFeed();
  }
  async function searchPeople(query) {
    if (!state.user) return;
    const q = String(query || "").trim().replace(/[%_,()]/g, "");
    if (q.length < 2) { state.people = []; return rerender(); }
    // allow_follows comes back so the follow button can be hidden for a
    // member who turned follows off. The server still rejects the insert
    // (follows_insert_self checks the same column plus block edges), this
    // is only so the button does not lie.
    const { data, error } = await client.from("profiles").select("id,handle,display_name,bio,avatar_url,allow_follows").or(`handle.ilike.%${q}%,display_name.ilike.%${q}%`).neq("id", state.user.id).limit(20);
    state.people = error ? [] : (data || []); rerender();
  }
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
    await loadFeed(); setMessage(error && error.code !== "23505" ? "עדכון המעקב נכשל" : "המעקב עודכן");
  }
  async function block(userId) {
    if (!state.user) return;
    await client.from("blocks").upsert({ blocker_id: state.user.id, blocked_id: userId });
    await client.from("follows").delete().eq("follower_id", state.user.id).eq("followed_id", userId);
    state.people = state.people.filter((person) => person.id !== userId); await loadFeed(); setMessage("המשתמש נחסם");
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
  // than in each feature. Phase 0 has no open subscriptions, so this is
  // a no-op today - it is in place first so a Phase 2 feature cannot
  // ship a leak by forgetting its own teardown.
  function setCommunityTab(tab) {
    if (window.HaimuniaRealtime && state.communityTab !== tab) window.HaimuniaRealtime.teardownAll();
    state.communityTab = tab;
    rerender();
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
    else if (c.action === "admin-remove-member") adminRemoveMember(c.payload.userId);
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
  function renderConfirmDialog() {
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
  function renderComments(post) {
    const open = !!state.openComments[post.id];
    if (!open) return "";
    const list = (state.comments[post.id] || []).map((c) => {
      const name = c.profiles ? (c.profiles.display_name || "@" + c.profiles.handle) : "";
      return `<div class="comment-row">${avatarHtml(name, 24)}<div style="flex:1;min-width:0;"><div style="font-size:12.5px;"><b>${safeText(name)}</b> ${safeText(c.body)}</div><div class="flex gap-10" style="margin-top:2px;"><span style="color:var(--steel);font-size:11px;">${relativeTime(c.created_at)}</span>${c.author_id === (state.user && state.user.id) ? `<button class="link-btn" data-community-action="delete-comment" data-id="${safeText(c.id)}" data-post="${safeText(post.id)}" aria-label="מחיקת תגובה">מחיקה</button>` : ""}</div></div></div>`;
    }).join("") || `<div class="empty" style="padding:6px 0;">אין תגובות עדיין</div>`;
    return `<div style="margin-top:10px;"><div class="log-list">${list}</div><form data-comment-post-id="${safeText(post.id)}" class="flex gap-6" style="margin-top:8px;"><input class="text-input" name="body" maxlength="280" placeholder="הוספת תגובה" aria-label="הוספת תגובה"/><button class="chip-btn primary" type="submit">שליחה</button></form></div>`;
  }
  function reasonLabel(reason) { return { spam: "ספאם", harassment: "הטרדה", privacy: "פרטיות", inappropriate: "תוכן לא הולם", other: "אחר" }[reason] || reason; }
  function reportStatusLabel(status) { return { open: "פתוח", reviewing: "בטיפול", resolved: "טופל", dismissed: "נדחה" }[status] || status; }
  function renderModeration() {
    if (!isAdmin()) return "";
    const open = state.reports.filter((r) => r.status === "open" || r.status === "reviewing");
    const closed = state.reports.filter((r) => r.status === "resolved" || r.status === "dismissed");
    const rowHtml = (r) => {
      const post = r.workout_posts;
      const authorName = post && post.profiles ? (post.profiles.display_name || "@" + post.profiles.handle) : "";
      const reporterName = r.profiles ? (r.profiles.display_name || "@" + r.profiles.handle) : "משתמש";
      const active = r.status === "open" || r.status === "reviewing";
      return `<div class="chart-card" style="margin-bottom:10px;">
        <div class="flex" style="justify-content:space-between;align-items:flex-start;gap:10px;">
          <div style="min-width:0;">
            <div style="font-weight:800;">${post ? safeText(post.title) : "הפוסט הוסר"}</div>
            ${post ? `<div style="color:var(--steel);font-size:12.5px;margin-top:2px;">מאת ${safeText(authorName)}</div><div class="mono" style="color:var(--brass);margin-top:4px;">${safeText(post.result_text)}</div>` : ""}
          </div>
          <span class="admin-tag" style="${r.status === "open" ? "background:rgba(194,57,44,.12);border-color:var(--red);color:var(--red);" : ""}">${reportStatusLabel(r.status)}</span>
        </div>
        <div style="color:var(--steel);font-size:12.5px;margin-top:8px;">דווח ע״י ${safeText(reporterName)} · ${reasonLabel(r.reason)}${r.details ? ` — ${safeText(r.details)}` : ""} · ${relativeTime(r.created_at)}</div>
        ${active ? `<div class="chip-row" style="margin-top:10px;">${r.status === "open" ? `<button class="chip-btn" data-community-action="review-report" data-id="${safeText(r.id)}" data-status="reviewing">סימון כבטיפול</button>` : ""}<button class="chip-btn primary" data-community-action="review-report" data-id="${safeText(r.id)}" data-status="resolved">סימון כטופל</button><button class="chip-btn" data-community-action="review-report" data-id="${safeText(r.id)}" data-status="dismissed">דחיית הדיווח</button></div>`
          : `<div style="color:var(--steel);font-size:11px;margin-top:8px;">${r.resolution_notes ? safeText(r.resolution_notes) + " · " : ""}טופל ${relativeTime(r.reviewed_at)}</div>`}
      </div>`;
    };
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--red)", "דיווחים לבדיקה", true)}${state.reports.length ? "" : `<div class="empty">אין דיווחים ממתינים</div>`}${open.map(rowHtml).join("")}${closed.length ? `<details style="margin-top:10px;"><summary class="link-btn" style="cursor:pointer;display:inline-block;">היסטוריית דיווחים שטופלו (${closed.length})</summary><div style="margin-top:8px;">${closed.map(rowHtml).join("")}</div></details>` : ""}</div>`;
  }
  function memberRoleLabel(m) { return m.is_admin ? "מנהל/ת" : m.role === "coach" ? "מאמן/ת" : m.role === "member" ? "חבר/ה" : "לא הצטרפ/ה עדיין"; }
  function renderMemberManagement() {
    if (!isAdmin()) return "";
    const results = state.memberResults;
    const rowHtml = (m) => `<div class="log-row" style="align-items:flex-start;flex-direction:column;gap:6px;">
      <div class="flex gap-10" style="align-items:center;">${avatarHtml(m.display_name || m.handle, 32)}<div><div style="font-weight:700;">${safeText(m.display_name || "@" + m.handle)}</div><div style="color:var(--steel);font-size:11px;">@${safeText(m.handle)} · ${memberRoleLabel(m)}</div></div></div>
      <div style="color:var(--steel);font-size:11px;">הצטרפ/ה: ${m.redeemed_at ? safeText(String(m.redeemed_at).slice(0, 10)) : "—"} · פעילות אחרונה: ${m.last_activity_on ? safeText(m.last_activity_on) : "מעולם לא"}</div>
      <div class="footer-note" style="margin:0;font-size:10.5px;">${safeText(m.id)}</div>
      ${m.is_admin ? "" : `<div class="chip-row" style="margin-top:0;">
        ${m.role === "coach"
          ? `<button class="chip-btn" data-community-action="admin-revoke-coach" data-id="${safeText(m.id)}">ביטול הרשאת מאמן/ת</button>`
          : `<button class="chip-btn" data-community-action="admin-grant-coach" data-id="${safeText(m.id)}">הענקת הרשאת מאמן/ת</button>`}
        <button class="chip-btn" data-community-action="admin-remove-member" data-id="${safeText(m.id)}" style="color:var(--red);">הסרת חבר/ה</button>
      </div>`}
    </div>`;
    return `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--purple)", "ניהול חברים", true)}
      <div class="search-box"><input id="adminMemberSearch" placeholder="חיפוש לפי handle, שם, או הדבקת מזהה משתמש" aria-label="חיפוש חברים לניהול" value="${safeText(state.memberSearch)}"/></div>
      ${results.length ? `<div class="log-list">${results.map(rowHtml).join("")}</div>` : state.memberSearch.trim().length >= 2 ? `<div class="empty">לא נמצאו חברים תואמים</div>` : `<div class="empty">חיפוש לפי handle, שם, או מזהה משתמש (UUID)</div>`}
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
    const announcementsList = otherAnnouncements.length ? `<div class="log-list">${otherAnnouncements.map((a) => `<div class="log-row" style="align-items:flex-start;flex-direction:column;gap:4px;"><div style="font-weight:700;">${safeText(a.title)}</div><div style="color:var(--steel);font-size:13px;">${safeText(a.body)}</div><div style="color:var(--steel);font-size:11px;">${safeText(a.profiles ? (a.profiles.display_name || "@" + a.profiles.handle) : "")}</div></div>`).join("")}</div>` : (pinnedToday ? "" : `<div class="empty">אין הודעות חדשות</div>`);
    const announcementsHtml = `<div class="ach-section">${sectionHead("var(--brass)", "הודעות מהמועדון")}${pinnedHtml}${announcementsList}${announceComposer}</div>`;

    // Sharing itself no longer lives here - it was a standing list of the
    // 8 most recent shareable results eating vertical space at the top of
    // the feed you open to see *other* people's posts. It's now
    // triggered from wherever a specific result actually lives (Calendar,
    // Progress) via renderShareControl(), collapsed to a single icon
    // until tapped.

    const feed = state.feed.length ? `<div class="log-list">${state.feed.map((post) => `<article class="chart-card post-card">
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
      ${renderComments(post)}</article>`).join("")}</div>` : `<div class="empty">עדיין אין שיתופים בפיד</div>`;
    const feedHtml = `<div class="ach-section">${sectionHead("var(--blue)", "הפיד שלי")}${feed}</div>`;

    const feedTab = announcementsHtml + feedHtml;

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

    const boardsTab = weeklyChallengeHtml + streaksHtml;

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

    const people = `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--steel)", "מציאת מתאמנים")}<div class="search-box"><input id="communityPeopleSearch" placeholder="חיפוש לפי שם או @handle" aria-label="חיפוש מתאמנים" /></div>${state.people.length ? `<div class="log-list">${state.people.map((person) => `<div class="log-row"><div class="flex gap-10" style="align-items:center;">${avatarHtml(person.display_name || person.handle, 32)}<div><div style="font-weight:700;">${safeText(person.display_name || "@" + person.handle)}</div><div style="color:var(--steel);font-size:12px;">@${safeText(person.handle)} ${safeText(person.bio || "")}</div></div></div><div class="chip-row" style="margin-top:0;">${person.allow_follows === false ? "" : `<button class="chip-btn" data-community-action="follow" data-id="${safeText(person.id)}">מעקב</button>`}<button class="chip-btn" data-community-action="block" data-id="${safeText(person.id)}">חסימה</button></div></div>`).join("")}</div>` : ""}</div>`;

    const newMembersHtml = staff ? `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--green)", "מתאמנים חדשים", true)}${state.newMembers.length ? `<div class="log-list">${state.newMembers.map((m) => `<div class="log-row"><span>${safeText(m.display_name || "@" + m.handle)}</span><span style="color:var(--steel);font-size:12px;">${safeText(m.first_activity_on)}</span></div>`).join("")}</div>` : `<div class="empty">אין מתאמנים חדשים לאחרונה</div>`}</div>` : "";
    const inactiveHtml = staff ? `<div class="ach-section" style="margin-top:18px;">${sectionHead("var(--red)", "מי לא התאמן לאחרונה", true)}${state.inactiveMembers.length ? `<div class="log-list">${state.inactiveMembers.map((m) => `<div class="log-row"><span>${safeText(m.display_name || "@" + m.handle)}</span><span style="color:var(--steel);font-size:12px;">${m.last_activity_on ? safeText(m.last_activity_on) : "מעולם לא"}</span></div>`).join("")}</div>` : `<div class="empty">כולם פעילים</div>`}</div>` : "";

    const accountTab = account + privacyPanel + people + newMembersHtml + inactiveHtml + renderModeration() + renderMemberManagement()
      + `<button class="link-btn" data-community-action="sign-out" style="display:block;margin:20px auto 0;">התנתקות</button>`
      + `<button class="link-btn" data-community-action="delete-account" style="display:block;margin:10px auto 8px;color:var(--red);">בקשת מחיקת חשבון</button>`;

    const pendingReports = isAdmin() ? state.reports.filter((r) => r.status === "open").length : 0;
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
  window.afterRenderCommunity = function () {
    const input = document.getElementById("communityPeopleSearch");
    if (input) input.addEventListener("input", () => searchPeople(input.value));
    const adminInput = document.getElementById("adminMemberSearch");
    if (adminInput) adminInput.addEventListener("input", () => searchMembers(adminInput.value));
    // COMM-018. Each privacy toggle persists on change, no save button.
    document.querySelectorAll("[data-privacy-field]").forEach((el) => {
      el.addEventListener("change", () => savePrivacyField(el.dataset.privacyField, el.checked));
    });
  };
  window.handleCommunityClick = function (el) {
    const action = el.dataset.communityAction;
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
    else if (action === "delete-comment") deleteComment(el.dataset.id, el.dataset.post);
    else if (action === "set-tab") setCommunityTab(el.dataset.tab);
    else if (action === "verify-recovery") verifyRecovery({ force: true });
    else if (action === "hide-my-leaderboard-result") savePrivacyField("in_leaderboards", false);
    else if (action === "review-report") reviewReport(el.dataset.id, el.dataset.status);
    else if (action === "confirm-yes") runConfirm();
    else if (action === "confirm-no") closeConfirm();
    else if (action === "start-signup") startSignup();
    else if (action === "sign-out") client.auth.signOut();
    else if (action === "admin-grant-coach") askConfirm({ title: "הענקת הרשאת מאמן/ת", message: "להעניק הרשאת מאמן/ת למשתמש/ת זה/ו?", confirmLabel: "הענקה", action: "admin-grant-coach", payload: { userId: el.dataset.id } });
    else if (action === "admin-revoke-coach") adminRevokeCoach(el.dataset.id);
    else if (action === "admin-remove-member") askConfirm({ title: "הסרת חבר/ה", message: "הפרופיל והשיתופים של המשתמש/ת יוסרו מיד. המחיקה הסופית תתבצע לאחר 30 יום. להמשיך?", confirmLabel: "הסרה", destructive: true, action: "admin-remove-member", payload: { userId: el.dataset.id } });
    else if (action === "toggle-share") toggleShare(el.dataset.type, el.dataset.id);
  };
  window.isCommunitySignedIn = function () { return !!(state.user && state.profile); };
  window.shareAchievementToCommunity = function (achievementId, title, rule) { publishAchievement(achievementId, title, rule); };
  document.addEventListener("submit", (event) => {
    if (event.target.id === "communityProfile") { event.preventDefault(); saveProfile(event.target); }
    else if (event.target.id === "communityAnnouncement") { event.preventDefault(); postAnnouncement(event.target); }
    else if (event.target.id === "communityWeeklyChallenge") { event.preventDefault(); setWeeklyChallenge(event.target); }
    else if (event.target.id === "communityInviteCode") { event.preventDefault(); redeemCode(event.target); }
    else if (event.target.id === "communityLogin") { event.preventDefault(); login(event.target); }
    else if (event.target.id === "communityCredentials") { event.preventDefault(); setCredentials(event.target); }
    else if (event.target.dataset && event.target.dataset.commentPostId) { event.preventDefault(); addComment(event.target.dataset.commentPostId, event.target); }
  });
  window.addEventListener("online", flushOutbox);
  window.addEventListener("haimunia-sync-needed", () => { flushOutbox(); pingActivity(); });
  if (client) {
    client.auth.onAuthStateChange((_event, session) => {
      state.user = session ? session.user : null;
      if (state.user) {
        loadRedemption()
          .then(() => Promise.all([loadProfile(), loadFeed(), loadStreaks(), loadAnnouncements(), loadWeeklyChallenge(), flushOutbox()]))
          .then(() => (isStaff() ? Promise.all([loadInactiveMembers(), loadNewMembers()]) : null))
          .then(() => (isAdmin() ? loadReports() : null))
          .then(pullPrivateRecords)
          .then(pingActivity)
          .then(rerender);
      } else {
        state.profile = null; state.feed = []; state.streaks = []; state.announcements = []; state.weeklyChallenge = null; state.weeklyLeaderboard = []; state.inactiveMembers = []; state.newMembers = []; state.redemption = null; state.reports = []; state.fieldErrors = {}; state.confirmDialog = null; state.signupStarted = false; state.memberSearch = ""; state.memberResults = []; state.openShare = {}; state.comparisonForPostId = null; state.comparison = [];
        anonSignInAttempted = false;
        recoveryVerifyAttempted = false;
        rerender();
      }
    });
    refreshSession();
  }
})();
