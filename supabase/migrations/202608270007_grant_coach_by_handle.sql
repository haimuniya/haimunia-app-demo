begin;

-- Convenience wrapper for the operator: promoting a coach in practice
-- means looking someone up by their profile handle (what's actually
-- visible in the app and in member search), not by a UUID nobody has on
-- hand. Same security posture as grant_coach_role(uuid) exactly —
-- service-role only, no client-reachable path, no new privilege this
-- doesn't already grant through the existing function.
create or replace function public.grant_coach_role_by_handle(p_handle text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid;
begin
  select id into v_user_id from public.profiles where handle = p_handle;
  if v_user_id is null then raise exception 'no profile found with that handle'; end if;
  update public.invite_redemptions set role = 'coach', redeemed_at = now() where user_id = v_user_id;
  if not found then raise exception 'user must redeem a member invite before coach access is granted'; end if;
end $$;
revoke all on function public.grant_coach_role_by_handle(text) from public, anon, authenticated;
grant execute on function public.grant_coach_role_by_handle(text) to service_role;

commit;
