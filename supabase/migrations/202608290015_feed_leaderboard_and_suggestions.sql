begin;

-- Community Phase 2, feed cluster: the two read functions COMM-210, COMM-211,
-- COMM-212 and COMM-232 are still waiting on, listed under "Needs from
-- schema, feed (Phase 2)" in docs/community/contracts.md.
--
--   public.leaderboard_row          composite type, the row shape the client
--                                   already has documented
--   public.consistency_week_streaks() internal set-based streak source
--   public.feed_leaderboard()       COMM-210 / 211 / 212
--   public.people_suggestions()     COMM-232
--
-- No new table, so no new RLS policy: everything here reads tables that
-- already have their own policies, and both entry points are SECURITY
-- DEFINER for one narrow reason each, spelled out at each function.

-- =====================================================================
-- 1. leaderboard_row
-- =====================================================================
-- The exact shape contracts.md has been promising since Phase 1 planning.
-- A composite type rather than a jsonb blob because a leaderboard is a
-- table: every row has every column, and the client renders columns, not
-- optional keys. (community_profile is jsonb for the opposite reason - an
-- absent key there means "hidden", which is a real state there and has no
-- meaning here.)
--
-- chal_progress (202608290003) builds its own simpler {user_id, name,
-- handle, avatar_url, value} objects inside challenge_progress_view.
-- Deliberately left alone: that function's leaderboard key is already
-- shipped and read by COMM-207, and widening it is a separate, additive
-- follow-up. Nothing here changes it.
create type public.leaderboard_row as (
  user_id uuid,
  display_name text,
  handle text,
  avatar_url text,
  rank integer,
  value numeric,
  is_self boolean
);

-- =====================================================================
-- 2. consistency_week_streaks() - the one set-based copy of the streak
-- =====================================================================
-- community_profile (202608280022) computes `current_streak` for ONE member
-- inline: distinct ISO weeks that carry a POST_WORKOUT or POST_PR, anchored
-- on the member's most recent such week, counted backwards while each week
-- is exactly 7 days before the previous one. A week not yet trained does not
-- break the streak, which is why the anchor may be the current week or the
-- previous one.
--
-- A leaderboard needs that number for every member at once, so this is the
-- same arithmetic expressed once, set-wide, instead of a per-member function
-- called in a loop. It is NOT a second definition of "streak": migrations
-- already merged are never edited, so community_profile keeps its inline
-- copy, and 0034_feed_leaderboard_and_suggestions_test.sql asserts the two
-- produce the same number for the same member so they cannot drift apart
-- unnoticed. When COMM-306 (Phase 3) swaps consistency onto verified
-- attendance, this function body is the single place that changes and
-- feed_leaderboard's contract does not move at all.
--
-- SECURITY INVOKER with no grant to anyone: it is internal plumbing, not an
-- API. Called from feed_leaderboard (definer, owned by the migration owner)
-- it runs with that owner's rights, which is how it sees every member's
-- posts; called from anywhere else it cannot be called at all. That keeps
-- the "definer functions check auth.uid() first" rule where it belongs - on
-- the entry point, not on a helper that has no caller of its own.
create or replace function public.consistency_week_streaks()
returns table (user_id uuid, streak integer)
language sql stable security invoker set search_path = '' as $$
  with weeks as (
    select p.author_id as uid,
           date_trunc('week', coalesce(p.occurred_on, p.created_at::date)::timestamp)::date as wk
    from public.workout_posts p
    where p.author_id is not null
      and p.deleted_at is null
      and p.status = 'active'
      and p.post_type in ('POST_WORKOUT', 'POST_PR')
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
  -- nothing after it - the same reason community_profile's version gives.
  select a.uid, count(*)::integer
  from anchored a
  where a.anchor >= date_trunc('week', current_date::timestamp)::date - 7
    and a.wk = a.anchor - ((a.rn - 1) * 7)::integer
  group by a.uid;
$$;

revoke all on function public.consistency_week_streaks() from public, anon, authenticated;

comment on function public.consistency_week_streaks() is
  'Internal. Current consecutive-ISO-week training streak for every member, the set-based form of community_profile''s current_streak. No grants: only feed_leaderboard calls it. COMM-306 replaces the body with verified attendance without touching feed_leaderboard.';

-- =====================================================================
-- 3. feed_leaderboard - COMM-210, COMM-211, COMM-212
-- =====================================================================
-- One function, two modes, two scopes, because the client renders one
-- component with a mode switch and a scope switch. Splitting it into
-- feed_leaderboard_consistency and feed_leaderboard_progress would push the
-- self-row rule, the limit clamp and the visibility filter into two places
-- that then have to be kept identical by hand.
--
-- SECURITY DEFINER buys exactly two things, both of which are already the
-- established pattern here:
--   - a member whose visible_to_club is off is not selectable through
--     profiles_read_authenticated (202608280003), yet the caller's OWN row
--     must always come back even when that member is the caller;
--   - workout_posts rows behind the streak are subject to
--     post_visible_to_viewer, but a consistency streak is a count of weeks,
--     not a list of posts. community_streaks (202608270001) already exposes
--     a streak number computed over rows the viewer cannot read one by one,
--     for the same reason.
-- It does not widen anything else: every ranked member still has to pass
-- can_view_profile_field twice, and that helper is the module's single
-- resolution point for both toggles and for block edges.
--
-- Blocks are NOT re-implemented here. can_view_profile_field checks a block
-- edge in either direction BEFORE it consults is_admin() or any toggle, so
-- one call already answers "blocked" and "opted out". A second not-exists
-- against public.blocks would be a second definition of the same rule.
--
-- The known consequence of routing through that helper: it returns true for
-- every field when the caller is a real is_admin(), so an admin's board
-- includes members who left in_leaderboards. That is the module-wide
-- behaviour of the resolution point (coach_celebrate_feed documents the same
-- thing), not a leaderboard decision. A coach who is only rank-20 staff sees
-- the same filtered board every member sees.
--
-- Ranking and ties, COMM-210: order by value descending, then by longer club
-- tenure (invite_redemptions.redeemed_at, falling back to profiles.created_at
-- the same way community_profile's member_since does), then alphabetically by
-- display_name, then by id so the order is total. Because ties are fully
-- broken, `rank` is a position: it is 1, 2, 3 with no repeats and no gaps,
-- and two members on the same streak are never both "rank 4".
--
-- Zero is a real value, not an absence. Every eligible member is ranked,
-- including a member with a 0-week streak or 0 progress, because that is what
-- makes the caller's "real rank" real - there is no rank to report from a set
-- the caller was filtered out of. COMM-210's "not enough data yet" empty
-- state is therefore "no rows, or every returned value is 0", not "no rows".
--
-- Club scope is club-wide with no club_id filter, matching every other
-- Phase 2 read function (chal_progress, community_search, coach_celebrate_feed).
-- The module is single-club today; when it stops being one, this is a
-- one-line predicate in cand below and nowhere else.
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
  'COMM-210/211/212 leaderboard. p_mode consistency (club-wide ISO-week training streak, p_challenge_id ignored) or progress (challenge_participants.progress_value, p_challenge_id required or it raises). p_scope club or friends (are_friends mutual follows, caller always included). Every ranked member passes can_view_profile_field for in_leaderboards and visible_to_club, which also settles block edges in both directions. rank is a position with ties broken by tenure then display name. The caller''s own row is always returned, appended last with its real rank when outside p_limit (clamped 1..100).';

-- =====================================================================
-- 4. people_suggestions - COMM-232
-- =====================================================================
-- The non-attendance fallback for "people you train with". Ranked by real
-- overlap the module can actually see today, in the priority order COMM-232
-- states: a shared active challenge first, then having engaged with the same
-- posts, then having said "going" to the same event.
--
-- Structured so COMM-302/307 can add the verified-attendance signal in a
-- later migration without touching the client: the signals CTE is a union of
-- one branch per signal, each emitting (candidate, signal, n). Adding
-- recurring-classmate overlap is one more branch, one more counter in
-- `scored`, and one more position in the ORDER BY. The returned jsonb carries
-- the per-signal counts under `signals` and an advisory `reason` label, so a
-- fourth signal extends both without renaming or removing a key any client is
-- already reading. The ranking itself is never part of the returned shape
-- beyond that - the client renders the order it is given.
--
-- Priority is lexicographic, not a weighted sum, because COMM-232 says "in
-- order": one shared challenge outranks any number of shared reactions, and
-- no amount of a weaker signal can overtake a stronger one.
--
-- SECURITY DEFINER for one boundary: feed_interactions is self-select only
-- (202608280006), so no member can compute overlap with anyone. This function
-- crosses that on purpose and returns only a count of shared posts - never a
-- post id, never a timestamp, never which post. event_attendees and
-- challenge_participants are readable already; they are here because the
-- three signals belong in one query.
--
-- Blocks are, again, not re-implemented: can_view_profile_field settles them
-- before any toggle. Deleted profiles fall out through the same call.
--
-- The 60-day window applies to the two time-stamped signals (interaction
-- created_at, RSVP registered_at). The challenge signal is bounded by the
-- challenge being live instead - an active challenge that started 90 days ago
-- is current by definition, and dropping it for being old would ignore the
-- strongest signal in the list.
create or replace function public.people_suggestions(p_limit int default 10)
returns setof jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_limit int;
  v_since timestamptz;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  if public.my_role_code() is null then raise exception 'not authorized'; end if;

  v_limit := greatest(1, least(coalesce(p_limit, 10), 20));
  v_since := now() - interval '60 days';

  return query
  with signals as (
    -- Signal 1: both in the same live challenge.
    select cp2.user_id as cand, 'challenge'::text as signal,
           count(distinct cp2.challenge_id)::integer as n
    from public.challenge_participants cp1
    join public.challenge_participants cp2
      on cp2.challenge_id = cp1.challenge_id
     and cp2.user_id <> cp1.user_id
    join public.challenges ch on ch.id = cp1.challenge_id
    where cp1.user_id = v_uid
      and cp1.status <> 'withdrawn'
      and cp2.status <> 'withdrawn'
      and ch.status = 'active'
      and ch.end_at >= now()
    group by cp2.user_id

    union all

    -- Signal 2: both reacted to or commented on the same post. 'open',
    -- 'hide', 'save' and 'profile_open' are telemetry, not engagement with
    -- another member, so they are not overlap.
    select fi2.user_id, 'interaction'::text,
           count(distinct fi2.post_id)::integer
    from public.feed_interactions fi1
    join public.feed_interactions fi2
      on fi2.post_id = fi1.post_id
     and fi2.user_id <> fi1.user_id
    where fi1.user_id = v_uid
      and fi1.kind in ('react', 'comment')
      and fi2.kind in ('react', 'comment')
      and fi1.created_at >= v_since
      and fi2.created_at >= v_since
    group by fi2.user_id

    union all

    -- Signal 3: both said going to the same event. 'interested' is not
    -- showing up, so it is not shared attendance of any kind.
    select ea2.user_id, 'event'::text,
           count(distinct ea2.event_id)::integer
    from public.event_attendees ea1
    join public.event_attendees ea2
      on ea2.event_id = ea1.event_id
     and ea2.user_id <> ea1.user_id
    where ea1.user_id = v_uid
      and ea1.response = 'going'
      and ea2.response = 'going'
      and ea1.registered_at >= v_since
      and ea2.registered_at >= v_since
    group by ea2.user_id
  ),
  scored as (
    select s.cand,
           coalesce(sum(s.n) filter (where s.signal = 'challenge'), 0)::integer as n_challenges,
           coalesce(sum(s.n) filter (where s.signal = 'interaction'), 0)::integer as n_interactions,
           coalesce(sum(s.n) filter (where s.signal = 'event'), 0)::integer as n_events
    from signals s
    group by s.cand
  ),
  eligible as (
    select sc.cand, sc.n_challenges, sc.n_interactions, sc.n_events,
           p.display_name, p.handle, p.avatar_url
    from scored sc
    join public.profiles p on p.id = sc.cand
    where sc.cand <> v_uid
      -- An existing edge in either direction is not a suggestion: one way
      -- means the caller already acted, the other means the strip would
      -- suggest someone already in their orbit.
      and not exists (
        select 1 from public.follows f
        where (f.follower_id = v_uid and f.followed_id = sc.cand)
           or (f.follower_id = sc.cand and f.followed_id = v_uid)
      )
      and public.can_view_profile_field(sc.cand, 'visible_to_club')
      and public.can_view_profile_field(sc.cand, 'allow_follows')
  )
  select jsonb_build_object(
    'user_id', e.cand,
    'display_name', e.display_name,
    'handle', e.handle,
    'avatar_url', e.avatar_url,
    'reason', case
                when e.n_challenges > 0 then 'challenge'
                when e.n_interactions > 0 then 'interaction'
                else 'event'
              end,
    'signals', jsonb_build_object(
      'shared_challenges', e.n_challenges,
      'shared_interactions', e.n_interactions,
      'shared_events', e.n_events
    )
  )
  from eligible e
  order by e.n_challenges desc,
           e.n_interactions desc,
           e.n_events desc,
           coalesce(nullif(btrim(e.display_name), ''), e.handle) asc,
           e.cand asc
  limit v_limit;
  -- No signal, no row. A brand new member gets zero suggestions and
  -- COMM-232's honest empty state, never a padded list of strangers.
end $$;

revoke all on function public.people_suggestions(int) from public, anon;
grant execute on function public.people_suggestions(int) to authenticated;

comment on function public.people_suggestions(int) is
  'COMM-232 people-you-may-know, the non-attendance fallback. Ranks members by shared live challenge, then shared post interaction (react or comment), then shared going RSVP, the last two over a trailing 60 days. Excludes self, any follow edge in either direction, and anything can_view_profile_field rejects for visible_to_club or allow_follows (which also settles blocks). Returns setof jsonb {user_id, display_name, handle, avatar_url, reason, signals{shared_challenges, shared_interactions, shared_events}}. p_limit clamped 1..20. COMM-302/307 add an attendance signal to the same shape.';

commit;
