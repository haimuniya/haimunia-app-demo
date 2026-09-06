begin;

-- Launch-readiness audit, finding 7: profiles.avatar_url has no CHECK at
-- all.
--
-- THE HOLE. `avatar_url text` (202608260001), with no length limit and no
-- scheme limit, and profiles_update_self is `using (id = auth.uid()) with
-- check (id = auth.uid())` - unrestricted by column, as 202609010010's own
-- comment cheerfully points out. So any member can write any string they
-- like into a column that ~30 call sites in cloud.js hand straight to
-- avatarHtml() as an `<img src>`, and that admin_search_members(),
-- member_roster(), people_suggestions() and community_search() all republish
-- to other members' screens. `javascript:...` and `data:text/html,...` are
-- both valid text.
--
-- This is the exact rule events.map_link got in 202609050004 and
-- notifications.deep_link has carried since it existed, applied to the one
-- remaining client-writable column that is rendered as a URL. Its reasoning
-- is the same word for word: forbid the schemes that execute, cap the
-- length, and leave "is this a real image" to the person typing it. If
-- anything the case is stronger here, because map_link is writable only by
-- community.event.manage holders while avatar_url is writable by every
-- member of the club.
--
-- THE RULE: null, or at most 500 characters starting with http:// or
-- https://, case-insensitively. Anchored with ^ so `javascript:void(0)//https://x`
-- cannot pass. 500 matches map_link; the real values the client writes are
-- roughly 120 characters (the Storage /object/public/ form plus a ?t=
-- cache-bust), so there is a wide margin and no risk of an honest value
-- being cut off.
--
-- STILL AN https URL AFTER 202609060003 MADE THE BUCKET PRIVATE, on
-- purpose. profiles.avatar_url keeps storing the /object/public/ form as a
-- stable identifier for the object; the bytes are now fetched through a
-- short-lived signed URL resolved at render time. Keeping the stored shape
-- means every already-written row stays valid under this constraint,
-- avatarPathFromUrl() keeps parsing, and the column keeps being a URL rather
-- than becoming an untyped path that this CHECK could no longer describe.
--
-- WIDENING BY DROP-AND-RE-ADD, the mechanism 202609050004, 202609030004 and
-- 202609050002 all use, because Postgres cannot alter a CHECK expression in
-- place. The column has never had one, so the lookup below normally finds
-- nothing; it is written as a lookup anyway, exactly as 202609050004 did, so
-- a live project that grew one by hand is corrected rather than left with
-- two constraints contradicting each other.
--
-- ROWS THAT WOULD FAIL. Added VALIDATED, so a pre-existing row with a
-- non-http avatar_url fails this migration loudly rather than being
-- grandfathered in - the intended behaviour for a constraint whose entire
-- purpose is that nothing gets past it. The only writer that has ever
-- existed is uploadAvatarPhoto(), which produces the Storage URL, so there
-- is nothing live to trip it. If a project ever does, the fix is to null the
-- offending value, not to weaken the check.

do $$
declare v_name text;
begin
  select conname into v_name from pg_constraint
  where conrelid = 'public.profiles'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%avatar_url%';
  if v_name is not null then
    execute format('alter table public.profiles drop constraint %I', v_name);
  end if;
end $$;

alter table public.profiles
  add constraint profiles_avatar_url_check
  check (
    avatar_url is null
    or (char_length(avatar_url) <= 500 and avatar_url ~* '^https?://')
  );

commit;
