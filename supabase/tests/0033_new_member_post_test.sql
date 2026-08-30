-- COMM-107: behavioural coverage for 202608290014, the POST_NEW_MEMBER
-- producer that was specified in Phase 1, rendered by cloud.js since Phase 1,
-- and never actually built as a server insert until now.
--
-- What this file has to prove, in order of how badly each would hurt:
--
-- 1. The shape. renderNewMemberPostCard and test/community-post-cards.test.mjs
--    are already shipped and already read {member_id, member_name, joined_on}.
--    If this insert writes any other shape the card silently degrades in
--    members' hands with nothing failing anywhere. So the metadata keys, and
--    the JSON type of member_id (the client compares it with === against a
--    uuid string), are asserted directly rather than via a count.
--
-- 2. Both triggers. invite_redemptions now carries two AFTER INSERT ROW
--    triggers - this one and seed_onboarding_progress (202608290011). Postgres
--    documents that all matching triggers fire, but "documented" is not
--    "true in this database", and a regression where adding the second one
--    quietly cost us the first would break onboarding for every new member.
--    One insert, both effects asserted.
--
-- 3. Exactly one post per member, ever. A duplicate welcome post is visible
--    club-wide and cannot be undone by the member it is about.
--
-- 4. The join-ordering reality. A redemption lands BEFORE the profile exists
--    (profiles_insert_self requires the redemption), so the common production
--    case is "no profile to read a name from". That must produce a post
--    anyway, with member_name absent rather than placeholder-filled, and must
--    not create or wait for a profile.
--
-- 5. The post is actually reachable. An authorless row has null author_id,
--    which flows through posts_feed_select's blocks subquery and its
--    author_id = auth.uid() branch. If null broke either, the post would
--    exist and be invisible to everyone.
--
-- 6. The producer is server-only. Nothing client-side may call it.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- The fixture redemptions each produced one welcome post
-- =====================================================================
select tests.clear_auth();

select results_eq(
  $$ select count(*)::int from public.workout_posts where post_type = 'POST_NEW_MEMBER' $$,
  $$ select count(*)::int from public.invite_redemptions $$,
  'every fixture redemption produced exactly one POST_NEW_MEMBER row - no member missed, none doubled');

select results_eq(
  $$ select count(*)::int from public.workout_posts
     where post_type = 'POST_NEW_MEMBER' and author_id is not null $$,
  $$ values (0) $$,
  'every welcome post is authorless - this is the club speaking, not the new member');

-- Fires for coach and owner redemptions too, not just role = 'member'. Only
-- the promote-an-existing-member path is excluded, and that is an UPDATE.
select isnt_empty(
  $$ select 1 from public.workout_posts
     where post_type = 'POST_NEW_MEMBER' and (metadata ->> 'member_id') = tests.uid('coach')::text $$,
  'a coach-code redemption is a joining too and gets a welcome post');

-- =====================================================================
-- The metadata shape the shipped renderer reads
-- =====================================================================
-- rls_helpers inserts profiles before redemptions, so these fixture members
-- DO have a name at trigger time. The no-profile case is exercised further
-- down, where it belongs.
select results_eq(
  $$ select metadata ->> 'member_id', metadata ->> 'member_name'
     from public.workout_posts
     where post_type = 'POST_NEW_MEMBER' and (metadata ->> 'member_id') = tests.uid('m1')::text $$,
  $$ values (tests.uid('m1')::text, 'Member A') $$,
  'member_id and member_name carry the values renderNewMemberPostCard reads');

select results_eq(
  $$ select jsonb_typeof(metadata -> 'member_id') from public.workout_posts
     where post_type = 'POST_NEW_MEMBER' and (metadata ->> 'member_id') = tests.uid('m1')::text $$,
  $$ values ('string') $$,
  'member_id is a JSON string - findNewMemberPost compares it with === against a uuid string');

select results_eq(
  $$ select (metadata -> 'joined_on') is not null,
            (metadata ->> 'joined_on')::timestamptz = ir.redeemed_at
     from public.workout_posts p
     join public.invite_redemptions ir on ir.user_id = tests.uid('m1')
     where p.post_type = 'POST_NEW_MEMBER' and (p.metadata ->> 'member_id') = tests.uid('m1')::text $$,
  $$ values (true, true) $$,
  'joined_on is the redemption timestamp, the module''s authoritative MEMBER_JOINED moment');

select results_eq(
  $$ select array(select jsonb_object_keys(metadata) order by 1) from public.workout_posts
     where post_type = 'POST_NEW_MEMBER' and (metadata ->> 'member_id') = tests.uid('m1')::text $$,
  $$ values (array['joined_on', 'member_id', 'member_name']) $$,
  'and those three keys are the whole of metadata - no extra shape invented alongside the one the client reads');

-- =====================================================================
-- The row's own columns
-- =====================================================================
select results_eq(
  $$ select author_id, post_type::text, visibility::text, status::text,
            club_id, source_type, source_id, deleted_at, is_pinned
     from public.workout_posts
     where post_type = 'POST_NEW_MEMBER' and (metadata ->> 'member_id') = tests.uid('m1')::text $$,
  $$ values (null::uuid, 'POST_NEW_MEMBER', 'club', 'active',
             '11111111-1111-1111-1111-111111111111'::uuid, 'member', tests.uid('m1'),
             null::timestamptz, false) $$,
  'authorless, club-visible, active, in the default club, sourced to the member');

select results_eq(
  $$ select published_at = ir.redeemed_at, occurred_on = ir.redeemed_at::date
     from public.workout_posts p
     join public.invite_redemptions ir on ir.user_id = tests.uid('m1')
     where p.post_type = 'POST_NEW_MEMBER' and (p.metadata ->> 'member_id') = tests.uid('m1')::text $$,
  $$ values (true, true) $$,
  'the post is dated at the join, not at whenever the trigger happened to run');

select isnt_empty(
  $$ select 1 from public.workout_posts
     where post_type = 'POST_NEW_MEMBER' and (metadata ->> 'member_id') = tests.uid('m1')::text
       and body is not null and char_length(body) between 1 and 1000 $$,
  'body is set and within the 1000-char CHECK - the card does not render it, but a null body would be a lie about a post that has one');

-- =====================================================================
-- A real join: redemption first, profile later
-- =====================================================================
-- This is the production ordering. profiles_insert_self (202608270003)
-- requires an invite_redemptions row to exist, so the profile CANNOT be there
-- when this trigger fires.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-0000-4000-8000-0000000000f1',
        'authenticated', 'authenticated', 'joiner@members.haimuniya.invalid',
        '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now());

select is_empty(
  $$ select 1 from public.workout_posts
     where post_type = 'POST_NEW_MEMBER' and (metadata ->> 'member_id') = 'aaaaaaaa-0000-4000-8000-0000000000f1' $$,
  'an auth user who has not redeemed has no welcome post - signing up is not joining');

insert into public.invite_redemptions (user_id, invite_id, role)
values ('aaaaaaaa-0000-4000-8000-0000000000f1', '11111111-2222-4333-8444-555555555555', 'member');

-- --- effect 1 of the one insert: the welcome post -------------------
select results_eq(
  $$ select count(*)::int from public.workout_posts
     where post_type = 'POST_NEW_MEMBER' and (metadata ->> 'member_id') = 'aaaaaaaa-0000-4000-8000-0000000000f1' $$,
  $$ values (1) $$,
  'the redemption alone created exactly one welcome post, with no profile in existence');

select is_empty(
  $$ select 1 from public.profiles where id = 'aaaaaaaa-0000-4000-8000-0000000000f1' $$,
  'and it did not invent a profile row on the way - this trigger only creates a post');

select results_eq(
  $$ select array(select jsonb_object_keys(metadata) order by 1) from public.workout_posts
     where post_type = 'POST_NEW_MEMBER' and (metadata ->> 'member_id') = 'aaaaaaaa-0000-4000-8000-0000000000f1' $$,
  $$ values (array['joined_on', 'member_id']) $$,
  'member_name is absent rather than placeholder-filled - the client fallback chain is what a missing name is for, and a stored placeholder would be indistinguishable from a real name');

select results_eq(
  $$ select author_id, post_type::text, visibility::text, status::text from public.workout_posts
     where post_type = 'POST_NEW_MEMBER' and (metadata ->> 'member_id') = 'aaaaaaaa-0000-4000-8000-0000000000f1' $$,
  $$ values (null::uuid, 'POST_NEW_MEMBER', 'club', 'active') $$,
  'the nameless post is otherwise identical - a missing display_name does not downgrade the post');

-- --- effect 2 of the SAME insert: onboarding is still seeded ---------
-- The point of this pair: two AFTER INSERT triggers on one table and event,
-- both fired, neither swallowed the other.
select isnt_empty(
  $$ select 1 from public.onboarding_progress where user_id = 'aaaaaaaa-0000-4000-8000-0000000000f1' $$,
  'the same redemption also seeded onboarding_progress - both AFTER INSERT triggers ran on one insert');

select results_eq(
  $$ select count(*)::int from public.onboarding_progress op
     join public.invite_redemptions ir on ir.user_id = op.user_id $$,
  $$ select count(*)::int from public.invite_redemptions $$,
  'and every redemption in the table still has its onboarding row - adding a second trigger cost the first one nothing');

-- =====================================================================
-- The name is read when it happens to be there
-- =====================================================================
-- A profile CAN exist first: fixtures do it, and so would any future flow
-- that reorders the two. display_name wins; handle is the fallback.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-0000-4000-8000-0000000000f2',
        'authenticated', 'authenticated', 'nodisplay@members.haimuniya.invalid',
        '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now());
insert into public.profiles (id, handle, display_name, recovery_verified_at)
values ('aaaaaaaa-0000-4000-8000-0000000000f2', 'quiet_one', '   ', now());
insert into public.invite_redemptions (user_id, invite_id, role)
values ('aaaaaaaa-0000-4000-8000-0000000000f2', '11111111-2222-4333-8444-555555555555', 'member');

select results_eq(
  $$ select metadata ->> 'member_name' from public.workout_posts
     where post_type = 'POST_NEW_MEMBER' and (metadata ->> 'member_id') = 'aaaaaaaa-0000-4000-8000-0000000000f2' $$,
  $$ values ('quiet_one') $$,
  'a blank display_name falls back to the handle rather than writing whitespace as a name');

-- =====================================================================
-- Exactly one welcome post per member, ever
-- =====================================================================
-- An UPDATE is not a joining. grant_coach_role() and
-- grant_coach_role_by_handle() both UPDATE this table and move redeemed_at.
update public.invite_redemptions set role = 'coach', redeemed_at = now() where user_id = tests.uid('m1');
select results_eq(
  $$ select count(*)::int from public.workout_posts
     where post_type = 'POST_NEW_MEMBER' and (metadata ->> 'member_id') = tests.uid('m1')::text $$,
  $$ values (1) $$,
  'promoting a member to coach did not announce them to the club a second time');

-- And a genuine second INSERT for the same member is caught by the guard,
-- not by a unique index: a unique violation here would abort the redemption
-- itself and block a real person from joining over a duplicate feed post.
delete from public.invite_redemptions where user_id = 'aaaaaaaa-0000-4000-8000-0000000000f1';
select lives_ok(
  $$ insert into public.invite_redemptions (user_id, invite_id, role)
     values ('aaaaaaaa-0000-4000-8000-0000000000f1', '11111111-2222-4333-8444-555555555555', 'member') $$,
  'a second redemption insert for the same member succeeds - the join is never blocked by the feed');
select results_eq(
  $$ select count(*)::int from public.workout_posts
     where post_type = 'POST_NEW_MEMBER' and (metadata ->> 'member_id') = 'aaaaaaaa-0000-4000-8000-0000000000f1' $$,
  $$ values (1) $$,
  'and it produced no second welcome post');

-- =====================================================================
-- The post is reachable by the club, through RLS
-- =====================================================================
-- posts_feed_select has an author_id = auth.uid() branch and a blocks
-- subquery that both reference author_id, which is null here. If null broke
-- either, the post would exist and nobody would ever see it.
select tests.set_auth(tests.uid('m2'));

select isnt_empty(
  $$ select 1 from public.workout_posts
     where post_type = 'POST_NEW_MEMBER' and (metadata ->> 'member_id') = tests.uid('m1')::text $$,
  'another member sees member A''s welcome post in the feed - a null author_id does not fall out of posts_feed_select');

select isnt_empty(
  $$ select 1 from public.workout_posts
     where post_type = 'POST_NEW_MEMBER' and (metadata ->> 'member_id') = tests.uid('m2')::text $$,
  'and sees their own');

-- This is the exact query cloud.js's findNewMemberPost() runs before
-- COMM-224's welcome comment: select id, post_type, metadata where
-- post_type = POST_NEW_MEMBER, then match metadata.member_id client-side.
select results_eq(
  $$ select count(*)::int from (
       select id, post_type, metadata from public.workout_posts
       where post_type = 'POST_NEW_MEMBER'
     ) t where (t.metadata ->> 'member_id') = tests.uid('m3')::text $$,
  $$ values (1) $$,
  'the coach-side lookup COMM-224 depends on now finds exactly one post - the Welcome button is no longer inert');

-- =====================================================================
-- Nothing client-side may produce one
-- =====================================================================
select throws_ok(
  $$ select public.post_new_member_on_join() $$,
  '42501',
  null,
  'post_new_member_on_join is not executable by authenticated - the trigger is the only caller');

select throws_ok(
  $$ insert into public.workout_posts (author_id, post_type, visibility, status, metadata)
     values (null, 'POST_NEW_MEMBER', 'club', 'active',
             jsonb_build_object('member_id', tests.uid('m2')::text, 'member_name', 'Totally Real')) $$,
  '42501',
  null,
  'a member cannot hand-write an authorless welcome post - posts_insert_self still requires author_id = auth.uid()');

select * from finish();
rollback;
