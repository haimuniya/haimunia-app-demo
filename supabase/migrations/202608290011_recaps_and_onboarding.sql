begin;

-- COMM-220 / COMM-221 / COMM-222, the schema half of the Phase 2 recaps
-- cluster. Two member-scoped tables and the trigger that seeds one of them.
-- The recap_weekly Edge Function and the recap/onboarding UI are the recaps
-- agent's, not this migration's.

-- =====================================================================
-- default_club_id() for the service role
-- =====================================================================
-- 202608280001 revoked default_club_id() from public and granted it to
-- authenticated only. Every service-role write so far has gone through a
-- security definer function, which evaluates column defaults as the
-- function owner, so the missing grant never showed.
--
-- weekly_recaps is the first table a service-role caller writes DIRECTLY,
-- with no definer function in between: recap_weekly upserts rows over the
-- REST endpoint. Its club_id default would then be evaluated as
-- service_role and fail with 42501 on every single insert. Granting the
-- execute here rather than making recap_weekly pass an explicit club_id
-- keeps "every new table defaults club_id through this" true, which is the
-- whole reason that function exists. The club id is not a secret; the
-- revoke on anon still stands.
grant execute on function public.default_club_id() to service_role;

-- =====================================================================
-- weekly_recaps (COMM-220, read surface COMM-221)
-- =====================================================================
-- One row per member per ISO week, generated server-side. The member reads
-- their own; nobody with a client key writes it at all.
--
-- What this table is NOT is a feed of recaps. Nothing here reaches another
-- member's screen. club_challenge_progress is the one aggregate field, and
-- it is aggregate by construction - the Edge Function writes club totals
-- into it, never a per-member breakdown, because a recap that named who
-- else trained would leak exactly the attendance data COMM-316 has not
-- been allowed to expose yet.
create table public.weekly_recaps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  club_id uuid not null default public.default_club_id() references public.clubs(id),

  -- The Monday of the ISO week the recap covers. The CHECK is load-bearing
  -- rather than tidiness: the unique key below is what makes recap_weekly
  -- idempotent, and a key on a free-form date is only unique per date, not
  -- per week. Without this, one run keying Sunday and another keying Monday
  -- would both insert and the member would get the same week twice. COMM-220
  -- says ISO week, and an ISO week starts on a Monday, so pin it.
  week_start date not null check (extract(isodow from week_start) = 1),

  -- The quiet-week floor. A member with no activity still gets a row
  -- (COMM-220), and these defaults are what make that row honest rather
  -- than null-shaped: zero sessions, zero streak, empty lists.
  sessions_completed integer not null default 0 check (sessions_completed >= 0),
  streak integer not null default 0 check (streak >= 0),
  -- [{movement, result, achieved_on}], the same shape profile_view uses.
  prs jsonb not null default '[]'::jsonb,
  -- [{title, badge_icon, code, unlocked_at}]
  achievements jsonb not null default '[]'::jsonb,
  -- The member's own challenge standing: [{id, title, progress, target}]
  challenge_progress jsonb not null default '[]'::jsonb,
  -- Aggregate club figures only: {title, participants, total, target}
  club_challenge_progress jsonb not null default '{}'::jsonb,
  -- Nullable on purpose. Null means "no upcoming event", which is a real
  -- and common state; an empty object would make the client guess.
  upcoming_event jsonb,

  generated_at timestamptz not null default now(),

  -- The idempotency key. recap_weekly upserts on this: a rerun for a week
  -- already generated updates in place instead of producing a second row
  -- and a second notification.
  constraint weekly_recaps_user_week_key unique (user_id, week_start)
);

-- COMM-221 browses past weeks newest-first. The unique constraint's index
-- is (user_id, week_start) ascending; Postgres can scan it backwards for
-- the descending order, so no second index is added here.

alter table public.weekly_recaps enable row level security;

revoke all on public.weekly_recaps from public, anon;
grant select on public.weekly_recaps to authenticated;

-- Own-row read, and that is the entire client surface. There is no insert,
-- update, or delete grant and no policy for any of the three, not even for
-- the member who owns the row - the same shape notification_batches uses in
-- 202608280018. A member who could write here could hand themselves a
-- 40-session week and then Share Recap it to the feed, which turns a
-- generated summary into a self-reported claim. Only recap_weekly writes,
-- running as service_role, which bypasses RLS entirely.
create policy weekly_recaps_self_select on public.weekly_recaps for select to authenticated
  using (user_id = auth.uid());

-- =====================================================================
-- onboarding_progress (COMM-222)
-- =====================================================================
-- One row per member, seeded at MEMBER_JOINED, holding "has this step been
-- shown yet" stamps. Own-row select and update; no insert path for a
-- client at all.
--
-- Deliberately absent: any joined_at / clock column. The onboarding clock
-- ("after the first week", "after the first month") runs from
-- invite_redemptions.redeemed_at, which is already the module's
-- authoritative MEMBER_JOINED timestamp - 202608290002 meters the
-- anniversary achievements off the very same column, and the member can
-- already read their own redemption row. A second copy of the join date
-- here would be a second thing to keep in sync and a second thing to be
-- wrong.
--
-- Also deliberately absent: the two steps tied to the member's first and
-- third class. Those need attendance, which does not exist. They land with
-- COMM-316; see COMM-P07. Do not add them here speculatively - a nullable
-- column nobody writes is indistinguishable from a step that never fired.
create table public.onboarding_progress (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- Null means "not shown yet". Set once, by the client, at the moment the
  -- step is actually rendered (COMM-222: shown, not merely scheduled).
  welcomed_at timestamptz,
  first_week_shown_at timestamptz,
  first_month_shown_at timestamptz
);

-- The FK is to auth.users, not profiles, and that is forced by ordering
-- rather than chosen. A redemption happens BEFORE the profile exists -
-- profiles_insert_self (202608270003) requires an invite_redemptions row to
-- already be there. A profiles FK would make the seeding trigger below fail
-- on its own insert for every new member. invite_redemptions itself keys to
-- auth.users for exactly this reason.

alter table public.onboarding_progress enable row level security;

revoke all on public.onboarding_progress from public, anon;
grant select, update on public.onboarding_progress to authenticated;

create policy onboarding_progress_self_select on public.onboarding_progress for select to authenticated
  using (user_id = auth.uid());

-- The update is the client marking a step seen. USING and WITH CHECK both
-- pin user_id: without the WITH CHECK a member could move their own row
-- onto another member's id and burn that member's onboarding.
create policy onboarding_progress_self_update on public.onboarding_progress for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- No insert grant and no insert policy. This is the half of COMM-222 that
-- makes "each step fires exactly once per member" true: if a member could
-- insert, they could delete-and-reinsert, or simply insert a fresh row
-- after we ever add a delete path, and re-see a step. The only way a row
-- exists is the trigger below. There is no delete grant either.

-- Timestamps here are one-way. A member can set a null stamp to a value;
-- they cannot clear it or move it afterwards. Pinning silently rather than
-- raising is deliberate: COMM-222 wants a failed dismiss-write to retry
-- quietly on next load, and two tabs both marking the welcome step seen is
-- a benign race, not an error worth surfacing to a member on their first
-- day. The write simply has no further effect.
create or replace function public.onboarding_progress_pin_shown() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.user_id             := old.user_id;
  new.welcomed_at         := coalesce(old.welcomed_at, new.welcomed_at);
  new.first_week_shown_at := coalesce(old.first_week_shown_at, new.first_week_shown_at);
  new.first_month_shown_at := coalesce(old.first_month_shown_at, new.first_month_shown_at);
  return new;
end $$;

create trigger onboarding_progress_pin before update on public.onboarding_progress
  for each row execute function public.onboarding_progress_pin_shown();

-- =====================================================================
-- Seeding at MEMBER_JOINED
-- =====================================================================
-- AFTER INSERT on invite_redemptions is the MEMBER_JOINED moment. Not
-- profiles: a member exists as a member the instant their redemption
-- lands, and that is the timestamp the onboarding clock and the tenure
-- achievements both read.
--
-- INSERT only, never UPDATE. grant_coach_role() and
-- grant_coach_role_by_handle() both UPDATE invite_redemptions and move
-- redeemed_at; firing on those would re-seed a row for someone who has
-- already been through onboarding. The on conflict do nothing is the
-- second belt on the same trousers.
--
-- No auth.uid() check in this definer function, same reasoning as
-- notif_queue_batched in 202608280018: it acts on the row being inserted,
-- not on the caller, and the boundary is that no client can insert into
-- invite_redemptions in the first place.
create or replace function public.seed_onboarding_progress() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.onboarding_progress (user_id) values (new.user_id)
  on conflict (user_id) do nothing;
  return new;
end $$;
revoke all on function public.seed_onboarding_progress() from public, anon, authenticated;

create trigger invite_redemptions_seed_onboarding after insert on public.invite_redemptions
  for each row execute function public.seed_onboarding_progress();

-- Backfill everyone who redeemed before this migration existed, so no
-- current member is left with no row and therefore no onboarding at all.
-- Idempotent, and a no-op on a fresh database.
insert into public.onboarding_progress (user_id)
  select user_id from public.invite_redemptions
on conflict (user_id) do nothing;

commit;
