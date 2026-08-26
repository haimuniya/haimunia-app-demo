"use strict";

// ---------- Mock backend ----------
// Every function below is named and shaped the way the real Supabase-backed
// version will be called (box_id scoping, profile_id ownership) — see
// schema.sql and the build-phases plan's phase 02. Swapping mock data for
// real `@supabase/supabase-js` queries later means rewriting these function
// bodies only; every screen below never touches mockDb directly.

const mockDb = (() => {
  const boxId = "box-demo-1";
  const box = { id: boxId, name: "האימוניה", invite_code_member: "DEMO2026", invite_code_coach: "COACH2026" };

  const profiles = [
    { id: "p1", box_id: boxId, display_name: "נועם כהן", role: "owner" },
    { id: "p2", box_id: boxId, display_name: "שחף רחמני", role: "coach" },
    { id: "p3", box_id: boxId, display_name: "דנה לוי", role: "member" },
    { id: "p4", box_id: boxId, display_name: "איתי ברק", role: "member" },
    { id: "p5", box_id: boxId, display_name: "מאיה שדה", role: "member" },
    { id: "p6", box_id: boxId, display_name: "יובל אור", role: "member" },
    { id: "p7", box_id: boxId, display_name: "תמר גל", role: "member" },
    { id: "p8", box_id: boxId, display_name: "רון פלד", role: "member" },
  ];

  const wodScores = [
    { profile_id: "p1", wod_name: "Fran", score_type: "time", score_value: 218, achieved_at: daysAgo(2) },
    { profile_id: "p2", wod_name: "Fran", score_type: "time", score_value: 195, achieved_at: daysAgo(9) },
    { profile_id: "p3", wod_name: "Fran", score_type: "time", score_value: 241, achieved_at: daysAgo(1) },
    { profile_id: "p4", wod_name: "Fran", score_type: "time", score_value: 260, achieved_at: daysAgo(5) },
    { profile_id: "p5", wod_name: "Fran", score_type: "time", score_value: 233, achieved_at: daysAgo(3) },
    { profile_id: "p6", wod_name: "Fran", score_type: "time", score_value: 289, achieved_at: daysAgo(12) },
    { profile_id: "p1", wod_name: "Grace", score_type: "time", score_value: 172, achieved_at: daysAgo(6) },
    { profile_id: "p3", wod_name: "Grace", score_type: "time", score_value: 188, achieved_at: daysAgo(4) },
    { profile_id: "p5", wod_name: "Grace", score_type: "time", score_value: 165, achieved_at: daysAgo(10) },
    { profile_id: "p7", wod_name: "Grace", score_type: "time", score_value: 210, achieved_at: daysAgo(2) },
    { profile_id: "p2", wod_name: "Murph", score_type: "time", score_value: 2340, achieved_at: daysAgo(20) },
    { profile_id: "p4", wod_name: "Murph", score_type: "time", score_value: 2610, achieved_at: daysAgo(15) },
    { profile_id: "p6", wod_name: "Murph", score_type: "time", score_value: 2890, achieved_at: daysAgo(20) },
    { profile_id: "p1", wod_name: "Cindy", score_type: "amrap", score_value: 19, achieved_at: daysAgo(7) },
    { profile_id: "p3", wod_name: "Cindy", score_type: "amrap", score_value: 17, achieved_at: daysAgo(3) },
    { profile_id: "p8", wod_name: "Cindy", score_type: "amrap", score_value: 21, achieved_at: daysAgo(1) },
  ];

  const prEvents = [
    { id: "e1", profile_id: "p3", exercise_name: "Back Squat", value: 82.5, unit: "kg", achieved_at: daysAgo(0) },
    { id: "e2", profile_id: "p5", exercise_name: "Deadlift", value: 110, unit: "kg", achieved_at: daysAgo(0) },
    { id: "e3", profile_id: "p1", exercise_name: "Fran", value: 218, unit: "sec", achieved_at: daysAgo(2) },
    { id: "e4", profile_id: "p7", exercise_name: "Clean & Jerk", value: 62, unit: "kg", achieved_at: daysAgo(2) },
    { id: "e5", profile_id: "p8", exercise_name: "Cindy", value: 21, unit: "rounds", achieved_at: daysAgo(1) },
    { id: "e6", profile_id: "p4", exercise_name: "Strict Pull-up", value: 8, unit: "reps", achieved_at: daysAgo(3) },
    { id: "e7", profile_id: "p6", exercise_name: "Front Squat", value: 70, unit: "kg", achieved_at: daysAgo(4) },
  ];

  // Sparse activity map, most recent 14 days, per profile — used by the
  // coach dashboard's presence/streak view.
  const activity = {};
  for (const p of profiles) {
    activity[p.id] = new Set();
    const sessionsThisFortnight = 4 + Math.floor(hashSeed(p.id) % 7);
    for (let i = 0; i < sessionsThisFortnight; i++) {
      const dayOffset = Math.floor(hashSeed(p.id + i) % 14);
      activity[p.id].add(dayOffset);
    }
  }

  function hashSeed(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  }
  function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString();
  }

  return { box, profiles, wodScores, prEvents, activity };
})();

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function dbJoinBox(displayName, inviteCode) {
  await delay(180);
  const name = (displayName || "").trim();
  if (!name) return { error: "יש להזין שם" };
  const code = (inviteCode || "").trim().toUpperCase();
  if (code === mockDb.box.invite_code_member.toUpperCase()) {
    return { profile: { id: "you", box_id: mockDb.box.id, display_name: name, role: "member" } };
  }
  if (code === mockDb.box.invite_code_coach.toUpperCase()) {
    return { profile: { id: "you", box_id: mockDb.box.id, display_name: name, role: "coach" } };
  }
  return { error: "קוד הזמנה לא תקין — נסו DEMO2026 (חבר) או COACH2026 (מאמן)" };
}

async function dbGetLeaderboard(wodName) {
  await delay(120);
  const rows = mockDb.wodScores
    .filter((s) => s.wod_name === wodName)
    .map((s) => ({ ...s, profile: mockDb.profiles.find((p) => p.id === s.profile_id) }))
    .sort((a, b) => a.score_value - b.score_value); // "time" scoring: lower is better, matches Fran/Grace/Murph
  return rows;
}

async function dbGetFeed() {
  await delay(120);
  return mockDb.prEvents
    .map((e) => ({ ...e, profile: mockDb.profiles.find((p) => p.id === e.profile_id) }))
    .sort((a, b) => new Date(b.achieved_at) - new Date(a.achieved_at));
}

async function dbGetCoachActivity() {
  await delay(120);
  return mockDb.profiles.map((p) => {
    const days = mockDb.activity[p.id];
    const lastDayAgo = Math.min(...(days.size ? [...days] : [99]));
    return { profile: p, sessionsLast14: days.size, lastActiveDaysAgo: lastDayAgo };
  }).sort((a, b) => a.lastActiveDaysAgo - b.lastActiveDaysAgo);
}

// ---------- App state ----------
let currentUser = null;
let tab = "leaderboard";
let leaderboardWod = "Fran";
const BENCHMARKS = ["Fran", "Grace", "Murph", "Cindy"];

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtTime(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
function fmtScore(row) {
  if (row.score_type === "time") return fmtTime(row.score_value);
  if (row.score_type === "amrap") return `${row.score_value} סבבים`;
  return String(row.score_value);
}
function fmtRelative(iso) {
  const days = Math.floor((Date.now() - new Date(iso)) / 86400000);
  if (days <= 0) return "היום";
  if (days === 1) return "אתמול";
  return `לפני ${days} ימים`;
}

// ---------- Screens ----------
function renderAuth() {
  return `
    <div class="auth-card">
      <div class="auth-icon">${ICON_HOME}</div>
      <h2>הצטרפות לקהילת הבוקס</h2>
      <p class="auth-sub">קוד ההזמנה מגיע מהמאמן או ממנהל הבוקס.</p>
      <label class="field">
        <span>שם מלא</span>
        <input id="joinName" type="text" placeholder="לדוגמה: דנה לוי" autocomplete="name" />
      </label>
      <label class="field">
        <span>קוד הזמנה</span>
        <input id="joinCode" type="text" placeholder="DEMO2026" autocomplete="off" style="text-transform:uppercase;" />
      </label>
      <div id="joinError" class="auth-error" hidden></div>
      <button id="joinBtn" data-action="join" class="btn-primary">הצטרפות</button>
      <div class="auth-hint">לתצוגה: <b class="mono">DEMO2026</b> — חבר &nbsp;·&nbsp; <b class="mono">COACH2026</b> — מאמן</div>
    </div>`;
}

function renderLeaderboard(rows) {
  const chips = BENCHMARKS.map((w) => `<button class="chip ${w === leaderboardWod ? "active" : ""}" data-action="pick-wod" data-wod="${esc(w)}">${esc(w)}</button>`).join("");
  const list = rows.length
    ? rows.map((r, i) => `
      <div class="lb-row ${r.profile_id === currentUser.id ? "me" : ""}">
        <span class="lb-rank mono">${i + 1}</span>
        <span class="lb-name">${esc(r.profile?.display_name || "—")}</span>
        <span class="lb-score mono">${fmtScore(r)}</span>
      </div>`).join("")
    : `<div class="empty">אין עדיין תוצאות ל-${esc(leaderboardWod)}</div>`;
  return `
    <div class="section-head"><h2>לוח מובילים</h2><p>דירוג לפי בנצ'מרק, בתוך הבוקס שלכם בלבד</p></div>
    <div class="chips">${chips}</div>
    <div class="lb-list">${list}</div>`;
}

function renderWall(events) {
  const list = events.length
    ? events.map((e) => `
      <div class="feed-item">
        <div class="feed-avatar">${esc((e.profile?.display_name || "?")[0])}</div>
        <div class="feed-body">
          <div class="feed-line"><b>${esc(e.profile?.display_name || "—")}</b> שיא חדש ב-<span class="mono">${esc(e.exercise_name)}</span></div>
          <div class="feed-value mono">${e.value}${esc(e.unit === "kg" ? " ק\"ג" : e.unit === "sec" ? "″" : " " + e.unit)}</div>
          <div class="feed-time">${fmtRelative(e.achieved_at)}</div>
        </div>
      </div>`).join("")
    : `<div class="empty">אין עדיין שיאים משותפים</div>`;
  return `
    <div class="section-head"><h2>קיר קהילה</h2><p>שיאים אישיים שהחברים בחרו לשתף</p></div>
    <div class="feed-list">${list}</div>`;
}

function renderCoach(rows) {
  if (currentUser.role !== "coach" && currentUser.role !== "owner") {
    return `<div class="empty">המסך הזה זמין למאמנים בלבד</div>`;
  }
  const list = rows.map((r) => {
    const stale = r.lastActiveDaysAgo >= 4;
    return `
      <div class="coach-row ${stale ? "stale" : ""}">
        <span class="coach-name">${esc(r.profile.display_name)}</span>
        <span class="coach-meta">${r.sessionsLast14} אימונים ב-14 יום</span>
        <span class="coach-last mono">${r.lastActiveDaysAgo === 0 ? "היום" : `לפני ${r.lastActiveDaysAgo} ימים`}</span>
      </div>`;
  }).join("");
  return `
    <div class="section-head"><h2>לוח מאמן</h2><p>נוכחות ב-14 הימים האחרונים, ${mockDb.profiles.length} חברים בבוקס</p></div>
    <div class="coach-list">${list}</div>`;
}

// ---------- Render ----------
async function render() {
  const app = document.getElementById("app");
  const nav = document.getElementById("nav");
  const whoWrap = document.getElementById("whoWrap");
  if (!currentUser) {
    nav.style.display = "none";
    whoWrap.style.display = "none";
    app.innerHTML = renderAuth();
    return;
  }
  nav.style.display = "flex";
  whoWrap.style.display = "flex";
  nav.querySelectorAll(".navbtn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
    b.style.display = (b.dataset.tab === "coach" && currentUser.role === "member") ? "none" : "flex";
  });
  document.getElementById("whoami").textContent = `${currentUser.display_name} · ${currentUser.role === "member" ? "חבר/ה" : currentUser.role === "coach" ? "מאמן/ת" : "בעלים"}`;

  app.innerHTML = `<div class="loading">טוען…</div>`;
  if (tab === "leaderboard") app.innerHTML = renderLeaderboard(await dbGetLeaderboard(leaderboardWod));
  else if (tab === "wall") app.innerHTML = renderWall(await dbGetFeed());
  else if (tab === "coach") app.innerHTML = renderCoach(await dbGetCoachActivity());
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action], .navbtn");
  if (!el) return;
  if (el.classList.contains("navbtn")) { tab = el.dataset.tab; render(); return; }
  const action = el.dataset.action;
  if (action === "pick-wod") { leaderboardWod = el.dataset.wod; render(); }
  else if (action === "join") {
    const name = document.getElementById("joinName").value;
    const code = document.getElementById("joinCode").value;
    const errEl = document.getElementById("joinError");
    errEl.hidden = true;
    const btn = document.getElementById("joinBtn");
    btn.disabled = true;
    const result = await dbJoinBox(name, code);
    btn.disabled = false;
    if (result.error) { errEl.textContent = result.error; errEl.hidden = false; return; }
    currentUser = result.profile;
    tab = "leaderboard";
    render();
  }
  else if (action === "sign-out") { currentUser = null; tab = "leaderboard"; render(); }
});
document.getElementById("app").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.target.id === "joinName" || e.target.id === "joinCode")) {
    document.getElementById("joinBtn")?.click();
  }
});

const ICON_HOME = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M9 22V12h6v10"/></svg>`;

render();
