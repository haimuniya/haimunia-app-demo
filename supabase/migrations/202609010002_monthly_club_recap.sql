begin;

-- COMM-309, schema half. The monthly club recap: one aggregate, club-wide
-- summary per calendar month, generated as a DRAFT that no member can see,
-- and published by a staff member through one action.
--
-- WHAT LANDS HERE
--   * public.monthly_club_recaps               table + RLS (read-only client surface)
--   * public.monthly_club_recaps_freeze()      trigger: a published row is immutable
--   * public.recap_monthly_generate(date)      service-role only, the generation unit
--   * public.recap_monthly_publish(uuid)       staff, the only writer of published_at
--   * two new admin_actions labels: action_type 'monthly_recap_publish',
--     target_type 'monthly_club_recap'
--
-- THE ONE IMPLEMENTATION DECISION THIS TICKET LEFT OPEN, decided here in
-- the open the way COMM-304 and COMM-315 recorded theirs:
--
--   GENERATION IS A POSTGRES FUNCTION, NOT AN EDGE FUNCTION.
--
-- COMM-309's own wording ("runs as a scheduled Edge Function, same shape as
-- recap_weekly") and contracts.md's `recap_monthly_club` stub both pointed
-- at `supabase/functions/recap_monthly/index.ts`. That was the right shape
-- for `recap_weekly` and is the wrong shape here, for four reasons:
--
--   1. recap_weekly is per-member. It runs one query set per active member,
--      builds five JSON blobs per row, and needs a real client library to
--      do it. This job produces exactly ONE row from five COUNT(*)s over
--      tables that all live in this database. Expressed in TypeScript it is
--      five REST round trips through PostgREST to compute five integers
--      Postgres could count without leaving the process.
--   2. The security gap found and fixed in recap_weekly last session is a
--      standing footgun. Supabase's default `verify_jwt` accepts ANY valid
--      JWT, including the public anon key that already ships in
--      cloud-config.js, so an Edge Function that "runs as service_role" is
--      not the same thing as an Edge Function only the service role can
--      CALL. recap_weekly now compares the Authorization header against the
--      real service role key by hand. A second Edge Function is a second
--      place to get that right, and a second place for it to be forgotten.
--      A Postgres function granted to `service_role` and revoked from
--      `public`, `anon` and `authenticated` has no equivalent hole: the
--      grant IS the gate, and PostgREST will not call what the caller's
--      role cannot execute.
--   3. Idempotency is the hard requirement of this ticket, and the
--      mechanism that makes it true - "update the draft in place, never
--      duplicate, never touch a published row" - is one `insert ... on
--      conflict (month_start) do update ... where published_at is null`
--      statement. In the database that is atomic under concurrency by
--      construction. Over REST it is a read-then-write with a race in the
--      middle, which is exactly the read-then-write recap_weekly has to
--      perform for its "did this row already exist" check.
--   4. It matches the two most recent precedents in this session -
--      `chal_notify_ending_soon()` (202608290006) and
--      `coach_detect_engagement_decline()` (202608310008) - both of which
--      are scheduled jobs expressed as service-role-only Postgres
--      functions, with the scheduler itself deliberately not built.
--
-- The client half needs to know: THE CLIENT NEVER CALLS GENERATION. It
-- calls `recap_monthly_publish(p_id)` and it reads `monthly_club_recaps`
-- directly under RLS. `recap_monthly_generate()` is not reachable from a
-- browser at all, by grant.
--
-- SCHEDULER IS NOT BUILT HERE, and the consequence is stated rather than
-- hidden: with no pg_cron entry and no scheduled invoker, NO DRAFT EVER
-- APPEARS ON ITS OWN. Until a scheduler exists, a draft is produced by
-- invoking `select public.recap_monthly_generate();` as the service role.
-- That is the same open infra item `notif_batch_flush_due()`,
-- `chal_notify_ending_soon()`, `coach_detect_engagement_decline()` and
-- `recap_weekly` all already carry, and it is why the staff preview surface
-- must render an honest empty state rather than assume a row is there.
--
-- CADENCE, in exactly one place, the way 202608310006 records
-- recompute_feed_weights'. This is the SECOND rhythm the module has - that
-- file argued for "one periodic rhythm rather than three" and settled on
-- weekly; a monthly recap cannot be weekly, and COMM-309's whole subject is
-- a calendar month, so this is a deliberate second cadence rather than a
-- drift. It runs on the 1st, after the month it summarises has closed:
--
--     select cron.schedule('recap_monthly', '41 4 1 * *',
--       $cron$ select public.recap_monthly_generate(); $cron$);
--
-- Not executed here: pg_cron is not guaranteed present in the CI stack, and
-- no schema below depends on it. Changing the cadence is an edit to that
-- one commented line.

-- =====================================================================
-- 0. admin_actions gains one action_type and one target_type label
-- =====================================================================
-- 202608280002 pinned both lists closed and 202609010001 widened
-- action_type once, to twelve. This adds the thirteenth. Reusing
-- 'privacy_config' or 'achievement_edit' would make the audit log describe
-- something that did not happen, which is the one thing an audit log may
-- not do.
--
-- target_type IS widened this time, unlike 202609010001 which found
-- 'member' already exactly right. COMM-309 names `target_type =
-- 'monthly_club_recap'` in as many words, and none of the ten existing
-- values fits: the subject of the action is the recap row itself. It is not
-- an 'announcement' (that table is untouched here), not a 'post' (no
-- workout_posts row is written), and not the 'club'.
alter table public.admin_actions drop constraint if exists admin_actions_action_type_check;
alter table public.admin_actions add constraint admin_actions_action_type_check check (action_type in (
  'content_delete', 'content_hide', 'member_restrict', 'member_unrestrict',
  'role_change', 'challenge_edit', 'achievement_edit', 'privacy_config',
  'content_pin', 'content_unpin', 'report_review',
  -- COMM-315.
  'member_of_week_publish',
  -- COMM-309.
  'monthly_recap_publish'
));

alter table public.admin_actions drop constraint if exists admin_actions_target_type_check;
alter table public.admin_actions add constraint admin_actions_target_type_check check (target_type in (
  'post', 'comment', 'member', 'role', 'challenge', 'achievement',
  'event', 'announcement', 'report', 'club',
  -- COMM-309.
  'monthly_club_recap'
));

-- =====================================================================
-- 1. monthly_club_recaps - the table
-- =====================================================================
-- AGGREGATE ONLY. This is the hard privacy rule of the ticket and it is
-- enforced by the SHAPE of the table, not by a policy and not by a
-- convention the generator is trusted to follow: there is no user_id
-- column, no jsonb column, no text column, and no array. Every column here
-- is a club-wide integer, a date, or a timestamp. There is nowhere for a
-- member name, a handle, an avatar, or an individually-attributable figure
-- to be written even by a careless future producer, which is a strictly
-- stronger guarantee than `weekly_recaps.club_challenge_progress`
-- (202608290011) has - that field is a jsonb blob whose aggregate-only rule
-- lives in a comment and in recap_weekly's code. Same rule, harder floor.
--
-- Do not add a `top_members`, a `highlights`, or a `most_improved` column
-- here. That is not a style preference: COMM-309's whole reason for a staff
-- preview step is that this is a club-wide, permanent, published summary,
-- and the first place aggregate attendance figures become club-visible at
-- all. A per-member breakdown in it would publish attendance data that no
-- surface in this module has ever been allowed to expose.
create table if not exists public.monthly_club_recaps (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null default public.default_club_id() references public.clubs(id),

  -- The first of the calendar month the recap covers. The CHECK is the same
  -- load-bearing one weekly_recaps.week_start and member_of_week.week_start
  -- both carry, for the same reason: the unique key below is what makes
  -- generation idempotent per month, and a key on a free-form date is only
  -- unique per DATE, not per month. Without it a run keying the 1st and a
  -- run keying the 3rd would both insert and the club would get two recaps
  -- for one month. recap_monthly_generate() normalises its input before it
  -- ever gets here, so this is a backstop against a future direct writer.
  month_start date not null unique check (extract(day from month_start) = 1),

  -- The five aggregate figures, all club-wide, all non-negative. A month
  -- with nothing in it still gets an honest row of zeros rather than a
  -- null-shaped one - the same "quiet week floor" reasoning weekly_recaps
  -- records for its own defaults.
  --
  -- The >= 0 CHECKs are an addition to the ticket's outline, matching
  -- weekly_recaps.sessions_completed. A count can never be negative, so the
  -- constraint only ever catches a writer that is not counting.
  sessions_logged      integer not null default 0 check (sessions_logged >= 0),
  posts_created        integer not null default 0 check (posts_created >= 0),
  new_members          integer not null default 0 check (new_members >= 0),
  challenges_completed integer not null default 0 check (challenges_completed >= 0),
  events_held          integer not null default 0 check (events_held >= 0),

  generated_at timestamptz not null default now(),

  -- NULL means DRAFT, and draft is the state every row starts in. This is
  -- the whole of COMM-309's preview step: a null here makes the row
  -- invisible to every plain member (the select policy below) and means no
  -- notification has fired. Only recap_monthly_publish() ever sets it, and
  -- once set the freeze trigger below makes it unmovable.
  --
  -- Deliberately NOT a `status` enum with draft/published/archived. There
  -- are exactly two states and the timestamp carries both the state and
  -- when it changed; a separate column would be a second thing to keep in
  -- sync with this one.
  published_at timestamptz
);

-- The staff preview reads the newest month first; the member surface reads
-- published months newest first. The unique constraint's index on
-- month_start serves both (Postgres scans it backwards for DESC), so the
-- only additional index is the partial one for the member's question,
-- which always carries `published_at is not null`.
create index if not exists monthly_club_recaps_published_idx
  on public.monthly_club_recaps(month_start desc) where published_at is not null;

alter table public.monthly_club_recaps enable row level security;

-- SELECT only, for authenticated. NO insert, update or delete grant and no
-- policy for any of the three, for any client role - not for a coach, not
-- for an admin, not for the owner. The same shape `pins` (202608280017),
-- `attendance_log` (202608310001) and `member_of_week` (202609010001) all
-- use, and here it is what makes three separate acceptance criteria true at
-- once: a draft cannot be hand-written into existence, a figure cannot be
-- edited after the fact, and a published recap cannot be un-published.
revoke all on public.monthly_club_recaps from public, anon;
grant select on public.monthly_club_recaps to authenticated;

-- TWO permissive SELECT policies rather than one with an OR, because they
-- are two different audiences answering two different questions, and a
-- reviewer (or a pgTAP assertion on polname) can see both. Permissive
-- policies OR together, so the effective rule is exactly the ticket's:
-- staff see every row, a plain member sees only published ones.
--
-- The staff predicate is `has_perm('community.analytics.view') or
-- is_staff()`, copied verbatim from attendance_log's own staff read policy
-- (202608310001) so the two tables answer "who is staff enough to see
-- unpublished club-wide attendance figures" identically.
--
-- NOTE THE DELIBERATE ASYMMETRY WITH PUBLISHING. is_staff() is coach rank
-- and above, so a COACH can preview a draft. recap_monthly_publish() below
-- requires `community.analytics.view` or `is_admin()`, which a coach does
-- NOT hold (202608280001 seeds that permission to admin and owner only).
-- That is COMM-309's outline read literally - "RLS: staff/
-- community.analytics.view select any row" for the read, "requires
-- community.analytics.view or admin" for the function - and it is the right
-- way round: looking at a draft is not an act, publishing a permanent
-- club-wide summary is. The client half must therefore gate the "פרסם"
-- control on the permission and not merely on staffness, or a coach will be
-- shown a button the database refuses.
create policy monthly_club_recaps_staff_select on public.monthly_club_recaps
  for select to authenticated
  using (public.has_perm('community.analytics.view') or public.is_staff());

create policy monthly_club_recaps_published_select on public.monthly_club_recaps
  for select to authenticated
  using (published_at is not null);

comment on table public.monthly_club_recaps is
  'COMM-309. One row per calendar month of club-wide AGGREGATE figures. Aggregate-only is enforced by the table shape: no user_id, no jsonb, no text column, so there is nowhere for a member name or an individually-attributable figure to live. published_at null means DRAFT - invisible to plain members, no notification sent. Two permissive select policies: staff/community.analytics.view read every row, any authenticated member reads a published one. No insert, update or delete grant and no write policy for any client role; public.recap_monthly_generate() (service role) and public.recap_monthly_publish() are the only writers, and a published row is frozen by monthly_club_recaps_freeze().';

comment on column public.monthly_club_recaps.published_at is
  'Null means draft. Set once, only by recap_monthly_publish(), and immutable afterwards - the freeze trigger raises on any UPDATE of a row whose published_at is already set, so a published recap cannot be un-published or edited, including by the service role.';

comment on column public.monthly_club_recaps.sessions_logged is
  'Club-wide count of attendance_log days in the month. The first place an aggregate attendance figure becomes club-visible; never a per-member breakdown.';

-- =====================================================================
-- 2. A published recap is immutable
-- =====================================================================
-- COMM-309: "A published recap cannot be un-published or edited by this
-- ticket's scope - a mistaken figure is corrected by staff manually
-- adjusting the next real data source, not by rewriting a historical
-- recap." No client can write this table at all, so this trigger is not
-- about clients. It is about the two writers that CAN: recap_monthly_
-- generate() and any future service-role caller, which bypasses RLS
-- entirely. Without it, "cannot be un-published" would be a property of
-- the generator's SQL rather than a property of the table.
--
-- RAISES rather than silently pinning, which is the opposite of
-- onboarding_progress_pin_shown() (202608290011). The reasoning there was
-- that two tabs both dismissing a welcome card is a benign race not worth
-- surfacing. Nothing about this table is a benign race: every legitimate
-- update path already checks published_at before it writes, so reaching
-- this trigger at all means a caller is doing something it did not intend,
-- and swallowing that would leave whoever wrote it believing the edit
-- landed.
--
-- Generation never trips this. Its `on conflict do update` carries
-- `where published_at is null`, so for a published month no UPDATE is
-- executed and no trigger fires - the rerun is a genuine no-op, not a
-- refused write.
--
-- DELETE is deliberately NOT guarded. There is no delete grant for any
-- client role, so the only deleter is the service role or a future
-- migration, and blocking those would make an operator's deliberate act -
-- or a later data migration - need a trigger drop first. The rule this
-- ticket owns is about editing and un-publishing a row that is there.
create or replace function public.monthly_club_recaps_freeze() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.published_at is not null then
    raise exception 'a published monthly recap is immutable';
  end if;
  return new;
end $$;

drop trigger if exists monthly_club_recaps_freeze_published on public.monthly_club_recaps;
create trigger monthly_club_recaps_freeze_published
  before update on public.monthly_club_recaps
  for each row execute function public.monthly_club_recaps_freeze();

comment on function public.monthly_club_recaps_freeze() is
  'COMM-309. BEFORE UPDATE guard: raises ''a published monthly recap is immutable'' (P0001) for any update of a row whose published_at is already set. Aimed at the service role, which bypasses RLS - no client has a write grant on this table at all. Never reached by recap_monthly_generate(), whose upsert carries `where published_at is null` and therefore executes no UPDATE for a published month.';

-- =====================================================================
-- 3. recap_monthly_generate(p_month_start date default null) returns uuid
-- =====================================================================
-- The generation unit, and the whole of it. See the decision note at the
-- top of this file for why this is a Postgres function and not an Edge
-- Function.
--
-- AUTH. Same shape as `chal_notify_ending_soon()` (202608290006),
-- `notif_batch_flush_due()` (202608280028) and
-- `coach_detect_engagement_decline()` (202608310008): `security definer`,
-- granted to `service_role` and to nobody else, and - the documented
-- exception to this schema's standing rule - it does NOT check auth.uid()
-- first. A scheduled job has no session, so an auth.uid() gate would reject
-- every legitimate call and pass none. The grant is the gate.
--
-- It is definer for one boundary, on purpose: `attendance_log` is own-row
-- plus staff (202608310001) and `invite_redemptions` is own-row only
-- (202608270003), so counting either club-wide crosses RLS. It reads those
-- as the owner and writes back a count, never a row.
--
-- WHICH MONTH. Null means the most recently COMPLETED calendar month,
-- which is the same reasoning recap_weekly's targetWeek() records for its
-- own "never the current, still-running week": a recap for a month that has
-- not finished would keep changing shape under whoever opened it, and a
-- staff member previewing a half-month would be previewing a figure that is
-- about to be wrong. Any other date is normalised to the first of its own
-- month rather than rejected, the same courtesy member_of_week_candidates()
-- extends to a mid-week date.
--
-- IDEMPOTENT PER CALENDAR MONTH, in one statement. The `on conflict
-- (month_start) do update` clause updates the draft IN PLACE, so a rerun
-- can never produce a second row for a month. The `where published_at is
-- null` on that clause is what makes the second half of the rule true: for
-- an already-published month no UPDATE is executed at all, so not one of
-- the five figures moves, generated_at does not move, and published_at
-- cannot move. Note also what is NOT in the insert column list and NOT in
-- the update SET list: `published_at`. Generation is structurally incapable
-- of publishing anything, which is why "no notification fires until a staff
-- member publishes" does not depend on this function remembering.
--
-- Returns the row id in every case - a fresh insert, a refreshed draft, or
-- an untouched published month - so a scheduler log line can name the row
-- it acted on without a second query. A `do update ... where` whose
-- predicate is false returns no row from RETURNING, which is exactly how
-- the "already published, did nothing" branch is detected below.
create or replace function public.recap_monthly_generate(p_month_start date default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_month date;
  v_next  date;
  v_id    uuid;
  v_sessions   integer;
  v_posts      integer;
  v_new        integer;
  v_challenges integer;
  v_events     integer;
begin
  -- The first of the month. Null -> the month before the current one.
  v_month := date_trunc('month',
               coalesce(p_month_start, (current_date - interval '1 month')::date)::timestamp
             )::date;
  v_next := (v_month + interval '1 month')::date;

  -- -------------------------------------------------------------------
  -- The five figures. Every one is a bare COUNT over the whole club with
  -- no user_id in the output and no grouping by member. There is nothing
  -- to filter for privacy because nothing per-member leaves these queries.
  --
  -- No club_id filter anywhere, deliberately and consistently with the
  -- rest of the module: 202608280001 established that club_id exists so a
  -- second club is a data migration rather than a schema rewrite, and
  -- "nothing reads it as a filter today". The day that changes, it changes
  -- here along with every other reader.
  --
  -- TIMEZONE, stated rather than left implicit. `sessions_logged` is
  -- exact: attendance_log.occurred_on is a bare date, so its month
  -- boundaries are calendar boundaries. The other four compare a
  -- timestamptz against `v_month::timestamptz`, which resolves at the
  -- CALLING SESSION's TimeZone - UTC for PostgREST and for the service
  -- role, which is the only caller. That matches recap_weekly, which
  -- computes its ISO weeks in UTC. A caller that did `set time zone
  -- 'Asia/Jerusalem'` first would shift those four boundaries by two or
  -- three hours, moving at most a handful of rows between adjacent months.
  -- Pinning a zone here was considered and not done: it would make this the
  -- only function in the module with an opinion about the club's local
  -- time, and that opinion belongs in one module-wide decision, not in a
  -- monthly recap.
  -- -------------------------------------------------------------------

  -- 1. SESSIONS LOGGED. attendance_log is unique on (user_id,
  -- occurred_on), so a row count is a count of member-training-days, which
  -- is what "total sessions logged" means for a club. Counted for every
  -- member who trained, including one who has since soft-deleted their
  -- profile: they did train that month, and a club total that quietly
  -- shrank when somebody left would not be an honest record of the month.
  select count(*)::integer into v_sessions
  from public.attendance_log a
  where a.occurred_on >= v_month and a.occurred_on < v_next;

  -- 2. POSTS CREATED. Four clauses, each doing separate work:
  --   deleted_at is null / status = 'active'  a removed or hidden post is
  --                        not part of the month's record. Same pair every
  --                        feed reader in this schema applies.
  --   visibility <> 'only_me'  a post only its author can see was not a
  --                        contribution to the community's month. It is
  --                        counted nowhere else club-wide either.
  --   author_id is not null    excludes the club's OWN authorless
  --                        announcements - member_of_week_publish
  --                        (202609010001) writes one every week. "How much
  --                        did the community post" must not be inflated by
  --                        posts the club itself generated.
  -- created_at rather than published_at: created_at is the row's own
  -- insert stamp and every producer leaves it to its default, whereas
  -- published_at is passed explicitly by producers (post_create and
  -- member_of_week_publish both pass now()) and is what 202608280004's
  -- backfill copied the legacy rows' created_at FROM. The two agree today;
  -- created_at is the one that stays right the day a producer backdates a
  -- publish.
  select count(*)::integer into v_posts
  from public.workout_posts w
  where w.created_at >= v_month::timestamptz
    and w.created_at <  v_next::timestamptz
    and w.deleted_at is null
    and w.status = 'active'
    and w.visibility <> 'only_me'
    and w.author_id is not null;

  -- 3. NEW MEMBERS. invite_redemptions.redeemed_at is this module's
  -- authoritative MEMBER_JOINED timestamp - 202608290011 says so in as many
  -- words, seed_onboarding_progress fires from it and the tenure
  -- achievements meter off it - so it is what this counts, rather than
  -- profiles.created_at (which exists before the member is a member) or
  -- auth.users.created_at (which counts anonymous profiles that never
  -- redeemed anything).
  --
  -- KNOWN LIMITATION, flagged rather than hidden: grant_coach_role() and
  -- grant_coach_role_by_handle() UPDATE invite_redemptions and move
  -- redeemed_at (202608290011 records exactly this, which is why the
  -- onboarding seed trigger is INSERT-only). Promoting an existing member
  -- to coach therefore re-dates them into the month of the promotion and
  -- they are counted as a new member for that month. There is no second
  -- join timestamp in the schema to fall back on; fixing it properly means
  -- giving invite_redemptions an immutable joined_at, which is a change to
  -- a shipped table this ticket has no business making.
  select count(*)::integer into v_new
  from public.invite_redemptions ir
  where ir.redeemed_at >= v_month::timestamptz
    and ir.redeemed_at <  v_next::timestamptz;

  -- 4. CHALLENGES COMPLETED. Completions, club-wide, not distinct
  -- challenges: five members finishing one challenge is five completions,
  -- which is what a club recap means by "total challenges completed".
  -- `status <> 'withdrawn'` and `c.status <> 'draft'` are the same two
  -- filters member_of_week_candidate_set's completion branch applies, so
  -- the two never disagree about what a completion is.
  select count(*)::integer into v_challenges
  from public.challenge_participants cp
  join public.challenges c on c.id = cp.challenge_id
  where cp.completed_at >= v_month::timestamptz
    and cp.completed_at <  v_next::timestamptz
    and cp.status <> 'withdrawn'
    and c.status <> 'draft';

  -- 5. EVENTS HELD. Keyed on start_at: an event is held on the day it
  -- starts. 'draft' never reached the club and 'cancelled' did not happen,
  -- so both are excluded; 'published' and 'past' are both counted, because
  -- nothing in this schema automatically flips a finished event from
  -- 'published' to 'past' and excluding one of the two would undercount
  -- every month depending on whether a human had tidied the status.
  select count(*)::integer into v_events
  from public.events e
  where e.start_at >= v_month::timestamptz
    and e.start_at <  v_next::timestamptz
    and e.status in ('published', 'past');

  -- -------------------------------------------------------------------
  -- The upsert. club_id is omitted so default_club_id() fires, the same
  -- way every other table in this schema takes it (and the grant that
  -- makes that work for a service-role caller landed in 202608290011).
  -- published_at appears in neither the column list nor the SET list.
  -- -------------------------------------------------------------------
  insert into public.monthly_club_recaps
    (month_start, sessions_logged, posts_created, new_members,
     challenges_completed, events_held, generated_at)
  values
    (v_month, v_sessions, v_posts, v_new, v_challenges, v_events, now())
  on conflict (month_start) do update
    set sessions_logged      = excluded.sessions_logged,
        posts_created        = excluded.posts_created,
        new_members          = excluded.new_members,
        challenges_completed = excluded.challenges_completed,
        events_held          = excluded.events_held,
        generated_at         = now()
    where public.monthly_club_recaps.published_at is null
  returning id into v_id;

  -- Reached only when the conflict target existed AND the update predicate
  -- was false, i.e. the month is already published. Nothing was written.
  if v_id is null then
    select r.id into v_id
    from public.monthly_club_recaps r where r.month_start = v_month;
  end if;

  return v_id;
end $$;

revoke all on function public.recap_monthly_generate(date)
  from public, anon, authenticated;
grant execute on function public.recap_monthly_generate(date) to service_role;

comment on function public.recap_monthly_generate(date) is
  'COMM-309 monthly club recap generation, chosen as a Postgres function rather than a recap_monthly Edge Function (see the migration header for the four reasons). service_role only: revoked from public, anon and authenticated, and - the documented exception a scheduled job carries - no auth.uid() check, because there is no session to check. p_month_start null means the most recently COMPLETED calendar month; any other date is normalised to the first of its own month. Computes five club-wide aggregate counts (attendance days, member-authored non-private active posts, invite redemptions, non-withdrawn completions on non-draft challenges, published/past events) and upserts one monthly_club_recaps row keyed on month_start. Idempotent: a rerun updates the draft in place and can never duplicate. published_at is in neither the insert column list nor the update SET list, and the ON CONFLICT clause carries `where published_at is null`, so a rerun for a published month writes nothing at all. Returns the row id in every case, including the no-op. No scheduler is built here - the same open item chal_notify_ending_soon(), notif_batch_flush_due(), coach_detect_engagement_decline() and recap_weekly all carry.';

-- =====================================================================
-- 4. recap_monthly_publish(p_id uuid) returns void
-- =====================================================================
-- The only writer of published_at, and the moment a draft becomes a thing
-- the club has been told about. Three side effects, one transaction: the
-- stamp, the fan-out, the audit row.
--
-- AUTH. `community.analytics.view` OR real `is_admin()`, checked inline
-- after auth.uid(), exactly as COMM-309 specifies. Note this is NARROWER
-- than the table's staff read policy - see the long note on that policy for
-- why a coach may preview but not publish. `is_admin()` here is the
-- table-driven role_rank >= 50 helper from 202608280001, which resolves
-- through my_role_code() and therefore also answers true for the legacy
-- profiles.is_admin flag and for the owner.
--
-- WHAT THE NOTIFICATION SAYS. Aggregate figures only, in the body text as
-- well as in the row: three club totals and no member reference of any
-- kind. The same rule the table's shape enforces, restated where a human
-- writes a string.
--
-- TWO INHERITED BEHAVIOURS OF THE FAN-OUT, stated because they are real and
-- because they follow from calling notif_create() with a live staff session
-- rather than from anything decided here. Both are exactly what
-- notif_announcement_fanout (202608280027) already does for a club
-- announcement, which is the closest existing analogue:
--
--   * THE PUBLISHER GETS NO NOTIFICATION. notif_create() suppresses a row
--     whose recipient is the actor for every type except the two
--     self-directed ones. The publisher is looking at the recap; telling
--     them about it would be noise.
--   * A MEMBER WHO HAS A BLOCK EDGE WITH THE PUBLISHER GETS NO
--     NOTIFICATION. notif_create() checks notif_blocked_between(recipient,
--     actor). This differs from recap_weekly's weekly_recap fan-out, where
--     the actor is null (service role, no session) and the block check is
--     therefore a no-op. It is the conservative direction - a suppressed
--     notification, never a leaked one - and the recap itself is readable
--     by that member the moment it is published, so nothing is withheld
--     but the ping.
--
-- The membership set is the same one notif_announcement_fanout and
-- recap_weekly both use: a non-deleted profile with an invite_redemptions
-- row. Not WCAM, which answers "did something this week" and would exclude
-- exactly the quiet members a club summary is for.
--
-- The whole-club loop is the fan-out cost 202608280027 already flagged as a
-- schema concern. This runs twelve times a year against a single small
-- club; batching a large club remains the same later ticket.
create or replace function public.recap_monthly_publish(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid;
  v_row    public.monthly_club_recaps;
  v_member uuid;
  v_sent   integer := 0;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not (public.has_perm('community.analytics.view') or public.is_admin()) then
    raise exception 'not authorized';
  end if;

  -- FOR UPDATE, so two staff members hitting the button at the same moment
  -- serialise here and the second one sees the first one's published_at
  -- rather than both fanning out. notif_create's one-hour dedupe would have
  -- caught the duplicate notifications, but not the duplicate admin_actions
  -- row, and this is cheaper than relying on either.
  select * into v_row from public.monthly_club_recaps r
  where r.id = p_id for update;
  if not found then raise exception 'recap not found'; end if;

  -- Checked and raised before anything is written, so the caller gets a
  -- readable error rather than the freeze trigger's. Both stand: this is
  -- the message, the trigger is the guarantee.
  if v_row.published_at is not null then
    raise exception 'recap already published';
  end if;

  update public.monthly_club_recaps set published_at = now() where id = p_id;

  -- Re-read, so the notification and the audit row carry the figures as
  -- they actually stand on the published row rather than the pre-update
  -- snapshot.
  select * into v_row from public.monthly_club_recaps r where r.id = p_id;

  for v_member in
    select p.id
    from public.profiles p
    where p.deleted_at is null
      and exists (select 1 from public.invite_redemptions ir where ir.user_id = p.id)
  loop
    if public.notif_create(
         v_member,
         'monthly_club_recap',
         'club',
         'סיכום החודש של הקהילה',
         -- Aggregate figures only. No name, no handle, no "you".
         v_row.sessions_logged::text || ' אימונים, ' ||
         v_row.posts_created::text || ' פוסטים ו-' ||
         v_row.new_members::text || ' חברים חדשים החודש.',
         'monthly_club_recap',
         v_row.id,
         '/community/recap/monthly?month=' || v_row.month_start::text
       ) is not null then
      v_sent := v_sent + 1;
    end if;
  end loop;

  -- One audit row, in the same transaction, so a failed log fails the whole
  -- publish. Same shape pin_set() and member_of_week_publish() use.
  -- after_data is aggregate-only too: a recipient LIST here would put
  -- per-member data into the audit log for a feature whose whole point is
  -- that it holds none, so it carries a COUNT. That count is also the
  -- "success and failure counts with no personal content" record COMM-309
  -- asks for - notified plus skipped is always the club size.
  perform public.log_admin_action(
    'monthly_recap_publish', 'monthly_club_recap', v_row.id, null,
    jsonb_build_object(
      'month_start',          v_row.month_start,
      'published_at',         v_row.published_at,
      'sessions_logged',      v_row.sessions_logged,
      'posts_created',        v_row.posts_created,
      'new_members',          v_row.new_members,
      'challenges_completed', v_row.challenges_completed,
      'events_held',          v_row.events_held,
      'notified',             v_sent
    )
  );
end $$;

revoke all on function public.recap_monthly_publish(uuid) from public, anon;
grant execute on function public.recap_monthly_publish(uuid) to authenticated;

comment on function public.recap_monthly_publish(uuid) is
  'COMM-309 publish a monthly club recap. security definer; auth.uid() checked first, then `has_perm(''community.analytics.view'') or is_admin()` - narrower than the table''s staff read policy, so a coach may PREVIEW a draft but not publish it. Refuses ''recap not found'' and ''recap already published'' (both P0001), the second checked under FOR UPDATE so two simultaneous publishes serialise. Side effects, one transaction: stamps published_at (which is also what makes the row readable by plain members), fans out one notif_create(''monthly_club_recap'', ''club'') per club member - a non-deleted profile with an invite_redemptions row - carrying aggregate figures only, and writes one admin_actions row of action_type ''monthly_recap_publish'' and target_type ''monthly_club_recap'' whose after_data holds the five figures plus a notified COUNT, never a recipient list. Inherited from notif_create with a live staff session, exactly as notif_announcement_fanout already inherits them: the publisher receives no notification, and neither does a member with a block edge to the publisher. Returns void. A published recap cannot be un-published or edited - monthly_club_recaps_freeze() raises on any further update.';

commit;
