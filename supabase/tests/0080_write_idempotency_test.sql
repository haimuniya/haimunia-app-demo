-- Production-readiness audit, 2026-09-06 (202609060014). Write idempotency.
--
-- The scenarios the reliability audit named: a repeated identical request, a
-- retry after a client-perceived timeout, a client restart reusing a stored
-- key, two different keys for two genuinely different actions, and the
-- rolled-back-first-attempt case. True cross-session CONCURRENCY (two
-- simultaneous connections blocking on the same claim row) cannot be
-- expressed in a single-session pgTAP transaction; the lock that makes it
-- work is asserted structurally instead, and the reasoning is in the
-- migration header.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- 0. The claim table is not client-reachable
-- =====================================================================
select is(
  (select has_table_privilege('authenticated', 'public.request_idempotency', 'SELECT')), false,
  'request_idempotency is not readable by a client role - only the definer helpers touch it');
select is(
  (select has_function_privilege('authenticated', 'public.idem_begin(text, uuid)', 'execute')), false,
  'idem_begin() is not directly callable by a client either');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.request_idempotency'::regclass),
  'and RLS is enabled on it regardless, so a future accidental grant still denies by default');

-- =====================================================================
-- 1. post_create - the repeated identical request
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.post_create('idempotent post', 'club', '[]'::jsonb, '{}'::jsonb,
                               'e0800000-0000-4000-8000-000000000001') $$,
  'a first post_create with an idempotency key succeeds');

select is(
  (select count(*)::int from public.workout_posts where body = 'idempotent post'), 1,
  'exactly one post exists');

-- The retry: same key, same payload, as if the client never saw the response.
select is(
  public.post_create('idempotent post', 'club', '[]'::jsonb, '{}'::jsonb,
                     'e0800000-0000-4000-8000-000000000001'),
  (select id from public.workout_posts where body = 'idempotent post'),
  'THE FIX: replaying the same key returns the ORIGINAL post id rather than creating a second post');
select is(
  (select count(*)::int from public.workout_posts where body = 'idempotent post'), 1,
  'and there is still exactly one post - the retry wrote nothing');

-- A different key IS a different action, even with an identical body: two
-- deliberate identical posts must both be possible.
select lives_ok(
  $$ select public.post_create('idempotent post', 'club', '[]'::jsonb, '{}'::jsonb,
                               'e0800000-0000-4000-8000-000000000002') $$,
  'a DIFFERENT key with the same body creates a second post...');
select is(
  (select count(*)::int from public.workout_posts where body = 'idempotent post'), 2,
  '...because idempotency is keyed on the request, not on the content - posting the same words twice on purpose still works');

-- Omitting the key entirely preserves the pre-migration behaviour exactly.
select lives_ok(
  $$ select public.post_create('unkeyed post', 'club', '[]'::jsonb, '{}'::jsonb) $$,
  'the 4-argument call still resolves (p_idempotency_key defaults to null)...');
select lives_ok(
  $$ select public.post_create('unkeyed post', 'club', '[]'::jsonb, '{}'::jsonb) $$,
  '...and remains non-idempotent without a key, which is the documented opt-out');
select is(
  (select count(*)::int from public.workout_posts where body = 'unkeyed post'), 2,
  'two unkeyed calls really did create two posts - this migration changes nothing for a caller that sends no key');

-- =====================================================================
-- 2. The key is scoped per user AND per action
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ select public.post_create('m2 post', 'club', '[]'::jsonb, '{}'::jsonb,
                               'e0800000-0000-4000-8000-000000000001') $$,
  'a DIFFERENT member reusing the same key value is unaffected - the claim is keyed (user, action, key)');
select is(
  (select count(*)::int from public.workout_posts where body = 'm2 post'), 1,
  'and their post was really created');

-- =====================================================================
-- 3. chal_record_progress - the double-count case, which is the worst of
--    the four because the damage is silent and permanent
-- =====================================================================
select tests.clear_auth();
insert into public.challenges (id, title, description, challenge_type, metric_type, status, start_at, end_at, target_value, created_by)
values ('40800000-0000-4000-8000-000000000001', 'Row 5000m', 'x', 'individual_target', 'meters', 'active',
        now() - interval '1 day', now() + interval '7 days', 5000, tests.uid('coach'));
insert into public.challenge_participants (challenge_id, user_id) values
  ('40800000-0000-4000-8000-000000000001', tests.uid('m1'));

select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ select public.chal_record_progress('40800000-0000-4000-8000-000000000001', tests.uid('m1'), 100, 'first entry',
                                        'e0800000-0000-4000-8000-000000000010') $$,
  'a coach records +100 progress with a key');
select is(
  (select progress_value from public.challenge_participants
   where challenge_id = '40800000-0000-4000-8000-000000000001' and user_id = tests.uid('m1')), 100::numeric,
  'the participant total is 100');

select lives_ok(
  $$ select public.chal_record_progress('40800000-0000-4000-8000-000000000001', tests.uid('m1'), 100, 'first entry',
                                        'e0800000-0000-4000-8000-000000000010') $$,
  'the same call is retried after a dropped response...');
select is(
  (select progress_value from public.challenge_participants
   where challenge_id = '40800000-0000-4000-8000-000000000001' and user_id = tests.uid('m1')), 100::numeric,
  'THE FIX: the total is STILL 100, not 200 - before this migration the retry silently double-counted, and nothing downstream could tell that apart from two real contributions');
select is(
  (select count(*)::int from public.challenge_progress
   where challenge_id = '40800000-0000-4000-8000-000000000001' and user_id = tests.uid('m1')), 1,
  'and the append-only progress log holds one row, not two');

-- =====================================================================
-- 4. toggle_reaction - converges instead of inverting
-- =====================================================================
select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, body, status)
values ('40800000-0000-4000-8000-000000000002', tests.uid('m2'), 'club', 'react to me', 'active');

select tests.set_auth(tests.uid('m1'));
select is(
  public.toggle_reaction('40800000-0000-4000-8000-000000000002', 'e0800000-0000-4000-8000-000000000020'),
  true,
  'a first cheer returns true (reaction added)');
select is(
  (select count(*)::int from public.reactions
   where post_id = '40800000-0000-4000-8000-000000000002' and user_id = tests.uid('m1')), 1,
  'and the reaction row exists');

select is(
  public.toggle_reaction('40800000-0000-4000-8000-000000000002', 'e0800000-0000-4000-8000-000000000020'),
  true,
  'THE FIX: replaying the same toggle returns true again rather than flipping to false...');
select is(
  (select count(*)::int from public.reactions
   where post_id = '40800000-0000-4000-8000-000000000002' and user_id = tests.uid('m1')), 1,
  '...and the reaction is still THERE - before this migration a retried cheer silently removed it');

-- A genuine second toggle, with its own key, still un-cheers. Idempotency
-- must not turn the feature into a one-way switch.
select is(
  public.toggle_reaction('40800000-0000-4000-8000-000000000002', 'e0800000-0000-4000-8000-000000000021'),
  false,
  'a NEW key still toggles the reaction off - the member can still change their mind');
select is(
  (select count(*)::int from public.reactions
   where post_id = '40800000-0000-4000-8000-000000000002' and user_id = tests.uid('m1')), 0,
  'and the reaction is really gone');

-- =====================================================================
-- 5. add_post_comment
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select is(
  public.add_post_comment('40800000-0000-4000-8000-000000000002', 'nice work', null, null,
                          'e0800000-0000-4000-8000-000000000030'),
  public.add_post_comment('40800000-0000-4000-8000-000000000002', 'nice work', null, null,
                          'e0800000-0000-4000-8000-000000000030'),
  'THE FIX: two calls with one key return the same comment id');
select is(
  (select count(*)::int from public.post_comments
   where post_id = '40800000-0000-4000-8000-000000000002' and body = 'nice work'), 1,
  'and only one comment was created');

-- =====================================================================
-- 6. The concurrency mechanism, asserted structurally
-- =====================================================================
-- Two simultaneous duplicates cannot be driven from one pgTAP session, so
-- what is pinned here is the property that makes the concurrent case safe:
-- idem_begin() claims with ON CONFLICT ... DO UPDATE (which locks the row a
-- second transaction must wait on) rather than DO NOTHING (which would let
-- it race past an invisible uncommitted row and do the work twice).
select ok(
  (select prosrc from pg_proc where proname = 'idem_begin') like '%do update set user_id%',
  'idem_begin() claims with DO UPDATE, which takes the row lock a concurrent duplicate blocks on - DO NOTHING here would reintroduce the race');
select ok(
  (select prosrc from pg_proc where proname = 'idem_begin') like '%xmax = 0%',
  'and distinguishes winner from replay by xmax, the standard test for "did this statement insert or conflict"');

-- =====================================================================
-- 7. Cleanup
-- =====================================================================
select tests.clear_auth();
update public.request_idempotency set created_at = now() - interval '30 days'
 where action = 'post_create';
select ok(
  public.idem_purge('7 days'::interval) >= 1,
  'idem_purge() removes claims older than its window, so the table cannot grow without bound');
select is(
  (select count(*)::int from public.request_idempotency where action = 'post_create'), 0,
  'and the aged-out claims are really gone');
select isnt_empty(
  $$ select 1 from cron.job where jobname = 'idempotency-purge' $$,
  'and the purge is actually scheduled, not just defined - the mistake purge_due_accounts() shipped with');

select * from finish();
rollback;
