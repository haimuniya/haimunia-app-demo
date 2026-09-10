#!/usr/bin/env node
// Static audit for three real bug SHAPES found by a manual role-coverage
// pass (2026-09-10, see CHANGES.md "A role-coverage audit"), encoded here
// as mechanical, rerunnable checks instead of one-off findings:
//
//   1. PERMISSION-GATE MISMATCH. A control renders behind one hasPerm()
//      check, but the server RPC it calls actually requires a STRICTER
//      permission on some code path (often reached only via a `perform
//      public.other_fn(...)` a few lines deep). The role that can see and
//      click the control is not the role that can actually use it - it
//      fails with an unexplained "not authorized" every time. This is
//      exactly the coach/restrict-button bug this pass fixed.
//   2. TYPE-COVERAGE GAP. A server RPC accepts a closed enum of values
//      (`if p_x not in (...) then raise exception`) for some "kind"
//      argument, but the client only ever produces a DOM control for a
//      SUBSET of that enum - the other values are only reachable by
//      calling the handler directly, never by a real click. This is
//      exactly the pin-target-type bug this pass fixed (pins worked for
//      announcements only, though challenges/events/posts were always
//      valid server-side).
//   3. DEAD FIELD REGISTRY ENTRY. A `{ key, label }`-style array renders a
//      real, working control (a checkbox, a toggle) for a field that
//      nothing else in the client ever reads or branches on - a control
//      for a feature that doesn't exist. This is exactly the
//      allow_messages privacy-toggle bug this pass removed.
//
// HOW TO READ THE OUTPUT. Every finding is a CANDIDATE for human review,
// not a proven defect - this is regex-based static analysis over a large,
// dynamic codebase, not a real parser or a live permission trace. It WILL
// have false positives (a permission checked through a path this script's
// one-hop call resolution doesn't follow; a field genuinely read through a
// naming convention this script doesn't recognize). Read each finding's
// evidence and verify in the code before treating it as real - the same
// discipline this repo already applies to every audit finding it ships.
//
// WHY THIS EXISTS. All three bugs it targets were invisible to the full
// test suite, the full browser-check regression, and every prior static
// audit pass in docs/audit/ - none of those tools trace "does the button
// that's visible to role X actually work for role X," "does every value a
// server enum accepts have a real client control," or "does this toggle's
// column get consumed by anything." This script is a standing, rerunnable
// check for exactly those three shapes so the next instance doesn't need
// a fresh multi-agent research pass to be caught again.
//
// A KNOWN, ACCEPTED LIMITATION OF CHECK 1, found the hard way while
// building this: it only sees a render function's OUTER gate, not a
// PER-BUTTON inner conditional inside it. After renderRestrictionsPanel()
// was fixed to wrap just its lift-restriction button in `canLift ? ... :
// ""`, this check kept flagging it - it still sees the literal
// `data-community-action="lift-restriction"` text and the function's
// whole-body permission set (which still includes the looser
// comment.moderate from the panel's own outer gate), with no model of
// which inner ternary actually controls that one occurrence. Verify by
// reading the code around a flagged occurrence, same as every other
// finding this script produces - a still-flagged action after a real fix
// is expected here, not a sign the fix didn't work.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLOUD_JS = fs.readFileSync(path.join(root, "cloud.js"), "utf8");
const APP_JS = fs.readFileSync(path.join(root, "app.js"), "utf8");
const MIGRATIONS_DIR = path.join(root, "supabase", "migrations");
const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
const MIGRATIONS = migrationFiles.map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")).join("\n");

let findings = [];
function flag(check, summary, evidence) { findings.push({ check, summary, evidence }); }

// ===========================================================================
// Shared parsing: roles/permissions, server function bodies, client function
// bodies, PERM.KEY -> "permission.string" map, action -> handler resolution.
// ===========================================================================

// role -> rank, from `insert into public.roles (code, label, rank) values (...)`.
const ROLE_RANK = {};
for (const m of MIGRATIONS.matchAll(/\(\s*'(\w+)'\s*,\s*'[^']*'\s*,\s*(\d+)\s*\)/g)) {
  // Only trust rows that look like the roles seed (small rank, known code
  // shape); this regex is loose on purpose since roles are seeded once but
  // we don't want to hardcode the migration filename.
  const [, code, rank] = m;
  if (/^(member|coach|head_coach|staff|admin|owner)$/.test(code)) ROLE_RANK[code] = Number(rank);
}

// role -> Set<permission>, from every `insert into public.role_permissions ... values (...);` block.
const ROLE_PERMS = {};
for (const block of MIGRATIONS.matchAll(/insert into public\.role_permissions[\s\S]*?;/g)) {
  for (const row of block[0].matchAll(/\(\s*'(\w+)'\s*,\s*'([\w.]+)'\s*\)/g)) {
    const [, role, perm] = row;
    (ROLE_PERMS[role] ||= new Set()).add(perm);
  }
}
function minRankHolding(perms) {
  // perms: Set<string>, entries are either real "a.b.c" permission strings
  // or the pseudo-permissions "is_admin()" / "is_staff()" handled below.
  let min = Infinity;
  for (const [role, rank] of Object.entries(ROLE_RANK)) {
    let holds = true;
    for (const p of perms) {
      if (p === "is_admin()") { if (rank < 50) { holds = false; break; } continue; }
      if (p === "is_staff()") { if (rank < 20) { holds = false; break; } continue; }
      if (!(ROLE_PERMS[role] || new Set()).has(p)) { holds = false; break; }
    }
    if (holds && rank < min) min = rank;
  }
  return min; // Infinity if no seeded role satisfies every entry (or perms is malformed).
}

// server function name -> raw body text, from `create or replace function
// public.NAME(` to THAT SAME FUNCTION's own `$$;` terminator - not to the
// next function declaration. This repo's migrations mix function
// definitions with `create policy`/`grant`/`revoke` statements in the same
// file, so slicing to "the next function" swept unrelated policy text
// (often containing its own is_admin()/has_perm() checks for a totally
// different table) into whatever function happened to precede it - a real
// false-positive source this script's own first run hit (pin_clear falsely
// showed an is_staff()/is_admin() requirement that was actually a nearby
// CREATE POLICY's own check, not anything pin_clear does). Every function
// body in this codebase consistently closes with `$$;` right after its
// `as $$ ... end $$` - the same convention read by hand across a dozen
// functions this session - so stop there instead.
const SERVER_FN_BODY = {};
{
  const starts = [...MIGRATIONS.matchAll(/create or replace function public\.(\w+)\(/g)];
  for (let i = 0; i < starts.length; i++) {
    const name = starts[i][1];
    const from = starts[i].index;
    const asIdx = MIGRATIONS.indexOf("as $$", from);
    const endIdx = asIdx >= 0 ? MIGRATIONS.indexOf("$$;", asIdx + 5) : -1;
    const to = endIdx >= 0 ? endIdx + 3 : (i + 1 < starts.length ? starts[i + 1].index : MIGRATIONS.length);
    // Keep the LAST declaration if a function is re-declared across
    // migrations (later files win, same as Postgres CREATE OR REPLACE).
    SERVER_FN_BODY[name] = MIGRATIONS.slice(from, to);
  }
}
// function name -> Set<permission required, INCLUDING transitively through
// `public.other_fn(...)` calls its body makes>, depth-capped.
const SERVER_FN_PERMS_CACHE = {};
function serverFnPerms(name, depth = 0, seen = new Set()) {
  if (SERVER_FN_PERMS_CACHE[name]) return SERVER_FN_PERMS_CACHE[name];
  const result = new Set();
  const body = SERVER_FN_BODY[name];
  if (!body || depth > 4 || seen.has(name)) return result;
  seen.add(name);
  // ONLY a blocking check counts as "required" - `if not ... has_perm(...)
  // then raise exception` (or `if not (has_perm(...) or ...) then raise`).
  // A PERMISSIVE early-return bypass - `if public.is_admin() then return
  // true; end if;`, the shape can_view_profile_field() and several other
  // read-path functions use to let an admin see past a privacy toggle -
  // is not a requirement on anyone else and must not read as one. This
  // script's own first run found exactly that false positive (chal_progress
  // looked like it required is_admin() solely because a function it calls,
  // can_view_profile_field(), has an unrelated admin bypass branch deep
  // inside it) - this distinction is why that finding does not reappear.
  for (const m of body.matchAll(/if\s+not\s+\(?\s*(?:public\.)?has_perm\('([\w.]+)'\)/g)) result.add(m[1]);
  if (/if\s+not\s+\(?\s*(?:public\.)?is_admin\(\)/.test(body)) result.add("is_admin()");
  if (/if\s+not\s+\(?\s*(?:public\.)?is_staff\(\)/.test(body)) result.add("is_staff()");
  for (const m of body.matchAll(/public\.(\w+)\(/g)) {
    if (m[1] === name || !SERVER_FN_BODY[m[1]]) continue;
    for (const p of serverFnPerms(m[1], depth + 1, seen)) result.add(p);
  }
  SERVER_FN_PERMS_CACHE[name] = result;
  return result;
}

// PERM.KEY -> "permission.string", from the client's own PERM = {...} table.
const PERM_CONST = {};
{
  const block = CLOUD_JS.match(/const PERM = \{([\s\S]*?)\n  \};/);
  if (block) for (const m of block[1].matchAll(/(\w+):\s*"([\w.]+)"/g)) PERM_CONST[m[1]] = m[2];
}

// Top-level `  function NAME(` bodies in cloud.js, by textual range - same
// heuristic boundary check-migration-immutability.mjs's neighbors use
// elsewhere in this repo: good enough for this file's consistent style,
// not a real parser (does not track nested closing braces precisely).
const CLIENT_FN_RANGES = [];
{
  // NOTE: must match `async function` too, or a short non-async function's
  // captured "body" silently runs on through every function after it up to
  // the next NON-async boundary - a real bug this script's own first run
  // hit (confirmCancelEvent's 2-line body appeared to contain a call to
  // post_create() that actually belongs to unrelated code many functions
  // later, because the intervening `async function cancelEvent(id)` wasn't
  // recognized as a boundary).
  const starts = [...CLOUD_JS.matchAll(/\n  (?:async )?function (\w+)\(/g)];
  for (let i = 0; i < starts.length; i++) {
    const name = starts[i][1];
    const from = starts[i].index;
    const to = i + 1 < starts.length ? starts[i + 1].index : CLOUD_JS.length;
    CLIENT_FN_RANGES.push({ name, from, to, body: CLOUD_JS.slice(from, to) });
  }
}
function clientFnBody(name) { return CLIENT_FN_RANGES.find((f) => f.name === name)?.body || ""; }

// Does calling `name(...)` reach a client.rpc("X") call DIRECTLY (this
// function's own body, no further recursion)? Deliberately shallow: a
// dispatcher arm that opens a multi-purpose form/panel function (e.g.
// event-edit -> openEventForm()) touches dozens of unrelated RPCs several
// hops down through that function's own render/load helpers - none of
// which are "what this click does." The real bug this script targets
// (mod-action-run -> runModAction() -> .rpc("mod_review")) is exactly ONE
// hop; recursing further trades false negatives (missed real bugs reached
// through a longer chain) for a flood of false positives (unrelated RPCs
// vacuumed out of big shared UI functions), and the false-positive
// direction is worse for a tool meant to be trusted on repeat runs.
function clientFnRpcs(name) {
  const result = new Set();
  const body = clientFnBody(name);
  if (!body) return result;
  for (const m of body.matchAll(/\.rpc\(\s*"(\w+)"/g)) result.add(m[1]);
  return result;
}

// action string -> the raw dispatcher-arm text in window.handleCommunityClick
// (`else if (action === "X") ...` up to the next such arm).
const ACTION_ARM = {};
{
  const dStart = CLOUD_JS.indexOf("window.handleCommunityClick = function");
  const dEnd = CLOUD_JS.indexOf("\n  window.", dStart + 1);
  const dispatcher = dStart >= 0 ? CLOUD_JS.slice(dStart, dEnd > 0 ? dEnd : undefined) : "";
  const parts = dispatcher.split(/else if \(action === "([\w-]+)"\)/);
  // parts[0] is pre-amble; then alternating [actionName, armText, actionName, armText, ...]
  for (let i = 1; i + 1 <= parts.length; i += 2) {
    const actionName = parts[i];
    const armText = parts[i + 1] || "";
    ACTION_ARM[actionName] = armText;
  }
}
// action string -> Set<rpc name> reached from its dispatcher arm, directly
// or via a one-name-deep call into a client function.
function actionRpcs(action) {
  const arm = ACTION_ARM[action];
  const result = new Set();
  if (!arm) return result;
  for (const m of arm.matchAll(/\.rpc\(\s*"(\w+)"/g)) result.add(m[1]);
  for (const m of arm.matchAll(/\b(\w+)\(/g)) {
    const callee = m[1];
    if (!CLIENT_FN_RANGES.some((f) => f.name === callee)) continue;
    for (const r of clientFnRpcs(callee)) result.add(r);
  }
  return result;
}

// ===========================================================================
// CHECK 1 - permission-gate mismatch: for every top-level render function,
// find its declared gate (hasPerm(PERM.X) calls anywhere in its body - a
// coarse over-approximation, deliberately: a false negative here just means
// "not flagged," which is the safe direction to err in for a lint tool),
// then for every action rendered inside it, compare the RPC's effective
// (transitive) required-permission rank against the gate's rank.
// ===========================================================================
{
  const renderFns = CLIENT_FN_RANGES.filter((f) => /^render/.test(f.name));
  for (const fn of renderFns) {
    const gatePerms = new Set();
    for (const m of fn.body.matchAll(/hasPerm\(PERM\.(\w+)\)/g)) if (PERM_CONST[m[1]]) gatePerms.add(PERM_CONST[m[1]]);
    if (/\bisAdmin\(\)/.test(fn.body)) gatePerms.add("is_admin()");
    if (/\bisStaff\(\)/.test(fn.body)) gatePerms.add("is_staff()");
    if (gatePerms.size === 0) continue; // no local gate found - can't compare, not a finding either way.
    // Treat the collected permissions as an OR, not an AND: this script's
    // own first validation run against the known coach/restrict bug missed
    // it entirely because renderModeration()'s real gate is `hasPerm(PERM.
    // COMMENT_MODERATE) || isAdmin()` - reaching it needs EITHER, not
    // both - and minRankHolding() over the whole set demands a role that
    // holds every entry simultaneously, which only `admin` does (rank 50),
    // masking that `coach` (rank 20, holds comment.moderate alone) can
    // already reach the section in real life. The minimum rank able to
    // pass the gate is the BEST (loosest) of its individual conditions,
    // not the rank required to satisfy all of them jointly. This is also
    // the conservative direction for a lint tool: assuming the loosest
    // gate consistent with the evidence means erring toward flagging a
    // real issue rather than silently clearing one.
    const gateRank = Math.min(...[...gatePerms].map((p) => minRankHolding(new Set([p]))));
    if (!Number.isFinite(gateRank)) continue; // couldn't resolve to a real role - skip rather than guess.

    const actionsHere = new Set();
    for (const m of fn.body.matchAll(/data-community-action="([\w-]+)"/g)) actionsHere.add(m[1]);
    for (const action of actionsHere) {
      for (const rpc of actionRpcs(action)) {
        const reqPerms = serverFnPerms(rpc);
        if (reqPerms.size === 0) continue; // couldn't resolve the server side - skip.
        const reqRank = minRankHolding(reqPerms);
        if (!Number.isFinite(reqRank)) continue;
        if (gateRank < reqRank) {
          flag(
            "permission-gate-mismatch",
            `${fn.name}() gates a control that calls "${action}" -> ${rpc}(), but the RPC needs a stricter permission than the render gate`,
            `render gate: {${[...gatePerms].join(", ")}} (min rank ${gateRank}) < RPC requirement: {${[...reqPerms].join(", ")}} (min rank ${reqRank})`
          );
        }
      }
    }
  }
}

// ===========================================================================
// CHECK 2 - type-coverage gap: for every server RPC with a closed-enum
// guard (`if p_x not in ('a','b',...) then raise exception`), find every
// client action that reaches it, and check that every enum value the
// server accepts has at least one real `data-type="value"` (or
// `data-target-type=`) producer paired with that action somewhere in
// cloud.js - not just a value the mock/tests pass via a direct call.
// ===========================================================================
{
  const enumGuards = [];
  const seenFnNames = new Set(); // a redeclared function (later migration) matches this scan once per declaration - dedupe by name, SERVER_FN_BODY already resolved to the final one.
  for (const fnStart of MIGRATIONS.matchAll(/create or replace function public\.(\w+)\(/g)) {
    const name = fnStart[1];
    if (seenFnNames.has(name)) continue;
    seenFnNames.add(name);
    const body = SERVER_FN_BODY[name];
    if (!body) continue;
    for (const g of body.matchAll(/if\s+(p_\w*type\w*)\s+not in\s*\(([^)]+)\)\s+then/g)) {
      const values = [...g[2].matchAll(/'([\w-]+)'/g)].map((x) => x[1]);
      if (values.length >= 2) enumGuards.push({ rpc: name, param: g[1], values });
    }
  }
  // action -> Set<rpc> already built lazily via actionRpcs(); build the
  // inverse by scanning every known action once.
  const rpcToActions = {};
  for (const action of Object.keys(ACTION_ARM)) {
    for (const rpc of actionRpcs(action)) (rpcToActions[rpc] ||= new Set()).add(action);
  }
  for (const guard of enumGuards) {
    const actions = rpcToActions[guard.rpc];
    if (!actions || actions.size === 0) continue; // no client caller found - not this check's job.
    const observed = new Set();
    for (const action of actions) {
      const re = new RegExp(`data-community-action="${action}"[^>]*?data-type="([\\w-]+)"`, "g");
      for (const m of CLOUD_JS.matchAll(re)) observed.add(m[1]);
      // Also the reverse attribute order (data-type before the action).
      const re2 = new RegExp(`data-type="([\\w-]+)"[^>]*?data-community-action="${action}"`, "g");
      for (const m of CLOUD_JS.matchAll(re2)) observed.add(m[1]);
    }
    // Two more signals, unioned in, because `data-type` is very often a
    // template variable rather than a literal (a shared helper function
    // parameterized by type, e.g. pinToggleHtml(type, id, note) - the
    // attribute-adjacency regex above only catches a literal in the DOM
    // markup itself, not a value passed one level up as a plain call
    // argument to that helper):
    //   (a) the literal `data-type="V"` appears ANYWHERE in the file, not
    //       necessarily next to this exact action's literal name.
    //   (b) the bare literal "V" appears as a quoted call argument within
    //       300 characters of the rpc name or one of its action names -
    //       loose, but this check already flags nothing it can't show
    //       working evidence for, so a wider net here trades a few
    //       possible false negatives for far fewer false positives.
    for (const v of guard.values) {
      if (new RegExp(`data-type="${v}"`).test(CLOUD_JS)) { observed.add(v); continue; }
      const anchors = [guard.rpc, ...actions];
      for (const m of CLOUD_JS.matchAll(new RegExp(`["'\`,(]\\s*"${v}"`, "g"))) {
        const window = CLOUD_JS.slice(Math.max(0, m.index - 300), m.index + 300);
        if (anchors.some((a) => window.includes(a))) { observed.add(v); break; }
      }
    }
    const missing = guard.values.filter((v) => !observed.has(v));
    if (missing.length) {
      flag(
        "type-coverage-gap",
        `${guard.rpc}() accepts ${guard.param} values [${guard.values.join(", ")}], but only [${[...observed].join(", ") || "none"}] have a real data-type producer on action(s) [${[...actions].join(", ")}]`,
        `missing client control(s) for: ${missing.join(", ")}`
      );
    }
  }
}

// ===========================================================================
// CHECK 3 - dead field-registry entry: for every `{ key: "x", label: "y" }`
// array (privacy toggles, club-module toggles, and similarly-shaped
// registries), flag any key that appears NOWHERE else in cloud.js/app.js
// beyond its own declaration - zero other occurrences, not "only one."
//
// KNOWN LIMITATION, stated plainly rather than overclaimed: this check's
// signal is much weaker for a registry like PRIVACY_FIELDS than for one
// like CLUB_MODULE_TOGGLES. A club-module toggle is enforced entirely
// client-side (`isModuleEnabled("x")` gates whether a section renders at
// all), so "consumed exactly once, at that gate" is real, sufficient
// evidence the feature exists. A privacy toggle's real enforcement is
// mostly SERVER-side (can_view_profile_field() decides what another
// member's client ever receives) - a privacy field that is fetched into
// PROFILE_COLUMNS and nothing else has exactly the same shape whether the
// feature behind it is real (server-enforced, client never needs a second
// reference) or genuinely doesn't exist. The allow_messages bug this
// script's checks were modeled on had EXACTLY that one-reference shape
// before it was removed - a >0 threshold would have cleared it as easily
// as it clears every other privacy field, member and non-member alike.
// That bug was actually found by asking "does a messaging feature exist
// anywhere in this app," a semantic question this script cannot ask.
// A >=1 threshold here would produce constant, uninformative noise on
// every server-enforced privacy field (verified: show_achievements and
// show_upcoming_booking sit at exactly the same 1-reference shape as
// show_prs/show_attendance/every other privacy toggle that is genuinely
// fine) - so this check only flags the zero-reference case, which is
// still a real, if narrower, signal for a client-enforced registry.
// ===========================================================================
{
  const registryRe = /const (\w+) = \[\s*((?:\{\s*key:[\s\S]*?\},?\s*)+)\];/g;
  for (const m of CLOUD_JS.matchAll(registryRe)) {
    const [, arrayName, body] = m;
    const keys = [...body.matchAll(/key:\s*"(\w+)"/g)].map((x) => x[1]);
    if (keys.length < 3) continue; // too small to be a real registry - avoid noise on one-off pairs.
    for (const key of keys) {
      const whole = new RegExp(`\\b${key}\\b`, "g");
      const cloudCount = (CLOUD_JS.match(whole) || []).length;
      const appCount = (APP_JS.match(whole) || []).length;
      // Subtract this key's own declaration line inside the registry.
      const total = cloudCount + appCount - 1;
      if (total === 0) {
        flag(
          "dead-field-registry",
          `${arrayName}'s "${key}" is referenced 0 times outside its own declaration - looks like a control with nothing consuming it`,
          `checked cloud.js (${cloudCount}x) + app.js (${appCount}x), minus its own "key: \\"${key}\\"" line`
        );
      }
    }
  }
}

// ===========================================================================
// Report
// ===========================================================================
console.log(`audit-role-coverage: ${MIGRATIONS.length} bytes of migrations (${migrationFiles.length} files), cloud.js ${CLOUD_JS.length} bytes`);
console.log(`roles resolved: ${Object.keys(ROLE_RANK).join(", ") || "(none - check ROLE_RANK regex)"}`);
console.log(`server functions indexed: ${Object.keys(SERVER_FN_BODY).length}`);
console.log(`client top-level functions indexed: ${CLIENT_FN_RANGES.length}`);
console.log(`dispatcher actions indexed: ${Object.keys(ACTION_ARM).length}`);
console.log("");

if (findings.length === 0) {
  console.log("audit-role-coverage: no candidates found by any of the 3 checks.");
} else {
  const byCheck = {};
  for (const f of findings) (byCheck[f.check] ||= []).push(f);
  for (const [check, items] of Object.entries(byCheck)) {
    console.log(`\n=== ${check} (${items.length}) ===`);
    for (const f of items) {
      console.log(`  - ${f.summary}`);
      console.log(`    ${f.evidence}`);
    }
  }
  console.log(`\naudit-role-coverage: ${findings.length} candidate(s) - each is heuristic, verify in code before treating as real (see this file's own header).`);
}
