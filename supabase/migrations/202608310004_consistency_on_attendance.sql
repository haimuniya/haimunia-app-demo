begin;

-- COMM-306, closing the parked COMM-P02. The consistency board and the
-- profile streak stop counting weeks a member POSTED and start counting
-- weeks a member TRAINED.
--
-- WHAT LANDS HERE
--   * public.consistency_week_streaks() re-created: same signature
--     (table(user_id uuid, streak integer)), same arithmetic, reading
--     public.attendance_log (202608310001) instead of public.workout_posts.
--   * public.feed_leaderboard(text, uuid, text, int) re-created: identical
--     apart from one predicate in the consistency branch -
--     can_view_profile_field(member, 'show_attendance').
--   * public.community_profile(uuid) re-created: its inline `current_streak`
--     copy moved onto the same source and behind the same toggle.
-- No new table, so no new RLS policy. Both tables read here already have
-- their own.
--
-- THE PLACEHOLDER THIS CLOSES, VERBATIM. 202608290015's own header on
-- consistency_week_streaks():
--   "When COMM-306 (Phase 3) swaps consistency onto verified attendance,
--    this function body is the single place that changes and
--    feed_leaderboard's contract does not move at all."
-- That is what the first of the three re-creations below is. The other two
-- exist for reasons that migration also named: community_profile keeps an
-- inline second copy of the same streak (merged migrations are never
-- edited, so it has to be re-created to follow), and the privacy toggle
-- attendance carries has to be applied by the reader, which is
-- feed_leaderboard.
--
-- WHAT DOES NOT MOVE
-- feed_leaderboard's signature, its p_mode='consistency' contract, its
-- tie-break, its rank-is-a-position rule, its always-return-self rule and
-- its zero-is-real rule are all unchanged, as is progress mode in every
-- respect. community_profile's `training_frequency` and `recent_workouts`
-- are untouched and still read workout_posts directly: those two answer
-- "what did this member choose to share", which is a different question
-- from "did they train", and COMM-306 says so explicitly. Only the streak
-- changes source.

-- =====================================================================
-- 1. consistency_week_streaks(), re-created on attendance_log
-- =====================================================================
-- Same shape as 202608290015, one table swapped:
--
--   distinct ISO weeks that carry at least one attendance day, anchored on
--   the member's most recent such week, counted backwards while each week is
--   exactly 7 days before the previous one, and only when the anchor is the
--   current week or the previous one. A week not yet trained does not break
--   the streak, which is why the anchor may be either.
--
-- attendance_log is already one row per member per calendar day (a unique
-- constraint, not a convention), so the group-by collapses days to weeks and
-- nothing else. There is no deleted_at, no status and no post_type to filter
-- here: the table is append-only and every row in it IS a training day, which
-- is the whole reason COMM-300 built it as a derived table rather than as a
-- view over private_records.
--
-- NO PRIVACY FILTER IN THIS FUNCTION, deliberately, and it is the one place
-- this ticket departs from the shape classmate_day_counts() (202608310003)
-- uses for the same toggle. That helper folds show_attendance into itself
-- because both of its callers want the same answer: absent. Here the two
-- callers want different things - feed_leaderboard must EXCLUDE an opted-out
-- member from the ranked set, not rank them at 0, and a gate inside this
-- function would produce exactly the 0 the ticket rules out (an absent row
-- left-joins to coalesce(s.streak, 0)). So the gate lives in the caller,
-- where "excluded" can be expressed, and this stays pure arithmetic over a
-- table nobody can reach anyway.
--
-- SECURITY INVOKER with no grant to anyone, unchanged: it is internal
-- plumbing, not an API. Called from feed_leaderboard (definer, owned by the
-- migration owner) it runs with that owner's rights, which is how it sees
-- every member's attendance days past attendance_log_self_select; called
-- from anywhere else it cannot be called at all.
create or replace function public.consistency_week_streaks()
returns table (user_id uuid, streak integer)
language sql stable security invoker set search_path = '' as $$
  with weeks as (
    select a.user_id as uid,
           date_trunc('week', a.occurred_on::timestamp)::date as wk
    from public.attendance_log a
    group by 1, 2
  ),
  anchored as (
    select w.uid, w.wk,
           row_number() over (partition by w.uid order by w.wk desc) as rn,
           max(w.wk) over (partition by w.uid) as anchor
    from weeks w
  )
  -- Once a week is missing every later row falls behind the expected date
  -- and stays behind, so this counts the contiguous run from the anchor and
  -- nothing after it - the same reason community_profile's copy gives.
  select a.uid, count(*)::integer
  from anchored a
  where a.anchor >= date_trunc('week', current_date::timestamp)::date - 7
    and a.wk = a.anchor - ((a.rn - 1) * 7)::integer
  group by a.uid;
$$;

revoke all on function public.consistency_week_streaks() from public, anon, authenticated;

comment on function public.consistency_week_streaks() is
  'Internal. Current consecutive-ISO-week training streak for every member, counted over public.attendance_log occurred_on days (COMM-300); the set-based form of community_profile''s current_streak. A member with no attendance days is absent, which every caller reads as 0. Carries no privacy filter on purpose - feed_leaderboard applies can_view_profile_field(member, ''show_attendance'') itself, because it has to exclude an opted-out member rather than rank them at 0. No grants: only feed_leaderboard calls it. COMM-306.';

-- =====================================================================
-- 2. feed_leaderboard, re-created. COMM-210 / 211 / 212, gated by COMM-306
-- =====================================================================
-- Identical to 202608290015 apart from one predicate in the consistency
-- branch of `valued`. Everything else in this function - the mode and scope
-- validation, the limit clamp, the challenge checks, the candidate set, the
-- ranking, the tie-break, the self-row append - is the same text.
--
-- THE ONE CHANGE: can_view_profile_field(member, 'show_attendance').
-- Consistency now ranks verified attendance, and attendance carries its own
-- privacy toggle (202608280003), separate from visible_to_club and separate
-- from in_leaderboards. 202608310001 states the rule this implements: the
-- table's staff select policy is deliberately NOT gated on that toggle, and
-- every member-facing reader is required to apply it in its own body. This is
-- COMM-306's half of that.
--
-- EXCLUDED, NOT ZEROED. A member with show_attendance off does not appear on
-- the consistency board at all - no row, not a row worth 0 - which is exactly
-- how a visible_to_club-off member already behaves. The distinction matters
-- because this board's zero IS a real value (see below): a 0 means "ranked,
-- and has not trained recently", so publishing a 0 for a member who opted out
-- would be publishing a false statement about them rather than withholding a
-- true one.
--
-- THE CALLER IS STILL ALWAYS IN THEIR OWN BOARD. can_view_profile_field
-- returns true for p_target = auth.uid() before it consults any toggle, so
-- the new predicate is automatically self-exempt, the same way the two
-- existing ones are - a caller who has never opted in still sees their own
-- streak and their own rank. That is the existing rule, not a new exception:
-- their own attendance rows always count for them (202608310003 says the
-- same thing about achievements and this board by name).
--
-- PROGRESS MODE IS UNTOUCHED. The predicate is inside the consistency branch,
-- not in `cand`, because a challenge ranking has nothing to do with
-- attendance and gating it would silently narrow COMM-211's board on a
-- toggle that has no bearing on it.
--
-- ZERO IS STILL A REAL VALUE, NOT AN ABSENCE. Every eligible member is
-- ranked, including one with a 0-week streak, because that is what makes the
-- caller's "real rank" real - there is no rank to report from a set the
-- caller was filtered out of. A member with no attendance_log rows at all
-- reads 0 rather than raising: consistency_week_streaks() simply has no row
-- for them and the left join coalesces. COMM-210's "not enough data yet"
-- empty state is therefore "no rows, or every returned value is 0", not "no
-- rows", exactly as before.
--
-- Blocks are still not re-implemented: can_view_profile_field checks a block
-- edge in either direction BEFORE it consults is_admin() or any toggle, so
-- the three calls answer "blocked" once between them. The known is_admin()
-- short-circuit applies to the new call as it does to the other two: a real
-- admin's board includes members who opted out of attendance visibility, the
-- module-wide behaviour of the resolution point rather than a leaderboard
-- decision.
--
-- Ranking and ties, COMM-210: order by value descending, then by longer club
-- tenure (invite_redemptions.redeemed_at, falling back to profiles.created_at
-- the same way community_profile's member_since does), then alphabetically by
-- display_name, then by id so the order is total. Because ties are fully
-- broken, `rank` is a position: it is 1, 2, 3 with no repeats and no gaps.
--
-- Club scope is club-wide with no club_id filter, matching every other read
-- function in the module.
create or replace function public.feed_leaderboard(
  p_mode text,
  p_challenge_id uuid default null,
  p_scope text default 'club',
  p_limit int default 50
) returns setof public.leaderboard_row
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_mode text;
  v_scope text;
  v_limit int;
  v_challenge public.challenges;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  -- Same read gate chal_progress uses: a real seat in the club, not the
  -- recovery-verification write gate. Reads are not gated behind
  -- is_community_member() anywhere in this module.
  if public.my_role_code() is null then raise exception 'not authorized'; end if;

  v_mode := lower(btrim(coalesce(p_mode, '')));
  v_scope := lower(btrim(coalesce(p_scope, 'club')));
  if v_scope = '' then v_scope := 'club'; end if;

  if v_mode not in ('consistency', 'progress') then
    raise exception 'unknown leaderboard mode %', p_mode;
  end if;
  if v_scope not in ('club', 'friends') then
    raise exception 'unknown leaderboard scope %', p_scope;
  end if;

  -- COMM-211: a missing challenge id raises rather than quietly degrading
  -- into a club-wide ranking of something else.
  if v_mode = 'progress' then
    if p_challenge_id is null then
      raise exception 'challenge required';
    end if;
    select * into v_challenge from public.challenges c where c.id = p_challenge_id;
    if not found then raise exception 'challenge not found'; end if;
    -- Same visibility chal_progress and challenges_read enforce, so the
    -- leaderboard cannot be used as an existence oracle for a draft.
    if v_challenge.status = 'draft'
       and v_challenge.created_by is distinct from v_uid
       and not public.has_perm('community.challenge.create') then
      raise exception 'challenge not found';
    end if;
  end if;

  -- COMM-210 asks for 50, COMM-211's panel for 20, contracts.md caps at 100.
  v_limit := greatest(1, least(coalesce(p_limit, 50), 100));

  return query
  with cand as (
    select p.id as uid,
           p.display_name,
           p.handle,
           p.avatar_url,
           coalesce(ir.redeemed_at, p.created_at) as joined_at
    from public.profiles p
    left join public.invite_redemptions ir on ir.user_id = p.id
    where p.deleted_at is null
      -- COMM-212: friends is a mutual follow edge and nothing else, and the
      -- caller is always in their own board regardless of scope.
      and (v_scope = 'club' or p.id = v_uid or public.are_friends(p.id))
      and public.can_view_profile_field(p.id, 'visible_to_club')
      and public.can_view_profile_field(p.id, 'in_leaderboards')
  ),
  valued as (
    -- Exactly one of these two branches runs: the mode is a one-time filter,
    -- so the other subplan is never executed.
    select c.uid, c.display_name, c.handle, c.avatar_url, c.joined_at,
           coalesce(s.streak, 0)::numeric as value
    from cand c
    left join public.consistency_week_streaks() s on s.user_id = c.uid
    where v_mode = 'consistency'
      -- COMM-306. The third toggle, and only in this mode: the value being
      -- ranked is now verified attendance, which has its own privacy
      -- setting. Self-exempt for free, because the helper answers true for
      -- the caller before it reads any toggle.
      and public.can_view_profile_field(c.uid, 'show_attendance')
    union all
    -- Progress ranks the challenge's participants, so a member who never
    -- joined has no row - including the caller. That is the one case where
    -- "the caller's row always comes back" cannot apply, and it is the
    -- honest answer: there is no standing in a challenge you did not enter.
    select c.uid, c.display_name, c.handle, c.avatar_url, c.joined_at,
           cp.progress_value
    from cand c
    join public.challenge_participants cp
      on cp.user_id = c.uid
     and cp.challenge_id = p_challenge_id
     and cp.status <> 'withdrawn'
    where v_mode = 'progress'
  ),
  ranked as (
    select v.uid, v.display_name, v.handle, v.avatar_url,
           (row_number() over (
              order by v.value desc,
                       v.joined_at asc,
                       coalesce(nullif(btrim(v.display_name), ''), v.handle) asc,
                       v.uid asc
            ))::integer as rank_pos,
           v.value,
           (v.uid = v_uid) as is_self
    from valued v
  )
  -- Top of the board in rank order, then the caller's own row appended last
  -- when it fell outside the limit, so "where do I stand" is never a second
  -- round trip. COMM-212's "hide my result" is a client render choice on top
  -- of this row, not a parameter: the server always sends it.
  select r.uid, r.display_name, r.handle, r.avatar_url, r.rank_pos, r.value, r.is_self
  from ranked r
  where r.rank_pos <= v_limit or r.is_self
  order by (case when r.rank_pos <= v_limit then 0 else 1 end), r.rank_pos;
end $$;

revoke all on function public.feed_leaderboard(text, uuid, text, int) from public, anon;
grant execute on function public.feed_leaderboard(text, uuid, text, int) to authenticated;

comment on function public.feed_leaderboard(text, uuid, text, int) is
  'COMM-210/211/212 leaderboard, consistency moved onto verified attendance by COMM-306. p_mode consistency (club-wide ISO-week streak of attendance_log training days, p_challenge_id ignored) or progress (challenge_participants.progress_value, p_challenge_id required or it raises). p_scope club or friends (are_friends mutual follows, caller always included). Every ranked member passes can_view_profile_field for in_leaderboards and visible_to_club, and in consistency mode for show_attendance as well - an opted-out member is absent from the ranked set, not ranked at 0. All three also settle block edges in both directions. rank is a position with ties broken by tenure then display name. A member with no attendance days is ranked at 0, which is a real value. The caller''s own row is always returned, appended last with its real rank when outside p_limit (clamped 1..100).';

-- =====================================================================
-- 3. community_profile, re-created. COMM-180, streak moved by COMM-306
-- =====================================================================
-- Identical to 202608280022 apart from the `current_streak` block, which is
-- the inline second copy of the streak 202608290015 documented and
-- 0034_feed_leaderboard_and_suggestions_test.sql pins against
-- consistency_week_streaks(). Two things move inside that block and nothing
-- else in the function does:
--
--   1. THE SOURCE. Distinct ISO weeks now come from attendance_log
--      occurred_on days instead of POST_WORKOUT / POST_PR posts, with the
--      identical anchor-and-count-back arithmetic, so the drift assertion
--      still compares two computations of the same rule rather than two
--      different rules that happen to agree.
--
--   2. THE TOGGLE. The key is now additionally gated on
--      can_view_profile_field(v_target, 'show_attendance'), nested inside the
--      existing show_workout_results block. This is the one place the built
--      thing goes past COMM-306's own migration outline, which named the
--      toggle only for the leaderboard, and it is not a scope decision taken
--      lightly: without it this function would publish an attendance-derived
--      number past the toggle that governs attendance, for every member, by
--      default (show_attendance defaults false and show_workout_results
--      defaults false, so the pairing only ever narrows). 202608310001 wrote
--      the rule down - "every member-facing Phase 3 reader (COMM-302,
--      COMM-306, COMM-307) is required to apply it in its own body" - and a
--      profile overlay is a member-facing reader. It also keeps this function
--      and feed_leaderboard telling one story about the same member: with the
--      gate, a member with attendance private is absent from the board AND
--      has no streak on their profile; without it, absent from one and
--      published on the other.
--
--      Expressed the way this function already expresses hiding: the key is
--      simply absent, which the contract has meant "hidden" since COMM-180
--      and which the client already renders as "no row" rather than a blank
--      (`if (d.current_streak != null)`). Reverting it is deleting one `if`.
--
-- EXPLICITLY UNCHANGED: `training_frequency` and `recent_workouts` still read
-- public.workout_posts directly, still under show_workout_results alone, with
-- the same 28-day window, the same rounding, the same 5-row limit and the
-- same post_visible_to_viewer() call. They answer what a member chose to
-- share, not whether they trained, and COMM-306 rules them out by name. So do
-- `prs`, `achievements` and `posts`, none of which this ticket touches.
--
-- Everything else below - the block check, the header fields, the
-- visible_to_club early return, the counts, active_challenge, the PR and
-- achievement blocks, the posts block, the SECURITY DEFINER reasoning - is
-- 202608280022's text verbatim.
create or replace function public.community_profile(user_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_target uuid;
  v_p public.profiles;
  v_out jsonb;
  v_role text;
  v_since timestamptz;
  v_hide_result boolean;
  v_days integer;
  v_freq numeric;
  v_anchor date;
  v_streak integer;
  v_json jsonb;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  v_target := coalesce(user_id, v_uid);

  -- A block edge in either direction ends the question before any row is
  -- read. can_view_profile_field() would return false for every field
  -- anyway, but returning the bare header to a blocked member is still a
  -- confirmation they should not get.
  if v_target <> v_uid and exists (
    select 1 from public.blocks b
    where (b.blocker_id = v_uid and b.blocked_id = v_target)
       or (b.blocker_id = v_target and b.blocked_id = v_uid)
  ) then
    raise exception 'not authorized';
  end if;

  select * into v_p from public.profiles p where p.id = v_target and p.deleted_at is null;
  if not found then raise exception 'profile not found'; end if;

  -- Role and tenure both come from the first invite redemption, which is
  -- the only server-side record of when a member joined the club and what
  -- they joined as. profiles.created_at is the fallback for a row that
  -- predates the invite gate.
  select ir.role, ir.redeemed_at into v_role, v_since
  from public.invite_redemptions ir
  where ir.user_id = v_target
  order by ir.redeemed_at asc
  limit 1;

  -- The three fields a fully private member still returns, plus handle,
  -- which the client needs to render a name at all when display_name is
  -- empty. profiles has no first_name or last_name column, so those two
  -- documented keys are simply absent and the client falls back to
  -- display_name, then handle.
  v_out := jsonb_build_object(
    'id', v_p.id,
    'display_name', nullif(v_p.display_name, ''),
    'handle', v_p.handle,
    'avatar_url', v_p.avatar_url,
    'role', coalesce(v_role, 'member'),
    'member_since', coalesce(v_since, v_p.created_at),
    -- False on your own profile, so the overlay does not offer you a
    -- Follow button pointed at yourself.
    'allow_follows', (v_target <> v_uid and public.can_view_profile_field(v_target, 'allow_follows'))
  );

  if not public.can_view_profile_field(v_target, 'visible_to_club') then
    return v_out;
  end if;

  v_out := v_out || jsonb_build_object(
    'follower_count', (select count(*)::integer from public.follows f where f.followed_id = v_target),
    'following_count', (select count(*)::integer from public.follows f where f.follower_id = v_target)
  );

  select jsonb_build_object('id', c.id, 'title', c.title, 'ends_at', c.end_at)
    into v_json
  from public.challenge_participants cp
  join public.challenges c on c.id = cp.challenge_id
  where cp.user_id = v_target
    and cp.status = 'active'
    and c.status = 'active'
    and now() >= c.start_at and now() <= c.end_at
  order by c.end_at asc
  limit 1;
  if v_json is not null then
    v_out := v_out || jsonb_build_object('active_challenge', v_json);
  end if;

  -- --- training numbers, COMM-018 --------------------------------------
  -- training_frequency and recent_workouts are still derived from posts the
  -- member chose to publish. A member who trains and never posts reads as
  -- zero in those two, and that is the honest answer for the question they
  -- ask. current_streak below no longer asks that question.
  if public.can_view_profile_field(v_target, 'show_workout_results') then
    select count(distinct coalesce(p.occurred_on, p.created_at::date))::integer
      into v_days
    from public.workout_posts p
    where p.author_id = v_target
      and p.deleted_at is null and p.status = 'active'
      and p.post_type in ('POST_WORKOUT', 'POST_PR')
      and coalesce(p.occurred_on, p.created_at::date) >= current_date - 27;

    if coalesce(v_days, 0) > 0 then
      v_freq := round(v_days / 4.0, 1);
      v_out := v_out || jsonb_build_object('training_frequency',
        case when v_freq = trunc(v_freq) then trunc(v_freq)::integer::text
             else to_char(v_freq, 'FM990.9') end || ' בשבוע');
    end if;

    -- Week streak, COMM-306: verified attendance days (attendance_log,
    -- COMM-300), counted the same way consistency_week_streaks() counts them
    -- set-wide - a week counts when the member trained in it at all, so a
    -- three times a week pattern scores exactly like a daily one. The streak
    -- may end on the current week or the previous one: a member who has not
    -- trained yet this week has not lost their streak.
    --
    -- Gated on show_attendance as well as show_workout_results, so an
    -- attendance-derived number never travels past attendance's own toggle.
    -- Absent key means hidden, the same as every other field here. A member
    -- with no attendance days at all is 0, not an error and not an absence:
    -- zero is a real value here for the same reason it is on the board.
    if public.can_view_profile_field(v_target, 'show_attendance') then
      select max(w.wk) into v_anchor
      from (
        select distinct date_trunc('week', a.occurred_on::timestamp)::date as wk
        from public.attendance_log a
        where a.user_id = v_target
      ) w;

      v_streak := 0;
      if v_anchor is not null and v_anchor >= date_trunc('week', current_date::timestamp)::date - 7 then
        -- Once a week is missing, every later row falls behind the expected
        -- date and stays behind, so this counts the contiguous run and
        -- nothing after it.
        select count(*)::integer into v_streak
        from (
          select w.wk, row_number() over (order by w.wk desc) as rn
          from (
            select distinct date_trunc('week', a.occurred_on::timestamp)::date as wk
            from public.attendance_log a
            where a.user_id = v_target
          ) w
        ) s
        where s.wk = v_anchor - ((s.rn - 1) * 7)::integer;
      end if;
      v_out := v_out || jsonb_build_object('current_streak', coalesce(v_streak, 0));
    end if;

    select coalesce(jsonb_agg(jsonb_build_object('title', r.title, 'date', r.d) order by r.d desc), '[]'::jsonb)
      into v_json
    from (
      select coalesce(nullif(p.title, ''), left(coalesce(p.body, ''), 80)) as title,
             coalesce(p.occurred_on, p.created_at::date) as d
      from public.workout_posts p
      where p.author_id = v_target
        and p.deleted_at is null and p.status = 'active'
        and p.post_type = 'POST_WORKOUT'
        and public.post_visible_to_viewer(p.id)
      order by coalesce(p.occurred_on, p.created_at::date) desc
      limit 5
    ) r;
    v_out := v_out || jsonb_build_object('recent_workouts', v_json);
  end if;

  -- --- PRs, gated by show_prs ------------------------------------------
  -- Absent key hides the Progress tab, empty array shows the no-PRs state.
  if public.can_view_profile_field(v_target, 'show_prs') then
    select coalesce(jsonb_agg(jsonb_build_object(
             'movement', r.movement, 'result', r.result, 'achieved_on', r.d) order by r.d desc), '[]'::jsonb)
      into v_json
    from (
      select coalesce(p.metadata ->> 'movement', nullif(p.title, ''), '') as movement,
             coalesce(p.metadata ->> 'new_result', nullif(p.result_text, ''), '') as result,
             coalesce(p.occurred_on, p.created_at::date) as d
      from public.workout_posts p
      where p.author_id = v_target
        and p.deleted_at is null and p.status = 'active'
        and p.post_type = 'POST_PR'
        and public.post_visible_to_viewer(p.id)
      order by coalesce(p.occurred_on, p.created_at::date) desc
      limit 20
    ) r;
    v_out := v_out || jsonb_build_object('prs', v_json);
  end if;

  -- --- achievements, gated by show_achievements ------------------------
  -- The per-unlock visibility column is applied on top of the toggle, the
  -- same three-way rule member_achievements_read spells out, so an
  -- only_me unlock never appears on someone else's screen.
  if public.can_view_profile_field(v_target, 'show_achievements') then
    select coalesce(jsonb_agg(jsonb_build_object(
             'title', r.title, 'badge_icon', r.icon, 'code', r.code,
             'unlocked_at', r.unlocked_at) order by r.unlocked_at desc), '[]'::jsonb)
      into v_json
    from (
      select d.name as title, d.icon as icon, d.code as code, ma.unlocked_at as unlocked_at
      from public.member_achievements ma
      join public.achievement_definitions d on d.id = ma.achievement_id
      where ma.user_id = v_target
        and (
          v_target = v_uid
          or ma.visibility = 'club'
          or (ma.visibility = 'friends' and public.are_friends(v_target))
        )
      order by ma.unlocked_at desc
      limit 24
    ) r;
    v_out := v_out || jsonb_build_object('achievements', v_json);
    if jsonb_array_length(v_json) > 0 then
      v_out := v_out || jsonb_build_object('recent_achievement', jsonb_build_object(
        'title', v_json -> 0 ->> 'title', 'badge_icon', v_json -> 0 ->> 'badge_icon'));
    end if;
  end if;

  -- --- posts -----------------------------------------------------------
  -- Card contract rows, the same shape feed_page returns, so
  -- renderPostCard() renders the Posts tab with no special case. Each row
  -- still passes post_visible_to_viewer(), so an only_me or friends post
  -- never reaches a viewer the author did not choose, profile tab or not.
  v_hide_result := not public.can_view_profile_field(v_target, 'show_workout_results');

  select coalesce(jsonb_agg(r.j order by r.ts desc), '[]'::jsonb) into v_json
  from (
    select jsonb_build_object(
             'id', p.id,
             'post_type', p.post_type::text,
             'author_id', p.author_id,
             'author', jsonb_build_object(
               'display_name', v_p.display_name, 'handle', v_p.handle, 'avatar_url', v_p.avatar_url),
             'display_name', v_p.display_name,
             'handle', v_p.handle,
             'body', p.body,
             'title', p.title,
             'result_text', case when v_hide_result and p.post_type in ('POST_WORKOUT', 'POST_PR')
                                 then null else p.result_text end,
             'occurred_on', p.occurred_on,
             'visibility', p.visibility::text,
             'created_at', p.created_at,
             'published_at', p.published_at,
             'metadata', case when v_hide_result and p.post_type in ('POST_WORKOUT', 'POST_PR')
                              then p.metadata - 'result_text' - 'new_result' - 'previous_result' - 'improvement'
                              else p.metadata end,
             'media', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'storage_path', m.storage_path,
                        'alt_text', m.alt_text,
                        'decorative', m.decorative,
                        'position', m."position",
                        'width', m.width,
                        'height', m.height) order by m."position")
               from public.post_media m where m.post_id = p.id),
               case when p.photo_path is not null
                    then jsonb_build_array(jsonb_build_object('storage_path', p.photo_path, 'position', 0))
                    else '[]'::jsonb end),
             'reaction_count', (select count(*)::integer from public.reactions rr where rr.post_id = p.id),
             'comment_count', (select count(*)::integer from public.post_comments pc
                               where pc.post_id = p.id and pc.deleted_at is null and pc.status = 'active')
           ) as j,
           coalesce(p.created_at, p.published_at) as ts
    from public.workout_posts p
    where p.author_id = v_target
      and p.deleted_at is null and p.status = 'active'
      and public.post_visible_to_viewer(p.id)
    order by coalesce(p.created_at, p.published_at) desc
    limit 10
  ) r;
  v_out := v_out || jsonb_build_object('posts', v_json);

  return v_out;
end $$;

revoke all on function public.community_profile(uuid) from public, anon;
grant execute on function public.community_profile(uuid) to authenticated;

comment on function public.community_profile(uuid) is
  'COMM-180 profile community section in one call, every field filtered by can_view_profile_field against the caller; an absent key means hidden. COMM-306 moved current_streak onto verified attendance days (attendance_log, COMM-300), counted as consecutive ISO weeks exactly as consistency_week_streaks() counts them set-wide, and gated it on show_attendance in addition to show_workout_results so an attendance-derived number never travels past attendance''s own toggle. training_frequency and recent_workouts still read workout_posts under show_workout_results alone - they answer what a member chose to share, which is a different question.';

commit;
