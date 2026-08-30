// Community Phase 2, realtime + search cluster (COMM-209, COMM-227,
// COMM-228). Same "faithful" static-assertion style as
// test/community-rls-boundaries.test.mjs (COMM-019) and
// test/community-rls-boundaries-phase1.test.mjs: this file pins the exact
// clause in the migration SQL that makes each boundary hold, so a later
// edit that widens exposure or drops a table from the realtime publication
// fails CI. See those two files' headers for the full faithful/partial/
// needs-infra rationale - it applies unchanged here.
//
// WHAT THIS FILE VERIFIES
// - 202608290007_realtime_publication.sql: exactly the five tables the
//   tickets name are added to supabase_realtime, no more, no fewer.
// - 202608290008_community_search.sql: community_search is security
//   definer with search_path pinned, revoked from anon, granted only to
//   authenticated, and the events/challenges branches read the exact same
//   status/creator/permission predicate events_read (202608280010) and
//   challenges_read (202608280009) already enforce, not a re-derived one.
//
// WHAT THIS FILE DOES NOT VERIFY
// Runtime enforcement for two real Postgres roles - the same limitation as
// every other file in this style. The runtime half (block edges,
// visible_to_club, draft visibility, the sub-2-character short-circuit,
// query sanitization, and the publication actually streaming rows) was run
// once by hand against a local `supabase db reset` stack and is recorded in
// docs/community/backlog.md's Phase 2 schema handoff for qa, which is where
// a pgTAP suite covering the runtime half belongs next.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

function migration(n) {
  return fs.readFileSync(new URL(`../supabase/migrations/${n}.sql`, import.meta.url), "utf8");
}

const mRealtime = migration("202608290007_realtime_publication");
const mSearch = migration("202608290008_community_search");

// ---------------------------------------------------------------------------
// 202608290007 - realtime publication membership
// ---------------------------------------------------------------------------

test("realtime publication [faithful]: exactly the five COMM-209/COMM-227 tables are added, one alter statement per table", () => {
  const adds = [...mRealtime.matchAll(/alter publication supabase_realtime add table public\.(\w+);/g)].map((m) => m[1]);
  assert.deepStrictEqual(
    adds.sort(),
    ["challenge_participants", "challenge_progress", "notifications", "post_comments", "reactions"].sort(),
  );
});

test("realtime publication [faithful]: no RLS or grant touched by this migration - publication membership only", () => {
  assert.doesNotMatch(mRealtime, /create policy/);
  assert.doesNotMatch(mRealtime, /revoke all/);
  assert.doesNotMatch(mRealtime, /grant /);
  assert.doesNotMatch(mRealtime, /alter table .* enable row level security/);
});

// ---------------------------------------------------------------------------
// 202608290008 - community_search
// ---------------------------------------------------------------------------

test("community_search(text, int) [faithful]: security definer, pinned search_path, revoked from anon, granted only to authenticated", () => {
  assert.match(mSearch, /create or replace function public\.community_search\(p_query text, p_limit int default 10\)\s*\nreturns jsonb\s*\nlanguage plpgsql stable security definer set search_path = ''/);
  assert.match(mSearch, /revoke all on function public\.community_search\(text, int\) from public, anon;/);
  assert.match(mSearch, /grant execute on function public\.community_search\(text, int\) to authenticated;/);
  assert.doesNotMatch(mSearch, /grant execute on function public\.community_search\(text, int\) to (?!authenticated;)/);
});

test("community_search [faithful]: raises not authorized for a null caller before any table is touched", () => {
  const fn = mSearch.slice(mSearch.indexOf("v_uid uuid := auth.uid();"), mSearch.indexOf("v_q := btrim"));
  assert.match(fn, /if v_uid is null then raise exception 'not authorized'; end if;/);
});

test("community_search [faithful]: p_query is stripped of %, _, comma and parens the same way searchPeople (cloud.js) already does, before any ilike pattern is built", () => {
  assert.match(mSearch, /v_q := btrim\(regexp_replace\(coalesce\(p_query, ''\), '\[%_,\(\)\]', '', 'g'\)\);/);
  // The stripped, trimmed value is what gets wrapped in the ilike pattern,
  // never the raw argument.
  const patternIdx = mSearch.indexOf("v_pattern := '%' || v_q || '%';");
  assert.ok(patternIdx > mSearch.indexOf("v_q := btrim"));
});

test("community_search [faithful]: a query under 2 characters short-circuits to three empty arrays before any table is read", () => {
  const shortCircuit = mSearch.slice(mSearch.indexOf("if char_length(v_q) < 2"), mSearch.indexOf("v_pattern := '%'"));
  assert.match(shortCircuit, /if char_length\(v_q\) < 2 then/);
  assert.match(shortCircuit, /'members', '\[\]'::jsonb/);
  assert.match(shortCircuit, /'events', '\[\]'::jsonb/);
  assert.match(shortCircuit, /'challenges', '\[\]'::jsonb/);
});

test("community_search members branch [faithful]: mirrors profiles_read_authenticated (202608280003) exactly - self excluded, no block edge either direction, visible_to_club or is_admin()", () => {
  const membersBlock = mSearch.slice(mSearch.indexOf("into v_members"), mSearch.indexOf("into v_events"));
  assert.match(membersBlock, /p\.deleted_at is null/);
  assert.match(membersBlock, /p\.id <> v_uid/);
  assert.match(
    membersBlock,
    /not exists \(\s*\n\s*select 1 from public\.blocks b\s*\n\s*where \(b\.blocker_id = v_uid and b\.blocked_id = p\.id\)\s*\n\s*or \(b\.blocker_id = p\.id and b\.blocked_id = v_uid\)\s*\n\s*\)/,
  );
  assert.match(membersBlock, /\(p\.visible_to_club or public\.is_admin\(\)\)/);
  assert.match(membersBlock, /p\.handle ilike v_pattern or p\.display_name ilike v_pattern/);
});

test("community_search members branch [faithful]: returns the exact searchPeople column shape - id, handle, display_name, bio, avatar_url, allow_follows", () => {
  const membersBlock = mSearch.slice(mSearch.indexOf("select coalesce(jsonb_agg(jsonb_build_object(\n    'id', m.id"), mSearch.indexOf("into v_members"));
  for (const key of ["id", "handle", "display_name", "bio", "avatar_url", "allow_follows"]) {
    assert.match(membersBlock, new RegExp(`'${key}',`));
  }
});

test("community_search events branch [faithful]: mirrors events_read (202608280010) exactly - status <> draft, or created_by = caller, or community.event.manage", () => {
  const eventsBlock = mSearch.slice(mSearch.indexOf("into v_events"), mSearch.indexOf("into v_challenges"));
  assert.match(eventsBlock, /e\.title ilike v_pattern/);
  assert.match(
    eventsBlock,
    /e\.status <> 'draft'\s*\n\s*or e\.created_by = v_uid\s*\n\s*or public\.has_perm\('community\.event\.manage'\)/,
  );
});

test("community_search challenges branch [faithful]: mirrors challenges_read (202608280009) exactly - status <> draft, or created_by = caller, or community.challenge.create", () => {
  const challengesBlock = mSearch.slice(mSearch.indexOf("into v_challenges"), mSearch.indexOf("return jsonb_build_object('members', v_members"));
  assert.match(challengesBlock, /ch\.title ilike v_pattern/);
  assert.match(
    challengesBlock,
    /ch\.status <> 'draft'\s*\n\s*or ch\.created_by = v_uid\s*\n\s*or public\.has_perm\('community\.challenge\.create'\)/,
  );
});

test("community_search [faithful]: every branch's result set is capped by v_limit, derived from p_limit clamped between 1 and 50", () => {
  assert.match(mSearch, /v_limit := greatest\(1, least\(coalesce\(p_limit, 10\), 50\)\);/);
  const limitUses = [...mSearch.matchAll(/limit v_limit/g)];
  assert.strictEqual(limitUses.length, 3);
});
