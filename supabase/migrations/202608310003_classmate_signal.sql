begin;

-- COMM-302. The recurring-classmate signal, wired into the two functions
-- that have been holding a place for it since Phase 1 and Phase 2.
--
-- WHAT LANDS HERE
--   * public.classmate_day_counts(p_as_of)  - new, internal, no grants
--   * public.feed_page(cursor, limit, scope) re-created: v_class_connection
--     stops being hard-0'd. Same signature, same returned columns.
--   * public.people_suggestions(p_limit) re-created: a fourth signal branch
--     and a fourth `signals` key. Same signature, same returned shape plus
--     one added key.
-- No new table, so no new RLS policy. Everything read here already has one.
--
-- THE TWO PLACEHOLDERS THIS CLOSES, VERBATIM
--   202608280019 / 202608310002, feed_page's declare block:
--     "v_class_connection constant numeric := 0;  -- always 0 until COMM-P01
--      lands". The component was written into the weight block on purpose so
--      that wiring an attendance source later would be a value change and
--      nothing else. It is.
--   202608290015, people_suggestions' header:
--     "Adding recurring-classmate overlap is one more branch, one more
--      counter in `scored`, and one more position in the ORDER BY." That is
--      exactly what the diff below is. `signals` gains a key; no existing key
--      is renamed, removed, or has its meaning changed, so a client reading
--      shared_challenges today keeps reading it.
--
-- WHY ONE HELPER RATHER THAN THE ARITHMETIC TWICE
-- This is the one deliberate addition beyond COMM-302's migration outline,
-- which named only the two `create or replace`s. Both functions need the
-- same three things - the same 60-day window, the same
-- overlapping-occurred_on count, and the same show_attendance gate - and the
-- repo already knows what two copies cost: community_profile's inline streak
-- versus consistency_week_streaks() needs a standing pgTAP assertion to stop
-- it drifting, and COMM-301 moved feed_page's relationship arithmetic out for
-- exactly this reason. The privacy gate in particular is the last thing that
-- should exist twice: two copies means two chances to forget it.
--
-- It is a SET-RETURNING helper, not a scalar one, and that is forced rather
-- than stylistic. people_suggestions builds its candidate set FROM the
-- signals union - a member whose only overlap with the caller is attendance
-- has to be introduced BY this branch or they are never a candidate at all.
-- A scalar `classmate_score(viewer, other)` could not do that; it could only
-- score candidates something else had already found. The same function shape
-- serves feed_page fine, as a left join on an author set it already has.
--
-- WHY IT TAKES NO VIEWER PARAMETER
-- It resolves the viewer from auth.uid() instead. can_view_profile_field()
-- resolves ITS viewer from auth.uid() and cannot be told to answer for
-- somebody else, so a p_viewer parameter would be honoured by the overlap
-- count and silently ignored by the privacy gate - which is precisely the
-- trap COMM-301 refused when it declined to hand are_friends() a viewer it
-- would ignore. Both callers want the caller's own overlap anyway. p_as_of
-- is a parameter for the same reason relationship_score's is: feed_page
-- measures every window from its frozen session anchor so that page 2 scores
-- identically to page 1.

-- ---------------------------------------------------------------------------
-- classmate_day_counts
-- ---------------------------------------------------------------------------
-- "How many days in the trailing window did the caller and this member both
-- train", for every member it may be answered for. One row per member with
-- at least one shared day; a member with no overlap is absent, not a zero
-- row, because both callers treat absent as 0 and neither wants a club-sized
-- result set of zeros.
--
-- THE WINDOW is 60 days, stated once, here. COMM-302 fixes it at the same
-- window people_suggestions' two time-stamped signals already use
-- (feed_interactions.created_at, event_attendees.registered_at), so the four
-- signals in that function are all measured over the same period. It is a
-- trailing window on purpose: a training partnership from eight months ago
-- must not outrank someone the member trained beside twice last week.
-- Lower-bounded only, exactly like relationship_score's 30-day window and
-- like the two signals it matches - attendance_log's own trigger already
-- refuses anything past current_date + 1, so there is nothing above the
-- anchor to exclude except a legitimate timezone-slack day.
--
-- THE PRIVACY GATE is can_view_profile_field(member, 'show_attendance'), and
-- it is the whole reason this function exists rather than a join written
-- twice. show_attendance is attendance's OWN toggle (202608280003), separate
-- from visible_to_club, and it DEFAULTS TO FALSE - so out of the box no
-- member contributes a classmate signal to anyone, and turning it on is a
-- deliberate act. A member with it off still accumulates attendance_log rows,
-- still earns attendance achievements from them (COMM-305) and still ranks on
-- the consistency board with them (COMM-306); what they do not do is show up
-- in anyone else's ranking or suggestion strip as a training partner.
--
-- can_view_profile_field's is_admin() short-circuit applies here as it does
-- everywhere else, so a real admin's feed and strip do see classmate signals
-- from members who opted out. That is the module-wide behaviour of the one
-- resolution point - feed_leaderboard's contract already records it - and not
-- a rule this function invents.
--
-- BLOCKS come through the same call and are deliberately not re-implemented:
-- can_view_profile_field settles a block edge in either direction before it
-- consults any toggle, which is the same thing people_suggestions already
-- relies on for its other three signals ("Blocks are, again, not
-- re-implemented", 202608290015). feed_page additionally drops a blocked
-- author from its candidate set outright, as it already did.
--
-- The gate is applied AFTER the aggregate, so it runs once per member who
-- actually shares a day with the caller rather than once per club member.
--
-- Self is excluded. A member is not their own classmate: feed_page would
-- otherwise hand every viewer a full class-connection component on their own
-- posts, and people_suggestions already refuses to suggest the caller to
-- themselves. Same self-exclusion relationship_score keeps.
--
-- SECURITY INVOKER with no grant to any role - the shape
-- consistency_week_streaks() (202608290015) and relationship_score()
-- (202608310002) both use. Called from feed_page or people_suggestions, both
-- SECURITY DEFINER and both owned by the migration owner, it runs with that
-- owner's rights, which is how it reads other members' attendance_log rows
-- past `attendance_log_self_select`. Called from anywhere a client can reach,
-- it cannot be called at all. The auth.uid() check stays on the entry points,
-- where it belongs; the null guard below is a correctness guard, not an
-- authorization one.
--
-- attendance_log_club_day_idx (202608310001) was created for this read.
create or replace function public.classmate_day_counts(
  p_as_of timestamptz default now()
) returns table (user_id uuid, shared_days integer)
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_window_days constant integer := 60;
  v_uid uuid;
  v_since date;
begin
  v_uid := auth.uid();
  -- No caller, no overlap. Returns an empty set rather than raising: this is
  -- a helper, and its callers have already refused a null uid themselves.
  if v_uid is null then return; end if;

  v_since := (coalesce(p_as_of, now()) - make_interval(days => v_window_days))::date;

  return query
  with mine as (
    select a.occurred_on as day
    from public.attendance_log a
    where a.user_id = v_uid
      and a.occurred_on >= v_since
  ),
  overlap as (
    select o.user_id as uid,
           count(*)::integer as n
    from public.attendance_log o
    join mine m on m.day = o.occurred_on
    where o.user_id <> v_uid
      and o.occurred_on >= v_since
    group by o.user_id
  )
  select ov.uid, ov.n
  from overlap ov
  where public.can_view_profile_field(ov.uid, 'show_attendance');
end $$;

revoke all on function public.classmate_day_counts(timestamptz)
  from public, anon, authenticated;

comment on function public.classmate_day_counts(timestamptz) is
  'Internal. Days in the trailing 60 days on which auth.uid() and another member both have an attendance_log row, one row per member with at least one such day (no zero rows). Gated per member by can_view_profile_field(member, ''show_attendance''), which also settles block edges in both directions and deleted profiles; show_attendance defaults false, so a member contributes nothing here until they turn it on, while their own rows still count toward their own achievements and leaderboard rank. Self excluded. p_as_of defaults to now() and is the anchor the window is measured back from, so feed_page can pass its frozen session anchor. Takes no viewer parameter because the privacy gate resolves its viewer from auth.uid() and could not honour one. No grants: only definer functions that have already resolved auth.uid() call it. COMM-302.';

-- ---------------------------------------------------------------------------
-- feed_page, re-created. COMM-110/111/112/113, closing COMM-P01.
-- ---------------------------------------------------------------------------
-- Identical to 202608310002 apart from four hunks, all of them the class
-- component and nothing else:
--   * the declare block: v_class_connection (the hard 0) is gone, and
--     v_class_saturation (the shaping constant that normalises the new count
--     to 0..1) takes its place beside the other shaping constants. v_w_class
--     is untouched at 6 - the weight was always feed_page's business and it
--     was already reserved.
--   * the my_classes early return: same behaviour, comment corrected, since
--     it no longer true that the module has no attendance source. See there.
--   * author_facts: one more column, class_days, from a left join on
--     classmate_day_counts(v_anchor) - the same place and the same shape
--     rel_value already resolves in, once per distinct author rather than
--     once per row.
--   * the score expression: v_w_class * <the normalised component> instead
--     of v_w_class * 0.
-- The cursor, the candidate filters, the other seven components, the
-- repetition penalty, the diversity pass and the row projection are the
-- previous file's text, unchanged.
--
-- HOW THE COMPONENT IS NORMALISED, and why this shape.
-- Every component in this function is a 0..1 number multiplied by a weight
-- stated in one block, so weights stay directly comparable. This one is
--     least(1.0, class_days / v_class_saturation)
-- which is the engagement component's exact shape - a raw count over a
-- saturation constant, capped - and reaches the same ceiling
-- relationship_score's least(1.0, ...) does. Saturating rather than scaling
-- by the window length matters: 60 days of shared attendance and 8 days of
-- shared attendance are both "you train with this person", and dividing by 60
-- would make even a real training partner worth a rounding error.
create or replace function public.feed_page(
  p_cursor text default null,
  p_limit integer default 20,
  p_scope text default 'for_you'
)
returns table (
  id uuid,
  post_type public.post_type,
  author_id uuid,
  author jsonb,
  body text,
  title text,
  result_text text,
  occurred_on date,
  visibility public.post_visibility,
  created_at timestamptz,
  published_at timestamptz,
  metadata jsonb,
  media jsonb,
  reaction_count integer,
  comment_count integer,
  feed_score numeric,
  next_cursor text
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  -- =========================================================================
  -- SCORING WEIGHTS. This block is the only place any of them appear.
  -- Every component is normalised to 0..1 first and then multiplied by its
  -- weight here, so a weight is directly comparable to every other weight
  -- and tuning one is a one-line change with no other arithmetic to redo.
  -- The positive weights sum to 104. Nothing depends on that number, it is
  -- only there so they read as rough percentages.
  -- =========================================================================
  v_w_recency        constant numeric := 40;  -- how fresh the post is
  v_w_relationship   constant numeric := 18;  -- who the author is to the viewer
  v_w_coach          constant numeric := 10;  -- coach voice carries further
  v_w_achievement    constant numeric := 8;   -- PRs, achievements, milestones
  v_w_challenge      constant numeric := 6;   -- challenge and event content
  v_w_engagement     constant numeric := 10;  -- what the club already did with it
  v_w_personal       constant numeric := 12;  -- it is about, or involves, the viewer
  -- COMM-302, closing COMM-P01. This weight was reserved and multiplied by a
  -- hard 0 from 202608280019 until now, so that wiring an attendance source
  -- would be a value change here and nothing else. It is: the value now comes
  -- from public.classmate_day_counts(), normalised below. The weight itself
  -- has not moved.
  v_w_class          constant numeric := 6;   -- the viewer and the author train together

  -- Component shaping constants. Same block, same reason.
  -- Recency is an exponential half-life, not a cliff: 36 hours means
  -- yesterday's post is worth half of this morning's and a week-old post
  -- about 1.5% of it.
  v_recency_half_life_hours constant numeric := 36;
  -- COMM-301: the relationship component's own constants (mutual, follow,
  -- interaction, window) moved into public.relationship_score(), which is
  -- called below with v_anchor so the 30-day interaction window is measured
  -- from the same frozen session anchor as every other term. Only its weight
  -- is still stated here.
  -- Coach: an explicitly coach-voiced post is the full component, anything
  -- else written by a member at coach rank or above is half of it.
  v_coach_post       constant numeric := 1.0;
  v_coach_author     constant numeric := 0.5;
  -- Engagement is CAPPED. A comment is worth two reactions because it costs
  -- more to leave, and the whole term saturates, so a post that goes loud
  -- cannot outrank a week of everything else on volume alone.
  v_comment_weight   constant numeric := 2.0;
  v_engagement_saturation constant numeric := 12.0;
  -- COMM-302. The class component SATURATES, on the same reasoning and in
  -- the same shape as engagement above: eight days trained alongside this
  -- author inside classmate_day_counts()' 60-day window is the full
  -- component, and more does not buy more. Eight is roughly twice a week for
  -- a month - a real training partnership rather than a coincidence - and
  -- past that the answer to "do these two train together" stops changing.
  -- Scaling by the window length instead would make even a daily training
  -- partner worth a fraction of a point.
  v_class_saturation constant numeric := 8.0;
  -- Personal relevance: each signal adds, the sum is capped at 1.
  v_pers_mention     constant numeric := 1.0;  -- the body names the viewer
  v_pers_reply       constant numeric := 0.8;  -- someone replied to the viewer here
  v_pers_thread      constant numeric := 0.5;  -- the viewer is in this thread
  v_pers_participant constant numeric := 0.6;  -- viewer is in the linked challenge or event
  -- Repetition penalty: the Nth post by one member inside the window costs
  -- (N-1) steps, capped, so a member emptying their training log does not
  -- take the whole page. Subtracted from the total, never applied to an
  -- authorless system post.
  v_repetition_window_hours constant numeric := 24;
  v_repetition_step  constant numeric := 6;
  v_repetition_max   constant numeric := 18;

  -- =========================================================================
  -- DIVERSITY LIMITS (COMM-112). Also one place, also tunable.
  -- =========================================================================
  v_max_same_author  constant integer := 2;  -- consecutive posts by one member
  v_max_system_run   constant integer := 2;  -- consecutive system-generated posts
  v_max_workout_run  constant integer := 3;  -- consecutive workout cards
  -- After a run of this many workout cards the next slot prefers an
  -- achievement, coach, challenge or event card, when the page holds one.
  v_prefer_after_workouts constant integer := 2;

  -- How far back a page may reach and how many rows one session may rank.
  -- The cap is what keeps the scoring pass bounded; past it the feed ends
  -- with the caught-up marker rather than scanning the whole table.
  v_window_days      constant integer := 90;
  v_candidate_cap    constant integer := 600;

  v_uid uuid;
  v_handle text;
  v_limit integer;
  v_scope text;
  v_anchor timestamptz;
  v_cur_score numeric;
  v_cur_pub timestamptz;
  v_cur_id uuid;
  v_tail jsonb := '[]'::jsonb;
  v_tail_out jsonb := '[]'::jsonb;
  v_token jsonb;
  v_page jsonb := '[]'::jsonb;
  v_last jsonb;
  v_next text;

  -- diversity working set
  v_cand_id uuid[];
  v_cand_author uuid[];
  v_cand_kind text[];
  v_cand_score numeric[];
  v_used boolean[];
  v_ids uuid[] := array[]::uuid[];
  v_out_author uuid[] := array[]::uuid[];
  v_out_kind text[] := array[]::text[];
  v_out_score numeric[] := array[]::numeric[];
  v_n integer;
  v_slot integer;
  v_i integer;
  v_pick integer;
  v_run_author uuid;
  v_run_author_n integer := 0;
  v_run_system_n integer := 0;
  v_run_workout_n integer := 0;
  v_prefer boolean;
  v_e jsonb;
  v_a uuid;
  v_k text;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  v_limit := least(greatest(coalesce(p_limit, 20), 1), 40);
  v_scope := lower(coalesce(p_scope, 'for_you'));
  -- COMM-111: an unknown scope falls back to for_you rather than raising, so
  -- an old client that has not learned a scope name still gets a feed.
  if v_scope not in ('for_you', 'following', 'achievements', 'coach', 'my_classes') then
    v_scope := 'for_you';
  end if;
  -- my_classes STAYS PARKED, deliberately, even though COMM-300 gave the
  -- module an attendance source and this migration wires it into the ranking
  -- above. A class-connection SCORE and a my-classes SCOPE are two different
  -- questions: the score asks "how much do these two members train
  -- together", which shared attendance days answer, and the scope asks
  -- "which posts belong to a class I attend", which they do not -
  -- attendance_log records days, not classes, and carries no class identity
  -- to filter a post by. Unparking the chip needs a source that has one, plus
  -- the client change to enable it, and neither is COMM-302. So this still
  -- answers empty rather than quietly answering something else, and the
  -- client still renders that chip disabled.
  if v_scope = 'my_classes' then
    return;
  end if;

  select p.handle into v_handle from public.profiles p where p.id = v_uid;

  -- --- cursor ------------------------------------------------------------
  -- Opaque on the wire: base64 of a small json object. A null, malformed or
  -- stale token restarts from the top instead of raising, because holding a
  -- stale cursor is a normal thing for a client to do.
  v_anchor := now();
  if p_cursor is not null and length(p_cursor) between 8 and 4000 then
    begin
      v_token := convert_from(decode(p_cursor, 'base64'), 'utf8')::jsonb;
      v_anchor := (v_token ->> 'a')::timestamptz;
      v_cur_score := (v_token ->> 's')::numeric;
      v_cur_pub := (v_token ->> 't')::timestamptz;
      v_cur_id := (v_token ->> 'i')::uuid;
      v_tail := coalesce(v_token -> 'p', '[]'::jsonb);
    exception when others then
      v_anchor := null; v_cur_score := null; v_cur_pub := null; v_cur_id := null;
      v_tail := '[]'::jsonb;
    end;
  end if;
  if v_anchor is null then v_anchor := now(); end if;
  -- A half-decoded token is treated as no token at all: a partial keyset
  -- would compare to null and silently return an empty page forever.
  if v_cur_score is null or v_cur_pub is null or v_cur_id is null then
    v_cur_score := null; v_cur_pub := null; v_cur_id := null;
  end if;

  -- --- score, then cut the page on the keyset ----------------------------
  select coalesce(
    jsonb_agg(jsonb_build_object('id', s.pid, 'a', s.aid, 'k', s.kind, 's', s.total, 't', s.pub)
              order by s.total desc, s.pub desc, s.pid desc),
    '[]'::jsonb)
  into v_page
  from (
    select sc.pid, sc.aid, sc.kind, sc.pub, sc.total
    from (
      with cand as (
        select p.id as pid,
               p.author_id as aid,
               p.post_type as ptype,
               p.published_at as pub,
               p.body as pbody,
               ((extract(epoch from (v_anchor - p.published_at)) / 3600.0))::numeric as age_hours,
               -- The three diversity classes plus a neutral one. An
               -- announcement is coach voice, not a system notice, so it is
               -- deliberately not counted against the system run.
               case
                 when p.post_type in ('POST_SYSTEM', 'POST_NEW_MEMBER') then 'system'
                 when p.post_type = 'POST_WORKOUT' then 'workout'
                 when p.post_type in (
                   'POST_ACHIEVEMENT', 'POST_PR', 'POST_ATTENDANCE_MILESTONE',
                   'POST_COACH', 'POST_ANNOUNCEMENT', 'POST_CHALLENGE', 'POST_EVENT'
                 ) then 'boost'
                 else 'other'
               end as kind,
               case when coalesce(p.metadata ->> 'challenge_id', '') ~ '^[0-9a-fA-F]{8}-'
                    then (p.metadata ->> 'challenge_id')::uuid else p.source_id end as challenge_ref,
               case when coalesce(p.metadata ->> 'event_id', '') ~ '^[0-9a-fA-F]{8}-'
                    then (p.metadata ->> 'event_id')::uuid else p.source_id end as event_ref
        from public.workout_posts p
        where p.deleted_at is null
          and p.status = 'active'
          and p.published_at <= v_anchor
          and p.published_at >= v_anchor - make_interval(days => v_window_days)
          -- COMM-108: a post the member muted never comes back.
          and not exists (
            select 1 from public.hidden_posts h where h.user_id = v_uid and h.post_id = p.id)
          -- Reporting a post hides it from the reporter immediately, which
          -- is what the client already promises when a report is filed.
          and not exists (
            select 1 from public.reports rp where rp.post_id = p.id and rp.reporter_id = v_uid)
          -- COMM-125 block edges, in either direction. post_visible_to_viewer
          -- checks the same thing; this is stated separately because "the
          -- feed excludes blocked authors" has to be readable as its own rule.
          -- It is also what makes a block strictly stronger than the class
          -- component COMM-302 added: a blocked author never reaches the
          -- scoring pass at all, whatever their overlap with the viewer.
          and not exists (
            select 1 from public.blocks b
            where (b.blocker_id = v_uid and b.blocked_id = p.author_id)
               or (b.blocker_id = p.author_id and b.blocked_id = v_uid))
          -- The one place that says what each visibility label means. This
          -- function is definer, so RLS is not doing the filtering here and
          -- this call is what stands in for it.
          and public.post_visible_to_viewer(p.id)
          -- COMM-111 scopes.
          and (v_scope <> 'following' or exists (
                select 1 from public.follows f
                where f.follower_id = v_uid and f.followed_id = p.author_id))
          and (v_scope <> 'achievements' or p.post_type in (
                'POST_PR', 'POST_ACHIEVEMENT', 'POST_ATTENDANCE_MILESTONE'))
          and (v_scope <> 'coach' or p.post_type in ('POST_COACH', 'POST_ANNOUNCEMENT'))
        order by p.published_at desc
        limit v_candidate_cap
      ),
      -- Relationship, class connection and author role depend on the author,
      -- not the post, so they resolve once per distinct author instead of
      -- once per row.
      authors as (
        select distinct c.aid as aid from cand c where c.aid is not null
      ),
      author_facts as (
        select a.aid as aid,
               -- COMM-301. Was an inline case/exists block here; identical
               -- arithmetic, same anchor, one copy.
               public.relationship_score(v_uid, a.aid, v_anchor) as rel_value,
               -- COMM-302. Was the constant 0. The helper is evaluated once
               -- for the whole page, not once per author, and it carries the
               -- show_attendance gate and the block check with it - an author
               -- who keeps their attendance private simply has no row here,
               -- so the coalesce below scores them 0.
               coalesce(cd.shared_days, 0) as class_days,
               (exists (select 1 from public.invite_redemptions ir
                        where ir.user_id = a.aid and public.role_rank(ir.role) >= 20)
                or exists (select 1 from public.profiles pf
                           where pf.id = a.aid and pf.is_admin and pf.deleted_at is null)
               ) as author_is_staff
        from authors a
        left join public.classmate_day_counts(v_anchor) cd on cd.user_id = a.aid
      ),
      counted as (
        select c.pid as pid,
               (select count(*) from public.reactions r where r.post_id = c.pid) as reactions,
               (select count(*) from public.post_comments pc
                where pc.post_id = c.pid and pc.deleted_at is null and pc.status = 'active') as comments
        from cand c
      ),
      -- The Nth post by one author inside the repetition window. Ordering
      -- the partition newest first means every post counted ahead of an
      -- in-window post is itself in the window, so a plain row_number is
      -- exact and no second window predicate is needed.
      repeated as (
        select c.pid as pid,
               case when c.aid is null or c.age_hours > v_repetition_window_hours then 0
                    else (row_number() over (partition by c.aid order by c.pub desc))::integer - 1
               end as rep_index
        from cand c
      )
      select c.pid, c.aid, c.kind, c.pub,
             round(
                 v_w_recency * power(0.5::numeric, c.age_hours / v_recency_half_life_hours)
               + v_w_relationship * coalesce(af.rel_value, 0)
               + v_w_coach * (case
                   when c.ptype in ('POST_COACH', 'POST_ANNOUNCEMENT') then v_coach_post
                   when coalesce(af.author_is_staff, false) then v_coach_author
                   else 0 end)
               + v_w_achievement * (case
                   when c.ptype in ('POST_PR', 'POST_ACHIEVEMENT', 'POST_ATTENDANCE_MILESTONE')
                   then 1 else 0 end)
               + v_w_challenge * (case
                   when c.ptype in ('POST_CHALLENGE', 'POST_EVENT') then 1 else 0 end)
               + v_w_engagement * least(1.0,
                   (cnt.comments * v_comment_weight + cnt.reactions) / v_engagement_saturation)
               + v_w_personal * least(1.0,
                   (case when v_handle is not null and v_handle <> ''
                          and position(lower('@' || v_handle) in lower(coalesce(c.pbody, ''))) > 0
                         then v_pers_mention else 0 end)
                   + (case when exists (
                         select 1 from public.post_comments rc
                         join public.post_comments pc on pc.id = rc.parent_comment_id
                         where rc.post_id = c.pid and rc.deleted_at is null and pc.author_id = v_uid)
                       then v_pers_reply else 0 end)
                   + (case when exists (
                         select 1 from public.post_comments pc
                         where pc.post_id = c.pid and pc.author_id = v_uid and pc.deleted_at is null)
                       then v_pers_thread else 0 end)
                   + (case when exists (
                         select 1 from public.challenge_participants chp
                         where chp.user_id = v_uid and chp.challenge_id = c.challenge_ref)
                       or exists (
                         select 1 from public.event_attendees ea
                         where ea.user_id = v_uid and ea.event_id = c.event_ref)
                       then v_pers_participant else 0 end))
               -- COMM-302, closing COMM-P01. Shared training days over a
               -- saturation constant, capped at 1 - the engagement term's
               -- shape - so this reaches the same 0..1 ceiling every other
               -- component does before v_w_class applies. No shared days is
               -- 0, not a missing term.
               + v_w_class * least(1.0, coalesce(af.class_days, 0) / v_class_saturation)
               - least(rep.rep_index * v_repetition_step, v_repetition_max)
             , 6) as total
      from cand c
      left join author_facts af on af.aid = c.aid
      join counted cnt on cnt.pid = c.pid
      join repeated rep on rep.pid = c.pid
    ) sc
    where v_cur_score is null
       or (sc.total, sc.pub, sc.pid) < (v_cur_score, v_cur_pub, v_cur_id)
    order by sc.total desc, sc.pub desc, sc.pid desc
    limit v_limit
  ) s;

  v_n := jsonb_array_length(v_page);
  if v_n = 0 then
    return;
  end if;

  -- --- diversity (COMM-112) ---------------------------------------------
  select array_agg((e ->> 'id')::uuid order by ord),
         array_agg(nullif(e ->> 'a', '')::uuid order by ord),
         array_agg(e ->> 'k' order by ord),
         array_agg((e ->> 's')::numeric order by ord)
  into v_cand_id, v_cand_author, v_cand_kind, v_cand_score
  from jsonb_array_elements(v_page) with ordinality t(e, ord);

  v_used := array_fill(false, array[v_n]);

  -- Seed the run counters from the tail of the previous page, so the limits
  -- hold across a page boundary and not only inside one page.
  begin
    for v_e in select value from jsonb_array_elements(v_tail) loop
      v_a := case when v_e ->> 'a' ~ '^[0-9a-fA-F]{8}-' then (v_e ->> 'a')::uuid else null end;
      v_k := coalesce(v_e ->> 'k', 'other');
      if v_a is not null and v_a = v_run_author then v_run_author_n := v_run_author_n + 1;
      else v_run_author := v_a; v_run_author_n := case when v_a is null then 0 else 1 end;
      end if;
      v_run_system_n := case when v_k = 'system' then v_run_system_n + 1 else 0 end;
      v_run_workout_n := case when v_k = 'workout' then v_run_workout_n + 1 else 0 end;
    end loop;
  exception when others then
    v_run_author := null; v_run_author_n := 0; v_run_system_n := 0; v_run_workout_n := 0;
  end;

  for v_slot in 1 .. v_n loop
    v_pick := null;
    -- After a workout run, prefer an achievement, coach, challenge or event
    -- card. A preference, not a rule: it applies only while the page still
    -- holds one.
    v_prefer := v_run_workout_n >= v_prefer_after_workouts;

    if v_prefer then
      for v_i in 1 .. v_n loop
        if not v_used[v_i] and v_cand_kind[v_i] = 'boost'
           and not (v_cand_author[v_i] is not null and v_cand_author[v_i] = v_run_author
                    and v_run_author_n >= v_max_same_author)
        then v_pick := v_i; exit; end if;
      end loop;
    end if;

    if v_pick is null then
      for v_i in 1 .. v_n loop
        if not v_used[v_i]
           and not (v_cand_author[v_i] is not null and v_cand_author[v_i] = v_run_author
                    and v_run_author_n >= v_max_same_author)
           and not (v_cand_kind[v_i] = 'system' and v_run_system_n >= v_max_system_run)
           and not (v_cand_kind[v_i] = 'workout' and v_run_workout_n >= v_max_workout_run)
        then v_pick := v_i; exit; end if;
      end loop;
    end if;

    -- COMM-112 validation rule: when the candidate set cannot satisfy a
    -- limit, relax that limit rather than return a shorter page.
    if v_pick is null then
      for v_i in 1 .. v_n loop
        if not v_used[v_i] then v_pick := v_i; exit; end if;
      end loop;
    end if;

    v_used[v_pick] := true;
    v_ids := v_ids || v_cand_id[v_pick];
    v_out_author := v_out_author || v_cand_author[v_pick];
    v_out_kind := v_out_kind || v_cand_kind[v_pick];
    v_out_score := v_out_score || v_cand_score[v_pick];

    if v_cand_author[v_pick] is not null and v_cand_author[v_pick] = v_run_author then
      v_run_author_n := v_run_author_n + 1;
    else
      v_run_author := v_cand_author[v_pick];
      v_run_author_n := case when v_cand_author[v_pick] is null then 0 else 1 end;
    end if;
    v_run_system_n := case when v_cand_kind[v_pick] = 'system' then v_run_system_n + 1 else 0 end;
    v_run_workout_n := case when v_cand_kind[v_pick] = 'workout' then v_run_workout_n + 1 else 0 end;
  end loop;

  -- --- next cursor -------------------------------------------------------
  -- A short page is the end of the feed, so it carries no cursor and the
  -- client shows the caught-up marker instead of a load-more control. The
  -- boundary row is the last one in SCORE order, which is v_page's last
  -- element, not the last one on screen after the diversity reorder.
  if v_n >= v_limit then
    v_last := v_page -> (v_n - 1);
    for v_i in greatest(1, v_n - 2) .. v_n loop
      v_tail_out := v_tail_out || jsonb_build_array(
        jsonb_build_object('a', v_out_author[v_i], 'k', v_out_kind[v_i]));
    end loop;
    v_next := translate(encode(convert_to(
      jsonb_build_object(
        'a', v_anchor,
        's', (v_last ->> 's')::numeric,
        't', (v_last ->> 't')::timestamptz,
        'i', v_last ->> 'id',
        'p', v_tail_out
      )::text, 'utf8'), 'base64'), E'\n', '');
  end if;

  -- --- the rows ----------------------------------------------------------
  return query
  select p.id,
         p.post_type,
         p.author_id,
         case when p.author_id is null then null
              else jsonb_build_object(
                     'display_name', pr.display_name,
                     'handle', pr.handle,
                     'avatar_url', pr.avatar_url) end,
         p.body,
         p.title,
         -- COMM-018. show_workout_results off means the result is stripped
         -- from the row, NOT that the post disappears: the member still
         -- posted, the number is just not this viewer's to read.
         case when priv.hide_result then null else p.result_text end,
         p.occurred_on,
         p.visibility,
         p.created_at,
         p.published_at,
         case when priv.hide_result
              then p.metadata - 'result_text' - 'new_result' - 'previous_result' - 'improvement'
              else p.metadata end,
         coalesce(
           (select jsonb_agg(jsonb_build_object(
                     'storage_path', m.storage_path,
                     'alt_text', m.alt_text,
                     'position', m."position",
                     'width', m.width,
                     'height', m.height) order by m."position")
            from public.post_media m where m.post_id = p.id),
           case when p.photo_path is not null
                then jsonb_build_array(jsonb_build_object('storage_path', p.photo_path, 'position', 0))
                else '[]'::jsonb end),
         (select count(*)::integer from public.reactions r where r.post_id = p.id),
         (select count(*)::integer from public.post_comments pc
          where pc.post_id = p.id and pc.deleted_at is null and pc.status = 'active'),
         v_out_score[o.ord],
         v_next
  from unnest(v_ids) with ordinality o(pid, ord)
  join public.workout_posts p on p.id = o.pid
  left join public.profiles pr on pr.id = p.author_id
  cross join lateral (
    select (p.author_id is not null
            and p.post_type in ('POST_WORKOUT', 'POST_PR')
            and not public.can_view_profile_field(p.author_id, 'show_workout_results')) as hide_result
  ) priv
  order by o.ord;
end $$;

revoke all on function public.feed_page(text, integer, text) from public, anon;
grant execute on function public.feed_page(text, integer, text) to authenticated;

-- ---------------------------------------------------------------------------
-- people_suggestions, re-created. COMM-232, extended by COMM-302.
-- ---------------------------------------------------------------------------
-- Identical to 202608290015 apart from the four things that migration's own
-- header said a fourth signal would be: one more UNION ALL branch, one more
-- counter in `scored` (carried through `eligible`), one more position in the
-- ORDER BY, one more key in `signals`. Plus the `reason` CASE gaining its
-- matching label. Nothing else moves.
--
-- THE PRIORITY ORDER IS NOW: challenge, classmate, interaction, event.
-- COMM-232 deliberately left where a fourth signal would rank as a product
-- decision for the ticket that added it rather than picking silently, and
-- COMM-302 states it: recurring in-person overlap outranks a shared reaction
-- or a shared "going" RSVP, because actually training beside someone
-- repeatedly is a stronger reason to know them than tapping the same post
-- once; it does not outrank a shared live challenge, which is a joint
-- commitment with a deadline that both members opted into by name.
--
-- Still LEXICOGRAPHIC, not a weighted sum, exactly as before: one shared
-- challenge outranks any number of shared training days, and any number of
-- shared training days outranks any number of shared reactions. No amount of
-- a weaker signal overtakes a stronger one. `reason` is the label of the
-- strongest signal present, read off in the same order.
--
-- THE RETURNED SHAPE IS ADDITIVE ONLY. `signals` gains
-- `shared_classmate_days`; `shared_challenges`, `shared_interactions` and
-- `shared_events` keep their names and their meanings, so a client reading
-- any of them today needs no change, which is what 202608290015 promised
-- ("without renaming or removing a key any client is already reading").
-- `reason` gains one possible value, 'classmate'.
--
-- PRIVACY. The classmate branch is the only one gated on show_attendance,
-- and the gate lives inside classmate_day_counts() rather than here, so it
-- cannot be applied differently in the two functions that use it. The effect
-- is worth stating plainly: a member with show_attendance off is not merely
-- ranked lower, they contribute no classmate signal at all, and if attendance
-- was their only overlap with the caller they are not suggested. Their
-- attendance_log rows still exist and still count for them.
--
-- Blocks are, again, not re-implemented anywhere in this function:
-- can_view_profile_field settles them before any toggle, in the `eligible`
-- CTE for every candidate and a second time inside classmate_day_counts()
-- for this branch's own candidates.
--
-- SECURITY DEFINER for the same one boundary as before - feed_interactions is
-- self-select only - now joined by a second: attendance_log's own policies
-- are own-row plus staff (202608310001), so no member could compute
-- attendance overlap either. As before, only counts leave the function: never
-- a post id, never an event id, never a date somebody trained.
--
-- The 60-day window applies to three of the four signals now (interaction
-- created_at, RSVP registered_at, and attendance occurred_on, the last stated
-- inside classmate_day_counts). The challenge signal is bounded by the
-- challenge being live instead, unchanged.
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

    -- Signal 2 (COMM-302): both trained on the same days. The count is
    -- calendar days the two members both logged a session inside the same
    -- trailing 60 days, already deduplicated to one day per member per day by
    -- attendance_log's unique key. The whole branch - window, overlap and the
    -- show_attendance gate - is classmate_day_counts(), which feed_page calls
    -- too, so the two functions cannot come to different answers about who
    -- trains with whom.
    select c.user_id, 'classmate'::text, c.shared_days
    from public.classmate_day_counts() c

    union all

    -- Signal 3: both reacted to or commented on the same post. 'open',
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

    -- Signal 4: both said going to the same event. 'interested' is not
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
           coalesce(sum(s.n) filter (where s.signal = 'classmate'), 0)::integer as n_classmate_days,
           coalesce(sum(s.n) filter (where s.signal = 'interaction'), 0)::integer as n_interactions,
           coalesce(sum(s.n) filter (where s.signal = 'event'), 0)::integer as n_events
    from signals s
    group by s.cand
  ),
  eligible as (
    select sc.cand, sc.n_challenges, sc.n_classmate_days, sc.n_interactions, sc.n_events,
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
                when e.n_classmate_days > 0 then 'classmate'
                when e.n_interactions > 0 then 'interaction'
                else 'event'
              end,
    'signals', jsonb_build_object(
      'shared_challenges', e.n_challenges,
      'shared_classmate_days', e.n_classmate_days,
      'shared_interactions', e.n_interactions,
      'shared_events', e.n_events
    )
  )
  from eligible e
  order by e.n_challenges desc,
           e.n_classmate_days desc,
           e.n_interactions desc,
           e.n_events desc,
           coalesce(nullif(btrim(e.display_name), ''), e.handle) asc,
           e.cand asc
  limit v_limit;
  -- No signal, no row. A brand new member gets zero suggestions and
  -- COMM-232's honest empty state, never a padded list of strangers. That is
  -- unchanged by the fourth signal: a member with zero overlap on all four
  -- still gets no card, not a padded one.
end $$;

revoke all on function public.people_suggestions(int) from public, anon;
grant execute on function public.people_suggestions(int) to authenticated;

comment on function public.people_suggestions(int) is
  'COMM-232 people-you-may-know, extended by COMM-302. Ranks members by shared live challenge, then shared training days (attendance_log overlap), then shared post interaction (react or comment), then shared going RSVP - lexicographic, so no weaker signal overtakes a stronger one. The last three are measured over a trailing 60 days. Excludes self, any follow edge in either direction, and anything can_view_profile_field rejects for visible_to_club or allow_follows (which also settles blocks). The classmate signal is additionally gated on can_view_profile_field(candidate, ''show_attendance''), inside public.classmate_day_counts(), so a member with attendance private contributes none of it. Returns setof jsonb {user_id, display_name, handle, avatar_url, reason, signals{shared_challenges, shared_classmate_days, shared_interactions, shared_events}}; reason is the strongest signal''s label and may now be ''classmate''. p_limit clamped 1..20.';

commit;
