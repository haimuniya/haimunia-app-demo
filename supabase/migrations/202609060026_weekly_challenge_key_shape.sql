begin;

-- Follow-up to fbf5a43 ("Stop asking a coach to type a database key"), which
-- replaced the free-text comparison_key field with a <select> and added two
-- client-side checks: the key's SHAPE, and whether the key NAMES SOMETHING
-- the app's catalog actually has.
--
-- THE GAP THAT LEAVES. weekly_challenges is INSERT-able and UPDATE-able over
-- PostgREST by any holder of community.challenge.create (202609060005), and
-- the only constraint on comparison_key since 202608270001 is
-- `char_length between 1 and 160`. So the picker is an affordance, not a
-- boundary: one `POST /rest/v1/weekly_challenges` with
-- {"comparison_key":"סקוואט אחורי"} still lands a challenge that can never
-- match a post, which is exactly how the six rows the UX audit found got
-- there in the first place (they were typed into the old free-text box).
--
-- =====================================================================
-- WHAT THIS CONSTRAINT DOES AND, MORE IMPORTANTLY, WHAT IT DOES NOT
-- =====================================================================
-- It enforces SHAPE ONLY. It is byte-for-byte the client's
-- COMPARISON_KEY_SHAPE_RE (cloud.js), deliberately not one character
-- stricter, so the database can never refuse a key the shipped picker
-- offers:
--
--     ^(movement:[a-z0-9-]+:(est1rm|duration)|wod:[a-z0-9-]+:[a-z]+:(rx|scaled))$
--
-- It CANNOT enforce the other half - that the key names a real movement or
-- WOD - and nothing in this schema ever will. The catalog lives in the
-- CLIENT (src/constants.js MOVEMENTS/WOD_LIBRARY, plus each member's own
-- locally stored custom WODs); Postgres has never seen it and has no table
-- to join against. `movement:not-a-real-lift:est1rm` passes this CHECK and
-- is just as dead as the Hebrew string was. That is precisely why cloud.js
-- keeps its SECOND check (challengeKeyExists) and why activeWeeklyChallenge()
-- requires both - this constraint does not replace it and must not be read
-- as having replaced it.
--
-- So the honest summary of the boundary after this migration:
--   refused by the DB       malformed shape, from any client, forever
--   refused by cloud.js     well-shaped key naming nothing real
--   refused by nobody       a well-shaped key naming something real that
--                           only ONE member's device knows about (a custom
--                           WOD is local data; challengeKeyExists is
--                           therefore device-relative). Unchanged by this
--                           migration and noted so it is not mistaken for
--                           something the CHECK covers.
--
-- workout_posts.comparison_key is deliberately LEFT UNCONSTRAINED. It is
-- nullable, written by publishWorkout() for years of existing rows, and a
-- malformed value there is inert - it simply never joins to a challenge.
-- Adding a validated CHECK to it would risk aborting `supabase db push`
-- against real production rows for no security gain.

-- =====================================================================
-- 1. THE EXISTING MALFORMED ROWS
-- =====================================================================
-- A validated CHECK cannot be added while rows violate it - the ALTER TABLE
-- aborts, taking the whole push with it. So they have to go somewhere, and
-- deleting a coach's row outright with no trace is not something a migration
-- gets to do quietly.
--
-- WHY NOT `NOT VALID`, which would have left every row untouched: it leaves
-- the dead rows in the live table, and a dead row is not passive here.
-- club_summary() picks the active weekly challenge with
-- `order by ends_on asc limit 1`, so a malformed row that ends sooner
-- SHADOWS a good one set alongside it - the club home advertises the broken
-- challenge and the working one is invisible. The client's new `valid` flag
-- hides the hero but cannot un-shadow the good challenge. These rows have to
-- leave the table, not merely be tolerated by the constraint.
--
-- WHAT IS LOST BY REMOVING THEM, stated plainly: a coach with a broken
-- challenge currently sees the staff-only banner cloud.js renders from
-- weeklyChallengeRow.valid ("...לא מוצג לחברי המועדון"). Once the row is
-- gone that banner stops appearing and the coach simply sees no active
-- challenge - a correct state, but a quieter one. Judged worth it: the
-- banner's job is to get a real challenge set, the Boards tab already said
-- "no active challenge" for these rows, and no member ever saw them.
--
-- REVERSIBLE IN PRINCIPLE: every removed row is copied WHOLE - id, title,
-- key, dates, author, original created_at - into the archive table below
-- before it is deleted, in this same transaction. Restoring one is an insert
-- with a corrected comparison_key; the coach's title and dates survive
-- verbatim. Nothing is destroyed, only moved out of the live table.
--
-- WHICH ROWS: exactly those failing the predicate below, no hand-written id
-- list. On the audit database that is the six the five-persona UX audit
-- found plus the one seeded while verifying fbf5a43 (e.g. the live row
-- `אתגר הסקוואט` / comparison_key `סקוואט אחורי`); on production it is
-- whatever fails the same test. The archive names them per row, which is a
-- better record than a literal list frozen at authoring time would be.
--
-- NOTHING REFERENCES THESE ROWS. Checked before deciding, because "clean up
-- the bad rows" is only safe if that is true:
--   * No foreign key anywhere points at weekly_challenges (chal_progress /
--     challenge_participants / challenge_progress all belong to the SEPARATE
--     Phase-2 public.challenges table, 202608280009 - different table, no
--     relationship to this one).
--   * weekly_challenge_leaderboard (202608270001) joins workout_posts on
--     comparison_key text equality. A malformed key matches no post by
--     construction, so every archived row contributes exactly zero
--     leaderboard rows before and after.
--   * club_summary() (202608280019, 202609060009) reads the table by date
--     window only; see above - removal is the fix, not the risk.
--   * cloud.js loadWeeklyChallenge() reads by date window only.
create table if not exists public.weekly_challenges_archive (
  id uuid primary key,
  comparison_key text not null,
  title text not null,
  starts_on date not null,
  ends_on date not null,
  -- No FK to profiles, unlike the live table's `references profiles(id) on
  -- delete cascade`. Same reasoning admin_actions (202609060022) records for
  -- admin_id: an archive row must outlive the account that produced it, and
  -- a cascade would silently erase the evidence of the cleanup.
  created_by uuid,
  created_at timestamptz not null,
  archived_at timestamptz not null default now(),
  archived_by_migration text not null,
  archived_reason text not null
);

alter table public.weekly_challenges_archive enable row level security;
revoke all on public.weekly_challenges_archive from public, anon, authenticated;
-- SELECT only, and only for the permission that could have created the row
-- in the first place. No insert/update/delete grant: this table is written
-- by migrations, never by a client. It carries no member data beyond a
-- created_by uuid a coach can already see on the live table.
grant select on public.weekly_challenges_archive to authenticated;
create policy weekly_challenges_archive_read on public.weekly_challenges_archive
  for select to authenticated
  using (public.has_perm('community.challenge.create'));

comment on table public.weekly_challenges_archive is
  'Rows removed from public.weekly_challenges by a migration, kept whole so the removal is reversible in principle and auditable. Written by migrations only - there is no INSERT/UPDATE/DELETE grant and no policy for them. SELECT is granted to holders of community.challenge.create, the same permission that may create and delete a weekly challenge (202609060005). First and so far only writer: 202609060026, which archived every row whose comparison_key failed the shape regex before adding weekly_challenges_comparison_key_shape as a VALIDATED check constraint. Restoring a row is a manual INSERT into weekly_challenges with a corrected comparison_key; the title, dates, author and original created_at are preserved verbatim.';

with removed as (
  delete from public.weekly_challenges w
  where w.comparison_key !~ '^(movement:[a-z0-9-]+:(est1rm|duration)|wod:[a-z0-9-]+:[a-z]+:(rx|scaled))$'
  returning w.id, w.comparison_key, w.title, w.starts_on, w.ends_on, w.created_by, w.created_at
)
insert into public.weekly_challenges_archive
  (id, comparison_key, title, starts_on, ends_on, created_by, created_at,
   archived_by_migration, archived_reason)
select r.id, r.comparison_key, r.title, r.starts_on, r.ends_on, r.created_by, r.created_at,
       '202609060026',
       'comparison_key does not match the shape weekly_challenges_comparison_key_shape now enforces; the row could never match a workout post and was invisible to members'
from removed r
on conflict (id) do nothing;

-- =====================================================================
-- 2. THE CONSTRAINT
-- =====================================================================
-- VALIDATED, not NOT VALID: after the move above the table has no violating
-- row, so the validation scan passes, and a constraint that is actually
-- validated is the only kind a later reader can trust. Guarded so a re-run
-- of this file is a no-op rather than a 42710 (Postgres has no
-- `add constraint if not exists`).
--
-- The 1..160 length check from 202608270001 stays; this is additive. The
-- regex already bounds length far below 160, but removing an existing
-- constraint would be an edit to shipped behaviour for no benefit.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.weekly_challenges'::regclass
      and conname = 'weekly_challenges_comparison_key_shape'
  ) then
    alter table public.weekly_challenges
      add constraint weekly_challenges_comparison_key_shape
      check (comparison_key ~ '^(movement:[a-z0-9-]+:(est1rm|duration)|wod:[a-z0-9-]+:[a-z]+:(rx|scaled))$');
  end if;
end $$;

comment on constraint weekly_challenges_comparison_key_shape on public.weekly_challenges is
  'SHAPE ONLY, and identical to cloud.js COMPARISON_KEY_SHAPE_RE so the database can never refuse a key the shipped picker offers. Enforced on INSERT and UPDATE for every writer including staff over PostgREST, which the <select> added in fbf5a43 cannot be. It does NOT and cannot verify that the key names a real movement or WOD - that catalog lives in the client (src/constants.js plus each device''s own custom WODs) and Postgres has nothing to join against - so movement:not-a-real-lift:est1rm passes here and is still dead. cloud.js challengeKeyExists() remains the only check for that half. Added by 202609060026, which first moved every violating row to public.weekly_challenges_archive.';

commit;
