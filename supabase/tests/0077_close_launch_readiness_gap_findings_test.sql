-- Production-readiness audit, 2026-09-06 (202609060011).
--
-- Covers, in order: SEC-001 (the anonymous read gate's remaining gaps),
-- SEC-002/SEC-005 (the moderation/ranking guard trigger on workout_posts),
-- the DELETE-bypass finding (posts_delete_self / the standing DELETE
-- grant), and the purge_due_accounts() scheduling + FK fix.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- The ghost, same shape as 0067's: a real authenticated JWT, no profile,
-- no redemption.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-0077-4000-8000-000000000001',
        'authenticated', 'authenticated', 'ghost77@members.haimuniya.invalid',
        '$2a$10$rlshelpersfixturehashaaaaaaaaaaaaaaaaaaaaaaaaaaaa', now(), now(), now())
on conflict (id) do nothing;

-- =====================================================================
-- Fixtures: one of everything SEC-001 named, written as the bootstrap
-- superuser so no policy is involved in creating them.
-- =====================================================================
insert into public.challenges (id, title, description, challenge_type, metric_type, status, start_at, end_at, target_value, created_by)
values ('40770000-0000-4000-8000-000000000001', 'Row 1000m', 'x', 'individual_target', 'meters', 'active',
        now() - interval '1 day', now() + interval '7 days', 1000, tests.uid('coach'));
insert into public.challenge_participants (challenge_id, user_id) values
  ('40770000-0000-4000-8000-000000000001', tests.uid('m1'));
insert into public.challenge_progress (challenge_id, user_id, delta) values
  ('40770000-0000-4000-8000-000000000001', tests.uid('m1'), 100);
insert into public.challenge_teams (id, challenge_id, name) values
  ('40770000-0000-4000-8000-000000000002', '40770000-0000-4000-8000-000000000001', 'Reds');

insert into public.events (id, title, description, event_type, location, start_at, end_at, status, created_by)
values ('40770000-0000-4000-8000-000000000003', 'Saturday WOD', 'x', 'community_event', 'Box', now() + interval '1 day', now() + interval '2 days', 'published', tests.uid('coach'));
insert into public.event_attendees (event_id, user_id, response) values
  ('40770000-0000-4000-8000-000000000003', tests.uid('m1'), 'going');

insert into public.member_achievements (user_id, achievement_id, visibility) values
  (tests.uid('m1'), (select id from public.achievement_definitions where code = 'first_workout'), 'club');

insert into public.member_of_week (week_start, user_id, category) values
  (date_trunc('week', current_date)::date, tests.uid('m1'), 'consistency_streak');

insert into public.weekly_challenges (id, comparison_key, title, starts_on, ends_on, created_by)
values ('40770000-0000-4000-8000-000000000004', 'movement:fran:time', 'Fran week', current_date, current_date + 6, tests.uid('coach'));

-- enforce_pin_target() requires the pinned row to actually exist and be
-- pinnable, so this needs a real announcement rather than a random uuid.
insert into public.announcements (id, author_id, title, body)
values ('40770000-0000-4000-8000-000000000005', tests.uid('admin'), 'Pinned notice', 'Body');
insert into public.pins (target_type, target_id, slot, note, pinned_by)
values ('announcement', '40770000-0000-4000-8000-000000000005', 0, 'pinned', tests.uid('coach'));

-- =====================================================================
-- 1. SEC-001 - a ghost reads none of it
-- =====================================================================
select tests.set_auth('aaaaaaaa-0077-4000-8000-000000000001'::uuid);

select is_empty(
  $$ select 1 from public.challenge_participants where challenge_id = '40770000-0000-4000-8000-000000000001' $$,
  'THE FIX: a ghost session reads ZERO challenge_participants rows - before this migration the challenge existing was the entire test');
select is_empty(
  $$ select 1 from public.challenge_progress where challenge_id = '40770000-0000-4000-8000-000000000001' $$,
  'ghost reads ZERO challenge_progress rows');
select is_empty(
  $$ select 1 from public.challenge_teams where challenge_id = '40770000-0000-4000-8000-000000000001' $$,
  'ghost reads ZERO challenge_teams rows');
select is_empty(
  $$ select 1 from public.challenges where id = '40770000-0000-4000-8000-000000000001' $$,
  'ghost reads ZERO challenges rows');
select is_empty(
  $$ select 1 from public.event_attendees where event_id = '40770000-0000-4000-8000-000000000003' $$,
  'ghost reads ZERO event_attendees rows, even though show_in_attendee_lists defaults true');
select is_empty(
  $$ select 1 from public.events where id = '40770000-0000-4000-8000-000000000003' $$,
  'ghost reads ZERO events rows - the club calendar is closed to it');
select is_empty(
  $$ select 1 from public.member_achievements where user_id = tests.uid('m1') $$,
  'ghost reads ZERO member_achievements rows, even though show_achievements defaults true');
select is_empty(
  $$ select 1 from public.member_of_week $$,
  'ghost reads ZERO member_of_week rows - previously using (true)');
select is_empty(
  $$ select 1 from public.weekly_challenges $$,
  'ghost reads ZERO weekly_challenges rows - previously using (true)');
select is_empty(
  $$ select 1 from public.pins $$,
  'ghost reads ZERO pins rows - previously using (true)');
select is_empty(
  $$ select 1 from public.clubs $$,
  'ghost reads ZERO clubs rows (tidiness gate)');

-- =====================================================================
-- 2. Regression: a real, fully redeemed member still reads all of it
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select isnt_empty(
  $$ select 1 from public.challenge_participants where challenge_id = '40770000-0000-4000-8000-000000000001' $$,
  'a real member still reads challenge_participants');
select isnt_empty(
  $$ select 1 from public.challenge_progress where challenge_id = '40770000-0000-4000-8000-000000000001' $$,
  'a real member still reads challenge_progress');
select isnt_empty(
  $$ select 1 from public.event_attendees where event_id = '40770000-0000-4000-8000-000000000003' $$,
  'a real member still reads event_attendees (own row)');
select isnt_empty(
  $$ select 1 from public.events where id = '40770000-0000-4000-8000-000000000003' $$,
  'a real member still reads events');
select isnt_empty(
  $$ select 1 from public.member_achievements where user_id = tests.uid('m1') $$,
  'a real member still reads their own member_achievements');
select isnt_empty(
  $$ select 1 from public.member_of_week $$,
  'a real member still reads member_of_week');
select isnt_empty(
  $$ select 1 from public.weekly_challenges $$,
  'a real member still reads weekly_challenges');
select isnt_empty(
  $$ select 1 from public.pins $$,
  'a real member still reads pins');
select isnt_empty(
  $$ select 1 from public.clubs $$,
  'a real member still reads clubs');

-- Pre-redemption surfaces stay open to the same ghost - unchanged by this
-- migration, asserted so a future edit does not gate them by accident.
select tests.set_auth('aaaaaaaa-0077-4000-8000-000000000001'::uuid);
select isnt_empty(
  $$ select 1 from public.club_features $$,
  'club_features stays open to a ghost - a pre-redemption onboarding surface, deliberately not gated');

-- =====================================================================
-- 3. SEC-002/SEC-005 - the moderation/ranking guard trigger
-- =====================================================================
select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, title, result_text, occurred_on, status)
values ('40770000-0000-4000-8000-000000000010', tests.uid('m1'), 'club', 'Fran', '5:00', current_date, 'active');
insert into public.reports (reporter_id, post_id, target_type, target_id, reason)
values (tests.uid('m2'), '40770000-0000-4000-8000-000000000010', 'post', '40770000-0000-4000-8000-000000000010', 'inappropriate');

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.post_delete('40770000-0000-4000-8000-000000000010') $$,
  'an admin removes the reported post through the sanctioned RPC');
select tests.clear_auth();
select is(
  (select status from public.workout_posts where id = '40770000-0000-4000-8000-000000000010'), 'removed',
  'the post is really removed');
select isnt_empty(
  $$ select 1 from public.reports where post_id = '40770000-0000-4000-8000-000000000010' $$,
  'and the report filed against it survives - post_delete() is UPDATE-only, nothing cascaded it away');

-- =====================================================================
-- SEC-002, corrected by this suite's first real run against Postgres.
-- =====================================================================
-- SECURITY_AUDIT.md SEC-002 predicted that an author could PATCH
-- status/deleted_at back to 'active'/null and undo a moderator's removal,
-- reasoning from posts_update_self being column-unrestricted. Running it
-- proves that specific attack does NOT work, for a reason the static read
-- missed: PostgreSQL applies SELECT policies to an UPDATE that carries a
-- WHERE clause, and no SELECT policy shows a removed post to its own author
-- (posts_feed_select requires deleted_at is null and status = 'active').
-- The row is simply invisible, so the UPDATE matches zero rows.
--
-- The finding is therefore DISPROVEN AS STATED and recorded that way in
-- SECURITY_AUDIT.md rather than quietly dropped. The guard trigger is kept
-- as defense-in-depth - it is what would hold if a future policy ever made
-- removed posts visible to their author - and SEC-005 below, which the same
-- trigger closes, IS live and exploitable.
select tests.set_auth(tests.uid('m1'));
select is(
  (select count(*)::int from public.workout_posts where id = '40770000-0000-4000-8000-000000000010'),
  0,
  'SEC-002 DISPROVEN AS STATED: a removed post is not even visible to its own author, so the un-delete UPDATE has no row to hit');
select lives_ok(
  $$ update public.workout_posts set status = 'active', deleted_at = null
     where id = '40770000-0000-4000-8000-000000000010' $$,
  '...so the reversal attempt raises nothing - it is a silent zero-row no-op, not a refusal');
select tests.clear_auth();
select is(
  (select status from public.workout_posts where id = '40770000-0000-4000-8000-000000000010'), 'removed',
  '...and the post is STILL removed afterwards, which is the property that actually matters');

-- =====================================================================
-- SEC-005: live, exploitable, and closed by the guard. Needs an ACTIVE
-- post - the removed one above is unreachable for the reason just proven.
-- =====================================================================
select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, title, result_text, occurred_on, status)
values ('40770000-0000-4000-8000-000000000014', tests.uid('m1'), 'club', 'Helen', '8:00', current_date, 'active');
select tests.set_auth(tests.uid('m1'));
select is(
  (select count(*)::int from public.workout_posts where id = '40770000-0000-4000-8000-000000000014'),
  1,
  'the author can see their own ACTIVE post, so an UPDATE against it really does reach the guard');
select throws_ok(
  $$ update public.workout_posts set score_value = 9999, comparison_key = 'fran', score_direction = 'lower', is_pinned = true
     where id = '40770000-0000-4000-8000-000000000014' $$,
  'P0001', 'field is server derived',
  'SEC-005 THE FIX: the author can no longer forge score_value/comparison_key/is_pinned on their own row - this was accepted before 202609060011 and topped the comparison board');
select throws_ok(
  $$ update public.workout_posts set published_at = now() + interval '10 days'
     where id = '40770000-0000-4000-8000-000000000014' $$,
  'P0001', 'field is server derived',
  'nor back/forward-date published_at, which feed_page uses as its recency input');
select lives_ok(
  $$ update public.workout_posts set body = 'edited caption' where id = '40770000-0000-4000-8000-000000000014' $$,
  'while an ordinary edit to a non-guarded column on the same row still succeeds - the guard is column-scoped, not a blanket freeze');

-- request_account_deletion(): the pin still lets the member's own posts get
-- soft-deleted by the function that is SUPPOSED to do exactly that.
select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, title, result_text, occurred_on, status)
values ('40770000-0000-4000-8000-000000000011', tests.uid('m2'), 'club', 'Grace', '3:10', current_date, 'active');
select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ select public.request_account_deletion() $$,
  'request_account_deletion() still runs - the new guard''s pin covers its own UPDATE');
select tests.clear_auth();
select is(
  (select deleted_at is not null from public.workout_posts where id = '40770000-0000-4000-8000-000000000011'), true,
  'and the member''s own post was really soft-deleted by it, exactly as before this migration');

-- admin_remove_member(): same pin, on someone else's posts.
select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, title, result_text, occurred_on, status)
values ('40770000-0000-4000-8000-000000000012', tests.uid('m3'), 'club', 'Cindy', '15 rounds', current_date, 'active');
select tests.set_auth(tests.uid('admin'));
select lives_ok(
  $$ select public.admin_remove_member(tests.uid('m3')) $$,
  'admin_remove_member() still runs - its UPDATE is covered by the same pin');
select tests.clear_auth();
select is(
  (select deleted_at is not null from public.workout_posts where id = '40770000-0000-4000-8000-000000000012'), true,
  'and the target member''s post was really soft-deleted');

-- The pin is transaction-local and is put back down when the function
-- returns. Asserted on the ADMIN'S OWN active post: an admin has no UPDATE
-- policy over someone else's row at all (posts_update_self is
-- `author_id = auth.uid()`), so pointing this at m3's post would prove
-- nothing about the pin - it would be filtered by RLS before the guard was
-- ever consulted, which is exactly the mistake the SEC-002 block above
-- documents.
select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, title, result_text, occurred_on, status)
values ('40770000-0000-4000-8000-000000000013', tests.uid('admin'), 'club', 'Angie', '20:00', current_date, 'active');
select tests.set_auth(tests.uid('admin'));
select throws_ok(
  $$ update public.workout_posts set score_value = 1 where id = '40770000-0000-4000-8000-000000000013' $$,
  'P0001', 'field is server derived',
  'the pin is cleared when admin_remove_member() returns: the very next guarded write in the same session is refused again, admin or not');

-- =====================================================================
-- 4. The DELETE-bypass finding: posts_delete_self / the standing grant
-- =====================================================================
select is(
  (select has_table_privilege('authenticated', 'public.workout_posts', 'DELETE')), false,
  'THE FIX: authenticated no longer holds a table-level DELETE grant on workout_posts at all');

select tests.clear_auth();
insert into public.workout_posts (id, author_id, visibility, title, result_text, occurred_on, status)
values ('40770000-0000-4000-8000-000000000015', tests.uid('m1'), 'club', 'Murph', '45:00', current_date, 'active');
insert into public.reports (reporter_id, post_id, target_type, target_id, reason)
values (tests.uid('m2'), '40770000-0000-4000-8000-000000000015', 'post', '40770000-0000-4000-8000-000000000015', 'inappropriate');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ delete from public.workout_posts where id = '40770000-0000-4000-8000-000000000015' $$,
  '42501',
  null,
  'a member can no longer hard-DELETE their own reported post - accepted before this migration, and reports.post_id''s ON DELETE CASCADE destroyed the report filed against it along with it');
select tests.clear_auth();
select isnt_empty(
  $$ select 1 from public.workout_posts where id = '40770000-0000-4000-8000-000000000015' $$,
  'the post still exists...');
select isnt_empty(
  $$ select 1 from public.reports where post_id = '40770000-0000-4000-8000-000000000015' $$,
  '...and so does the report against it');

-- =====================================================================
-- 5. purge_due_accounts(): scheduled, and its FKs no longer block it
-- =====================================================================
select isnt_empty(
  $$ select 1 from cron.job where jobname = 'purge-due-accounts' $$,
  'THE FIX: purge_due_accounts() now has a cron.schedule entry - it existed since 202608260001 but nothing ever called it');

select is(
  (select confdeltype from pg_constraint where conname = 'invites_created_by_fkey'), 'n',
  'invites.created_by is now ON DELETE SET NULL, so deleting its creator no longer blocks the whole purge_due_accounts() batch');
select is(
  (select confdeltype from pg_constraint where conname = 'invites_revoked_by_fkey'), 'n',
  'invites.revoked_by is now ON DELETE SET NULL');
select is(
  (select confdeltype from pg_constraint where conname = 'invites_redeemed_by_fkey'), 'n',
  'invites.redeemed_by is now ON DELETE SET NULL');
select is(
  (select confdeltype from pg_constraint where conname = 'onboarding_step_content_updated_by_fkey'), 'n',
  'onboarding_step_content.updated_by is now ON DELETE SET NULL');
select is(
  (select confdeltype from pg_constraint where conname = 'intro_carousel_content_updated_by_fkey'), 'n',
  'intro_carousel_content.updated_by is now ON DELETE SET NULL');
select is(
  (select confdeltype from pg_constraint where conname = 'reports_reviewed_by_fkey'), 'n',
  'reports.reviewed_by is now ON DELETE SET NULL - found while fixing the above: profiles cascades from auth.users, so this NO ACTION FK would have blocked the same purge one join further out for any member who ever reviewed a report');

select * from finish();
rollback;
