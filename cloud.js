(function () {
  "use strict";
  const cfg = window.HAIMUNIA_CONFIG || {};
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(cfg.supabaseUrl || "") && !!cfg.supabasePublishableKey;
  const client = configured && window.supabase ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  }) : null;
  const state = { configured, client, user: null, profile: null, feed: [], people: [], comparison: [], loading: false, message: "", syncEnabled: localStorage.getItem("haimunia-demo:cloudSyncEnabled") === "1" };

  function safeText(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function rerender() { if (typeof window.render === "function") window.render(); }
  function setMessage(message) { state.message = message || ""; rerender(); }

  async function refreshSession() {
    if (!client) return;
    const { data } = await client.auth.getSession();
    state.user = data.session ? data.session.user : null;
    if (state.user) { await Promise.all([loadProfile(), loadFeed()]); await pullPrivateRecords(); }
    rerender();
  }
  async function loadProfile() {
    if (!state.user) return;
    const { data } = await client.from("profiles").select("id,handle,display_name,bio,avatar_url").eq("id", state.user.id).maybeSingle();
    state.profile = data || null;
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
    const p = state.profile || {};
    const profile = `<form id="communityProfile" class="chart-card"><div style="font-weight:800;margin-bottom:10px;">הפרופיל שלי</div><input class="text-input" name="handle" dir="ltr" value="${safeText(p.handle || "")}" placeholder="handle" required/><input class="text-input" name="displayName" value="${safeText(p.display_name || "")}" placeholder="שם תצוגה" style="margin-top:8px;"/><textarea class="text-input" name="bio" maxlength="160" placeholder="כמה מילים עליי" style="margin-top:8px;">${safeText(p.bio || "")}</textarea><button class="link-btn" type="submit" style="margin-top:10px;">שמירת פרופיל</button> · <button class="link-btn" type="button" data-community-action="migrate">סנכרון היסטוריה פרטית</button> · <button class="link-btn" type="button" data-community-action="sign-out">יציאה</button></form>`;
    const people = `<div class="section-label" style="margin-top:18px;">מציאת מתאמנים</div><div class="search-box"><input id="communityPeopleSearch" placeholder="חיפוש לפי שם או @handle" aria-label="חיפוש מתאמנים" /></div>${state.people.map((person) => `<div class="log-row"><div><div style="font-weight:700;">${safeText(person.display_name || "@" + person.handle)}</div><div style="color:var(--steel);font-size:12px;">@${safeText(person.handle)} ${safeText(person.bio || "")}</div></div><div><button class="link-btn" data-community-action="follow" data-id="${safeText(person.id)}">מעקב</button> · <button class="link-btn" data-community-action="block" data-id="${safeText(person.id)}">חסימה</button></div></div>`).join("")}`;
    const candidates = typeof window.communityShareCandidates === "function" ? window.communityShareCandidates() : [];
    const sharing = candidates.length ? `<div class="section-label" style="margin-top:18px;">שיתוף תוצאה</div>${candidates.map((item) => `<div class="log-row"><div><div style="font-weight:700;">${safeText(item.title)}</div><div class="mono" style="color:var(--brass);">${safeText(item.resultText)}</div></div><div><button class="link-btn" data-community-action="publish" data-type="${safeText(item.type)}" data-id="${safeText(item.id)}" data-visibility="followers">עוקבים</button> · <button class="link-btn" data-community-action="publish" data-type="${safeText(item.type)}" data-id="${safeText(item.id)}" data-visibility="public">ציבורי</button></div></div>`).join("")}` : "";
    const feed = state.feed.length ? state.feed.map((post) => `<article class="chart-card" style="margin-top:10px;"><div style="font-weight:800;">${safeText(post.display_name || "@" + post.handle)}</div><div style="font-size:16px;margin:8px 0;">${safeText(post.title)}</div><div class="mono" style="color:var(--brass);font-weight:700;">${safeText(post.result_text)}</div><div class="flex gap-10" style="margin-top:12px;"><button class="link-btn" data-community-action="cheer" data-id="${safeText(post.id)}">🔥 ${Number(post.cheer_count || 0)}</button>${post.comparison_key ? `<button class="link-btn" data-community-action="compare" data-key="${safeText(post.comparison_key)}">השוואה</button>` : ""}<button class="link-btn" data-community-action="report" data-id="${safeText(post.id)}">דיווח</button></div></article>`).join("") : `<div class="empty">עדיין אין שיתופים בפיד</div>`;
    const comparison = state.comparison.length ? `<div class="section-label" style="margin-top:18px;">השוואת תוצאות</div>${state.comparison.map((item, index) => `<div class="log-row"><span>${index + 1}. ${safeText(item.display_name || "@" + item.handle)}</span><span class="mono" style="color:var(--brass);">${safeText(item.result_text)}</span></div>`).join("")}` : "";
    return profile + (state.message ? `<div class="footer-note" role="status" style="color:var(--brass);">${safeText(state.message)}</div>` : "") + people + sharing + comparison + `<div class="section-label" style="margin-top:18px;">הפיד שלי</div>${feed}<button class="link-btn" data-community-action="delete-account" style="display:block;margin:28px auto 0;color:var(--red);">בקשת מחיקת חשבון</button>`;
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
  };
  document.addEventListener("submit", (event) => { if (event.target.id === "communityProfile") { event.preventDefault(); saveProfile(event.target); } });
  window.addEventListener("online", flushOutbox);
  window.addEventListener("haimunia-sync-needed", flushOutbox);
  if (client) {
    client.auth.onAuthStateChange((_event, session) => { state.user = session ? session.user : null; if (state.user) Promise.all([loadProfile(), loadFeed(), flushOutbox()]).then(pullPrivateRecords).then(rerender); else { state.profile = null; state.feed = []; rerender(); } });
    refreshSession();
  }
})();
