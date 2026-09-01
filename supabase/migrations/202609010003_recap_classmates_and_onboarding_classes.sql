begin;

-- COMM-316, schema half. Closes both parked items in one migration:
-- COMM-P06 (the weekly recap's classmates line) and COMM-P07 (the two
-- onboarding steps tied to a member's first and third class).
--
-- WHAT LANDS HERE
--   * public.weekly_recaps.classmates          new column, jsonb not null default '[]'
--   * public.recap_weekly_classmates(uuid, date, int) returns jsonb
--                                              new, security definer, service_role only
--   * public.onboarding_progress.first_class_shown_at  new column, timestamptz null
--   * public.onboarding_progress.third_class_shown_at  new column, timestamptz null
--   * public.onboarding_progress_pin_shown()   re-created: two more pinned columns
--
-- No new table, so no new RLS policy. The two tables written here already
-- have theirs, and neither policy set changes: weekly_recaps stays own-row
-- SELECT with no client write of any kind, onboarding_progress stays own-row
-- SELECT plus own-row UPDATE. See "THE GRANT SHAPE" below for why adding a
-- column to either needed no grant at all.
--
-- THE TWO FORWARD REFERENCES THIS CLOSES, VERBATIM
--   202608290011, weekly_recaps' own header:
--     "club_challenge_progress is the one aggregate field, and it is
--      aggregate by construction ... because a recap that named who else
--      trained would leak exactly the attendance data COMM-316 has not been
--      allowed to expose yet."
--   202608290011, onboarding_progress' own header:
--     "Also deliberately absent: the two steps tied to the member's first and
--      third class. Those need attendance, which does not exist. They land
--      with COMM-316; see COMM-P07."
-- Both are now true rather than deferred: COMM-300 shipped attendance_log.
--
-- WHY NAMING CLASSMATES IN A WEEKLY RECAP IS NOT THE THING COMM-309 REFUSED
-- These two rules look like opposites and are not. A weekly_recaps row is a
-- PRIVATE, OWN-ROW surface - `weekly_recaps_self_select` is the only policy
-- on the table and there is no write grant at all - so the audience of a
-- classmates line is exactly one member, the one who was in the room on the
-- days being named. monthly_club_recaps (202609010002) is the opposite: one
-- row the whole club reads, which is why its aggregate-only rule is enforced
-- by the table having no user_id, no text and no jsonb column to write a name
-- into, and why it stays aggregate-only forever. Same module, two audiences,
-- two rules.
--
-- The line still only ever names members who opted in. See PRIVACY below,
-- which is the whole of this file's difficulty.

-- =====================================================================
-- 1. weekly_recaps.classmates
-- =====================================================================
-- [{user_id, display_name, handle, avatar_url}] - the four keys COMM-316's
-- "client calls and contracts" names and no fifth. In particular NOT
-- shared_days, even though the function below computes it: the count is the
-- ordering key and it stays inside the function. The same restraint
-- attendance_classmates_today() (202608310005) shows for the same reason -
-- "a caller learns that these members trained today ... they do not learn
-- anything about any other day" - and the four keys are exactly what
-- community_profile (202608280022) already returns to any member for any
-- member, so nothing new about a classmate becomes reachable.
--
-- `not null default '[]'` is the quiet-week floor the table's other list
-- columns already use (prs, achievements, challenge_progress). A member with
-- no overlap gets an honest empty array, never a null the client has to
-- branch on, which is COMM-316's "quiet week shape is unaffected" criterion
-- expressed as a default rather than as a rule recap_weekly has to remember.
--
-- No `check (jsonb_typeof(classmates) = 'array')`. Not an oversight: none of
-- the four jsonb columns already on this table carries one, and a constraint
-- on the fifth alone would say the writer is trusted for four blobs and not
-- for the fifth. The array shape is guaranteed by its only producer, which is
-- the function below and which cannot return anything else.
alter table public.weekly_recaps
  add column if not exists classmates jsonb not null default '[]'::jsonb;

comment on column public.weekly_recaps.classmates is
  'COMM-316, closing COMM-P06. [{user_id, display_name, handle, avatar_url}] - up to a small number of members this row''s own member shared an attendance_log day with during week_start''s ISO week, ordered by shared days then display name. Empty array means no overlap (or the member''s own show_attendance is off), never null. Written only by recap_weekly, from public.recap_weekly_classmates(); no client can write this table at all. Naming individuals is safe HERE and nowhere else in the module: weekly_recaps is own-row select only, so the audience is the one member who was in the room. The club-wide monthly recap (COMM-309) stays aggregate-only forever.';

-- THE GRANT SHAPE, verified rather than assumed. 202608290011 grants only
-- `select` on weekly_recaps to `authenticated`, revokes everything from
-- `public` and `anon`, and creates exactly one policy - weekly_recaps_self_
-- select, own-row SELECT. There is NO insert, update or delete grant and no
-- write policy for anybody, the owning member included; recap_weekly writes
-- as service_role, which bypasses RLS entirely. A table-level SELECT grant
-- covers a column added later, so this column inherits that shape with no
-- new grant and no new policy. Nothing below re-grants anything, and that is
-- deliberate: a `grant select on public.weekly_recaps to authenticated` here
-- would be a no-op that looked like a decision.

-- =====================================================================
-- 2. recap_weekly_classmates(p_user, p_week_start, p_limit) returns jsonb
-- =====================================================================
-- The data source for the column above, and the only genuinely new piece of
-- reasoning in this file.
--
-- WHY A POSTGRES FUNCTION AND NOT TYPESCRIPT INSIDE recap_weekly
-- Same four-point argument 202609010002 records for recap_monthly_generate,
-- and one more that is specific to this query. attendance_log is own-row
-- plus staff (202608310001), so a service-role REST read of it would work
-- only because service_role bypasses RLS - and it would then have to
-- re-implement the block check, the deleted-profile check, the
-- visible_to_club check and the show_attendance check in TypeScript, which
-- puts the module's most sensitive privacy gate in a second language, in a
-- file the schema agent does not own. It lives here instead, once.
--
-- ---------------------------------------------------------------------
-- THE CRUX: THIS RUNS AS service_role, SO can_view_profile_field() CANNOT
-- BE USED, AND THE GATE IS SPELLED OUT INSTEAD.
-- ---------------------------------------------------------------------
-- can_view_profile_field(target, field) (202608280003) is the module's one
-- privacy resolution point and every member-facing Phase 3 reader calls it -
-- classmate_day_counts() (COMM-302), attendance_classmates_today()
-- (COMM-307), feed_leaderboard (COMM-306). It resolves ITS viewer from
-- auth.uid() and its very first statement is:
--
--     v_uid := auth.uid();
--     if v_uid is null then return false; end if;
--
-- The caller here is the recap_weekly Edge Function running as service_role
-- with no user JWT, so auth.uid() is NULL and that call would return FALSE
-- for every candidate, for every member, always. The classmates line would
-- be permanently empty and nothing would fail loudly to say so. Note that
-- being SECURITY DEFINER does not help: definer changes the executing ROLE,
-- not the request's JWT claims, which is why the same helper works fine
-- inside member-facing definer functions (auth.uid() is still the real
-- session there, as member_of_week_candidate_set records) and cannot work
-- here.
--
-- The viewer therefore has to be passed EXPLICITLY, as p_user, and the gate
-- re-expressed relative to it. classmate_day_counts()' header refuses a
-- p_viewer parameter for exactly the right reason - "a p_viewer parameter
-- would be honoured by the overlap count and silently ignored by the privacy
-- gate" - and that reason is precisely what is fixed here: this function does
-- not call the helper at all, so there is no gate left to silently ignore it.
-- The trap that header warns about would be taking p_user AND calling
-- can_view_profile_field(); doing one without the other is the way out.
--
-- WHAT THE HAND-WRITTEN GATE REPRODUCES, term for term, so a reviewer can
-- diff it against 202608280003:
--
--   can_view_profile_field                    here
--   ----------------------------------------  -----------------------------
--   p_target = auth.uid() -> true             self-exclusion in the join
--   block edge either direction -> false      the `not exists` on blocks
--   profile missing or deleted -> false       join + `deleted_at is null`
--   is_admin() -> true (short-circuit)        DELIBERATELY NOT REPRODUCED
--   not visible_to_club -> false              `pr.visible_to_club`
--   the named toggle                          `pr.show_attendance`
--
-- THE ADMIN SHORT-CIRCUIT IS DELIBERATELY NOT REPRODUCED, and this is a
-- product decision, recorded here the way COMM-304, COMM-309 and COMM-315
-- recorded theirs rather than left to be discovered.
--
-- 202609010001 already drew this exact line: member_of_week_candidate_set
-- asks BOTH the helper and the raw columns, because "an admin's rank governs
-- what they may see, never what the club may be told". A weekly recap is not
-- club-wide, but it is a PERSISTED ARTIFACT rather than a live view, and
-- that is the same distinction one step further along:
--
--   * The helper answers "may this session see this, right now". There is no
--     session here. The nearest thing - "is p_user an admin" - is a question
--     about the SUBJECT, not about a viewer, and the short-circuit was never
--     about the subject.
--   * A recap row outlives the moment it was computed. It sits in the table
--     indefinitely, the member reads it whenever they open the surface, and
--     COMM-221's Share Recap turns it into feed content. A name written into
--     it past a member's own toggle is written past that toggle permanently,
--     with no session left to justify it.
--   * The practical effect, stated plainly: an admin's weekly recap names
--     only classmates who opted in, exactly like every other member's. An
--     admin who wants to see who trained when still has attendance_log's
--     staff read policy, which is the surface that boundary belongs to.
--
-- THE SUBJECT'S OWN TOGGLE, which is the second half of COMM-316's first
-- acceptance criterion ("gates whether the line appears AT ALL for them, not
-- just whether their name appears in someone else's"). It is read STRAIGHT
-- OFF the member's own profiles row, not through any viewer-relative helper -
-- the identical direct-column read attendance_classmates_today()
-- (202608310005) and attendance_milestones_on_log() (202608310007) both make,
-- both for the identical reason: a viewer-relative helper answers true for
-- the subject before it consults any toggle and therefore literally cannot
-- express "has this member opted in at all". The two questions are different
-- and only the second one is being asked.
--
-- It is a reciprocity rule and reciprocity has to be symmetric, which is
-- COMM-307's argument applied to a second surface: every member NAMED on the
-- line has opted into being seen training, so a member who declined that
-- trade does not get to read the other side of it. Off means an empty array -
-- the same value a member with no overlap gets - so the recap's quiet-week
-- rendering already covers it and nothing about the member's setting leaks
-- into the shape of their own row.
--
-- show_attendance DEFAULTS TO FALSE (202608280003), so out of the box every
-- recap's classmates line is empty and every name that ever appears on one is
-- there by two deliberate choices: the subject's and the classmate's.
--
-- WHAT IS NOT ASKED ABOUT THE SUBJECT: visible_to_club. The candidate side
-- requires it, because that is the toggle governing whether a member may be
-- shown to another member at all; the subject side does not, because a member
-- reading their own recap is not being shown to anybody. This matches
-- attendance_classmates_today's own subject gate exactly, which reads
-- show_attendance and nothing else.
--
-- AUTH. security definer, granted to service_role and to NOBODY else, and -
-- the documented exception this schema already carries for every scheduled
-- job (chal_notify_ending_soon, notif_batch_flush_due,
-- coach_detect_engagement_decline, recap_monthly_generate) - it does not
-- check auth.uid() first, because there is no session to check. THE GRANT IS
-- THE GATE, and here that matters more than it does for those four: p_user is
-- a parameter, so a member-callable version of this function would answer
-- "who did member X train with in week W" about anybody. It is revoked from
-- public, anon and authenticated, and 0047 asserts all four privileges.
--
-- THE WEEK. p_week_start is normalised to the Monday of its own ISO week
-- rather than rejected - the courtesy member_of_week_candidates() and
-- recap_monthly_generate() both extend - so a caller that hands over a
-- mid-week date gets that week rather than an error. Null means the most
-- recently COMPLETED ISO week, the same week recap_weekly's targetWeek()
-- picks and for the same stated reason. The window is [Monday, Monday+6] on
-- BOTH sides of the join: a day the two members shared outside the target
-- week is not a day they shared that week, which is the entire difference
-- between this and classmate_day_counts()' rolling 60-day window and the
-- reason that helper is not reused with a different anchor.
--
-- THE ORDER: shared days descending, then display name, then id. COMM-316's
-- validation rules name the first two; the id makes the order TOTAL, so the
-- cut at p_limit is deterministic and two runs of the same week produce the
-- same line rather than whatever the plan returned. Same three-key shape
-- people_suggestions and attendance_classmates_today already use, with the
-- same `coalesce(nullif(btrim(display_name), ''), handle)` name key.
--
-- THE LIMIT: p_limit, clamped 1..20 like every other capped reader in this
-- module, defaulting to 5. Five is a recap line - a sentence naming people,
-- read once a week - where COMM-307's card is 6 and people_suggestions'
-- scrolling strip is 10. The clamp is the server's; the default is a
-- parameter so the recaps agent can revisit it from the Edge Function
-- without a migration.
--
-- RAISES only for a null p_user, which is a caller bug and not a data state:
-- a job that loops members cannot legitimately reach here without one, and
-- silently writing an empty line would make that bug invisible in a stored
-- row. Every real data state - no profile, deleted profile, opted out, no
-- attendance, no overlap, nobody opted in - returns '[]' instead, so
-- recap_weekly's per-member try/catch only ever sees a genuine fault.
create or replace function public.recap_weekly_classmates(
  p_user uuid,
  p_week_start date default null,
  p_limit int default 5
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_week     date;
  v_limit    int;
  v_opted_in boolean;
  v_out      jsonb;
begin
  if p_user is null then
    raise exception 'recap_weekly_classmates: p_user is required';
  end if;

  -- date_trunc('week') is Monday in Postgres, which is the same Monday
  -- weekly_recaps.week_start's CHECK pins.
  v_week := date_trunc('week',
              coalesce(p_week_start, current_date - 7)::timestamp)::date;

  v_limit := greatest(1, least(coalesce(p_limit, 5), 20));

  -- The subject's own toggle. Direct column read - see the header. A missing
  -- or soft-deleted profile coalesces to false, which is the same empty line
  -- and not an error.
  select p.show_attendance into v_opted_in
  from public.profiles p
  where p.id = p_user and p.deleted_at is null;
  if not coalesce(v_opted_in, false) then return '[]'::jsonb; end if;

  select coalesce(
           jsonb_agg(x.item order by x.shared_days desc, x.sort_name asc, x.cand asc),
           '[]'::jsonb)
  into v_out
  from (
    select o.cand,
           o.shared_days,
           coalesce(nullif(btrim(pr.display_name), ''), pr.handle) as sort_name,
           jsonb_build_object(
             'user_id',      o.cand,
             'display_name', pr.display_name,
             'handle',       pr.handle,
             'avatar_url',   pr.avatar_url
           ) as item
    from (
      -- attendance_log to itself, both sides inside the target week. `me` is
      -- at most seven rows (the table's unique (user_id, occurred_on) key),
      -- and no row at all for the subject means no candidates at all, which
      -- is the honest quiet week rather than a separate branch.
      select a.user_id as cand, count(*)::int as shared_days
      from public.attendance_log me
      join public.attendance_log a
        on a.occurred_on = me.occurred_on
       and a.user_id <> me.user_id
      where me.user_id = p_user
        and me.occurred_on between v_week and v_week + 6
      group by a.user_id
    ) o
    join public.profiles pr on pr.id = o.cand
    -- The gate, term for term against can_view_profile_field. See the header
    -- for why it is written out here and for the one term deliberately absent.
    where pr.deleted_at is null
      and pr.visible_to_club
      and pr.show_attendance
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = p_user and b.blocked_id = o.cand)
           or (b.blocker_id = o.cand and b.blocked_id = p_user)
      )
    order by o.shared_days desc, sort_name asc, o.cand asc
    limit v_limit
  ) x;

  return v_out;
end $$;

revoke all on function public.recap_weekly_classmates(uuid, date, int)
  from public, anon, authenticated;
grant execute on function public.recap_weekly_classmates(uuid, date, int) to service_role;

comment on function public.recap_weekly_classmates(uuid, date, int) is
  'COMM-316 weekly recap classmates line, closing COMM-P06. Returns a jsonb ARRAY (never null) of up to p_limit objects {user_id, display_name, handle, avatar_url} - members other than p_user who have an attendance_log row on a day p_user also has one, inside ONE ISO week on both sides of the join. p_week_start is normalised to its own week''s Monday; null means the most recently completed ISO week, the same week recap_weekly''s targetWeek() picks. p_limit clamped 1..20, null means 5. Ordered by shared days desc, then display name, then id, so the cut is deterministic. The shared-day COUNT is the ordering key only and never leaves the function. Called by the recap_weekly Edge Function as service_role, once per member per week. AUTH: security definer, granted to service_role ONLY and revoked from public, anon and authenticated - p_user is a parameter, so a member-callable version would answer "who did member X train with" about anybody; the grant is the gate, and there is no auth.uid() check because a job has no session (the documented exception recap_monthly_generate, chal_notify_ending_soon, notif_batch_flush_due and coach_detect_engagement_decline all carry). PRIVACY: can_view_profile_field() CANNOT be used here - it resolves its viewer from auth.uid(), which is null for a service-role caller, so it would return false for every candidate forever. The gate is therefore written out against the explicit p_user viewer and reproduces the helper term for term (self excluded, block edge in either direction, profile present and not soft-deleted, visible_to_club, show_attendance) EXCEPT the is_admin() short-circuit, deliberately: a recap row is a persisted artifact a member can Share to the feed, so a member''s own toggle outranks the subject''s rank. p_user''s OWN show_attendance is read straight off profiles (not through any viewer-relative helper, which answers true for the subject before reading any toggle) and gates the line entirely: off means ''[]'', indistinguishable from a quiet week, never a raise. Naming individuals is safe because weekly_recaps is own-row select only; the club-wide COMM-309 recap stays aggregate-only. Raises P0001 only for a null p_user, which is a caller bug rather than a data state.';

-- =====================================================================
-- 3. onboarding_progress: the two attendance-tied steps (COMM-P07)
-- =====================================================================
-- 202608290011 refused to add these speculatively - "a nullable column nobody
-- writes is indistinguishable from a step that never fired" - and named this
-- ticket as where they land. They are timestamptz and nullable, exactly like
-- the three that are already there: null means "not shown yet", and the
-- client stamps them at the moment the card is actually RENDERED, not when it
-- becomes eligible.
--
-- WHAT DECIDES ELIGIBILITY IS NOT A COLUMN HERE, on purpose and consistently
-- with the three existing steps. welcomed_at / first_week_shown_at /
-- first_month_shown_at carry no schedule either; the clock is
-- invite_redemptions.redeemed_at, which the member can already read on their
-- own row. The clock for these two is public.attendance_log, which the member
-- can already read on their own rows under attendance_log_self_select: "do I
-- have at least one row" and "do I have at least three distinct occurred_on
-- days". No new RPC, no new view, no denormalised counter to drift - the
-- client asks the table it already reads. This is also what makes COMM-316's
-- "these two steps do not block or reorder the three already-shipped steps"
-- true structurally: five independent nullable stamps with five independent
-- eligibility questions, no ordering between them anywhere in the schema.
--
-- NO BACKFILL AND NO SEEDING. The seeding trigger (seed_onboarding_progress,
-- INSERT-only on invite_redemptions) already puts a row there for every
-- member, and these two columns simply start null on every existing row -
-- which is the correct state for both an existing member who has never been
-- shown the step and a brand-new one. A member who has already logged fifty
-- classes will see the first-class card once, on their next visit; that is
-- the same "the step fires when the client first renders it" behaviour the
-- three existing steps have on deploy day, and stamping them retroactively
-- would need a rule about which past day counted as "shown", which is a rule
-- nobody can honestly write.
alter table public.onboarding_progress
  add column if not exists first_class_shown_at timestamptz,
  add column if not exists third_class_shown_at timestamptz;

comment on column public.onboarding_progress.first_class_shown_at is
  'COMM-316, closing COMM-P07. Null means not shown yet. Stamped once by the client at the moment the step is rendered, after the member''s first public.attendance_log row. One-way: onboarding_progress_pin_shown() pins it once set. Eligibility is read from attendance_log directly (own-row select), not from a column here.';

comment on column public.onboarding_progress.third_class_shown_at is
  'COMM-316, closing COMM-P07. Null means not shown yet. Stamped once by the client at the moment the step is rendered, after the member''s third DISTINCT public.attendance_log.occurred_on day (attendance_log is unique on (user_id, occurred_on), so three rows are three days). One-way: onboarding_progress_pin_shown() pins it once set. Independent of the other four steps - no ordering between any of them exists in the schema.';

-- THE GRANT SHAPE, again verified rather than assumed. 202608290011 grants
-- `select, update` on onboarding_progress to `authenticated` at the TABLE
-- level, with no column list, so both new columns are readable and updatable
-- by their owner the moment they exist. The two policies pin user_id in
-- USING and WITH CHECK and say nothing about columns, so they cover the new
-- ones unchanged. There is still no insert and no delete grant. Nothing is
-- re-granted here; 0047 asserts the privileges instead of this file
-- restating them.

-- =====================================================================
-- 4. onboarding_progress_pin_shown(), extended
-- =====================================================================
-- THE EXISTING TRIGGER DID NOT ALREADY COVER THE NEW COLUMNS. Checked rather
-- than assumed: 202608290011's body names all four columns explicitly -
--
--     new.user_id              := old.user_id;
--     new.welcomed_at          := coalesce(old.welcomed_at, new.welcomed_at);
--     new.first_week_shown_at  := coalesce(old.first_week_shown_at,  new.first_week_shown_at);
--     new.first_month_shown_at := coalesce(old.first_month_shown_at, new.first_month_shown_at);
--
-- - so a column added later is not pinned by it at all, and both new stamps
-- would have been freely clearable and freely re-movable by their owner. The
-- one-way rule would have quietly held for three columns out of five, which
-- is the worst possible outcome: it would look correct in every test that
-- only exercised the old ones. 0047 asserts the behaviour for all five
-- columns rather than the shape of this function, so a future sixth column is
-- caught by a failing assertion instead of by a reviewer noticing.
--
-- Column-wise rather than generic (a `to_jsonb(old)`/`to_jsonb(new)` merge
-- loop would cover any future column automatically) because that generic form
-- would also pin any NON-timestamp column added later, silently making it
-- read-only. The rule is "a shown-stamp is one-way", not "this table is
-- append-only", and stating it per column keeps the two from being confused.
-- The cost is one line per future step, which is the right amount of friction
-- for adding an onboarding step.
--
-- `create or replace function` only. The trigger itself
-- (onboarding_progress_pin, BEFORE UPDATE) is bound to the function by name
-- and is NOT re-created: dropping and re-creating it would leave a window
-- with no pin, and there is nothing about the trigger definition to change.
create or replace function public.onboarding_progress_pin_shown() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.user_id              := old.user_id;
  new.welcomed_at          := coalesce(old.welcomed_at,          new.welcomed_at);
  new.first_week_shown_at  := coalesce(old.first_week_shown_at,  new.first_week_shown_at);
  new.first_month_shown_at := coalesce(old.first_month_shown_at, new.first_month_shown_at);
  -- COMM-316. Same one-way rule, same silent pin, same reason: a member
  -- opening two tabs on their first day is a benign race, not an error worth
  -- surfacing, and COMM-222 wants a failed dismiss-write to retry quietly.
  new.first_class_shown_at := coalesce(old.first_class_shown_at, new.first_class_shown_at);
  new.third_class_shown_at := coalesce(old.third_class_shown_at, new.third_class_shown_at);
  return new;
end $$;

comment on function public.onboarding_progress_pin_shown() is
  'BEFORE UPDATE on public.onboarding_progress, as trigger onboarding_progress_pin. Pins user_id and every already-set shown-stamp to its previous value: a null stamp may be set once, a set stamp can never be cleared or moved. Silently, never raising - two tabs dismissing the same card is a benign race and COMM-222 wants a failed dismiss-write to retry quietly. COMM-316 extended it to first_class_shown_at and third_class_shown_at; the body names each column, so ADDING A SIXTH STEP REQUIRES ADDING A LINE HERE - it is deliberately not a generic to_jsonb merge, which would also pin any non-timestamp column a later ticket adds.';

commit;
