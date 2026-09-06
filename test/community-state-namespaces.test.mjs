// COMM-365. cloud.js's `state` used to be ~139 flat sibling keys where the
// only thing stopping two feature clusters from colliding on a name like
// `view`, `items`, `loading` or `error` was a hand-maintained prefix
// convention (feedScope / challengeView / coachCelebrate / modQueueStatus).
// It is now namespaced by feature domain.
//
// This file is the guard that keeps it that way, and - more usefully - the
// guard that a namespaced path is never MIS-typed. A flat `state.foo` that no
// longer exists throws the moment it is read; a `state.feed.scop` typo reads
// undefined forever and silently renders the wrong thing. So the load-bearing
// assertion here is the third one: every two-level `state.<ns>.<leaf>`
// reference anywhere in cloud.js must name a leaf the literal declares.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

// The session/auth/config core, deliberately left flat at the root: every
// domain reads it and no domain owns it. Adding to this list should be a
// conscious decision, which is why it is spelled out rather than derived.
const ROOT_SCALARS = [
  "configured", "client", "user", "profile", "redemption", "syncEnabled",
  "signupStarted", "communityDataLoaded", "communityDataLoading",
  "permissions", "permissionsLoaded", "featureFlags", "avatarUpload",
  // Launch-readiness audit, CQ-006. Load-failure flags for the two root
  // scalars immediately above - not a feature domain of their own, just
  // "did the last fetch of profile/redemption fail", read only by the join
  // funnel that already reads profile/redemption directly.
  "profileLoadError", "redemptionLoadError",
];

function readStateLiteral() {
  const start = src.indexOf("  const state = {");
  assert.ok(start > -1, "cloud.js must still declare `const state = {`");
  const end = src.indexOf("\n  };\n", start) + "\n  };\n".length;
  const body = src.slice(start, end);
  // configured/client/localStorage are the only three things the literal
  // closes over.
  return new Function("configured", "client", "localStorage", body + "\nreturn state;")(
    true, {}, { getItem: () => null }
  );
}

test("the state root is the session core plus per-domain namespaces, nothing else", () => {
  const state = readStateLiteral();
  const namespaces = Object.keys(state).filter((k) => !ROOT_SCALARS.includes(k));
  for (const k of ROOT_SCALARS) {
    assert.ok(Object.prototype.hasOwnProperty.call(state, k), `${k} must still be declared at the root`);
  }
  // Everything that is not session core must be a namespace object - never a
  // bare new flat key. This is the assertion a future feature cluster trips
  // if it adds `state.somethingNew` as a top-level sibling.
  for (const ns of namespaces) {
    const v = state[ns];
    assert.ok(v && typeof v === "object" && !Array.isArray(v),
      `state.${ns} is a flat non-namespace key - put it inside a feature domain (or in ROOT_SCALARS here, deliberately)`);
  }
  assert.deepEqual(namespaces, [
    "ui", "feed", "posts", "engagement", "members", "club", "leaderboard",
    "admin", "analytics", "challenges", "events", "search", "achievements",
    "notif", "onboarding", "intro", "recaps",
    // The community write queue's view-model (launch-readiness audit,
    // RELIABILITY): { pending, failed }. A real namespace rather than two
    // root scalars, because it groups two related leaves that are always
    // read together by the outbox banner.
    "outbox",
    "coach",
  ], "the namespace set changed - update this list and docs/community/backlog.md's COMM-365 row");
});

test("every namespace declares at least two leaves, so a namespace is a real grouping", () => {
  const state = readStateLiteral();
  for (const ns of Object.keys(state).filter((k) => !ROOT_SCALARS.includes(k))) {
    assert.ok(Object.keys(state[ns]).length >= 2, `state.${ns} has fewer than two leaves`);
  }
});

test("every state.<namespace>.<leaf> reference in cloud.js names a declared leaf", () => {
  const state = readStateLiteral();
  const rootKeys = Object.keys(state);
  const namespaces = rootKeys.filter((k) => !ROOT_SCALARS.includes(k));
  const problems = new Set();
  const referenced = {};

  for (const m of src.matchAll(/\bstate\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g)) {
    const [, ns, leaf] = m;
    if (!rootKeys.includes(ns)) { problems.add(`state.${ns} is not a declared state key`); continue; }
    if (!namespaces.includes(ns) || leaf === undefined) continue;
    (referenced[ns] = referenced[ns] || new Set()).add(leaf);
    if (!Object.prototype.hasOwnProperty.call(state[ns], leaf)) {
      problems.add(`state.${ns}.${leaf} is read/written but not declared in the state literal`);
    }
  }
  assert.deepEqual([...problems], [], [...problems].join("\n"));

  // And the reverse: a declared leaf nothing reads is dead state. Every one
  // of them was referenced when COMM-365 landed; if this trips, either the
  // reference was deleted and the leaf should go too, or a new leaf was added
  // ahead of its consumer (in which case say so here).
  for (const ns of namespaces) {
    for (const leaf of Object.keys(state[ns])) {
      assert.ok(referenced[ns] && referenced[ns].has(leaf),
        `state.${ns}.${leaf} is declared but never referenced - dead state, or a leaf added ahead of its consumer`);
    }
  }
});

test("nothing reaches state through a computed key, so the paths above are the whole story", () => {
  // Before COMM-365 the dialog-focus registry did `state[key]`, which only
  // worked because every dialog flag happened to be a top-level sibling. That
  // is now an isOpen() getter per registry entry. A new `state[...]` would put
  // a state path beyond the reach of the assertions in this file.
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /\bstate\[/, "reach state by an explicit path, not a computed key");
});

test("the dialog registry keeps DOM keys and state paths separate", () => {
  // `key` is markup (the data-cloud-dialog attribute, and what
  // cloudDialogOpeners is keyed by) and must NOT drift with a state rename;
  // isOpen() is the only thing that knows where the flag lives.
  const registry = src.slice(src.indexOf("const CLOUD_DIALOGS = ["), src.indexOf("const cloudDialogOpeners"));
  const entries = [...registry.matchAll(/\{ key: "([^"]+)", isOpen: \(\) => (state\.[\w.]+),/g)];
  // 12 since the launch-readiness audit's A3 fix added the confirm sheet -
  // it was previously invisible to this whole registry.
  assert.equal(entries.length, 12, "every dialog entry needs a key and an isOpen getter");
  const state = readStateLiteral();
  for (const [, key, path] of entries) {
    const value = path.split(".").slice(1).reduce((o, k) => (o == null ? o : o[k]), state);
    assert.equal(value, null, `${path} (dialog "${key}") must default to null - a dialog starts closed`);
    assert.ok(src.includes(`data-cloud-dialog="${key}"`), `no overlay carries data-cloud-dialog="${key}"`);
  }
  assert.match(src, /if \(spec\.isOpen\(\) && cloudDialogEl\(spec\.key\)\) return spec\.key;/);
});

test("the sign-out reset assigns leaves, never a whole namespace", () => {
  // A `state.feed = { ... }` style reset would silently drop every key the
  // reset list does not happen to mention - and several keys are meant to
  // survive a sign-out (state.ui.tab, state.leaderboard.hideMine, the
  // localStorage-backed switches, featureFlags).
  const resetStart = src.indexOf("state.profile = null; state.redemption = null;");
  assert.ok(resetStart > -1, "the sign-out reset block must still be findable");
  const block = src.slice(resetStart, src.indexOf("rerender();", resetStart));
  const state = readStateLiteral();
  const namespaces = Object.keys(state).filter((k) => !ROOT_SCALARS.includes(k));
  for (const ns of namespaces) {
    assert.doesNotMatch(block, new RegExp(`state\\.${ns}\\s*=`),
      `the sign-out reset replaces the whole state.${ns} namespace - assign its leaves instead`);
  }
  // The two that must outlive a sign-out.
  assert.doesNotMatch(block, /state\.ui\.tab\s*=/);
  assert.doesNotMatch(block, /state\.leaderboard\.hideMine\s*=/);
});
