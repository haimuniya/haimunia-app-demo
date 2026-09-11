begin;

-- Security hunt, round 8 (2026-09-12), identity/display-spoofing agent.
--
-- profiles_guard_staff_impersonation_trigger (202609060015, SEC-019) is
-- `before update of display_name` only. Confirmed live against real local
-- Postgres: a brand-new member's FIRST profile write is an INSERT, not an
-- UPDATE (saveProfile() in cloud.js does update-if-exists, insert
-- otherwise, and there is no existing row for a new member) - so the
-- guard never runs for the exact moment a member sets a staff-claiming
-- name for the first time, and never runs again as long as they leave
-- display_name untouched afterward (`new.display_name is not distinct
-- from old.display_name` short-circuits every later no-op-to-name
-- update). A plain member could permanently keep a name like "מאמן דני"
-- from day one with zero enforcement ever applying to them.
--
-- Also confirmed live: the same free-text staff-word claim works in `bio`
-- too (no guard exists for that column at all, insert or update), and
-- `bio` renders next to the name in the directory and profile view.
--
-- Fix: fire on INSERT as well as UPDATE OF display_name, and add bio to
-- both the trigger's column list and the check - one function, one staff-
-- word pattern, covering the two free-text fields a member could use to
-- make the same claim.

create or replace function public.profiles_guard_staff_impersonation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_re text := '(^|[^a-zא-ת])(מאמן|מאמנת|מנהל|מנהלת|צוות|admin|coach|staff|moderator|owner)([^a-zא-ת]|$)';
  v_name_changed boolean;
  v_bio_changed boolean;
begin
  if coalesce(auth.role(), '') <> 'authenticated' then return new; end if;

  v_name_changed := (TG_OP = 'INSERT') or (new.display_name is distinct from old.display_name);
  v_bio_changed := (TG_OP = 'INSERT') or (new.bio is distinct from old.bio);
  if not v_name_changed and not v_bio_changed then return new; end if;

  if public.is_staff()
     or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin and p.deleted_at is null)
  then
    return new;
  end if;

  if v_name_changed and lower(btrim(coalesce(new.display_name, ''))) ~ v_re then
    raise exception 'display name may not claim a staff role';
  end if;
  if v_bio_changed and lower(btrim(coalesce(new.bio, ''))) ~ v_re then
    raise exception 'bio may not claim a staff role';
  end if;

  return new;
end $$;
revoke all on function public.profiles_guard_staff_impersonation() from public, anon, authenticated;

drop trigger if exists profiles_guard_staff_impersonation_trigger on public.profiles;
create trigger profiles_guard_staff_impersonation_trigger
  before insert or update of display_name, bio on public.profiles
  for each row execute function public.profiles_guard_staff_impersonation();

comment on function public.profiles_guard_staff_impersonation() is
  'Security hunt round 7 origin: launch-readiness audit SEC-019; widened round 8 (202609120007). BEFORE INSERT OR UPDATE OF display_name, bio on profiles. Raises ''display name may not claim a staff role'' or ''bio may not claim a staff role'' (P0001) when a non-staff, non-admin member''s display_name or bio contains a staff word (מאמן/מאמנת/מנהל/מנהלת/צוות/admin/coach/staff/moderator/owner) as a whole token. Real staff are exempt, so a coach may of course call themselves a coach. Fires on INSERT too, not just UPDATE - a new member''s first profile write is an insert, and the original UPDATE-only version never covered it. Deliberately NOT a uniqueness constraint on either column: they are not identifiers and two real members may legitimately share one; what is being prevented is claiming a ROLE, not collision.';

commit;
