begin;

-- Launch-readiness audit, finding 1, part 2: the SECURITY DEFINER read
-- functions the same anonymous session was still reading everything through.
--
-- 202609060001 put is_community_member() on profiles_read_authenticated,
-- posts_feed_select and announcements_read - the three relations the audit
-- sampled. Re-probing a ghost session against the fixed stack, the way that
-- migration's own instructions asked for ("verify with a real
-- anonymous-session probe before and after"), showed the fix was HALF DONE:
--
--   public.feed_page(null, 20, 'for_you')  ->  8 rows, the whole club feed
--   public.community_search('member', 10)  ->  members, posts and events
--   public.community_profile(<any uuid>)   ->  a complete member profile,
--                                              posts and achievements included
--   public.club_summary()                  ->  club name and member_count
--   public.member_roles(array[<uuid>])     ->  who is a coach
--
-- WHY THE POLICIES DID NOT COVER THESE. All five are SECURITY DEFINER, so
-- they read their base tables with the owner's rights and RLS never runs.
-- That is the whole point of them - feed_page has to score across posts one
-- at a time that the viewer may not be able to read one at a time - and it
-- means every access rule has to be re-stated inside the function. Each of
-- these five re-stated exactly one: `if auth.uid() is null then raise
-- exception 'not authorized'`. An anonymous sign-in session HAS an
-- auth.uid(). That check has never meant "a member"; it means "somebody sent
-- a token", and since anonymous sign-in was enabled anyone can obtain one in
-- a single unauthenticated request.
--
-- WHY THESE FIVE AND NOT ALL SEVENTY-ODD DEFINER FUNCTIONS. Every other
-- client-callable definer read was probed as a ghost in the same pass and
-- already refuses: people_suggestions, feed_leaderboard,
-- attendance_classmates_today, chal_progress, coach_* and admin_* all resolve
-- my_role_code() first, which is null for a caller with no profile row, so
-- they raise 'not authorized' already. my_permissions() returns nothing for
-- the same reason. These five were the ones that only ever checked for a
-- token.
--
-- THE GATE IS ONE LINE PER FUNCTION, inserted immediately after the existing
-- auth.uid() check and nowhere else:
--
--   if not public.is_community_member() then raise exception 'recovery method required'; end if;
--
-- Same predicate, same message, and the same position every write path in
-- this module already puts it in (post_create, add_post_comment, report,
-- ach_claim, event_rsvp ...). A member mid-onboarding cannot reach any of
-- these five: renderCommunityApp() returns the COMM-016 recovery card and
-- nothing else while recovery_verified_at is null, and
-- ensureCommunityDataLoaded() - which is the ONLY caller of loadFeed(),
-- loadClubSummary() and the role cache - refuses to run until it is stamped.
--
-- THE BODIES BELOW ARE NOT RETYPED. Each was read back out of the live
-- database with pg_get_functiondef() and re-emitted with that single line
-- added, so nothing else can have drifted in transcription. That is the same
-- full-recreation-with-one-added-gate shape 202609010012 used when it added
-- club_feature_enabled() to feed_leaderboard, and it is the only mechanism
-- Postgres offers - a function body cannot be patched in place.
--
-- member_roles() is the exception to the shape: it is four lines of SQL with
-- no auth check at all, so the predicate goes in its WHERE clause rather
-- than in a preceding statement, and it returns an empty set rather than
-- raising. That matches how the client uses it (a best-effort badge cache,
-- 202609010011) - it has always tolerated a missing row and must not start
-- throwing.

-- =====================================================================
-- feed_page(p_cursor text, p_limit integer, p_scope text)
-- =====================================================================
-- The one that mattered most: this IS the club feed, and a ghost session got
-- all eight of the fixture's posts out of it with every author's handle,
-- display name and avatar attached. Verified before and after.
CREATE OR REPLACE FUNCTION public.feed_page(p_cursor text DEFAULT NULL::text, p_limit integer DEFAULT 20, p_scope text DEFAULT 'for_you'::text)
 RETURNS TABLE(id uuid, post_type post_type, author_id uuid, author jsonb, body text, title text, result_text text, occurred_on date, visibility post_visibility, created_at timestamp with time zone, published_at timestamp with time zone, metadata jsonb, media jsonb, reaction_count integer, comment_count integer, feed_score numeric, next_cursor text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  -- =========================================================================
  -- SCORING WEIGHTS. This block is the only place any of them appear.
  -- Every component is normalised to 0..1 first and then multiplied by its
  -- weight here, so a weight is directly comparable to every other weight
  -- and tuning one is a one-line change with no other arithmetic to redo.
  -- The positive weights sum to 110. Nothing depends on that number, it is
  -- only there so they read as rough percentages.
  --
  -- IT SAID 104 UNTIL NOW, and that had been wrong since 202608310003. The
  -- 104 was the seven live weights while v_w_class was declared at 6 and
  -- multiplied by a hard 0; COMM-302 turned that component on and left the
  -- comment behind. Corrected here rather than acted on: NO WEIGHT MOVES IN
  -- THIS MIGRATION. Renormalising the block back down to 104 would change
  -- every existing feed score on deploy day, which is the one thing COMM-303
  -- must not do.
  --
  -- COMM-303. These eight are no longer `constant`: they are the DEFAULTS,
  -- and the section marked "per-user weights" in the body below may replace
  -- each of them with this member's own resolved weight before the scoring
  -- query runs. What it may not do is change their total - a personalized
  -- set sums to exactly what this block sums to, so personalization moves
  -- emphasis between components and never inflates the score. That total is
  -- computed from these values at call time and is nowhere hardcoded, so the
  -- next retune of any weight here needs no second edit anywhere.
  -- =========================================================================
  v_w_recency        numeric := 40;  -- how fresh the post is
  v_w_relationship   numeric := 18;  -- who the author is to the viewer
  v_w_coach          numeric := 10;  -- coach voice carries further
  v_w_achievement    numeric := 8;   -- PRs, achievements, milestones
  v_w_challenge      numeric := 6;   -- challenge and event content
  v_w_engagement     numeric := 10;  -- what the club already did with it
  v_w_personal       numeric := 12;  -- it is about, or involves, the viewer
  -- COMM-302, closing COMM-P01. This weight was reserved and multiplied by a
  -- hard 0 from 202608280019 until now, so that wiring an attendance source
  -- would be a value change here and nothing else. It is: the value now comes
  -- from public.classmate_day_counts(), normalised below. The weight itself
  -- has not moved. COMM-303 personalizes it exactly like the other seven -
  -- it is not special-cased as immovable, so a member who trains with the
  -- same people every week can have the class component carry more of their
  -- ranking than the club default gives it.
  v_w_class          numeric := 6;   -- the viewer and the author train together

  -- COMM-303. The defaults above, packed for feed_weights_resolve(). Built
  -- in the body from the eight variables themselves, so this is not a second
  -- copy of the numbers.
  v_w_defaults jsonb;
  v_weights    jsonb;

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
  if not public.is_community_member() then raise exception 'recovery method required'; end if;

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

  -- --- per-user weights (COMM-303) ---------------------------------------
  -- The eight defaults out, this member's eight resolved weights back. For a
  -- member with no member_feed_weights row - which is every member today,
  -- since nothing writes that table yet - feed_weights_resolve returns the
  -- object it was handed, so the unpack below reads each weight straight back
  -- out of the object the line above put it into and every score in this page
  -- is the one 202608310003 would have produced.
  --
  -- Placed HERE, after the auth check and after the parked my_classes scope
  -- has already returned, and before anything is scored: one lookup per feed
  -- request, never one per candidate row or one per page of a session. The
  -- weights are then fixed for the whole call, exactly like v_anchor, so
  -- diversity, the repetition penalty and the cursor all see one weight set.
  --
  -- This function is definer, so this reads past member_feed_weights_self_select
  -- - but only ever for v_uid, which is the one row that policy would have
  -- granted the caller anyway.
  v_w_defaults := jsonb_build_object(
    'recency',      v_w_recency,
    'relationship', v_w_relationship,
    'coach',        v_w_coach,
    'achievement',  v_w_achievement,
    'challenge',    v_w_challenge,
    'engagement',   v_w_engagement,
    'personal',     v_w_personal,
    'class',        v_w_class);
  v_weights := coalesce(public.feed_weights_resolve(v_uid, v_w_defaults), v_w_defaults);
  if jsonb_typeof(v_weights) <> 'object' then v_weights := v_w_defaults; end if;

  -- Each coalesce leaves that weight at its default if the key is missing,
  -- so a short object costs a component its personalization rather than
  -- turning every score on the page null.
  v_w_recency      := coalesce((v_weights ->> 'recency')::numeric,      v_w_recency);
  v_w_relationship := coalesce((v_weights ->> 'relationship')::numeric, v_w_relationship);
  v_w_coach        := coalesce((v_weights ->> 'coach')::numeric,        v_w_coach);
  v_w_achievement  := coalesce((v_weights ->> 'achievement')::numeric,  v_w_achievement);
  v_w_challenge    := coalesce((v_weights ->> 'challenge')::numeric,    v_w_challenge);
  v_w_engagement   := coalesce((v_weights ->> 'engagement')::numeric,   v_w_engagement);
  v_w_personal     := coalesce((v_weights ->> 'personal')::numeric,     v_w_personal);
  v_w_class        := coalesce((v_weights ->> 'class')::numeric,        v_w_class);

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
end $function$;
revoke all on function public.feed_page(text, integer, text) from public, anon;
grant execute on function public.feed_page(text, integer, text) to authenticated;

-- =====================================================================
-- community_search(p_query text, p_limit integer)
-- =====================================================================
-- Three groups in one call - members, events, challenges - so a two-letter
-- query enumerated the club's directory. It is also what the Directory
-- sub-tab's roster box reads (searchDirectory, cloud.js).
CREATE OR REPLACE FUNCTION public.community_search(p_query text, p_limit integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := auth.uid();
  v_q text;
  v_limit int;
  v_pattern text;
  v_members jsonb;
  v_events jsonb;
  v_challenges jsonb;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;

  -- Same sanitization searchPeople (cloud.js) already does client-side
  -- before building its ilike pattern: strip %, _, comma and parens so a
  -- raw query cannot turn into an unintended wildcard or break the
  -- concatenated pattern. Replicated here because this function receives
  -- the raw string over RPC, not the client's already-sanitized copy.
  v_q := btrim(regexp_replace(coalesce(p_query, ''), '[%_,()]', '', 'g'));
  v_limit := greatest(1, least(coalesce(p_limit, 10), 50));

  -- Matches searchPeople's existing client-side threshold: under 2
  -- characters is empty results, not a query, and not an error.
  if char_length(v_q) < 2 then
    return jsonb_build_object(
      'members', '[]'::jsonb,
      'events', '[]'::jsonb,
      'challenges', '[]'::jsonb
    );
  end if;

  v_pattern := '%' || v_q || '%';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id,
    'handle', m.handle,
    'display_name', m.display_name,
    'bio', m.bio,
    'avatar_url', m.avatar_url,
    'allow_follows', m.allow_follows
  )), '[]'::jsonb)
  into v_members
  from (
    select p.id, p.handle, p.display_name, p.bio, p.avatar_url, p.allow_follows
    from public.profiles p
    where p.deleted_at is null
      and p.id <> v_uid
      and (p.handle ilike v_pattern or p.display_name ilike v_pattern)
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = v_uid and b.blocked_id = p.id)
           or (b.blocker_id = p.id and b.blocked_id = v_uid)
      )
      and (p.visible_to_club or public.is_admin())
    order by p.display_name nulls last, p.handle
    limit v_limit
  ) m;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ev.id,
    'title', ev.title,
    'event_type', ev.event_type,
    'status', ev.status,
    'start_at', ev.start_at
  )), '[]'::jsonb)
  into v_events
  from (
    select e.id, e.title, e.event_type, e.status, e.start_at
    from public.events e
    where e.title ilike v_pattern
      and (
        e.status <> 'draft'
        or e.created_by = v_uid
        or public.has_perm('community.event.manage')
      )
    order by e.start_at asc
    limit v_limit
  ) ev;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'title', c.title,
    'challenge_type', c.challenge_type,
    'status', c.status,
    'start_at', c.start_at,
    'end_at', c.end_at
  )), '[]'::jsonb)
  into v_challenges
  from (
    select ch.id, ch.title, ch.challenge_type, ch.status, ch.start_at, ch.end_at
    from public.challenges ch
    where ch.title ilike v_pattern
      and (
        ch.status <> 'draft'
        or ch.created_by = v_uid
        or public.has_perm('community.challenge.create')
      )
    order by ch.end_at desc
    limit v_limit
  ) c;

  return jsonb_build_object('members', v_members, 'events', v_events, 'challenges', v_challenges);
end $function$;
revoke all on function public.community_search(text, integer) from public, anon;
grant execute on function public.community_search(text, integer) to authenticated;

-- =====================================================================
-- community_profile(user_id uuid)
-- =====================================================================
-- A whole member: handle, display name, avatar, tenure, follower counts,
-- recent posts, achievements. Its SECOND 'not authorized' (the visible_to_club
-- branch, further down) is untouched - that one answers a different question
-- and already worked.
--
-- THE ONE OF THE FIVE WITH A SELF BRANCH, and it is placed with the same
-- reasoning 202609060001 used on profiles_read_authenticated: reading your
-- OWN row is outside the gate. The gate is therefore two lines here rather
-- than one, and sits after v_target is resolved rather than before it,
-- because "is this me" cannot be asked until the coalesce has run (a null
-- p_user_id means "my own profile" and always has).
--
-- This is not a hole. A ghost session HAS no profile row, so asking for its
-- own gets 'profile not found' - one line further down and unchanged. What
-- the branch actually protects is the mid-onboarding member, and there is a
-- shipped assertion depending on it: 0040 has a caller with their own
-- show_attendance off reading their own current_streak back, which is the
-- self-exemption rule this whole module keeps ("opting out removes you from
-- other members' boards, never from your own").
CREATE OR REPLACE FUNCTION public.community_profile(user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if v_target <> v_uid and not public.is_community_member() then
    raise exception 'recovery method required';
  end if;

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
end $function$;
revoke all on function public.community_profile(uuid) from public, anon;
grant execute on function public.community_profile(uuid) to authenticated;

-- =====================================================================
-- club_summary()
-- =====================================================================
-- The smallest of the five and included for consistency rather than urgency:
-- club name, image, member_count and the active challenge. member_count is a
-- club statistic, and none of it is one of the three surfaces the security
-- review deliberately left open (those are intro_carousel_content,
-- onboarding_step_content and club_features, which carry no member data at
-- all). Its only caller is loadClubSummary(), inside
-- ensureCommunityDataLoaded(), which never runs before recovery is stamped.
CREATE OR REPLACE FUNCTION public.club_summary()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid;
  v_club public.clubs;
  v_members integer;
  v_challenge jsonb;
  v_unread integer;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;

  select * into v_club from public.clubs c where c.id = public.default_club_id();
  -- Definer, so this is the real member count and not "everyone this viewer
  -- has not blocked", which is what a client-side count through
  -- profiles_read_authenticated would have produced.
  select count(*)::integer into v_members from public.profiles p where p.deleted_at is null;

  select jsonb_build_object('id', c.id, 'title', c.title, 'source', 'challenge', 'ends_at', c.end_at)
    into v_challenge
  from public.challenges c
  where c.status = 'active' and now() >= c.start_at and now() <= c.end_at
  order by c.end_at asc
  limit 1;
  -- challenges is Phase 2 (COMM-201) and is empty today, so the current
  -- weekly challenge is the fallback and is what actually renders in V1.
  if v_challenge is null then
    select jsonb_build_object('id', w.id, 'title', w.title, 'source', 'weekly', 'ends_at', w.ends_on)
      into v_challenge
    from public.weekly_challenges w
    where current_date >= w.starts_on and current_date <= w.ends_on
    order by w.ends_on asc
    limit 1;
  end if;

  select count(*)::integer into v_unread
  from public.notifications n where n.user_id = v_uid and n.read_at is null;

  return jsonb_build_object(
    'name', coalesce(v_club.name, ''),
    -- TODO COMM-115: clubs has no image column. The mark reads
    -- settings->>'image_url' when an admin has set one and the client falls
    -- back to a lettermark. Promote it to a real column when club branding
    -- gets its own ticket rather than inventing one here.
    'image_url', v_club.settings ->> 'image_url',
    'member_count', coalesce(v_members, 0),
    'active_challenge', v_challenge,
    'unread_notifications', coalesce(v_unread, 0)
  );
end $function$;
revoke all on function public.club_summary() from public, anon;
grant execute on function public.club_summary() to authenticated;

-- member_roles(uuid[]): the predicate lives in the WHERE clause. Empty set,
-- not an exception - see the header.
create or replace function public.member_roles(p_ids uuid[])
returns table(user_id uuid, role text)
language sql stable security definer set search_path = '' as $$
  select ir.user_id, ir.role
  from public.invite_redemptions ir
  where ir.user_id = any(coalesce(p_ids, array[]::uuid[]))
    and public.is_community_member();
$$;
revoke all on function public.member_roles(uuid[]) from public, anon;
grant execute on function public.member_roles(uuid[]) to authenticated;

commit;
