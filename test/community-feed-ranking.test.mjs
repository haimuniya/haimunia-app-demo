// COMM-110 to COMM-115, the server half: public.feed_page() and
// public.club_summary().
//
// WHICH MIGRATION EACH HALF READS, AND WHY THEY DIFFER
// feed_page() has been re-created three times since 202608280019 and
// migrations apply in order, so the last `create or replace` is the one that
// ships. The chain is:
//   202608280019  the original: eight weights, all `constant`, with the
//                 class component declared and multiplied by a hard 0.
//   202608310002  COMM-301: the relationship arithmetic moves out into
//                 public.relationship_score(); feed_page calls it.
//   202608310003  COMM-302: v_class_connection (the hard 0) is DELETED and
//                 the class component is wired to real shared attendance
//                 through public.classmate_day_counts(). COMM-P01 closed.
//   202608310006  COMM-303, and what runs today: the eight weights stop
//                 being `constant` and are resolved per member by
//                 public.feed_weights_resolve() before scoring.
// So every feed_page assertion below reads 202608310006, and the two helper
// functions it delegates components to are read from the migrations that
// define them (neither has been re-created since).
//
// club_summary() was never redefined after 202608280019, so it is still read
// from there - as are the four supporting indexes, which no later migration
// re-creates either.
//
// WHAT THIS FILE VERIFIES
// The definitions. That the weights live in exactly one block and that the
// only thing allowed to move them is the documented per-member resolve step,
// that the engagement term is capped, that the class-connection component
// reads a gated attendance helper rather than being re-implemented here, that
// the visibility and mute anti-joins are in the candidate WHERE, that a
// show_workout_results opt-out nulls a field rather than dropping a post, and
// that the page boundary is a keyset and not an offset. Each of those is a
// static fact about the SQL, so a later edit that widens or drops one fails
// here.
//
// WHAT THIS FILE DOES NOT VERIFY
// That the ordering it produces is correct for real rows. That needs a real
// Postgres, and it lives in supabase/tests/0019_feed_ranking_test.sql plus
// 0038 (relationship_score), 0039 (classmate signal) and 0042 (personalized
// weights), run by the migration-check CI job. The same split
// test/community-rls-boundaries documents: a JS mock has no planner, no
// window functions and no plpgsql, so a test here that "proved" a ranking
// would be proving its own re-implementation.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const read = (name) => fs.readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");

// The live feed_page, plus member_feed_weights, feed_weights_resolve and
// recompute_feed_weights.
const live = read("202608310006_personalized_feed_weights.sql");
// Still live: club_summary and the four scoring indexes.
const base = read("202608280019_feed_ranking.sql");
// The two components feed_page delegates, each in the migration that owns it.
const relSql = read("202608310002_relationship_score.sql");
const classSql = read("202608310003_classmate_signal.sql");
// The index behind the attendance read the scoring pass now makes.
const attendanceSql = read("202608310001_attendance_log.sql");

const feedPage = live.slice(
  live.indexOf("create or replace function public.feed_page"),
  live.indexOf("revoke all on function public.feed_page"));
const declareBlock = feedPage.slice(feedPage.indexOf("declare"), feedPage.indexOf("\nbegin\n"));
const bodyBlock = feedPage.slice(feedPage.indexOf("\nbegin\n"));
const candidateWhere = feedPage.slice(feedPage.indexOf("from public.workout_posts p"), feedPage.indexOf("limit v_candidate_cap"));
// The one arithmetic expression every component lands in.
const scoreExpr = feedPage.slice(
  feedPage.indexOf("select c.pid, c.aid, c.kind, c.pub,"),
  feedPage.indexOf(", 6) as total"));
const perUser = bodyBlock.slice(bodyBlock.indexOf("--- per-user weights"), bodyBlock.indexOf("--- cursor"));

const resolveFn = live.slice(
  live.indexOf("create or replace function public.feed_weights_resolve"),
  live.indexOf("revoke all on function public.feed_weights_resolve"));
const relScore = relSql.slice(
  relSql.indexOf("create or replace function public.relationship_score"),
  relSql.indexOf("revoke all on function public.relationship_score"));
const classmateFn = classSql.slice(
  classSql.indexOf("create or replace function public.classmate_day_counts"),
  classSql.indexOf("revoke all on function public.classmate_day_counts"));
const clubSummary = base.slice(
  base.indexOf("create or replace function public.club_summary"),
  base.indexOf("revoke all on function public.club_summary"));

// --- shape and auth -------------------------------------------------------

test("feed_page takes an opaque cursor, a limit and a scope, defaulting to 20 and for_you", () => {
  assert.match(feedPage, /p_cursor text default null/);
  assert.match(feedPage, /p_limit integer default 20/);
  assert.match(feedPage, /p_scope text default 'for_you'/);
  assert.match(bodyBlock, /v_limit := least\(greatest\(coalesce\(p_limit, 20\), 1\), 40\)/,
    "COMM-110 and COMM-113: limit clamped to 1..40");
});

test("feed_page is a definer function with an empty search_path and refuses a null caller", () => {
  assert.match(feedPage, /security definer set search_path = ''/);
  assert.match(bodyBlock, /if v_uid is null then raise exception 'not authorized'; end if;/);
  assert.match(live, /revoke all on function public\.feed_page\(text, integer, text\) from public, anon;/);
  assert.match(live, /grant execute on function public\.feed_page\(text, integer, text\) to authenticated;/);
});

// --- one place for the weights -------------------------------------------

const WEIGHTS = [
  "v_w_recency", "v_w_relationship", "v_w_coach", "v_w_achievement",
  "v_w_challenge", "v_w_engagement", "v_w_personal", "v_w_class",
];

// COMM-303 keyed each weight for the resolver. The key is the weight's name
// with the v_w_ prefix dropped, and this pairing is what makes "the defaults
// object is built from the declared variables" checkable below.
const WEIGHT_KEYS = [
  ["recency", "v_w_recency"],
  ["relationship", "v_w_relationship"],
  ["coach", "v_w_coach"],
  ["achievement", "v_w_achievement"],
  ["challenge", "v_w_challenge"],
  ["engagement", "v_w_engagement"],
  ["personal", "v_w_personal"],
  ["class", "v_w_class"],
];

test("every scoring weight is declared exactly once, in the one documented block", () => {
  // Scoped to the function text rather than the whole migration: this file's
  // header discusses the weight block in prose, and prose is not an
  // assignment.
  for (const w of WEIGHTS) {
    const declared = declareBlock.match(new RegExp(`${w}\\s+numeric := \\d+;`, "g")) || [];
    assert.equal(declared.length, 1, `${w} is declared once`);

    // COMM-303 made the eight reassignable, so "one place to tune" is now
    // "one place a NUMBER is stated, plus the one documented resolve step".
    // Any third assignment is a second place to tune.
    const assigns = feedPage.match(new RegExp(`${w}\\s*(?:numeric\\s*)?:=[^;]*;`, "g")) || [];
    assert.equal(assigns.length, 2, `${w} is assigned in exactly two places`);
    assert.match(assigns[0], new RegExp(`^${w}\\s+numeric := \\d+;$`),
      `${w}'s first assignment is its default, a literal in the weight block`);
    assert.match(assigns[1],
      new RegExp(`^${w}\\s*:= coalesce\\(\\(v_weights ->> '[a-z]+'\\)::numeric,\\s*${w}\\);$`),
      `${w}'s only other assignment is the COMM-303 unpack, defaulting to itself`);
  }
});

test("the eight weights are no longer constant, because the resolve step replaces them", () => {
  for (const w of WEIGHTS) {
    assert.doesNotMatch(declareBlock, new RegExp(`${w}\\s+constant`),
      `${w} must be assignable for feed_weights_resolve to override it`);
  }
  // The shaping constants are a different thing and stay constant.
  assert.match(declareBlock, /v_recency_half_life_hours constant numeric := 36;/);
  assert.match(declareBlock, /v_class_saturation constant numeric := 8\.0;/);
});

test("each weight is used exactly once, multiplied into the one score expression", () => {
  for (const w of WEIGHTS) {
    const used = scoreExpr.match(new RegExp(`${w} \\* `, "g")) || [];
    assert.equal(used.length, 1, `${w} contributes exactly one term`);
  }
});

test("the weights block is documented inline, component by component", () => {
  // Each weight line carries its own trailing comment. A weight without one
  // is a number nobody can tune with confidence. v_w_class gained its own
  // comment in 202608310003 when the component stopped being a stub.
  for (const w of WEIGHTS) {
    assert.match(declareBlock, new RegExp(`${w}\\s+numeric := \\d+;\\s+-- \\S`),
      `${w} carries an inline comment`);
  }
});

test("the diversity limits are 2 same-author, 2 system, 3 workout, in the same block", () => {
  assert.match(declareBlock, /v_max_same_author\s+constant integer := 2;/);
  assert.match(declareBlock, /v_max_system_run\s+constant integer := 2;/);
  assert.match(declareBlock, /v_max_workout_run\s+constant integer := 3;/);
});

// --- COMM-303 per-member weights -----------------------------------------

test("the weights are resolved once per request, after auth and before anything is scored", () => {
  assert.ok(perUser.length > 0, "the per-user weights section exists");
  assert.match(perUser, /v_weights := coalesce\(public\.feed_weights_resolve\(v_uid, v_w_defaults\), v_w_defaults\);/);
  assert.match(perUser, /if jsonb_typeof\(v_weights\) <> 'object' then v_weights := v_w_defaults; end if;/);
  // One lookup per feed request: it sits after the parked-scope early return
  // and before the candidate query, so it cannot run per candidate row.
  assert.ok(bodyBlock.indexOf("--- per-user weights") > bodyBlock.indexOf("if v_scope = 'my_classes' then"),
    "resolved after the parked scope has already returned");
  assert.ok(bodyBlock.indexOf("--- per-user weights") < bodyBlock.indexOf("--- score, then cut the page"),
    "resolved before the scoring query runs");
});

test("the defaults handed to the resolver are the declared variables, not a second copy", () => {
  assert.match(perUser, /v_w_defaults := jsonb_build_object\(/);
  for (const [key, w] of WEIGHT_KEYS) {
    assert.match(perUser, new RegExp(`'${key}',\\s+${w}[,)]`),
      `the ${key} default is read from ${w} rather than restated`);
  }
  // A literal number in the packing would be the second place to tune.
  assert.doesNotMatch(perUser, /'(recency|relationship|coach|achievement|challenge|engagement|personal|class)',\s+\d/);
});

test("personalization redistributes emphasis and can never inflate the total", () => {
  assert.match(resolveFn, /v_lo  constant numeric := 0\.40;/);
  assert.match(resolveFn, /v_hi  constant numeric := 2\.50;/);
  // The sum invariant is checked against the defaults' own total, computed at
  // call time, so no second copy of "110" exists to drift.
  assert.match(resolveFn, /if abs\(v_sum - v_total\) > v_eps then\s*\n\s*return p_defaults;/,
    "a set that does not sum to the defaults' total is discarded");
  assert.match(resolveFn, /v_w\[v_i\] < v_d\[v_i\] \* v_lo - v_eps/);
  assert.match(resolveFn, /v_w\[v_i\] > v_d\[v_i\] \* v_hi \+ v_eps/);
  assert.doesNotMatch(resolveFn, /\b104\b|\b110\b/, "the total is never hardcoded");
});

test("a member with no stored weights gets the defaults object back, unexamined", () => {
  assert.match(resolveFn, /if v_stored is null\s*\n\s*or jsonb_typeof\(v_stored\) <> 'object'\s*\n\s*or v_stored = '\{\}'::jsonb then\s*\n\s*return p_defaults;/);
  assert.match(resolveFn, /if not v_moved or v_total <= 0 then\s*\n\s*return p_defaults;/,
    "an all-1.0 multiplier set takes the same path as no row at all");
});

test("a member's weights are never a parameter and never client-writable", () => {
  assert.match(live, /revoke all on public\.member_feed_weights from public, anon;/);
  assert.match(live, /grant select on public\.member_feed_weights to authenticated;/);
  assert.doesNotMatch(live, /grant\s+(insert|update|delete)[^\n]*member_feed_weights/i,
    "no client role may write a ranking input");
  assert.match(live, /create policy member_feed_weights_self_select on public\.member_feed_weights[\s\S]*?using \(user_id = auth\.uid\(\)\);/);
  assert.match(live, /revoke all on function public\.feed_weights_resolve\(uuid, jsonb\)\s*\n\s*from public, anon, authenticated;/,
    "the resolver is internal plumbing, not a second API surface");
});

test("the weight-derivation job is a named, service-role-only no-op stub", () => {
  assert.match(live, /create or replace function public\.recompute_feed_weights\(p_limit integer default 500\)/);
  assert.match(live, /revoke all on function public\.recompute_feed_weights\(integer\)\s*\n\s*from public, anon, authenticated;/);
  assert.match(live, /grant execute on function public\.recompute_feed_weights\(integer\) to service_role;/);
  assert.match(live, /TODO \(a later ticket, not COMM-303\): the derivation/,
    "the stub says what is missing and which ticket owns it");
});

// --- individual score components -----------------------------------------

test("recency decays exponentially against the frozen session anchor", () => {
  assert.match(scoreExpr, /v_w_recency \* power\(0\.5::numeric, c\.age_hours \/ v_recency_half_life_hours\)/);
  assert.match(feedPage, /extract\(epoch from \(v_anchor - p\.published_at\)\) \/ 3600\.0/);
});

test("the relationship component is one shared definition, called with the frozen anchor", () => {
  // COMM-301 moved the arithmetic out; feed_page keeps only the weight.
  assert.match(feedPage, /public\.relationship_score\(v_uid, a\.aid, v_anchor\) as rel_value/,
    "called with v_anchor, so the 30-day window is the same on page 2 as on page 1");
  assert.match(scoreExpr, /\+ v_w_relationship \* coalesce\(af\.rel_value, 0\)/);
  assert.doesNotMatch(feedPage, /v_rel_mutual|v_rel_follow|v_rel_interaction|v_rel_window_days/,
    "the component's constants are not a second copy inside feed_page");
});

test("relationship reads a mutual follow first, then a one-way follow, then recent interaction", () => {
  assert.match(relScore, /v_rel_mutual\s+constant numeric := 1\.0;/);
  assert.match(relScore, /v_rel_follow\s+constant numeric := 0\.55;/);
  assert.match(relScore, /v_rel_interaction\s+constant numeric := 0\.45;/);
  assert.match(relScore, /v_rel_window_days\s+constant integer := 30;/);
  // are_friends()'s own predicate, parameterised on the viewer because
  // are_friends() resolves its viewer from auth.uid() and could not answer
  // for an arbitrary p_viewer. Both directions, and the self-exclusion.
  assert.match(relScore, /and p_other <> p_viewer/);
  assert.match(relScore, /where f\.follower_id = p_viewer and f\.followed_id = p_other\)\s*and exists \(select 1 from public\.follows f\s*where f\.follower_id = p_other and f\.followed_id = p_viewer\)\s*then v_rel_mutual/);
  assert.match(relScore, /where f\.follower_id = p_viewer and f\.followed_id = p_other\) then v_rel_follow/);
  assert.match(relScore, /then v_rel_interaction else 0 end/);
  assert.match(relScore, /return least\(1\.0,\s*\n\s*\(case/,
    "the relationship component is capped at 1 before feed_page's weight applies");
  assert.match(relSql, /revoke all on function public\.relationship_score\(uuid, uuid, timestamptz\)\s*\n\s*from public, anon, authenticated;/);
});

test("the coach component reads the author's role rank, not a hardcoded name", () => {
  assert.match(feedPage, /public\.role_rank\(ir\.role\) >= 20/);
  assert.match(feedPage, /when c\.ptype in \('POST_COACH', 'POST_ANNOUNCEMENT'\) then v_coach_post/);
});

test("the achievement and challenge components are type-driven", () => {
  assert.match(scoreExpr, /'POST_PR', 'POST_ACHIEVEMENT', 'POST_ATTENDANCE_MILESTONE'\)\s*\n?\s*then 1 else 0 end/);
  assert.match(scoreExpr, /when c\.ptype in \('POST_CHALLENGE', 'POST_EVENT'\) then 1 else 0 end/);
});

test("engagement is capped and a comment outweighs a reaction", () => {
  assert.match(scoreExpr, /v_w_engagement \* least\(1\.0,\s*\n\s*\(cnt\.comments \* v_comment_weight \+ cnt\.reactions\) \/ v_engagement_saturation\)/);
  const commentWeight = Number((declareBlock.match(/v_comment_weight\s+constant numeric := ([\d.]+);/) || [])[1]);
  assert.ok(commentWeight > 1, "a comment is worth more than a reaction");
  assert.ok(/v_engagement_saturation\s+constant numeric := [\d.]+;/.test(declareBlock), "the saturation point is a named constant");
});

test("personal relevance covers mention, reply, thread and challenge or event participation", () => {
  assert.match(scoreExpr, /then v_pers_mention else 0 end/);
  assert.match(scoreExpr, /pc\.id = rc\.parent_comment_id[\s\S]*?then v_pers_reply else 0 end/);
  assert.match(scoreExpr, /then v_pers_thread else 0 end/);
  assert.match(scoreExpr, /public\.challenge_participants chp[\s\S]*?public\.event_attendees ea[\s\S]*?then v_pers_participant else 0 end/);
  assert.match(scoreExpr, /v_w_personal \* least\(1\.0,/, "capped at 1 before its weight applies");
});

test("the repetition penalty is per author, windowed, and capped", () => {
  assert.match(feedPage, /row_number\(\) over \(partition by c\.aid order by c\.pub desc\)/);
  assert.match(feedPage, /when c\.aid is null or c\.age_hours > v_repetition_window_hours then 0/,
    "an authorless system post is never penalised, and neither is an out-of-window post");
  assert.match(scoreExpr, /- least\(rep\.rep_index \* v_repetition_step, v_repetition_max\)/,
    "the penalty is subtracted and capped");
});

// --- COMM-P01, closed by COMM-302 ----------------------------------------
// This was "the class-connection component is present, always zero, and named
// to COMM-P01" while the module had no attendance source. 202608310003 gave
// it one, deleted the hard 0 and wired the component up, so the invariant to
// hold now is that the component is real, normalised the same way every other
// component is, and cannot outrank a block or leak a private toggle.

test("the class-connection component is wired to real attendance, not a hardcoded zero", () => {
  assert.doesNotMatch(feedPage, /v_class_connection/,
    "the COMM-P01 placeholder is gone, not merely unused");
  assert.match(feedPage, /COMM-302, closing COMM-P01/,
    "the migration says which ticket closed the parked one");
  assert.match(declareBlock, /v_class_saturation constant numeric := 8\.0;/,
    "the saturation point is a named constant in the same block");
  assert.match(scoreExpr, /\+ v_w_class \* least\(1\.0, coalesce\(af\.class_days, 0\) \/ v_class_saturation\)/,
    "a raw day count over a saturation constant, capped at 1 like every other component");
});

test("shared training days resolve once per author, through the gated helper", () => {
  assert.match(feedPage, /coalesce\(cd\.shared_days, 0\) as class_days/);
  assert.match(feedPage, /left join public\.classmate_day_counts\(v_anchor\) cd on cd\.user_id = a\.aid/,
    "measured from the same frozen anchor as every other window, and once per author");
  // The show_attendance gate is not applied here - feed_page's only privacy
  // call is COMM-018's, and the classmate gate lives inside the helper so it
  // cannot be applied differently by its two callers.
  const gates = [...new Set(feedPage.match(/can_view_profile_field\([^)]*\)/g) || [])];
  assert.deepEqual(gates, ["can_view_profile_field(p.author_id, 'show_workout_results')"]);
  assert.match(classmateFn, /where public\.can_view_profile_field\(ov\.uid, 'show_attendance'\)/,
    "one gate, applied after the aggregate, settling blocks and the toggle together");
  assert.match(classmateFn, /v_window_days constant integer := 60;/);
  assert.match(classmateFn, /where o\.user_id <> v_uid/, "a member is not their own classmate");
  assert.match(classSql, /revoke all on function public\.classmate_day_counts\(timestamptz\)\s*\n\s*from public, anon, authenticated;/);
});

// --- visibility, mutes and blocks ----------------------------------------

test("the candidate set anti-joins hidden_posts, reports and blocks", () => {
  assert.match(candidateWhere, /not exists \(\s*\n?\s*select 1 from public\.hidden_posts h where h\.user_id = v_uid and h\.post_id = p\.id\)/);
  assert.match(candidateWhere, /not exists \(\s*\n?\s*select 1 from public\.reports rp where rp\.post_id = p\.id and rp\.reporter_id = v_uid\)/);
  assert.match(candidateWhere, /b\.blocker_id = v_uid and b\.blocked_id = p\.author_id/);
  assert.match(candidateWhere, /b\.blocker_id = p\.author_id and b\.blocked_id = v_uid/);
});

test("visibility is resolved by post_visible_to_viewer, not re-implemented a third time", () => {
  assert.match(candidateWhere, /and public\.post_visible_to_viewer\(p\.id\)/);
  assert.doesNotMatch(candidateWhere, /p\.visibility in \('public', 'club'\)/,
    "the label rules are not copied into the feed");
  assert.match(candidateWhere, /p\.deleted_at is null/);
  assert.match(candidateWhere, /p\.status = 'active'/);
});

test("show_workout_results off nulls the result, it does not drop the post", () => {
  assert.doesNotMatch(candidateWhere, /can_view_profile_field/,
    "the privacy toggle is not a candidate filter");
  assert.match(bodyBlock, /not public\.can_view_profile_field\(p\.author_id, 'show_workout_results'\)\) as hide_result/);
  assert.match(bodyBlock, /case when priv\.hide_result then null else p\.result_text end/);
  assert.match(bodyBlock, /p\.metadata - 'result_text' - 'new_result' - 'previous_result' - 'improvement'/,
    "the same numbers are stripped out of metadata, not only out of result_text");
});

// --- COMM-111 scopes ------------------------------------------------------

test("the five scopes map to the post types the ticket names, unknown falls back", () => {
  assert.match(bodyBlock, /if v_scope not in \('for_you', 'following', 'achievements', 'coach', 'my_classes'\) then\s*\n\s*v_scope := 'for_you';/);
  assert.match(candidateWhere, /v_scope <> 'following' or exists \(\s*\n?\s*select 1 from public\.follows f/);
  assert.match(candidateWhere, /v_scope <> 'achievements' or p\.post_type in \(\s*\n?\s*'POST_PR', 'POST_ACHIEVEMENT', 'POST_ATTENDANCE_MILESTONE'\)/);
  assert.match(candidateWhere, /v_scope <> 'coach' or p\.post_type in \('POST_COACH', 'POST_ANNOUNCEMENT'\)/);
});

test("my_classes stays parked server-side and returns nothing, for a stated reason", () => {
  // Still parked after COMM-302, and no longer for want of any attendance
  // source: attendance_log records days, not classes, so it cannot answer
  // "which posts belong to a class I attend".
  assert.match(bodyBlock, /my_classes STAYS PARKED, deliberately/);
  assert.match(bodyBlock, /attendance_log records days, not classes[\s\S]{0,600}if v_scope = 'my_classes' then\s*\n\s*return;/);
});

// --- COMM-112 diversity ---------------------------------------------------

test("diversity runs after scoring, inside the function, over the selected page", () => {
  const diversity = bodyBlock.slice(bodyBlock.indexOf("--- diversity"), bodyBlock.indexOf("--- next cursor"));
  assert.match(diversity, /v_cand_author\[v_i\] = v_run_author\s*\n?\s*and v_run_author_n >= v_max_same_author/);
  assert.match(diversity, /v_cand_kind\[v_i\] = 'system' and v_run_system_n >= v_max_system_run/);
  assert.match(diversity, /v_cand_kind\[v_i\] = 'workout' and v_run_workout_n >= v_max_workout_run/);
  assert.match(diversity, /v_prefer := v_run_workout_n >= v_prefer_after_workouts/,
    "after a workout run the next slot prefers other content");
  assert.match(diversity, /v_cand_kind\[v_i\] = 'boost'/);
  // The relax pass: a page is never shortened to satisfy a limit.
  assert.match(diversity, /relax that limit rather than return a shorter page[\s\S]*?if not v_used\[v_i\] then v_pick := v_i; exit; end if;/);
  // COMM-303 changes which rows reach the page, never how they are laid out:
  // no weight appears anywhere in the diversity pass.
  for (const w of WEIGHTS) assert.doesNotMatch(diversity, new RegExp(w));
});

test("the boost class is achievement, coach, challenge and event content", () => {
  assert.match(feedPage, /'POST_ACHIEVEMENT', 'POST_PR', 'POST_ATTENDANCE_MILESTONE',\s*\n\s*'POST_COACH', 'POST_ANNOUNCEMENT', 'POST_CHALLENGE', 'POST_EVENT'\s*\n\s*\) then 'boost'/);
  assert.match(feedPage, /when p\.post_type in \('POST_SYSTEM', 'POST_NEW_MEMBER'\) then 'system'/);
  assert.match(feedPage, /when p\.post_type = 'POST_WORKOUT' then 'workout'/);
});

test("the diversity run state crosses the page boundary through the cursor", () => {
  assert.match(bodyBlock, /Seed the run counters from the tail of the previous page/);
  assert.match(bodyBlock, /'p', v_tail_out/, "the trailing run state travels in the token");
});

// --- COMM-113 cursor ------------------------------------------------------

test("the page boundary is a keyset on score, published_at and id, never an offset", () => {
  assert.match(bodyBlock, /\(sc\.total, sc\.pub, sc\.pid\) < \(v_cur_score, v_cur_pub, v_cur_id\)/);
  assert.doesNotMatch(feedPage, /\boffset\b/i);
});

test("the cursor freezes now() as a session anchor, which is what makes pages stable", () => {
  assert.match(bodyBlock, /v_anchor := \(v_token ->> 'a'\)::timestamptz/);
  assert.match(bodyBlock, /'a', v_anchor/);
  assert.match(candidateWhere, /p\.published_at <= v_anchor/,
    "a post created mid-session cannot enter a later page");
});

test("a malformed or partial cursor restarts from the top instead of raising", () => {
  assert.match(bodyBlock, /exception when others then\s*\n\s*v_anchor := null; v_cur_score := null; v_cur_pub := null; v_cur_id := null;/);
  assert.match(bodyBlock, /if v_cur_score is null or v_cur_pub is null or v_cur_id is null then\s*\n\s*v_cur_score := null; v_cur_pub := null; v_cur_id := null;/);
});

test("a short page carries no cursor, which is how the client knows it is the end", () => {
  assert.match(bodyBlock, /if v_n >= v_limit then\s*\n\s*v_last := v_page -> \(v_n - 1\);/);
});

test("the token is opaque on the wire and newline free", () => {
  assert.match(bodyBlock, /translate\(encode\(convert_to\(/);
  assert.match(bodyBlock, /'base64'\), E'\\n', ''\)/);
  assert.match(bodyBlock, /convert_from\(decode\(p_cursor, 'base64'\), 'utf8'\)::jsonb/);
});

// --- indexes and performance ---------------------------------------------

test("every per-author and per-post lookup the scoring pass makes has an index", () => {
  // 202608280019's four, none of which a later migration re-creates.
  assert.match(base, /create index if not exists workout_posts_author_recent_idx\s*\n\s*on public\.workout_posts\(author_id, published_at desc\) where deleted_at is null;/);
  assert.match(base, /create index if not exists follows_followed_idx\s*\n\s*on public\.follows\(followed_id, follower_id\);/);
  assert.match(base, /create index if not exists reactions_user_idx\s*\n\s*on public\.reactions\(user_id, post_id\);/);
  assert.match(base, /create index if not exists post_comments_author_recent_idx\s*\n\s*on public\.post_comments\(author_id, created_at desc\);/);
  // COMM-302 added a fifth per-author lookup, the attendance overlap, and
  // named the index that backs it rather than adding an unindexed scan.
  assert.match(classSql, /attendance_log_club_day_idx \(202608310001\) was created for this read\./);
  assert.match(attendanceSql, /create index attendance_log_club_day_idx on public\.attendance_log\(club_id, occurred_on desc\);/);
});

test("the scoring pass is bounded by a named window and a named candidate cap", () => {
  assert.match(declareBlock, /v_window_days\s+constant integer := \d+;/);
  assert.match(declareBlock, /v_candidate_cap\s+constant integer := \d+;/);
  assert.match(feedPage, /limit v_candidate_cap/);
  assert.match(feedPage, /order by p\.published_at desc\s*\n\s*limit v_candidate_cap/,
    "the cap is taken off the newest end, so it never hides fresh content");
});

test("relationship, class connection and author role resolve once per author, not once per row", () => {
  assert.match(feedPage, /authors as \(\s*\n\s*select distinct c\.aid as aid from cand c where c\.aid is not null\s*\n\s*\)/);
  assert.match(feedPage, /author_facts as \(/);
  assert.match(feedPage, /left join author_facts af on af\.aid = c\.aid/);
});

// --- COMM-115 club_summary ------------------------------------------------
// Never re-created after 202608280019, so this half still reads that file.

test("club_summary is definer, refuses a null caller, and is granted to authenticated only", () => {
  assert.match(clubSummary, /security definer set search_path = ''/);
  assert.match(clubSummary, /if v_uid is null then raise exception 'not authorized'; end if;/);
  assert.match(base, /revoke all on function public\.club_summary\(\) from public, anon;/);
  assert.match(base, /grant execute on function public\.club_summary\(\) to authenticated;/);
});

test("club_summary answers name, mark, member count, active challenge and unread count", () => {
  assert.match(clubSummary, /'name', coalesce\(v_club\.name, ''\)/);
  assert.match(clubSummary, /'image_url', v_club\.settings ->> 'image_url'/);
  assert.match(clubSummary, /'member_count', coalesce\(v_members, 0\)/);
  assert.match(clubSummary, /'active_challenge', v_challenge/);
  assert.match(clubSummary, /'unread_notifications', coalesce\(v_unread, 0\)/);
  assert.match(clubSummary, /TODO COMM-115: clubs has no image column/,
    "the stub says what is missing and what would replace it");
});

test("club_summary falls back to the weekly challenge while challenges is a Phase 2 table", () => {
  assert.match(clubSummary, /from public\.challenges c\s*\n\s*where c\.status = 'active'/);
  assert.match(clubSummary, /if v_challenge is null then[\s\S]*?from public\.weekly_challenges w/);
});

test("the unread count is scoped to the caller, never to the club", () => {
  assert.match(clubSummary, /from public\.notifications n where n\.user_id = v_uid and n\.read_at is null/);
});
