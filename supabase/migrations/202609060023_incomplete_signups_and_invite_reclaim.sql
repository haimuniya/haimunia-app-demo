begin;

-- Five-persona UX audit, defect 3 (MAJOR): ghost accounts consume invites.
--
-- THE SHAPE OF THE HOLE. Signup is two-stage and the stages are separated by
-- a three-slide carousel:
--
--   anonymous session -> redeem_invite_code() -> credentials -> CAROUSEL
--     -> the profiles insert -> mark_recovery_verified()
--
-- redeem_invite_code() (202609030003) is what consumes the invite: it bumps
-- invite_codes.use_count, or stamps invites.redeemed_at/redeemed_by, and
-- writes the invite_redemptions row. Everything after it is optional from
-- the database's point of view. Close the tab on slide two and what is left
-- is a real auth.users row, a real invite_redemptions row, a spent invite -
-- and NO public.profiles row.
--
-- WHY THAT ACCOUNT IS INVISIBLE. Every roster surface starts `from
-- public.profiles`: admin_member_roster (202609030005), admin_search_members
-- (202608270011), admin_user_directory. A row that does not exist cannot be
-- listed by any of them. registration_funnel (202609030006) can see the
-- SHAPE of the problem - its redeemed vs profile_completed steps are exactly
-- this gap - but it is aggregate-only by design and names nobody. So an
-- admin can see that four invites went missing and has no way at all to find
-- out which four, who they were for, or whether any of them can be reused.
--
-- WHY purge_abandoned_profiles() DOES NOT COVER IT. That job (202609010004,
-- runbook at docs/community/abandoned-profile-purge-runbook.md) requires all
-- four of: is_anonymous, no invite_redemptions row, no recovery_verified_at,
-- older than the window. A ghost created by an abandoned carousel FAILS the
-- second condition - it redeemed, that is the whole problem - so the purge
-- deliberately and correctly never touches it. These two paths are
-- complementary, not overlapping, and this migration is written to hand
-- accounts TO that job rather than duplicate it.
--
-- ------------------------------------------------------------------
-- WHY THIS FIX AND NOT THE OTHER TWO
-- ------------------------------------------------------------------
-- The three candidate fixes were weighed as follows.
--
-- (1) MOVE CONSUMPTION TO PROFILE CREATION. Rejected. The redemption row is
--     not bookkeeping, it is the membership fact itself: is_community_member(),
--     has_perm(), role_rank(), my_role_code() and every write gate in the
--     module read invite_redemptions, and the client's own gate order
--     (loadRedemption() -> credentials -> carousel -> profile) requires the
--     redemption to exist BEFORE the profile form is reachable. Deferring it
--     would mean a member holding a valid code who is not yet a member,
--     re-checking the code at profile-insert time (it may have been revoked,
--     expired or exhausted in between, with no UI anywhere for that failure),
--     and losing the row lock that makes concurrent redemption of one
--     single-use invite safe. That is a redesign of the invite gate, in the
--     highest-risk function in the module, to fix a reporting problem.
--
-- (2) FOLD THE GHOSTS INTO admin_member_roster(). Rejected. That function's
--     contract is that it returns admin_search_members' exact eight columns
--     in its exact order so ONE client row renderer serves both surfaces
--     (202609030005's own header). A ghost has no handle, no display name and
--     no avatar, so folding it in means either blank rows the renderer draws
--     with role controls that cannot work, or an extra column that breaks the
--     shared-shape contract. Either way the client has to change, so a
--     separate, honestly-named surface costs the same and lies less.
--
-- (3) SURFACE THEM EXPLICITLY, PLUS A RECLAIM PATH. Built. Two functions:
--     admin_incomplete_signups() makes them visible and identifiable, and
--     admin_reclaim_invite() puts the invite back into circulation and hands
--     the empty account to the purge job that already exists.
--
-- NO auth.users ROW IS EVER DELETED HERE, and none is soft-deleted either.
-- admin_reclaim_invite() releases the INVITE and nothing else. The account
-- keeps existing, and the member can walk back in with the same code (a
-- per-person invite returns to 'pending'; a shared code gets its use back).
-- Actual deletion stays where it already lives, with the retention window
-- and the runbook that documents it.

-- The one new action_type, and the one from 202609060022 restated with it -
-- this constraint is declared in full by whichever migration widens it last,
-- the module's convention since 202609010001.
alter table public.admin_actions drop constraint if exists admin_actions_action_type_check;
alter table public.admin_actions add constraint admin_actions_action_type_check check (action_type in (
  'content_delete', 'content_hide', 'member_restrict', 'member_unrestrict',
  'role_change', 'challenge_edit', 'achievement_edit', 'privacy_config',
  'content_pin', 'content_unpin', 'report_review', 'member_of_week_publish',
  'monthly_recap_publish', 'club_feature_toggle', 'invite_created',
  'invite_revoked', 'shared_code_created', 'shared_code_status_changed',
  'onboarding_content_updated', 'member_password_reset', 'announcement_edit',
  'member_remove', 'invite_reclaimed'
));

-- ===========================================================================
-- 1. admin_incomplete_signups() - making them visible
-- ===========================================================================
-- AUTH is is_staff(), matching admin_member_roster() rather than
-- admin_search_members(): this is the same read-only browse of who is in the
-- club, asked about the people who did not finish, and a coach chasing a
-- member who never appeared is the obvious first user of it. The RECLAIM
-- below is a different question and takes a real admin.
--
-- WHAT IT WILL NOT RETURN, and this is the part to coordinate with
-- identity-privacy on: `username` is the local part of auth.users.email AND
-- ONLY when the address is the synthetic one this app mints
-- (usernameToEmail() in cloud.js -> '<username>@members.haimuniya.invalid').
-- Any other address - a real one, from any future provider - returns NULL
-- rather than being handed to staff, because a login address a member gave
-- for authentication is not roster data. The synthetic local part is the
-- username the member typed into this app's own signup form and is exactly
-- what makes an otherwise nameless uuid identifiable to the admin trying to
-- help them.
--
-- `label` is the per-person invite's own admin-authored label ("דנה מהבוקר
-- של שני"), which is usually the ONLY thing that identifies a ghost who
-- abandoned before setting credentials.
--
-- A soft-deleted profile is NOT a ghost: that row exists, so admin_member_roster
-- already knows about it and this function must not double-report a removed
-- member as an unfinished signup. The predicate is "no profiles row at all".
create or replace function public.admin_incomplete_signups(
  p_cursor timestamptz default null,
  p_limit integer default 25)
returns table(
  user_id uuid, username text, label text, role text, invite_source text,
  redeemed_at timestamptz, signed_up_at timestamptz, last_sign_in_at timestamptz,
  stalled_days integer, purgeable_after_reclaim boolean
)
language plpgsql stable security definer set search_path = '' as $$
declare v_limit integer;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if not public.is_staff() then raise exception 'not authorized'; end if;

  -- Clamped 1..100: admin_actions_page, mod_queue and admin_member_roster's
  -- shared convention.
  v_limit := least(greatest(coalesce(p_limit, 25), 1), 100);

  return query
    select
      u.id,
      case when u.email like '%@members.haimuniya.invalid'
           then pg_catalog.split_part(u.email, '@', 1) end,
      i.label,
      ir.role,
      case when ir.invite_id is not null then 'shared_code' else 'person_invite' end,
      ir.redeemed_at,
      u.created_at,
      u.last_sign_in_at,
      (extract(day from (now() - ir.redeemed_at)))::integer,
      -- Whether purge_abandoned_profiles() would eventually collect this
      -- account once admin_reclaim_invite() has removed the redemption row
      -- that currently disqualifies it. is_anonymous is the only one of that
      -- job's four conditions still in question here: a ghost has no
      -- profiles row, so it can have no recovery_verified_at, and the
      -- retention window is the job's own parameter.
      coalesce(u.is_anonymous, false)
    from auth.users u
    join public.invite_redemptions ir on ir.user_id = u.id
    left join public.invites i on i.id = ir.person_invite_id
    where not exists (select 1 from public.profiles p where p.id = u.id)
      and (p_cursor is null or ir.redeemed_at < p_cursor)
    -- u.id is the tie-break for admin_member_roster's reason: a club that
    -- redeemed a batch of invites in one sitting shares timestamps, and a
    -- cursor paginator whose sort key repeats can loop or skip.
    order by ir.redeemed_at desc, u.id
    limit v_limit;
end $$;
revoke all on function public.admin_incomplete_signups(timestamptz, integer) from public, anon;
grant execute on function public.admin_incomplete_signups(timestamptz, integer) to authenticated;

comment on function public.admin_incomplete_signups(timestamptz, integer) is
  'Five-persona UX audit, defect 3. The accounts every roster surface is structurally blind to: an auth.users row that HAS redeemed an invite and has NO public.profiles row at all - a signup abandoned between redemption and the profile form, holding a spent invite. AUTH: security definer (auth.users is not client-reachable at all); auth.uid() first, then is_staff(), the same read-only browse rank admin_member_roster uses. Raises ''not authorized''. p_limit clamped 1..100; cursor pages backwards on invite_redemptions.redeemed_at with user_id as tie-break. RETURNS user_id, username, label, role, invite_source (shared_code | person_invite), redeemed_at, signed_up_at, last_sign_in_at, stalled_days, purgeable_after_reclaim. PRIVACY: username is the LOCAL PART of auth.users.email and only when the address is this app''s synthetic ''<username>@members.haimuniya.invalid'' form; any other address returns null, so a real login address is never handed to staff. label is the per-person invite''s own admin-authored label, which for a ghost that never set credentials is the only identifying string that exists. purgeable_after_reclaim is auth.users.is_anonymous - i.e. whether purge_abandoned_profiles() would collect this account once admin_reclaim_invite() removes the redemption row that currently disqualifies it. A soft-deleted profile is NOT reported here: that row exists and admin_member_roster already owns it. Read-only.';

-- ===========================================================================
-- 2. admin_reclaim_invite() - putting the invite back
-- ===========================================================================
-- AUTH is a real profiles.is_admin, not is_staff() and not a permission
-- code: this un-memberships an account. admin_remove_member() and
-- admin_grant_coach() take the same inline check for the same reason.
--
-- THE GRACE PERIOD IS A HARD FLOOR, NOT A DEFAULT. p_older_than_days is
-- clamped to at least 1, so no amount of admin urgency can reclaim an invite
-- out from under someone who is on slide two of the carousel RIGHT NOW.
-- Seven days is the default because an abandoned carousel is abandoned in
-- minutes, and because a member who comes back after a week and finds their
-- code spent has a worse day than the club has waiting a week.
--
-- WHAT IT DOES, exactly:
--   * shared code   -> invite_codes.use_count - 1 (floored at 0)
--   * person invite -> invites.redeemed_at / redeemed_by back to null, which
--                      is precisely what invite_status() reads as 'pending',
--                      so the invite reappears in admin_invite_list as
--                      outstanding and the SAME code works again
--   * deletes the invite_redemptions row
--   * soft-deletes the POST_NEW_MEMBER welcome post that redemption produced
--     (post_new_member_on_join, 202608290014). The club was told someone
--     joined; they did not, and retracting that is part of reclaiming the
--     redemption, not a separate cleanup. Soft, never hard, like every other
--     post removal in the module.
--   * writes one invite_reclaimed audit row through log_admin_action(), so
--     this is reviewable under 202609060022's rules like any other staff act
--
-- WHAT IT DOES NOT DO: it does not touch auth.users. The account stays,
-- signed-in sessions stay valid, and the member simply lands back on the
-- invite screen - which is the correct place for someone who is no longer
-- holding a redemption. Deletion remains purge_abandoned_profiles()'s job,
-- under its own retention window and its own runbook, and this function's
-- whole effect on that job is to remove the one condition that was keeping
-- an empty anonymous account out of its reach.
--
-- REFUSALS ARE NAMED, never silent, because every one of them means the
-- admin is looking at a different situation than they think:
--   'member has a profile'          -> not a ghost; admin_remove_member is
--                                      the function they want
--   'signup is still in progress'   -> inside the grace period
--   'no invite to reclaim'          -> no redemption row
create or replace function public.admin_reclaim_invite(
  p_user_id uuid,
  p_note text default null,
  p_older_than_days integer default 7)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_days integer;
  v_red public.invite_redemptions;
  v_source text;
  v_invite_id uuid;
  v_posts integer := 0;
  v_anon boolean;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not exists (select 1 from public.profiles where id = v_uid and is_admin and deleted_at is null) then
    raise exception 'not authorized';
  end if;
  if p_user_id is null then raise exception 'target account required'; end if;
  if p_user_id = v_uid then raise exception 'cannot reclaim your own invite'; end if;

  -- The floor. greatest(...,1), not coalesce alone: a caller passing 0 or a
  -- negative number gets one day, not "right now".
  v_days := greatest(coalesce(p_older_than_days, 7), 1);

  -- A profiles row - even a soft-deleted one - means this account finished
  -- signup and is a member's, not a ghost's.
  if exists (select 1 from public.profiles p where p.id = p_user_id) then
    raise exception 'member has a profile';
  end if;

  select * into v_red from public.invite_redemptions r where r.user_id = p_user_id;
  if not found then raise exception 'no invite to reclaim'; end if;
  if v_red.redeemed_at > now() - (v_days || ' days')::interval then
    raise exception 'signup is still in progress';
  end if;

  select coalesce(u.is_anonymous, false) into v_anon from auth.users u where u.id = p_user_id;

  if v_red.invite_id is not null then
    v_source := 'shared_code';
    v_invite_id := v_red.invite_id;
    -- Floored at zero. use_count is also the shared code's rate-limit
    -- counter, and a negative one would hand out unlimited redemptions.
    update public.invite_codes
       set use_count = greatest(use_count - 1, 0)
     where id = v_red.invite_id;
  else
    v_source := 'person_invite';
    v_invite_id := v_red.person_invite_id;
    -- Only when this account is still the one holding it. A revoked invite
    -- is left revoked: invites_not_both_revoked_and_redeemed would refuse a
    -- half-reset row anyway, and un-revoking is a decision this function has
    -- no business taking.
    update public.invites
       set redeemed_at = null, redeemed_by = null
     where id = v_red.person_invite_id
       and redeemed_by = p_user_id
       and revoked_at is null;
  end if;

  delete from public.invite_redemptions where user_id = p_user_id;

  -- The welcome post. Pinned because the caller is an authenticated admin
  -- and workout_posts_guard_moderated_fields refuses deleted_at otherwise.
  perform set_config('app.allow_moderation_write', 'on', true);
  with retracted as (
    update public.workout_posts
       set deleted_at = now(), status = 'removed'
     where post_type = 'POST_NEW_MEMBER'
       and (metadata ->> 'member_id') = p_user_id::text
       and deleted_at is null
    returning 1
  ) select count(*) into v_posts from retracted;
  perform set_config('app.allow_moderation_write', 'off', true);

  perform public.log_admin_action(
    'invite_reclaimed', 'member', p_user_id,
    jsonb_build_object(
      'invite_source', v_source,
      'invite_id', v_invite_id,
      'role', v_red.role,
      'redeemed_at', v_red.redeemed_at),
    jsonb_build_object(
      'released', true,
      'welcome_posts_retracted', v_posts,
      'purgeable', v_anon),
    'reclaim', p_note, p_user_id
  );

  return jsonb_build_object(
    'user_id', p_user_id,
    'invite_source', v_source,
    'invite_id', v_invite_id,
    'released', true,
    'welcome_posts_retracted', v_posts,
    'purgeable_by_purge_abandoned_profiles', v_anon);
end $$;
revoke all on function public.admin_reclaim_invite(uuid, text, integer) from public, anon;
grant execute on function public.admin_reclaim_invite(uuid, text, integer) to authenticated;

comment on function public.admin_reclaim_invite(uuid, text, integer) is
  'Five-persona UX audit, defect 3. Returns the invite an abandoned signup is holding to circulation, WITHOUT deleting the account. AUTH: security definer; auth.uid() first, then a real profiles.is_admin row - not is_staff() and not a permission code, because this un-memberships an account. Raises (all P0001) ''not authorized'', ''target account required'', ''cannot reclaim your own invite'', ''member has a profile'' (a profiles row exists, even soft-deleted - admin_remove_member is the function for that), ''no invite to reclaim'' (no invite_redemptions row), ''signup is still in progress'' (redeemed inside the grace window). p_older_than_days defaults to 7 and is FLOORED at 1, so no call can reclaim a code out from under someone mid-carousel. SIDE EFFECTS: a shared code gets invite_codes.use_count decremented (floored at 0); a per-person invite has redeemed_at/redeemed_by cleared so invite_status() reads it as ''pending'' again and the same code works - unless it was revoked in the meantime, which is left alone; the invite_redemptions row is deleted; the POST_NEW_MEMBER welcome post that redemption produced is soft-deleted; one invite_reclaimed admin_actions row is written. NEVER touches auth.users: the session stays valid and the member simply lands back on the invite screen. Removing the redemption is also the ONE condition that was keeping an empty anonymous account out of purge_abandoned_profiles() (202609010004), so afterwards that job collects it under its own retention window - see docs/community/abandoned-profile-purge-runbook.md. RETURNS jsonb {user_id, invite_source, invite_id, released, welcome_posts_retracted, purgeable_by_purge_abandoned_profiles}.';

commit;
