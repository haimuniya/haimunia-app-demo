begin;

-- COMM-223 / COMM-224 / COMM-225: the schema half of the Phase 2 coach
-- dashboard. Three things: coach_celebrate_feed(), profiles
-- .assigned_coach_id (plus the one write path that can actually set it),
-- and member_contact_log.
--
-- Deliberately NOT here: coach_engagement_flags (COMM-011) is untouched.
-- It ships empty in Phase 2 per COMM-226 and stays out of scope until
-- COMM-304, so this migration adds no column to it and changes none of its
-- policies.
--
-- Deliberately NOT here either: any birthday source. There is no birth date
-- column anywhere in this schema (2026-08-28 decision, see the note at the
-- top of 202608280003), so Celebrate never queries for one. Anniversary is
-- the only date-shaped item in the feed and it comes from
-- invite_redemptions.redeemed_at, a server-set timestamp.

-- ---------------------------------------------------------------------------
-- 1. coach_celebrate_feed(p_days) - COMM-223, and the source of the items
--    COMM-225's Congratulate action acts on.
-- ---------------------------------------------------------------------------
-- One call for the whole Celebrate list, three kinds unioned and sorted by
-- recency. Staff-only, checked inline the way coach_inactive_members()
-- (202608270005) does it, so a non-staff caller is refused by the database
-- and not merely by a hidden nav item.
--
-- The privacy rule is the point of this function, and it is why the three
-- branches each carry a different predicate rather than one shared one.
-- Celebrate surfaces what a coach could already see; it never bypasses a
-- member's own toggle. Each branch reuses the toggle this schema had
-- already picked for that kind of item, through the single resolution point
-- can_view_profile_field() (202608280003):
--
--   - a PR row:        'show_prs', the same gate the Progress tab of
--                      community_profile() reads (202608280022), plus
--                      post_visible_to_viewer() for the post's own
--                      followers/public/block rules, again exactly as that
--                      function does it.
--   - a completion:    'in_leaderboards', the toggle chal_progress()
--                      (202608290003) already applies to decide whether a
--                      member's challenge standing may be shown to another
--                      member at all. A member who opted out of the
--                      leaderboard did not opt in to being announced.
--   - an anniversary:  'visible_to_club'. There is no anniversary-specific
--                      toggle and inventing one here would be a second,
--                      competing definition of the same question; a member
--                      hidden from the club is hidden from Celebrate.
--
-- can_view_profile_field() also settles blocks in both directions and
-- returns true for the caller's own row and for an admin, so a coach who is
-- also a plain member sees their own items and an admin sees everything -
-- both already true everywhere else this helper is used.
create or replace function public.coach_celebrate_feed(p_days int default 7)
returns setof jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_days int;
  v_since timestamptz;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_staff() then raise exception 'not authorized'; end if;

  -- COMM-223 clamps the window to 1..30 rather than rejecting it: this is a
  -- read a dashboard makes on load, and a bad number is a client bug, not
  -- something worth turning into an error toast in front of a coach.
  v_days := least(greatest(coalesce(p_days, 7), 1), 30);
  v_since := now() - (v_days || ' days')::interval;

  return query
  with prs as (
    select
      'pr'::text as kind,
      p.author_id as user_id,
      p.created_at as occurred_at,
      p.id as post_id,
      jsonb_build_object(
        'movement', coalesce(nullif(p.metadata ->> 'movement', ''), nullif(p.title, ''), ''),
        'result',   coalesce(nullif(p.metadata ->> 'new_result', ''), nullif(p.result_text, ''), '')
      ) as detail
    from public.workout_posts p
    where p.post_type = 'POST_PR'
      and p.created_at >= v_since
      and p.deleted_at is null
      and p.status = 'active'
      and p.author_id is not null
      and public.can_view_profile_field(p.author_id, 'show_prs')
      and public.post_visible_to_viewer(p.id)
  ),
  -- The tenure arithmetic is ach_claim()'s, not a new one. 202608290002
  -- made membership tenure a server-checked fact keyed on
  -- config->>'metric' = 'tenure_days' and threshold-in-days against
  -- invite_redemptions.redeemed_at; Celebrate asks the same question with
  -- one extra bound, so a definition added later (a ten-year badge, say) is
  -- picked up here with no further migration, and the day a member's
  -- anniversary lands in this feed is the same day they can claim the
  -- badge. Neither side gets to disagree about when a year has passed.
  --
  --   ach_claim:  redeemed_at <= now() - threshold days      ("reached it")
  --   here:       ... and the crossing itself, redeemed_at + threshold
  --               days, fell inside the window, which is the same
  --               comparison shifted: redeemed_at > v_since - threshold
  --               days.
  annis as (
    select
      'anniversary'::text as kind,
      ir.user_id as user_id,
      ir.redeemed_at + (d.threshold || ' days')::interval as occurred_at,
      null::uuid as post_id,
      jsonb_build_object(
        'code',  d.code,
        'title', d.name,
        -- threshold is numeric, so the cast is not decoration: without it
        -- a one-year anniversary serialises as 1.0000000000000000 and the
        -- client has to guess. 365/730/1095/1825 all divide exactly.
        'years', (d.threshold / 365)::integer
      ) as detail
    from public.invite_redemptions ir
    join public.achievement_definitions d
      on coalesce(d.config ->> 'metric', '') = 'tenure_days'
     and d.enabled
     and d.threshold >= 365
    where ir.redeemed_at <= now() - (d.threshold || ' days')::interval
      and ir.redeemed_at > v_since - (d.threshold || ' days')::interval
      and public.can_view_profile_field(ir.user_id, 'visible_to_club')
  ),
  comps as (
    select
      'challenge_completion'::text as kind,
      cp.user_id as user_id,
      cp.completed_at as occurred_at,
      null::uuid as post_id,
      jsonb_build_object(
        'challenge_id', c.id,
        'title',        c.title
      ) as detail
    from public.challenge_participants cp
    join public.challenges c on c.id = cp.challenge_id
    where cp.completed_at is not null
      and cp.completed_at >= v_since
      and cp.status <> 'withdrawn'
      and c.status <> 'draft'
      and public.can_view_profile_field(cp.user_id, 'in_leaderboards')
  ),
  items as (
    select * from prs
    union all select * from annis
    union all select * from comps
  )
  -- A plain jsonb shape, flat and self-describing, so the client can render
  -- a row without joining anything back or trusting anything it computed
  -- itself. post_id is null exactly when there is no source post, which is
  -- what COMM-225 branches on to pick add_post_comment over post_create.
  select jsonb_build_object(
           'kind',         i.kind,
           'user_id',      i.user_id,
           'handle',       pf.handle,
           'display_name', coalesce(nullif(pf.display_name, ''), pf.handle),
           'avatar_url',   pf.avatar_url,
           'occurred_at',  i.occurred_at,
           'post_id',      i.post_id,
           'detail',       i.detail
         )
  from items i
  join public.profiles pf on pf.id = i.user_id and pf.deleted_at is null
  order by i.occurred_at desc
  limit 100;
end $$;

revoke all on function public.coach_celebrate_feed(int) from public, anon;
grant execute on function public.coach_celebrate_feed(int) to authenticated;

comment on function public.coach_celebrate_feed(int) is
  'COMM-223/225 Celebrate list for the coach dashboard: recent PRs, membership anniversaries, and challenge completions within p_days (clamped 1..30), newest first. Staff-only, is_staff() inline. Each row is subject to the subject member''s own toggle - show_prs, visible_to_club, in_leaderboards respectively - through can_view_profile_field(), so Celebrate never surfaces what a coach could not already see. No birthday source exists.';

-- ---------------------------------------------------------------------------
-- 2. profiles.assigned_coach_id - COMM-224 "Assign coach (optional)"
-- ---------------------------------------------------------------------------
-- Nullable, self-referential, ON DELETE SET NULL: a coach leaving the club
-- must not take their members' rows with them.
alter table public.profiles
  add column if not exists assigned_coach_id uuid references public.profiles(id) on delete set null;

create index if not exists profiles_assigned_coach_idx
  on public.profiles(assigned_coach_id) where assigned_coach_id is not null;

comment on column public.profiles.assigned_coach_id is
  'COMM-224. The staff member responsible for this member, or null. Set only through coach_assign_coach(); pinned against direct client UPDATE by protect_is_admin(), the same way is_admin, club_id and recovery_verified_at are.';

-- The column is documented as staff-writable, and on this schema that
-- needs saying out loud rather than assuming. profiles has exactly one
-- UPDATE policy, profiles_update_self (202608270003), and it is
-- `id = auth.uid()` on both sides. So a coach's direct UPDATE of another
-- member's row does not fail - it silently matches zero rows, which is the
-- worst of the three possible outcomes. Two ways out: widen the UPDATE
-- policy for staff, or cross the boundary once, on purpose, in a function
-- that can only touch this one column.
--
-- This takes the second. A staff UPDATE policy on profiles would let any
-- coach rewrite any member's handle, display name, and every privacy
-- toggle they own, to ship one nullable organisational field - and any
-- policy touching profiles or visibility is identity-privacy's call, not a
-- side effect of the coach dashboard. The narrower policy the contract
-- anticipates can still replace this later without changing the column.
--
-- protect_is_admin() gains the pin, so "staff-writable" is true rather than
-- aspirational: without it, a member could set their own assigned_coach_id
-- through the existing own-row update, and a field a member can set about
-- themselves is not a coach assignment. Same transaction-local GUC escape
-- hatch mark_recovery_verified() already uses, and for the same reason -
-- auth.role() still reads 'authenticated' inside a SECURITY DEFINER
-- function, so definer rights alone would not survive this trigger.
create or replace function public.protect_is_admin() returns trigger
language plpgsql set search_path = '' as $$
begin
  if auth.role() = 'authenticated' then
    new.is_admin = old.is_admin;
    new.club_id = old.club_id;
    if coalesce(current_setting('app.allow_recovery_stamp', true), '') <> 'on' then
      new.recovery_verified_at = old.recovery_verified_at;
    end if;
    if coalesce(current_setting('app.allow_coach_assign', true), '') <> 'on' then
      new.assigned_coach_id = old.assigned_coach_id;
    end if;
  end if;
  return new;
end $$;

-- The one write path for the column above.
--
-- p_coach_id null clears the assignment, which is how "unassign" works
-- without a second function. A non-null p_coach_id must itself be staff:
-- the field means "which coach owns this relationship", and pointing it at
-- a plain member would make every dashboard reading it lie. The rank test
-- is the same >= 20 is_staff() uses, asked about another user rather than
-- the caller - which is exactly why my_role_code() cannot be reused here,
-- it deliberately answers only about auth.uid().
create or replace function public.coach_assign_coach(p_user_id uuid, p_coach_id uuid default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_out uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_staff() then raise exception 'not authorized'; end if;
  if p_user_id is null then raise exception 'member required'; end if;

  if p_coach_id is not null and not exists (
    select 1 from public.profiles p
    where p.id = p_coach_id
      and p.deleted_at is null
      and (
        p.is_admin
        or coalesce(public.role_rank((
             select ir.role from public.invite_redemptions ir where ir.user_id = p.id
           )), 0) >= 20
      )
  ) then
    raise exception 'assigned coach must be staff';
  end if;

  perform set_config('app.allow_coach_assign', 'on', true);
  update public.profiles
    set assigned_coach_id = p_coach_id
  where id = p_user_id and deleted_at is null
  returning id into v_out;
  perform set_config('app.allow_coach_assign', 'off', true);

  if v_out is null then raise exception 'member not found'; end if;
  return p_coach_id;
end $$;

revoke all on function public.coach_assign_coach(uuid, uuid) from public, anon;
grant execute on function public.coach_assign_coach(uuid, uuid) to authenticated;

comment on function public.coach_assign_coach(uuid, uuid) is
  'COMM-224 Assign coach. Staff-only, is_staff() inline. Sets profiles.assigned_coach_id for p_user_id to p_coach_id, or clears it when p_coach_id is null. p_coach_id must itself be staff. Returns the value written. The only write path for the column: profiles_update_self is own-row only and protect_is_admin() pins the column against direct client UPDATE.';

-- ---------------------------------------------------------------------------
-- 3. member_contact_log - COMM-224 "Mark contacted"
-- ---------------------------------------------------------------------------
-- Coach-to-coach coordination, so nobody welcomes the same new member
-- twice and nobody is missed. Unlike coach_engagement_flags this carries no
-- `user_id <> auth.uid()` clause on any policy, and that difference is the
-- whole design: a decline flag is a judgement a member must never read
-- about themselves, whereas "someone said hello to you" is not a sensitive
-- signal at all. What it is, in this ticket's scope, is not the member's
-- business either - COMM-224 asks only for coaches to see it, so there is
-- no member-facing SELECT policy here. Adding one later is one line;
-- removing a leak is not.
create table if not exists public.member_contact_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  contacted_by uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  contacted_at timestamptz not null default now(),
  note text not null default '' check (char_length(note) <= 500)
);
create index if not exists member_contact_log_user_idx
  on public.member_contact_log(user_id, contacted_at desc);
create index if not exists member_contact_log_by_idx
  on public.member_contact_log(contacted_by, contacted_at desc);

alter table public.member_contact_log enable row level security;
revoke all on public.member_contact_log from public, anon;
grant select, insert, update, delete on public.member_contact_log to authenticated;

-- Read: any staff member, about any member, including themselves. That is
-- what makes it coordination rather than a private note.
create policy member_contact_log_staff_select on public.member_contact_log for select to authenticated
  using (public.is_staff());

-- Write: staff only, and always in your own name. `contacted_by =
-- auth.uid()` is the same author pin every other insert policy in this
-- schema carries; the column defaults to auth.uid() so the client inserts
-- {user_id, note} and never has to name itself. Correcting or withdrawing a
-- log entry is the author's to do, which is why update and delete are
-- author-scoped too - a shared list where anyone can rewrite anyone's
-- entry is not a record of who did what.
create policy member_contact_log_staff_insert on public.member_contact_log for insert to authenticated
  with check (public.is_staff() and contacted_by = auth.uid());
create policy member_contact_log_author_update on public.member_contact_log for update to authenticated
  using (public.is_staff() and contacted_by = auth.uid())
  with check (public.is_staff() and contacted_by = auth.uid());
create policy member_contact_log_author_delete on public.member_contact_log for delete to authenticated
  using (public.is_staff() and contacted_by = auth.uid());

comment on table public.member_contact_log is
  'COMM-224 Mark contacted. One row per coach outreach to a member. Staff read any row; staff write only their own (contacted_by = auth.uid(), defaulted). Not readable by a non-staff member, including about themselves, in this ticket''s scope.';

commit;
