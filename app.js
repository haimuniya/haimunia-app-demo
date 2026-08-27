// ---------- Suppress accidental double-tap zoom ----------
// Deliberate pinch-zoom is left working: blocking it (the previous
// touchmove/gesturestart handlers plus user-scalable=no) is a WCAG 1.4.4
// failure and makes the app unusable for low-vision users. Only the
// double-tap-to-zoom gesture is suppressed, since it fires by accident when
// tapping the +/- steppers quickly.
let lastTouchEndTime = 0;
document.addEventListener("touchend", (e) => {
  const now = Date.now();
  if (now - lastTouchEndTime <= 300) e.preventDefault();
  lastTouchEndTime = now;
}, false);

// ---------- Data ----------
const CATEGORY_COLORS = {
  Squat: "var(--teal)", Deadlift: "var(--red)", Press: "var(--yellow)",
  Olympic: "var(--green)", Pull: "var(--purple)", Other: "var(--steel)",
  Custom: "var(--brass)", Girls: "var(--purple)", Heroes: "var(--red)",
  Gymnastics: "var(--purple)", Weightlifting: "var(--blue)", Dumbbell: "var(--green)",
  Kettlebell: "var(--yellow)", "Odd Object": "var(--red)", Monostructural: "var(--steel)",
};

const CATEGORY_LABELS = {
  Squat: "Squat", Deadlift: "Deadlift", Press: "Press", Olympic: "Olympic",
  Pull: "Pull", Other: "Other", Custom: "Custom", Girls: "Girls", Heroes: "Heroes",
  Gymnastics: "Gymnastics", Weightlifting: "Weightlifting", Dumbbell: "Dumbbell",
  Kettlebell: "Kettlebell", "Odd Object": "Odd Object", Monostructural: "Monostructural",
};

const MOVEMENTS = [
  { id: "back-squat", name: "Back Squat", category: "Squat" },
  { id: "front-squat", name: "Front Squat", category: "Squat" },
  { id: "overhead-squat", name: "Overhead Squat", category: "Squat" },
  { id: "box-squat", name: "Box Squat", category: "Squat" },
  { id: "pause-squat", name: "Pause Squat", category: "Squat" },
  { id: "zercher-squat", name: "Zercher Squat", category: "Squat" },
  { id: "bulgarian-split-squat", name: "Bulgarian Split Squat", category: "Squat" },
  { id: "deadlift", name: "Deadlift", category: "Deadlift" },
  { id: "sumo-deadlift", name: "Sumo Deadlift", category: "Deadlift" },
  { id: "deficit-deadlift", name: "Deficit Deadlift", category: "Deadlift" },
  { id: "romanian-deadlift", name: "Romanian Deadlift", category: "Deadlift" },
  { id: "trap-bar-deadlift", name: "Trap Bar Deadlift", category: "Deadlift" },
  { id: "stiff-leg-deadlift", name: "Stiff-Leg Deadlift", category: "Deadlift" },
  { id: "snatch-grip-deadlift", name: "Snatch-Grip Deadlift", category: "Deadlift" },
  { id: "strict-press", name: "Strict Press", category: "Press" },
  { id: "push-press", name: "Push Press", category: "Press" },
  { id: "bench-press", name: "Bench Press", category: "Press" },
  { id: "push-jerk", name: "Push Jerk", category: "Press" },
  { id: "split-jerk", name: "Split Jerk", category: "Press" },
  { id: "seated-press", name: "Seated Press", category: "Press" },
  { id: "z-press", name: "Z-Press", category: "Press" },
  { id: "single-arm-db-press", name: "Single-Arm DB Press", category: "Press" },
  { id: "incline-bench-press", name: "Incline Bench Press", category: "Press" },
  { id: "close-grip-bench-press", name: "Close-Grip Bench Press", category: "Press" },
  { id: "landmine-press", name: "Landmine Press", category: "Press" },
  { id: "clean", name: "Clean (Squat Clean)", category: "Olympic" },
  { id: "power-clean", name: "Power Clean", category: "Olympic" },
  { id: "hang-clean", name: "Hang Clean", category: "Olympic" },
  { id: "clean-and-jerk", name: "Clean and Jerk", category: "Olympic" },
  { id: "snatch", name: "Snatch", category: "Olympic" },
  { id: "power-snatch", name: "Power Snatch", category: "Olympic" },
  { id: "hang-snatch", name: "Hang Snatch", category: "Olympic" },
  { id: "muscle-snatch", name: "Muscle Snatch", category: "Olympic" },
  { id: "muscle-clean", name: "Muscle Clean", category: "Olympic" },
  { id: "snatch-pull", name: "Snatch Pull", category: "Olympic" },
  { id: "clean-pull", name: "Clean Pull", category: "Olympic" },
  { id: "snatch-balance", name: "Snatch Balance", category: "Olympic" },
  { id: "pause-snatch", name: "Pause Snatch", category: "Olympic" },
  { id: "pause-clean", name: "Pause Clean", category: "Olympic" },
  { id: "weighted-pullup", name: "Weighted Pull-Up", category: "Pull" },
  { id: "weighted-chinup", name: "Weighted Chin-Up", category: "Pull" },
  { id: "bent-over-row", name: "Bent-Over Row", category: "Pull" },
  { id: "barbell-row", name: "Barbell Row", category: "Pull" },
  { id: "pendlay-row", name: "Pendlay Row", category: "Pull" },
  { id: "single-arm-db-row", name: "Single-Arm DB Row", category: "Pull" },
  { id: "t-bar-row", name: "T-Bar Row", category: "Pull" },
  { id: "face-pull", name: "Face Pull", category: "Pull" },
  { id: "lat-pulldown", name: "Lat Pulldown", category: "Pull" },
  { id: "thruster", name: "Thruster", category: "Other" },
  { id: "front-rack-lunge", name: "Front Rack Lunge", category: "Other" },
  { id: "weighted-dip", name: "Weighted Dip", category: "Other" },
  { id: "turkish-getup", name: "Turkish Get-Up", category: "Other" },
  { id: "good-mornings", name: "Good Mornings", category: "Other" },
  { id: "hip-thrust", name: "Hip Thrust", category: "Other" },
  { id: "barbell-lunge", name: "Barbell Lunge", category: "Other" },
  { id: "weighted-step-up", name: "Weighted Step-Up", category: "Other" },
  { id: "nordic-curl", name: "Nordic Curl", category: "Other" },
  { id: "ghd-hip-extension", name: "GHD Hip Extension", category: "Other" },
  { id: "weighted-plank", name: "Weighted Plank", category: "Other" },
  { id: "ab-wheel-rollout", name: "Ab Wheel Rollout", category: "Other" },
  { id: "leg-press", name: "Leg Press", category: "Other" },
  { id: "leg-curl", name: "Leg Curl", category: "Other" },
  { id: "leg-extension", name: "Leg Extension", category: "Other" },
  { id: "calf-raise", name: "Calf Raise", category: "Other" },
];

const STANDARD_REPS = [1, 2, 3, 5, 10];
const BAR_OPTIONS = [20, 15, 8];
let barWeight = 20;
// Single source of truth for the app version. After bumping this, run
// `npm run sync-version` to copy it into SW_VERSION in sw.js — `npm test`
// fails if the two drift apart.
const APP_VERSION = "3.0.8";

const WOD_MOVEMENT_TAGS = [
  // Gymnastics (bodyweight)
  { name: "Air Squat", category: "Gymnastics" },
  { name: "Pistols (Single-Leg Squat)", category: "Gymnastics" },
  { name: "Push-Ups", category: "Gymnastics" },
  { name: "Pull-Ups", category: "Gymnastics" },
  { name: "Chest-to-Bar Pull-Ups", category: "Gymnastics" },
  { name: "Strict Pull-Ups", category: "Gymnastics" },
  { name: "Bar Muscle-Ups", category: "Gymnastics" },
  { name: "Ring Muscle-Ups", category: "Gymnastics" },
  { name: "Ring Dips", category: "Gymnastics" },
  { name: "Handstand Push-Ups", category: "Gymnastics" },
  { name: "Handstand Walk", category: "Gymnastics" },
  { name: "Wall Walks", category: "Gymnastics" },
  { name: "Toes-to-Bar", category: "Gymnastics" },
  { name: "Knees-to-Elbows", category: "Gymnastics" },
  { name: "Sit-Ups", category: "Gymnastics" },
  { name: "GHD Sit-Ups", category: "Gymnastics" },
  { name: "Burpees", category: "Gymnastics" },
  { name: "Burpee Box Jump-Overs", category: "Gymnastics" },
  { name: "Box Jumps", category: "Gymnastics" },
  { name: "Box Step-Ups", category: "Gymnastics" },
  { name: "Rope Climbs", category: "Gymnastics" },
  { name: "Double-Unders", category: "Gymnastics" },
  { name: "Single-Unders", category: "Gymnastics" },
  { name: "L-Sit", category: "Gymnastics" },
  { name: "Pike Push-Ups", category: "Gymnastics" },
  { name: "Deficit Push-Ups", category: "Gymnastics" },
  { name: "Ring Rows", category: "Gymnastics" },
  { name: "Australian Pull-Ups", category: "Gymnastics" },
  { name: "Banded Pull-Ups", category: "Gymnastics" },
  { name: "Kipping Pull-Ups", category: "Gymnastics" },
  { name: "Ring Support Hold", category: "Gymnastics" },
  { name: "Ring Push-Ups", category: "Gymnastics" },
  { name: "Broad Jump", category: "Gymnastics" },
  { name: "Tuck-Ups", category: "Gymnastics" },
  { name: "V-Ups", category: "Gymnastics" },
  { name: "Hollow Rocks", category: "Gymnastics" },
  { name: "Superman Hold", category: "Gymnastics" },
  { name: "Plank Hold", category: "Gymnastics" },
  { name: "Side Plank", category: "Gymnastics" },
  { name: "Bear Crawl", category: "Gymnastics" },
  { name: "Crab Walk", category: "Gymnastics" },
  { name: "Inchworm", category: "Gymnastics" },
  { name: "Mountain Climbers", category: "Gymnastics" },
  { name: "Jumping Lunges", category: "Gymnastics" },
  { name: "Jump Squats", category: "Gymnastics" },
  { name: "Star Jumps", category: "Gymnastics" },
  { name: "Skater Jumps", category: "Gymnastics" },
  { name: "Wall Sit", category: "Gymnastics" },
  // Weightlifting (barbell)
  { name: "Back Squat", category: "Weightlifting" },
  { name: "Front Squat", category: "Weightlifting" },
  { name: "Overhead Squat", category: "Weightlifting" },
  { name: "Deadlift", category: "Weightlifting" },
  { name: "Sumo Deadlift", category: "Weightlifting" },
  { name: "Romanian Deadlift", category: "Weightlifting" },
  { name: "Clean", category: "Weightlifting" },
  { name: "Power Clean", category: "Weightlifting" },
  { name: "Hang Clean", category: "Weightlifting" },
  { name: "Hang Power Clean", category: "Weightlifting" },
  { name: "Clean and Jerk", category: "Weightlifting" },
  { name: "Snatch", category: "Weightlifting" },
  { name: "Power Snatch", category: "Weightlifting" },
  { name: "Hang Snatch", category: "Weightlifting" },
  { name: "Split Jerk", category: "Weightlifting" },
  { name: "Push Jerk", category: "Weightlifting" },
  { name: "Push Press", category: "Weightlifting" },
  { name: "Strict Press", category: "Weightlifting" },
  { name: "Bench Press", category: "Weightlifting" },
  { name: "Thruster", category: "Weightlifting" },
  { name: "Sumo Deadlift High Pull", category: "Weightlifting" },
  { name: "Good Mornings", category: "Weightlifting" },
  { name: "Muscle Snatch", category: "Weightlifting" },
  { name: "Muscle Clean", category: "Weightlifting" },
  { name: "Snatch Balance", category: "Weightlifting" },
  { name: "Snatch Pull", category: "Weightlifting" },
  { name: "Clean Pull", category: "Weightlifting" },
  { name: "Tall Clean", category: "Weightlifting" },
  { name: "Tall Snatch", category: "Weightlifting" },
  { name: "Front Rack Lunge", category: "Weightlifting" },
  { name: "Overhead Lunge", category: "Weightlifting" },
  { name: "Zercher Squat", category: "Weightlifting" },
  { name: "Bulgarian Split Squat", category: "Weightlifting" },
  { name: "Box Squat", category: "Weightlifting" },
  // Dumbbell
  { name: "DB Snatch", category: "Dumbbell" },
  { name: "DB Clean", category: "Dumbbell" },
  { name: "DB Clean and Jerk", category: "Dumbbell" },
  { name: "DB Thruster", category: "Dumbbell" },
  { name: "DB Push Press", category: "Dumbbell" },
  { name: "DB Overhead Squat", category: "Dumbbell" },
  { name: "DB Front Squat", category: "Dumbbell" },
  { name: "DB Deadlift", category: "Dumbbell" },
  { name: "DB Lunges", category: "Dumbbell" },
  { name: "DB Man Makers", category: "Dumbbell" },
  { name: "Devil Press", category: "Dumbbell" },
  { name: "DB Box Step-Overs", category: "Dumbbell" },
  { name: "DB Hang Clean", category: "Dumbbell" },
  { name: "DB Hang Snatch", category: "Dumbbell" },
  { name: "DB Renegade Row", category: "Dumbbell" },
  { name: "DB Bench Press", category: "Dumbbell" },
  { name: "DB Single-Arm Overhead Squat", category: "Dumbbell" },
  { name: "DB Walking Lunge", category: "Dumbbell" },
  { name: "DB Floor Press", category: "Dumbbell" },
  // Kettlebell
  { name: "KB Swings (Russian)", category: "Kettlebell" },
  { name: "KB Swings (American)", category: "Kettlebell" },
  { name: "KB Snatch", category: "Kettlebell" },
  { name: "KB Clean", category: "Kettlebell" },
  { name: "KB Goblet Squat", category: "Kettlebell" },
  { name: "KB Overhead Squat", category: "Kettlebell" },
  { name: "Turkish Get-Up", category: "Kettlebell" },
  { name: "KB Single-Arm Swing", category: "Kettlebell" },
  { name: "KB Windmill", category: "Kettlebell" },
  { name: "KB Lunge", category: "Kettlebell" },
  { name: "KB Press", category: "Kettlebell" },
  { name: "KB Thruster", category: "Kettlebell" },
  // Odd object / carries
  { name: "Wall Balls", category: "Odd Object" },
  { name: "Farmers Carry", category: "Odd Object" },
  { name: "Sandbag Cleans", category: "Odd Object" },
  { name: "Sandbag Carry", category: "Odd Object" },
  { name: "Sled Push", category: "Odd Object" },
  { name: "Sled Pull", category: "Odd Object" },
  { name: "Yoke Carry", category: "Odd Object" },
  { name: "Atlas Stone to Shoulder", category: "Odd Object" },
  { name: "Tire Flip", category: "Odd Object" },
  { name: "Sledgehammer Swings", category: "Odd Object" },
  { name: "Sandbag Over Shoulder", category: "Odd Object" },
  { name: "Keg Carry", category: "Odd Object" },
  { name: "D-Ball Cleans", category: "Odd Object" },
  { name: "Zercher Carry", category: "Odd Object" },
  // Monostructural
  { name: "Run (Meters)", category: "Monostructural" },
  { name: "Row (Meters)", category: "Monostructural" },
  { name: "Row (Calories)", category: "Monostructural" },
  { name: "Bike (Calories)", category: "Monostructural" },
  { name: "Assault Bike (Calories)", category: "Monostructural" },
  { name: "Ski Erg (Calories)", category: "Monostructural" },
  { name: "Swim (Meters)", category: "Monostructural" },
  { name: "Echo Bike (Calories)", category: "Monostructural" },
  { name: "Shuttle Runs (Meters)", category: "Monostructural" },
  { name: "Sprint (Meters)", category: "Monostructural" },
];
const WOD_MOVE_CATEGORIES_WITH_WEIGHT = new Set(["Weightlifting", "Dumbbell", "Kettlebell", "Odd Object"]);
const WOD_MOVE_CATEGORIES = ["Gymnastics", "Weightlifting", "Dumbbell", "Kettlebell", "Odd Object", "Monostructural"];

const WOD_LIBRARY = [
  { id: "fran", name: "Fran", category: "Girls", scoreType: "time", desc: "21-15-9 Thrusters & Pull-ups" },
  { id: "grace", name: "Grace", category: "Girls", scoreType: "time", desc: "30 Clean & Jerks" },
  { id: "isabel", name: "Isabel", category: "Girls", scoreType: "time", desc: "30 Snatches" },
  { id: "diane", name: "Diane", category: "Girls", scoreType: "time", desc: "21-15-9 Deadlifts & HSPU" },
  { id: "elizabeth", name: "Elizabeth", category: "Girls", scoreType: "time", desc: "21-15-9 Cleans & Ring Dips" },
  { id: "karen", name: "Karen", category: "Girls", scoreType: "time", desc: "150 Wall Balls for time" },
  { id: "annie", name: "Annie", category: "Girls", scoreType: "time", desc: "50-40-30-20-10 Double-unders & Sit-ups" },
  { id: "helen", name: "Helen", category: "Girls", scoreType: "time", desc: "3 rounds: 400m run, 21 KB swings, 12 pull-ups" },
  { id: "nancy", name: "Nancy", category: "Girls", scoreType: "time", desc: "5 rounds: 400m run, 15 OHS" },
  { id: "jackie", name: "Jackie", category: "Girls", scoreType: "time", desc: "1000m row, 50 thrusters, 30 pull-ups" },
  { id: "angie", name: "Angie", category: "Girls", scoreType: "time", desc: "100 pull-ups, push-ups, sit-ups, squats" },
  { id: "cindy", name: "Cindy", category: "Girls", scoreType: "amrap", desc: "AMRAP 20: 5 pull-ups, 10 push-ups, 15 squats" },
  { id: "mary", name: "Mary", category: "Girls", scoreType: "amrap", desc: "AMRAP 20: 5 HSPU, 10 pistols, 15 pull-ups" },
  { id: "kelly", name: "Kelly", category: "Girls", scoreType: "time", desc: "5 rounds: 400m run, 30 box jumps, 30 wall balls" },
  { id: "eva", name: "Eva", category: "Girls", scoreType: "time", desc: "5 rounds: 800m run, 30 KB swings, 30 pull-ups" },
  { id: "barbara", name: "Barbara", category: "Girls", scoreType: "time", desc: "5 rounds: 20 pull-ups, 30 push-ups, 40 sit-ups, 50 squats" },
  { id: "filthy-fifty", name: "Filthy Fifty", category: "Girls", scoreType: "time", desc: "50 reps each of 10 movements, for time" },
  { id: "murph", name: "Murph", category: "Heroes", scoreType: "time", desc: "1mi run, 100 pull-ups, 200 push-ups, 300 squats, 1mi run" },
  { id: "dt", name: "DT", category: "Heroes", scoreType: "time", desc: "5 rounds: 12 deadlifts, 9 hang power cleans, 6 push jerks" },
  { id: "randy", name: "Randy", category: "Heroes", scoreType: "time", desc: "75 power snatches" },
  { id: "jt", name: "JT", category: "Heroes", scoreType: "time", desc: "21-15-9 HSPU, ring dips, push-ups" },
  { id: "nate", name: "Nate", category: "Heroes", scoreType: "amrap", desc: "AMRAP 20: 2 muscle-ups, 4 HSPU, 8 KB swings" },
  { id: "michael", name: "Michael", category: "Heroes", scoreType: "time", desc: "3 rounds: 800m run, 50 back extensions, 50 sit-ups" },
  { id: "danny", name: "Danny", category: "Heroes", scoreType: "amrap", desc: "AMRAP 20: 30 box jumps, 20 push press, 30 pull-ups" },
  { id: "badger", name: "Badger", category: "Heroes", scoreType: "time", desc: "3 rounds: 30 squat cleans, 30 pull-ups, 800m run" },
];
const PLATE_DEFS = [
  { kg: 25, color: "#D8453C", w: 15, h: 78 },
  { kg: 20, color: "#3E6FD9", w: 15, h: 70 },
  { kg: 15, color: "#E0B23C", w: 13, h: 62 },
  { kg: 10, color: "#4B9B5F", w: 11, h: 54 },
  { kg: 5, color: "#7A828C", w: 9, h: 44 },
  { kg: 2.5, color: "#1A1A1A", w: 7, h: 34 },
  { kg: 1.25, color: "#1A1A1A", w: 6, h: 26 },
];

function calcPlates(total) {
  let perSide = Math.max(0, (total - barWeight) / 2);
  const out = [];
  for (const p of PLATE_DEFS) {
    while (perSide + 1e-9 >= p.kg) { out.push(p); perSide -= p.kg; }
  }
  return out;
}
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
const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(str) { return String(str ?? "").replace(/[&<>"']/g, (c) => ESC_MAP[c]); }

// ---------- Safety helpers ----------
// Escape a value for use inside a CSS attribute selector.
function cssSel(v) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(String(v ?? ""));
  return String(v ?? "").replace(/["\\\]]/g, "\\$&");
}
// Prototype-safe lookup tables. A record whose category is "__proto__" (only
// reachable through an imported backup) must never resolve to Object.prototype.
function catColor(cat) {
  return Object.prototype.hasOwnProperty.call(CATEGORY_COLORS, cat) ? CATEGORY_COLORS[cat] : "var(--steel)";
}
function catLabel(cat) {
  return Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, cat) ? CATEGORY_LABELS[cat] : String(cat ?? "");
}
// Accumulator objects keyed by untrusted strings must have no prototype.
function bag() { return Object.create(null); }

const WOD_SCORE_TYPES = ["time", "amrap", "load", "emom"];
const LIMITS = {
  nameLen: 80, notesLen: 300, idLen: 128, importItems: 20000,
  weight: 1000, reps: 1000, sets: 100, minutes: 999, seconds: 59,
  rounds: 9999, bodyweight: 500, measurement: 300, duration: 3600,
  emomMovements: 20, partnerTag: 40,
};
const FIELD_MAX = {
  weight: LIMITS.weight, reps: LIMITS.reps, sets: LIMITS.sets,
  wodMinutes: LIMITS.minutes, wodSeconds: LIMITS.seconds, wodRounds: LIMITS.rounds,
  wodReps: LIMITS.reps, wodWeight: LIMITS.weight, wodScaledWeight: LIMITS.weight,
  bwWeight: LIMITS.bodyweight, durationSeconds: LIMITS.duration,
};
function fieldMax(action, field) {
  if (action === "bw-step") return LIMITS.bodyweight;
  if (action === "builder-movement-reps") return LIMITS.reps;
  if (action === "builder-movement-weight") return LIMITS.weight;
  if (action === "builder-movement-duration") return LIMITS.duration;
  if (action === "builder-emom-minutes") return LIMITS.minutes;
  if (action === "builder-time-cap") return LIMITS.minutes;
  if (action === "wod-emom-step") return LIMITS.reps;
  if (action === "measure-step") return LIMITS.measurement;
  return Object.prototype.hasOwnProperty.call(FIELD_MAX, field) ? FIELD_MAX[field] : LIMITS.weight;
}
function cleanStr(v, max) {
  if (typeof v !== "string") return "";
  // strip control chars, collapse runaway whitespace, hard-cap length
  return v.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, max);
}
function cleanNum(v, min, max, fallback) {
  const n = typeof v === "number" ? v : parseFloat(v);
  if (!isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
}
function cleanId(v) {
  const raw = typeof v === "string" ? v : "";
  // opaque identifier: conservative charset, never reaches HTML as markup
  const id = raw.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, LIMITS.idLen);
  return id || null;
}
function cleanISODate(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(v + "T00:00:00");
  return isNaN(d.getTime()) ? null : v;
}
function cleanTs(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0 || n > 4102444800000) return Date.now(); // cap at year 2100
  return Math.floor(n);
}
function uid(prefix) {
  let r;
  try { r = (self.crypto && self.crypto.randomUUID) ? self.crypto.randomUUID() : null; } catch (e) { r = null; }
  if (!r) {
    try {
      const a = new Uint8Array(16); self.crypto.getRandomValues(a);
      r = Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
    } catch (e) { r = Date.now().toString(36) + Math.random().toString(36).slice(2); }
  }
  return prefix + "-" + r;
}
// ---------- Record sanitizers ----------
// Applied to every record that comes off disk or out of an imported file.
// Nothing else in the app is allowed to trust these shapes.
function sanitizeMovement(m) {
  if (!m || typeof m !== "object") return null;
  const id = cleanId(m.id), name = cleanStr(m.name, LIMITS.nameLen);
  if (!id || !name) return null;
  return { id, name, category: MOVEMENT_CATEGORIES.includes(m.category) ? m.category : "Other" };
}
function sanitizeCustomWod(w) {
  if (!w || typeof w !== "object") return null;
  const id = cleanId(w.id), name = cleanStr(w.name, LIMITS.nameLen);
  if (!id || !name) return null;
  const scoreType = WOD_SCORE_TYPES.includes(w.scoreType) ? w.scoreType : "time";
  const out = { id, name, category: "Custom", scoreType, desc: cleanStr(w.desc, LIMITS.notesLen) };
  // EMOM structure lives on the WOD itself (unlike every other format, whose
  // per-movement fields are only ever baked into free text) — the log form
  // needs to know the movement rotation to render one reps field per
  // movement each time this WOD is attempted. See renderWodLogSection.
  if (scoreType === "emom") {
    const movements = Array.isArray(w.emomMovements) ? w.emomMovements : [];
    out.emomMovements = movements.slice(0, LIMITS.emomMovements).map((n) => cleanStr(n, LIMITS.nameLen)).filter(Boolean);
    const targets = Array.isArray(w.emomTargetReps) ? w.emomTargetReps : [];
    out.emomTargetReps = out.emomMovements.map((_, i) => Math.round(cleanNum(targets[i], 0, LIMITS.reps, 0)));
    out.emomMinutes = Math.round(cleanNum(w.emomMinutes, 1, LIMITS.minutes, 10));
    if (out.emomMovements.length === 0) return null;
  }
  // Optional reference-only time cap (e.g. "For Time, 20 min cap") — shown
  // in the log form, never enforced or scored against.
  const cap = cleanNum(w.timeCapSeconds, 0, LIMITS.minutes * 60 + 59, 0);
  out.timeCapSeconds = cap || null;
  return out;
}
function sanitizeEntry(e) {
  if (!e || typeof e !== "object") return null;
  const id = cleanId(e.id), exerciseId = cleanId(e.exerciseId), date = cleanISODate(e.date);
  if (!id || !exerciseId || !date) return null;
  const sets = cleanNum(e.sets, 0, LIMITS.sets, null);
  if (sets === null) return null;
  // "duration" entries (holds/carries) skip reps/est1RM entirely — a hold has
  // no rep count, and est1RM extrapolation is meaningless for time-under-load.
  // Weight stays optional (0 for a bodyweight hold, >0 for a weighted carry).
  const type = e.type === "duration" ? "duration" : "reps";
  const groupId = cleanId(e.groupId) || null;
  // Optional free tag ("A"/"B"/"C"/"D") for real A/B/C session-block
  // programming — set once per ladder/superset group, see ladderBlockLabel.
  const blockLabel = cleanStr(e.blockLabel, 8) || null;
  if (type === "duration") {
    const durationSeconds = cleanNum(e.durationSeconds, 1, LIMITS.duration, null);
    if (durationSeconds === null) return null;
    const weight = cleanNum(e.weight, 0, LIMITS.weight, 0);
    return {
      id, exerciseId, date, type, weight, reps: 0, sets: Math.round(sets),
      durationSeconds: Math.round(durationSeconds),
      ts: cleanTs(e.ts), isPR: e.isPR === true, groupId, blockLabel, est1RM: 0,
    };
  }
  const weight = cleanNum(e.weight, 0, LIMITS.weight, null);
  const reps = cleanNum(e.reps, 0, LIMITS.reps, null);
  if (weight === null || reps === null) return null;
  return {
    id, exerciseId, date, type, weight, reps, sets: Math.round(sets),
    durationSeconds: 0,
    ts: cleanTs(e.ts), isPR: e.isPR === true,
    // Links several rows saved as one working-set ladder or superset (same
    // groupId, one or two exerciseIds, same day) so the calendar day view
    // can group them — see renderCalDetail. null for an ordinary single set.
    groupId, blockLabel,
    est1RM: cleanNum(e.est1RM, 0, LIMITS.weight * 2, estimate1RM(weight, reps)),
  };
}
function sanitizeWodEntry(e) {
  if (!e || typeof e !== "object") return null;
  const id = cleanId(e.id), wodId = cleanId(e.wodId), date = cleanISODate(e.date);
  if (!id || !wodId || !date) return null;
  const scoreType = WOD_SCORE_TYPES.includes(e.scoreType) ? e.scoreType : "time";
  // EMOM has no cross-attempt scoring (yet) — never let a hand-edited import
  // claim a PR flame for it.
  const out = { id, wodId, date, scoreType, ts: cleanTs(e.ts), rx: e.rx !== false, isPR: scoreType === "emom" ? false : e.isPR === true };
  if (scoreType === "time") out.timeSeconds = cleanNum(e.timeSeconds, 0, LIMITS.minutes * 60 + 59, 0);
  else if (scoreType === "amrap") {
    out.rounds = Math.round(cleanNum(e.rounds, 0, LIMITS.rounds, 0));
    out.reps = Math.round(cleanNum(e.reps, 0, LIMITS.reps, 0));
  } else if (scoreType === "emom") {
    // No fixed movement count to validate against here (the WOD record that
    // defines it may not even be loaded yet during import) — just clamp
    // whatever array of rep counts came in; renderWodLogSection resizes it
    // to match the WOD's own movement count whenever it's actually shown.
    const reps = Array.isArray(e.emomReps) ? e.emomReps : [];
    out.emomReps = reps.slice(0, LIMITS.emomMovements).map((r) => Math.round(cleanNum(r, 0, LIMITS.reps, 0)));
  } else out.weight = cleanNum(e.weight, 0, LIMITS.weight, 0);
  if (!out.rx) {
    const sw = cleanNum(e.scaledWeight, 0, LIMITS.weight, 0);
    if (sw) out.scaledWeight = sw;
    const notes = cleanStr(e.notes, LIMITS.notesLen);
    out.notes = notes || null;
  }
  // Applies regardless of Rx/Scaled — a partner WOD is a partner WOD either way.
  out.partnerTag = cleanStr(e.partnerTag, LIMITS.partnerTag) || null;
  return out;
}
function sanitizeBodyweight(e) {
  if (!e || typeof e !== "object") return null;
  const id = cleanId(e.id), date = cleanISODate(e.date);
  const weight = cleanNum(e.weight, 0, LIMITS.bodyweight, null);
  if (!id || !date || weight === null) return null;
  return { id, date, weight, ts: cleanTs(e.ts) };
}
function sanitizeMeasureType(t) {
  if (!t || typeof t !== "object") return null;
  const id = cleanId(t.id), name = cleanStr(t.name, LIMITS.nameLen);
  if (!id || !name) return null;
  return { id, name };
}
function sanitizeMeasurement(e) {
  if (!e || typeof e !== "object") return null;
  const id = cleanId(e.id), typeId = cleanId(e.typeId), date = cleanISODate(e.date);
  const value = cleanNum(e.value, 0, LIMITS.measurement, null);
  if (!id || !typeId || !date || value === null) return null;
  return { id, typeId, date, value, ts: cleanTs(e.ts) };
}
function sanitizeList(list, fn) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, LIMITS.importItems).map(fn).filter(Boolean);
}

let customMovements = [];
function allMovements() { return MOVEMENTS.concat(customMovements); }
function movementById(id) { return allMovements().find((m) => m.id === id); }

// ---------- IndexedDB ----------
// Deliberately distinct from the real production app's own database name.
// Both apps are served from the same GitHub Pages origin (haimuniya.
// github.io), just different paths, and IndexedDB is scoped per-origin,
// not per-path — reusing that name would mean a real member's local
// training data and this demo's community/social code share one database.
const DB_NAME = "haimunia-demo-db", STORE = "entries", MOVSTORE = "movements", WODSTORE = "wodEntries", CUSTOMWODSTORE = "customWods", BWSTORE = "bodyweight", SETTINGSTORE = "settings", MEASTYPESTORE = "measureTypes", MEASSTORE = "measurements", OUTBOXSTORE = "syncOutbox";
let _dbPromise = null;
let syncApplyingRemote = false;
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 8);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(MOVSTORE)) db.createObjectStore(MOVSTORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(WODSTORE)) db.createObjectStore(WODSTORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(CUSTOMWODSTORE)) db.createObjectStore(CUSTOMWODSTORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(BWSTORE)) db.createObjectStore(BWSTORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SETTINGSTORE)) db.createObjectStore(SETTINGSTORE, { keyPath: "key" });
      if (!db.objectStoreNames.contains(MEASTYPESTORE)) db.createObjectStore(MEASTYPESTORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(MEASSTORE)) db.createObjectStore(MEASSTORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(OUTBOXSTORE)) db.createObjectStore(OUTBOXSTORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { _dbPromise = null; reject(req.error); };
  });
  return _dbPromise;
}
// Settings live in IndexedDB alongside everything else. userName is the only
// PII in the app and previously sat in localStorage, which "clear all data"
// never touched.
async function dbGetSetting(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(SETTINGSTORE, "readonly").objectStore(SETTINGSTORE).get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => reject(req.error);
  });
}
async function dbSetSetting(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SETTINGSTORE, "readwrite");
    tx.objectStore(SETTINGSTORE).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbClearSettings() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SETTINGSTORE, "readwrite");
    tx.objectStore(SETTINGSTORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbLoadMovements() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MOVSTORE, "readonly");
    const req = tx.objectStore(MOVSTORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function dbAddMovement(m) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MOVSTORE, "readwrite");
    tx.objectStore(MOVSTORE).put(m);
    tx.oncomplete = () => { queueSyncRecord("movement", m); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
async function dbClearMovements() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MOVSTORE, "readwrite");
    tx.objectStore(MOVSTORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbLoadWodEntries() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WODSTORE, "readonly");
    const req = tx.objectStore(WODSTORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function dbPutWodEntry(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WODSTORE, "readwrite");
    tx.objectStore(WODSTORE).put(entry);
    tx.oncomplete = () => { queueSyncRecord("wod_entry", entry); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
async function dbDeleteWodEntry(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WODSTORE, "readwrite");
    tx.objectStore(WODSTORE).delete(id);
    tx.oncomplete = () => { queueSyncRecord("wod_entry", { id }, true); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
async function dbClearWodEntries() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WODSTORE, "readwrite");
    tx.objectStore(WODSTORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbLoadCustomWods() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CUSTOMWODSTORE, "readonly");
    const req = tx.objectStore(CUSTOMWODSTORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function dbAddCustomWod(w) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CUSTOMWODSTORE, "readwrite");
    tx.objectStore(CUSTOMWODSTORE).put(w);
    tx.oncomplete = () => { queueSyncRecord("custom_wod", w); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
async function dbClearCustomWods() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CUSTOMWODSTORE, "readwrite");
    tx.objectStore(CUSTOMWODSTORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbLoadBodyweight() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BWSTORE, "readonly");
    const req = tx.objectStore(BWSTORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function dbPutBodyweight(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BWSTORE, "readwrite");
    tx.objectStore(BWSTORE).put(entry);
    tx.oncomplete = () => { queueSyncRecord("bodyweight", entry); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
async function dbClearBodyweight() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BWSTORE, "readwrite");
    tx.objectStore(BWSTORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbLoadMeasureTypes() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(MEASTYPESTORE, "readonly").objectStore(MEASTYPESTORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function dbAddMeasureType(t) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEASTYPESTORE, "readwrite");
    tx.objectStore(MEASTYPESTORE).put(t);
    tx.oncomplete = () => { queueSyncRecord("measure_type", t); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
async function dbDeleteMeasureType(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEASTYPESTORE, "readwrite");
    tx.objectStore(MEASTYPESTORE).delete(id);
    tx.oncomplete = () => { queueSyncRecord("measure_type", { id }, true); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
async function dbClearMeasureTypes() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEASTYPESTORE, "readwrite");
    tx.objectStore(MEASTYPESTORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbLoadMeasurements() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(MEASSTORE, "readonly").objectStore(MEASSTORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function dbPutMeasurement(m) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEASSTORE, "readwrite");
    tx.objectStore(MEASSTORE).put(m);
    tx.oncomplete = () => { queueSyncRecord("measurement", m); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
async function dbDeleteMeasurement(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEASSTORE, "readwrite");
    tx.objectStore(MEASSTORE).delete(id);
    tx.oncomplete = () => { queueSyncRecord("measurement", { id }, true); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
async function dbClearMeasurements() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEASSTORE, "readwrite");
    tx.objectStore(MEASSTORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbLoadAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function dbPut(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(entry);
    tx.oncomplete = () => { queueSyncRecord("strength_entry", entry); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => { queueSyncRecord("strength_entry", { id }, true); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
async function dbClear() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- State ----------
let entries = [];
const VALID_TABS = ["add", "history", "calendar", "wod", "community"];
const urlTab = new URLSearchParams(location.search).get("tab");
let tab = VALID_TABS.includes(urlTab) ? urlTab : "add";
let selectedId = MOVEMENTS[0].id;
let weight = 20, reps = 5, sets = 1;
// "reps" (weight×reps×sets, the original/default) or "duration" (a timed
// hold/carry — see sanitizeEntry). durationSeconds is that mode's own value,
// kept separate from reps so switching modes never clobbers the other.
let logEntryType = "reps", durationSeconds = 20;
let logDate = todayISO();
// A ladder groups the next saves (different weight/reps each) under one
// groupId, scoped to one exercise/day — see toggleLadderMode() and saveSet().
// Setting ladderPartnerId turns the same group into a superset: exactly two
// exercises alternating rounds under one groupId (see switchLadderExercise
// and openPicker's "partner" target). ladderPrimaryId is fixed at whatever
// selectedId was when the ladder started — selectedId itself keeps changing
// as the user switches between the two exercises, so it can't double as
// "the other one" once they match; these two ids are the stable pair to
// switch between. ladderBlockLabel is an optional free tag ("A"/"B"/"C"/"D")
// for real-world A/B/C session-block programming — set once per group,
// carried by every round saved into it.
let ladderMode = false, ladderGroupId = null, ladderPrimaryId = null, ladderPartnerId = null, ladderBlockLabel = null;
let editingEntryId = null;
// Never allow a future-dated set, even if a user bypasses the date input's
// max attribute (e.g. via devtools) or the device clock is off.
function clampLogDate(v) {
  const clean = cleanISODate(v);
  if (!clean) return todayISO();
  return clean > todayISO() ? todayISO() : clean;
}
let historyId = null;
let historySearch = "";
const now0 = new Date();
let calYear = now0.getFullYear();
let calMonth = now0.getMonth();
let calSelectedDate = todayISO();

// WOD tab state
let wodEntries = [];
let customWods = [];
let wodSubTab = "log";
let selectedWodId = WOD_LIBRARY[0].id;
let wodMinutes = 3, wodSeconds = 0, wodRounds = 5, wodReps = 0, wodWeight = 20;
// EMOM-only: one rep count per movement in the selected WOD's rotation,
// index-aligned with its emomMovements — kept in sync with that WOD's own
// movement count by renderWodLogSection whenever it renders.
let wodEmomReps = [];
let wodRx = true;
let wodScaledWeight = 20;
let wodNotes = "";
// Free-text tag for a partner WOD ("with Dana", a team name, ...) — per
// entry (who you partnered with varies attempt to attempt), unlike
// timeCapSeconds below which describes the WOD itself.
let wodPartnerTag = "";
let wodLogDate = todayISO();
let editingWodEntryId = null;
let emomStateWodId = null;
let wodHistoryId = null;
let wodHistorySearch = "";
let wodBuilderOpen = false;
let builderFormat = null;
let builderMovements = bag();
let builderMoveSearch = "";
// EMOM-only: how many minutes the rotation runs. Movement order/targets for
// an EMOM come from builderMovements itself (insertion order = rotation
// order) — see createWodFromBuilder.
let builderEmomMinutes = 10;
// Optional, any non-EMOM format — reference-only, never enforced. 0 = no cap.
let builderTimeCapMinutes = 0;
let confirmClear = false;
let storageOK = true;
let storageErrMsg = "";
// Surface write failures instead of swallowing them — a user whose saves are
// silently failing otherwise believes the log is being kept.
function noteStorageError(e) {
  storageOK = false;
  const quota = e && (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED");
  storageErrMsg = quota
    ? "אין מקום אחסון פנוי — ייצאו גיבוי ומחקו נתונים ישנים"
    : "השמירה במכשיר נכשלה — הנתונים האחרונים אולי לא נשמרו";
  console.error("storage write failed:", e);
}

// Bodyweight tab state
let bodyweightEntries = [];
let bwWeight = 70;
let bodyweightExpanded = false;

// Body measurements (custom types the user defines, e.g. waist/chest — cm)
let measureTypes = [];
let measureEntries = [];
let measureExpandedId = null;
let measureAddOpen = false;
let measureValues = bag(); // per-type stepper input value, keyed by typeId

let importMessage = "";
let importMsgTimeout = null;
function setImportMessage(msg) {
  importMessage = msg;
  clearTimeout(importMsgTimeout);
  importMsgTimeout = setTimeout(() => { importMessage = ""; render(); }, 5000);
}

// ---------- Derived helpers ----------
function entriesFor(id, excludeId) { return entries.filter((e) => e.exerciseId === id && e.id !== excludeId); }
// Actual logged working sets from the last N days, most recent first, capped
// so a movement trained daily doesn't flood the entry screen. No warm-up
// concept anywhere here — every row is a real set someone saved.
function recentEntriesFor(id, days = 14, cap = 5) {
  const cutoff = localISODate(new Date(Date.now() - days * 86400000));
  return entriesFor(id).filter((e) => e.date >= cutoff).slice(0, cap);
}
function bestEst1RM(id, excludeId) {
  // Duration entries carry est1RM: 0 (see sanitizeEntry) so they can't win
  // this max by accident, but they're filtered explicitly anyway so an
  // exercise logged only as holds correctly reports "no 1RM" (null), not 0.
  const list = entriesFor(id, excludeId).filter((e) => e.type !== "duration");
  return list.length ? Math.max(...list.map((e) => e.est1RM)) : null;
}
function repRecordFor(id, repCount, excludeId) {
  const list = entriesFor(id, excludeId).filter((e) => e.reps === repCount);
  return list.length ? Math.max(...list.map((e) => e.weight)) : null;
}
function bestDurationFor(id, excludeId) {
  const list = entriesFor(id, excludeId).filter((e) => e.type === "duration");
  return list.length ? Math.max(...list.map((e) => e.durationSeconds)) : null;
}
// Which entry type the Log tab's toggle should default to when an exercise
// is (re)selected — follows whatever this exercise was logged as last time,
// so a hold-only movement like a plank doesn't keep resetting to reps mode.
function inferEntryTypeFor(id) {
  const last = entriesFor(id)[0];
  return last && last.type === "duration" ? "duration" : "reps";
}
// Called right after selectedId changes to a fresh exercise (not while
// editing an existing entry — startEditEntry restores type from the entry
// itself instead).
function syncLogEntryTypeToSelection() {
  logEntryType = inferEntryTypeFor(selectedId);
  if (logEntryType === "duration") {
    const last = entriesFor(selectedId)[0];
    durationSeconds = last.durationSeconds || 20;
  }
}
function activeExercises() {
  const ids = [...new Set(entries.map((e) => e.exerciseId))];
  return ids.map(movementById).filter(Boolean);
}

const MOVEMENT_CATEGORIES = ["Squat", "Deadlift", "Press", "Olympic", "Pull", "Other"];

// ---------- Achievements ----------
// Everything here is derived from data already on this device. No server, no
// account, no comparison between athletes — tiers count personal PRs/weeks,
// never absolute kg, so a bronze/silver/gold badge means the same effort
// regardless of who's training.
const ACHIEVEMENT_PR_CATEGORIES = ["Squat", "Deadlift", "Press", "Olympic", "Pull"];
// Same ladder shape everywhere a tier repeats a behavior at a rising bar:
// an accessible first step, then a clean x5 climb - so "gold" always means
// a comparable order of magnitude more effort than "bronze", not an
// arbitrary per-category number.
const PR_TIERS = [{ tier: "bronze", need: 1 }, { tier: "silver", need: 5 }, { tier: "gold", need: 25 }];
// Streaks stay on a calendar ladder instead (month / quarter / half-year) -
// weeks don't take well to a x5 climb, but a shared unit everyone recognizes
// is its own kind of "connected."
const STREAK_TIERS = [{ tier: "bronze", need: 4 }, { tier: "silver", need: 12 }, { tier: "gold", need: 26 }];
const SESSION_MILESTONES = [10, 50, 100, 365];
const TENURE_MILESTONES = [
  { id: "month1", days: 30, label: "חודש בבוקס" },
  { id: "month6", days: 182, label: "חצי שנה בבוקס" },
  { id: "year1", days: 365, label: "שנה בבוקס" },
];
const TIER_LABELS = { bronze: "ברונזה", silver: "כסף", gold: "זהב" };

// Point values follow the same non-linear curve trophy/badge systems (PSN,
// Peloton) use so a tier's weight matches its real rarity instead of every
// badge counting the same: bronze≈2.5x, gold≈7.5x. Every family feeds the
// same score, which is the actual "connect everything" move here - a PR
// badge and an Rx badge both move the same number.
const TIER_POINTS = { bronze: 10, silver: 25, gold: 75 };
const MILESTONE_POINTS = 25;
const RX_POINTS = 15;
const CAPSTONE_POINTS = 200;
// Named like the box's own progression, not borrowed esports tiers - and
// deliberately a different vocabulary than bronze/silver/gold so "you're
// Gold level" (badge tier) and "you're at מתקדם" (overall level) never read
// as the same claim. Thresholds step up non-linearly (Peloton: 0-99 / 100-
// 1999 / 2000-14999), scaled to this app's much smaller point pool.
const ATHLETE_LEVELS = [
  { min: 0, name: "מתחיל" },
  { min: 50, name: "מתמיד" },
  { min: 200, name: "מנוסה" },
  { min: 500, name: "מתקדם" },
  { min: 900, name: "אלוף האימוניה" },
];
function athleteLevel(score) {
  let level = ATHLETE_LEVELS[0];
  for (const l of ATHLETE_LEVELS) { if (score >= l.min) level = l; }
  const idx = ATHLETE_LEVELS.indexOf(level);
  const next = ATHLETE_LEVELS[idx + 1] || null;
  return { name: level.name, min: level.min, next };
}

function categoryPRCounts() {
  const counts = bag();
  const byMovement = bag();
  for (const e of entries) { (byMovement[e.exerciseId] ||= []).push(e); }
  for (const movId of Object.keys(byMovement)) {
    const mov = movementById(movId);
    if (!mov || !ACHIEVEMENT_PR_CATEGORIES.includes(mov.category)) continue;
    // Duration entries carry est1RM: 0 (see sanitizeEntry) — skip them so a
    // hold-only movement (e.g. a dead hang under Pull) can't register a
    // phantom 0kg "PR" the first time it's logged.
    const list = byMovement[movId].filter((e) => e.type !== "duration").sort((a, b) => (a.ts || 0) - (b.ts || 0));
    let max = -Infinity;
    for (const e of list) {
      if (e.est1RM > max) { max = e.est1RM; counts[mov.category] = (counts[mov.category] || 0) + 1; }
    }
  }
  return counts;
}
function loggedDates() { return [...entries.map((e) => e.date), ...wodEntries.map((e) => e.date)]; }
function weekBucket(iso) { return Math.floor(new Date(iso + "T00:00:00").getTime() / 86400000 / 7); }
function longestWeekStreak() {
  const buckets = [...new Set(loggedDates().map(weekBucket))].sort((a, b) => a - b);
  let longest = 0, current = 0, prev = null;
  for (const b of buckets) {
    current = (prev !== null && b === prev + 1) ? current + 1 : 1;
    longest = Math.max(longest, current);
    prev = b;
  }
  return longest;
}
function totalSessions() { return new Set(loggedDates()).size; }
function daysSinceBoxStart() {
  if (!boxStartDate) return null;
  return Math.floor((Date.now() - new Date(boxStartDate + "T00:00:00").getTime()) / 86400000);
}
function earnedRxWodIds() { return new Set(wodEntries.filter((e) => e.rx).map((e) => e.wodId)); }
function loggedCategories() {
  const cats = new Set();
  for (const e of entries) { const m = movementById(e.exerciseId); if (m) cats.add(m.category); }
  return cats;
}
function isWellRounded() {
  const cats = loggedCategories();
  return ACHIEVEMENT_PR_CATEGORIES.every((c) => cats.has(c));
}

function allGoldPRsEarned() { return ACHIEVEMENT_PR_CATEGORIES.every((cat) => (categoryPRCounts()[cat] || 0) >= 25); }
function allTenureEarned() {
  const d = daysSinceBoxStart();
  return d !== null && TENURE_MILESTONES.every((m) => d >= m.days);
}
// Mirrors how a PlayStation Platinum trophy works: one capstone that unlocks
// only once every other top-shelf badge is in, rather than its own separate
// bar to clear. It's the one badge that ties every family together.
function capstoneEarned() {
  return allGoldPRsEarned() && longestWeekStreak() >= 26 && isWellRounded() && allTenureEarned();
}

const ACHIEVEMENTS = [
  {
    id: "capstone", group: "capstone", glyph: "home",
    name: "אלוף האימוניה",
    rule: "זהב בכל קבוצות השיאים + רצף זהב + אתלט שלם + כל עיטורי הוותק",
    earned: capstoneEarned,
    points: CAPSTONE_POINTS,
  },
  ...ACHIEVEMENT_PR_CATEGORIES.flatMap((cat) => PR_TIERS.map((t) => ({
    id: `pr-${cat}-${t.tier}`, group: "pr", tier: t.tier, cat, glyph: "bar",
    name: `${CATEGORY_LABELS[cat]} — ${TIER_LABELS[t.tier]}`,
    rule: `${t.need} ${t.need === 1 ? "שיא אישי" : "שיאים אישיים"} בקבוצת ${CATEGORY_LABELS[cat]}`,
    earned: () => (categoryPRCounts()[cat] || 0) >= t.need,
    points: TIER_POINTS[t.tier],
  }))),
  ...STREAK_TIERS.map((t) => ({
    id: `streak-${t.tier}`, group: "streak", tier: t.tier, glyph: "chevrons",
    name: `רצף — ${TIER_LABELS[t.tier]}`,
    rule: `רצף של ${t.need} שבועות עם רישום`,
    earned: () => longestWeekStreak() >= t.need,
    points: TIER_POINTS[t.tier],
  })),
  ...SESSION_MILESTONES.map((n) => ({
    id: `sessions-${n}`, group: "milestone", glyph: "home",
    name: `${n} אימונים`,
    rule: `${n} ימי אימון מתועדים`,
    earned: () => totalSessions() >= n,
    points: MILESTONE_POINTS,
  })),
  ...TENURE_MILESTONES.map((m) => ({
    id: `tenure-${m.id}`, group: "milestone", glyph: "flame",
    name: m.label,
    rule: `${m.label} מתאריך ההתחלה בבוקס`,
    earned: () => { const d = daysSinceBoxStart(); return d !== null && d >= m.days; },
    points: MILESTONE_POINTS,
  })),
  {
    id: "well-rounded", group: "milestone", glyph: "chevrons",
    name: "אתלט שלם",
    rule: "תרגיל אחד לפחות מכל קבוצה (סקוואט/דדליפט/לחיצה/אולימפי/משיכה)",
    earned: () => isWellRounded(),
    points: MILESTONE_POINTS,
  },
  ...WOD_LIBRARY.map((w) => ({
    id: `rx-${w.id}`, group: "rx", glyph: "bar",
    name: `Rx — ${w.name}`,
    rule: `רישום ראשון של ${w.name} כ-Rx`,
    earned: () => earnedRxWodIds().has(w.id),
    points: RX_POINTS,
  })),
];

function renderMedal(ach, earned) {
  const shape = ach.group === "pr" || ach.group === "streak" ? "shield" : "circle";
  const glowMap = { bronze: "rgba(201,162,39,.7)", silver: "rgba(216,222,228,.8)", gold: "rgba(242,185,12,.8)" };
  const glow = ach.group === "capstone" ? "rgba(255,180,60,.85)"
    : ach.tier ? glowMap[ach.tier]
    : (ach.group === "rx" ? "rgba(62,111,217,.6)" : "rgba(232,93,61,.6)");
  const tierClass = ach.group === "capstone" ? "medal-capstone" : ach.tier ? `tier-${ach.tier}` : (ach.group === "rx" ? "medal-rx" : "medal-milestone");
  const glyphId = ach.glyph === "home" ? "Home" : ach.glyph === "chevrons" ? "Chevrons" : ach.glyph === "bar" ? "Bar" : "Flame";
  const glyphUse = shape === "shield"
    ? `<use href="#glyph${glyphId}" transform="translate(19,16) scale(0.62)"/>`
    : `<use href="#glyph${glyphId}" transform="translate(15,15) scale(0.7)"/>`;
  const plateMap = { bronze: "assets/medal-bronze.png", silver: "assets/medal-silver.png", gold: "assets/medal-gold.png" };
  const symbol = ach.tier
    ? `<div class="medal-shape medal-shape-plate ${tierClass}"><div class="medal-plate"><img src="${plateMap[ach.tier]}" alt="" /><span class="medal-plate-shine" aria-hidden="true"></span></div></div>`
    : shape === "shield"
      ? `<svg class="medal-shape ${tierClass}" viewBox="0 0 100 112"><use href="#medalShield"/>${glyphUse}</svg>`
      : `<svg class="medal-shape shape-circle ${tierClass}" viewBox="0 0 100 100"><use href="#medalCircle"/>${glyphUse}</svg>`;
  // title is a nice-to-have for desktop; it never shows on a touch screen,
  // so locked badges also print the rule as a visible caption.
  return `<div class="medal-badge ${ach.group === "capstone" ? "capstone-badge" : ""} ${earned ? "earned" : "locked"}" style="--glow-color:${glow};" title="${esc(ach.rule)}">
    ${symbol}
    <div class="medal-name">${esc(ach.name)}</div>
    ${earned ? "" : `<div class="medal-rule">${esc(ach.rule)}</div>`}
  </div>`;
}
function renderAchievementsContent() {
  const earnedMap = bag();
  for (const a of ACHIEVEMENTS) earnedMap[a.id] = a.earned();
  const earnedCount = ACHIEVEMENTS.filter((a) => earnedMap[a.id]).length;
  const score = ACHIEVEMENTS.reduce((s, a) => s + (earnedMap[a.id] ? a.points : 0), 0);
  const level = athleteLevel(score);

  const capstoneAch = ACHIEVEMENTS.find((a) => a.group === "capstone");
  const capstoneSection = `
    <div class="ach-section" style="text-align:center;">
      ${renderMedal(capstoneAch, earnedMap[capstoneAch.id])}
    </div>`;

  const prSections = ACHIEVEMENT_PR_CATEGORIES.map((cat) => `
    <div class="ach-section">
      <div class="ach-section-head"><span class="ach-section-dot" style="background:${CATEGORY_COLORS[cat]};"></span><span class="ach-section-title">${esc(CATEGORY_LABELS[cat])}</span></div>
      <div class="ach-row">${ACHIEVEMENTS.filter((a) => a.group === "pr" && a.cat === cat).map((a) => renderMedal(a, earnedMap[a.id])).join("")}</div>
    </div>`).join("");

  const streakSection = `
    <div class="ach-section">
      <div class="ach-section-head"><span class="ach-section-dot" style="background:var(--energy);"></span><span class="ach-section-title">רצף אימונים</span></div>
      <div class="ach-row">${ACHIEVEMENTS.filter((a) => a.group === "streak").map((a) => renderMedal(a, earnedMap[a.id])).join("")}</div>
    </div>`;

  const boxStartPrompt = boxStartDate ? "" : `
    <button data-action="open-profile-from-achievements" class="card flex items-center justify-between gap-10" style="width:100%; text-align:right; margin-bottom:12px;">
      <span style="font-size:12.5px; color:var(--chalk); font-weight:600;">הוסיפו תאריך התחלה בבוקס כדי לפתוח את עיטורי הוותק</span>
      <span style="color:var(--steel); flex-shrink:0;">${ICONS.chevronsLeft}</span>
    </button>`;

  const milestoneSection = `
    <div class="ach-section">
      <div class="ach-section-head"><span class="ach-section-dot" style="background:var(--brass);"></span><span class="ach-section-title">אבני דרך</span></div>
      ${boxStartPrompt}
      <div class="ach-grid">${ACHIEVEMENTS.filter((a) => a.group === "milestone").map((a) => renderMedal(a, earnedMap[a.id])).join("")}</div>
    </div>`;

  const rxSection = `
    <div class="ach-section">
      <div class="ach-section-head"><span class="ach-section-dot" style="background:var(--blue);"></span><span class="ach-section-title">Rx לכל אימון</span></div>
      <div class="ach-grid">${ACHIEVEMENTS.filter((a) => a.group === "rx").map((a) => renderMedal(a, earnedMap[a.id])).join("")}</div>
    </div>`;

  const progressToNext = level.next
    ? `<div class="ach-level-bar"><div class="ach-level-fill" style="width:${Math.min(100, Math.round(((score - level.min) / (level.next.min - level.min)) * 100))}%;"></div></div>
       <div class="ach-summary-label">${level.next.min - score} נקודות עד ${esc(level.next.name)}</div>`
    : `<div class="ach-summary-label">הדרגה הגבוהה ביותר</div>`;

  return `
    <div class="ach-summary">
      <div class="ach-summary-level">${esc(level.name)}</div>
      <div class="ach-summary-num mono">${score} נקודות</div>
      ${progressToNext}
      <div class="ach-summary-label" style="margin-top:8px;">${earnedCount} / ${ACHIEVEMENTS.length} עיטורים</div>
    </div>
    ${capstoneSection}
    ${prSections}${streakSection}${milestoneSection}${rxSection}
  `;
}
function openAchievements() {
  document.body.style.overflow = "hidden";
  document.getElementById("achievementsOverlay").classList.add("open");
  document.getElementById("achievementsList").innerHTML = renderAchievementsContent();
}
function closeAchievements() {
  document.body.style.overflow = "";
  document.getElementById("achievementsOverlay").classList.remove("open");
}

// Which badges the athlete has already been shown a celebration for, so a
// save only pops the modal for what's genuinely new this time.
const SEEN_ACHIEVEMENTS_KEY = "haimunia-demo:seenAchievements";
let seenAchievementIds = new Set();
async function loadSeenAchievements() {
  try {
    const v = await dbGetSetting(SEEN_ACHIEVEMENTS_KEY);
    if (Array.isArray(v)) { seenAchievementIds = new Set(v); return; }
  } catch (e) { /* fall through to baseline */ }
  // First time this ships: baseline whatever's already earned silently, so
  // existing progress doesn't trigger a flood of celebrations on next open.
  seenAchievementIds = new Set(ACHIEVEMENTS.filter((a) => a.earned()).map((a) => a.id));
  dbSetSetting(SEEN_ACHIEVEMENTS_KEY, [...seenAchievementIds]).catch(() => {});
}
function newlyEarnedAchievements() {
  return ACHIEVEMENTS.filter((a) => a.earned() && !seenAchievementIds.has(a.id));
}
function checkForNewAchievements() {
  const newlyEarned = newlyEarnedAchievements();
  if (!newlyEarned.length) return;
  for (const a of newlyEarned) seenAchievementIds.add(a.id);
  dbSetSetting(SEEN_ACHIEVEMENTS_KEY, [...seenAchievementIds]).catch(noteStorageError);
  showCelebration(null, newlyEarned);
}
// prLabel: a short "Exercise — 92.5 kg" style string when this save itself
// was a personal record, or null. Badges and a plain PR can land in the
// same save (a PR that also crosses a tier threshold) - one popup covers
// both instead of firing twice back to back.
function celebrateAfterSave(prLabel) {
  const newBadges = newlyEarnedAchievements();
  if (!prLabel && !newBadges.length) return;
  for (const a of newBadges) seenAchievementIds.add(a.id);
  if (newBadges.length) dbSetSetting(SEEN_ACHIEVEMENTS_KEY, [...seenAchievementIds]).catch(noteStorageError);
  showCelebration(prLabel, newBadges);
}
function showCelebration(prLabel, badges) {
  const title = document.getElementById("celebrationTitle");
  if (title) title.textContent = badges.length ? "כל הכבוד!" : "שיא אישי חדש!";
  const prLine = document.getElementById("celebrationPrLine");
  if (prLine) {
    prLine.textContent = prLabel || "";
    prLine.style.display = prLabel ? "block" : "none";
  }
  const medalsEl = document.getElementById("celebrationMedals");
  if (medalsEl) medalsEl.innerHTML = badges.map((a) => renderMedal(a, true)).join("");
  const shareEl = document.getElementById("celebrationShare");
  if (shareEl) {
    // Achievement unlocks aren't durable local records the way strength/WOD
    // entries are, so they can't join communityShareCandidates() — this is
    // a transient share offer, only for the badges just earned, only shown
    // if the community layer is actually signed in.
    const canShare = badges.length && typeof window.isCommunitySignedIn === "function" && window.isCommunitySignedIn();
    shareEl.innerHTML = canShare
      ? badges.map((a) => `<button class="link-btn" data-action="share-achievement" data-id="${esc(a.id)}" data-title="${esc(a.name)}" data-rule="${esc(a.rule)}">שיתוף ${esc(a.name)} בקהילה</button>`).join(" · ")
      : "";
  }
  const sub = document.getElementById("celebrationSub");
  if (sub) {
    sub.textContent = badges.length
      ? (badges.length > 1 ? `${badges.length} עיטורים חדשים נפתחו — תמשיכו ככה!` : "עיטור חדש נפתח — תמשיכו ככה!")
      : "תמשיכו ככה!";
  }
  document.body.style.overflow = "hidden";
  document.getElementById("celebrationOverlay").classList.add("open");
}
function closeCelebration() {
  document.body.style.overflow = "";
  document.getElementById("celebrationOverlay").classList.remove("open");
}

// ---------- Update notifications ----------
// Short, user-facing changelog — deliberately separate from CHANGES.md,
// which is developer-facing, technical, and in English. Only add an entry
// here when something a member would actually notice shipped; not every
// version bump needs one. Same list backs both the auto-shown "what's new"
// popup and the bell icon's persistent history — see openNotifications().
const RELEASE_NOTES = [
  { version: "2.24.0", date: "2026-08-25", items: [
    "אפשר לרשום סופרסט — שני תרגילים לסירוגין תחת אותו סולם, עם תווית בלוק (A/B/C/D) לתוכניות מסודרות",
    "פורמט EMOM חדש באימונים: בונים סבב תרגילים מתחלף ורושמים חזרות לכל תרגיל בנפרד",
    "אפשר להוסיף מגבלת זמן ותג פרטנר לאימונים",
  ] },
  { version: "2.23.0", date: "2026-08-25", items: [
    "אפשר לרשום גם תרגילי החזקה בזמן (כמו פלאנק או תלייה) — לא רק משקל וחזרות",
  ] },
  { version: "2.22.0", date: "2026-08-25", items: [
    "הקשה על \"אימון אחרון\" ממלאת אוטומטית את המשקל והחזרות",
    "סטים בסולם (כמה סטים ברצף, כל אחד במשקל שונה) — עכשיו קל יותר למצוא ולהשתמש",
  ] },
];
function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}
const LAST_SEEN_VERSION_KEY = "haimunia-demo:lastSeenVersion";
let lastSeenVersion = null;
async function loadLastSeenVersion() {
  try {
    const v = await dbGetSetting(LAST_SEEN_VERSION_KEY);
    lastSeenVersion = typeof v === "string" ? v : null;
  } catch (e) { lastSeenVersion = null; }
}
function markNotificationsSeen() {
  lastSeenVersion = APP_VERSION;
  dbSetSetting(LAST_SEEN_VERSION_KEY, APP_VERSION).catch(noteStorageError);
}
function unseenReleaseNotes() {
  if (!lastSeenVersion) return [];
  return RELEASE_NOTES.filter((r) => compareVersions(r.version, lastSeenVersion) > 0);
}
function renderNotificationsList() {
  const el = document.getElementById("notificationsList");
  if (!el) return;
  if (!RELEASE_NOTES.length) {
    el.innerHTML = `<div class="empty">אין עדכונים עדיין</div>`;
    return;
  }
  const unseen = new Set(unseenReleaseNotes().map((r) => r.version));
  el.innerHTML = RELEASE_NOTES.slice().reverse().map((r) => `
    <div class="cat-group">
      <div class="cat-head flex items-center gap-8">
        <span class="cat-name mono" style="direction:ltr; unicode-bidi:isolate;">${esc(r.version)}</span>
        ${unseen.has(r.version) ? `<span style="background:var(--energy); color:#fff; font-size:10px; font-weight:800; border-radius:10px; padding:2px 8px;">חדש</span>` : ""}
        <span style="color:var(--steel); font-size:11px; margin-inline-start:auto;">${esc(fmtDate(r.date))}</span>
      </div>
      <ul style="margin:6px 0 4px; padding-inline-start:20px; color:var(--chalk); font-size:13.5px; line-height:1.6;">
        ${r.items.map((i) => `<li>${esc(i)}</li>`).join("")}
      </ul>
    </div>`).join("");
}
function updateNotificationsBadge() {
  const badge = document.getElementById("notificationsBadge");
  if (!badge) return;
  const count = unseenReleaseNotes().length;
  badge.textContent = count > 9 ? "9+" : String(count);
  badge.style.display = count > 0 ? "flex" : "none";
}
function openNotifications() {
  renderNotificationsList();
  document.body.style.overflow = "hidden";
  document.getElementById("notificationsOverlay").classList.add("open");
  if (unseenReleaseNotes().length) { markNotificationsSeen(); updateNotificationsBadge(); }
}
function closeNotifications() {
  document.body.style.overflow = "";
  document.getElementById("notificationsOverlay").classList.remove("open");
}

// ---------- First-time onboarding ----------
const HAS_ONBOARDED_KEY = "haimunia-demo:hasOnboarded";
let hasOnboarded = true; // default true so existing devices never see it by accident
async function loadOnboardedFlag() {
  try {
    const v = await dbGetSetting(HAS_ONBOARDED_KEY);
    hasOnboarded = v === true;
  } catch (e) { hasOnboarded = true; }
}
function openOnboarding() {
  document.body.style.overflow = "hidden";
  document.getElementById("onboardingOverlay").classList.add("open");
}
function closeOnboarding() {
  hasOnboarded = true;
  dbSetSetting(HAS_ONBOARDED_KEY, true).catch(noteStorageError);
  document.body.style.overflow = "";
  document.getElementById("onboardingOverlay").classList.remove("open");
}

async function addMovement(name, category) {
  const trimmed = cleanStr(name, LIMITS.nameLen);
  if (!trimmed) return;
  const existing = allMovements().find((m) => m.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) {
    choosePickedMovement(existing.id);
    closePicker();
    render();
    return;
  }
  // Collision-free and charset-safe. The old slug scheme collapsed to a bare
  // "custom--<ts>" for Hebrew names, since the regex stripped every character.
  const id = uid("custom");
  const movement = { id, name: trimmed, category: MOVEMENT_CATEGORIES.includes(category) ? category : "Other" };
  customMovements.push(movement);
  try { await dbAddMovement(movement); } catch (e) { noteStorageError(e); }
  choosePickedMovement(id);
  closePicker();
  render();
}
async function saveSet() {
  const date = clampLogDate(logDate);
  const editId = editingEntryId;
  const existing = editId ? entries.find((e) => e.id === editId) : null;
  // Editing keeps the row's original group/label; a fresh save only joins
  // the active ladder/superset (if any) — see toggleLadderMode().
  const groupId = existing ? (existing.groupId ?? null) : (ladderMode ? ladderGroupId : null);
  const blockLabel = existing ? (existing.blockLabel ?? null) : (ladderMode ? ladderBlockLabel : null);
  let entry, isPR, celebrationLabel;
  if (logEntryType === "duration") {
    if (!isFinite(durationSeconds) || durationSeconds <= 0 || !isFinite(sets)) return;
    const prevBest = bestDurationFor(selectedId, editId) || 0;
    isPR = durationSeconds > prevBest;
    entry = {
      id: existing ? existing.id : uid("set"),
      ts: existing ? existing.ts : Date.now(),
      exerciseId: selectedId, type: "duration", weight, reps: 0, sets,
      durationSeconds, date, isPR, est1RM: 0, groupId, blockLabel,
    };
    celebrationLabel = `${weight ? weight + ' ק"ג × ' : ""}${formatDuration(durationSeconds)}`;
  } else {
    if (!isFinite(weight) || !isFinite(reps) || !isFinite(sets)) return;
    const prevRepRecord = repRecordFor(selectedId, reps, editId) || 0;
    const prevEst1RM = bestEst1RM(selectedId, editId) || 0;
    const est = estimate1RM(weight, reps);
    isPR = weight > prevRepRecord || est > prevEst1RM;
    entry = {
      id: existing ? existing.id : uid("set"),
      ts: existing ? existing.ts : Date.now(),
      exerciseId: selectedId, type: "reps", weight, reps, sets, date, isPR, est1RM: est,
      durationSeconds: 0, groupId, blockLabel,
    };
    celebrationLabel = `${weight} ק"ג × ${reps}`;
  }
  entries = entries.filter((e) => e.id !== entry.id);
  entries.unshift(entry);
  entries.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  try { await dbPut(entry); storageOK = true; } catch (e) { noteStorageError(e); }
  editingEntryId = null;
  // Mid-ladder, keep the date fixed so every rung lands on the same day —
  // otherwise this reset-to-today would silently misdate rungs 2+ of a
  // ladder logged for a past date.
  if (!ladderMode) logDate = todayISO();
  if (isPR) flashPR();
  render();
  // The full-screen popup is disruptive mid-ladder — an ascending ladder's
  // rungs routinely all beat the previous best est1RM, which would otherwise
  // mean one popup per rung. The barbell flash above still shows a PR inline
  // either way; if this same set unlocks a badge later (once ladder mode is
  // off), that celebration still fires normally then.
  if (!ladderMode) {
    const mov = movementById(entry.exerciseId);
    celebrateAfterSave(isPR && mov ? `${mov.name} — ${celebrationLabel}` : null);
  }
}
// A ladder (working-set session: same exercise/day, different weight+reps
// each rung) is just consecutive saveSet() calls tagged with one groupId —
// see saveSet(). Turning ladder mode on starts a fresh group; turning it
// off (here or via endLadder()) only stops future saves from joining it,
// rounds already saved keep their tag.
function toggleLadderMode() {
  if (ladderMode) {
    const count = currentLadderRounds().length;
    const wasSuperset = !!ladderPartnerId;
    endLadder();
    if (count > 0) {
      const label = wasSuperset ? "הסופרסט" : "הסולם";
      setImportMessage(count === 1 ? `${label} נשמר — סט אחד` : `${label} נשמר — ${count} סטים`);
    }
    render();
    return;
  }
  ladderMode = true;
  ladderGroupId = uid("ladder");
  ladderPrimaryId = selectedId;
  ladderPartnerId = null;
  ladderBlockLabel = null;
  render();
}
function endLadder() {
  if (!ladderMode) return;
  ladderMode = false;
  ladderGroupId = null;
  ladderPrimaryId = null;
  ladderPartnerId = null;
  ladderBlockLabel = null;
}

async function queueSyncRecord(recordType, record, deleted = false) {
  if (syncApplyingRemote) return;
  if (!record || !record.id) return;
  const row = { id: `${recordType}:${record.id}`, recordType, recordId: record.id, payload: deleted ? {} : record, deleted, queuedAt: Date.now() };
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(OUTBOXSTORE, "readwrite");
      tx.objectStore(OUTBOXSTORE).put(row);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    window.dispatchEvent(new Event("haimunia-sync-needed"));
  } catch (e) { noteStorageError(e); }
}
async function dbLoadSyncOutbox() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(OUTBOXSTORE, "readonly").objectStore(OUTBOXSTORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function dbDeleteSyncOutbox(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOXSTORE, "readwrite");
    tx.objectStore(OUTBOXSTORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function queueAllLocalRecordsForSync() {
  const groups = [["movement", customMovements], ["custom_wod", customWods], ["strength_entry", entries], ["wod_entry", wodEntries], ["bodyweight", bodyweightEntries], ["measure_type", measureTypes], ["measurement", measureEntries]];
  for (const [type, list] of groups) for (const record of list) await queueSyncRecord(type, record);
}
async function applyRemotePrivateRecord(row) {
  if (!row || !row.record_type || !row.record_id) return;
  const deleted = !!row.deleted_at;
  const payload = row.payload || {};
  const clean = row.record_type === "movement" ? sanitizeMovement(payload)
    : row.record_type === "custom_wod" ? sanitizeCustomWod(payload)
    : row.record_type === "strength_entry" ? sanitizeEntry(payload)
    : row.record_type === "wod_entry" ? sanitizeWodEntry(payload)
    : row.record_type === "bodyweight" ? sanitizeBodyweight(payload)
    : row.record_type === "measure_type" ? sanitizeMeasureType(payload)
    : row.record_type === "measurement" ? sanitizeMeasurement(payload) : null;
  if (!deleted && !clean) return;
  syncApplyingRemote = true;
  try {
    if (row.record_type === "movement") deleted ? await dbDeleteMovementRecord(row.record_id) : await dbAddMovement(clean);
    else if (row.record_type === "custom_wod") deleted ? await dbDeleteCustomWod(row.record_id) : await dbAddCustomWod(clean);
    else if (row.record_type === "strength_entry") deleted ? await dbDelete(row.record_id) : await dbPut(clean);
    else if (row.record_type === "wod_entry") deleted ? await dbDeleteWodEntry(row.record_id) : await dbPutWodEntry(clean);
    else if (row.record_type === "bodyweight" && !deleted) await dbPutBodyweight(clean);
    else if (row.record_type === "measure_type") deleted ? await dbDeleteMeasureType(row.record_id) : await dbAddMeasureType(clean);
    else if (row.record_type === "measurement") deleted ? await dbDeleteMeasurement(row.record_id) : await dbPutMeasurement(clean);
  } finally { syncApplyingRemote = false; }
}
async function dbDeleteMovementRecord(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MOVSTORE, "readwrite");
    tx.objectStore(MOVSTORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function endEntryEditIfActive() {
  if (!editingEntryId) return;
  editingEntryId = null;
  logDate = todayISO();
}

function endWodEditIfActive() {
  if (!editingWodEntryId) return;
  editingWodEntryId = null;
  wodLogDate = todayISO();
}
// Adds (or would-be-adds) a second exercise to the active ladder, turning it
// into a superset — exactly two exercises alternating rounds under one
// groupId. A no-op if the picked exercise is the same as the primary one
// (a superset needs two distinct movements) or no ladder is running.
function setLadderPartner(id) {
  if (!ladderMode || !id || id === ladderPrimaryId) return;
  ladderPartnerId = id;
  render();
}
// Switches which of the superset's two exercises the next save is for,
// without ending the ladder (unlike the normal exercise picker, which
// always ends it — see pick-movement). ladderPrimaryId/ladderPartnerId are
// the fixed pair to switch between — selectedId itself can't play that role
// since it becomes equal to whichever one is currently active.
function switchLadderExercise(id) {
  if (!ladderMode || !ladderPartnerId) return;
  if (id !== ladderPrimaryId && id !== ladderPartnerId) return;
  selectedId = id;
  syncLogEntryTypeToSelection();
  render();
}
function setLadderBlockLabel(label) {
  if (!ladderMode) return;
  ladderBlockLabel = ["A", "B", "C", "D"].includes(label) ? label : null;
  render();
}
function setLogEntryType(t) {
  const type = t === "duration" ? "duration" : "reps";
  if (type === logEntryType) return;
  logEntryType = type;
  endLadder();
  render();
}
function currentLadderRounds() {
  if (!ladderGroupId) return [];
  return entries.filter((e) => e.groupId === ladderGroupId).sort((a, b) => (a.ts || 0) - (b.ts || 0));
}
// This app is filled in after a workout, not during one — reconstructing a
// session from memory (or a whiteboard scribble) usually means numbers
// close to last time, not random ones. Tapping the "last session" card
// copies them into the steppers as a starting point instead of everyone
// re-dragging from whatever was left over from the previous save.
function prefillFromLast() {
  // Matches the currently toggled mode, not just whatever was logged most
  // recently — prefilling reps numbers into a duration hold (or vice versa)
  // would be meaningless.
  const wantDuration = logEntryType === "duration";
  const last = entriesFor(selectedId).find((e) => (e.type === "duration") === wantDuration);
  if (!last) return;
  weight = last.weight;
  sets = last.sets;
  if (wantDuration) durationSeconds = last.durationSeconds;
  else reps = last.reps;
  render();
}
function startEditEntry(id) {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;
  selectedId = entry.exerciseId;
  logEntryType = entry.type === "duration" ? "duration" : "reps";
  weight = entry.weight;
  reps = entry.reps;
  sets = entry.sets;
  if (entry.durationSeconds) durationSeconds = entry.durationSeconds;
  logDate = entry.date;
  editingEntryId = entry.id;
  tab = "add";
  // Editing an entry can switch exercise and date out from under an active
  // ladder the same way pick-movement/reset-log-date do — without this, the
  // toggle would keep advertising a ladder for a now-unrelated exercise/date.
  // Exception: fixing a typo in one of the active ladder's own rounds should
  // NOT end it — selectedId/logDate already match, and doing so would strand
  // anyone who just wants to correct set 3 and keep adding set 6 afterward.
  if (!ladderGroupId || entry.groupId !== ladderGroupId) endLadder();
  render();
}
function cancelEditEntry() {
  editingEntryId = null;
  logDate = todayISO();
  render();
}
async function deleteEntry(id) {
  entries = entries.filter((e) => e.id !== id);
  if (editingEntryId === id) { editingEntryId = null; logDate = todayISO(); }
  try { await dbDelete(id); } catch (e) { noteStorageError(e); }
  render();
}

// ---------- Bodyweight ----------
async function saveBodyweight() {
  if (!isFinite(bwWeight)) return;
  const today = todayISO();
  const existing = bodyweightEntries.find((e) => e.date === today);
  const entry = existing
    ? { ...existing, weight: bwWeight, ts: Date.now() }
    : { id: uid("bw"), date: today, ts: Date.now(), weight: bwWeight };
  bodyweightEntries = bodyweightEntries.filter((e) => e.id !== entry.id);
  bodyweightEntries.unshift(entry);
  try { await dbPutBodyweight(entry); storageOK = true; } catch (e) { noteStorageError(e); }
  render();
}

// ---------- Body measurements (custom, user-named, cm) ----------
function measureTypesSorted() { return measureTypes.slice().sort((a, b) => a.name.localeCompare(b.name)); }
function measureEntriesFor(typeId) { return measureEntries.filter((e) => e.typeId === typeId); }
function latestMeasurement(typeId) {
  const list = measureEntriesFor(typeId).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return list.length ? list[0] : null;
}
async function addMeasureType(name) {
  const trimmed = cleanStr(name, LIMITS.nameLen);
  if (!trimmed) return;
  const existing = measureTypes.find((t) => t.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) {
    measureExpandedId = existing.id;
    measureAddOpen = false;
    renderMeasureArea();
    return;
  }
  const type = { id: uid("meas-type"), name: trimmed };
  measureTypes.push(type);
  try { await dbAddMeasureType(type); } catch (e) { noteStorageError(e); }
  measureValues[type.id] = 0;
  measureExpandedId = type.id;
  measureAddOpen = false;
  renderMeasureArea();
}
async function deleteMeasureType(id) {
  measureTypes = measureTypes.filter((t) => t.id !== id);
  const toDelete = measureEntriesFor(id).map((e) => e.id);
  measureEntries = measureEntries.filter((e) => e.typeId !== id);
  if (measureExpandedId === id) measureExpandedId = null;
  try {
    await dbDeleteMeasureType(id);
    for (const eid of toDelete) await dbDeleteMeasurement(eid);
  } catch (e) { noteStorageError(e); }
  renderMeasureArea();
}
async function saveMeasurement(typeId) {
  const value = measureValues[typeId];
  if (typeof value !== "number" || !isFinite(value) || value <= 0) return;
  const today = todayISO();
  const existing = measureEntries.find((e) => e.typeId === typeId && e.date === today);
  const entry = existing
    ? { ...existing, value, ts: Date.now() }
    : { id: uid("meas"), typeId, date: today, value, ts: Date.now() };
  measureEntries = measureEntries.filter((e) => e.id !== entry.id);
  measureEntries.unshift(entry);
  try { await dbPutMeasurement(entry); storageOK = true; } catch (e) { noteStorageError(e); }
  renderMeasureArea();
}
async function deleteMeasurementEntry(id) {
  measureEntries = measureEntries.filter((e) => e.id !== id);
  try { await dbDeleteMeasurement(id); } catch (e) { noteStorageError(e); }
  renderMeasureArea();
}

const USER_NAME_KEY = "haimunia-demo:userName";
let userName = null;
async function loadUserName() {
  try {
    const stored = await dbGetSetting(USER_NAME_KEY);
    if (stored !== null && stored !== undefined) { userName = cleanStr(stored, LIMITS.nameLen); return; }
  } catch (e) { /* fall through to migration */ }
  // one-time migration off localStorage
  let legacy = null;
  try { legacy = localStorage.getItem(USER_NAME_KEY); } catch (e) {}
  if (legacy !== null) {
    userName = cleanStr(legacy, LIMITS.nameLen);
    try { await dbSetSetting(USER_NAME_KEY, userName); } catch (e) {}
    try { localStorage.removeItem(USER_NAME_KEY); } catch (e) {}
  }
}

// Box-tenure badges need the athlete's actual join date, not their first log
// - someone can start using the app long after they joined the box, and
// firstLogDate would silently measure "time using this app" instead.
const BOX_START_KEY = "haimunia-demo:boxStartDate";
let boxStartDate = null;
async function loadBoxStartDate() {
  try {
    const v = await dbGetSetting(BOX_START_KEY);
    boxStartDate = v ? cleanISODate(v) : null;
  } catch (e) { /* keep the default */ }
}

function renderUserGreeting() {
  const el = document.getElementById("userGreeting");
  if (!el) return;
  el.innerHTML = userName ? `<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">שלום ${esc(userName)}</span>${ICONS.chevronsLeft}` : "";
  if (userName) el.setAttribute("aria-label", `שלום ${userName} — פתיחת עיטורים והישגים`);
  else el.removeAttribute("aria-label");
}
let welcomeEditing = false;
function openWelcomeModal(editing) {
  welcomeEditing = !!editing;
  document.body.style.overflow = "hidden";
  const overlay = document.getElementById("welcomeOverlay");
  if (overlay) overlay.classList.add("open");
  const title = document.getElementById("welcomeTitle");
  const subtitle = document.getElementById("welcomeSubtitle");
  const saveLabel = document.getElementById("welcomeSaveLabel");
  const skipBtn = document.getElementById("welcomeSkipBtn");
  if (title) title.textContent = welcomeEditing ? "עריכת פרופיל" : "ברוכים הבאים!";
  if (subtitle) subtitle.textContent = "איך נקרא לך?";
  if (saveLabel) saveLabel.textContent = welcomeEditing ? "שמירה" : "בואו נתחיל";
  if (skipBtn) {
    skipBtn.textContent = welcomeEditing ? "ביטול" : "דלג";
    skipBtn.dataset.action = welcomeEditing ? "cancel-welcome-name" : "skip-user-name";
  }
  const input = document.getElementById("welcomeNameInput");
  if (input) {
    input.value = welcomeEditing ? (userName || "") : "";
    setTimeout(() => input.focus(), 50);
  }
  const boxInput = document.getElementById("welcomeBoxStartInput");
  if (boxInput) {
    boxInput.max = todayISO();
    boxInput.value = welcomeEditing ? (boxStartDate || "") : "";
  }
}
function closeWelcomeModal() {
  document.body.style.overflow = "";
  const overlay = document.getElementById("welcomeOverlay");
  if (overlay) overlay.classList.remove("open");
}
function saveUserName(name) {
  const trimmed = cleanStr(name, LIMITS.nameLen);
  userName = trimmed;
  dbSetSetting(USER_NAME_KEY, trimmed).catch(noteStorageError);
  closeWelcomeModal();
  renderUserGreeting();
}
function saveBoxStartDate(v) {
  const cleaned = v ? cleanISODate(v) : null;
  const today = todayISO();
  boxStartDate = (cleaned && cleaned <= today) ? cleaned : null;
  dbSetSetting(BOX_START_KEY, boxStartDate).catch(noteStorageError);
}
// Saves both welcome-modal fields together, so hitting Enter in the name
// field or skipping the name doesn't discard a box-start-date the user
// already picked.
function saveWelcomeForm(name) {
  const wasFirstTimeWelcome = !welcomeEditing;
  const boxInput = document.getElementById("welcomeBoxStartInput");
  saveBoxStartDate(boxInput ? boxInput.value : "");
  saveUserName(name);
  // After the modal has closed, in case a box-start-date typed in for the
  // first time (member since before they ever opened this app) instantly
  // qualifies for tenure badges.
  checkForNewAchievements();
  // Only the very first welcome (not "edit profile" later) triggers the
  // onboarding walkthrough — openOnboarding() itself no-ops via
  // hasOnboarded for anyone who's already seen it.
  if (wasFirstTimeWelcome && !hasOnboarded) openOnboarding();
}

const BAR_WEIGHT_KEY = "haimunia-demo:barWeight";
async function loadBarWeight() {
  try {
    const stored = await dbGetSetting(BAR_WEIGHT_KEY);
    if (BAR_OPTIONS.includes(stored)) barWeight = stored;
  } catch (e) { /* keep the default */ }
}
function setBarWeight(kg) {
  if (!BAR_OPTIONS.includes(kg)) return;
  barWeight = kg;
  dbSetSetting(BAR_WEIGHT_KEY, kg).catch(noteStorageError);
  // Total can never be less than the bar itself - bump it up if needed so the
  // barbell visual actually changes even if the user never touches "weight".
  if (weight < barWeight) weight = barWeight;
  updateLogQuickUI("weight");
  const barRow = document.getElementById("barWeightRow");
  if (barRow) barRow.outerHTML = renderBarWeightRow();
}

// Theme preference lives in localStorage, not IndexedDB — it has to be
// readable synchronously by theme-init.js before first paint, and it isn't
// user training data, so "clear all data" deliberately leaves it alone.
const THEME_KEY = "haimunia-demo:theme";
let themePref = "dark";
function loadThemePref() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark" || stored === "auto") themePref = stored;
  } catch (e) { /* keep the default */ }
}
function resolvedTheme() {
  if (themePref !== "auto") return themePref;
  return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
}
function syncThemeColorMeta() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", resolvedTheme() === "light" ? "#F2F5FA" : "#152342");
}
function applyThemePref() {
  const root = document.documentElement;
  if (themePref === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", themePref);
  syncThemeColorMeta();
}
function setThemePref(pref) {
  if (pref !== "light" && pref !== "dark" && pref !== "auto") return;
  themePref = pref;
  try { localStorage.setItem(THEME_KEY, pref); } catch (e) {}
  applyThemePref();
  const row = document.getElementById("themeRow");
  if (row) row.outerHTML = renderThemeRow();
}
function renderThemeRow() {
  const opts = [["dark", "כהה"], ["light", "בהיר"], ["auto", "אוטומטי"]];
  return `<div id="themeRow" class="flex items-center justify-center gap-8" role="radiogroup" aria-label="מראה" style="margin-bottom:8px;">
    ${opts.map(([val, label]) => `<button class="link-btn" data-action="set-theme" data-pref="${val}" role="radio" aria-checked="${themePref === val}" style="${themePref === val ? "color:var(--chalk); font-weight:700; text-decoration:none;" : ""}">${label}</button>`).join('<span style="color:var(--border); font-size:11px;" aria-hidden="true">·</span>')}
  </div>`;
}

const LAST_EXPORT_KEY = "haimunia-demo:lastExportAt";
let lastExportAt = null;
async function loadLastExport() {
  try {
    const v = await dbGetSetting(LAST_EXPORT_KEY);
    if (v) { lastExportAt = Number(v); return; }
  } catch (e) {}
  try {
    const legacy = localStorage.getItem(LAST_EXPORT_KEY);
    if (legacy) {
      lastExportAt = Number(legacy);
      await dbSetSetting(LAST_EXPORT_KEY, lastExportAt).catch(() => {});
      localStorage.removeItem(LAST_EXPORT_KEY);
    }
  } catch (e) {}
}
function markExported() {
  lastExportAt = Date.now();
  dbSetSetting(LAST_EXPORT_KEY, lastExportAt).catch(() => {});
}
function daysSinceLastExport() {
  if (!lastExportAt || !isFinite(lastExportAt)) return null;
  return Math.floor((Date.now() - lastExportAt) / 86400000);
}
const BACKUP_APP_ID = "box-log";
const BACKUP_VERSION = 1;

function buildBackupPayload() {
  return {
    app: BACKUP_APP_ID,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    entries,
    customMovements,
    wodEntries,
    customWods,
    bodyweightEntries,
    measureTypes,
    measureEntries,
  };
}

function downloadBackup(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the download a tick to start before tearing down the blob URL.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return true;
}

function exportData() {
  downloadBackup(buildBackupPayload(), `box-log-backup-${todayISO()}.json`);
  markExported();
  render();
}

const MAX_BACKUP_BYTES = 25 * 1024 * 1024;

function triggerImport() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", () => {
    if (input.files && input.files[0]) importDataFromFile(input.files[0]);
  });
  input.click();
}

// A backup file is untrusted input — it may have been edited, corrupted, or
// received from someone else. Every record is rebuilt field by field from a
// whitelist; nothing from the file object is ever stored or rendered as-is.
async function importDataFromFile(file) {
  const bad = (msg) => { setImportMessage(msg || "הייבוא נכשל — הקובץ אינו קובץ גיבוי תקין"); render(); };

  if (!file || file.size > MAX_BACKUP_BYTES) {
    return bad("הייבוא נכשל — הקובץ גדול מדי (מעל 25MB)");
  }

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) { return bad(); }
  if (!data || typeof data !== "object" || Array.isArray(data)) return bad();
  if (data.app !== BACKUP_APP_ID) return bad("הייבוא נכשל — הקובץ אינו גיבוי של האימוניה");
  if (Number(data.version) > BACKUP_VERSION) {
    return bad("הייבוא נכשל — הגיבוי נוצר בגרסה חדשה יותר של האפליקציה");
  }

  const clean = {
    customMovements: sanitizeList(data.customMovements, sanitizeMovement),
    customWods: sanitizeList(data.customWods, sanitizeCustomWod),
    entries: sanitizeList(data.entries, sanitizeEntry),
    wodEntries: sanitizeList(data.wodEntries, sanitizeWodEntry),
    bodyweightEntries: sanitizeList(data.bodyweightEntries, sanitizeBodyweight),
    measureTypes: sanitizeList(data.measureTypes, sanitizeMeasureType),
    measureEntries: sanitizeList(data.measureEntries, sanitizeMeasurement),
  };
  const incoming = Object.values(clean).reduce((n, l) => n + l.length, 0);
  const rawCount = ["customMovements", "customWods", "entries", "wodEntries", "bodyweightEntries", "measureTypes", "measureEntries"]
    .reduce((n, k) => n + (Array.isArray(data[k]) ? data[k].length : 0), 0);
  const rejected = Math.max(0, rawCount - incoming);

  if (incoming === 0) return bad("הייבוא נכשל — לא נמצאו רשומות תקינות בקובץ");

  // The import merges into existing data and cannot be undone from inside the
  // app, so confirm first and drop a rollback backup on the way in.
  const hasExisting = entries.length || wodEntries.length || bodyweightEntries.length || customMovements.length || customWods.length || measureTypes.length;
  const question = hasExisting
    ? `הייבוא יוסיף ${incoming} רשומות לנתונים הקיימים ולא ניתן לבטל אותו.\nלפני כן יורד גיבוי של המצב הנוכחי.\n\nלהמשיך?`
    : `לייבא ${incoming} רשומות?`;
  if (!window.confirm(question)) { setImportMessage("הייבוא בוטל"); render(); return; }

  if (hasExisting) {
    try { downloadBackup(buildBackupPayload(), `box-log-rollback-${todayISO()}.json`); } catch (e) {}
  }

  let ok = 0, failed = 0;
  const write = async (list, fn) => {
    for (const rec of list) {
      try { await fn(rec); ok++; } catch (e) { failed++; if (failed === 1) noteStorageError(e); }
    }
  };
  await write(clean.customMovements, dbAddMovement);
  await write(clean.customWods, dbAddCustomWod);
  await write(clean.entries, dbPut);
  await write(clean.wodEntries, dbPutWodEntry);
  await write(clean.bodyweightEntries, dbPutBodyweight);
  await write(clean.measureTypes, dbAddMeasureType);
  await write(clean.measureEntries, dbPutMeasurement);

  await reloadFromDb();

  const parts = [`יובאו ${ok} רשומות`];
  if (rejected) parts.push(`${rejected} נפסלו`);
  if (failed) parts.push(`${failed} נכשלו בשמירה`);
  setImportMessage(parts.join(", "));
  render();
}

// Single source of truth for pulling state out of IndexedDB. Everything is
// re-sanitized on the way in, so records written by an older build of the app
// cannot poison the render path either.
async function reloadFromDb() {
  try {
    entries = sanitizeList(await dbLoadAll(), sanitizeEntry).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    customMovements = sanitizeList(await dbLoadMovements(), sanitizeMovement);
    wodEntries = sanitizeList(await dbLoadWodEntries(), sanitizeWodEntry).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    customWods = sanitizeList(await dbLoadCustomWods(), sanitizeCustomWod);
    bodyweightEntries = sanitizeList(await dbLoadBodyweight(), sanitizeBodyweight).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    if (bodyweightEntries[0]) bwWeight = bodyweightEntries[0].weight;
    measureTypes = sanitizeList(await dbLoadMeasureTypes(), sanitizeMeasureType);
    measureEntries = sanitizeList(await dbLoadMeasurements(), sanitizeMeasurement);
    storageOK = true;
    storageErrMsg = "";
    return true;
  } catch (e) {
    noteStorageError(e);
    return false;
  }
}

async function clearAllData() {
  endLadder();
  entries = [];
  wodEntries = [];
  customMovements = [];
  customWods = [];
  bodyweightEntries = [];
  measureTypes = [];
  measureEntries = [];
  measureValues = bag();
  try {
    await dbClear();
    await dbClearWodEntries();
    await dbClearMovements();
    await dbClearCustomWods();
    await dbClearBodyweight();
    await dbClearMeasureTypes();
    await dbClearMeasurements();
    // "delete everything" must also drop the stored name and export marker.
    await dbClearSettings();
    try { localStorage.removeItem(USER_NAME_KEY); localStorage.removeItem(LAST_EXPORT_KEY); } catch (e) {}
    userName = null;
    boxStartDate = null;
    seenAchievementIds = new Set();
    lastExportAt = null;
  } catch (e) {
    noteStorageError(e);
  }
  selectedId = MOVEMENTS[0].id;
  historyId = null;
  selectedWodId = WOD_LIBRARY[0].id;
  wodHistoryId = null;
  bwWeight = 70;
  barWeight = 20;
  measureExpandedId = null;
  measureAddOpen = false;
  logDate = todayISO();
  editingEntryId = null;
  wodLogDate = todayISO();
  editingWodEntryId = null;
  confirmClear = false;
  renderUserGreeting();
  render();
  if (userName === null) openWelcomeModal();
}

// ---------- WOD helpers & actions ----------
function allWods() { return WOD_LIBRARY.concat(customWods); }
function wodById(id) { return allWods().find((w) => w.id === id); }
function wodEntriesFor(id, excludeId) { return wodEntries.filter((e) => e.wodId === id && e.id !== excludeId); }
function recentWodEntriesFor(id, days = 14, cap = 5) {
  const cutoff = localISODate(new Date(Date.now() - days * 86400000));
  return wodEntriesFor(id).filter((e) => e.date >= cutoff).slice(0, cap);
}
function activeWods() {
  const ids = [...new Set(wodEntries.map((e) => e.wodId))];
  return ids.map(wodById).filter(Boolean);
}
function formatClock(totalSeconds) {
  const m = Math.floor(totalSeconds / 60), s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
function scoreValue(e) {
  if (e.scoreType === "time") return e.timeSeconds;
  if (e.scoreType === "amrap") return e.rounds * 1000 + e.reps;
  if (e.scoreType === "emom") return 0; // no single comparable score — see bestWodScore
  return e.weight;
}
function bestWodScore(id, excludeId) {
  const w = wodById(id);
  // EMOM has no cross-attempt scoring yet: consistency (did every round)
  // matters more than a single number, and there's no agreed way to reduce
  // "10 reps of A, 8 of B" to one comparable value. No PR concept for it.
  if (w.scoreType === "emom") return null;
  const list = wodEntriesFor(id, excludeId);
  if (!list.length) return null;
  if (w.scoreType === "time") return Math.min(...list.map(scoreValue));
  return Math.max(...list.map(scoreValue));
}
function formatWodEntry(e) {
  const base = e.scoreType === "time" ? formatClock(e.timeSeconds)
    : e.scoreType === "amrap" ? `${e.rounds}+${e.reps}`
    : e.scoreType === "emom" ? (e.emomReps || []).join(" · ")
    : `${e.weight} kg`;
  return (!e.rx && e.scaledWeight) ? `${base} @ ${e.scaledWeight}kg` : base;
}
function lastScaledAttempt(id) {
  const list = wodEntriesFor(id).filter((e) => !e.rx).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return list.length ? list[0] : null;
}
function formatWodBest(id) {
  const w = wodById(id);
  const best = bestWodScore(id);
  if (best === null) return "—";
  if (w.scoreType === "time") return formatClock(best);
  if (w.scoreType === "amrap") return `${Math.floor(best / 1000)}+${best % 1000}`;
  return `${best} kg`;
}

async function addCustomWod(name, scoreType, desc, extra) {
  const trimmed = cleanStr(name, LIMITS.nameLen);
  if (!trimmed) return;
  if (!WOD_SCORE_TYPES.includes(scoreType)) return;
  const existing = allWods().find((w) => w.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) { choosePickedWod(existing.id); closeWodPicker(); closeWodBuilder(); render(); return; }
  const id = uid("customwod");
  // extra carries scoreType-specific structured fields (currently just EMOM's
  // movement rotation — see sanitizeCustomWod) that, unlike every other
  // format, aren't fully representable as free text alone.
  const wod = { id, name: trimmed, category: "Custom", scoreType, desc: cleanStr(desc, LIMITS.notesLen), ...(extra || {}) };
  customWods.push(wod);
  try { await dbAddCustomWod(wod); } catch (e) { noteStorageError(e); }
  choosePickedWod(id);
  closeWodPicker();
  closeWodBuilder();
  render();
}

function communityShareCandidates() {
  const strength = entries.slice(0, 5).map((entry) => {
    const movement = movementById(entry.exerciseId);
    if (!movement) return null;
    const duration = entry.type === "duration";
    return { type: "strength_entry", id: entry.id, title: movement.name,
      resultText: duration ? `${formatDuration(entry.durationSeconds)}${entry.weight ? ` @ ${entry.weight} kg` : ""}` : `${entry.weight} kg × ${entry.reps} × ${entry.sets}`,
      comparisonKey: `movement:${entry.exerciseId}:${duration ? "duration" : "est1rm"}`,
      scoreValue: duration ? entry.durationSeconds : entry.est1RM, scoreDirection: "higher", occurredOn: entry.date, rx: null };
  }).filter(Boolean);
  const wods = wodEntries.slice(0, 5).map((entry) => {
    const wod = wodById(entry.wodId);
    if (!wod) return null;
    return { type: "wod_entry", id: entry.id, title: wod.name, resultText: formatWodEntry(entry),
      comparisonKey: entry.scoreType === "emom" ? null : `wod:${entry.wodId}:${entry.scoreType}:${entry.rx ? "rx" : "scaled"}`,
      scoreValue: entry.scoreType === "emom" ? null : scoreValue(entry),
      scoreDirection: entry.scoreType === "time" ? "lower" : entry.scoreType === "emom" ? null : "higher", occurredOn: entry.date, rx: entry.rx };
  }).filter(Boolean);
  return strength.concat(wods).sort((a, b) => b.occurredOn.localeCompare(a.occurredOn)).slice(0, 8);
}

const TEXT_SCALE_KEY = "haimunia-demo:textScale";
let textScalePref = "normal";
function loadTextScalePref() {
  let stored = "normal";
  try { stored = localStorage.getItem(TEXT_SCALE_KEY) || "normal"; } catch (e) {}
  textScalePref = stored === "large" ? "large" : "normal";
}
function applyTextScalePref() {
  if (textScalePref === "large") document.documentElement.setAttribute("data-text-scale", "large");
  else document.documentElement.removeAttribute("data-text-scale");
}
function setTextScalePref(pref) {
  if (pref !== "normal" && pref !== "large") return;
  textScalePref = pref;
  try { localStorage.setItem(TEXT_SCALE_KEY, pref); } catch (e) {}
  applyTextScalePref();
  const row = document.getElementById("textScaleRow");
  if (row) row.outerHTML = renderTextScaleRow();
}
function renderTextScaleRow() {
  const opts = [["normal", "רגיל"], ["large", "גדול"]];
  return `<div id="textScaleRow" class="flex items-center justify-center gap-8" role="radiogroup" aria-label="גודל טקסט" style="margin-bottom:8px;">
    ${opts.map(([val, label]) => `<button class="link-btn" data-action="set-text-scale" data-pref="${val}" role="radio" aria-checked="${textScalePref === val}" style="${textScalePref === val ? "color:var(--chalk); font-weight:700; text-decoration:none;" : ""}">${label}</button>`).join('<span style="color:var(--border); font-size:11px;" aria-hidden="true">·</span>')}
  </div>`;
}

async function dbDeleteCustomWod(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CUSTOMWODSTORE, "readwrite");
    tx.objectStore(CUSTOMWODSTORE).delete(id);
    tx.oncomplete = () => { queueSyncRecord("custom_wod", { id }, true); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteCustomWod(id) {
  const wod = customWods.find((item) => item.id === id);
  if (!wod || wod.category !== "Custom" || wodEntriesFor(id).length) return false;
  customWods = customWods.filter((item) => item.id !== id);
  if (selectedWodId === id) selectedWodId = null;
  if (wodHistoryId === id) wodHistoryId = null;
  renderWodPickerList("");
  render();
  try { await dbDeleteCustomWod(id); } catch (e) {
    customWods.push(wod);
    noteStorageError(e);
    render();
    return false;
  }
  return true;
}

// ---------- WOD builder ----------
function openWodBuilder(prefillName) {
  wodBuilderOpen = true;
  builderFormat = null;
  builderMovements = bag();
  builderMoveSearch = "";
  builderEmomMinutes = 10;
  builderTimeCapMinutes = 0;
  document.body.style.overflow = "hidden";
  const overlay = document.getElementById("wodBuilderOverlay");
  overlay.style.height = (window.visualViewport ? window.visualViewport.height : window.innerHeight) + "px";
  overlay.classList.add("open");
  document.getElementById("wodBuilderName").value = prefillName || "";
  const moveSearch = document.getElementById("wodBuilderMoveSearch");
  if (moveSearch) moveSearch.value = "";
  renderWodBuilderMovements("");
  renderWodBuilderFormats();
}
function closeWodBuilder() {
  wodBuilderOpen = false;
  document.body.style.overflow = "";
  const overlay = document.getElementById("wodBuilderOverlay");
  if (overlay) overlay.classList.remove("open");
}
function renderWodBuilderFormats() {
  document.querySelectorAll("#wodBuilderFormats .format-chip").forEach((btn) => {
    const active = btn.dataset.format === builderFormat;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-checked", String(active));
    btn.style.borderColor = "";
  });
  const hint = document.getElementById("wodBuilderFormatHint");
  if (hint) {
    hint.textContent = "חובה לבחור אחד";
    hint.style.color = "var(--steel)";
  }
  const isEmom = builderFormat === "emom";
  const emomEl = document.getElementById("wodBuilderEmomOptions");
  if (emomEl) {
    emomEl.innerHTML = isEmom ? `
      <div style="color:var(--steel); font-size:11px; font-weight:700; letter-spacing:.5px; margin-bottom:6px;">כמה דקות</div>
      <div class="steppers" style="margin-bottom:16px;">${renderStepper("emomMinutes", "דקות", builderEmomMinutes, 1, 1, "builder-emom-minutes")}</div>
    ` : "";
  }
  const movesLabel = document.getElementById("wodBuilderMovesLabel");
  if (movesLabel) movesLabel.textContent = isEmom ? "תרגילים (סדר הסיבוב — לפי סדר הבחירה)" : "תרגילים (אופציונלי)";
  // Reference-only, shown for every format except EMOM (which already has
  // its own minutes) — never enforced or scored against, see saveWod().
  const capEl = document.getElementById("wodBuilderTimeCapOptions");
  if (capEl) {
    capEl.innerHTML = (builderFormat && !isEmom) ? `
      <div style="color:var(--steel); font-size:11px; font-weight:700; letter-spacing:.5px; margin-bottom:6px;">מגבלת זמן (אופציונלי, 0 = ללא)</div>
      <div class="steppers" style="margin-bottom:16px;">${renderStepper("timeCapMinutes", "דקות", builderTimeCapMinutes, 1, 0, "builder-time-cap")}</div>
    ` : "";
  }
}
function renderWodBuilderMovements(query) {
  const el = document.getElementById("wodBuilderMovements");
  if (!el) return;
  if (typeof query === "string") builderMoveSearch = query;
  const q = builderMoveSearch.trim().toLowerCase();
  const filtered = WOD_MOVEMENT_TAGS.filter((m) => m.name.toLowerCase().includes(q));
  const exactMatch = WOD_MOVEMENT_TAGS.some((m) => m.name.toLowerCase() === q);
  const byCategory = bag();
  filtered.forEach((m) => { (byCategory[m.category] = byCategory[m.category] || []).push(m); });
  const addRow = builderMoveSearch.trim() && !exactMatch
    ? `<div style="border:1px solid var(--brass); border-radius:12px; padding:10px 12px; margin-bottom:10px;">
         <div style="font-weight:700; font-size:13px; color:var(--brass); margin-bottom:8px;">הוספת "${esc(builderMoveSearch.trim())}" — לאיזו קטגוריה?</div>
         <div class="flex wrap gap-8">
           ${WOD_MOVE_CATEGORIES.map((cat) => `<button class="format-chip" style="flex:0 0 auto; padding:8px 14px;" data-action="add-builder-movement-tag" data-name="${esc(builderMoveSearch.trim())}" data-category="${cat}">${esc(catLabel(cat))}</button>`).join("")}
         </div>
       </div>`
    : `<button class="movement-btn" data-action="focus-wod-builder-search" style="border-color:var(--brass); margin-bottom:10px;">
         <span style="font-weight:700; font-size:14px; color:var(--brass);">+ הוספת תרגיל/סקילס חדש</span>
       </button>`;
  if (Object.keys(byCategory).length === 0) {
    el.innerHTML = addRow + (builderMoveSearch.trim() ? `<div style="color:var(--steel); text-align:center; padding:16px 0; font-size:13px;">לא נמצא תרגיל התואם ל-"${esc(builderMoveSearch)}"</div>` : "");
    return;
  }
  el.innerHTML = addRow + Object.entries(byCategory).map(([cat, items]) => `
    <div class="cat-group">
      <div class="cat-head"><div class="dot" style="background:${esc(catColor(cat))}"></div><span class="cat-name">${esc(catLabel(cat))}</span></div>
      ${items.map((m) => {
        const checked = Object.prototype.hasOwnProperty.call(builderMovements, m.name);
        const data = builderMovements[m.name] || { reps: 10, weight: 0, type: "reps", durationSeconds: 20 };
        const isEmom = builderFormat === "emom";
        const hasWeight = !isEmom && WOD_MOVE_CATEGORIES_WITH_WEIGHT.has(m.category);
        const isDuration = !isEmom && data.type === "duration";
        // EMOM movements are reps-only (no weight/duration toggle) — the
        // rotation order itself (shown here) carries the structure, and
        // keeping every station the same simple shape keeps the log form
        // straightforward too. See renderWodLogSection.
        const rotationNum = isEmom && checked ? Object.keys(builderMovements).indexOf(m.name) + 1 : null;
        return `
        <button class="movecheck-row ${checked ? "checked" : ""}" data-action="toggle-builder-movement" data-name="${esc(m.name)}" role="checkbox" aria-checked="${checked}">
          <span style="font-weight:600; font-size:14px;">${rotationNum ? `${rotationNum}. ` : ""}${esc(m.name)}</span>
          <div class="movecheck-box">${checked ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#1a1a1a" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>' : ""}</div>
        </button>
        ${checked && !isEmom ? `
        <div class="flex gap-8" style="margin:-2px 0 6px; padding:0 2px;" role="radiogroup" aria-label="חזרות או זמן — ${esc(m.name)}">
          <button class="format-chip ${!isDuration ? "active" : ""}" style="flex:0 0 auto; padding:6px 12px; font-size:11.5px;" data-action="toggle-builder-movement-type" data-name="${esc(m.name)}" data-type="reps" role="radio" aria-checked="${!isDuration}">חזרות</button>
          <button class="format-chip ${isDuration ? "active" : ""}" style="flex:0 0 auto; padding:6px 12px; font-size:11.5px;" data-action="toggle-builder-movement-type" data-name="${esc(m.name)}" data-type="duration" role="radio" aria-checked="${isDuration}">זמן</button>
        </div>
        <div class="flex" style="gap:8px; margin:0 0 10px; padding:0 2px;">
          ${isDuration ? renderStepper(m.name, "שניות", data.durationSeconds, 5, 1, "builder-movement-duration") : renderStepper(m.name, "חזרות", data.reps, 1, 0, "builder-movement-reps")}
          ${hasWeight ? renderStepper(m.name, "ק\"ג", data.weight, 2.5, 0, "builder-movement-weight") : ""}
        </div>` : ""}
        ${checked && isEmom ? `
        <div style="width:50%; margin:-2px 0 10px; padding:0 2px;">
          ${renderStepper(m.name, "חזרות בכל סבב", data.reps, 1, 0, "builder-movement-reps")}
        </div>` : ""}`;
      }).join("")}
    </div>`).join("");
}
function toggleBuilderMovement(name) {
  if (Object.prototype.hasOwnProperty.call(builderMovements, name)) delete builderMovements[name];
  else builderMovements[name] = { reps: 10, weight: 0, type: "reps", durationSeconds: 20 };
  renderWodBuilderMovements();
}
function setBuilderMovementType(name, type) {
  if (!builderMovements[name]) return;
  builderMovements[name].type = type === "duration" ? "duration" : "reps";
  renderWodBuilderMovements();
}
function createWodFromBuilder() {
  const nameInput = document.getElementById("wodBuilderName");
  const name = nameInput ? cleanStr(nameInput.value, LIMITS.nameLen) : "";
  if (!name) { nameInput.focus(); return; }
  if (!builderFormat) {
    const hint = document.getElementById("wodBuilderFormatHint");
    if (hint) {
      hint.textContent = "יש לבחור פורמט למעלה כדי להמשיך";
      hint.style.color = "var(--red)";
    }
    document.querySelectorAll("#wodBuilderFormats .format-chip").forEach((btn) => {
      btn.style.borderColor = "var(--red)";
    });
    return;
  }
  if (builderFormat === "emom") {
    const emomMovements = Object.keys(builderMovements);
    if (emomMovements.length === 0) {
      const hint = document.getElementById("wodBuilderFormatHint");
      if (hint) { hint.textContent = "יש לבחור לפחות תרגיל אחד לסיבוב"; hint.style.color = "var(--red)"; }
      return;
    }
    const emomTargetReps = emomMovements.map((n) => builderMovements[n].reps);
    addCustomWod(name, "emom", emomWodDesc(builderEmomMinutes, emomMovements, emomTargetReps), {
      emomMinutes: builderEmomMinutes, emomMovements, emomTargetReps,
    });
    return;
  }
  addCustomWod(name, builderFormat, builderMovementsToDesc(builderMovements), {
    timeCapSeconds: builderTimeCapMinutes > 0 ? builderTimeCapMinutes * 60 : null,
  });
}
// Pure by design, same reasoning as builderMovementsToDesc — a compact,
// human-readable summary of the rotation for the WOD picker/log header.
function emomWodDesc(minutes, movements, targetReps) {
  return `EMOM ${minutes}: ${movements.map((n, i) => `${targetReps[i]} ${n}`).join(" / ")}`;
}
// Pure by design (no DOM/state reads) so it's directly testable — the
// builder's per-movement reps/weight/duration fields are never stored as
// structured data on the WOD itself, only baked into this free-text desc.
function builderMovementsToDesc(movements) {
  return Object.entries(movements)
    .map(([name, d]) => d.type === "duration"
      ? `${formatDuration(d.durationSeconds)} ${name}${d.weight ? ` @ ${d.weight}kg` : ""}`
      : `${d.reps} ${name}${d.weight ? ` @ ${d.weight}kg` : ""}`)
    .join(", ");
}

async function saveWod() {
  const w = wodById(selectedWodId);
  if (!isFinite(wodMinutes) || !isFinite(wodSeconds) || !isFinite(wodRounds) || !isFinite(wodReps) || !isFinite(wodWeight) || !isFinite(wodScaledWeight)) return;
  if (w.scoreType === "emom" && !wodEmomReps.every((r) => isFinite(r))) return;
  const editId = editingWodEntryId;
  const existing = editId ? wodEntries.find((e) => e.id === editId) : null;
  const prevBest = bestWodScore(selectedWodId, editId);
  const entry = {
    id: existing ? existing.id : uid("wod"),
    ts: existing ? existing.ts : Date.now(),
    date: clampLogDate(wodLogDate),
    wodId: selectedWodId,
    scoreType: w.scoreType,
    rx: wodRx,
  };
  if (w.scoreType === "time") entry.timeSeconds = wodMinutes * 60 + wodSeconds;
  else if (w.scoreType === "amrap") { entry.rounds = wodRounds; entry.reps = wodReps; }
  else if (w.scoreType === "emom") entry.emomReps = wodEmomReps.slice();
  else entry.weight = wodWeight;
  entry.notes = wodNotes.trim() || null;
  entry.scaledWeight = !wodRx ? wodScaledWeight : null;
  entry.partnerTag = cleanStr(wodPartnerTag, LIMITS.partnerTag) || null;

  // EMOM has no cross-attempt scoring (yet) — see bestWodScore/scoreValue.
  const val = scoreValue(entry);
  const isPR = w.scoreType === "emom" ? false : (prevBest === null || (w.scoreType === "time" ? val < prevBest : val > prevBest));
  entry.isPR = isPR;

  wodEntries = wodEntries.filter((e) => e.id !== entry.id);
  wodEntries.unshift(entry);
  wodEntries.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  try { await dbPutWodEntry(entry); storageOK = true; } catch (e) { noteStorageError(e); }
  wodNotes = "";
  wodPartnerTag = "";
  editingWodEntryId = null;
  wodLogDate = todayISO();
  if (isPR) flashWodPR();
  render();
  celebrateAfterSave(isPR ? `${w.name} — ${formatWodEntry(entry)}` : null);
}
function startEditWodEntry(id) {
  const entry = wodEntries.find((e) => e.id === id);
  if (!entry) return;
  const w = wodById(entry.wodId);
  if (!w) return;
  selectedWodId = entry.wodId;
  emomStateWodId = entry.scoreType === "emom" ? entry.wodId : null;
  wodRx = entry.rx;
  wodNotes = entry.notes || "";
  wodPartnerTag = entry.partnerTag || "";
  wodScaledWeight = entry.scaledWeight || 20;
  if (entry.scoreType === "time") { wodMinutes = Math.floor((entry.timeSeconds || 0) / 60); wodSeconds = (entry.timeSeconds || 0) % 60; }
  else if (entry.scoreType === "amrap") { wodRounds = entry.rounds || 0; wodReps = entry.reps || 0; }
  else if (entry.scoreType === "emom") wodEmomReps = (entry.emomReps || []).slice();
  else wodWeight = entry.weight || 0;
  wodLogDate = entry.date;
  editingWodEntryId = entry.id;
  tab = "wod";
  wodSubTab = "log";
  render();
}
function cancelEditWodEntry() {
  editingWodEntryId = null;
  wodLogDate = todayISO();
  wodNotes = "";
  wodPartnerTag = "";
  render();
}
async function deleteWodEntry(id) {
  wodEntries = wodEntries.filter((e) => e.id !== id);
  if (editingWodEntryId === id) { editingWodEntryId = null; wodLogDate = todayISO(); }
  try { await dbDeleteWodEntry(id); } catch (e) { noteStorageError(e); }
  render();
}

let wodPrFlashTimeout = null;
function flashWodPR() {
  const el = document.getElementById("wodFlashBox");
  if (!el) return;
  el.style.display = "flex";
  clearTimeout(wodPrFlashTimeout);
  wodPrFlashTimeout = setTimeout(() => { if (el) el.style.display = "none"; }, 1400);
}

let prFlashTimeout = null;
function flashPR() {
  const el = document.getElementById("barWrap");
  if (!el) return;
  el.classList.add("pr");
  const flash = document.getElementById("prFlash");
  if (flash) flash.style.display = "flex";
  clearTimeout(prFlashTimeout);
  prFlashTimeout = setTimeout(() => {
    el.classList.remove("pr");
    if (flash) flash.style.display = "none";
  }, 1400);
}

function showUpdateBanner() {
  const el = document.getElementById("updateBanner");
  if (el) el.style.display = "block";
  dismissInstallBanner();
}

// ---------- Icons ----------
const ICONS = {
  flame: '<svg width="15" height="15" viewBox="0 0 24 24" fill="var(--brass)" stroke="none"><path d="M12 2c3 4-2 5-2 9a4 4 0 0 0 8 0c0-2-1-3-1-3s2 1 2 5a7 7 0 1 1-14 0c0-5 4-7 7-11z"/></svg>',
  trash: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
  edit: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  dumbbell: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--border)" stroke-width="2" stroke-linecap="round"><path d="M4 9v6M20 9v6M2 10v4M22 10v4M7 12h10"/></svg>',
  chevron: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--steel)" stroke-width="2" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>',
  up: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.2" stroke-linecap="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>',
  down: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--steel)" stroke-width="2.2" stroke-linecap="round"><path d="M3 7l6 6 4-4 8 8"/><path d="M14 17h7v-7"/></svg>',
  flat: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--steel)" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
  chevronsLeft: '<img src="./assets/icon-chevrons.png" alt="" width="11" height="10" style="transform:scaleX(-1); vertical-align:middle;" />',
  ladder: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3v18M18 3v18M6 8h12M6 13h12M6 18h12"/></svg>',
  repeat: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  bell: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
  calendarIcon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  chartIcon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20V12M12 20V4M20 20v-7"/></svg>',
  stopwatchIcon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6M12 2v3"/></svg>',
};

// ---------- Rendering ----------
function renderBarWeightRow() {
  return `<div id="barWeightRow">
    <div style="color:var(--steel); font-size:11px; font-weight:700; letter-spacing:.5px; margin-bottom:6px;" id="barWeightLabel">משקל המוט</div>
    <div class="flex gap-8" style="margin-bottom:12px;" role="radiogroup" aria-labelledby="barWeightLabel">
      ${BAR_OPTIONS.map((kg) => `<button class="format-chip ${barWeight === kg ? "active" : ""}" data-action="set-bar-weight" data-kg="${kg}" role="radio" aria-checked="${barWeight === kg}">${kg} ק"ג</button>`).join("")}
    </div>
  </div>`;
}
function renderBarbell(w) {
  const plates = calcPlates(w);
  const left = [...plates].reverse();
  const right = plates;
  const renderSide = (list) => list.map((p) =>
    `<div class="plate" style="width:${p.w}px;height:${p.h}px;background:${p.color};"></div>`
  ).join("");
  return `
    <div class="barbell">
      <div class="bar-row">
        ${renderSide(left)}
        <div class="collar"></div><div class="sleeve"></div>
        <div class="bar-center">${w}</div>
        <div class="sleeve"></div><div class="collar"></div>
        ${renderSide(right)}
      </div>
      <span class="bar-caption">${w < barWeight ? `מתחת למשקל המוט (${barWeight} ק"ג)` : `מוט ${barWeight} ק"ג + ${plates.length} משקולות`}</span>
    </div>`;
}

function renderChart(data) {
  if (!data.length) return `<div class="flex col items-center" style="padding:32px 0; gap:8px;">${ICONS.dumbbell}<span style="color:var(--steel); font-size:13px;">אין עדיין נתונים לתרגיל הזה</span></div>`;
  const n = data.length;
  // Every point gets its own date label now (rotated, to fit more before they
  // overlap). Few points still render at the original full-width 300 viewBox;
  // once labels would start crowding, the chart grows wide instead of
  // cramming, and scrolls horizontally so every date stays readable.
  const padTop = 20, padBottom = 44, plotH = 110, padX = 24, spacing = 44;
  const h = padTop + plotH + padBottom;
  const naturalW = padX * 2 + Math.max(0, n - 1) * spacing;
  const wide = naturalW > 300;
  const w = wide ? naturalW : 300;
  const xs = data.map((d, i) => padX + i * ((w - 2 * padX) / Math.max(1, n - 1)));
  const ys = data.map((d) => d.est1RM);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const range = maxY - minY || 1;
  const pts = data.map((d, i) => ({
    x: xs[i],
    y: padTop + plotH - ((d.est1RM - minY) / range) * plotH,
    isPR: d.isPR,
    label: d.dateLabel,
  }));
  const polyline = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const dots = pts.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.isPR ? 5 : 2.5}" fill="${p.isPR ? "var(--brass)" : "var(--chalk)"}" ${p.isPR ? 'stroke="var(--surface)" stroke-width="2"' : ""}/>`).join("");
  const labelY = padTop + plotH + 12;
  const labels = pts.map((p) => `<text x="${p.x.toFixed(1)}" y="${labelY}" font-size="9" fill="var(--steel)" text-anchor="end" transform="rotate(-45 ${p.x.toFixed(1)} ${labelY})">${esc(p.label)}</text>`).join("");
  const svg = `<svg viewBox="0 0 ${w} ${h}" style="${wide ? `width:${w}px;` : "width:100%;"} height:${h}px; display:block;">
    <polyline points="${polyline}" fill="none" stroke="var(--brass)" stroke-width="2"/>
    ${dots}${labels}
  </svg>`;
  return wide ? `<div style="overflow-x:auto; -webkit-overflow-scrolling:touch;">${svg}</div>` : svg;
}

// One-line summary for an entry regardless of its type — used anywhere a
// logged set/hold needs a compact label (recent-history strip, day footer).
function entrySummary(e) {
  if (e.type === "duration") return `${e.sets}×${formatDuration(e.durationSeconds)}${e.weight ? " @ " + e.weight : ""}`;
  return `${e.sets}×${e.reps} @ ${e.weight}`;
}
// showExercise: true for a superset (two exercises in the same group) so
// each round is legible on its own — a plain single-exercise ladder omits
// it, matching the existing compact "reps×weight" style.
function ladderRoundSummary(r, showExercise) {
  const prefix = showExercise ? `${movementById(r.exerciseId) ? movementById(r.exerciseId).name : "?"}: ` : "";
  if (r.type === "duration") return `${prefix}${formatDuration(r.durationSeconds)}${r.weight ? " @ " + r.weight : ""}`;
  return `${prefix}${r.reps}×${r.weight}`;
}

function renderLogTab() {
  const selected = movementById(selectedId);
  const isDuration = logEntryType === "duration";
  const est = isDuration ? null : bestEst1RM(selectedId);
  const bestHold = isDuration ? bestDurationFor(selectedId) : null;
  // Matches whichever mode is toggled — a duration exercise's most recent
  // reps-mode entry (or vice versa) isn't "last session" for this toggle.
  const last = entriesFor(selectedId).find((e) => (e.type === "duration") === isDuration);
  const isToday = logDate === todayISO();
  const dayEntries = entries.filter((e) => e.date === logDate);
  const dayLabel = isToday ? "היום" : fmtDate(logDate);

  return `
    ${editingEntryId ? `
    <div style="background:rgba(232,185,138,.12); border:1px solid var(--brass); border-radius:12px; padding:10px 14px; margin-bottom:12px; display:flex; align-items:center; justify-content:space-between;">
      <span style="color:var(--brass); font-weight:700; font-size:13px;">עריכת סט קיים</span>
      <button data-action="cancel-edit-entry" style="color:var(--steel); font-size:12px; text-decoration:underline;">ביטול</button>
    </div>` : ""}

    <button class="exercise-select" data-action="open-picker">
      <div class="flex items-center gap-8">
        <div class="dot" style="background:${esc(catColor(selected.category))}"></div>
        <span style="font-weight:800; font-size:16px;">${esc(selected.name)}</span>
      </div>
      <span class="flex items-center gap-6" style="color:var(--steel); font-size:12px; font-weight:600;">שינוי${ICONS.chevronsLeft}</span>
    </button>

    <div class="rx-toggle" role="radiogroup" aria-label="סוג רישום">
      <button class="rx-btn ${!isDuration ? "active-type" : ""}" data-action="set-log-entry-type" data-type="reps" role="radio" aria-checked="${!isDuration}">משקל וחזרות</button>
      <button class="rx-btn ${isDuration ? "active-type" : ""}" data-action="set-log-entry-type" data-type="duration" role="radio" aria-checked="${isDuration}"><span style="display:inline-flex; width:16px; height:16px; vertical-align:-3px; margin-left:4px;">${ICONS.stopwatchIcon}</span>החזקה בזמן</button>
    </div>

    <div class="flex items-center gap-8" style="margin-bottom:12px;">
      <input type="date" id="logDateInput" value="${esc(logDate)}" max="${todayISO()}" aria-label="תאריך רישום הסט" style="flex:1; min-width:0; background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:12px 14px; color:var(--chalk); font-size:14px; font-weight:700; font-family:inherit;" />
      ${logDate !== todayISO() ? `<button data-action="reset-log-date" style="background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:12px 16px; color:var(--steel); font-weight:700; font-size:13px; white-space:nowrap;">היום</button>` : ""}
    </div>

    ${(est || bestHold || last) ? `
    <div class="stat-row">
      ${est ? `<div class="stat-card"><div class="stat-label">1RM משוער</div><div class="stat-value mono" style="color:var(--brass);">${est} kg</div></div>` : ""}
      ${bestHold ? `<div class="stat-card"><div class="stat-label">שיא החזקה</div><div class="stat-value mono" style="color:var(--brass);">${formatDuration(bestHold)}</div></div>` : ""}
      ${last ? `<button data-action="prefill-last" class="stat-card" style="text-align:right;" aria-label="מילוי הנתונים מהאימון האחרון — ${isDuration ? formatDuration(last.durationSeconds) : `${last.weight} על ${last.reps}`}">
        <div class="flex items-center justify-between gap-6">
          <span class="stat-label">אימון אחרון</span>
          <span style="color:var(--steel);">${ICONS.repeat}</span>
        </div>
        <div class="stat-value mono">${isDuration ? formatDuration(last.durationSeconds) : `${last.weight}×${last.reps}`}</div>
      </button>` : ""}
    </div>` : ""}

    ${(() => {
      const recent = recentEntriesFor(selectedId);
      if (recent.length === 0) return "";
      return `
      <div style="margin-bottom:12px;">
        <div style="color:var(--steel); font-size:11px; font-weight:700; letter-spacing:.5px; margin-bottom:6px;">ב-14 הימים האחרונים</div>
        <div class="flex wrap gap-8">
          ${recent.map((e) => `<span class="mono" style="background:var(--surface2); border-radius:10px; padding:6px 10px; font-size:12.5px; font-weight:700; color:var(--steel);">${esc(fmtDate(e.date))}: <span style="color:var(--chalk);">${esc(entrySummary(e))}</span></span>`).join("")}
        </div>
      </div>`;
    })()}

    ${isDuration ? "" : renderBarWeightRow()}

    <div class="bar-wrap" id="barWrap">
      <div class="pr-flash" id="prFlash" style="display:none;">${ICONS.flame}<span>שיא חדש!</span></div>
      ${isDuration ? "" : `<div id="barbellVisual">${renderBarbell(weight)}</div>`}
    </div>

    <div class="steppers">
      ${renderStepper("weight", "משקל (ק\"ג)", weight, 2.5, isDuration ? 0 : barWeight)}
      ${isDuration ? renderStepper("durationSeconds", "משך (שניות)", durationSeconds, 5, 1) : renderStepper("reps", "חזרות", reps, 1, 1)}
      ${renderStepper("sets", "סטים", sets, 1, 1)}
    </div>

    ${isDuration
      ? `<div class="est-line">‹ משך ההחזקה: <b id="durationLineValue">${formatDuration(durationSeconds)}</b></div>`
      : `<div class="est-line">‹ הסט הזה מעריך 1RM של <b id="estLineValue">${estimate1RM(weight, reps)} kg</b></div>`}

    ${(() => {
      const rounds = ladderMode ? currentLadderRounds() : [];
      const nextNum = rounds.length + 1;
      const isSuperset = !!ladderPartnerId;
      const modeLabel = isSuperset ? "סופרסט" : "סולם";
      const partner = ladderPartnerId ? movementById(ladderPartnerId) : null;
      return `
      <button data-action="toggle-ladder-mode" class="movement-btn ${ladderMode ? "active" : ""}" aria-pressed="${ladderMode}" style="margin-bottom:${ladderMode ? "0" : "12px"};">
        <div class="flex items-center gap-8">
          <span style="display:inline-flex; color:var(--brass); flex-shrink:0;">${ICONS.ladder}</span>
          <div style="text-align:right;">
            <div aria-live="polite" style="font-weight:700; font-size:14px; color:${ladderMode ? "var(--brass)" : "var(--chalk)"};">${ladderMode ? (rounds.length ? `${modeLabel} פעיל — ${rounds.length} סטים נרשמו · הבא: ${nextNum}` : `${modeLabel} פעיל — קבעו את הסט הראשון למטה`) : "רישום סולם / סופרסט"}</div>
            ${!ladderMode ? `<div style="color:var(--steel); font-size:11.5px; margin-top:2px;">כמה סטים ברצף — אותו תרגיל במשקלים שונים, או שני תרגילים לסירוגין</div>` : ""}
          </div>
        </div>
        ${ladderMode ? `<span style="color:var(--brass); font-size:12px; font-weight:700; flex-shrink:0;">סיום</span>` : ""}
      </button>
      ${ladderMode ? `
      <div style="border:1px solid var(--brass); border-top:none; border-radius:0 0 12px 12px; padding:10px 12px; margin-bottom:12px; margin-top:-1px;">
        <div class="flex items-center gap-8" style="margin-bottom:10px;" role="radiogroup" aria-label="תווית בלוק (לא חובה)">
          <span style="color:var(--steel); font-size:11px; font-weight:700;">בלוק:</span>
          ${["A", "B", "C", "D"].map((l) => `<button class="format-chip ${ladderBlockLabel === l ? "active" : ""}" style="flex:0 0 auto; padding:5px 12px; font-size:12px;" data-action="set-ladder-block-label" data-label="${l}" role="radio" aria-checked="${ladderBlockLabel === l}">${l}</button>`).join("")}
          ${ladderBlockLabel ? `<button class="format-chip" style="flex:0 0 auto; padding:5px 12px; font-size:12px;" data-action="set-ladder-block-label" data-label="">ללא</button>` : ""}
        </div>
        ${partner ? (() => {
          const primary = movementById(ladderPrimaryId);
          return `
        <div class="flex items-center gap-8" style="margin-bottom:10px;" role="radiogroup" aria-label="תרגיל נוכחי בסופרסט">
          <button class="format-chip ${selectedId === ladderPrimaryId ? "active" : ""}" style="padding:8px 10px; font-size:12.5px;" data-action="ladder-switch-exercise" data-id="${esc(ladderPrimaryId)}" role="radio" aria-checked="${selectedId === ladderPrimaryId}">${esc(primary ? primary.name : "?")}</button>
          <button class="format-chip ${selectedId === ladderPartnerId ? "active" : ""}" style="padding:8px 10px; font-size:12.5px;" data-action="ladder-switch-exercise" data-id="${esc(ladderPartnerId)}" role="radio" aria-checked="${selectedId === ladderPartnerId}">${esc(partner.name)}</button>
        </div>`;
        })() : `
        <button data-action="open-picker" data-target="partner" class="link-btn" style="display:block; margin-bottom:10px; font-size:12.5px;">${ICONS.repeat} הוספת תרגיל שני (סופרסט)</button>`}
        ${rounds.length ? `<div class="flex wrap gap-8">
          ${rounds.map((r, i) => `
            <span class="flex items-center gap-6 mono" style="background:var(--surface2); border-radius:10px; padding:6px 10px; font-size:13px; font-weight:700;">
              ${i + 1}. ${esc(ladderRoundSummary(r, isSuperset))}
              <button data-action="delete-entry" data-id="${esc(r.id)}" aria-label="מחיקת סט ${i + 1} מה${modeLabel}" style="color:var(--steel); padding:0; display:inline-flex;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </span>`).join("")}
        </div>` : `<div style="color:var(--steel); font-size:12px;">אפשר לשנות משקל וחזרות לכל סט בנפרד — לחצו על כפתור השמירה בכל פעם שסט מוכן</div>`}
      </div>` : ""}`;
    })()}

    ${dayEntries.length === 0 ? `
    <div class="empty">${isToday ? "עדיין לא נרשמו סטים היום. קדימה למוט." : `עדיין לא נרשמו סטים ב-${esc(dayLabel)}.`}</div>` : `
    <button class="exercise-row" data-action="view-log-date-calendar" style="margin-bottom:0;">
      <div class="flex items-center gap-8">
        ${dayEntries[0].isPR ? ICONS.flame : ""}
        <div style="text-align:right;">
          <div style="font-weight:700; font-size:13px;">אחרון: ${esc(movementById(dayEntries[0].exerciseId) ? movementById(dayEntries[0].exerciseId).name : "?")} — ${esc(entrySummary(dayEntries[0]))}</div>
          <div style="color:var(--steel); font-size:11px;">${dayEntries.length} סט${dayEntries.length === 1 ? "" : "ים"} נרשמו ${isToday ? "היום" : `ב-${esc(dayLabel)}`}</div>
        </div>
      </div>
      <span class="flex items-center gap-6" style="color:var(--steel); font-size:12px; font-weight:600;">צפייה ביום${ICONS.chevronsLeft}</span>
    </button>`}
  `;
}

function renderStepper(field, label, value, step, min, action) {
  action = action || "step";
  // Every attribute below is escaped: `field` can be a user-authored movement
  // name coming from the WOD builder, and `value` can come off disk.
  const f = esc(field), a = esc(action), st = esc(step), mn = esc(min), v = esc(value);
  return `
    <div class="stepper">
      <span class="stepper-label">${esc(label)}</span>
      <div class="stepper-box">
        <button class="stepper-btn" data-action="${a}" data-field="${f}" data-dir="-1" data-step="${st}" data-min="${mn}" aria-label="הפחתה — ${esc(label)}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>
        </button>
        <input class="stepper-val mono" type="text" inputmode="decimal" data-action="${a}" data-field="${f}" data-min="${mn}" value="${v}" aria-label="${esc(label)}" />
        <button class="stepper-btn" data-action="${a}" data-field="${f}" data-dir="1" data-step="${st}" data-min="${mn}" aria-label="הוספה — ${esc(label)}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
    </div>`;
}

function renderDetailCard(m) {
  const hEntries = entriesFor(m.id);
  if (hEntries.length === 0) return "";
  // The most recently logged entry decides which mode this card renders in —
  // a movement almost never switches between holds and reps, and this keeps
  // the chart/PR-table meaningful instead of averaging two unrelated units.
  const isDuration = hEntries[0].type === "duration";
  if (isDuration) return renderDurationDetailCard(m, hEntries.filter((e) => e.type === "duration"));
  let max = -Infinity;
  const chartData = hEntries.filter((e) => e.type !== "duration").slice().sort((a, b) => a.date.localeCompare(b.date) || a.ts - b.ts).map((e) => {
    const isPR = e.est1RM >= max;
    if (e.est1RM > max) max = e.est1RM;
    return { dateLabel: fmtDate(e.date), est1RM: e.est1RM, isPR };
  });
  const prPoints = chartData.filter((d) => d.isPR);
  const trend = prPoints.length >= 2 ? +(prPoints[prPoints.length - 1].est1RM - prPoints[prPoints.length - 2].est1RM).toFixed(1) : null;
  return `
    <div class="chart-card" style="margin-top:-4px; border-top-left-radius:0; border-top-right-radius:0; border-top:none;">
      <div class="flex items-center justify-between" style="margin-bottom:12px;">
        <span style="font-weight:800; font-size:15px;">${esc(m.name)}</span>
        ${trend !== null ? `<span class="flex items-center gap-6" style="font-weight:700; font-size:12px;">${trend > 0 ? ICONS.up : trend < 0 ? ICONS.down : ICONS.flat}<span class="mono">${trend > 0 ? "+" : ""}${trend} kg</span> 1RM משוער</span>` : ""}
      </div>
      ${renderChart(chartData)}
      <div class="rep-table">
        ${STANDARD_REPS.map((r) => {
          const rec = repRecordFor(m.id, r);
          return `<div class="rep-cell"><div class="rep-cell-label">${r}RM</div><div class="rep-cell-val mono" style="color:${rec ? "var(--chalk)" : "var(--border)"};">${rec ?? "—"}</div></div>`;
        }).join("")}
      </div>
    </div>`;
}

// Duration-mode counterpart to the block above — same chart, but plotting
// hold time instead of est1RM, and a single best-hold stat instead of the
// STANDARD_REPS grid (a rep-record table means nothing for a timed hold).
function renderDurationDetailCard(m, durationEntries) {
  let max = -Infinity;
  const chartData = durationEntries.slice().sort((a, b) => a.date.localeCompare(b.date) || a.ts - b.ts).map((e) => {
    const isPR = e.durationSeconds >= max;
    if (e.durationSeconds > max) max = e.durationSeconds;
    return { dateLabel: fmtDate(e.date), est1RM: e.durationSeconds, isPR };
  });
  const prPoints = chartData.filter((d) => d.isPR);
  const trendSec = prPoints.length >= 2 ? prPoints[prPoints.length - 1].est1RM - prPoints[prPoints.length - 2].est1RM : null;
  const best = bestDurationFor(m.id);
  return `
    <div class="chart-card" style="margin-top:-4px; border-top-left-radius:0; border-top-right-radius:0; border-top:none;">
      <div class="flex items-center justify-between" style="margin-bottom:12px;">
        <span style="font-weight:800; font-size:15px;">${esc(m.name)}</span>
        ${trendSec !== null ? `<span class="flex items-center gap-6" style="font-weight:700; font-size:12px;">${trendSec > 0 ? ICONS.up : trendSec < 0 ? ICONS.down : ICONS.flat}<span class="mono">${trendSec > 0 ? "+" : ""}${formatDuration(Math.abs(trendSec))}</span> שיא החזקה</span>` : ""}
      </div>
      ${renderChart(chartData)}
      ${best ? `<div class="rep-table"><div class="rep-cell"><div class="rep-cell-label">שיא החזקה</div><div class="rep-cell-val mono" style="color:var(--chalk);">${formatDuration(best)}</div></div></div>` : ""}
    </div>`;
}

function renderHistoryListArea() {
  const area = document.getElementById("historyListArea");
  if (!area) return;
  const q = historySearch.trim().toLowerCase();
  const active = activeExercises().filter((m) => m.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  if (activeExercises().length === 0) {
    area.innerHTML = `<div class="flex col items-center" style="padding:40px 0; gap:8px;">${ICONS.dumbbell}<span style="color:var(--steel); font-size:13px;">רשמו סט כדי להתחיל לראות התקדמות</span></div>`;
    return;
  }
  if (active.length === 0) {
    area.innerHTML = `<div style="color:var(--steel); text-align:center; padding:20px 0; font-size:13px;">לא נמצא תרגיל התואם ל-"${esc(historySearch)}"</div>`;
    return;
  }
  area.innerHTML = active.map((m) => {
    const row = `
      <button class="exercise-row ${historyId === m.id ? "active" : ""}" data-action="select-history" data-id="${esc(m.id)}" style="${historyId === m.id ? "margin-bottom:0; border-bottom-left-radius:0; border-bottom-right-radius:0;" : ""}">
        <div class="flex items-center gap-8">
          <span style="display:inline-flex; transition:transform .2s; transform:rotate(${historyId === m.id ? "90deg" : "180deg"});">${ICONS.chevron}</span>
          <div class="dot" style="background:${esc(catColor(m.category))}"></div>
          <span style="font-weight:700; font-size:14px;">${esc(m.name)}</span>
        </div>
        <span class="mono" style="color:var(--brass); font-weight:700; font-size:14px;">${bestEst1RM(m.id)} kg</span>
      </button>`;
    const detail = historyId === m.id ? renderDetailCard(m) + `<div style="height:8px;"></div>` : "";
    return row + detail;
  }).join("");
}

// ---------- Calendar tab ----------
const MONTH_NAMES = ["ינואר","פברואר","מרץ","אפריל","מאי","יוני","יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר"];
const REPORT_CATEGORIES = ["Squat","Deadlift","Press","Olympic","Pull","Other"];

function isoDate(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Whether any strength set or WOD attempt was logged on a given date —
// shared by the calendar's day dots and the header streak indicator so the
// two never define "counts as a trained day" differently.
function hasAnyEntryOn(iso) {
  return entries.some((e) => e.date === iso) || wodEntries.some((e) => e.date === iso);
}
// Consecutive days, counting backward from today, with at least one logged
// entry. Today not being logged yet doesn't break the streak — it's just
// not counted until it is; the first fully-empty day (including today, if
// yesterday also has nothing) resets it to 0.
function computeCurrentStreak() {
  let streak = 0;
  const d = new Date(todayISO() + "T00:00:00");
  if (!hasAnyEntryOn(localISODate(d))) d.setDate(d.getDate() - 1);
  while (hasAnyEntryOn(localISODate(d))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}
function updateStreakLabel() {
  const el = document.getElementById("streakLabel");
  if (!el) return;
  const streak = computeCurrentStreak();
  if (streak <= 0) { el.style.display = "none"; return; }
  el.innerHTML = `${ICONS.flame}<span>${streak}</span>`;
  el.style.display = "flex";
  el.setAttribute("aria-label", `${streak} ימים ברצף`);
}
function renderCalendarGrid() {
  const grid = document.getElementById("calGrid");
  const label = document.getElementById("calMonthLabel");
  if (!grid || !label) return;
  label.textContent = `${MONTH_NAMES[calMonth]} ${calYear}`;
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const firstWeekday = new Date(calYear, calMonth, 1).getDay();
  const today = todayISO();
  let cells = "";
  for (let i = 0; i < firstWeekday; i++) cells += `<div class="cal-cell empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = isoDate(calYear, calMonth, d);
    const dayEntries = entries.filter((e) => e.date === iso);
    const dayWods = wodEntries.filter((e) => e.date === iso);
    const hasData = hasAnyEntryOn(iso);
    const hasPR = dayEntries.some((e) => e.isPR) || dayWods.some((e) => e.isPR);
    const cls = ["cal-cell"];
    if (iso === today) cls.push("today");
    if (iso === calSelectedDate) cls.push("selected");
    const dayAria = `${d}${hasData ? (hasPR ? " — שיא אישי" : " — יש נתונים") : ""}`;
    cells += `<button class="${cls.join(" ")}" data-action="cal-select-day" data-date="${esc(iso)}" aria-label="${esc(dayAria)}">
      <span class="cal-daynum" aria-hidden="true">${d}</span>
      ${hasData ? `<div class="cal-dot ${hasPR ? "pr" : ""}" aria-hidden="true"></div>` : ""}
    </button>`;
  }
  grid.innerHTML = cells;
  renderCalDetail();
}

// Partitions same-day entries into ladder groups (rows sharing a groupId)
// and singletons (an ordinary set, or a ladder row from an older backup
// with no groupId). Groups keep the incoming (most-recent-first) order;
// rounds within a group are oldest-first, i.e. the order they were logged.
function groupDayEntries(list) {
  const seen = new Set();
  const groups = [];
  for (const e of list) {
    const key = e.groupId || e.id;
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push(e.groupId
      ? list.filter((x) => x.groupId === e.groupId).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0))
      : [e]);
  }
  return groups;
}
// One free-text note per calendar date (how the whole session felt) —
// distinct from the per-WOD-entry scaling notes on wodEntries records.
// Keyed straight into the existing settings key-value store, same as every
// other small per-device flag; a note per day for years of use is trivial
// volume for it.
let calNoteDate = null; // which date calNoteText currently reflects
let calNoteText = "";
let calNoteLoading = false;
async function loadSessionNoteFor(date) {
  if (calNoteDate === date || calNoteLoading) return;
  calNoteLoading = true;
  try {
    const v = await dbGetSetting(`sessionNote:${date}`);
    calNoteText = typeof v === "string" ? v : "";
  } catch (e) { calNoteText = ""; }
  calNoteDate = date;
  calNoteLoading = false;
  if (tab === "calendar" && calSelectedDate === date) renderCalDetail();
}
async function saveSessionNote(date, text) {
  const cleaned = cleanStr(text, LIMITS.notesLen);
  calNoteText = cleaned;
  calNoteDate = date;
  try {
    await dbSetSetting(`sessionNote:${date}`, cleaned);
    setImportMessage("ההערה נשמרה");
  } catch (e) { noteStorageError(e); }
  render();
}
function renderCalDetail() {
  const el = document.getElementById("calDetail");
  if (!el) return;
  if (calNoteDate !== calSelectedDate) loadSessionNoteFor(calSelectedDate);
  const dayEntries = entries.filter((e) => e.date === calSelectedDate).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const dayWods = wodEntries.filter((e) => e.date === calSelectedDate).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const d = new Date(calSelectedDate + "T00:00:00");
  const label = d.toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  el.innerHTML = `
    <div class="section-label" style="margin-top:4px;">${label.toUpperCase()}</div>
    ${(dayEntries.length === 0 && dayWods.length === 0) ? `<div class="empty">לא נרשם דבר ביום הזה.</div>` : `
    <div class="log-list">
      ${groupDayEntries(dayEntries).map((group) => {
        if (group.length === 1) {
          const e = group[0];
          return `
        <div class="log-row">
          <div class="flex items-center gap-8">
            ${e.isPR ? ICONS.flame : ""}
            <span style="font-weight:700; font-size:14px;">${esc(movementById(e.exerciseId) ? movementById(e.exerciseId).name : "?")}</span>
          </div>
          <div class="flex items-center gap-10">
            <span class="mono" style="color:var(--steel); font-size:13px;">${esc(entrySummary(e))}</span>
            <button data-action="edit-entry" data-id="${esc(e.id)}" aria-label="עריכת סט" style="color:var(--steel); padding:4px;">${ICONS.edit}</button>
            <button data-action="delete-entry" data-id="${esc(e.id)}" aria-label="מחיקת סט" style="color:var(--steel); padding:4px;">${ICONS.trash}</button>
          </div>
        </div>`;
        }
        // Ladder or superset: one card, exercise name(s) + PR flame shown
        // once, then every round on its own line with its own edit/delete —
        // each rung stays individually correctable, per the point of this
        // whole feature. A superset is just a ladder whose rounds span two
        // exerciseIds instead of one — derived from the group's own data,
        // not from any currently-active session state.
        const anyPR = group.some((e) => e.isPR);
        const exerciseIds = [...new Set(group.map((e) => e.exerciseId))];
        const isSuperset = exerciseIds.length > 1;
        const name = esc(exerciseIds.map((id) => movementById(id) ? movementById(id).name : "?").join(" + "));
        const blockTag = group[0].blockLabel ? ` · בלוק ${esc(group[0].blockLabel)}` : "";
        return `
        <div class="log-row" style="flex-direction:column; align-items:stretch; gap:8px;">
          <div class="flex items-center gap-8">
            ${anyPR ? ICONS.flame : ""}
            <span style="font-weight:700; font-size:14px;">${name}</span>
            <span style="color:var(--steel); font-size:11px;">${isSuperset ? "סופרסט" : "סולם"} · ${group.length} סטים${blockTag}</span>
          </div>
          <div class="flex col gap-6">
            ${group.map((e, i) => `
            <div class="flex items-center justify-between">
              <span class="mono flex items-center gap-6" style="color:var(--steel); font-size:13px;">${i + 1}. ${esc(ladderRoundSummary(e, isSuperset))}${e.isPR ? ICONS.flame : ""}</span>
              <div class="flex items-center gap-6">
                <button data-action="edit-entry" data-id="${esc(e.id)}" aria-label="עריכת סט ${i + 1}" style="color:var(--steel); padding:4px;">${ICONS.edit}</button>
                <button data-action="delete-entry" data-id="${esc(e.id)}" aria-label="מחיקת סט ${i + 1}" style="color:var(--steel); padding:4px;">${ICONS.trash}</button>
              </div>
            </div>`).join("")}
          </div>
        </div>`;
      }).join("")}
      ${dayWods.map((e) => {
        const w = wodById(e.wodId);
        return `
        <div class="log-row" style="${e.notes ? "flex-direction:column; align-items:stretch; gap:4px;" : ""}">
          <div class="flex items-center justify-between" style="width:100%;">
            <div class="flex items-center gap-8">
              ${e.isPR ? ICONS.flame : ""}
              <span style="font-weight:700; font-size:14px;">${esc(w ? w.name : "?")}</span>
              <span style="color:var(--steel); font-size:11px;">${e.rx ? "Rx" : "Scaled"}${e.partnerTag ? ` · ${esc(e.partnerTag)}` : ""}</span>
            </div>
            <div class="flex items-center gap-10">
              <span class="mono" style="color:var(--steel); font-size:13px;">${formatWodEntry(e)}</span>
              <button data-action="edit-wod-entry" data-id="${esc(e.id)}" aria-label="עריכת אימון" style="color:var(--steel); padding:4px;">${ICONS.edit}</button>
              <button data-action="delete-wod-entry" data-id="${esc(e.id)}" aria-label="מחיקת אימון" style="color:var(--steel); padding:4px;">${ICONS.trash}</button>
            </div>
          </div>
          ${e.notes ? `<div style="color:var(--steel); font-size:12px; padding-left:23px;">${esc(e.notes)}</div>` : ""}
        </div>`;
      }).join("")}
    </div>`}

    <div style="color:var(--steel); font-size:11px; font-weight:700; letter-spacing:.5px; margin:16px 0 6px;">איך היה האימון היום</div>
    <textarea id="sessionNoteInput" class="text-input" dir="auto" maxlength="${LIMITS.notesLen}" rows="3" placeholder="הרגשה, אנרגיה, מה עבד ומה פחות..." aria-label="איך היה האימון היום" style="resize:vertical; min-height:64px; font-family:inherit; margin-bottom:8px;">${esc(calNoteDate === calSelectedDate ? calNoteText : "")}</textarea>
    <button data-action="save-session-note" data-date="${esc(calSelectedDate)}" class="link-btn" style="display:block;">שמירת הערה</button>
  `;
}

function daysAgoLabel(iso) {
  if (!iso) return "מעולם לא";
  const diff = Math.round((new Date(todayISO()) - new Date(iso)) / 86400000);
  if (diff === 0) return "היום";
  if (diff === 1) return "לפני יום";
  return `לפני ${diff} ימים`;
}

function renderVolumeReport() {
  const now = new Date();
  const cutoff7 = new Date(now); cutoff7.setDate(now.getDate() - 6);
  const cutoff7ISO = localISODate(cutoff7);
  const cutoff30 = new Date(now); cutoff30.setDate(now.getDate() - 29);
  const cutoff30ISO = localISODate(cutoff30);

  const cats = REPORT_CATEGORIES.concat(customMovements.length ? ["Custom"] : []);
  const rows = cats.map((cat) => {
    const catEntries = entries.filter((e) => { const m = movementById(e.exerciseId); return m && m.category === cat; });
    const setsWeek = catEntries.filter((e) => e.date >= cutoff7ISO).reduce((s, e) => s + e.sets, 0);
    const setsMonth = catEntries.filter((e) => e.date >= cutoff30ISO).reduce((s, e) => s + e.sets, 0);
    const lastDate = catEntries.length ? catEntries.map((e) => e.date).sort().slice(-1)[0] : null;
    const diff = lastDate ? Math.round((new Date(todayISO()) - new Date(lastDate)) / 86400000) : null;
    let flagColor = "var(--steel)", flagBg = "rgba(138,143,151,.15)", flagText = daysAgoLabel(lastDate);
    if (diff === null) { flagColor = "var(--red)"; flagBg = "rgba(216,69,60,.15)"; }
    else if (diff <= 7) { flagColor = "var(--green)"; flagBg = "rgba(75,155,95,.15)"; }
    else if (diff > 14) { flagColor = "var(--red)"; flagBg = "rgba(216,69,60,.15)"; }
    return `
      <div class="report-row">
        <div class="flex items-center gap-8">
          <div class="dot" style="background:${esc(catColor(cat))}"></div>
          <span style="font-weight:700; font-size:14px;">${esc(catLabel(cat))}</span>
        </div>
        <div class="flex items-center gap-10">
          <span class="mono" style="color:var(--steel); font-size:12px;">${setsWeek}/${setsMonth} סטים</span>
          <span class="report-flag" style="color:${flagColor}; background:${flagBg};">${flagText}</span>
        </div>
      </div>`;
  }).join("");

  return `
    <div class="section-label">נפח ותדירות לפי קטגוריה</div>
    <div style="color:var(--steel); font-size:11px; margin-bottom:10px;">סטים ב-7 / 30 הימים האחרונים, וזמן מאז האימון האחרון</div>
    ${rows}
  `;
}

function renderCalendarTab() {
  return `
    <div class="cal-header">
      <button class="cal-nav-btn" data-action="cal-prev" aria-label="חודש קודם">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--chalk)" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>
      </button>
      <span class="cal-month-label" id="calMonthLabel"></span>
      <button class="cal-nav-btn" data-action="cal-next" aria-label="חודש הבא">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--chalk)" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
      </button>
    </div>
    <div class="cal-weekdays">${["א","ב","ג","ד","ה","ו","ש"].map((d) => `<div class="cal-weekday">${d}</div>`).join("")}</div>
    <div class="cal-grid" id="calGrid"></div>
    <div id="calDetail" style="margin-bottom:20px;"></div>
    ${renderVolumeReport()}
  `;
}
function renderBodyweightArea() {
  const el = document.getElementById("bodyweightArea");
  if (!el) return;
  const sorted = bodyweightEntries.slice().sort((a, b) => a.date.localeCompare(b.date) || a.ts - b.ts);
  const last = bodyweightEntries.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
  const chartData = sorted.map((e) => ({ dateLabel: fmtDate(e.date), est1RM: e.weight, isPR: false }));
  const header = `
    <button class="exercise-row ${bodyweightExpanded ? "active" : ""}" data-action="toggle-bodyweight" style="${bodyweightExpanded ? "margin-bottom:0; border-bottom-left-radius:0; border-bottom-right-radius:0;" : ""}">
      <div class="flex items-center gap-8">
        <span style="display:inline-flex; transition:transform .2s; transform:rotate(${bodyweightExpanded ? "90deg" : "180deg"});">${ICONS.chevron}</span>
        <span style="font-weight:700; font-size:14px;">משקל גוף</span>
      </div>
      ${last ? `<span class="mono" style="color:var(--brass); font-weight:700; font-size:14px;">${last.weight} kg</span>` : `<span style="color:var(--steel); font-size:12px;">אין עדיין מדידות</span>`}
    </button>`;
  const detail = bodyweightExpanded ? `
    <div class="chart-card" style="margin-top:-4px; border-top-left-radius:0; border-top-right-radius:0; border-top:none;">
      ${last ? `<div style="color:var(--steel); font-size:12px; margin-bottom:${chartData.length ? "12px" : "0"};">עודכן לאחרונה: ${fmtDate(last.date)}</div>` : ""}
      ${chartData.length ? renderChart(chartData) : ""}
      <div class="steppers" style="margin-top:14px; margin-bottom:0;">
        ${renderStepper("bwWeight", "משקל (ק\"ג)", bwWeight, 0.5, 0, "bw-step")}
      </div>
      <button data-action="save-bw" class="save-btn" style="max-width:none; margin-top:14px;">רישום משקל גוף — היום</button>
    </div>
    <div style="height:8px;"></div>` : "";
  el.innerHTML = header + detail;
}

function renderMeasureArea() {
  const el = document.getElementById("measureArea");
  if (!el) return;
  const types = measureTypesSorted();

  const addRow = measureAddOpen
    ? `<div style="border:1px solid var(--brass); border-radius:12px; padding:10px 12px; margin-bottom:8px;">
         <input id="measureTypeInput" class="text-input" dir="auto" maxlength="80" autocomplete="off" placeholder="לדוגמה: היקף מותן" aria-label="שם מדד חדש" style="margin-bottom:8px;" />
         <div class="flex gap-8">
           <button data-action="confirm-add-measure-type" class="save-btn" style="max-width:none; flex:1;">הוספה</button>
           <button data-action="cancel-add-measure-type" style="color:var(--steel); font-size:13px; padding:0 10px;">ביטול</button>
         </div>
       </div>`
    : `<button class="movement-btn" data-action="open-add-measure-type" style="border-color:var(--brass); margin-bottom:${types.length ? "8px" : "0"};">
         <span style="font-weight:700; font-size:14px; color:var(--brass);">+ הוספת מדד חדש</span>
       </button>`;

  const rows = types.map((t) => {
    const expanded = measureExpandedId === t.id;
    const last = latestMeasurement(t.id);
    const header = `
      <button class="exercise-row ${expanded ? "active" : ""}" data-action="toggle-measure-type" data-id="${esc(t.id)}" style="${expanded ? "margin-bottom:0; border-bottom-left-radius:0; border-bottom-right-radius:0;" : ""}">
        <div class="flex items-center gap-8">
          <span style="display:inline-flex; transition:transform .2s; transform:rotate(${expanded ? "90deg" : "180deg"});">${ICONS.chevron}</span>
          <span style="font-weight:700; font-size:14px;">${esc(t.name)}</span>
        </div>
        ${last ? `<span class="mono" style="color:var(--brass); font-weight:700; font-size:14px;">${last.value} ס"מ</span>` : `<span style="color:var(--steel); font-size:12px;">אין עדיין מדידות</span>`}
      </button>`;
    if (!expanded) return header;

    if (typeof measureValues[t.id] !== "number") measureValues[t.id] = last ? last.value : 0;
    const sorted = measureEntriesFor(t.id).slice().sort((a, b) => a.date.localeCompare(b.date) || a.ts - b.ts);
    const chartData = sorted.map((e) => ({ dateLabel: fmtDate(e.date), est1RM: e.value, isPR: false }));
    const recent = measureEntriesFor(t.id).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 8);
    const detail = `
      <div class="chart-card" style="margin-top:-4px; border-top-left-radius:0; border-top-right-radius:0; border-top:none;">
        <div class="flex items-center justify-between" style="margin-bottom:${chartData.length ? "12px" : "0"};">
          ${last ? `<span style="color:var(--steel); font-size:12px;">עודכן לאחרונה: ${fmtDate(last.date)}</span>` : `<span style="color:var(--steel); font-size:12px;">אין עדיין מדידות</span>`}
          <button data-action="delete-measure-type" data-id="${esc(t.id)}" aria-label="מחיקת מדד" style="color:var(--steel); padding:4px;">${ICONS.trash}</button>
        </div>
        ${chartData.length ? renderChart(chartData) : ""}
        <div class="steppers" style="margin-top:14px; margin-bottom:0;">
          ${renderStepper(t.id, 'ס"מ', measureValues[t.id], 0.5, 0, "measure-step")}
        </div>
        <button data-action="save-measurement" data-id="${esc(t.id)}" class="save-btn" style="max-width:none; margin-top:14px;">רישום מדידה — היום</button>
        ${recent.length ? `
        <div class="log-list" style="margin-top:14px;">
          ${recent.map((e) => `
            <div class="log-row">
              <span style="color:var(--steel); font-size:12px;">${fmtDate(e.date)}</span>
              <div class="flex items-center gap-10">
                <span class="mono" style="font-size:13px;">${e.value} ס"מ</span>
                <button data-action="delete-measurement-entry" data-id="${esc(e.id)}" aria-label="מחיקת מדידה" style="color:var(--steel); padding:4px;">${ICONS.trash}</button>
              </div>
            </div>`).join("")}
        </div>` : ""}
      </div>
      <div style="height:8px;"></div>`;
    return header + detail;
  }).join("");

  el.innerHTML = `
    <div class="section-label" style="margin-top:4px;">מדדי גוף</div>
    ${addRow}
    ${rows}
  `;
  if (measureAddOpen) {
    const input = document.getElementById("measureTypeInput");
    if (input) {
      setTimeout(() => input.focus(), 50);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); addMeasureType(e.target.value); }
      });
    }
  }
}

function renderHistoryTab() {
  const now = new Date();
  const monthPrefix = localISODate(now).slice(0, 7);
  const prCountThisMonth = entries.filter((e) => e.isPR && e.date.startsWith(monthPrefix)).length;
  const start = new Date(now); start.setDate(now.getDate() - now.getDay());
  const startISO = localISODate(start);
  const sessionsThisWeek = new Set(entries.filter((e) => e.date >= startISO).map((e) => e.date)).size;
  const totalSetsLogged = entries.reduce((sum, e) => sum + e.sets, 0);

  return `
    <div class="stat-row">
      <div class="stat-card" style="text-align:center;"><div class="stat-value mono" style="color:var(--brass); font-size:20px;">${prCountThisMonth}</div><div class="stat-label">שיאים החודש</div></div>
      <div class="stat-card" style="text-align:center;"><div class="stat-value mono" style="font-size:20px;">${sessionsThisWeek}</div><div class="stat-label">אימונים השבוע</div></div>
      <div class="stat-card" style="text-align:center;"><div class="stat-value mono" style="font-size:20px;">${totalSetsLogged}</div><div class="stat-label">סטים שנרשמו</div></div>
    </div>

    ${activeExercises().length > 0 ? `
    <div class="section-label">שיאים כלל-זמנים</div>
    <div class="search-box" style="margin:0 0 12px;">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--steel)" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input id="historySearch" dir="auto" placeholder="חיפוש בתרגילים שלך" aria-label="חיפוש בתרגילים שלך" value="${esc(historySearch)}" />
    </div>` : ""}

    <div id="historyListArea"></div>

    <div id="bodyweightArea"></div>

    <div id="measureArea"></div>
  `;
}

function renderFooter() {
  return `
    <div class="footer">
      <div class="footer-note"${storageOK ? "" : ' style="color:var(--red);" role="alert"'}>${storageOK ? esc(typeof cloudStorageStatusText === "function" ? cloudStorageStatusText() : "נשמר במכשיר הזה בלבד, ללא שרת") : esc(storageErrMsg || "שמירה נכשלה — בדקו את מקום האחסון")}</div>
      ${(() => {
        const hasData = entries.length || wodEntries.length || bodyweightEntries.length || measureTypes.length;
        if (!hasData) return "";
        const days = daysSinceLastExport();
        if (days !== null && days < 30) return "";
        const msg = days === null ? "עדיין לא ביצעתם גיבוי" : `הגיבוי האחרון לפני ${days} ימים`;
        return `<div class="footer-note" style="color:var(--yellow); margin-bottom:8px;">${esc(msg)} — ייצוא גיבוי למטה</div>`;
      })()}
      <div class="flex items-center justify-center gap-10" style="margin-bottom:8px; flex-wrap:wrap;">
        <button class="link-btn" data-action="edit-user-name">עריכת פרופיל</button>
        <span style="color:var(--border); font-size:11px;">·</span>
        <button class="link-btn" data-action="export-data">ייצוא גיבוי</button>
        <span style="color:var(--border); font-size:11px;">·</span>
        <button class="link-btn" data-action="import-data">ייבוא גיבוי</button>
      </div>
      ${renderTextScaleRow()}
      <div class="flex items-center justify-center gap-8" style="margin-bottom:8px;"><a class="link-btn" href="./PRIVACY.md" target="_blank" rel="noopener">פרטיות</a><span aria-hidden="true">·</span><a class="link-btn" href="./TERMS.md" target="_blank" rel="noopener">כללי קהילה</a></div>
      <div class="footer-note" style="margin-bottom:8px;">קובץ הגיבוי הוא טקסט פשוט (JSON) וכולל שם, היסטוריית משקל גוף ויומן אימונים מלא — שמרו אותו במקום בטוח</div>
      <div style="color:var(--steel); font-size:11px; font-weight:700; letter-spacing:.5px; margin-bottom:6px;">מראה</div>
      ${renderThemeRow()}
      ${importMessage ? `<div class="footer-note" role="status" aria-live="polite" style="color:var(--brass); margin-bottom:8px;">${esc(importMessage)}</div>` : ""}
      ${!confirmClear ? `<button class="link-btn" data-action="ask-clear">מחיקת כל הנתונים</button>` : `
        <div class="flex items-center justify-center gap-10">
          <span style="color:var(--steel); font-size:11px;">למחוק הכל?</span>
          <button data-action="do-clear" style="color:var(--red); font-size:11px; font-weight:700;">כן, מחיקה</button>
          <button data-action="cancel-clear" style="color:var(--steel); font-size:11px;">ביטול</button>
        </div>`}
      <div class="footer-note" style="margin-top:10px;">© ${new Date().getFullYear()} Shahaf Rachmany · v${APP_VERSION}</div>
    </div>`;
}

function updateLogQuickUI(field) {
  const valMap = { weight, reps, sets, durationSeconds };
  const inp = document.querySelector(`.stepper-val[data-action="step"][data-field="${cssSel(field)}"]`);
  if (inp) inp.value = valMap[field];
  if (field === "weight" && logEntryType === "reps") {
    const bv = document.getElementById("barbellVisual");
    if (bv) bv.innerHTML = renderBarbell(weight);
    // The weight stepper's floor tracks barWeight (total can't be less than
    // the empty bar) - keep every element carrying data-min in sync with it.
    document.querySelectorAll('[data-action="step"][data-field="weight"]').forEach((elm) => { elm.dataset.min = barWeight; });
  }
  if (logEntryType === "reps") {
    const estEl = document.getElementById("estLineValue");
    if (estEl) estEl.textContent = estimate1RM(weight, reps) + " kg";
  } else if (field === "durationSeconds") {
    const durEl = document.getElementById("durationLineValue");
    if (durEl) durEl.textContent = formatDuration(durationSeconds);
  }
}

// Bound every numeric field at both ends. Previously only a floor was applied,
// so "1e12" typed into a weight box propagated straight through the app state.
function clampField(action, field, value, min) {
  const lo = isFinite(min) ? min : 0;
  const hi = fieldMax(action, field);
  if (typeof value !== "number" || !isFinite(value)) return lo;
  return Math.min(hi, Math.max(lo, +value.toFixed(2)));
}

function getFieldValue(action, field) {
  if (action === "step") return { weight, reps, sets, durationSeconds }[field];
  if (action === "wod-step") return { wodMinutes, wodSeconds, wodRounds, wodReps, wodWeight, wodScaledWeight }[field];
  if (action === "bw-step") return bwWeight;
  if (action === "builder-movement-reps") return builderMovements[field] ? builderMovements[field].reps : 0;
  if (action === "builder-movement-weight") return builderMovements[field] ? builderMovements[field].weight : 0;
  if (action === "builder-movement-duration") return builderMovements[field] ? builderMovements[field].durationSeconds : 0;
  if (action === "builder-emom-minutes") return builderEmomMinutes;
  if (action === "builder-time-cap") return builderTimeCapMinutes;
  if (action === "wod-emom-step") return typeof wodEmomReps[+field] === "number" ? wodEmomReps[+field] : 0;
  if (action === "measure-step") return typeof measureValues[field] === "number" ? measureValues[field] : 0;
  return 0;
}

// Pure state write, no DOM side effects — safe to call on every keystroke.
function setFieldState(action, field, value) {
  if (action === "step") {
    if (field === "weight") weight = value;
    else if (field === "reps") reps = value;
    else if (field === "sets") sets = value;
    else if (field === "durationSeconds") durationSeconds = value;
  } else if (action === "wod-step") {
    if (field === "wodMinutes") wodMinutes = value;
    else if (field === "wodSeconds") wodSeconds = value;
    else if (field === "wodRounds") wodRounds = value;
    else if (field === "wodReps") wodReps = value;
    else if (field === "wodWeight") wodWeight = value;
    else if (field === "wodScaledWeight") wodScaledWeight = value;
  } else if (action === "bw-step") {
    bwWeight = value;
  } else if (action === "builder-movement-reps") {
    if (builderMovements[field]) builderMovements[field].reps = value;
  } else if (action === "builder-movement-weight") {
    if (builderMovements[field]) builderMovements[field].weight = value;
  } else if (action === "builder-movement-duration") {
    if (builderMovements[field]) builderMovements[field].durationSeconds = value;
  } else if (action === "builder-emom-minutes") {
    builderEmomMinutes = value;
  } else if (action === "builder-time-cap") {
    builderTimeCapMinutes = value;
  } else if (action === "wod-emom-step") {
    wodEmomReps[+field] = value;
  } else if (action === "measure-step") {
    measureValues[field] = value;
  }
}

// Full commit: validates, writes state, and resyncs every dependent display
// (including the field's own text) — used by +/- buttons and on blur.
function applyFieldValue(action, field, value) {
  if (typeof value !== "number" || !isFinite(value)) {
    value = getFieldValue(action, field);
    if (typeof value !== "number" || !isFinite(value)) value = 0;
  }
  setFieldState(action, field, value);
  if (action === "step") {
    updateLogQuickUI(field);
  } else if (action === "wod-step") {
    const valMap = { wodMinutes, wodSeconds, wodRounds, wodReps, wodWeight, wodScaledWeight };
    const inp = document.querySelector(`.stepper-val[data-action="wod-step"][data-field="${cssSel(field)}"]`);
    if (inp) inp.value = valMap[field];
  } else if (action === "bw-step") {
    const inp = document.querySelector(`.stepper-val[data-action="bw-step"][data-field="bwWeight"]`);
    if (inp) inp.value = bwWeight;
  } else if (action === "builder-movement-reps" || action === "builder-movement-weight" || action === "builder-movement-duration") {
    renderWodBuilderMovements();
  } else if (action === "builder-emom-minutes") {
    const inp = document.querySelector(`.stepper-val[data-action="builder-emom-minutes"]`);
    if (inp) inp.value = builderEmomMinutes;
  } else if (action === "builder-time-cap") {
    const inp = document.querySelector(`.stepper-val[data-action="builder-time-cap"]`);
    if (inp) inp.value = builderTimeCapMinutes;
  } else if (action === "wod-emom-step") {
    const inp = document.querySelector(`.stepper-val[data-action="wod-emom-step"][data-field="${cssSel(field)}"]`);
    if (inp) inp.value = value;
  } else if (action === "measure-step") {
    const inp = document.querySelector(`.stepper-val[data-action="measure-step"][data-field="${cssSel(field)}"]`);
    if (inp) inp.value = value;
  }
}

function render() {
  let content;
  try {
    if (tab === "add") {
      const selected = movementById(selectedId);
      content = renderLogTab();
      if (selected) {
        const prefix = editingEntryId ? "עדכון סט — " : ladderMode ? `הוספת סט ${currentLadderRounds().length + 1} ל${ladderPartnerId ? "סופרסט" : "סולם"} — ` : "רישום סט — ";
        document.getElementById("saveBtnLabel").textContent = prefix + selected.name;
      }
    } else if (tab === "history") {
      content = renderHistoryTab();
    } else if (tab === "calendar") {
      content = renderCalendarTab();
    } else if (tab === "wod") {
      content = renderWodTab();
    } else {
      content = typeof renderCommunityApp === "function" ? renderCommunityApp() : `<div class="empty">הקהילה בטעינה</div>`;
    }
  } catch (err) {
    console.error("render error:", err);
    content = `<div style="padding:40px 16px; text-align:center;">
      <div style="color:var(--red); font-weight:700; margin-bottom:8px;">משהו השתבש בהצגת הטאב הזה</div>
      <div style="color:var(--steel); font-size:12px;">${esc((err && err.message) ? err.message : String(err))}</div>
    </div>`;
  }
  [["tabAddBtn", "add"], ["tabHistoryBtn", "history"], ["tabCalendarBtn", "calendar"], ["tabWodBtn", "wod"], ["tabCommunityBtn", "community"]].forEach(([id, t]) => {
    const btn = document.getElementById(id);
    btn.className = "tabbtn" + (tab === t ? " active" : "");
    btn.setAttribute("aria-selected", String(tab === t));
  });
  document.getElementById("bottomBar").style.display = tab === "add" ? "flex" : "none";
  updateStreakLabel();
  document.getElementById("content").innerHTML = content + renderFooter();
  try {
    if (tab === "add") {
      const dateInput = document.getElementById("logDateInput");
      if (dateInput) dateInput.addEventListener("change", (e) => {
        logDate = clampLogDate(e.target.value);
        endLadder(); // a ladder is scoped to one day
        render();
      });
    }
    if (tab === "history") {
      renderHistoryListArea();
      renderBodyweightArea();
      renderMeasureArea();
      const search = document.getElementById("historySearch");
      if (search) search.addEventListener("input", (e) => { historySearch = cleanStr(e.target.value, LIMITS.nameLen); renderHistoryListArea(); });
    }
    if (tab === "calendar") renderCalendarGrid();
    if (tab === "wod") renderWodContent();
    if (tab === "community" && typeof afterRenderCommunity === "function") afterRenderCommunity();
  } catch (err) {
    console.error("post-render error:", err);
  }
}

// ---------- WOD tab ----------
function renderWodLogSection() {
  const w = wodById(selectedWodId);
  if (!w) return `<div class="empty">בחרו אימון כדי להתחיל</div>`;
  const best = formatWodBest(selectedWodId);
  const isToday = wodLogDate === todayISO();
  const dayWods = wodEntries.filter((e) => e.date === wodLogDate);
  const dayLabel = isToday ? "היום" : fmtDate(wodLogDate);
  const lastScaled = lastScaledAttempt(selectedWodId);
  const history = wodEntriesFor(selectedWodId).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));

  let inputsHtml = "";
  if (w.scoreType === "time") {
    inputsHtml = `<div class="steppers">
      ${renderStepper("wodMinutes", "דקות", wodMinutes, 1, 0, "wod-step")}
      ${renderStepper("wodSeconds", "שניות", wodSeconds, 5, 0, "wod-step")}
    </div>`;
  } else if (w.scoreType === "amrap") {
    inputsHtml = `<div class="steppers">
      ${renderStepper("wodRounds", "סבבים", wodRounds, 1, 0, "wod-step")}
      ${renderStepper("wodReps", "+ חזרות", wodReps, 1, 0, "wod-step")}
    </div>`;
  } else if (w.scoreType === "emom") {
    // Resync to this WOD's own rotation whenever it doesn't already match —
    // covers first-ever render, switching from a differently-shaped EMOM,
    // and switching in from a non-EMOM WOD. Prefills from the WOD's own
    // target reps, same "starting point, not a blank form" idea as
    // prefill-from-last elsewhere in the app.
    if (emomStateWodId !== w.id || wodEmomReps.length !== w.emomMovements.length) {
      wodEmomReps = w.emomTargetReps.slice();
      emomStateWodId = w.id;
    }
    inputsHtml = `
    <div style="color:var(--steel); font-size:11px; font-weight:700; letter-spacing:.5px; margin-bottom:6px;">EMOM ${w.emomMinutes} — חזרות בכל סבב, לפי תרגיל</div>
    <div class="steppers">
      ${w.emomMovements.map((name, i) => renderStepper(String(i), `${i + 1}. ${name}`, wodEmomReps[i], 1, 0, "wod-emom-step")).join("")}
    </div>`;
  } else {
    inputsHtml = `<div class="steppers">
      ${renderStepper("wodWeight", "משקל (ק\"ג)", wodWeight, 2.5, 0, "wod-step")}
    </div>`;
  }

  return `
    ${editingWodEntryId ? `
    <div style="background:rgba(232,185,138,.12); border:1px solid var(--brass); border-radius:12px; padding:10px 14px; margin-bottom:12px; display:flex; align-items:center; justify-content:space-between;">
      <span style="color:var(--brass); font-weight:700; font-size:13px;">עריכת אימון קיים</span>
      <button data-action="cancel-edit-wod-entry" style="color:var(--steel); font-size:12px; text-decoration:underline;">ביטול</button>
    </div>` : ""}

    <button class="exercise-select" data-action="open-wod-picker">
      <div class="flex items-center gap-8">
        <div class="dot" style="background:${esc(catColor(w.category))}"></div>
        <div>
          <span style="font-weight:800; font-size:16px;">${esc(w.name)}</span>
          ${w.desc ? `<div class="wod-desc">${esc(w.desc)}</div>` : ""}
          ${w.timeCapSeconds ? `<div class="wod-desc" style="color:var(--brass);">מגבלת זמן: ${formatClock(w.timeCapSeconds)}</div>` : ""}
        </div>
      </div>
      <span class="flex items-center gap-6" style="color:var(--steel); font-size:12px; font-weight:600;">שינוי${ICONS.chevronsLeft}</span>
    </button>

    <div class="flex items-center gap-8" style="margin-bottom:12px;">
      <input type="date" id="wodLogDateInput" value="${esc(wodLogDate)}" max="${todayISO()}" aria-label="תאריך רישום האימון" style="flex:1; min-width:0; background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:12px 14px; color:var(--chalk); font-size:14px; font-weight:700; font-family:inherit;" />
      ${wodLogDate !== todayISO() ? `<button data-action="reset-wod-log-date" style="background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:12px 16px; color:var(--steel); font-weight:700; font-size:13px; white-space:nowrap;">היום</button>` : ""}
    </div>

    ${history.length > 0 ? `
    <div style="background:rgba(232,185,138,.12); border:1px solid var(--brass); border-radius:14px; padding:12px 14px; margin-bottom:16px;">
      <div style="color:var(--brass); font-weight:800; font-size:13px; margin-bottom:8px;">↺ עשית את זה ${history.length} פעמים בעבר — השוואה למטה</div>
      <div class="flex items-center justify-between">
        <div>
          <div class="stat-label">שיא</div>
          <div class="mono" style="color:var(--brass); font-weight:800; font-size:16px;">${best}</div>
        </div>
        <div style="text-align:left;">
          <div class="stat-label">אחרון (${fmtDate(history[0].date)})</div>
          <div class="mono" style="font-weight:700; font-size:16px;">${formatWodEntry(history[0])} ${history[0].rx ? "" : "· Scaled"}</div>
        </div>
      </div>
    </div>` : `
    <div class="stat-row">
      <div class="stat-card"><div class="stat-label">שיא</div><div class="stat-value mono" style="color:var(--brass);">${best}</div></div>
      <div class="stat-card"><div class="stat-label">סוג ניקוד</div><div class="stat-value" style="font-size:14px;">${w.scoreType === "time" ? "For Time" : w.scoreType === "amrap" ? "AMRAP" : w.scoreType === "emom" ? "EMOM" : "Load"}</div></div>
    </div>`}

    ${(() => {
      const recent = recentWodEntriesFor(selectedWodId);
      if (recent.length === 0) return "";
      return `
      <div style="margin-bottom:16px;">
        <div style="color:var(--steel); font-size:11px; font-weight:700; letter-spacing:.5px; margin-bottom:6px;">ב-14 הימים האחרונים</div>
        <div class="flex wrap gap-8">
          ${recent.map((e) => `<span class="mono" style="background:var(--surface2); border-radius:10px; padding:6px 10px; font-size:12.5px; font-weight:700; color:var(--steel);">${esc(fmtDate(e.date))}: <span style="color:var(--chalk);">${esc(formatWodEntry(e))}</span>${e.rx ? "" : " · Scaled"}</span>`).join("")}
        </div>
      </div>`;
    })()}

    <div id="wodFlashBox" class="flex items-center justify-center" style="display:none; gap:6px; color:#fff; font-weight:800; font-size:14px; background-image:var(--stripe); border-radius:14px; padding:10px 0; margin-bottom:16px; text-shadow:0 1px 3px rgba(0,0,0,.5);">${ICONS.flame}<span>שיא חדש!</span></div>

    <div class="rx-toggle" role="radiogroup" aria-label="Rx או Scaled">
      <button class="rx-btn ${wodRx ? "active-rx" : ""}" data-action="set-rx" data-rx="1" role="radio" aria-checked="${wodRx}">Rx</button>
      <button class="rx-btn ${!wodRx ? "active-scaled" : ""}" data-action="set-rx" data-rx="0" role="radio" aria-checked="${!wodRx}">Scaled</button>
    </div>

    <input id="wodPartnerTagInput" class="text-input" dir="auto" maxlength="${LIMITS.partnerTag}" style="margin-bottom:16px;" placeholder="עם פרטנר? (אופציונלי, לדוגמה עם דנה)" aria-label="שם הפרטנר (אופציונלי)" value="${esc(wodPartnerTag)}" />

    ${!wodRx ? `
    <div class="steppers" style="margin-bottom:16px;">
      ${renderStepper("wodScaledWeight", "משקל מותאם (ק\"ג)", wodScaledWeight, 2.5, 0, "wod-step")}
    </div>
    <input id="wodNotesInput" class="text-input" dir="auto" style="margin-bottom:8px;" placeholder="שינוי בתרגיל? (אופציונלי, לדוגמה מתח עם רצועה)" aria-label="שינוי בתרגיל (אופציונלי)" value="${esc(wodNotes)}" />
    <div class="flex items-center justify-between" style="margin-bottom:16px;">
      ${lastScaled ? `<button data-action="copy-last-scaled" style="color:var(--steel); font-size:12px; text-align:right;">↺ בפעם הקודמת: ${lastScaled.notes ? esc(lastScaled.notes) + " — " : ""}${formatWodEntry(lastScaled)}</button>` : `<span style="color:var(--steel); font-size:12px;">פעם ראשונה שמתאימים את זה</span>`}
    </div>` : ""}

    ${inputsHtml}

    <button data-action="save-wod" class="save-btn" style="max-width:none; margin:20px 0 24px;">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      ${editingWodEntryId ? "עדכון" : "רישום"} אימון — ${esc(w.name)}
    </button>

    ${dayWods.length === 0 ? `
    <div class="empty">${isToday ? "עדיין לא נרשמו אימונים היום." : `עדיין לא נרשמו אימונים ב-${esc(dayLabel)}.`}</div>` : `
    <button class="exercise-row" data-action="view-log-wod-date-calendar" style="margin-bottom:0;">
      <div class="flex items-center gap-8">
        ${dayWods[0].isPR ? ICONS.flame : ""}
        <div style="text-align:right;">
          <div style="font-weight:700; font-size:13px;">אחרון: ${esc(wodById(dayWods[0].wodId) ? wodById(dayWods[0].wodId).name : "?")} — ${formatWodEntry(dayWods[0])} (${dayWods[0].rx ? "Rx" : "Scaled"})</div>
          <div style="color:var(--steel); font-size:11px;">${dayWods.length} אימון${dayWods.length === 1 ? "" : "ים"} נרשמו ${isToday ? "היום" : `ב-${esc(dayLabel)}`}</div>
        </div>
      </div>
      <span class="flex items-center gap-6" style="color:var(--steel); font-size:12px; font-weight:600;">צפייה ביום${ICONS.chevronsLeft}</span>
    </button>`}
  `;
}

function renderWodDetailCard(w) {
  const list = wodEntriesFor(w.id);
  if (list.length === 0) return "";
  // EMOM has no single comparable score (see bestWodScore/scoreValue) — a
  // PR-trend chart would either be misleadingly flat or falsely mark every
  // attempt as a "PR". Skip the chart for it; the per-attempt list below
  // (with formatWodEntry's per-movement reps) is the useful part.
  const isEmom = w.scoreType === "emom";
  let chartHtml = "";
  if (!isEmom) {
    const sorted = list.slice().sort((a, b) => a.date.localeCompare(b.date) || a.ts - b.ts);
    let bestSoFar = w.scoreType === "time" ? Infinity : -Infinity;
    const chartData = sorted.map((e) => {
      const val = scoreValue(e);
      const isPR = w.scoreType === "time" ? val <= bestSoFar : val >= bestSoFar;
      bestSoFar = w.scoreType === "time" ? Math.min(bestSoFar, val) : Math.max(bestSoFar, val);
      return { dateLabel: fmtDate(e.date), est1RM: val, isPR };
    });
    chartHtml = renderChart(chartData);
  }
  const recent = list.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 8);
  return `
    <div class="chart-card" style="margin-top:-4px; border-top-left-radius:0; border-top-right-radius:0; border-top:none;">
      <div class="flex items-center justify-between" style="margin-bottom:12px;">
        <span style="font-weight:800; font-size:15px;">${esc(w.name)}</span>
        ${isEmom ? "" : `<span class="mono" style="color:var(--brass); font-weight:700; font-size:13px;">שיא: ${formatWodBest(w.id)}</span>`}
      </div>
      ${chartHtml}
      <div class="log-list" style="margin-top:12px;">
        ${recent.map((e) => `
          <div class="log-row" style="${e.notes ? "flex-direction:column; align-items:stretch; gap:4px;" : ""}">
            <div class="flex items-center justify-between" style="width:100%;">
              <div class="flex items-center gap-8">
                ${e.isPR ? ICONS.flame : ""}
                <span style="color:var(--steel); font-size:12px;">${fmtDate(e.date)}</span>
                <span style="color:var(--steel); font-size:11px;">${e.rx ? "Rx" : "Scaled"}${e.partnerTag ? ` · ${esc(e.partnerTag)}` : ""}</span>
              </div>
              <span class="mono" style="font-size:13px;">${formatWodEntry(e)}</span>
            </div>
            ${e.notes ? `<div style="color:var(--steel); font-size:12px;">${esc(e.notes)}</div>` : ""}
          </div>`).join("")}
      </div>
    </div>`;
}

function renderWodHistoryListArea() {
  const area = document.getElementById("wodHistoryListArea");
  if (!area) return;
  const q = wodHistorySearch.trim().toLowerCase();
  const active = activeWods().filter((w) => w.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  if (activeWods().length === 0) {
    area.innerHTML = `<div class="flex col items-center" style="padding:40px 0; gap:8px;">${ICONS.dumbbell}<span style="color:var(--steel); font-size:13px;">רשמו אימון כדי להתחיל לראות התקדמות</span></div>`;
    return;
  }
  if (active.length === 0) {
    area.innerHTML = `<div style="color:var(--steel); text-align:center; padding:20px 0; font-size:13px;">לא נמצא אימון התואם ל-"${esc(wodHistorySearch)}"</div>`;
    return;
  }
  area.innerHTML = active.map((w) => {
    const row = `
      <button class="exercise-row ${wodHistoryId === w.id ? "active" : ""}" data-action="select-wod-history" data-id="${esc(w.id)}" style="${wodHistoryId === w.id ? "margin-bottom:0; border-bottom-left-radius:0; border-bottom-right-radius:0;" : ""}">
        <div class="flex items-center gap-8">
          <span style="display:inline-flex; transition:transform .2s; transform:rotate(${wodHistoryId === w.id ? "90deg" : "180deg"});">${ICONS.chevron}</span>
          <div class="dot" style="background:${esc(catColor(w.category))}"></div>
          <span style="font-weight:700; font-size:14px;">${esc(w.name)}</span>
        </div>
        <span class="mono" style="color:var(--brass); font-weight:700; font-size:14px;">${formatWodBest(w.id)}</span>
      </button>`;
    const detail = wodHistoryId === w.id ? renderWodDetailCard(w) + `<div style="height:8px;"></div>` : "";
    return row + detail;
  }).join("");
}

function renderWodHistorySection() {
  return `
    ${activeWods().length > 0 ? `
    <div class="section-label">שיאים כלל-זמנים</div>
    <div class="search-box" style="margin:0 0 12px;">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--steel)" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input id="wodHistorySearch" dir="auto" placeholder="חיפוש באימונים שלך" aria-label="חיפוש באימונים שלך" value="${esc(wodHistorySearch)}" />
    </div>` : ""}
    <div id="wodHistoryListArea"></div>
  `;
}

function renderWodBenchmarksSection() {
  return `<div class="section-label">Benchmarks</div>
    ${WOD_LIBRARY.map((w) => `<button class="movement-btn" data-action="select-benchmark" data-id="${esc(w.id)}">
      <div><span style="font-weight:700;">${esc(w.name)}</span>${w.desc ? `<div class="wod-desc">${esc(w.desc)}</div>` : ""}</div>
      <span aria-hidden="true">‹</span>
    </button>`).join("")}`;
}

function renderWodTab() {
  return `
    <div class="subtabbar" role="tablist">
      <button class="subtabbtn ${wodSubTab === "log" ? "active" : ""}" data-action="switch-wod-subtab" data-subtab="log" role="tab" aria-selected="${wodSubTab === "log"}" aria-controls="wodContent">רישום</button>
      <button class="subtabbtn ${wodSubTab === "history" ? "active" : ""}" data-action="switch-wod-subtab" data-subtab="history" role="tab" aria-selected="${wodSubTab === "history"}" aria-controls="wodContent">היסטוריה</button>
      <button class="subtabbtn ${wodSubTab === "benchmarks" ? "active" : ""}" data-action="switch-wod-subtab" data-subtab="benchmarks" role="tab" aria-selected="${wodSubTab === "benchmarks"}" aria-controls="wodContent">Benchmarks</button>
    </div>
    <div id="wodContent"></div>
  `;
}

function renderWodContent() {
  const el = document.getElementById("wodContent");
  if (!el) return;
  el.innerHTML = wodSubTab === "log" ? renderWodLogSection() : wodSubTab === "benchmarks" ? renderWodBenchmarksSection() : renderWodHistorySection();
  if (wodSubTab === "log") {
    const notesInput = document.getElementById("wodNotesInput");
    if (notesInput) notesInput.addEventListener("input", (e) => { wodNotes = cleanStr(e.target.value, LIMITS.notesLen); });
    const partnerInput = document.getElementById("wodPartnerTagInput");
    if (partnerInput) partnerInput.addEventListener("input", (e) => { wodPartnerTag = cleanStr(e.target.value, LIMITS.partnerTag); });
    const dateInput = document.getElementById("wodLogDateInput");
    if (dateInput) dateInput.addEventListener("change", (e) => {
      wodLogDate = clampLogDate(e.target.value);
      renderWodContent();
    });
  }
  if (wodSubTab === "history") {
    renderWodHistoryListArea();
    const search = document.getElementById("wodHistorySearch");
    if (search) search.addEventListener("input", (e) => { wodHistorySearch = cleanStr(e.target.value, LIMITS.nameLen); renderWodHistoryListArea(); });
  }
}

// ---------- Picker ----------
let pickerOpen = false;
// "primary" (the normal case — picking selectedId) or "partner" (picking
// the second exercise of an active superset — see setLadderPartner).
let pickerTarget = "primary";
function syncPickerViewport() {
  const overlay = document.getElementById("pickerOverlay");
  if (!overlay) return;
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  overlay.style.height = vh + "px";
}
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", () => { if (pickerOpen) syncPickerViewport(); });
}
function openPicker(target) {
  pickerOpen = true;
  pickerTarget = target === "partner" ? "partner" : "primary";
  document.body.style.overflow = "hidden";
  syncPickerViewport();
  document.getElementById("pickerOverlay").classList.add("open");
  const search = document.getElementById("pickerSearch");
  search.value = "";
  renderPickerList("");
  setTimeout(() => search.focus(), 50);
}
// Routes a picked movement id to the right place depending on pickerTarget:
// the normal exercise selection, or the active ladder's superset partner.
function choosePickedMovement(id) {
  if (pickerTarget === "partner") { setLadderPartner(id); return; }
  if (id !== selectedId) endEntryEditIfActive();
  selectedId = id;
  syncLogEntryTypeToSelection();
  endLadder();
}

function choosePickedWod(id) {
  const next = wodById(id);
  if (!next) return;
  if (id !== selectedWodId) {
    endWodEditIfActive();
    wodNotes = "";
    wodEmomReps = next.scoreType === "emom" ? next.emomTargetReps.slice() : [];
    emomStateWodId = next.scoreType === "emom" ? next.id : null;
  }
  selectedWodId = id;
}
function closePicker() {
  pickerOpen = false;
  document.body.style.overflow = "";
  document.getElementById("pickerOverlay").classList.remove("open");
}
function renderPickerList(query) {
  const q = query.toLowerCase();
  const filtered = allMovements().filter((m) => m.name.toLowerCase().includes(q));
  const exactMatch = allMovements().some((m) => m.name.toLowerCase() === q);
  const byCategory = bag();
  filtered.forEach((m) => { (byCategory[m.category] = byCategory[m.category] || []).push(m); });
  const list = document.getElementById("pickerList");
  const addRow = query.trim() && !exactMatch
    ? `<div style="border:1px solid var(--brass); border-radius:12px; padding:10px 12px; margin-top:4px; margin-bottom:8px;">
         <div style="font-weight:700; font-size:13px; color:var(--brass); margin-bottom:8px;">הוספת "${esc(query.trim())}" — לאיזו קטגוריה?</div>
         <div class="flex wrap gap-8">
           ${MOVEMENT_CATEGORIES.map((cat) => `<button class="format-chip" style="flex:0 0 auto; padding:8px 14px;" data-action="add-movement" data-name="${esc(query.trim())}" data-category="${cat}">${cat}</button>`).join("")}
         </div>
       </div>`
    : `<button class="movement-btn" data-action="focus-picker-search" style="border-color:var(--brass); margin-top:4px; margin-bottom:8px;">
         <span style="font-weight:700; font-size:14px; color:var(--brass);">+ הוספת תרגיל חדש</span>
       </button>`;
  if (Object.keys(byCategory).length === 0) {
    list.innerHTML = addRow + `<div style="color:var(--steel); text-align:center; padding:16px 0; font-size:13px;">לא נמצא תרגיל</div>`;
    return;
  }
  list.innerHTML = addRow + Object.entries(byCategory).map(([cat, items]) => `
    <div class="cat-group">
      <div class="cat-head"><div class="dot" style="background:${esc(catColor(cat))}"></div><span class="cat-name">${esc(catLabel(cat))}</span></div>
      ${items.map((m) => `
        <button class="movement-btn ${selectedId === m.id ? "active" : ""}" data-action="pick-movement" data-id="${esc(m.id)}">
          <span style="font-weight:600; font-size:14px;">${esc(m.name)}</span>
          ${selectedId === m.id ? `<div class="dot" style="background:var(--brass);"></div>` : ""}
        </button>`).join("")}
    </div>`).join("");
}

let wodPickerOpen = false;
function syncWodPickerViewport() {
  const overlay = document.getElementById("wodPickerOverlay");
  if (!overlay) return;
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  overlay.style.height = vh + "px";
}
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", () => { if (wodPickerOpen) syncWodPickerViewport(); });
  window.visualViewport.addEventListener("resize", () => {
    if (wodBuilderOpen) {
      const overlay = document.getElementById("wodBuilderOverlay");
      if (overlay) overlay.style.height = window.visualViewport.height + "px";
    }
  });
}
function openWodPicker() {
  wodPickerOpen = true;
  document.body.style.overflow = "hidden";
  syncWodPickerViewport();
  document.getElementById("wodPickerOverlay").classList.add("open");
  const search = document.getElementById("wodPickerSearch");
  search.value = "";
  renderWodPickerList("");
  setTimeout(() => search.focus(), 50);
}
function closeWodPicker() {
  wodPickerOpen = false;
  document.body.style.overflow = "";
  document.getElementById("wodPickerOverlay").classList.remove("open");
}
function renderWodPickerList(query) {
  const q = query.toLowerCase();
  const filtered = allWods().filter((w) => w.name.toLowerCase().includes(q));
  const exactMatch = allWods().some((w) => w.name.toLowerCase() === q);
  const byCategory = bag();
  filtered.forEach((w) => { (byCategory[w.category] = byCategory[w.category] || []).push(w); });
  const list = document.getElementById("wodPickerList");
  const addRow = query.trim() && !exactMatch
    ? `<button class="movement-btn" data-action="open-wod-builder" data-name="${esc(query.trim())}" style="border-color:var(--energy); margin-top:4px;">
         <span style="font-weight:700; font-size:14px; color:var(--energy);">+ בניית "${esc(query.trim())}" כאימון חדש</span>
       </button>`
    : `<button class="movement-btn" data-action="open-wod-builder" data-name="" style="border-color:var(--energy); margin-top:4px;">
         <span style="font-weight:700; font-size:14px; color:var(--energy);">+ בניית אימון מותאם אישית</span>
       </button>`;
  if (Object.keys(byCategory).length === 0) {
    list.innerHTML = addRow + `<div style="color:var(--steel); text-align:center; padding:16px 0; font-size:13px;">לא נמצא אימון</div>`;
    return;
  }
  const order = ["Girls", "Heroes", "Custom"];
  const cats = Object.keys(byCategory).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  list.innerHTML = addRow + `<div style="height:12px;"></div>` + cats.map((cat) => `
    <div class="cat-group">
      <div class="cat-head"><div class="dot" style="background:${esc(catColor(cat))}"></div><span class="cat-name">${esc(catLabel(cat))}</span></div>
      ${byCategory[cat].map((w) => `
        <div class="movement-btn ${selectedWodId === w.id ? "active" : ""}" style="padding:0; overflow:hidden;">
        <button style="flex:1; padding:12px 14px; text-align:right;" data-action="pick-wod" data-id="${esc(w.id)}">
          <div>
            <span style="font-weight:600; font-size:14px;">${esc(w.name)}</span>
            ${w.desc ? `<div class="wod-desc">${esc(w.desc)}</div>` : ""}
          </div>
          ${selectedWodId === w.id ? `<div class="dot" style="background:var(--brass);"></div>` : ""}
        </button>
        ${w.category === "Custom" && wodEntriesFor(w.id).length === 0 ? `<button data-action="delete-custom-wod" data-id="${esc(w.id)}" aria-label="מחיקת ${esc(w.name)}" style="padding:12px; color:var(--red);">✕</button>` : ""}
        </div>`).join("")}
    </div>`).join("");
}

// ---------- Service worker update handshake ----------
let pendingWorker = null;
// Set right before we ask a waiting worker to take over, so the
// controllerchange listener below can tell "we asked for this swap" apart
// from self.clients.claim() firing that same event on the very first
// install too (a page with no prior controller still gets one controllerchange
// the moment the first SW claims it — that's not an update, and reloading
// for it was wiping out whatever someone had just started typing, every
// single first visit).
let swapRequested = false;
function applyUpdate() {
  const worker = pendingWorker;
  pendingWorker = null; // guard against a second trigger firing before the reload lands
  if (worker) {
    swapRequested = true;
    try { worker.postMessage({ type: "SKIP_WAITING" }); return; } catch (e) { swapRequested = false; }
  }
  location.reload();
}
// A new version becomes available mid-session fairly often here — the phone
// screen locks between sets, which already fires visibilitychange, so most
// updates apply the moment someone picks the phone back up, with no banner
// and no manual reopen needed. The one case that still needs the banner:
// the update lands while the page has been continuously visible (an
// uninterrupted stretch of active use) — reloading out from under someone
// mid-set would drop whatever they just typed but haven't tapped Save on
// yet, since nothing here persists until that tap.
function offerUpdate(worker) {
  pendingWorker = worker;
  if (document.visibilityState === "visible") showUpdateBanner();
  else applyUpdate();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && pendingWorker) applyUpdate();
});

// ---------- Install prompt ----------
// Chrome/Android fire beforeinstallprompt once, early, and let a page defer
// and replay it later — that's what lets us show our own banner instead of
// relying on the browser's own (often buried) install affordance. iOS Safari
// never fires this event at all, so there the banner simply never appears.
let deferredInstallPrompt = null;
const INSTALL_DISMISS_KEY = "haimunia-demo:installDismissed";

function isStandalone() {
  return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
}

function showInstallBanner() {
  if (isStandalone()) return;
  try { if (sessionStorage.getItem(INSTALL_DISMISS_KEY)) return; } catch (e) {}
  const updateEl = document.getElementById("updateBanner");
  if (updateEl && updateEl.style.display === "block") return;
  const el = document.getElementById("installBanner");
  if (el) el.style.display = "block";
}

function dismissInstallBanner() {
  const el = document.getElementById("installBanner");
  if (el) el.style.display = "none";
  try { sessionStorage.setItem(INSTALL_DISMISS_KEY, "1"); } catch (e) {}
}

async function installApp() {
  dismissInstallBanner();
  if (!deferredInstallPrompt) return;
  const evt = deferredInstallPrompt;
  deferredInstallPrompt = null;
  try {
    evt.prompt();
    await evt.userChoice;
  } catch (e) {}
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallBanner();
});
window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  dismissInstallBanner();
});

// ---------- Event delegation ----------
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) {
    const communityEl = e.target.closest("[data-community-action]");
    if (communityEl && typeof handleCommunityClick === "function") handleCommunityClick(communityEl);
    return;
  }
  const action = el.dataset.action;
  if (action === "reload-app") { applyUpdate(); }
  else if (action === "install-app") { installApp(); }
  else if (action === "dismiss-install-hint") { dismissInstallBanner(); }
  else if (action === "switch-tab") { tab = el.dataset.tab; render(); }
  else if (action === "view-today-calendar") {
    tab = "calendar";
    const t = new Date();
    calYear = t.getFullYear();
    calMonth = t.getMonth();
    calSelectedDate = todayISO();
    render();
  }
  else if (action === "view-log-date-calendar") {
    tab = "calendar";
    const d = new Date(logDate + "T00:00:00");
    calYear = d.getFullYear();
    calMonth = d.getMonth();
    calSelectedDate = logDate;
    render();
  }
  else if (action === "reset-log-date") { logDate = todayISO(); endLadder(); render(); }
  else if (action === "toggle-ladder-mode") { toggleLadderMode(); }
  else if (action === "set-log-entry-type") { setLogEntryType(el.dataset.type); }
  else if (action === "ladder-switch-exercise") { switchLadderExercise(el.dataset.id); }
  else if (action === "set-ladder-block-label") { setLadderBlockLabel(el.dataset.label); }
  else if (action === "prefill-last") { prefillFromLast(); }
  else if (action === "cancel-edit-entry") { cancelEditEntry(); }
  else if (action === "edit-entry") { startEditEntry(el.dataset.id); }
  else if (action === "view-log-wod-date-calendar") {
    tab = "calendar";
    const d = new Date(wodLogDate + "T00:00:00");
    calYear = d.getFullYear();
    calMonth = d.getMonth();
    calSelectedDate = wodLogDate;
    render();
  }
  else if (action === "reset-wod-log-date") { wodLogDate = todayISO(); renderWodContent(); }
  else if (action === "cancel-edit-wod-entry") { cancelEditWodEntry(); }
  else if (action === "edit-wod-entry") { startEditWodEntry(el.dataset.id); }
  else if (action === "open-picker") { openPicker(el.dataset.target); }
  else if (action === "close-picker") {
    if (el.id === "pickerOverlay" && e.target !== el) return;
    closePicker();
  }
  else if (action === "pick-movement") { choosePickedMovement(el.dataset.id); closePicker(); render(); }
  else if (action === "add-movement") { addMovement(el.dataset.name, el.dataset.category); }
  else if (action === "focus-picker-search") { document.getElementById("pickerSearch").focus(); }
  else if ((action === "step" || action === "wod-step" || action === "bw-step" || action === "builder-movement-reps" || action === "builder-movement-weight" || action === "builder-movement-duration" || action === "builder-emom-minutes" || action === "builder-time-cap" || action === "wod-emom-step" || action === "measure-step") && el.classList.contains("stepper-btn")) {
    const field = el.dataset.field, dir = +el.dataset.dir, step = +el.dataset.step, min = +el.dataset.min;
    const current = getFieldValue(action, field);
    const base = (typeof current === "number" && isFinite(current)) ? current : 0;
    const next = clampField(action, field, +(base + dir * step).toFixed(2), min);
    applyFieldValue(action, field, next);
  }
  else if (action === "save-set") { saveSet(); }
  else if (action === "set-bar-weight") { setBarWeight(+el.dataset.kg); }
  else if (action === "set-theme") { setThemePref(el.dataset.pref); }
  else if (action === "set-text-scale") { setTextScalePref(el.dataset.pref); }
  else if (action === "delete-entry") { deleteEntry(el.dataset.id); }
  else if (action === "cal-prev") { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendarGrid(); }
  else if (action === "cal-next") { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendarGrid(); }
  else if (action === "cal-select-day") { calSelectedDate = el.dataset.date; renderCalendarGrid(); }
  else if (action === "save-session-note") {
    const text = document.getElementById("sessionNoteInput");
    saveSessionNote(el.dataset.date, text ? text.value : "");
  }
  else if (action === "select-history") { historyId = historyId === el.dataset.id ? null : el.dataset.id; renderHistoryListArea(); }
  else if (action === "export-data") { exportData(); }
  else if (action === "import-data") { triggerImport(); }
  else if (action === "ask-clear") { confirmClear = true; render(); }
  else if (action === "do-clear") { clearAllData(); }
  else if (action === "cancel-clear") { confirmClear = false; render(); }
  else if (action === "switch-wod-subtab") {
    wodSubTab = el.dataset.subtab;
    // The pill buttons themselves live in renderWodTab(), which only runs
    // on a full top-level tab switch — renderWodContent() alone only swaps
    // #wodContent's innerHTML, so without this the highlighted pill stayed
    // stuck on whichever subtab was active when the WOD tab was first
    // opened, even though the content underneath switched correctly.
    document.querySelectorAll(".subtabbar .subtabbtn").forEach((btn) => {
      const active = btn.dataset.subtab === wodSubTab;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    renderWodContent();
  }
  else if (action === "open-wod-picker") { openWodPicker(); }
  else if (action === "close-wod-picker") {
    if (el.id === "wodPickerOverlay" && e.target !== el) return;
    closeWodPicker();
  }
  else if (action === "pick-wod") {
    choosePickedWod(el.dataset.id);
    closeWodPicker();
    renderWodContent();
  }
  else if (action === "delete-custom-wod") { deleteCustomWod(el.dataset.id); }
  else if (action === "select-benchmark") {
    choosePickedWod(el.dataset.id);
    wodSubTab = "log";
    render();
  }
  else if (action === "open-wod-builder") { openWodBuilder(el.dataset.name || ""); }
  else if (action === "close-wod-builder") {
    if (el.id === "wodBuilderOverlay" && e.target !== el) return;
    closeWodBuilder();
  }
  else if (action === "builder-set-format") { builderFormat = el.dataset.format; renderWodBuilderFormats(); renderWodBuilderMovements(); }
  else if (action === "toggle-builder-movement") { toggleBuilderMovement(el.dataset.name); }
  else if (action === "toggle-builder-movement-type") { setBuilderMovementType(el.dataset.name, el.dataset.type); }
  else if (action === "add-builder-movement-tag") {
    const name = cleanStr(el.dataset.name, LIMITS.nameLen), category = el.dataset.category;
    if (!name) return;
    if (WOD_MOVEMENT_TAGS.length >= 500) return;
    if (!WOD_MOVEMENT_TAGS.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
      WOD_MOVEMENT_TAGS.push({ name, category: WOD_MOVE_CATEGORIES.includes(category) ? category : "Gymnastics" });
    }
    builderMovements[name] = { reps: 10, weight: 0 };
    builderMoveSearch = "";
    const moveSearch = document.getElementById("wodBuilderMoveSearch");
    if (moveSearch) moveSearch.value = "";
    renderWodBuilderMovements("");
  }
  else if (action === "focus-wod-builder-search") { document.getElementById("wodBuilderMoveSearch").focus(); }
  else if (action === "create-wod") { createWodFromBuilder(); }
  else if (action === "save-bw") { saveBodyweight(); }
  else if (action === "toggle-bodyweight") { bodyweightExpanded = !bodyweightExpanded; renderBodyweightArea(); }
  else if (action === "open-add-measure-type") { measureAddOpen = true; renderMeasureArea(); }
  else if (action === "cancel-add-measure-type") { measureAddOpen = false; renderMeasureArea(); }
  else if (action === "confirm-add-measure-type") {
    const input = document.getElementById("measureTypeInput");
    addMeasureType(input ? input.value : "");
  }
  else if (action === "toggle-measure-type") {
    measureExpandedId = measureExpandedId === el.dataset.id ? null : el.dataset.id;
    renderMeasureArea();
  }
  else if (action === "delete-measure-type") { deleteMeasureType(el.dataset.id); }
  else if (action === "save-measurement") { saveMeasurement(el.dataset.id); }
  else if (action === "delete-measurement-entry") { deleteMeasurementEntry(el.dataset.id); }
  else if (action === "save-user-name") { saveWelcomeForm(document.getElementById("welcomeNameInput").value); }
  else if (action === "skip-user-name") { saveWelcomeForm(""); }
  else if (action === "cancel-welcome-name") { closeWelcomeModal(); }
  else if (action === "edit-user-name") { openWelcomeModal(true); }
  else if (action === "open-profile-from-achievements") { closeAchievements(); openWelcomeModal(true); }
  else if (action === "close-celebration") {
    if (el.id === "celebrationOverlay" && e.target !== el) return;
    closeCelebration();
  }
  else if (action === "share-achievement") {
    if (typeof window.shareAchievementToCommunity === "function") window.shareAchievementToCommunity(el.dataset.id, el.dataset.title, el.dataset.rule);
  }
  else if (action === "open-achievements") { openAchievements(); }
  else if (action === "close-achievements") {
    if (el.id === "achievementsOverlay" && e.target !== el) return;
    closeAchievements();
  }
  else if (action === "open-notifications") { openNotifications(); }
  else if (action === "close-notifications") {
    if (el.id === "notificationsOverlay" && e.target !== el) return;
    closeNotifications();
  }
  else if (action === "close-onboarding") {
    if (el.id === "onboardingOverlay" && e.target !== el) return;
    closeOnboarding();
  }
  else if (action === "set-rx") {
    wodRx = el.dataset.rx === "1";
    renderWodContent();
  }
  else if (action === "copy-last-scaled") {
    const last = lastScaledAttempt(selectedWodId);
    wodNotes = last && last.notes ? last.notes : "";
    if (last && last.scaledWeight) wodScaledWeight = last.scaledWeight;
    renderWodContent();
  }
  else if (action === "save-wod") { saveWod(); }
  else if (action === "delete-wod-entry") { deleteWodEntry(el.dataset.id); }
  else if (action === "select-wod-history") { wodHistoryId = wodHistoryId === el.dataset.id ? null : el.dataset.id; renderWodHistoryListArea(); }
});
document.getElementById("pickerSearch").addEventListener("input", (e) => renderPickerList(cleanStr(e.target.value, LIMITS.nameLen)));
document.getElementById("pickerSearch").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const q = e.target.value.trim();
  if (!q) return;
  const exact = allMovements().find((m) => m.name.toLowerCase() === q.toLowerCase());
  if (exact) { choosePickedMovement(exact.id); closePicker(); render(); }
  else e.target.blur();
});
document.getElementById("wodPickerSearch").addEventListener("input", (e) => renderWodPickerList(cleanStr(e.target.value, LIMITS.nameLen)));
document.getElementById("wodBuilderMoveSearch").addEventListener("input", (e) => renderWodBuilderMovements(cleanStr(e.target.value, LIMITS.nameLen)));
document.getElementById("wodBuilderMoveSearch").addEventListener("keydown", (e) => {
  if (e.key === "Enter") e.target.blur();
});
document.getElementById("welcomeNameInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); saveWelcomeForm(e.target.value); }
});

document.addEventListener("focusin", (e) => {
  // Select (don't clear) the existing value: typing immediately replaces
  // it, same as before, but the value is never destructively wiped just
  // from tapping in — a screen reader still announces it, and clicking to
  // reposition the cursor for a small edit still works normally.
  if (e.target.classList && e.target.classList.contains("stepper-val")) e.target.select();
});
document.addEventListener("keydown", (e) => {
  if (e.target.classList && e.target.classList.contains("stepper-val") && e.key === "Enter") {
    e.preventDefault();
    e.target.blur();
  }
});
document.addEventListener("input", (e) => {
  const el = e.target;
  if (!el.classList || !el.classList.contains("stepper-val")) return;
  const raw = String(el.value).trim().replace(",", ".");
  if (raw === "" || raw === "-" || raw === ".") return;
  const val = parseFloat(raw);
  if (!isFinite(val)) return;
  const action = el.dataset.action, field = el.dataset.field;
  setFieldState(action, field, clampField(action, field, val, +el.dataset.min));
  if (action === "step" && field === "weight" && logEntryType === "reps") {
    const bv = document.getElementById("barbellVisual");
    if (bv) bv.innerHTML = renderBarbell(weight);
  }
  if (action === "step") {
    if (logEntryType === "reps") {
      const estEl = document.getElementById("estLineValue");
      if (estEl) estEl.textContent = estimate1RM(weight, reps) + " kg";
    } else if (field === "durationSeconds") {
      const durEl = document.getElementById("durationLineValue");
      if (durEl) durEl.textContent = formatDuration(durationSeconds);
    }
  }
});
document.addEventListener("focusout", (e) => {
  const el = e.target;
  if (!el.classList || !el.classList.contains("stepper-val")) return;
  const action = el.dataset.action, field = el.dataset.field, min = +el.dataset.min;
  const current = getFieldValue(action, field);
  const safe = (typeof current === "number" && isFinite(current)) ? current : 0;
  applyFieldValue(action, field, clampField(action, field, +safe.toFixed(2), min));
});
document.getElementById("wodPickerSearch").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const q = e.target.value.trim();
  if (!q) return;
  const exact = allWods().find((w) => w.name.toLowerCase() === q.toLowerCase());
  if (exact) { choosePickedWod(exact.id); closeWodPicker(); renderWodContent(); }
  else openWodBuilder(q);
});

// ---------- Init ----------
async function init() {
  loadThemePref();
  applyThemePref();
  loadTextScalePref();
  applyTextScalePref();
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (themePref === "auto") syncThemeColorMeta();
    });
  }
  document.getElementById("dateLabel").textContent = new Date().toLocaleDateString("he-IL", { weekday: "short", day: "numeric", month: "short" });
  await reloadFromDb();
  await loadUserName();
  await loadLastExport();
  await loadBarWeight();
  await loadBoxStartDate();
  await loadSeenAchievements();
  await loadLastSeenVersion();
  await loadOnboardedFlag();
  document.getElementById("loading").style.display = "none";
  document.getElementById("app").style.display = "block";
  renderUserGreeting();
  render();

  // Bootstrap flags that predate this device ever tracking them. A device
  // with real data/a name already existed before update-notifications and
  // onboarding shipped — it must never see either retroactively. A device
  // with nothing at all is a genuinely fresh install: the welcome modal
  // (below) leads into onboarding on its own, and there's no changelog
  // worth showing someone who's never used the app.
  const isFreshInstall = userName === null && entries.length === 0 && wodEntries.length === 0
    && customMovements.length === 0 && bodyweightEntries.length === 0 && measureTypes.length === 0;
  if (lastSeenVersion === null) {
    lastSeenVersion = isFreshInstall ? APP_VERSION : "0.0.0";
    dbSetSetting(LAST_SEEN_VERSION_KEY, lastSeenVersion).catch(() => {});
  }
  if (!hasOnboarded && !isFreshInstall) {
    hasOnboarded = true;
    dbSetSetting(HAS_ONBOARDED_KEY, true).catch(() => {});
  }
  updateNotificationsBadge();

  if (userName === null) openWelcomeModal();
  else if (unseenReleaseNotes().length) openNotifications();

  if ("serviceWorker" in navigator) {
    // The SW no longer calls skipWaiting() on install, so a new version parks
    // in "waiting" until offerUpdate() applies it (see the update handshake
    // above) — either right away if the page isn't currently visible, or via
    // the banner/next visibility-regain otherwise. That keeps the running
    // page and its cached assets on the same version until it's safe to swap.
    navigator.serviceWorker.register("./sw.js").then((reg) => {
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) offerUpdate(nw);
        });
      });
    }).catch((e) => console.warn("sw registration failed:", e));

    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!swapRequested) return; // e.g. the first-ever clients.claim() — nothing to reload for
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  }
}
init();
