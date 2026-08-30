begin;

-- Community Phase 2, challenges cluster, part 1 of 4: the read shape.
-- COMM-201's chal_progress(challenge_id) stub from Phase 1 contracts.md,
-- built for real, plus the one small column addition it needs.
--
-- challenge_progress.team_id: COMM-204 requires that a member's prior
-- challenge_progress rows keep counting toward their team's total after
-- they leave the challenge (challenge_participants row deleted, per the
-- existing leave policy). challenge_progress has no team_id of its own, so
-- once a participant row is gone there would be no way to say which team a
-- historical contribution belonged to. The fix is to snapshot the
-- contributor's team onto the progress row at insert time, with a BEFORE
-- INSERT trigger (the challenge_progress_apply trigger documented in
-- contracts.md is AFTER INSERT, for the running-total math; this one runs
-- first so team_id is set before that row is ever readable). Once
-- snapshotted it never changes, so a later team switch by a still-active
-- member does not retroactively rewrite where their old contributions
-- count - same append-only, never-rewrite-history reasoning the rest of
-- this table already follows.

alter table public.challenge_progress
  add column team_id uuid references public.challenge_teams(id) on delete set null;

create or replace function public.challenge_progress_stamp_team() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.team_id is null then
    select cp.team_id into new.team_id
    from public.challenge_participants cp
    where cp.challenge_id = new.challenge_id and cp.user_id = new.user_id;
  end if;
  return new;
end $$;
revoke all on function public.challenge_progress_stamp_team() from public, anon, authenticated;

create trigger challenge_progress_stamp_team_trigger before insert on public.challenge_progress
  for each row execute function public.challenge_progress_stamp_team();

-- The one shape every challenge_type reads through. Fields that do not
-- apply to a given type are left null, never zeroed, so the client can
-- tell "not applicable" from "genuinely zero" (an empty cooperative pool is
-- club_total = 0, not null; a non-cooperative challenge is club_total =
-- null).
create type public.challenge_progress_view as (
  challenge_id uuid,
  challenge_type text,
  title text,
  ends_at timestamptz,
  my_progress numeric,
  my_status text,
  target_value numeric,
  participant_count integer,
  club_total numeric,
  team_totals jsonb,
  leaderboard jsonb
);

-- leaderboard shape assumption: feed_leaderboard (COMM-210/211/212) is not
-- built yet, still listed under "Needs from schema, feed (Phase 2)" in
-- contracts.md at the time this migration lands. Its documented row shape
-- (user_id, display_name, handle, avatar_url, rank, value, is_self) is
-- richer than this needs today, so each element here is the simpler
-- {user_id, name, handle, avatar_url, value}, sorted descending by value.
-- `name` falls back from display_name to handle the same way the feed
-- card contract already does. If/when feed_leaderboard lands, its row type
-- is not reused here automatically - a follow-up can widen this object to
-- match it (add rank, is_self) without breaking a client reading the
-- fields already present.
create or replace function public.chal_progress(challenge_id uuid) returns public.challenge_progress_view
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_challenge public.challenges;
  v_result public.challenge_progress_view;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  -- "club member" here is deliberately looser than is_community_member():
  -- this is a read, and the Phase 0/1 rule is that read paths are not
  -- gated behind the recovery-verification write gate. my_role_code()
  -- already folds together a live invite_redemptions row and the legacy
  -- profiles.is_admin flag, so it is the one existing "has a real seat in
  -- this club" predicate.
  if public.my_role_code() is null then raise exception 'not authorized'; end if;

  select * into v_challenge from public.challenges c where c.id = chal_progress.challenge_id;
  if not found then raise exception 'challenge not found'; end if;
  -- Same visibility as challenges_read: a draft is invisible to everyone
  -- but its creator and a challenge manager.
  if v_challenge.status = 'draft'
     and v_challenge.created_by is distinct from v_uid
     and not public.has_perm('community.challenge.create') then
    raise exception 'challenge not found';
  end if;

  v_result.challenge_id := v_challenge.id;
  v_result.challenge_type := v_challenge.challenge_type;
  v_result.title := v_challenge.title;
  v_result.ends_at := v_challenge.end_at;
  v_result.target_value := v_challenge.target_value;

  select cp.progress_value, cp.status into v_result.my_progress, v_result.my_status
  from public.challenge_participants cp
  where cp.challenge_id = v_challenge.id and cp.user_id = v_uid;

  select count(*) into v_result.participant_count
  from public.challenge_participants cp
  where cp.challenge_id = v_challenge.id and cp.status <> 'withdrawn';

  if v_challenge.challenge_type = 'cooperative' then
    select coalesce(sum(p.delta), 0) into v_result.club_total
    from public.challenge_progress p
    where p.challenge_id = v_challenge.id;
  end if;

  if v_challenge.challenge_type = 'team' then
    -- Summed from challenge_progress.team_id (snapshotted at insert time),
    -- not from challenge_participants.team_id, so a departed member's
    -- earlier contributions stay in their team's total. See the column
    -- comment above.
    select coalesce(jsonb_agg(
             jsonb_build_object('team_id', t.id, 'name', t.name, 'total', coalesce(tt.total, 0))
             order by t.name
           ), '[]'::jsonb)
    into v_result.team_totals
    from public.challenge_teams t
    left join (
      select p.team_id, sum(p.delta) as total
      from public.challenge_progress p
      where p.challenge_id = v_challenge.id and p.team_id is not null
      group by p.team_id
    ) tt on tt.team_id = t.id
    where t.challenge_id = v_challenge.id;
  end if;

  if v_challenge.challenge_type in ('individual_performance', 'coach') then
    select coalesce(jsonb_agg(
             jsonb_build_object(
               'user_id', ranked.user_id,
               'name', coalesce(pr.display_name, pr.handle),
               'handle', pr.handle,
               'avatar_url', pr.avatar_url,
               'value', ranked.progress_value
             ) order by ranked.progress_value desc
           ), '[]'::jsonb)
    into v_result.leaderboard
    from (
      select cp.user_id, cp.progress_value
      from public.challenge_participants cp
      where cp.challenge_id = v_challenge.id
        and cp.status <> 'withdrawn'
        and public.can_view_profile_field(cp.user_id, 'in_leaderboards')
        and not public.notif_blocked_between(v_uid, cp.user_id)
      order by cp.progress_value desc
      limit 20
    ) ranked
    join public.profiles pr on pr.id = ranked.user_id;
  end if;

  return v_result;
end $$;

revoke all on function public.chal_progress(uuid) from public, anon;
grant execute on function public.chal_progress(uuid) to authenticated;

commit;
