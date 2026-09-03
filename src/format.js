function estimate1RM(weight, reps) {
  if (reps <= 1) return weight;
  return Math.round(weight * (1 + reps / 30) * 10) / 10;
}
// Matches the box's own shorthand for holds: seconds alone under a minute,
// M:SS once it crosses one — e.g. 20" for a 20-second hold, 1:15 for longer.
function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  if (s < 60) return `${s}"`;
  const m = Math.floor(s / 60), rem = s % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}
function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit" });
}
function localISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayISO() { return localISODate(new Date()); }
// esc() moved to src/shared/safe-helpers.js in COMM-368 (one HTML escape for
// both Box Log clients, and, since COMM-367, for cloud.js too — which had its
// own byte-identical copy named safeText). It is bound as a bare `esc`
// identifier at the top of src/constants.js, which loads before this file,
// so every call site in this file and in app.js is unchanged.
