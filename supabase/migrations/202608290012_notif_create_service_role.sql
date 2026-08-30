begin;

-- COMM-220 follow-up, one line, same shape as 202608290011's
-- default_club_id() fix.
--
-- notif_create() (202608280026) is `revoke all ... from public, anon,
-- authenticated`. Every caller until now has been a trigger owned by the
-- migration owner (comment/mention/reaction/announcement/achievement) or
-- another security definer function calling it as a plain SQL statement -
-- in both cases Postgres checks EXECUTE against the owning role, which is
-- effectively unrestricted, so the missing service_role grant never
-- showed. recap_weekly (COMM-220) is the first caller that reaches
-- notif_create over PostgREST, as the literal `service_role` database
-- role, which DOES have EXECUTE checked for real - and does not have it,
-- because `revoke all ... from public` also strips whatever service_role
-- was getting through the default-to-PUBLIC EXECUTE grant every function
-- gets at creation, and nothing since has granted it back explicitly.
-- Without this, every recap_weekly notif_create call fails 42501 and no
-- member ever gets a weekly_recap notification.
grant execute on function public.notif_create(uuid, text, text, text, text, text, uuid, text) to service_role;

commit;
