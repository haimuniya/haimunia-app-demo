begin;

-- COMM-315, schema half. Member of the week, rotating across a fixed,
-- named set of recognition categories.
--
-- WHAT LANDS HERE
--   * public.member_of_week                       table + RLS (read-only client surface)
--   * public.member_of_week_category(date)        the rotation rule, on its own
--   * public.member_of_week_candidates(date)      staff read, suggestions only
--   * public.member_of_week_publish(date, uuid, text) staff write, the only writer
--   * one new admin_actions.action_type label, 'member_of_week_publish'
--
-- The ticket confirmed the category set with the user on 2026-08-31 and
-- left four things to this implementation. Each one is decided below, in
-- the open, rather than left ambiguous:
--
--   1. HOW THE ROTATION INDEX IS DERIVED  -> section 1
--   2. WHICH POST PATTERN PUBLISHING USES -> section 5, "THE POST"
--   3. WHAT A NON-CANDIDATE PICK MEANS    -> section 5, "CATEGORY RESOLUTION"
--   4. WHERE THE PRIVACY LINE SITS        -> section 3, "PRIVACY" and
--                                            section 5, "VISIBLE TO CLUB"

-- =====================================================================
-- 0. admin_actions gains one action_type label
-- =====================================================================
-- 202608280002 pinned action_type to a closed list and no migration has
-- widened it since. member_of_week_publish writes an audit row (COMM-315
-- says so in as many words) and none of the eleven existing labels
-- describes it: reusing 'achievement_edit' or 'privacy_config' would make
-- the audit log lie about what happened, which is the one thing an audit
-- log may not do. So the list gains a twelfth label and nothing else about
-- the table moves.
--
-- target_type is NOT widened: 'member' already exists and is exactly right
-- - the subject of the action is the member being recognised.
alter table public.admin_actions drop constraint if exists admin_actions_action_type_check;
alter table public.admin_actions add constraint admin_actions_action_type_check check (action_type in (
  'content_delete', 'content_hide', 'member_restrict', 'member_unrestrict',
  'role_change', 'challenge_edit', 'achievement_edit', 'privacy_config',
  'content_pin', 'content_unpin', 'report_review',
  -- COMM-315.
  'member_of_week_publish'
));

-- =====================================================================
-- 1. member_of_week_category(p_week_start date) - THE ROTATION RULE
-- =====================================================================
-- COMM-315: "cycling one category per week in a stated order, not randomly
-- - a stated order is auditable and repeatable, a random one is not." This
-- function is the whole of that statement, in one place, so the suggestion
-- side and the publish side can never disagree about whose week it is.
--
-- THE ORDER, fixed, in this order:
--     0  consistency_streak
--     1  most_prs
--     2  challenge_completion
--     3  coachs_pick
--
-- THE INDEX: whole weeks elapsed since a fixed epoch Monday, modulo 4.
--
--     index = ((week_start - 2026-01-05) / 7) mod 4
--
-- 2026-01-05 is a Monday (ISO week 1 of 2026) and is the epoch only
-- because a cycle has to start somewhere; nothing about it is magic and
-- moving it rotates the whole calendar by a fixed offset.
--
-- WHY NOT "ISO WEEK NUMBER MOD 4", which the ticket offers as an example.
-- Because it is not actually a cycle. An ISO year has 52 or 53 weeks, so
-- at every 53-week year the sequence runs ... week 52 (index 0), week 53
-- (index 1), then week 1 of the next year (index 1 again) - the same
-- category two weeks running, roughly every five or six years, silently.
-- "A member cannot be picked two weeks in a row" is a rule this ticket
-- takes seriously; a category quietly repeating two weeks in a row would
-- undercut the same intent, and it would do it on a schedule nobody
-- reading the code would predict. Counting weeks from a fixed Monday has
-- no year boundary in it at all: week N and week N+1 are always adjacent
-- indices, forever, in both directions.
--
-- The modulo is written ((x % 4) + 4) % 4 rather than mod(x, 4) because
-- Postgres's % keeps the sign of the dividend, so a week BEFORE the epoch
-- would otherwise come back as a negative index and hit the else branch.
-- Dates before 2026-01-05 are a real input: a test fixture, a backfill, or
-- simply a club that starts using this in a year the epoch is behind.
--
-- IMMUTABLE and calendar-only. It reads no table, so it leaks nothing and
-- needs no auth check; `authenticated` may call it because a client that
-- wants to label next week's category should not have to re-derive this
-- rule in JavaScript and get it subtly wrong.
create or replace function public.member_of_week_category(p_week_start date)
returns text
language sql immutable set search_path = '' as $$
  select case ((((p_week_start - date '2026-01-05') / 7) % 4) + 4) % 4
    when 0 then 'consistency_streak'
    when 1 then 'most_prs'
    when 2 then 'challenge_completion'
    when 3 then 'coachs_pick'
  end;
$$;

revoke all on function public.member_of_week_category(date) from public, anon;
grant execute on function public.member_of_week_category(date) to authenticated;

comment on function public.member_of_week_category(date) is
  'COMM-315 rotation rule, and the only copy of it. Returns the recognition category for the ISO week starting p_week_start, cycling consistency_streak -> most_prs -> challenge_completion -> coachs_pick, one per week, in that fixed order. The index is whole weeks since the epoch Monday 2026-01-05, modulo 4 - not the ISO week number, which repeats an index across every 53-week year boundary. Immutable, reads no table, deterministic for every date including dates before the epoch.';

-- The Hebrew label for each category, kept beside the rule rather than in
-- the client, so the suggestion card, the published post and any later
-- surface all name the same category the same way.
create or replace function public.member_of_week_category_label(p_category text)
returns text
language sql immutable set search_path = '' as $$
  select case p_category
    when 'consistency_streak'    then 'עקביות באימונים'
    when 'most_prs'              then 'שיאים אישיים השבוע'
    when 'challenge_completion'  then 'השלמת אתגר'
    when 'coachs_pick'           then 'בחירת המאמן/ת'
    else ''
  end;
$$;

revoke all on function public.member_of_week_category_label(text) from public, anon;
grant execute on function public.member_of_week_category_label(text) to authenticated;

comment on function public.member_of_week_category_label(text) is
  'COMM-315. The Hebrew display label for a member_of_week category code. Immutable, reads no table. Kept in the database rather than the client so the suggestion card and the published post name the category identically.';

-- =====================================================================
-- 2. member_of_week - the table
-- =====================================================================
-- One row per published week. A row exists only after a staff member
-- published it: there is no draft state and no unpublished row, which is
-- why published_at is NOT NULL with a default rather than a nullable stamp
-- the way COMM-309's monthly recap plans it. A generated draft here is not
-- a row, it is what member_of_week_candidates() returns.
create table if not exists public.member_of_week (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null default public.default_club_id() references public.clubs(id),

  -- The Monday of the ISO week being recognised. The CHECK is the same
  -- load-bearing one weekly_recaps (202608290011) carries and for the same
  -- reason: the unique key below is what makes "one publish per week" true,
  -- and a key on a free-form date is only unique per date, not per week.
  -- Both functions normalise their input to a Monday before they get here,
  -- so this constraint is a backstop against a future direct writer rather
  -- than something a client can trip.
  week_start date not null check (extract(isodow from week_start) = 1),

  -- The rotation category this week was published under. Stored rather
  -- than re-derived on read, because the category a human actually chose
  -- is a historical fact: it can be 'coachs_pick' on a week whose rotation
  -- said something else (see member_of_week_publish), and re-deriving
  -- would silently rewrite the past if the rotation rule is ever re-tuned.
  category text not null check (category in (
    'consistency_streak', 'most_prs', 'challenge_completion', 'coachs_pick'
  )),

  user_id uuid not null references public.profiles(id) on delete cascade,

  -- Same 500-char shape member_contact_log.note and challenge_progress.note
  -- already use. Defaults to '' so a computed-category publish with no
  -- typed reason is a real, honest row rather than a null.
  reason text not null default '' check (char_length(reason) <= 500),

  -- The celebratory post. Nullable so a deleted post does not take the
  -- recognition record with it; ON DELETE SET NULL rather than CASCADE for
  -- the same reason.
  post_id uuid references public.workout_posts(id) on delete set null,

  published_by uuid references public.profiles(id) on delete set null,
  published_at timestamptz not null default now(),

  -- ONE PUBLISH PER WEEK. This is the hard half of COMM-315's "a second
  -- call for a week already published updates nothing and raises";
  -- member_of_week_publish checks and raises a readable error first, and
  -- this constraint is what makes the rule true even if some future writer
  -- forgets to check.
  --
  -- Deliberately keyed on week_start alone, exactly as the ticket's
  -- migration outline writes it, and NOT on (club_id, week_start). club_id
  -- is provenance here, the same as it is on weekly_recaps, challenges and
  -- challenge_progress - none of which carry it in a unique key either. The
  -- module is single-club today (`default_club_id()`), so the two are the
  -- same constraint; the day a second club exists this becomes
  -- (club_id, week_start) in a new migration, along with the same change on
  -- every other table in the module. Doing it here alone would be one table
  -- disagreeing with the rest for no benefit anyone can observe.
  constraint member_of_week_week_key unique (week_start)
);

create index if not exists member_of_week_recent_idx
  on public.member_of_week(week_start desc);
-- Serves the two-consecutive-weeks lookup, which asks for one member and
-- one specific week.
create index if not exists member_of_week_user_idx
  on public.member_of_week(user_id, week_start desc);

alter table public.member_of_week enable row level security;

-- The `pins` shape (202608280017), for the same two reasons. SELECT only,
-- open to every signed-in member: a published member of the week is the
-- most public thing in the club, which is the point of it. And NO write
-- grant and no write policy at all - not for staff, not for an admin, not
-- for the owner. member_of_week_publish() is the only writer, and it is
-- what enforces the consecutive-week refusal, the once-per-week refusal,
-- the category resolution and the admin_actions row. Handing staff a direct
-- INSERT would make every one of those four depend on the client behaving.
revoke all on public.member_of_week from public, anon;
grant select on public.member_of_week to authenticated;

create policy member_of_week_read on public.member_of_week for select to authenticated
  using (true);

comment on table public.member_of_week is
  'COMM-315. One row per published week of member-of-the-week recognition. Club-wide readable by any authenticated member (a published celebration is public by construction); no client write grant and no write policy of any kind - public.member_of_week_publish() is the only writer, the same shape public.pins uses. week_start is the Monday of the ISO week and is unique, which is the once-per-week rule. category is stored, not re-derived, because it records what was actually published.';

comment on column public.member_of_week.category is
  'The rotation category this week was published under, one of consistency_streak, most_prs, challenge_completion, coachs_pick. Usually equals member_of_week_category(week_start); it is coachs_pick instead whenever staff published somebody the week''s computed candidate list did not contain, which is COMM-315''s stated "staff can fall back to coach''s pick" empty state.';

-- =====================================================================
-- 3. Internal: the computed candidate sets
-- =====================================================================
-- Split out of member_of_week_candidates() so that member_of_week_publish()
-- can ask the identical question when it resolves the category, instead of
-- keeping a second copy of three queries that would drift. One rule, two
-- readers - the same reasoning consistency_week_streaks() (202608290015)
-- gives for existing as its own function.
--
-- SECURITY INVOKER with no grant to anybody: internal plumbing, not an API.
-- Called from the two definer functions below it runs with the migration
-- owner's rights, which is how it reads across workout_posts and
-- challenge_participants; called from anywhere else it cannot be called at
-- all. Note that the privacy helpers it calls - can_view_profile_field()
-- and post_visible_to_viewer() - resolve against auth.uid(), which is still
-- the real staff caller inside a definer function, so the toggles below are
-- answered about the coach who asked and not about the function's owner.
--
-- PRIVACY. Every branch is filtered through the subject member's own toggle
-- before they can be a candidate, which is coach_celebrate_feed's rule
-- (202608290013) - "surfaces what a coach could already see" - applied to
-- the toggle this schema had already picked for each kind of item:
--
--   consistency_streak    in_leaderboards (plus visible_to_club and
--                         show_attendance, inherited whole from
--                         feed_leaderboard, see below)
--   most_prs              show_prs, plus post_visible_to_viewer() on each
--                         counted post, exactly as coach_celebrate_feed's
--                         PR branch does it
--   challenge_completion  in_leaderboards, exactly as
--                         coach_celebrate_feed's completion branch does it
--
-- ONE ADDITION BEYOND THAT PATTERN, stated because it is an addition: every
-- branch ALSO requires the relevant toggles to be true read from the RAW
-- COLUMN, on top of the can_view_profile_field() call, never instead of it:
--
--   consistency_streak    visible_to_club and in_leaderboards and
--                         show_attendance
--   most_prs              visible_to_club and show_prs
--   challenge_completion  visible_to_club and in_leaderboards
--
-- The two questions differ deliberately. can_view_profile_field() answers
-- "may this coach see this?" - it settles block edges in both directions,
-- returns true for the caller's own row, and, the part that matters here,
-- SHORT-CIRCUITS TO TRUE FOR AN ADMIN before it consults any toggle
-- (202608280003). That is the right question for a dashboard row a coach
-- reads, which is all Celebrate is, and the admin short-circuit is the
-- module-wide behaviour of that resolution point rather than anything this
-- ticket should fight.
--
-- It is the wrong question on its own here, because a candidate is a
-- suggestion the caller is about to BROADCAST to the whole club. Read
-- through the helper alone, an ADMIN would be offered - and could publish -
-- a "most PRs this week" celebration of a member who keeps their PRs
-- private, or a consistency celebration of a member who opted out of
-- leaderboards. A member's own toggle has to outrank the caller's rank when
-- the output is a club-wide post. So both are asked: the helper for the
-- blocks and the coach's own view, the columns for the member's actual
-- choice. Keeping the helper call as well is what preserves the block rule
-- and coach_celebrate_feed's shape; adding the columns is what makes the
-- rule "never publish past a toggle" true for every rank.
--
-- member_of_week_publish() enforces visible_to_club again at write time, so
-- a free coach's pick - which by definition is not on any shortlist - is
-- covered by the same rule.
create or replace function public.member_of_week_candidate_set(
  p_category text,
  p_week_start date,
  p_limit int default 3
) returns table (user_id uuid, value numeric, detail jsonb)
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_prev uuid;
begin
  -- The member recognised last week is filtered out of the suggestions as
  -- well as refused at publish. The refusal in member_of_week_publish() is
  -- the rule; this is the courtesy that stops a coach being shown a name
  -- the server is about to reject.
  select m.user_id into v_prev
  from public.member_of_week m
  where m.week_start = p_week_start - 7;

  if p_category = 'consistency_streak' then
    -- COMM-315 names feed_leaderboard's consistency mode as the source and
    -- this calls it rather than re-deriving it, so the member of the week
    -- and the board the club can already see never disagree about who is
    -- most consistent. That also means this branch inherits all three of
    -- the board's gates - in_leaderboards, visible_to_club and (since
    -- COMM-306) show_attendance - which is strictly narrower than the
    -- in_leaderboards the ticket asks for, and correctly so: the value
    -- being surfaced IS attendance-derived.
    --
    -- KNOWN LIMITATION, flagged rather than hidden: feed_leaderboard's
    -- consistency mode reports the streak AS OF NOW. It takes no as-of
    -- date and consistency_week_streaks() anchors on current_date, so
    -- asking for a past week returns today's streaks, not that week's.
    -- For the intended use - staff publishing the current or the just-ended
    -- week - the two are the same. Publishing a months-old week under this
    -- category would credit a present-day streak, and there is no existing
    -- function that could answer otherwise without COMM-306's arithmetic
    -- growing an as-of parameter.
    return query
    select b.user_id, b.value, jsonb_build_object('streak_weeks', b.value::integer, 'rank', b.rank)
    from public.feed_leaderboard('consistency', null, 'club', 50) b
    join public.profiles p on p.id = b.user_id
    where b.value > 0
      and p.deleted_at is null
      -- The raw columns, on top of the three gates feed_leaderboard already
      -- applied through can_view_profile_field. Identical for a coach;
      -- for an ADMIN, this is the difference between "may I see it" and
      -- "may the club be told".
      and p.visible_to_club and p.in_leaderboards and p.show_attendance
      and (v_prev is null or b.user_id <> v_prev)
    order by b.rank
    limit p_limit;

  elsif p_category = 'most_prs' then
    -- A count of PR posts inside the week, keyed on the day the PR
    -- happened (occurred_on, falling back to the post's own date) the same
    -- way community_profile's PR block keys it, so a PR logged late still
    -- counts for the week it was set in.
    return query
    select q.uid, q.n::numeric, jsonb_build_object('pr_count', q.n::integer)
    from (
      select w.author_id as uid, count(*) as n,
             min(coalesce(nullif(btrim(pr.display_name), ''), pr.handle)) as name
      from public.workout_posts w
      join public.profiles pr on pr.id = w.author_id
      where w.post_type = 'POST_PR'
        and w.deleted_at is null
        and w.status = 'active'
        and w.author_id is not null
        and coalesce(w.occurred_on, w.created_at::date) between p_week_start and p_week_start + 6
        and pr.deleted_at is null
        and pr.visible_to_club and pr.show_prs
        and public.can_view_profile_field(w.author_id, 'show_prs')
        and public.post_visible_to_viewer(w.id)
        and (v_prev is null or w.author_id <> v_prev)
      group by w.author_id
    ) q
    -- Ties are broken by name and then by id so the order is total and the
    -- same call twice returns the same list. There is no tenure tie-break
    -- here on purpose: the leaderboard's tie-break is part of a ranking
    -- members can see, whereas this is a three-name shortlist for a human
    -- who is about to choose from it anyway.
    order by q.n desc, q.name asc, q.uid asc
    limit p_limit;

  elsif p_category = 'challenge_completion' then
    return query
    select q.uid, q.n::numeric, jsonb_build_object('completions', q.n::integer, 'titles', q.titles)
    from (
      select cp.user_id as uid, count(*) as n,
             jsonb_agg(c.title order by cp.completed_at) as titles,
             min(coalesce(nullif(btrim(pr.display_name), ''), pr.handle)) as name
      from public.challenge_participants cp
      join public.challenges c on c.id = cp.challenge_id
      join public.profiles pr on pr.id = cp.user_id
      where cp.completed_at is not null
        and cp.completed_at::date between p_week_start and p_week_start + 6
        and cp.status <> 'withdrawn'
        and c.status <> 'draft'
        and pr.deleted_at is null
        and pr.visible_to_club and pr.in_leaderboards
        and public.can_view_profile_field(cp.user_id, 'in_leaderboards')
        and (v_prev is null or cp.user_id <> v_prev)
      group by cp.user_id
    ) q
    order by q.n desc, q.name asc, q.uid asc
    limit p_limit;
  end if;

  -- 'coachs_pick' falls through and returns nothing. That is not an empty
  -- result, it is the category's definition: a free staff selection among
  -- any member, with no computed shortlist to narrow it.
  return;
end $$;

revoke all on function public.member_of_week_candidate_set(text, date, int)
  from public, anon, authenticated;

comment on function public.member_of_week_candidate_set(text, date, int) is
  'Internal. The computed candidate shortlist for one COMM-315 category in one ISO week: consistency_streak delegates to feed_leaderboard(''consistency''), most_prs counts POST_PR posts in the week, challenge_completion counts challenge_participants completions in the week, coachs_pick returns nothing by definition. Every branch applies the subject''s own privacy toggle through can_view_profile_field (in_leaderboards / show_prs, for the blocks and the coach''s own view) AND the same toggles read from the raw profiles columns plus visible_to_club - because can_view_profile_field short-circuits to true for an admin, and an admin''s rank governs what they may see, never what the club may be told. Also excludes the member recognised in the immediately prior week. No grants: only member_of_week_candidates() and member_of_week_publish() call it, and they call the same copy so a suggestion and a publish can never disagree.';

-- =====================================================================
-- 4. member_of_week_candidates(p_week_start) - COMM-315 staff read
-- =====================================================================
-- Staff-only, checked inline the way coach_celebrate_feed() and
-- coach_inactive_members() do it, so a non-staff caller is refused by the
-- database and not merely by a hidden nav item.
--
-- SUGGESTIONS, NEVER AUTO-PUBLISH. This function writes nothing. It is
-- `stable`. COMM-315 asks for COMM-309's "generated draft, staff publishes"
-- shape and this is the draft half; the club sees nothing until a human
-- calls member_of_week_publish().
--
-- ALWAYS EXACTLY ONE ROW, despite the `setof jsonb` return the ticket's
-- contract pins. The envelope carries the category as well as the
-- candidates because the empty state needs both: "no candidates this week
-- for THIS category" cannot be rendered from an empty set of rows. The
-- client reads data[0] and never has to join or compute anything - the
-- plain-shape rule for accumulator lookups.
create or replace function public.member_of_week_candidates(p_week_start date default null)
returns setof jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_week date;
  v_category text;
  v_prev uuid;
  v_published public.member_of_week;
  v_cands jsonb;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_staff() then raise exception 'not authorized'; end if;

  -- Null means "this week". Any other date is normalised to the Monday of
  -- its own ISO week rather than rejected: a client sending the Sunday a
  -- coach tapped in a date picker means the same week a human means, and
  -- turning that into an error toast helps nobody. The same normalisation
  -- runs in member_of_week_publish(), so the two always agree about which
  -- week is being talked about.
  v_week := date_trunc('week', coalesce(p_week_start, current_date)::timestamp)::date;
  v_category := public.member_of_week_category(v_week);

  select m.user_id into v_prev
  from public.member_of_week m where m.week_start = v_week - 7;

  select * into v_published
  from public.member_of_week m where m.week_start = v_week;

  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id',      c.user_id,
           'handle',       p.handle,
           'display_name', coalesce(nullif(btrim(p.display_name), ''), p.handle),
           'avatar_url',   p.avatar_url,
           'value',        c.value,
           'detail',       c.detail
         -- A total order, not just `value desc`: two members tied on the
         -- same count would otherwise come back in whatever order the plan
         -- happened to produce, and a suggestion list that reshuffles
         -- between two identical calls is not a list a coach can trust.
         ) order by c.value desc,
                    coalesce(nullif(btrim(p.display_name), ''), p.handle) asc,
                    c.user_id asc), '[]'::jsonb)
    into v_cands
  from public.member_of_week_candidate_set(v_category, v_week, 3) c
  join public.profiles p on p.id = c.user_id;

  return query select jsonb_build_object(
    'week_start',     v_week,
    'category',       v_category,
    'category_label', public.member_of_week_category_label(v_category),
    -- The client should not re-implement the rotation arithmetic to show
    -- "week 2 of 4"; it is cheap to send and it is the same number the
    -- rule used.
    'rotation_index', ((((v_week - date '2026-01-05') / 7) % 4) + 4) % 4,
    -- True only for coachs_pick. The client branches on this to swap the
    -- suggestion list for the free member-selection form rather than
    -- string-matching the category name.
    'free_selection', (v_category = 'coachs_pick'),
    -- Already published? Then the publish control is spent for this week.
    -- Sent as a small object rather than a bare boolean so the card can
    -- name who it was without a second round trip.
    'published',      case when v_published.id is null then null
                           else jsonb_build_object(
                             'id', v_published.id,
                             'user_id', v_published.user_id,
                             'category', v_published.category,
                             'reason', v_published.reason,
                             'post_id', v_published.post_id,
                             'published_at', v_published.published_at)
                      end,
    -- Last week's member, who member_of_week_publish() will refuse. Sent so
    -- the free-selection form can grey them out instead of letting a coach
    -- discover the rule by hitting it.
    'previous_week_user_id', v_prev,
    'candidates',     v_cands
  );
end $$;

revoke all on function public.member_of_week_candidates(date) from public, anon;
grant execute on function public.member_of_week_candidates(date) to authenticated;

comment on function public.member_of_week_candidates(date) is
  'COMM-315 member-of-the-week suggestions for one ISO week. Staff-only, is_staff() inline, raises not authorized otherwise. p_week_start null means the current week; any date is normalised to the Monday of its own ISO week. Returns EXACTLY ONE jsonb row: {week_start, category, category_label, rotation_index, free_selection, published, previous_week_user_id, candidates[]}, where candidates is at most 3 entries of {user_id, handle, display_name, avatar_url, value, detail} and is always [] for the coachs_pick week. Every candidate passes the subject''s own privacy toggle (in_leaderboards for streak and challenge, show_prs for PRs) plus the raw visible_to_club column, and last week''s member is excluded. Writes nothing: this is the draft half of COMM-309''s generated-draft/staff-publishes shape.';

-- =====================================================================
-- 5. member_of_week_publish(p_week_start, p_user_id, p_reason)
-- =====================================================================
-- The only writer of public.member_of_week, and the only producer of a
-- POST_ANNOUNCEMENT row anywhere in this schema.
--
-- THE POST. COMM-315 left the choice between an authorless
-- POST_ANNOUNCEMENT and COMM-225's comment-on-the-member's-card pattern
-- explicitly to the implementation, and required it be stated rather than
-- left ambiguous. This takes the authorless POST_ANNOUNCEMENT, for three
-- reasons:
--
--   1. COMM-225's pattern needs a card to comment ON. It branches on
--      Celebrate's `post_id`, which is non-null only for a PR. Three of the
--      four categories here have no source post at all - a consistency
--      streak is not a post, a challenge completion is not a post, and a
--      coach's pick is by definition not tied to anything the member
--      published. Choosing the comment pattern would mean it works for one
--      category in four and silently degrades for the rest, which is the
--      ambiguity the ticket asked to be resolved.
--   2. Member of the week is club voice, not a coach's reply. It names the
--      week, the category and the reason; it is an announcement about the
--      club's own recognition cycle, and rendering it under a particular
--      coach's face would make it read as one coach's opinion of a member.
--      author_id is therefore null, which 202608280004 made legal for
--      exactly this kind of row, and `published_by` on the member_of_week
--      row keeps the real accountability where an audit wants it.
--   3. The renderer already exists and already handles this. cloud.js's
--      renderAnnouncementPostCard reads `metadata.title` falling back to
--      `title`, and passes `authorless: !postAuthorName(post)` - so an
--      authorless POST_ANNOUNCEMENT renders correctly today, with no client
--      change, which is not true of any shape invented here. This is the
--      first producer POST_ANNOUNCEMENT has ever had.
--
-- CATEGORY RESOLUTION, and why there is no p_category parameter. The
-- signature is fixed by the ticket, so the category has to be derived. It
-- is derived by LOOKING: if p_user_id is in the week's computed candidate
-- shortlist, the row records the week's rotation category; if not, it
-- records 'coachs_pick'. That is not a fallback bolted on - it is exactly
-- what COMM-315's own empty state describes ("nobody logged a PR that week
-- ... staff can fall back to coach's pick"), expressed as a fact about who
-- was chosen rather than as a flag the client has to remember to send. A
-- coach who picks someone off the list gets the rotation's category; a
-- coach who picks anyone else has, by definition, made a coach's pick.
--
-- REASON. Trimmed, control characters stripped (the body reaches the club
-- feed, so post_create's normalisation applies here for the same reason it
-- applies there), then capped at 500 rather than rejected - "capped" is
-- what the ticket says. REQUIRED when the resolved category is
-- 'coachs_pick': a free selection with no stated reason publishes a name
-- and nothing else, and COMM-315 defines the category as a selection "with
-- a short reason staff types". The three computed categories carry their
-- own reason in the category itself, so an empty reason there is fine.
--
-- VISIBLE TO CLUB. Refused for a member whose `visible_to_club` is false,
-- read from the column and not through can_view_profile_field() - see the
-- note on member_of_week_candidate_set() for why the helper is the wrong
-- question here. This is the one refusal COMM-315 does not name, and it is
-- deliberate: publishing is broadcasting, and a member who removed
-- themselves from the club's view did not consent to being its headline.
-- Reverting it is deleting one `if`.
create or replace function public.member_of_week_publish(
  p_week_start date,
  p_user_id uuid,
  p_reason text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_week date;
  v_rotation text;
  v_category text;
  v_reason text;
  v_p public.profiles;
  v_name text;
  v_id uuid := gen_random_uuid();
  v_post_id uuid;
  v_label text;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_staff() then raise exception 'not authorized'; end if;
  if p_user_id is null then raise exception 'member required'; end if;

  -- Same normalisation member_of_week_candidates() applies, so a coach
  -- publishing the week they were just shown always lands on that week.
  -- Null means the current week, which is what a "publish" button with no
  -- date picker means.
  v_week := date_trunc('week', coalesce(p_week_start, current_date)::timestamp)::date;

  -- --- once per week ---------------------------------------------------
  -- Checked and raised before anything is written, so the caller gets
  -- 'week already published' rather than a raw 23505 from the unique
  -- constraint below it. The constraint still stands and is still the thing
  -- that makes the rule true; this is the readable error on top of it.
  -- Explicitly NOT an upsert: weekly_recaps upserts because a recap is a
  -- regenerated summary, whereas this is a public act of recognition that
  -- has already been posted to the feed, and quietly replacing it would
  -- leave the post naming one member and the row naming another.
  if exists (select 1 from public.member_of_week m where m.week_start = v_week) then
    raise exception 'week already published';
  end if;

  select * into v_p from public.profiles p
  where p.id = p_user_id and p.deleted_at is null;
  if not found then raise exception 'member not found'; end if;
  if not v_p.visible_to_club then
    raise exception 'member is not visible to the club';
  end if;

  -- --- no two weeks running --------------------------------------------
  -- A real refusal, not a suggestion-level nicety: the candidate list
  -- already hides last week's member, and this is what makes that true
  -- even for a coach's pick, a hand-written client call, or a week whose
  -- suggestions were never fetched at all.
  if exists (
    select 1 from public.member_of_week m
    where m.week_start = v_week - 7 and m.user_id = p_user_id
  ) then
    raise exception 'member was recognised last week';
  end if;

  -- --- category ---------------------------------------------------------
  v_rotation := public.member_of_week_category(v_week);
  if v_rotation <> 'coachs_pick' and exists (
    select 1 from public.member_of_week_candidate_set(v_rotation, v_week, 3) c
    where c.user_id = p_user_id
  ) then
    v_category := v_rotation;
  else
    v_category := 'coachs_pick';
  end if;

  -- --- reason -----------------------------------------------------------
  -- The same control-character class post_create strips: 0x01-0x08 and
  -- 0x0B-0x1F, keeping tab and newline, built with chr() so it does not
  -- depend on the database LC_CTYPE and cannot strip Hebrew on a C-locale
  -- build.
  v_reason := regexp_replace(
    coalesce(p_reason, ''),
    '[' || chr(1) || '-' || chr(8) || chr(11) || '-' || chr(31) || ']',
    '', 'g');
  v_reason := left(btrim(v_reason), 500);

  if v_category = 'coachs_pick' and v_reason = '' then
    raise exception 'reason required for a coach''s pick';
  end if;

  -- --- the post ---------------------------------------------------------
  v_name := coalesce(nullif(btrim(v_p.display_name), ''), v_p.handle);
  v_label := public.member_of_week_category_label(v_category);

  insert into public.workout_posts
    (author_id, post_type, visibility, title, body, metadata, status,
     published_at, club_id, source_type, source_id, occurred_on)
  values (
    null, 'POST_ANNOUNCEMENT', 'club',
    'חבר/ת השבוע',
    left(v_name || ' — ' || v_label || case when v_reason = '' then '' else E'\n' || v_reason end, 1000),
    -- metadata.title is what renderAnnouncementPostCard reads first; the
    -- rest is the same flat, self-describing shape every other producer in
    -- this schema writes, so a card can be rendered without joining back.
    jsonb_build_object(
      'title',            'חבר/ת השבוע',
      'member_of_week',   true,
      'member_id',        p_user_id,
      'member_name',      v_name,
      'category',         v_category,
      'category_label',   v_label,
      'week_start',       v_week,
      'reason',           v_reason
    ),
    'active', now(), public.default_club_id(),
    -- source_id points at the member_of_week row, whose id is generated
    -- above so the two rows can reference each other in one transaction.
    'announcement', v_id, v_week
  )
  returning id into v_post_id;

  insert into public.member_of_week
    (id, week_start, category, user_id, reason, post_id, published_by)
  values (v_id, v_week, v_category, p_user_id, v_reason, v_post_id, v_uid);

  -- One audit row, written inside the same transaction, so a failed log
  -- fails the whole publish. Same shape pin_set() uses.
  perform public.log_admin_action(
    'member_of_week_publish', 'member', p_user_id, null,
    jsonb_build_object(
      'member_of_week_id', v_id,
      'week_start',        v_week,
      'category',          v_category,
      'rotation_category', v_rotation,
      'post_id',           v_post_id,
      'reason',            v_reason
    )
  );

  return v_id;
end $$;

revoke all on function public.member_of_week_publish(date, uuid, text) from public, anon;
grant execute on function public.member_of_week_publish(date, uuid, text) to authenticated;

comment on function public.member_of_week_publish(date, uuid, text) is
  'COMM-315 publish member of the week. Staff-only, is_staff() inline. p_week_start null means the current week and any date is normalised to its ISO Monday. Refuses: a week already published (''week already published'' - never an upsert), the member recognised in the immediately prior week (''member was recognised last week''), a deleted member, and a member whose visible_to_club is false. Category is derived, not passed: the week''s rotation category when p_user_id is in that week''s computed shortlist, otherwise coachs_pick, which is how COMM-315''s "staff can fall back to coach''s pick" empty state is expressed. p_reason is trimmed, control characters stripped, capped at 500, and required when the resolved category is coachs_pick. Side effects: one authorless club-visible POST_ANNOUNCEMENT naming the member, the category and the reason (chosen over COMM-225''s comment-on-a-card pattern because three of the four categories have no source post); one public.member_of_week row; one admin_actions row of action_type member_of_week_publish. Returns the member_of_week id.';

commit;
