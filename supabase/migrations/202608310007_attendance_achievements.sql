begin;

-- COMM-305, closing the parked COMM-P03. The four ATTENDANCE_RECORDED
-- achievement definitions stop being inert badges, and
-- POST_ATTENDANCE_MILESTONE gets its first producer since the enum label and
-- the client card contract shipped in Phase 1.
--
-- WHAT LANDS HERE
--   * The four seeded ATTENDANCE_RECORDED achievement_definitions rows
--     (202608280007) flip to enabled = true. That is an UPDATE, exactly as
--     that migration's own comment predicted ("Enabling them later is an
--     UPDATE, not a migration").
--   * public.attendance_week_streak(uuid, date) - new, internal, ungranted.
--     The per-member, optionally one-day-excluded form of the same ISO-week
--     arithmetic consistency_week_streaks() (202608310004, COMM-306) does
--     set-wide.
--   * public.attendance_milestones_on_log() - new AFTER INSERT trigger
--     function on attendance_log, security definer, fired as
--     attendance_log_milestones.
--   * One partial expression index on workout_posts, mirroring the two
--     202608290004 and 202608290014 already added for their own metadata
--     lookups.
-- No new table, so no new RLS policy. Both tables written here already have
-- their own, and neither gains a client write grant.
--
-- WHY A TABLE TRIGGER AND NOT ach_evaluate()
-- contracts.md's "Needs from schema, achievements" has named
-- ach_evaluate(user_id, trigger, payload) - the service-role event-bus
-- consumer - since Phase 0, and it is STILL NOT BUILT. This migration does
-- not build it either; that is explicitly out of COMM-305's scope. What it
-- follows instead is the precedent challenge_progress_apply (202608290004)
-- already set for exactly this situation: no generic consumer exists, so an
-- AFTER INSERT trigger on the source table does the evaluation inline. The
-- consequence is worth stating plainly rather than leaving implicit: after
-- this migration the four attendance codes are the only ones in the seed
-- that a member can actually earn without the client asking for them. Every
-- community/challenge/club-shaped row is still unearnable until
-- ach_evaluate lands.
--
-- THE ONE SHAPE DECISION A REVIEWER SHOULD READ BEFORE THE CODE
-- The three count milestones and the one streak milestone are detected
-- DIFFERENTLY, on purpose, and each branch says why at length in place:
--
--   count milestones (non-repeatable)  test STATE: the member's all-time day
--     count reaches the threshold and they do not already hold the code, with
--     member_achievements_once_idx deciding "already hold" atomically.
--   weekly streak (repeatable)         tests an EVENT: the streak computed
--     with and without the day just inserted, firing only when the threshold
--     sits between the two.
--
-- The asymmetry is not an inconsistency. "Have they got this badge already"
-- is answerable from state and a state test is also correct for a multi-row
-- insert, which a just-crossed delta is not (see the count branch). "Did a
-- fresh streak just start qualifying" is not answerable from state at all,
-- because the member is meant to earn it again and again.
--
-- WHY THE STREAK ARITHMETIC IS NOT INLINED
-- COMM-305 requires that this trigger and consistency_week_streaks() can
-- never disagree about what a "streak" is. consistency_week_streaks() is
-- set-wide, zero-argument and cannot answer "what would this member's streak
-- have been without today's row", which is precisely the question a
-- repeatable definition has to ask (see below). So the arithmetic is
-- restated once, in one named function, in the same shape - distinct ISO
-- weeks carrying at least one attendance day, anchored on the member's most
-- recent such week, counted backwards while each week is exactly 7 days
-- before the previous one, and only when the anchor is the current week or
-- the previous one. That is the same "second copy pinned by a drift
-- assertion" shape community_profile's inline current_streak has carried
-- since COMM-180 and 202608310004 kept deliberately;
-- 0043_attendance_achievements_test.sql pins the two against each other for
-- every member of a fixture, so a future edit to one that is not made to the
-- other fails CI rather than quietly splitting the definition of a streak in
-- two.

-- =====================================================================
-- 1. The definitions go live
-- =====================================================================
-- Keyed on trigger_type, not on a list of four codes, so a fifth
-- attendance-triggered definition added later is enabled by its own seed
-- row rather than needing this statement re-run. Idempotent: running it
-- again updates nothing that is not already true.
update public.achievement_definitions
set enabled = true
where trigger_type = 'ATTENDANCE_RECORDED' and not enabled;

-- =====================================================================
-- 2. attendance_week_streak(p_user, p_exclude_day)
-- =====================================================================
-- p_exclude_day is the whole reason this function is parameterised rather
-- than being a filtered call into consistency_week_streaks(). The trigger
-- below runs AFTER INSERT, so the new row is already in the table and the
-- "current" streak already includes it; answering "did this row just push
-- them over the line" needs the same number computed without it. Excluding
-- by DAY rather than by row id is exact here and nowhere else: attendance_log
-- is unique on (user_id, occurred_on), so a day is a row.
--
-- Note what excluding one day does NOT do: it does not remove the week. A
-- member who trains twice in the same week produces a second insert whose
-- excluded-day streak is identical to its included-day streak, because the
-- week is still carried by the other day. That is the correct answer - the
-- week was already counted, nothing crossed - and it falls out of the
-- arithmetic rather than needing a special case.
--
-- SECURITY INVOKER with no grant to anyone, the same shape
-- consistency_week_streaks() and classmate_day_counts() use: internal
-- plumbing, not an API. Called from the definer trigger below it runs with
-- that function's rights, which is how it reads a member's attendance days
-- past attendance_log_self_select; called from anywhere else it cannot be
-- called at all.
--
-- No privacy filter, deliberately, and for a stronger reason than
-- consistency_week_streaks() has: this number is only ever used to decide
-- whether a member earned their OWN achievement. show_attendance governs
-- what other members may be told about a member's training, never whether
-- the member's own training counts for them - the rule 202608310003 and
-- 202608310004 both state and 0039/0040 both assert. The privacy branch in
-- this ticket is on the public POST, and it lives in the trigger.
create or replace function public.attendance_week_streak(p_user uuid, p_exclude_day date default null)
returns integer
language sql stable security invoker set search_path = '' as $$
  with weeks as (
    select distinct date_trunc('week', a.occurred_on::timestamp)::date as wk
    from public.attendance_log a
    where a.user_id = p_user
      and (p_exclude_day is null or a.occurred_on <> p_exclude_day)
  ),
  anchored as (
    select w.wk,
           row_number() over (order by w.wk desc) as rn,
           max(w.wk) over () as anchor
    from weeks w
  )
  -- Once a week is missing every later row falls behind the expected date
  -- and stays behind, so this counts the contiguous run from the anchor and
  -- nothing after it. Identical to consistency_week_streaks()' final select,
  -- with the partition dropped because the set is one member.
  select coalesce((
    select count(*)::integer
    from anchored a
    where a.anchor >= date_trunc('week', current_date::timestamp)::date - 7
      and a.wk = a.anchor - ((a.rn - 1) * 7)::integer
  ), 0);
$$;

revoke all on function public.attendance_week_streak(uuid, date) from public, anon, authenticated;

comment on function public.attendance_week_streak(uuid, date) is
  'Internal. One member''s current consecutive-ISO-week training streak over public.attendance_log, the same arithmetic consistency_week_streaks() (COMM-306) computes set-wide, with an optional p_exclude_day so an AFTER INSERT trigger can ask what the streak was before the row it just saw. A member with no attendance days, or whose most recent trained week is older than the previous week, is 0. Carries no privacy filter: it only ever decides a member''s own achievement, and show_attendance governs what OTHER members are told. No grants: only attendance_milestones_on_log() calls it. COMM-305.';

-- =====================================================================
-- 3. attendance_milestones_on_log()
-- =====================================================================
-- SECURITY DEFINER, and it does NOT check auth.uid() first. Same documented
-- exception attendance_log_from_record(), post_new_member_on_join(),
-- seed_onboarding_progress() and notif_queue_batched() all record: the
-- identity this function acts for is new.user_id, and the row it reads was
-- written by attendance_log_from_record() off a private_records row already
-- pinned to its owner by RLS - a stronger check than re-reading auth.uid()
-- here would be. An auth.uid() gate would also break any future
-- service-role repair, which legitimately has no session.
--
-- It is definer for two boundaries it crosses on purpose:
--   * member_achievements has no insert grant and no insert policy for any
--     client role (202608280007: "a member cannot award themselves").
--   * an authorless workout_posts row is unreachable through
--     posts_insert_self, which requires author_id = auth.uid(). Same
--     reasoning post_create() and post_new_member_on_join() give.
--
-- THRESHOLDS ARE READ FROM THE TABLE, never restated. 1, 25, 100 and 4
-- appear nowhere in this file: every number comes from
-- achievement_definitions.threshold, so re-tuning a milestone is an UPDATE
-- to one row and adding a fifth one is an INSERT, neither of which needs a
-- migration here. Disabling a definition stops its unlocks immediately, for
-- the same reason.
--
-- THE LOCK. `select ... for update` on the member's own profiles row, taken
-- before anything is evaluated, is the same serialisation
-- challenge_progress_apply takes on its challenges row and for the same
-- reason: two attendance rows for one member landing in the same instant
-- would otherwise both read the pre-insert world and both decide "not posted
-- yet". The achievement side does not need it (member_achievements_once_idx
-- is the real backstop under concurrency, exactly as every other unlock path
-- relies on) but the post side has no unique index and deliberately must not
-- grow one - see the idempotency note below. The row locked is the row this
-- function has to read anyway for show_attendance and the member's name, so
-- the lock costs one statement, not an extra one.
create or replace function public.attendance_milestones_on_log() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_profile public.profiles;
  v_days integer;
  v_streak integer;
  v_streak_before integer;
  v_def record;
  v_unlocked uuid;
  v_already boolean;
  v_name text;
begin
  select * into v_profile from public.profiles p where p.id = new.user_id for update;
  -- attendance_log.user_id is a foreign key to profiles, so this cannot
  -- normally miss. Returning rather than raising keeps the guarantee
  -- attendance_log_from_record() already makes: nothing downstream of a
  -- member's training-log sync may ever abort that sync.
  if not found then return new; end if;

  -- attendance_log is one row per member per calendar day (a unique
  -- constraint, not a convention), so count(*) IS the distinct occurred_on
  -- count, all-time and unwindowed.
  select count(*)::integer into v_days
  from public.attendance_log a where a.user_id = new.user_id;

  v_name := coalesce(nullif(btrim(v_profile.display_name), ''), v_profile.handle, 'חבר/ה');

  -- --- the count milestones, non-repeatable ---------------------------
  for v_def in
    select d.id, d.code, d.name, d.threshold, d.visibility
    from public.achievement_definitions d
    where d.trigger_type = 'ATTENDANCE_RECORDED'
      and d.enabled
      and d.threshold is not null
      and not d.repeatable
    order by d.threshold
  loop
    -- THE CROSSING TEST FOR A NON-REPEATABLE COUNT MILESTONE IS "QUALIFIES
    -- AND HAS NOT GOT IT YET", not a computed before/after delta, and that is
    -- a deliberate choice worth reading twice, because a delta form was
    -- written first and is wrong.
    --
    -- The delta form is `v_days >= threshold and v_days - 1 < threshold`,
    -- i.e. "this row is the 25th". It reads like the ticket's sentence, and
    -- it holds for the production write path, where the count really does
    -- move one at a time: attendance_log_from_record() issues one
    -- single-row INSERT per private_records row, each in its own statement.
    -- It silently awards NOTHING for a multi-row insert, because Postgres
    -- queues AFTER ... FOR EACH ROW triggers to the end of the statement, so
    -- all 30 rows of a 30-row insert see a count of 30 and a "before" of 29,
    -- and not one of them is the 25th. A repair script, a fixture, or any
    -- future set-based writer would then produce attendance days that earn
    -- nothing, with no error to notice.
    --
    -- "Qualifies and has not got it yet" is the same thing for the
    -- one-row-at-a-time path - the previous day's insert would already have
    -- awarded it if it qualified, so the row that first satisfies this IS the
    -- 25th - and is also right for a bulk insert. It is additionally the
    -- shape ach_claim already uses for exactly this question (`d.repeatable
    -- or not exists (select 1 from member_achievements ...)`) which is what
    -- COMM-305 means by not reinventing idempotency.
    --
    -- ON CONFLICT DO NOTHING ... RETURNING is where the "has not got it yet"
    -- half actually lives: member_achievements_once_idx (the partial unique
    -- index on non-repeatable definitions) decides it, atomically, so two
    -- concurrent inserts cannot both win and a lost race is swallowed rather
    -- than surfaced. v_unlocked is null exactly when this call did not write
    -- the row, which is also what gates the post below.
    continue when v_days < v_def.threshold;

    insert into public.member_achievements (user_id, achievement_id, visibility)
    values (new.user_id, v_def.id, v_def.visibility)
    on conflict do nothing
    returning id into v_unlocked;

    continue when v_unlocked is null;

    -- ---------------------------------------------------------------
    -- The feed post: the two count milestones only, and only with the
    -- member's own show_attendance on.
    -- ---------------------------------------------------------------
    -- A FIRST CLASS IS NOT A POST. It is celebrated as an achievement
    -- unlock and nothing else, which is how every other first-time
    -- milestone in this schema is already celebrated: ach_claim writes a
    -- member_achievements row and never a post, and a POST_ACHIEVEMENT only
    -- ever exists because the member deliberately shared it (ach_share).
    -- The two count milestones are the exception COMM-305 makes, not the
    -- rule they follow.
    --
    -- Expressed as `threshold > 1` rather than as a code list, so the rule
    -- stays "a member's very first logged day is not a club announcement"
    -- rather than "these two hard-coded codes post". A future
    -- attendance_250_classes row posts automatically; a future
    -- first-anything row does not.
    --
    -- THE PRIVACY BRANCH. show_attendance is read straight off the member's
    -- own profiles row, NOT through can_view_profile_field(), which is
    -- viewer-relative and answers true for the subject before it consults
    -- any toggle - it literally cannot express "does this member want their
    -- attendance published". This is the same direct-column read
    -- attendance_classmates_today() (202608310005) makes for the same
    -- question, and for the same reason.
    --
    -- The achievement above is NOT inside this branch, deliberately.
    -- Achievements carry their own separate toggle (show_achievements,
    -- applied by member_achievements_read and by community_profile), so a
    -- member with attendance private still earns the badge and still
    -- controls who sees it - through the toggle that governs badges. Off
    -- means no public post, never no achievement. show_attendance also
    -- DEFAULTS TO FALSE (202608280003), so out of the box this trigger
    -- unlocks achievements for everyone and posts for nobody.
    --
    -- THE TOGGLE IS READ AT THE MOMENT OF THE UNLOCK AND NEVER RE-ASKED.
    -- This block is downstream of `continue when v_unlocked is null`, so it
    -- is reachable only on the call that actually wrote the achievement
    -- row - once per member per milestone, ever. A member who crossed 25
    -- with attendance private and turns the toggle on months later does not
    -- get a belated "25 classes" announcement on their next session; the
    -- celebration happened, privately, and the moment is not replayed. That
    -- is the same one-shot shape post_new_member_on_join has (a welcome post
    -- exists for the moment of joining or not at all), and it is why the
    -- toggle is a write-time gate here rather than a read-time filter like
    -- every other use of show_attendance in the module.
    if v_def.threshold > 1 and coalesce(v_profile.show_attendance, false) then
      -- "Already posted this milestone" is answered by looking at
      -- workout_posts itself - a POST_ATTENDANCE_MILESTONE row already
      -- carrying this member and this count - rather than by a second piece
      -- of tracking state that could drift from what was actually posted.
      -- Identical in shape to challenge_progress_apply's cooperative
      -- threshold check and post_new_member_on_join's one-welcome-ever
      -- guard, and backed by the same kind of partial expression index.
      --
      -- Deliberately a guard rather than a unique index, the reason
      -- 202608290014 spells out: a unique violation here would abort the
      -- enclosing transaction, which is a member's training-log sync. A
      -- duplicate feed post is a far smaller harm than a member who cannot
      -- sync.
      select exists (
        select 1 from public.workout_posts
        where post_type = 'POST_ATTENDANCE_MILESTONE'
          and (metadata ->> 'member_id') = new.user_id::text
          and (metadata ->> 'count')::numeric = v_def.threshold
      ) into v_already;

      if not v_already then
        -- The metadata shape is fixed by an already-shipped renderer:
        -- renderAttendanceMilestonePostCard in cloud.js reads exactly
        -- `milestone_label` (its title line) and `count` (its result line),
        -- and contracts.md has recorded those two keys since Phase 1.
        -- Inventing a tidier shape here would silently break a card that is
        -- already in members' hands.
        --
        -- `member_id` is the one key beyond that contract. The renderer
        -- ignores it; the idempotency check above requires it, since
        -- "this member and this count" is the whole of the rule. Same key
        -- name and same role it has in POST_NEW_MEMBER's metadata.
        --
        -- `milestone_label` is the definition's own `name`, not a string
        -- composed here, so the post and the achievement badge on the
        -- member's profile can never announce two different things. Renaming
        -- the milestone is an UPDATE to that one row.
        --
        -- Authorless (author_id null), visibility 'club', status 'active',
        -- source_type 'member' - the same shape post_new_member_on_join
        -- writes and challenge_progress_apply's cooperative milestone
        -- writes, which is what COMM-305 asks for by name.
        insert into public.workout_posts
          (author_id, post_type, visibility, body, metadata, status, published_at, club_id,
           source_type, source_id, occurred_on)
        values (
          null, 'POST_ATTENDANCE_MILESTONE', 'club',
          v_name || ' השלימ/ה ' || v_def.threshold::integer::text || ' אימונים',
          jsonb_build_object(
            'member_id', new.user_id,
            'milestone_label', v_def.name,
            'count', v_def.threshold::integer
          ),
          'active', now(), new.club_id,
          'member', new.user_id, new.occurred_on
        );
      end if;
    end if;
  end loop;

  -- --- the weekly streak, repeatable ----------------------------------
  -- THE FRESH-CROSSING RULE, and the one place a naive reading of
  -- "repeatable" would be wrong. attendance_weekly_streak is repeatable with
  -- threshold 4, and ach_claim's own rule for a repeatable definition is
  -- "write a fresh row each qualifying event" (contracts.md, ach_claim side
  -- effects). The qualifying EVENT here is reaching a fresh 4-week streak -
  -- not being in one. A bare `streak >= 4` test would re-fire on every
  -- single training day for the rest of a member's 40-week run, which is
  -- neither what the badge means nor what any member would read it as.
  --
  -- So this is a genuine two-sided crossing test, with the "before" computed
  -- by excluding exactly the day this row just added:
  --
  --   fires   week 4 of a run reached (before 3, after 4)
  --   silent  weeks 5, 6, 7 ... of that same run (before >= 4 already)
  --   silent  a second training day inside an already-counted week (the week
  --           survives the exclusion, so before = after)
  --   fires   again on week 4 of a LATER run, after the streak has been
  --           broken and rebuilt - which is the whole point of the code
  --           being repeatable rather than once-ever
  --
  -- Both numbers come from attendance_week_streak(), so this branch and
  -- COMM-306's leaderboard/profile streak cannot disagree about what a
  -- streak is. The two calls are made lazily, only if an enabled repeatable
  -- definition actually exists, so disabling the code costs nothing.
  --
  -- AND THIS IS WHY THIS BRANCH IS SHAPED DIFFERENTLY FROM THE COUNT
  -- BRANCH ABOVE. "Have they got the badge already" is a state, so a count
  -- milestone can be answered from the table plus a unique index and needs
  -- no notion of an event at all. "Did a FRESH streak just start
  -- qualifying" is irreducibly an event: the member has held a qualifying
  -- streak before, is meant to earn the badge again, and the only thing that
  -- distinguishes the qualifying day from the 40 days after it is the row
  -- that caused it. There is no index that can express that, which is
  -- exactly why ach_claim's repeatable rule is "a fresh row per qualifying
  -- event" and not "on conflict do nothing".
  --
  -- The consequence, stated rather than buried: because it is an event test,
  -- a MULTI-ROW insert into attendance_log awards no streak badge. Every row
  -- of such a statement sees the whole statement's rows (Postgres queues
  -- AFTER FOR EACH ROW triggers to the end of the statement), so excluding
  -- any single day leaves the streak unchanged and nothing crosses. That is
  -- the right answer rather than a gap: a bulk import of a member's history
  -- is not a training event, and the alternatives are awarding one badge
  -- arbitrarily or awarding a dozen at once. The production writer,
  -- attendance_log_from_record(), inserts exactly one row per statement.
  -- The count branch above is unaffected by the same situation because it
  -- reads state.
  --
  -- Note also that a streak has to be LIVE to count, because
  -- attendance_week_streak() carries consistency_week_streaks()' anchor rule:
  -- a member back-filling four consecutive weeks that ended two months ago
  -- earns nothing, since they do not have a four-week streak now. That is
  -- the same number their profile and the consistency board would show them.
  v_streak := null;
  for v_def in
    select d.id, d.code, d.name, d.threshold, d.visibility
    from public.achievement_definitions d
    where d.trigger_type = 'ATTENDANCE_RECORDED'
      and d.enabled
      and d.threshold is not null
      and d.repeatable
    order by d.threshold
  loop
    if v_streak is null then
      v_streak        := public.attendance_week_streak(new.user_id, null);
      v_streak_before := public.attendance_week_streak(new.user_id, new.occurred_on);
    end if;

    continue when not (v_streak >= v_def.threshold and v_streak_before < v_def.threshold);

    -- No `on conflict` target is possible or wanted for a repeatable
    -- definition: member_achievements_once_idx is partial on
    -- `not repeatable` and does not cover this row. The crossing test above
    -- is the whole of the idempotency, which is exactly the shape ach_claim
    -- documents for its own repeatable codes - a fresh row per qualifying
    -- event, no unique index to lean on.
    insert into public.member_achievements (user_id, achievement_id, visibility)
    values (new.user_id, v_def.id, v_def.visibility);

    -- No post. COMM-305 confines POST_ATTENDANCE_MILESTONE to the two count
    -- milestones; a streak is an achievement unlock only.
  end loop;

  return new;
end $$;

revoke all on function public.attendance_milestones_on_log() from public, anon, authenticated;

comment on function public.attendance_milestones_on_log() is
  'COMM-305. AFTER INSERT trigger on public.attendance_log (fires as attendance_log_milestones), security definer. Unlocks the ATTENDANCE_RECORDED achievements, with every threshold read from achievement_definitions rather than restated. Non-repeatable count milestones fire when the member''s all-time distinct occurred_on count reaches the threshold and they do not already hold the code, exactly once, decided by member_achievements_once_idx. The repeatable weekly-streak code fires on a genuine fresh crossing - attendance_week_streak() computed with and without the day just inserted, firing only when the threshold sits between the two - so it repeats on a later rebuilt streak and stays silent for every day of a run already qualifying. For a count milestone above the first-day threshold it also posts one authorless club-visible POST_ATTENDANCE_MILESTONE row, metadata {member_id, milestone_label, count}, gated at write time on the member''s own show_attendance read directly off profiles; the achievement is never gated on it (achievements carry show_achievements). Never client-callable, and ach_claim independently refuses every ATTENDANCE_RECORDED code.';

create trigger attendance_log_milestones
  after insert on public.attendance_log
  for each row
  execute function public.attendance_milestones_on_log();

-- Serves the "already posted this milestone" guard above. Mirrors
-- workout_posts_challenge_metadata_idx (202608290004) and
-- workout_posts_new_member_metadata_idx (202608290014) exactly.
create index if not exists workout_posts_attendance_milestone_metadata_idx
  on public.workout_posts ((metadata ->> 'member_id'))
  where post_type = 'POST_ATTENDANCE_MILESTONE';

-- =====================================================================
-- No backfill, and this is the one place it matters most in Phase 3
-- =====================================================================
-- 202608310001 backfilled attendance_log from the private_records rows that
-- already existed, and said in as many words why it was safe to do so there
-- and would not be here: "COMM-305 adds an AFTER INSERT trigger on this
-- table that mints achievements and posts milestones, and that trigger does
-- not exist yet, so this backfill cannot spam anybody's feed or
-- notifications. Run after COMM-305, the same rows would."
--
-- Migrations apply in order, so that ordering holds on every fresh database
-- as well as on the deployed one: the backfill is finished before this
-- trigger exists, and no member is awarded anything at migration time. There
-- is no backfill of achievements or of milestone posts here, for the reason
-- 202608290014 gave about historical welcome posts: those are club-visible
-- and member-notifying, and publishing a club's whole history at once is a
-- product action with a chosen schedule, not a migration side effect.
--
-- WHAT DOES HAPPEN, AND IT IS DELIBERATE. Because the count branch reads
-- state rather than a delta (see its comment), a member whose backfilled
-- history already stands at 60 days earns attendance_first_class and
-- attendance_25_classes on their NEXT logged session - once each, spread
-- across the club as members sync, never in a burst at deploy time. That is
-- the honest answer to "have they attended 25 classes": they have. The
-- alternative, staying silent forever about milestones a member genuinely
-- passed, is the thing that would need defending.
--
-- The feed consequence of that is bounded by the privacy gate rather than by
-- luck: a milestone POST is written only for a member whose own
-- show_attendance is on, and show_attendance defaults to FALSE
-- (202608280003). On deploy day the club therefore sees achievement unlocks
-- and, from the handful of members who have opted in, one milestone post
-- each at most.

commit;
