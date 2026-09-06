begin;

-- Launch-readiness audit, findings 5 and 6: two challenge write boundaries
-- that do not say what every sibling in the same model says.
--
-- =====================================================================
-- 5. weekly_challenges: is_staff() where every sibling says has_perm()
-- =====================================================================
-- THE DIVERGENCE, and exactly how big it is. weekly_challenges_insert_admin
-- (last re-declared by 202608270006) checks public.is_staff(), which since
-- 202608280001 means role_rank(my_role_code()) >= 20. The seeded role set
-- with rank >= 20 is coach(20), head_coach(30), staff(40), admin(50),
-- owner(60). The seeded holders of community.challenge.create - which is
-- what EVERY other write in the Phase 2 challenge model checks
-- (challenges_insert_perm / update / delete, challenge_teams_*_perm,
-- chal_record_progress, chal_reassign_team, chal_set_captain) - are
-- coach, head_coach, admin, owner. `staff` is in the first set and not the
-- second.
--
-- So a `staff`-role member could insert a weekly challenge directly by RLS
-- while being refused by every function and policy in the model built on
-- top of it. LATENT, NOT LIVE: nothing in the shipped app grants the `staff`
-- role - invite_create pins the grantable roles and admin_grant_coach names
-- coach and head_coach - so no account can currently hold it. That is
-- exactly why it is worth fixing now rather than after someone adds the
-- grant path and inherits a hole nobody remembers.
--
-- announcements_insert_admin is deliberately LEFT ALONE. It also checks
-- is_staff(), and the audit's first pass flagged it as the same bug. It is
-- not: community.announcement.publish is seeded to coach, head_coach,
-- staff, admin AND owner - every role of rank >= 20, with no exceptions -
-- so there is no set of members for which the two predicates disagree.
-- Re-verified against the 202608280001 seed while writing this migration.
-- Changing it would be churn with a nonzero chance of drift, not a fix.
--
-- THE MISSING HALF. weekly_challenges has carried a read policy and an
-- insert policy since 202608270001 and NOTHING ELSE - no UPDATE policy, no
-- DELETE policy, and no UPDATE or DELETE grant. A typo in a challenge title
-- or a wrong comparison_key is currently uncorrectable and unremovable by
-- anyone, admin and owner included, short of shipping a migration. Both are
-- added here to the same permission holder, which is what the equivalent
-- policies on public.challenges (202608280009) already do.
drop policy if exists weekly_challenges_insert_admin on public.weekly_challenges;
create policy weekly_challenges_insert_admin on public.weekly_challenges for insert to authenticated
  with check (created_by = auth.uid() and public.has_perm('community.challenge.create'));

grant update, delete on public.weekly_challenges to authenticated;

-- Not scoped to created_by: a challenge belongs to the club, not to the
-- coach who happened to type it in, and challenges_update_perm /
-- challenges_delete_perm (202608280009) already settle the question the
-- same way for the Phase 2 table.
create policy weekly_challenges_update_perm on public.weekly_challenges for update to authenticated
  using (public.has_perm('community.challenge.create'))
  with check (public.has_perm('community.challenge.create'));
create policy weekly_challenges_delete_perm on public.weekly_challenges for delete to authenticated
  using (public.has_perm('community.challenge.create'));

-- =====================================================================
-- 6. challenge_participants.progress_value is client-writable
-- =====================================================================
-- THE HOLE. challenge_participants_update_self (202608280009) is
-- `using (user_id = auth.uid() or has_perm(...))` with the identical WITH
-- CHECK and NO column restriction, so a member can UPDATE any column of
-- their own row. 202609010005 already found this out the hard way for
-- team_id ("READ THAT POLICY ... the ticket's premise was not true") and
-- fixed that one column with a trigger, while explicitly leaving the rest:
-- "a member can still edit their own status and progress_value directly,
-- which is what COMM-205's consistency 'mark complete' tap does and is a
-- separate, pre-existing question."
--
-- This is that question. A member can set progress_value to any number they
-- like in one PostgREST call, which lands them at the top of
-- feed_leaderboard('progress') and of chal_progress's board, and - for an
-- individual_target challenge - is read straight back by
-- challenge_progress_apply as the base for every later delta. That directly
-- contradicts the model's own load-bearing rule, stated in
-- 202608280009's comment on challenge_progress and in contracts.md: the
-- participant total is DERIVED from the append-only contribution log, never
-- client-summed.
--
-- WHAT THE SHIPPED CLIENT ACTUALLY WRITES to this table, checked call site
-- by call site before anything was locked down, because the point is to
-- close the hole without breaking the one legitimate direct write:
--   insert  {challenge_id, user_id}                joinChallenge
--   update  {team_id}                              autoAssignChallengeTeam / pickChallengeTeam
--   update  {status:'completed', completed_at}     logConsistencyWeekHit  <- the one
--   delete  own row                                leaveChallenge
-- progress_value is written by the client NOWHERE. Every real increment
-- goes through challenge_progress (append-only insert) and lands on the
-- participant row via the challenge_progress_apply trigger.
--
-- THE RULES, therefore:
--   progress_value  refused for EVERY authenticated session, coach and
--                   admin included. There is no legitimate direct writer,
--                   and "server-derived" that a staff role can overwrite by
--                   hand is not server-derived. A correction is a
--                   compensating negative delta through chal_record_progress,
--                   which is the mechanism 202608280009 already chose for
--                   exactly this.
--   status          refused unless it is (a) a community.challenge.create
--                   holder administering the challenge, or (b) the
--                   documented consistency self-completion: the member's own
--                   row moving 'active' -> 'completed'. Anything else - most
--                   pointedly a member marking themselves completed on a
--                   challenge they never finished, or un-withdrawing - is
--                   refused.
--
-- Both bypassed behind one transaction-local GUC that only
-- challenge_progress_apply() ever sets, the same app.allow_captain_set
-- shape 202609010005 uses and for the identical reason: auth.role() still
-- reads 'authenticated' inside a SECURITY DEFINER trigger function, so
-- definer rights alone would not carry that trigger's own UPDATE past this
-- one. `app.` is a namespace PostgREST never populates from a request.
--
-- Scoped to auth.role() = 'authenticated' at the top, matching
-- challenge_participants_guard_team() exactly: the service role, a
-- dashboard fix and a future backfill are unaffected.
--
-- completed_at is deliberately NOT in the trigger's column list. It is
-- meaningless on its own - nothing reads it except beside a 'completed'
-- status - and adding it would refuse logConsistencyWeekHit's single
-- legitimate write, which sets both in one statement.
create or replace function public.challenge_participants_guard_progress() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_pinned boolean;
begin
  if coalesce(auth.role(), '') <> 'authenticated' then return new; end if;

  v_pinned := coalesce(current_setting('app.allow_progress_apply', true), '') = 'on';
  if v_pinned then return new; end if;

  if new.progress_value is distinct from old.progress_value then
    raise exception 'progress is server derived';
  end if;

  if new.status is distinct from old.status then
    if public.has_perm('community.challenge.create') then
      return new;
    end if;
    if new.user_id = auth.uid() and old.status = 'active' and new.status = 'completed' then
      return new;
    end if;
    raise exception 'status is server derived';
  end if;

  return new;
end $$;
revoke all on function public.challenge_participants_guard_progress() from public, anon, authenticated;

drop trigger if exists challenge_participants_guard_progress_trigger on public.challenge_participants;
create trigger challenge_participants_guard_progress_trigger
  before update of progress_value, status on public.challenge_participants
  for each row execute function public.challenge_participants_guard_progress();

comment on function public.challenge_participants_guard_progress() is
  'Launch-readiness audit. BEFORE UPDATE OF progress_value, status on challenge_participants. Raises ''progress is server derived'' (P0001) for ANY authenticated change to progress_value, staff included - the participant total is derived from the append-only challenge_progress log and a correction is a compensating negative delta through chal_record_progress. Raises ''status is server derived'' for a status change other than a community.challenge.create holder''s, or the member''s own row moving ''active'' -> ''completed'' (COMM-205''s consistency self-completion, the one direct status write the shipped client makes). Both are bypassed inside the transaction-local app.allow_progress_apply pin, which only challenge_progress_apply() sets, around its own UPDATE. Skipped entirely when auth.role() is not ''authenticated''. Closes the half of challenge_participants_update_self''s unrestricted self-row UPDATE that 202609010005 named and deliberately left open.';

-- =====================================================================
-- challenge_progress_apply() gains the pin
-- =====================================================================
-- Byte-identical to the live 202608290004 function except for the two
-- set_config calls wrapping its one UPDATE. Recreated in full rather than
-- patched, because that is the only way Postgres offers.
create or replace function public.challenge_progress_apply() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_challenge public.challenges;
  v_participant public.challenge_participants;
  v_new_total numeric;
  v_now_complete boolean;
  v_club_total numeric;
  v_pct numeric;
  v_threshold integer;
  v_already boolean;
begin
  select * into v_challenge from public.challenges where id = new.challenge_id for update;
  if not found then
    return new;
  end if;

  select * into v_participant from public.challenge_participants
    where challenge_id = new.challenge_id and user_id = new.user_id
    for update;

  if found then
    v_new_total := v_participant.progress_value + new.delta;
    v_now_complete := (
      v_participant.status <> 'completed'
      and v_challenge.challenge_type in ('individual_target', 'individual_performance')
      and v_challenge.target_value is not null
      and v_new_total >= v_challenge.target_value
    );

    -- Transaction-local, cleared immediately after the one UPDATE it exists
    -- for. See challenge_participants_guard_progress() above: this trigger
    -- runs inside the contributing member's own authenticated session,
    -- where that guard would otherwise refuse the derived write it is
    -- there to protect.
    perform set_config('app.allow_progress_apply', 'on', true);
    update public.challenge_participants
    set progress_value = v_new_total,
        status = case when v_now_complete then 'completed' else status end,
        completed_at = case when v_now_complete then now() else completed_at end
    where challenge_id = new.challenge_id and user_id = new.user_id;
    perform set_config('app.allow_progress_apply', 'off', true);
  end if;
  -- No participant row (e.g. a stray coach entry against a bad target) is
  -- silently a no-op here; chal_record_progress already refuses that case
  -- before it ever inserts, so this branch only guards against a future
  -- write path that skips that check.

  if v_challenge.challenge_type = 'cooperative'
     and v_challenge.target_value is not null
     and v_challenge.target_value > 0 then
    select coalesce(sum(delta), 0) into v_club_total
    from public.challenge_progress
    where challenge_id = new.challenge_id;

    v_pct := (v_club_total / v_challenge.target_value) * 100;

    foreach v_threshold in array array[25, 50, 75, 100] loop
      if v_pct >= v_threshold then
        select exists (
          select 1 from public.workout_posts
          where post_type = 'POST_CHALLENGE'
            and (metadata ->> 'challenge_id') = new.challenge_id::text
            and (metadata ->> 'milestone')::integer = v_threshold
        ) into v_already;

        if not v_already then
          insert into public.workout_posts
            (author_id, post_type, visibility, body, metadata, status, published_at, club_id)
          values (
            null, 'POST_CHALLENGE', 'club',
            v_threshold::text || '% of the way to ' || v_challenge.title,
            jsonb_build_object(
              'challenge_id', new.challenge_id,
              'challenge_title', v_challenge.title,
              'milestone', v_threshold,
              'club_total', v_club_total,
              'target_value', v_challenge.target_value
            ),
            'active', now(), v_challenge.club_id
          );
        end if;
      end if;
    end loop;
  end if;

  return new;
end $$;
revoke all on function public.challenge_progress_apply() from public, anon, authenticated;

commit;
