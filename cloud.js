(function () {
  "use strict";
  const cfg = window.HAIMUNIA_CONFIG || {};
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(cfg.supabaseUrl || "") && !!cfg.supabasePublishableKey;
  const client = configured && window.supabase ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  }) : null;
  const state = { configured, client, user: null, profile: null, feed: [], people: [], comparison: [], loading: false, message: "", syncEnabled: localStorage.getItem("haimunia-demo:cloudSyncEnabled") === "1",
    streaks: [], announcements: [], weeklyChallenge: null, weeklyLeaderboard: [], inactiveMembers: [], redemption: null };

  function safeText(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function rerender() { if (typeof window.render === "function") window.render(); }
  function setMessage(message) { state.message = message || ""; rerender(); }

  async function refreshSession() {
    if (!client) return;
    const { data } = await client.auth.getSession();
    state.user = data.session ? data.session.user : null;
    if (state.user) {
      await loadRedemption();
      await Promise.all([loadProfile(), loadFeed(), loadStreaks(), loadAnnouncements(), loadWeeklyChallenge()]);
      if (state.profile && state.profile.is_admin) await loadInactiveMembers();
      await pullPrivateRecords();
      await pingActivity();
    }
    rerender();
  }
  async function loadProfile() {
    if (!state.user) return;
    const { data } = await client.from("profiles").select("id,handle,display_name,bio,avatar_url,is_admin").eq("id", state.user.id).maybeSingle();
    state.profile = data || null;
  }
  // A profile can only be created once a valid box invite code has been
  // redeemed (enforced server-side by profiles_insert_self's RLS check,
  // not just here) — this just drives which form the Community tab shows.
  async function loadRedemption() {
    if (!state.user) return;
    const { data } = await client.from("invite_redemptions").select("code,role,redeemed_at").eq("user_id", state.user.id).maybeSingle();
    state.redemption = data || null;
  }
  async function redeemCode(form) {
    if (!state.user) return;
    const code = String(form.code.value || "").trim();
    if (!code) return setMessage("יש להזין קוד הזמנה");
    const { data, error } = await client.rpc("redeem_invite_code", { p_code: code });
    if (error) return setMessage("קוד ההזמנה שגוי או לא פעיל");
    await loadRedemption();
    setMessage(data === "coach" ? "קוד מאמן אושר, אפשר להשלים פרופיל" : "קוד אושר, אפשר להשלים פרופיל");
    rerender();
  }
  // One row per user per day they had the app open — the raw dates stay
  // private (activity_pings RLS is self-only); this only ever records
  // today, so a missed day just isn't there rather than being backfilled.
  async function pingActivity() {
    if (!client || !state.user) return;
    const today = new Date().toISOString().slice(0, 10);
    await client.from("activity_pings").upsert({ user_id: state.user.id, activity_date: today }, { onConflict: "user_id,activity_date", ignoreDuplicates: true }).catch(() => {});
  }
  async function loadStreaks() {
    if (!state.user) return;
    const { data, error } = await client.from("community_streaks").select("user_id,handle,display_name,current_streak,last_activity_on").order("current_streak", { ascending: false }).limit(20);
    state.streaks = error ? [] : (data || []).filter((r) => r.current_streak > 0);
  }
  async function loadAnnouncements() {
    if (!state.user) return;
    const { data, error } = await client.from("announcements").select("id,title,body,created_at,profiles(handle,display_name)").order("created_at", { ascending: false }).limit(20);
    state.announcements = error ? [] : (data || []);
  }
  async function postAnnouncement(form) {
    if (!state.user || !state.profile || !state.profile.is_admin) return;
    const title = String(form.title.value || "").trim().slice(0, 120);
    const body = String(form.body.value || "").trim().slice(0, 2000);
    if (!title || !body) return setMessage("יש למלא כותרת ותוכן להודעה");
    const { error } = await client.from("announcements").insert({ author_id: state.user.id, title, body });
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
    if (!state.user || !state.profile || !state.profile.is_admin) return;
    const title = String(form.title.value || "").trim().slice(0, 120);
    const comparisonKey = String(form.comparisonKey.value || "").trim().slice(0, 160);
    const startsOn = form.startsOn.value, endsOn = form.endsOn.value;
    if (!title || !comparisonKey || !startsOn || !endsOn) return setMessage("יש למלא את כל שדות האתגר");
    const { error } = await client.from("weekly_challenges").insert({ title, comparison_key: comparisonKey, starts_on: startsOn, ends_on: endsOn, created_by: state.user.id });
    if (error) return setMessage("קביעת האתגר נכשלה");
    form.reset(); await loadWeeklyChallenge(); setMessage("האתגר השבועי עודכן"); rerender();
  }
  async function loadInactiveMembers() {
    if (!state.user || !state.profile || !state.profile.is_admin) return;
    const { data, error } = await client.rpc("coach_inactive_members");
    state.inactiveMembers = error ? [] : (data || []);
  }
  async function publishAchievement(achievementId, title, rule) {
    if (!state.user || !state.profile) return setMessage("התחברו לקהילה כדי לשתף עיטור");
    const payload = { author_id: state.user.id, source_type: "achievement", source_record_id: achievementId, visibility: "followers", title: String(title || "עיטור חדש").slice(0, 120), result_text: String(rule || "עיטור חדש נפתח").slice(0, 240), occurred_on: new Date().toISOString().slice(0, 10) };
    const { error } = await client.from("workout_posts").upsert(payload, { onConflict: "author_id,source_type,source_record_id" });
    if (error) return setMessage("שיתוף העיטור נכשל");
    await loadFeed(); setMessage("העיטור שותף לעוקבים שלכם"); rerender();
  }
  async function loadFeed() {
    if (!state.user) return;
    state.loading = true;
    const { data, error } = await client.from("community_feed").select("*").order("published_at", { ascending: false }).limit(50);
    state.feed = error ? [] : (data || []);
    state.message = error ? "לא ניתן לטעון את הקהילה כרגע" : "";
    state.loading = false;
  }
  async function sendMagicLink(email) {
    if (!client) return setMessage("יש להגדיר תחילה את חיבור Supabase");
    const clean = String(email || "").trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(clean)) return setMessage("כתובת האימייל אינה תקינה");
    const { error } = await client.auth.signInWithOtp({ email: clean, options: { emailRedirectTo: location.origin + location.pathname } });
    setMessage(error ? "שליחת הקישור נכשלה" : "שלחנו קישור כניסה לאימייל");
  }
  async function signOut() { if (client) await client.auth.signOut(); }
  async function saveProfile(form) {
    if (!state.user) return;
    const handle = String(form.handle.value || "").trim().toLowerCase();
    if (!/^[a-z0-9_]{3,24}$/.test(handle)) return setMessage("שם המשתמש חייב להכיל 3–24 אותיות באנגלית, מספרים או קו תחתון");
    // is_admin is deliberately never sent from here — a coach-code
    // redemption is a label only (invite_redemptions.role), not automatic
    // full admin access. Full admin stays a manual dashboard-only flip;
    // real coach-scoped permissions (their own classes/members) are a
    // separate piece of work, not built yet.
    const payload = { id: state.user.id, handle, display_name: String(form.displayName.value || "").trim().slice(0, 80), bio: String(form.bio.value || "").trim().slice(0, 160) };
    const { error } = await client.from("profiles").upsert(payload);
    if (error) return setMessage(error.code === "23505" ? "שם המשתמש כבר תפוס" : "שמירת הפרופיל נכשלה");
    await loadProfile(); setMessage("הפרופיל נשמר");
  }
  async function migrateLocalData() {
    if (!state.user || typeof window.queueAllLocalRecordsForSync !== "function") return;
    if (!window.confirm("להעלות את היסטוריית האימונים הפרטית לחשבון? שום נתון לא יפורסם בקהילה.")) return;
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
  async function pullPrivateRecords() {
    if (!client || !state.user || typeof window.applyRemotePrivateRecord !== "function") return;
    const { data, error } = await client.from("private_records").select("record_type,record_id,payload,deleted_at,updated_at").order("updated_at", { ascending: true }).limit(20000);
    if (error) return;
    for (const row of data || []) await window.applyRemotePrivateRecord(row);
    if (typeof window.reloadFromDb === "function") { await window.reloadFromDb(); rerender(); }
  }
  async function react(postId) {
    if (!state.user) return;
    const { error } = await client.from("reactions").insert({ post_id: postId, user_id: state.user.id, kind: "cheer" });
    if (error && error.code === "23505") await client.from("reactions").delete().eq("post_id", postId).eq("user_id", state.user.id);
    await loadFeed(); rerender();
  }
  async function report(postId) {
    if (!state.user) return;
    await client.from("reports").insert({ reporter_id: state.user.id, post_id: postId, reason: "inappropriate" });
    setMessage("הדיווח נשלח לבדיקה והתוכן הוסתר עבורך"); await loadFeed();
  }
  async function searchPeople(query) {
    if (!state.user) return;
    const q = String(query || "").trim().replace(/[%_,()]/g, "");
    if (q.length < 2) { state.people = []; return rerender(); }
    const { data, error } = await client.from("profiles").select("id,handle,display_name,bio,avatar_url").or(`handle.ilike.%${q}%,display_name.ilike.%${q}%`).neq("id", state.user.id).limit(20);
    state.people = error ? [] : (data || []); rerender();
  }
  async function follow(userId) {
    if (!state.user) return;
    const { error } = await client.from("follows").insert({ follower_id: state.user.id, followed_id: userId });
    if (error && error.code === "23505") await client.from("follows").delete().eq("follower_id", state.user.id).eq("followed_id", userId);
    await loadFeed(); setMessage(error && error.code !== "23505" ? "עדכון המעקב נכשל" : "המעקב עודכן");
  }
  async function block(userId) {
    if (!state.user || !window.confirm("לחסום את המשתמש? לא תראו זה את זה בקהילה.")) return;
    await client.from("blocks").upsert({ blocker_id: state.user.id, blocked_id: userId });
    await client.from("follows").delete().eq("follower_id", state.user.id).eq("followed_id", userId);
    state.people = state.people.filter((person) => person.id !== userId); await loadFeed(); setMessage("המשתמש נחסם");
  }
  async function publishWorkout(type, id, visibility) {
    if (!state.user || !state.profile || typeof window.communityShareCandidates !== "function") return;
    const item = window.communityShareCandidates().find((candidate) => candidate.type === type && candidate.id === id);
    if (!item) return setMessage("לא ניתן למצוא את התוצאה במכשיר");
    const payload = { author_id: state.user.id, source_type: item.type, source_record_id: item.id, visibility: visibility === "public" ? "public" : "followers", title: item.title, result_text: item.resultText, comparison_key: item.comparisonKey, score_value: item.scoreValue, score_direction: item.scoreDirection, rx: item.rx, occurred_on: item.occurredOn };
    const { error } = await client.from("workout_posts").upsert(payload, { onConflict: "author_id,source_type,source_record_id" });
    if (error) return setMessage("שיתוף התוצאה נכשל");
    await loadFeed(); setMessage("התוצאה שותפה בלי הערות, מדדים או פרטים אישיים");
  }
  async function compare(comparisonKey) {
    if (!comparisonKey) return;
    const { data, error } = await client.from("community_feed").select("id,handle,display_name,result_text,score_value,score_direction,occurred_on").eq("comparison_key", comparisonKey).limit(50);
    state.comparison = error ? [] : (data || []).sort((a, b) => a.score_direction === "lower" ? Number(a.score_value) - Number(b.score_value) : Number(b.score_value) - Number(a.score_value));
    setMessage(error ? "השוואת התוצאות נכשלה" : "");
  }
  async function requestDeletion() {
    if (!state.user || !window.confirm("הפרופיל והשיתופים יוסרו מיד. המחיקה הסופית תתבצע לאחר 30 יום. להמשיך?")) return;
    const { error } = await client.rpc("request_account_deletion");
    if (error) return setMessage("בקשת המחיקה נכשלה");
    await client.auth.signOut();
  }

  window.renderCommunityApp = function () {
    if (!configured) return `<div class="chart-card"><div style="font-weight:800;font-size:18px;margin-bottom:8px;">הקהילה מוכנה לחיבור</div><div style="color:var(--steel);font-size:13px;line-height:1.7;">יש ליצור פרויקט Supabase, להריץ את קובץ המיגרציה ולהכניס URL ומפתח publishable בקובץ cloud-config.js. אין להכניס מפתח secret.</div></div>`;
    if (!state.user) return `<div class="chart-card"><div style="font-weight:800;font-size:18px;margin-bottom:6px;">כניסה לקהילה</div><div style="color:var(--steel);font-size:13px;margin-bottom:14px;">קישור כניסה חד-פעמי יישלח לאימייל. האימונים נשארים פרטיים עד שתבחרו לשתף.</div><input id="communityEmail" class="text-input" type="email" dir="ltr" autocomplete="email" placeholder="name@example.com" aria-label="אימייל"/><button class="save-btn" style="margin-top:12px;" data-community-action="magic-link">שליחת קישור כניסה</button>${state.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${safeText(state.message)}</div>` : ""}</div>`;
    if (!state.redemption) return `<div class="chart-card"><div style="font-weight:800;font-size:18px;margin-bottom:6px;">קוד הזמנה למועדון</div><div style="color:var(--steel);font-size:13px;margin-bottom:14px;">הקהילה פתוחה רק למי שקיבל/ה קוד הזמנה מהמאמן/ת. הקוד לא נוגע לרישום האימונים עצמו — הוא רק פותח את לשונית הקהילה.</div><form id="communityInviteCode"><input class="text-input" name="code" dir="ltr" placeholder="קוד הזמנה" required/><button class="save-btn" type="submit" style="margin-top:12px;">אישור קוד</button></form>${state.message ? `<div class="footer-note" role="status" style="margin-top:10px;color:var(--brass);">${safeText(state.message)}</div>` : ""}</div>`;
    const p = state.profile || {};
    const isAdmin = !!(state.profile && state.profile.is_admin);

    const sectionHead = (color, title, adminTag) => `<div class="ach-section-head"><span class="ach-section-dot" style="background:${color};"></span><span class="ach-section-title">${title}</span>${adminTag ? `<span class="admin-tag">ניהול</span>` : ""}</div>`;

    const account = `<div class="ach-section"><form id="communityProfile" class="chart-card"><div style="font-weight:800;font-size:16px;margin-bottom:12px;">הפרופיל שלי</div>
      <label class="field"><span class="field-label">שם משתמש (handle)</span><input class="text-input" name="handle" dir="ltr" value="${safeText(p.handle || "")}" placeholder="handle" required/></label>
      <label class="field"><span class="field-label">שם תצוגה</span><input class="text-input" name="displayName" value="${safeText(p.display_name || "")}" placeholder="שם תצוגה"/></label>
      <label class="field"><span class="field-label">קצת עליי</span><textarea class="text-input" name="bio" maxlength="160" placeholder="כמה מילים עליי">${safeText(p.bio || "")}</textarea></label>
      <div class="chip-row"><button class="chip-btn primary" type="submit">שמירת פרופיל</button><button class="chip-btn" type="button" data-community-action="migrate">סנכרון היסטוריה פרטית</button><button class="chip-btn" type="button" data-community-action="sign-out">יציאה</button></div>
    </form></div>`;

    const announceComposer = isAdmin ? `<form id="communityAnnouncement" class="chart-card admin-card" style="margin-top:10px;"><div style="font-weight:800;margin-bottom:10px;">הודעה חדשה למועדון<span class="admin-tag">ניהול</span></div><label class="field"><span class="field-label">כותרת</span><input class="text-input" name="title" placeholder="כותרת" required/></label><label class="field"><span class="field-label">תוכן</span><textarea class="text-input" name="body" maxlength="2000" placeholder="תוכן ההודעה" required></textarea></label><button class="chip-btn primary" type="submit" style="margin-top:10px;">פרסום הודעה</button></form>` : "";
    const announcementsList = state.announcements.length ? `<div class="log-list">${state.announcements.map((a) => `<div class="log-row" style="align-items:flex-start;flex-direction:column;gap:4px;"><div style="font-weight:700;">${safeText(a.title)}</div><div style="color:var(--steel);font-size:13px;">${safeText(a.body)}</div><div style="color:var(--steel);font-size:11px;">${safeText(a.profiles ? (a.profiles.display_name || "@" + a.profiles.handle) : "")}</div></div>`).join("")}</div>` : `<div class="empty">אין הודעות חדשות</div>`;
    const announcementsHtml = `<div class="ach-section">${sectionHead("var(--brass)", "הודעות מהמועדון")}${announcementsList}${announceComposer}</div>`;

    const challengeSetter = isAdmin ? `<form id="communityWeeklyChallenge" class="chart-card admin-card" style="margin-top:10px;"><div style="font-weight:800;margin-bottom:10px;">קביעת אתגר שבועי<span class="admin-tag">ניהול</span></div><label class="field"><span class="field-label">שם האתגר</span><input class="text-input" name="title" placeholder="שם האתגר" required/></label><label class="field"><span class="field-label">מפתח השוואה</span><input class="text-input" name="comparisonKey" dir="ltr" placeholder="למשל back-squat" required/></label><div class="flex gap-10 field"><input class="text-input" name="startsOn" type="date" required/><input class="text-input" name="endsOn" type="date" required/></div><button class="chip-btn primary" type="submit" style="margin-top:10px;">קביעת אתגר</button></form>` : "";
    const weeklyLeaderboardList = state.weeklyChallenge ? `<div class="log-list">${state.weeklyLeaderboard.map((r, index) => `<div class="log-row"><span>${index + 1}. ${safeText(r.display_name || "@" + r.handle)}</span><span class="mono" style="color:var(--brass);">${safeText(r.result_text)}</span></div>`).join("")}</div>` : `<div class="empty">אין אתגר פעיל כרגע</div>`;
    const weeklyChallengeHtml = `<div class="ach-section">${sectionHead("var(--teal)", state.weeklyChallenge ? `אתגר השבוע: ${safeText(state.weeklyChallenge.title)}` : "אתגר השבוע")}${weeklyLeaderboardList}${challengeSetter}</div>`;

    const streaksHtml = state.streaks.length ? `<div class="ach-section">${sectionHead("var(--purple)", "רצפי התמדה")}<div class="log-list">${state.streaks.map((r, index) => `<div class="log-row"><span>${index + 1}. ${safeText(r.display_name || "@" + r.handle)}</span><span class="mono" style="color:var(--brass);">🔥 ${Number(r.current_streak)}</span></div>`).join("")}</div></div>` : "";

    const people = `<div class="ach-section">${sectionHead("var(--steel)", "מציאת מתאמנים")}<div class="search-box"><input id="communityPeopleSearch" placeholder="חיפוש לפי שם או @handle" aria-label="חיפוש מתאמנים" /></div>${state.people.length ? `<div class="log-list">${state.people.map((person) => `<div class="log-row"><div><div style="font-weight:700;">${safeText(person.display_name || "@" + person.handle)}</div><div style="color:var(--steel);font-size:12px;">@${safeText(person.handle)} ${safeText(person.bio || "")}</div></div><div class="chip-row" style="margin-top:0;"><button class="chip-btn" data-community-action="follow" data-id="${safeText(person.id)}">מעקב</button><button class="chip-btn" data-community-action="block" data-id="${safeText(person.id)}">חסימה</button></div></div>`).join("")}</div>` : ""}</div>`;

    const candidates = typeof window.communityShareCandidates === "function" ? window.communityShareCandidates() : [];
    const sharing = candidates.length ? `<div class="ach-section">${sectionHead("var(--energy)", "שיתוף תוצאה")}<div class="log-list">${candidates.map((item) => `<div class="log-row"><div><div style="font-weight:700;">${safeText(item.title)}</div><div class="mono" style="color:var(--brass);">${safeText(item.resultText)}</div></div><div class="chip-row" style="margin-top:0;"><button class="chip-btn" data-community-action="publish" data-type="${safeText(item.type)}" data-id="${safeText(item.id)}" data-visibility="followers">עוקבים</button><button class="chip-btn primary" data-community-action="publish" data-type="${safeText(item.type)}" data-id="${safeText(item.id)}" data-visibility="public">ציבורי</button></div></div>`).join("")}</div></div>` : "";

    const comparison = state.comparison.length ? `<div class="ach-section">${sectionHead("var(--blue)", "השוואת תוצאות")}<div class="log-list">${state.comparison.map((item, index) => `<div class="log-row"><span>${index + 1}. ${safeText(item.display_name || "@" + item.handle)}</span><span class="mono" style="color:var(--brass);">${safeText(item.result_text)}</span></div>`).join("")}</div></div>` : "";

    const inactiveHtml = isAdmin ? `<div class="ach-section">${sectionHead("var(--red)", "מי לא התאמן לאחרונה", true)}${state.inactiveMembers.length ? `<div class="log-list">${state.inactiveMembers.map((m) => `<div class="log-row"><span>${safeText(m.display_name || "@" + m.handle)}</span><span style="color:var(--steel);font-size:12px;">${m.last_activity_on ? safeText(m.last_activity_on) : "מעולם לא"}</span></div>`).join("")}</div>` : `<div class="empty">כולם פעילים</div>`}</div>` : "";

    const feed = state.feed.length ? `<div class="log-list">${state.feed.map((post) => `<article class="chart-card"><div style="font-weight:800;">${safeText(post.display_name || "@" + post.handle)}</div><div style="font-size:16px;margin:8px 0;">${safeText(post.title)}</div><div class="mono" style="color:var(--brass);font-weight:700;">${safeText(post.result_text)}</div><div class="chip-row"><button class="chip-btn" data-community-action="cheer" data-id="${safeText(post.id)}">🔥 ${Number(post.cheer_count || 0)}</button>${post.comparison_key ? `<button class="chip-btn" data-community-action="compare" data-key="${safeText(post.comparison_key)}">השוואה</button>` : ""}<button class="chip-btn" data-community-action="report" data-id="${safeText(post.id)}">דיווח</button></div></article>`).join("")}</div>` : `<div class="empty">עדיין אין שיתופים בפיד</div>`;
    const feedHtml = `<div class="ach-section">${sectionHead("var(--blue)", "הפיד שלי")}${feed}</div>`;

    return account
      + (state.message ? `<div class="footer-note" role="status" style="color:var(--brass);margin-bottom:14px;">${safeText(state.message)}</div>` : "")
      + announcementsHtml + weeklyChallengeHtml + streaksHtml + people + sharing + comparison + inactiveHtml + feedHtml
      + `<button class="link-btn" data-community-action="delete-account" style="display:block;margin:8px auto 28px;color:var(--red);">בקשת מחיקת חשבון</button>`;
  };
  window.cloudStorageStatusText = function () {
    if (!configured) return "נשמר במכשיר הזה בלבד, ללא שרת";
    if (!state.user) return "נשמר במכשיר; התחברו כדי לסנכרן באופן פרטי";
    return state.syncEnabled ? "נשמר במכשיר ומסונכרן באופן פרטי לחשבון" : "נשמר במכשיר; סנכרון ענן ממתין לאישורכם";
  };
  window.afterRenderCommunity = function () {
    const input = document.getElementById("communityPeopleSearch");
    if (input) input.addEventListener("change", () => searchPeople(input.value));
  };
  window.handleCommunityClick = function (el) {
    const action = el.dataset.communityAction;
    if (action === "magic-link") sendMagicLink(document.getElementById("communityEmail").value);
    else if (action === "sign-out") signOut();
    else if (action === "migrate") migrateLocalData();
    else if (action === "cheer") react(el.dataset.id);
    else if (action === "report") report(el.dataset.id);
    else if (action === "publish") publishWorkout(el.dataset.type, el.dataset.id, el.dataset.visibility);
    else if (action === "follow") follow(el.dataset.id);
    else if (action === "block") block(el.dataset.id);
    else if (action === "compare") compare(el.dataset.key);
    else if (action === "delete-account") requestDeletion();
    else if (action === "share-achievement") publishAchievement(el.dataset.id, el.dataset.title, el.dataset.rule);
  };
  window.isCommunitySignedIn = function () { return !!(state.user && state.profile); };
  window.shareAchievementToCommunity = function (achievementId, title, rule) { publishAchievement(achievementId, title, rule); };
  document.addEventListener("submit", (event) => {
    if (event.target.id === "communityProfile") { event.preventDefault(); saveProfile(event.target); }
    else if (event.target.id === "communityAnnouncement") { event.preventDefault(); postAnnouncement(event.target); }
    else if (event.target.id === "communityWeeklyChallenge") { event.preventDefault(); setWeeklyChallenge(event.target); }
    else if (event.target.id === "communityInviteCode") { event.preventDefault(); redeemCode(event.target); }
  });
  window.addEventListener("online", flushOutbox);
  window.addEventListener("haimunia-sync-needed", () => { flushOutbox(); pingActivity(); });
  if (client) {
    client.auth.onAuthStateChange((_event, session) => {
      state.user = session ? session.user : null;
      if (state.user) {
        loadRedemption()
          .then(() => Promise.all([loadProfile(), loadFeed(), loadStreaks(), loadAnnouncements(), loadWeeklyChallenge(), flushOutbox()]))
          .then(() => (state.profile && state.profile.is_admin ? loadInactiveMembers() : null))
          .then(pullPrivateRecords)
          .then(pingActivity)
          .then(rerender);
      } else {
        state.profile = null; state.feed = []; state.streaks = []; state.announcements = []; state.weeklyChallenge = null; state.weeklyLeaderboard = []; state.inactiveMembers = []; state.redemption = null;
        rerender();
      }
    });
    refreshSession();
  }
})();
