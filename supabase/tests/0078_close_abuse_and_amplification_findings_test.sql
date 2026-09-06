-- Production-readiness audit, 2026-09-06, part 2 (202609060012).
-- SEC-003 (post_create rate-limit bypass), SEC-006 (avatar object cap),
-- SEC-007 (private_records/analytics_events/push_subscriptions
-- amplification), SEC-008 (single-club invariant), SEC-011's rate-limit half
-- (admin_reset_password).

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- 1. SEC-003 - the direct-insert path is now rate-limited too, and
--    post_create() itself still works and only spends one token per post.
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.post_create('hello from post_create', 'club', '[]'::jsonb, '{}'::jsonb) $$,
  'post_create() still works after gaining the insert pin');

select is(
  (select has_table_privilege('authenticated', 'public.workout_posts', 'INSERT')), true,
  'the INSERT grant on workout_posts is intentionally still live (cloud.js:3072/4211 upsert directly) - SEC-003''s interim fix is the rate-limit trigger, not revoking this grant');

-- Exhaust the shared post_create rate-limit budget (20 / 10 min) via the
-- direct-insert path, then confirm the trigger - not post_create() - is
-- what refuses the next one.
select tests.clear_auth();
delete from public.rate_limits where user_id = tests.uid('m2') and action = 'post_create';
select tests.set_auth(tests.uid('m2'));
do $$
begin
  -- check_rate_limit(action, 20, 10) allows attempt_count <= 20, so the
  -- 20th call is still within budget - it is the 21st that must fail.
  for i in 1..20 loop
    insert into public.workout_posts (author_id, visibility, title, result_text, occurred_on, status)
    values (tests.uid('m2'), 'club', 'burst ' || i, 'x', current_date, 'active');
  end loop;
end $$;
select throws_ok(
  $$ insert into public.workout_posts (author_id, visibility, title, result_text, occurred_on, status)
     values (tests.uid('m2'), 'club', 'burst 21', 'x', current_date, 'active') $$,
  'P0001', 'rate_limited',
  'THE FIX: the 21st direct insert in the window is refused by workout_posts_guard_insert_rate_limit_trigger - before this migration nothing counted these at all');

-- =====================================================================
-- 2. SEC-006 - avatar-photos gets a 3-object cap, post-photos keeps its 20
-- =====================================================================
select tests.clear_auth();
select is(
  (select prosrc ~ '< 3' from pg_proc where proname = 'can_write_own_avatar'), true,
  'THE FIX: can_write_own_avatar() now carries an object-count cap (previously none at all)');

-- =====================================================================
-- 3. SEC-007 - size/rate/count caps on the three previously-unbounded paths
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values (tests.uid('m1'), 'session_note', 'huge-1',
             jsonb_build_object('note', repeat('x', 100000))) $$,
  '23514',
  null,
  'THE FIX: a payload over 64 KB is refused by private_records_payload_size - previously uncapped');

select lives_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values (tests.uid('m1'), 'session_note', 'normal-1', jsonb_build_object('note', 'a real workout note')) $$,
  'an ordinary-sized sync row still inserts fine');

-- private_records keeps NO membership gate - the offline-sync channel is
-- documented to accept a pre-redemption/no-profile session.
--
-- The auth.users insert must run as the bootstrap superuser, not while
-- impersonating the ghost: `authenticated` holds no grant on auth.users
-- (correctly), so writing the fixture under set_auth fails with 42501.
-- Every other fixture in this suite follows the same clear_auth-then-write
-- pattern for the same reason.
select tests.clear_auth();
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-0078-4000-8000-000000000001',
        'authenticated', 'authenticated', 'ghost78@members.haimuniya.invalid',
        '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now())
on conflict (id) do nothing;
select tests.set_auth('aaaaaaaa-0078-4000-8000-000000000001'::uuid);
select lives_ok(
  $$ insert into public.private_records (user_id, record_type, record_id, payload)
     values ('aaaaaaaa-0078-4000-8000-000000000001', 'session_note', 'ghost-1', '{}'::jsonb) $$,
  'a ghost session (no profile, no redemption) can still write private_records - unchanged by this migration, on purpose');

select tests.set_auth(tests.uid('m1'));
-- P0001, not 23514: the 4 KB props cap is a TRIGGER
-- (enforce_analytics_props_size, 202608280012) rather than a CHECK
-- constraint, because pg_column_size() is STABLE and Postgres refuses a
-- non-IMMUTABLE function inside a check constraint - that migration says so
-- in its own comment.
select throws_ok(
  $$ insert into public.analytics_events (user_id, event_name, props)
     values (tests.uid('m1'), 'test.event', jsonb_build_object('n', repeat('x', 5000))) $$,
  'P0001',
  'props exceeds 4 KB',
  'analytics_events keeps its pre-existing 4 KB props-size guard (unchanged by this migration)');

select tests.clear_auth();
delete from public.push_subscriptions where user_id = tests.uid('m3');
select tests.set_auth(tests.uid('m3'));
do $$
begin
  for i in 1..10 loop
    insert into public.push_subscriptions (user_id, endpoint, keys)
    values (tests.uid('m3'), 'https://example.test/ep-' || i, '{"p256dh":"k","auth":"a"}'::jsonb);
  end loop;
end $$;
select throws_ok(
  $$ insert into public.push_subscriptions (user_id, endpoint, keys)
     values (tests.uid('m3'), 'https://example.test/ep-11', '{"p256dh":"k","auth":"a"}'::jsonb) $$,
  'P0001', 'too many push subscriptions for this account',
  'THE FIX: an 11th push subscription for the same member is refused - previously uncapped');

-- =====================================================================
-- 4. SEC-008 - a second clubs row is refused loudly instead of silently
--    becoming a cross-tenant leak
-- =====================================================================
select tests.clear_auth();
select throws_ok(
  $$ insert into public.clubs (id, name) values (gen_random_uuid(), 'Second Club') $$,
  'P0001',
  null,
  'THE FIX: inserting a second clubs row is refused with an explicit error - before this migration it would have silently made every unfiltered read policy cross-tenant');

-- =====================================================================
-- 5. SEC-011 rate-limit half - admin_check_password_reset_rate_limit()
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.admin_check_password_reset_rate_limit() $$,
  'P0001', 'not authorized',
  'a plain member cannot call the reset rate-limit check at all');

select tests.clear_auth();
delete from public.rate_limits where user_id = tests.uid('admin') and action = 'admin_password_reset';
select tests.set_auth(tests.uid('admin'));
do $$
begin
  for i in 1..5 loop
    perform public.admin_check_password_reset_rate_limit();
  end loop;
end $$;
select throws_ok(
  $$ select public.admin_check_password_reset_rate_limit() $$,
  'P0001', 'rate_limited',
  'THE FIX: a 6th password-reset check within the hour is refused - before this migration the Edge Function called check_rate_limit nowhere at all, so a compromised admin session could reset every account in a loop');

select * from finish();
rollback;
