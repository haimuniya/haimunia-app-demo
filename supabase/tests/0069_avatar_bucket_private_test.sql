-- Launch-readiness audit, finding 3 (202609060003). avatar-photos is a
-- private bucket now, and its SELECT policy is a real boundary.
--
-- THE VECTOR THIS FILE REPRODUCES. The bucket was created with
-- public = true, and a public bucket is served by an endpoint that does not
-- evaluate SELECT RLS at all, so the object bytes were reachable with no
-- session whatsoever - verified live with an unauthenticated GET of
-- /storage/v1/object/public/avatar-photos/{uuid}/avatar.webp. On top of that
-- avatar_photos_select_all was declared `for select` with no `to` clause,
-- which is `to public` - the anon role included - so even once the bucket
-- went private that policy would have been the hole rather than the fix.
--
-- A pgTAP test cannot make an HTTP request, so the flag itself is asserted
-- directly (section 1) and the policy that becomes load-bearing the moment
-- the flag is false is asserted behaviourally (sections 2 onward). This is
-- the first file in the suite to cover storage.objects RLS at all.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-0069-4000-8000-000000000001',
        'authenticated', 'authenticated', 'ghost69@members.haimuniya.invalid',
        '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now())
on conflict (id) do nothing;

-- One avatar object per member, at the exact path the client writes:
-- {auth.uid()}/avatar.{ext}.
insert into storage.objects (bucket_id, name, owner_id)
values
  ('avatar-photos', tests.uid('m1')::text || '/avatar.webp', tests.uid('m1')::text),
  ('avatar-photos', tests.uid('m2')::text || '/avatar.webp', tests.uid('m2')::text),
  ('avatar-photos', tests.uid('m3')::text || '/avatar.webp', tests.uid('m3')::text);

-- =====================================================================
-- 1. The flag, and the policy shape
-- =====================================================================
select is(
  (select public from storage.buckets where id = 'avatar-photos'), false,
  'THE FIX: avatar-photos is private. While it was public the /object/public/ endpoint served every member''s face to the open internet with no session at all, and the three RLS policies on it were decoration');
select is(
  (select public from storage.buckets where id = 'post-photos'), false,
  'which is what post-photos has been since 202608270004 - the two buckets now agree');

select is_empty(
  $$ select polname from pg_catalog.pg_policy
     where polrelid = 'storage.objects'::regclass and polname = 'avatar_photos_select_all' $$,
  'the old avatar_photos_select_all is gone - it was `for select` with no `to` clause, which is `to public`, anon included');
select is(
  (select string_agg(r.rolname::text, ',' order by r.rolname::text)
   from pg_catalog.pg_policy p
   join pg_catalog.pg_roles r on r.oid = any(p.polroles)
   where p.polrelid = 'storage.objects'::regclass
     and p.polname::text = 'avatar_photos_select_own_or_visible'),
  'authenticated',
  'and its replacement is scoped to authenticated and to nothing else');

-- =====================================================================
-- 2. Reading: the bytes are readable exactly as far as the profiles row
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select is(
  (select count(*)::int from storage.objects
   where bucket_id = 'avatar-photos' and name = tests.uid('m1')::text || '/avatar.webp'), 1,
  'a member reads their own avatar object unconditionally - the own-path branch is outside every gate, so an avatar uploaded mid-onboarding is still visible to its owner');
select is(
  (select count(*)::int from storage.objects
   where bucket_id = 'avatar-photos' and name = tests.uid('m2')::text || '/avatar.webp'), 1,
  'and another member''s, while that member is visible to the club');

select tests.clear_auth();
update public.profiles set visible_to_club = false where id = tests.uid('m2');
select tests.set_auth(tests.uid('m1'));
select is(
  (select count(*)::int from storage.objects
   where bucket_id = 'avatar-photos' and name = tests.uid('m2')::text || '/avatar.webp'), 0,
  'a member who hides from the club hides their FACE too - which is the rule 202609010010 said it wanted ("profiles already has exactly one visibility gate") and a public bucket could not enforce');
select tests.set_auth(tests.uid('m2'));
select is(
  (select count(*)::int from storage.objects
   where bucket_id = 'avatar-photos' and name = tests.uid('m2')::text || '/avatar.webp'), 1,
  'and still sees it themselves');
select tests.clear_auth();
update public.profiles set visible_to_club = true where id = tests.uid('m2');

insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m3'), tests.uid('m1'));
select tests.set_auth(tests.uid('m1'));
select is(
  (select count(*)::int from storage.objects
   where bucket_id = 'avatar-photos' and name = tests.uid('m3')::text || '/avatar.webp'), 0,
  'a block cuts the avatar in both directions, because can_view_profile_field settles block edges on the way through - the storage boundary cannot drift from the table boundary when it is asking the same function');
select tests.clear_auth();
delete from public.blocks where blocker_id = tests.uid('m3') and blocked_id = tests.uid('m1');

-- =====================================================================
-- 3. The anonymous read gate reaches storage too
-- =====================================================================
select tests.set_auth('aaaaaaaa-0069-4000-8000-000000000001'::uuid);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'avatar-photos'), 0,
  'a ghost session reads no avatar at all - is_community_member() gates the other-member branch here exactly as it does on profiles');
select tests.set_auth(tests.uid('norec'));
select is(
  (select count(*)::int from storage.objects where bucket_id = 'avatar-photos'), 0,
  'and neither does a redeemed member who has not verified a recovery method yet');

select tests.clear_auth();
select set_config('role', 'anon', true);
select is(
  (select count(*)::int from storage.objects where bucket_id = 'avatar-photos'), 0,
  'and a signed-out anon session matches no policy on this bucket at all');
select tests.clear_auth();

-- =====================================================================
-- 4. Writing: unchanged by this migration, and asserted so
-- =====================================================================
-- 202609010010's three write policies all key off can_write_own_avatar(),
-- which pins the uid path prefix. Nothing here touched them; this is the
-- first coverage they have had.
select tests.set_auth(tests.uid('m1'));
select is(public.can_write_own_avatar(tests.uid('m1')::text || '/avatar.webp'), true,
  'can_write_own_avatar accepts the member''s own path');
select is(public.can_write_own_avatar(tests.uid('m2')::text || '/avatar.webp'), false,
  'and refuses somebody else''s, which is what stops an upload overwriting another member''s face');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name, owner_id)
     values ('avatar-photos', tests.uid('m2')::text || '/hijack.webp', tests.uid('m1')::text) $$,
  '42501',
  null,
  'and the insert policy refuses it for real, not just the helper');
select lives_ok(
  $$ insert into storage.objects (bucket_id, name, owner_id)
     values ('avatar-photos', tests.uid('m1')::text || '/avatar.png', tests.uid('m1')::text) $$,
  'while the member''s own second upload (a different resolved extension) is accepted');

select * from finish();
rollback;
