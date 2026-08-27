begin;

-- Right now anyone who finds the demo URL can sign in with any email and
-- create a community profile — fine for review, not fine once real
-- members start using this. Gate profile creation behind a single shared
-- invite code per role (member/coach), set by whoever runs this box.

create table public.invite_codes (
  code text primary key check (code ~ '^[A-Za-z0-9_-]{4,32}$'),
  role text not null default 'member' check (role in ('member', 'coach')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.invite_codes enable row level security;
-- Deliberately no grant to authenticated at all — nobody reads this table
-- directly, not even to check a code exists. redeem_invite_code() below
-- is the only path in, and it runs with the function owner's rights, same
-- pattern as coach_inactive_members().

create table public.invite_redemptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  code text not null references public.invite_codes(code),
  role text not null check (role in ('member', 'coach')),
  redeemed_at timestamptz not null default now()
);
alter table public.invite_redemptions enable row level security;
grant select on public.invite_redemptions to authenticated;
create policy invite_redemptions_self_select on public.invite_redemptions for select to authenticated using (user_id = auth.uid());
-- No insert policy for authenticated on purpose: a redemption can only be
-- created by redeem_invite_code(), never by a direct client insert.

create or replace function public.redeem_invite_code(p_code text) returns text
language plpgsql security definer set search_path = '' as $$
declare v_role text;
begin
  select role into v_role from public.invite_codes where code = p_code and active;
  if v_role is null then
    raise exception 'invalid or inactive invite code';
  end if;
  insert into public.invite_redemptions (user_id, code, role) values (auth.uid(), p_code, v_role)
    on conflict (user_id) do update set code = excluded.code, role = excluded.role, redeemed_at = now();
  return v_role;
end $$;
revoke all on function public.redeem_invite_code(text) from public, anon;
grant execute on function public.redeem_invite_code(text) to authenticated;

-- A profile can now only be created after a valid code was redeemed.
-- invite_redemptions.role ('member'/'coach') is a label only at this
-- point — it grants nothing by itself. The end state is three real tiers
-- (admin: full access; coach: scoped to their own relevant
-- classes/members; member) but "relevant" needs its own data model
-- (which classes/members a coach is actually attached to) that doesn't
-- exist yet, so a coach-code redemption must NOT be treated as
-- equivalent to is_admin here — that would wrongly grant a future-coach
-- full admin access today. is_admin stays exactly as strict as before
-- this migration: never settable by any client-side path, invite code or
-- otherwise, only ever set manually via the dashboard (bypassing RLS).
drop policy profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles for insert to authenticated with check (
  id = auth.uid()
  and is_admin = false
  and exists (select 1 from public.invite_redemptions ir where ir.user_id = auth.uid())
);

-- Bug found while building the above: profiles_update_self's check
-- required is_admin = false on every update — meaning the moment any
-- profile actually has is_admin = true (a real coach account), that
-- account can never save its own profile again, since the resulting row
-- still has is_admin = true and the check rejects it outright. Fixed
-- properly with a trigger that pins is_admin to its previous value on
-- every self-update (so no client-side path, upsert or otherwise, can
-- ever change it after creation) instead of blocking the whole update.
create or replace function public.protect_is_admin() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.is_admin = old.is_admin;
  return new;
end $$;
create trigger profiles_protect_is_admin before update on public.profiles for each row execute function public.protect_is_admin();

drop policy profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

commit;
