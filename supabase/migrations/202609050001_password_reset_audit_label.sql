begin;

-- One label. `admin_actions.action_type` gains 'member_password_reset' so an
-- admin-initiated password reset for a member can be audited like every other
-- sensitive staff action.
--
-- WHY A NEW LABEL RATHER THAN REUSING ONE. The list is deliberately closed
-- (202608280002) and every widening since has argued the same point: an audit
-- row may not describe something that did not happen. 'role_change' is a role
-- change, 'privacy_config' is a privacy setting, 'member_restrict' is a
-- restriction. A password reset is none of those - it is a credential act on
-- someone else's account, the single most sensitive thing an admin can do to a
-- member, and it needs its own name in the log or it is invisible.
--
-- `target_type` is NOT touched. It has carried 'member' since 202608280002 and
-- that is exactly right for this: the target of a password reset is a member,
-- not a new kind of object. Same finding 202609010001 recorded when it widened
-- action_type alone.
--
-- The widening is the same drop/re-add both 202609010001 and 202609030004 use.
-- Postgres cannot alter a CHECK expression in place, so the whole list is
-- restated - which is also why the list below is the 202609030004 list verbatim
-- plus one entry, and not a rewrite.
--
-- =====================================================================
-- AND THE ONE THING THAT CAN WRITE IT
-- =====================================================================
-- A label with no writer is dead schema, so the writer ships here too.
--
-- The constraint that shapes it: `log_admin_action()` (202608280002) is
-- `revoke all ... from public, anon, authenticated`, and `admin_actions` has no
-- INSERT policy and no INSERT grant. The only writers are other SECURITY
-- DEFINER functions - that is what makes the log unforgeable. Meanwhile the
-- password reset ITSELF cannot happen in SQL at all: GoTrue owns
-- auth.users.encrypted_password and the supported way to set one is the Auth
-- Admin API, which lives outside Postgres.
--
-- So the act is split, and each half is done where it belongs:
--   * supabase/functions/admin_reset_password/ performs the reset with the
--     service-role key through auth.admin.updateUserById(), then
--   * calls public.admin_log_password_reset(p_user_id) below WITH THE ACTING
--     ADMIN'S OWN JWT, not the service-role key, so `auth.uid()` inside this
--     definer function is a real person and the audit row names them.
--
-- That last point is the whole reason this function takes only a target and
-- has no p_admin_id parameter: the actor is read from the session and can
-- never be passed in, so an Edge Function cannot attribute a reset to somebody
-- who did not do it. It also re-checks profiles.is_admin server-side rather
-- than trusting that the Edge Function already did - the same defence in depth
-- admin_grant_coach and mod_restrict_member carry.

alter table public.admin_actions drop constraint if exists admin_actions_action_type_check;
alter table public.admin_actions add constraint admin_actions_action_type_check check (action_type in (
  'content_delete', 'content_hide', 'member_restrict', 'member_unrestrict',
  'role_change', 'challenge_edit', 'achievement_edit', 'privacy_config',
  'content_pin', 'content_unpin', 'report_review',
  'member_of_week_publish',
  'monthly_recap_publish',
  'club_feature_toggle',
  'invite_created', 'invite_revoked',
  'shared_code_created', 'shared_code_status_changed',
  'onboarding_content_updated',
  -- Admin-initiated password reset for a member. target_type is 'member',
  -- target_id is that member's profiles.id.
  'member_password_reset'
));

-- ---------------------------------------------------------------------
-- The audit writer
-- ---------------------------------------------------------------------
-- Auth: a REAL profiles.is_admin row, the narrow gate - not is_staff(), not
-- has_perm(). Resetting another member's credentials is not a coaching task
-- and head_coach does not get it. This is the same `exists (select 1 from
-- public.profiles where id = v_uid and is_admin and deleted_at is null)`
-- predicate admin_grant_coach and admin_revoke_coach (202608270011) use, and
-- it is written with the columns unaliased exactly as they are there, which is
-- safe because this function returns void and so has no OUT parameters to
-- shadow them - the distinction 202609030007 documents at length.
--
-- Writes ONLY the audit row. It does not reset anything, cannot reset
-- anything, and must not be mistaken for the reset itself: calling it without
-- having performed a reset writes a true-looking row about an event that did
-- not happen, which is why its only caller is the Edge Function that just did
-- the reset, immediately after.
create or replace function public.admin_log_password_reset(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not exists (select 1 from public.profiles where id = v_uid and is_admin and deleted_at is null) then
    raise exception 'not authorized';
  end if;
  if p_user_id is null then raise exception 'target member required'; end if;
  if not exists (select 1 from public.profiles where id = p_user_id and deleted_at is null) then
    raise exception 'member not found';
  end if;

  -- before_data is null: there is no prior state to record. A password has no
  -- readable "before", and recording a hash - even a partial one - in a table
  -- every community.analytics.view holder can read would be the opposite of
  -- what this row is for. after_data carries the method, not the credential.
  perform public.log_admin_action(
    'member_password_reset', 'member', p_user_id,
    null,
    jsonb_build_object('method', 'admin_temp_password')
  );
end $$;
revoke all on function public.admin_log_password_reset(uuid) from public, anon;
grant execute on function public.admin_log_password_reset(uuid) to authenticated;
comment on function public.admin_log_password_reset(uuid) is
  'Writes the ''member_password_reset'' / ''member'' audit row for an admin-initiated password reset, and NOTHING ELSE - it does not and cannot reset a password (GoTrue owns auth.users.encrypted_password; supabase/functions/admin_reset_password does the reset through the Auth Admin API and then calls this). Auth: a real profiles.is_admin row that is not soft-deleted; anything else raises ''not authorized''. Raises ''target member required'' on a null target and ''member not found'' when the target has no live profile. THE ACTOR IS auth.uid() AND CANNOT BE PASSED IN, which is why the caller must invoke this with the acting admin''s own JWT rather than the service-role key - a service-role call has no auth.uid() and is refused. before_data is null and after_data is {"method": "admin_temp_password"}: no credential material, not even a hash, is ever written, because admin_actions is readable by every community.analytics.view holder. Granted to authenticated (the gate is the is_admin check inside), unlike log_admin_action() itself which is granted to no client role.';

commit;
