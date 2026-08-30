-- COMM-218 / COMM-219: real behavioural coverage for 202608290010
-- (announcements.priority + expires_at, the important mirror, the expiry
-- read filter, the widened notif_is_operational, and the three-tier
-- escalation fan-out).
--
-- Boundaries: the sync and escalation trigger functions are unreachable by
-- a direct client RPC; announcement_priority_rank IS callable by a member,
-- because it is pure. An out-of-range priority is rejected by the check
-- constraint. priority and important stay mirrored through every spelling:
-- inserting a priority, inserting the legacy boolean alone, updating either
-- one, and de-escalating. Only staff can set priority or expires_at - a
-- member's insert raises and a member's update changes nothing, through the
-- unchanged is_staff() policies. An expired announcement disappears from a
-- member's read (which is what empties it out of the feed top area and the
-- pinned strip) while staff keep reading it, and expiry never touches a
-- pin: the pin row survives, since only an explicit unpin or a real delete
-- removes it.
--
-- The fan-out half: a normal announcement reaches the five non-off,
-- non-author members; a normal -> urgent jump that skips the important tier
-- still reaches the member who was skipped; an announcement born important
-- reaches everyone at once and a later escalation to urgent adds nobody;
-- normal -> important -> urgent adds exactly one row in total, proven with
-- the earlier notifications backdated past notif_dedupe_window() so the
-- assertion is about the fan-out's own already-notified filter and not
-- about notif_create's de-dupe window; a downgrade fans out to nobody; an
-- already-expired announcement notifies nobody on insert or on escalation;
-- and an edit that touches neither column notifies nobody.
--
-- Every state check runs as tests.clear_auth() (the bootstrap superuser,
-- which bypasses notifications' own select-your-own-row RLS) rather than as
-- the acting member, so a check for what landed in someone else's stream is
-- not itself hidden by the RLS boundary 0008 already covers. Every
-- announcement write is performed by a real staff member through the real
-- policies, not as the superuser, so the write gate and the actor-exclusion
-- branch of notif_create both mean something.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- m3 is the member who has switched announcements off: the whole COMM-219
-- question is what does and does not reach them.
select tests.clear_auth();
insert into public.notification_preferences (user_id, type, channel)
values (tests.uid('m3'), 'announcements', 'off')
on conflict (user_id, type) do update set channel = 'off';

-- =====================================================================
-- boundaries: the trigger functions are not client-callable, the rank
-- helper is
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.announcements_priority_sync() $$, '42501', null,
  'announcements_priority_sync cannot be called directly by a member');
select throws_ok(
  $$ select public.notif_on_announcement() $$, '42501', null,
  'notif_on_announcement cannot be called directly by a member');
select results_eq(
  $$ select public.announcement_priority_rank('normal'),
            public.announcement_priority_rank('important'),
            public.announcement_priority_rank('urgent'),
            public.announcement_priority_rank(null) $$,
  $$ values (0, 1, 2, 0) $$,
  'announcement_priority_rank is callable by a member and orders the three tiers, unknown/null lowest');

-- =====================================================================
-- the check constraint and the priority <-> important mirror
-- =====================================================================
select tests.clear_auth();
select throws_ok(
  $$ insert into public.announcements (id, author_id, title, body, priority) values
       ('c0300000-0000-4000-8000-0000000000ff', tests.uid('admin'), 'Bad', 'body', 'critical') $$,
  '23514', null,
  'a priority outside normal/important/urgent is rejected by the check constraint');

insert into public.announcements (id, author_id, title, body) values
  ('c0300000-0000-4000-8000-000000000001', tests.uid('admin'), 'Plain', 'body');
insert into public.announcements (id, author_id, title, body, priority) values
  ('c0300000-0000-4000-8000-000000000002', tests.uid('admin'), 'Urgent one', 'body', 'urgent');
-- the Phase 1 spelling: a writer that has never heard of priority
insert into public.announcements (id, author_id, title, body, important) values
  ('c0300000-0000-4000-8000-000000000003', tests.uid('admin'), 'Legacy important', 'body', true);

select results_eq(
  $$ select priority, important from public.announcements
     where id = 'c0300000-0000-4000-8000-000000000001' $$,
  $$ values ('normal'::text, false) $$,
  'a plain insert defaults to normal and mirrors important = false');
select results_eq(
  $$ select priority, important from public.announcements
     where id = 'c0300000-0000-4000-8000-000000000002' $$,
  $$ values ('urgent'::text, true) $$,
  'inserting priority urgent mirrors important = true, so every Phase 1 reader of important still sees it');
select results_eq(
  $$ select priority, important from public.announcements
     where id = 'c0300000-0000-4000-8000-000000000003' $$,
  $$ values ('important'::text, true) $$,
  'inserting the legacy boolean alone lands on the important tier - the old write spelling still works');

update public.announcements set priority = 'important'
  where id = 'c0300000-0000-4000-8000-000000000001';
select results_eq(
  $$ select priority, important from public.announcements
     where id = 'c0300000-0000-4000-8000-000000000001' $$,
  $$ values ('important'::text, true) $$,
  'updating priority upward mirrors important = true');
update public.announcements set priority = 'normal'
  where id = 'c0300000-0000-4000-8000-000000000001';
select results_eq(
  $$ select priority, important from public.announcements
     where id = 'c0300000-0000-4000-8000-000000000001' $$,
  $$ values ('normal'::text, false) $$,
  'and de-escalating to normal mirrors important = false');
update public.announcements set important = true
  where id = 'c0300000-0000-4000-8000-000000000001';
select results_eq(
  $$ select priority, important from public.announcements
     where id = 'c0300000-0000-4000-8000-000000000001' $$,
  $$ values ('important'::text, true) $$,
  'the legacy update spelling still escalates, and drags priority with it');
update public.announcements set important = false
  where id = 'c0300000-0000-4000-8000-000000000002';
select results_eq(
  $$ select priority, important from public.announcements
     where id = 'c0300000-0000-4000-8000-000000000002' $$,
  $$ values ('normal'::text, false) $$,
  'clearing the legacy boolean on an urgent row drops it all the way to normal, never leaving the pair disagreeing');
update public.announcements set title = 'Plain, retitled'
  where id = 'c0300000-0000-4000-8000-000000000001';
select results_eq(
  $$ select priority, important from public.announcements
     where id = 'c0300000-0000-4000-8000-000000000001' $$,
  $$ values ('important'::text, true) $$,
  'an edit that touches neither column leaves the pair exactly as it was');

-- =====================================================================
-- notif_is_operational widened to the two operational tiers
-- =====================================================================
update public.announcements set priority = 'normal'
  where id = 'c0300000-0000-4000-8000-000000000001';
select results_eq(
  $$ select public.notif_is_operational('announcement', 'c0300000-0000-4000-8000-000000000001'),
            public.notif_is_operational('announcement', 'c0300000-0000-4000-8000-000000000003'),
            public.notif_is_operational('announcement', 'c0300000-0000-4000-8000-000000000002'),
            public.notif_is_operational('comment_reply', 'c0300000-0000-4000-8000-000000000003') $$,
  $$ values (false, true, false, false) $$,
  'normal is not operational, important is, a de-escalated row is not, and no other type ever is');
update public.announcements set priority = 'urgent'
  where id = 'c0300000-0000-4000-8000-000000000002';
select is(
  public.notif_is_operational('announcement', 'c0300000-0000-4000-8000-000000000002'),
  true,
  'urgent is operational too - this is the COMM-219 widening, an off preference cannot suppress it');

-- =====================================================================
-- the write gate: staff only, unchanged from the important gate
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ insert into public.announcements (id, author_id, title, body, priority, expires_at) values
       ('c0300000-0000-4000-8000-0000000000fe', tests.uid('m1'), 'Member', 'body', 'urgent', now() + interval '1 day') $$,
  '42501', null,
  'a member cannot post an announcement at all, priority column or not');

update public.announcements
   set priority = 'urgent', expires_at = now() + interval '1 day'
 where id = 'c0300000-0000-4000-8000-000000000001';
select tests.clear_auth();
select results_eq(
  $$ select priority, expires_at is null from public.announcements
     where id = 'c0300000-0000-4000-8000-000000000001' $$,
  $$ values ('normal'::text, true) $$,
  'a member''s update of priority/expires_at silently matches no row - the is_staff policy was not widened');

select tests.set_auth(tests.uid('coach'));
update public.announcements
   set priority = 'important', expires_at = now() + interval '1 day'
 where id = 'c0300000-0000-4000-8000-000000000001';
select tests.clear_auth();
select results_eq(
  $$ select priority, important, expires_at > now() from public.announcements
     where id = 'c0300000-0000-4000-8000-000000000001' $$,
  $$ values ('important'::text, true, true) $$,
  'a coach is staff, so a coach can set both new columns');

-- =====================================================================
-- expiry is a read-time filter: gone for members, still there for staff,
-- and it never unpins anything
-- =====================================================================
select tests.clear_auth();
insert into public.announcements (id, author_id, title, body, expires_at) values
  ('c0300000-0000-4000-8000-000000000011', tests.uid('admin'), 'Still live', 'body', now() + interval '1 day'),
  ('c0300000-0000-4000-8000-000000000012', tests.uid('admin'), 'Expired', 'body', now() - interval '1 minute');
insert into public.pins (club_id, target_type, target_id, slot, pinned_by) values
  (public.default_club_id(), 'announcement', 'c0300000-0000-4000-8000-000000000012', 0, tests.uid('admin'));

select tests.set_auth(tests.uid('m1'));
select isnt_empty(
  $$ select 1 from public.announcements where id = 'c0300000-0000-4000-8000-000000000011' $$,
  'a member reads an announcement whose expiry is still in the future');
select is_empty(
  $$ select 1 from public.announcements where id = 'c0300000-0000-4000-8000-000000000012' $$,
  'and cannot read it once expires_at has passed - no cron ran, the read policy simply stopped matching');
select isnt_empty(
  $$ select 1 from public.announcements where id = 'c0300000-0000-4000-8000-000000000003' $$,
  'a null expires_at is not an expiry - every announcement that predates this migration still reads');

select tests.set_auth(tests.uid('coach'));
select isnt_empty(
  $$ select 1 from public.announcements where id = 'c0300000-0000-4000-8000-000000000012' $$,
  'staff still read the expired announcement - expiry hides it from members, not from the record');

select tests.clear_auth();
update public.announcements set deleted_at = now()
  where id = 'c0300000-0000-4000-8000-000000000011';
select tests.set_auth(tests.uid('coach'));
select is_empty(
  $$ select 1 from public.announcements where id = 'c0300000-0000-4000-8000-000000000011' $$,
  'the deleted_at half of the read policy is untouched: a soft-deleted announcement is hidden from staff too');

select tests.clear_auth();
select isnt_empty(
  $$ select 1 from public.pins
     where target_type = 'announcement' and target_id = 'c0300000-0000-4000-8000-000000000012' $$,
  'the expired announcement is still pinned - expiry is not deadness, only an explicit unpin or a real delete clears a pin (COMM-218/COMM-155)');
delete from public.announcements where id = 'c0300000-0000-4000-8000-000000000012';
select is_empty(
  $$ select 1 from public.pins
     where target_type = 'announcement' and target_id = 'c0300000-0000-4000-8000-000000000012' $$,
  'and deleting it for real does still auto-unpin, so the pins trigger set kept working');

-- =====================================================================
-- fan-out: normal, then a normal -> urgent jump that skips important
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
insert into public.announcements (id, author_id, title, body) values
  ('c0300000-0000-4000-8000-000000000021', tests.uid('admin'), 'Normal then urgent', 'body');

select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.notifications
     where type = 'announcement' and source_id = 'c0300000-0000-4000-8000-000000000021' $$,
  $$ values (5) $$,
  'the normal fan-out reaches exactly the five non-off, non-author members (m1, m2, coach, owner, norec)');
select is_empty(
  $$ select 1 from public.notifications
     where type = 'announcement' and user_id = tests.uid('m3')
       and source_id = 'c0300000-0000-4000-8000-000000000021' $$,
  'm3, who switched announcements off, is skipped on a normal announcement');

select tests.set_auth(tests.uid('coach'));
update public.announcements set priority = 'urgent'
  where id = 'c0300000-0000-4000-8000-000000000021';
select tests.clear_auth();
select isnt_empty(
  $$ select 1 from public.notifications
     where type = 'announcement' and user_id = tests.uid('m3')
       and source_id = 'c0300000-0000-4000-8000-000000000021' $$,
  'jumping normal -> urgent, skipping the important tier entirely, still reaches m3 - urgent overrides off');
select results_eq(
  $$ select count(*)::int from public.notifications
     where type = 'announcement' and source_id = 'c0300000-0000-4000-8000-000000000021' $$,
  $$ values (6) $$,
  'and adds exactly that one row - nobody from the first pass was notified twice');

-- =====================================================================
-- born important, later urgent: the escalation must add nobody
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
insert into public.announcements (id, author_id, title, body, priority) values
  ('c0300000-0000-4000-8000-000000000022', tests.uid('admin'), 'Important then urgent', 'body', 'important');
select tests.clear_auth();
select isnt_empty(
  $$ select 1 from public.notifications
     where type = 'announcement' and user_id = tests.uid('m3')
       and source_id = 'c0300000-0000-4000-8000-000000000022' $$,
  'an announcement born important is operational, so it reaches m3 on the very first fan-out');
select results_eq(
  $$ select count(*)::int from public.notifications
     where type = 'announcement' and source_id = 'c0300000-0000-4000-8000-000000000022' $$,
  $$ values (6) $$,
  'six rows: every member except the author');

-- Push those rows out past notif_dedupe_window(), so what stops the second
-- fan-out below is the fan-out's own already-notified filter and not
-- notif_create's one-hour de-dupe probe.
update public.notifications set created_at = now() - interval '2 hours'
  where type = 'announcement' and source_id = 'c0300000-0000-4000-8000-000000000022';

select tests.set_auth(tests.uid('coach'));
update public.announcements set priority = 'urgent'
  where id = 'c0300000-0000-4000-8000-000000000022';
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.notifications
     where type = 'announcement' and source_id = 'c0300000-0000-4000-8000-000000000022' $$,
  $$ values (6) $$,
  'escalating important -> urgent notifies nobody a second time, even with the de-dupe window long expired - a member already reached at important is never re-reached at urgent');

-- =====================================================================
-- the full ladder normal -> important -> urgent, then a downgrade
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
insert into public.announcements (id, author_id, title, body) values
  ('c0300000-0000-4000-8000-000000000023', tests.uid('admin'), 'The whole ladder', 'body');
select tests.set_auth(tests.uid('coach'));
update public.announcements set priority = 'important'
  where id = 'c0300000-0000-4000-8000-000000000023';
select tests.clear_auth();
update public.notifications set created_at = now() - interval '2 hours'
  where type = 'announcement' and source_id = 'c0300000-0000-4000-8000-000000000023';
select results_eq(
  $$ select count(*)::int from public.notifications
     where type = 'announcement' and source_id = 'c0300000-0000-4000-8000-000000000023' $$,
  $$ values (6) $$,
  'normal (5) then important (+1, m3) is six rows, the Phase 1 behaviour unchanged');

select tests.set_auth(tests.uid('coach'));
update public.announcements set priority = 'urgent'
  where id = 'c0300000-0000-4000-8000-000000000023';
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.notifications
     where type = 'announcement' and source_id = 'c0300000-0000-4000-8000-000000000023' $$,
  $$ values (6) $$,
  'the third step up the ladder adds nothing: one row per member per announcement, however many times priority moves');

select tests.set_auth(tests.uid('coach'));
update public.announcements set priority = 'normal'
  where id = 'c0300000-0000-4000-8000-000000000023';
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.notifications
     where type = 'announcement' and source_id = 'c0300000-0000-4000-8000-000000000023' $$,
  $$ values (6) $$,
  'a downgrade is not an escalation and fans out to nobody');
select results_eq(
  $$ select priority, important from public.announcements
     where id = 'c0300000-0000-4000-8000-000000000023' $$,
  $$ values ('normal'::text, false) $$,
  'and the downgrade still lands, mirror and all');

-- =====================================================================
-- an expired announcement notifies nobody, on insert or on escalation
-- =====================================================================
select tests.set_auth(tests.uid('admin'));
insert into public.announcements (id, author_id, title, body, expires_at) values
  ('c0300000-0000-4000-8000-000000000024', tests.uid('admin'), 'Born expired', 'body', now() - interval '1 minute');
select tests.clear_auth();
select is_empty(
  $$ select 1 from public.notifications
     where type = 'announcement' and source_id = 'c0300000-0000-4000-8000-000000000024' $$,
  'an announcement inserted already expired notifies nobody - the deep link would open onto a row no member can read');
select tests.set_auth(tests.uid('coach'));
update public.announcements set priority = 'urgent'
  where id = 'c0300000-0000-4000-8000-000000000024';
select tests.clear_auth();
select is_empty(
  $$ select 1 from public.notifications
     where type = 'announcement' and source_id = 'c0300000-0000-4000-8000-000000000024' $$,
  'and escalating an expired announcement to urgent still notifies nobody');

-- =====================================================================
-- an ordinary edit fans out nothing
-- =====================================================================
select tests.set_auth(tests.uid('coach'));
update public.announcements set title = 'Normal then urgent, retitled', body = 'edited body'
  where id = 'c0300000-0000-4000-8000-000000000021';
select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.notifications
     where type = 'announcement' and source_id = 'c0300000-0000-4000-8000-000000000021' $$,
  $$ values (6) $$,
  'editing the title and body of an announcement notifies nobody - the trigger only fires on the two priority columns');

select * from finish();
rollback;
