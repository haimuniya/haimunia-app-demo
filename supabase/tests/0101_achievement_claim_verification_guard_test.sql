-- Security hunt round 6 (202609120001). ach_claim() never independently
-- verified five of its six client_claimable metrics (only tenure_days is
-- checked against invite_redemptions) - confirmed live, a brand-new member
-- with zero training history could claim top-tier session/PR/streak
-- badges for free. The real damage was one step further: ach_share()
-- previously required only "a real member_achievements row exists", which
-- ach_claim() had just manufactured, turning the forged badge into a real,
-- public feed post. This file proves member_achievements.verified is
-- computed server-side (never caller-supplied), and that ach_share()
-- refuses an unverified claim while a genuinely verified one (tenure- or
-- attendance-backed) still shares normally.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select tests.clear_auth();

-- A client-claimable, non-tenure definition - the exact shape the real
-- vulnerability exploited.
insert into public.achievement_definitions (code, name, category, trigger_type, threshold, repeatable, visibility, icon, enabled, config)
values ('unver_probe', 'Unverified probe', 'consistency', 'WORKOUT_COMPLETED', 1, false, 'club', '🔥', true, '{"client_claimable": true, "metric": "session_count"}')
on conflict (code) do update set config = excluded.config, enabled = excluded.enabled;

-- A tenure-metered, client-claimable definition (independently checked
-- against invite_redemptions - the one pre-existing exception).
insert into public.achievement_definitions (code, name, category, trigger_type, threshold, repeatable, visibility, icon, enabled, config)
values ('tenure_probe', 'Tenure probe', 'club', 'MEMBER_JOINED', 365, false, 'club', '🎖', true, '{"client_claimable": true, "metric": "tenure_days"}')
on conflict (code) do update set config = excluded.config, threshold = excluded.threshold, enabled = excluded.enabled;

-- =====================================================================
-- 1. A client-claimed, non-tenure achievement is stamped UNVERIFIED.
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select lives_ok(
  $$ select public.ach_claim(array['unver_probe']) $$,
  'm1 claims a valid client-claimable, non-tenure code - ach_claim itself is unchanged');
select results_eq(
  $$ select verified from public.member_achievements ma
     join public.achievement_definitions d on d.id = ma.achievement_id
     where ma.user_id = tests.uid('m1') and d.code = 'unver_probe' $$,
  $$ values (false) $$,
  'a client-claimed, non-independently-checkable metric is stamped verified = false');

-- =====================================================================
-- 2. ach_share() refuses to publish an unverified achievement - THE FIX.
-- =====================================================================
select throws_ok(
  $$ select public.ach_share((
       select ma.id from public.member_achievements ma
       join public.achievement_definitions d on d.id = ma.achievement_id
       where ma.user_id = tests.uid('m1') and d.code = 'unver_probe'
     )) $$,
  'P0001', 'achievement not verified',
  'sharing an unverified (forged-shape) achievement is refused outright');
select is_empty(
  $$ select 1 from public.workout_posts where author_id = tests.uid('m1') and post_type = 'POST_ACHIEVEMENT' $$,
  'no POST_ACHIEVEMENT was created for the refused share - the forged badge never became a public post');

-- =====================================================================
-- 3. The trigger is authoritative, not merely "the only current writer
--    happens to behave" - even a privileged direct INSERT explicitly
--    forcing verified = true is overridden from the definition row. (A
--    plain member has no INSERT grant on this table at all - only
--    SECURITY DEFINER functions can write it - so this runs unauthenticated/
--    superuser, the same footing a future service-role backfill or a grant
--    change would have, which is exactly the case the trigger - not the
--    grant list - needs to cover.)
-- =====================================================================
select tests.clear_auth();
insert into public.member_achievements (user_id, achievement_id, visibility, verified)
values (tests.uid('m2'), (select id from public.achievement_definitions where code = 'unver_probe'), 'club', true);
select results_eq(
  $$ select verified from public.member_achievements ma
     join public.achievement_definitions d on d.id = ma.achievement_id
     where ma.user_id = tests.uid('m2') and d.code = 'unver_probe' $$,
  $$ values (false) $$,
  'a caller-supplied verified = true on INSERT is silently overridden - the trigger is authoritative, not advisory');

-- =====================================================================
-- 4. Tenure-verified claims are stamped VERIFIED and CAN be shared -
--    the legitimate path is unaffected.
-- =====================================================================
update public.invite_redemptions set redeemed_at = now() - interval '400 days' where user_id = tests.uid('m3');
select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ select public.ach_claim(array['tenure_probe']) $$,
  'm3, redeemed 400 days ago, claims the tenure-metered code');
select results_eq(
  $$ select verified from public.member_achievements ma
     join public.achievement_definitions d on d.id = ma.achievement_id
     where ma.user_id = tests.uid('m3') and d.code = 'tenure_probe' $$,
  $$ values (true) $$,
  'a tenure_days claim, independently checked against invite_redemptions, is stamped verified = true');
select lives_ok(
  $$ select public.ach_share((
       select ma.id from public.member_achievements ma
       join public.achievement_definitions d on d.id = ma.achievement_id
       where ma.user_id = tests.uid('m3') and d.code = 'tenure_probe'
     )) $$,
  'a verified achievement still shares normally - the fix does not break the legitimate path');
select isnt_empty(
  $$ select 1 from public.workout_posts where author_id = tests.uid('m3') and post_type = 'POST_ACHIEVEMENT' $$,
  'the verified share really did publish a POST_ACHIEVEMENT');

select * from finish();
rollback;
