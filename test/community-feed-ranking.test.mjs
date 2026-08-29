// COMM-110 to COMM-115, the server half: public.feed_page() and
// public.club_summary() in migration 202608280019.
//
// WHAT THIS FILE VERIFIES
// The definitions. That the weights live in exactly one block, that the
// engagement term is capped, that the class-connection component is present
// and multiplied by zero with COMM-P01 named next to it, that the visibility
// and mute anti-joins are in the candidate WHERE, that a
// show_workout_results opt-out nulls a field rather than dropping a post,
// and that the page boundary is a keyset and not an offset. Each of those is
// a static fact about the SQL, so a later edit that widens or drops one
// fails here.
//
// WHAT THIS FILE DOES NOT VERIFY
// That the ordering it produces is correct for real rows. That needs a real
// Postgres, and it lives in supabase/tests/0019_feed_page_test.sql, run by
// the migration-check CI job. The same split test/community-rls-boundaries
// documents: a JS mock has no planner, no window functions and no plpgsql,
// so a test here that "proved" a ranking would be proving its own
// re-implementation.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const sql = fs.readFileSync(new URL("../supabase/migrations/202608280019_feed_ranking.sql", import.meta.url), "utf8");

const feedPage = sql.slice(
  sql.indexOf("create or replace function public.feed_page"),
  sql.indexOf("revoke all on function public.feed_page"));
const declareBlock = feedPage.slice(feedPage.indexOf("declare"), feedPage.indexOf("\nbegin\n"));
const bodyBlock = feedPage.slice(feedPage.indexOf("\nbegin\n"));
const candidateWhere = feedPage.slice(feedPage.indexOf("from public.workout_posts p"), feedPage.indexOf("limit v_candidate_cap"));
const clubSummary = sql.slice(
  sql.indexOf("create or replace function public.club_summary"),
  sql.indexOf("revoke all on function public.club_summary"));

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
  assert.match(sql, /revoke all on function public\.feed_page\(text, integer, text\) from public, anon;/);
  assert.match(sql, /grant execute on function public\.feed_page\(text, integer, text\) to authenticated;/);
});

// --- one place for the weights -------------------------------------------

const WEIGHTS = [
  "v_w_recency", "v_w_relationship", "v_w_coach", "v_w_achievement",
  "v_w_challenge", "v_w_engagement", "v_w_personal", "v_w_class",
];

test("every scoring weight is declared exactly once, in the one documented block", () => {
  for (const w of WEIGHTS) {
    const declared = declareBlock.match(new RegExp(`${w}\\s+constant numeric :=`, "g")) || [];
    assert.equal(declared.length, 1, `${w} is declared once`);
    const elsewhere = sql.split(`${w} `).length - 1;
    assert.ok(elsewhere >= 1, `${w} is used`);
    // No second assignment anywhere, which is what "one place to tune" means.
    // The one assignment is the `constant numeric :=` declaration itself.
    const assignments = sql.match(new RegExp(`${w}\\s*(?:constant numeric\\s*)?:=`, "g")) || [];
    assert.equal(assignments.length, 1, `${w} is assigned in exactly one place`);
  }
});

test("the weights block is documented inline, component by component", () => {
  // Each weight line carries its own trailing comment. A weight without one
  // is a number nobody can tune with confidence.
  for (const w of WEIGHTS) {
    if (w === "v_w_class") continue; // documented in the block above it
    assert.match(declareBlock, new RegExp(`${w}\\s+constant numeric := \\d+;\\s+-- \\S`),
      `${w} carries an inline comment`);
  }
});

test("the diversity limits are 2 same-author, 2 system, 3 workout, in the same block", () => {
  assert.match(declareBlock, /v_max_same_author\s+constant integer := 2;/);
  assert.match(declareBlock, /v_max_system_run\s+constant integer := 2;/);
  assert.match(declareBlock, /v_max_workout_run\s+constant integer := 3;/);
});

// --- individual score components -----------------------------------------

test("recency decays exponentially against the frozen session anchor", () => {
  assert.match(bodyBlock, /v_w_recency \* power\(0\.5::numeric, c\.age_hours \/ v_recency_half_life_hours\)/);
  assert.match(feedPage, /extract\(epoch from \(v_anchor - p\.published_at\)\) \/ 3600\.0/);
});

test("relationship reads are_friends first, then a one-way follow, then recent interaction", () => {
  assert.match(feedPage, /when public\.are_friends\(a\.aid\) then v_rel_mutual/);
  assert.match(feedPage, /follows f\s+where f\.follower_id = v_uid and f\.followed_id = a\.aid\) then v_rel_follow/);
  assert.match(feedPage, /then v_rel_interaction else 0 end/);
  assert.match(feedPage, /least\(1\.0,\s*\n\s*\(case\s*\n\s*when public\.are_friends/,
    "the relationship component is capped at 1 before its weight applies");
});

test("the coach component reads the author's role rank, not a hardcoded name", () => {
  assert.match(feedPage, /public\.role_rank\(ir\.role\) >= 20/);
  assert.match(feedPage, /when c\.ptype in \('POST_COACH', 'POST_ANNOUNCEMENT'\) then v_coach_post/);
});

test("the achievement and challenge components are type-driven", () => {
  assert.match(feedPage, /'POST_PR', 'POST_ACHIEVEMENT', 'POST_ATTENDANCE_MILESTONE'\)\s*\n?\s*then 1 else 0 end/);
  assert.match(feedPage, /when c\.ptype in \('POST_CHALLENGE', 'POST_EVENT'\) then 1 else 0 end/);
});

test("engagement is capped and a comment outweighs a reaction", () => {
  assert.match(feedPage, /v_w_engagement \* least\(1\.0,\s*\n\s*\(cnt\.comments \* v_comment_weight \+ cnt\.reactions\) \/ v_engagement_saturation\)/);
  const commentWeight = Number((declareBlock.match(/v_comment_weight\s+constant numeric := ([\d.]+);/) || [])[1]);
  assert.ok(commentWeight > 1, "a comment is worth more than a reaction");
  assert.ok(/v_engagement_saturation\s+constant numeric := [\d.]+;/.test(declareBlock), "the saturation point is a named constant");
});

test("personal relevance covers mention, reply, thread and challenge or event participation", () => {
  assert.match(feedPage, /then v_pers_mention else 0 end/);
  assert.match(feedPage, /pc\.id = rc\.parent_comment_id[\s\S]*?then v_pers_reply else 0 end/);
  assert.match(feedPage, /then v_pers_thread else 0 end/);
  assert.match(feedPage, /public\.challenge_participants chp[\s\S]*?public\.event_attendees ea[\s\S]*?then v_pers_participant else 0 end/);
  assert.match(feedPage, /v_w_personal \* least\(1\.0,/, "capped at 1 before its weight applies");
});

test("the repetition penalty is per author, windowed, and capped", () => {
  assert.match(feedPage, /row_number\(\) over \(partition by c\.aid order by c\.pub desc\)/);
  assert.match(feedPage, /when c\.aid is null or c\.age_hours > v_repetition_window_hours then 0/,
    "an authorless system post is never penalised, and neither is an out-of-window post");
  assert.match(feedPage, /- least\(rep\.rep_index \* v_repetition_step, v_repetition_max\)/,
    "the penalty is subtracted and capped");
});

test("the class-connection component is present, always zero, and named to COMM-P01", () => {
  assert.match(declareBlock, /v_class_connection constant numeric := 0;\s+-- always 0 until COMM-P01 lands/);
  assert.match(bodyBlock, /\+ v_w_class \* v_class_connection/,
    "it is in the sum, so wiring attendance is a value change and nothing else");
  assert.match(declareBlock, /COMM-P01/);
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

test("my_classes is parked server-side and returns nothing, tied to COMM-P01", () => {
  assert.match(bodyBlock, /COMM-P01\.[\s\S]{0,240}if v_scope = 'my_classes' then\s*\n\s*return;/);
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
  assert.match(sql, /create index if not exists workout_posts_author_recent_idx\s*\n\s*on public\.workout_posts\(author_id, published_at desc\) where deleted_at is null;/);
  assert.match(sql, /create index if not exists follows_followed_idx\s*\n\s*on public\.follows\(followed_id, follower_id\);/);
  assert.match(sql, /create index if not exists reactions_user_idx\s*\n\s*on public\.reactions\(user_id, post_id\);/);
  assert.match(sql, /create index if not exists post_comments_author_recent_idx\s*\n\s*on public\.post_comments\(author_id, created_at desc\);/);
});

test("the scoring pass is bounded by a named window and a named candidate cap", () => {
  assert.match(declareBlock, /v_window_days\s+constant integer := \d+;/);
  assert.match(declareBlock, /v_candidate_cap\s+constant integer := \d+;/);
  assert.match(feedPage, /limit v_candidate_cap/);
  assert.match(feedPage, /order by p\.published_at desc\s*\n\s*limit v_candidate_cap/,
    "the cap is taken off the newest end, so it never hides fresh content");
});

test("relationship and author role resolve once per author, not once per row", () => {
  assert.match(feedPage, /authors as \(\s*\n\s*select distinct c\.aid as aid from cand c where c\.aid is not null\s*\n\s*\)/);
  assert.match(feedPage, /author_facts as \(/);
  assert.match(feedPage, /left join author_facts af on af\.aid = c\.aid/);
});

// --- COMM-115 club_summary ------------------------------------------------

test("club_summary is definer, refuses a null caller, and is granted to authenticated only", () => {
  assert.match(clubSummary, /security definer set search_path = ''/);
  assert.match(clubSummary, /if v_uid is null then raise exception 'not authorized'; end if;/);
  assert.match(sql, /revoke all on function public\.club_summary\(\) from public, anon;/);
  assert.match(sql, /grant execute on function public\.club_summary\(\) to authenticated;/);
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
