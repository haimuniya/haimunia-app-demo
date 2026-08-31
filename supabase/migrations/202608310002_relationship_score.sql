begin;

-- COMM-301. Relationship score, extracted.
--
-- WHAT THIS IS NOT
-- It is not a ranking change. feed_page (202608280019) has scored "who this
-- author is to this viewer" since Phase 1, inline, inside its author_facts
-- CTE. This migration moves that arithmetic - the same four constants, the
-- same three branches, the same cap, the same window anchor - into one
-- function and has feed_page call it. Every score feed_page returns for a
-- given fixture is the same number to six decimal places before and after,
-- which is what supabase/tests/0038_relationship_score_test.sql pins.
--
-- WHY MOVE IT AT ALL
-- Three Phase 3 tickets need the same number and none of them are feed_page:
-- COMM-303 reweights it per member, COMM-302 adds a sibling component beside
-- it, COMM-307 wants "how close is this pair already" for a card that is not
-- a feed row. Each of those re-deriving it from feed_page's body is three
-- more copies to keep in step, and the repo already knows how that ends -
-- community_profile's inline streak versus consistency_week_streaks() needs
-- a standing pgTAP assertion to stop it drifting. One copy needs none.
--
-- SHAPE: exactly consistency_week_streaks() (202608290015).
-- SECURITY INVOKER, and no grant to any role. It is internal plumbing, not a
-- second API surface. Called from feed_page - SECURITY DEFINER, owned by the
-- migration owner - it runs with that owner's rights, which is how it reads
-- follows, reactions and post_comments rows across members, exactly as the
-- inline CTE did. Called from anywhere a client can reach, it cannot be
-- called at all. That keeps the "definer functions check auth.uid() first"
-- rule where it belongs: on the entry point, not on a helper with no caller
-- of its own.

-- ---------------------------------------------------------------------------
-- relationship_score
-- ---------------------------------------------------------------------------
--
-- TWO THINGS DELIBERATELY DIFFER FROM A NAIVE COPY-PASTE. Both exist so the
-- extraction stays behaviour-preserving; neither changes a number.
--
-- 1. p_as_of, defaulted to now().
--    The inline version measured the interaction window from feed_page's
--    v_anchor, not from now(), and that is load-bearing rather than
--    incidental: the anchor is frozen into the cursor precisely so that every
--    page of one feed session scores identically (see 202608280019's header -
--    "without it scores drift between calls and a keyset means nothing"). A
--    two-argument function reading now() internally would put the 30-day
--    boundary a few minutes further along on page 2 than on page 1, and a
--    reaction sitting near that boundary would change a row's score mid-
--    session. So the anchor is passed in. The default means the promised
--    two-argument call form, relationship_score(viewer, other), still works
--    verbatim for a caller that has no session anchor of its own.
--
-- 2. The mutual-follow test is written out rather than delegated to
--    are_friends().
--    are_friends(p_other) resolves the viewer from auth.uid(), so it cannot
--    answer for an arbitrary p_viewer, and a helper whose first parameter is
--    silently ignored is a trap for the next caller. The predicate below is
--    are_friends()'s body with auth.uid() replaced by p_viewer and nothing
--    else changed - including the null guards and the p_other <> p_viewer
--    self-exclusion, which is why a viewer's own post scores 0 on the mutual
--    and follow branches and can still pick up the interaction top-up, the
--    same as before. are_friends() remains the one definition of "friends"
--    every client-facing surface uses; 0038 asserts the two agree for both a
--    friend and a stranger so this second copy cannot drift from it.
--
-- The three indexes 202608280019 created for this lookup (follows_followed_idx
-- for the reverse follow direction, reactions_user_idx and
-- post_comments_author_recent_idx for the two interaction branches) still back
-- it, unchanged. Nothing here needs a new one.
create or replace function public.relationship_score(
  p_viewer  uuid,
  p_other   uuid,
  p_as_of   timestamptz default now()
) returns numeric
language plpgsql stable security invoker set search_path = ''
as $$
declare
  -- Moved verbatim out of feed_page's weight block, names included. A mutual
  -- follow is the full component. A one-way follow is most of it. Having
  -- actually reacted to or commented on this member recently tops it up. The
  -- sum is capped at 1, so the caller's weight is applied to a 0..1 number
  -- and stays directly comparable to every other component's weight.
  v_rel_mutual      constant numeric := 1.0;
  v_rel_follow      constant numeric := 0.55;
  v_rel_interaction constant numeric := 0.45;
  v_rel_window_days constant integer := 30;
  v_as_of timestamptz;
begin
  v_as_of := coalesce(p_as_of, now());

  return least(1.0,
      (case
         when p_viewer is not null
              and p_other is not null
              and p_other <> p_viewer
              and exists (select 1 from public.follows f
                          where f.follower_id = p_viewer and f.followed_id = p_other)
              and exists (select 1 from public.follows f
                          where f.follower_id = p_other and f.followed_id = p_viewer)
           then v_rel_mutual
         when exists (select 1 from public.follows f
                      where f.follower_id = p_viewer and f.followed_id = p_other) then v_rel_follow
         else 0
       end)
    + (case when exists (
            select 1 from public.reactions r
            join public.workout_posts rp on rp.id = r.post_id
            where r.user_id = p_viewer and rp.author_id = p_other
              and r.created_at >= v_as_of - make_interval(days => v_rel_window_days))
         or exists (
            select 1 from public.post_comments pc
            join public.workout_posts cp on cp.id = pc.post_id
            where pc.author_id = p_viewer and cp.author_id = p_other
              and pc.created_at >= v_as_of - make_interval(days => v_rel_window_days))
         then v_rel_interaction else 0 end)
  );
end $$;

revoke all on function public.relationship_score(uuid, uuid, timestamptz)
  from public, anon, authenticated;

comment on function public.relationship_score(uuid, uuid, timestamptz) is
  'Internal. How close p_viewer already is to p_other, 0..1: mutual follow 1.0 (are_friends()''s predicate, parameterised on the viewer), one-way follow 0.55, a reaction or comment by the viewer on the other member''s posts within 30 days of p_as_of adds 0.45, sum capped at 1. Extracted verbatim from feed_page''s inline author_facts CTE (202608280019), same numbers. p_as_of defaults to now() and exists so a caller with a frozen session anchor - feed_page - keeps the same 30-day boundary across every page of one session. No grants: only definer functions that have already resolved auth.uid() call it. COMM-301.';

-- ---------------------------------------------------------------------------
-- feed_page, re-created. COMM-110/111/112/113.
-- ---------------------------------------------------------------------------
-- Byte-identical to 202608280019 apart from two edits, both in this file's
-- scope and nothing else:
--   * the four v_rel_* constants left the declare block (they now live in
--     relationship_score); v_w_relationship, the weight applied to the
--     component, stays here with every other weight, because a weight is
--     feed_page's business and the component's internals are not.
--   * author_facts' rel_value is the function call instead of the CTE.
-- Everything else - the cursor, the candidate filters, the other six
-- components, the repetition penalty, the diversity pass, the row projection
-- - is the original text, unchanged.
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
  -- COMM-P01, parked. The class-connection component exists so that wiring
  -- an attendance source later is a value change here and nothing else. It
  -- is multiplied by a hard 0 below, so it cannot influence an order today
  -- and cannot be forgotten either. See docs/community/backlog.md, the
  -- parked bucket, and the "Attendance-blocked" line on COMM-P01.
  v_w_class          constant numeric := 6;
  v_class_connection constant numeric := 0;   -- always 0 until COMM-P01 lands

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
  -- COMM-P01. my_classes needs an attendance source and has none, so it
  -- answers empty rather than quietly answering something else. The client
  -- renders that chip disabled; this is the server half of the same parking.
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
      -- Relationship and author role depend on the author, not the post, so
      -- they resolve once per distinct author instead of once per row.
      authors as (
        select distinct c.aid as aid from cand c where c.aid is not null
      ),
      author_facts as (
        select a.aid as aid,
               -- COMM-301. Was an inline case/exists block here; identical
               -- arithmetic, same anchor, one copy.
               public.relationship_score(v_uid, a.aid, v_anchor) as rel_value,
               (exists (select 1 from public.invite_redemptions ir
                        where ir.user_id = a.aid and public.role_rank(ir.role) >= 20)
                or exists (select 1 from public.profiles pf
                           where pf.id = a.aid and pf.is_admin and pf.deleted_at is null)
               ) as author_is_staff
        from authors a
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
               -- COMM-P01. Structurally present, multiplied by zero.
               + v_w_class * v_class_connection
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

-- people_suggestions (COMM-232, 202608290015) is deliberately NOT touched.
-- It answers a different question - "who should this member start following"
-- - and its shipped, tested priority order is challenge, then interaction,
-- then event. relationship_score answers "how close is this pair already",
-- which is the opposite end: a high relationship_score is a reason NOT to
-- suggest someone. Folding one into the other would change COMM-232's
-- ordering rule, which 0034 pins. See COMM-301's own scope boundary.

commit;
