-- 202609060028: the club WOD catalogue.
--
-- THE DEFECT IT CLOSES. A weekly challenge is a comparison_key, and the WOD
-- form of that key is `wod:<wodId>:<scoreType>:<rx|scaled>` (app.js:2263).
-- A custom WOD is LOCAL data - IndexedDB plus a private_records row nobody
-- but its author can read - so a challenge keyed to a coach's own
-- programming resolved on exactly one device in the club and was invalid,
-- unjoinable and unscoreable for everyone else. 202609060026 named that and
-- left it open ("refused by nobody: a well-shaped key naming something real
-- that only ONE member's device knows about").
--
-- What this file pins, in order:
--   1. the boundary (who reads, who publishes, who can never write directly)
--   2. THE POINT: a published WOD's comparison key satisfies the existing
--      weekly_challenges CHECK, so a coach can actually run the challenge
--   3. the id rule, including the imported-backup id that is legal on the
--      client and would have produced a key the database refuses
--   4. the privacy rule: nothing auto-publishes, and one member cannot
--      publish another member's private custom WOD
--   5. the snapshot rule: re-publishing a CHANGED definition raises rather
--      than silently changing what a live challenge means
--   6. retirement, and that a retired WOD is still readable - the client
--      must keep resolving it or a member's own history breaks

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

\set w1 '''customwod-11111111-1111-4111-8111-111111111111'''
\set w2 '''customwod-22222222-2222-4222-8222-222222222222'''
\set w3 '''customwod-33333333-3333-4333-8333-333333333333'''
\set w4 '''customwod-44444444-4444-4444-8444-444444444444'''
\set w5 '''customwod-55555555-5555-4555-8555-555555555555'''

-- =====================================================================
-- 1. THE TABLE AND ITS BOUNDARY
-- =====================================================================
select has_table('public', 'club_wods', 'the catalogue exists...');
select is(
  (select relrowsecurity from pg_class where oid = 'public.club_wods'::regclass),
  true,
  '...with RLS enabled...');
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'club_wods'),
  1,
  '...and exactly one policy, so it is neither unreachable nor open by accident');

select ok(
  has_table_privilege('authenticated', 'public.club_wods', 'select'),
  'authenticated may SELECT (the policy narrows that to is_community_member)');
select ok(
  not has_table_privilege('authenticated', 'public.club_wods', 'insert')
  and not has_table_privilege('authenticated', 'public.club_wods', 'update')
  and not has_table_privilege('authenticated', 'public.club_wods', 'delete'),
  'and can NEVER write the table directly - no insert, update or delete grant, so publish/edit/retire cannot be stepped around with a raw PostgREST call, and the ownership probe, the snapshot rule and the audit row cannot be skipped');
select ok(
  not has_table_privilege('anon', 'public.club_wods', 'select'),
  'anon cannot read the catalogue at all');

-- No DELETE grant is the retirement decision made structural: three separate
-- things reference a published wod_id (weekly_challenges rows,
-- workout_posts.comparison_key, every member's local wod_entries) and all of
-- them outlive the decision to stop programming the workout.
select ok(
  not exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'club_wods' and cmd = 'DELETE'),
  'there is no DELETE policy either - retirement is the only exit, deliberately');

-- =====================================================================
-- 2. WHO MAY PUBLISH
-- =====================================================================
-- community.challenge.create, the permission that already gates creating the
-- weekly challenge this catalogue exists to serve (202609060005). Not
-- is_staff(), which that migration explicitly moved weekly_challenges away
-- from because it also admits the `staff` role, which holds no challenge
-- permission at all.
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  format($$ select public.club_wod_publish(%L, 'Coach Special', 'time', '21-15-9') $$, :w1),
  'P0001', 'not authorized',
  'THE WRITE BOUNDARY: a plain member cannot publish to the club catalogue, so a member''s private programming can never become club content by their own hand');

select tests.set_auth(tests.uid('norec'));
select throws_ok(
  format($$ select public.club_wod_publish(%L, 'Coach Special', 'time', '21-15-9') $$, :w1),
  'P0001', 'recovery method required',
  'and a member mid-onboarding is stopped by is_community_member() before the permission is even consulted, in the module''s standing order');

select tests.set_auth(tests.uid('coach'));
select lives_ok(
  format($$ select public.club_wod_publish(%L, 'Coach Special', 'time', '21-15-9 Thrusters & Pull-ups') $$, :w1),
  'a coach - community.challenge.create - publishes');
select lives_ok(
  format($$ select public.club_wod_publish(%L, 'Club Cindy', 'amrap', 'AMRAP 20') $$, :w2),
  'and a second one, which the challenge tests below use');

select tests.set_auth(tests.uid('admin'));
select lives_ok(
  format($$ select public.club_wod_publish('customwod-a0000000-0000-4000-8000-00000000000a', 'Admin WOD', 'load', '1RM complex') $$),
  'an admin holds the same permission and publishes too');

-- =====================================================================
-- 3. THE POINT OF THE WHOLE MIGRATION
-- =====================================================================
-- A published WOD's comparison key must satisfy
-- weekly_challenges_comparison_key_shape (202609060026). If it does not, a
-- coach can publish a workout and still not be able to run a challenge on
-- it, which is the entire defect restated.
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  format($$ insert into public.weekly_challenges (id, comparison_key, title, starts_on, ends_on, created_by)
            values ('40890000-0000-4000-8000-000000000001',
                    'wod:' || %L || ':amrap:rx', 'Club Cindy week',
                    current_date, current_date + 6, tests.uid('coach')) $$, :w2),
  'THE POINT: a challenge keyed to a PUBLISHED club WOD is accepted by weekly_challenges_comparison_key_shape - the coach can now run a club challenge on their own programming, which is the one thing they could not do before');

-- Stated as a theorem over the table rather than as one lucky example, so a
-- later widening of the wod_id CHECK that broke it would fail here.
select is_empty(
  $$ select wod_id from public.club_wods
     where ('wod:' || wod_id || ':' || score_type || ':rx')
           !~ '^(movement:[a-z0-9-]+:(est1rm|duration)|wod:[a-z0-9-]+:[a-z]+:(rx|scaled))$'
        or ('wod:' || wod_id || ':' || score_type || ':scaled')
           !~ '^(movement:[a-z0-9-]+:(est1rm|duration)|wod:[a-z0-9-]+:[a-z]+:(rx|scaled))$' $$,
  'and that holds for EVERY row in the catalogue, both rx and scaled - the wod_id CHECK exists to make it a guarantee rather than a coincidence');
select is_empty(
  $$ select wod_id from public.club_wods where char_length('wod:' || wod_id || ':' || score_type || ':scaled') > 160 $$,
  'and every such key fits weekly_challenges.comparison_key''s 1..160 length CHECK - 128 (cleanId''s idLen) + 17 is 145');

-- =====================================================================
-- 4. THE ID RULE
-- =====================================================================
select throws_ok(
  $$ select public.club_wod_publish('fran', 'Not Fran', 'time', 'x') $$,
  'P0001', 'wod id must be a custom WOD id',
  'a WOD_LIBRARY id is refused, so a published WOD can never shadow a built-in one on every member''s device');
-- cleanId() accepts [A-Za-z0-9._:-], so an IMPORTED backup can put this id
-- on a device legally. Its comparison key would be
-- `wod:customwod-ABC.x:y:time:rx`, which weekly_challenges refuses - i.e. a
-- WOD that could be published and then never used for the one thing
-- publishing is for. Publish time is the only moment the coach can be told.
select throws_ok(
  $$ select public.club_wod_publish('customwod-ABC.x:y', 'Imported', 'time', 'x') $$,
  'P0001', 'wod id must be a custom WOD id',
  'and so is an id that is legal on the client but whose comparison key the weekly_challenges CHECK would reject - cleanId() allows [A-Za-z0-9._:-], so an imported backup really can produce one, and this is the only moment a coach can still be told');
select throws_ok(
  $$ select public.club_wod_publish('clubwod-6f1b2c3d', 'Wrong namespace', 'time', 'x') $$,
  'P0001', 'wod id must be a custom WOD id',
  'and any id outside the customwod- namespace, which is what keeps "customwod-<uuid>" meaning exactly one thing');
select throws_ok(
  format($$ select public.club_wod_publish(%L, '   ', 'time', 'x') $$, :w3),
  'P0001', 'a wod needs a name',
  'a blank name is refused after trimming');
select throws_ok(
  format($$ select public.club_wod_publish(%L, 'Bad score', 'rounds', 'x') $$, :w3),
  'P0001', 'unknown score type',
  'and a score type outside WOD_SCORE_TYPES is refused - score_type lands verbatim in the comparison key');

-- =====================================================================
-- 5. PRIVACY: NOTHING AUTO-PUBLISHES, AND NOT YOUR WOD, NOT YOUR CALL
-- =====================================================================
select tests.clear_auth();
insert into public.private_records (user_id, record_type, record_id, payload)
values (tests.uid('m1'), 'custom_wod', :w4,
        jsonb_build_object('id', :w4, 'name', 'My private hero WOD', 'scoreType', 'time'));
select is_empty(
  format($$ select wod_id from public.club_wods where wod_id = %L $$, :w4),
  'THE PRIVACY RULE: syncing a custom WOD to private_records publishes NOTHING. There is no trigger from private_records to club_wods and there must never be one - syncing your training log and publishing it are different acts');

select tests.set_auth(tests.uid('coach'));
select throws_ok(
  format($$ select public.club_wod_publish(%L, 'Stolen', 'time', 'x') $$, :w4),
  'P0001', 'not authorized',
  'and a coach cannot publish under a record_id that is a DIFFERENT member''s private custom WOD - besides being someone else''s private record, that member''s client would then merge a club WOD whose id collides with a different local workout of their own and their history would render as someone else''s programming');

select tests.clear_auth();
insert into public.private_records (user_id, record_type, record_id, payload)
values (tests.uid('coach'), 'custom_wod', :w5,
        jsonb_build_object('id', :w5, 'name', 'Coach own', 'scoreType', 'time'));
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  format($$ select public.club_wod_publish(%L, 'Coach Own', 'time', 'x') $$, :w5),
  'while the coach''s OWN synced custom WOD publishes normally');
-- The third case, and the one a stricter rule would have broken: cloud
-- backup is opt-OUT, so a coach who switched sync off has a real WOD on
-- their device and no server copy of it, forever. w1/w2 above had no
-- private_records row at all and published fine - asserted here so the
-- permissiveness is deliberate rather than accidental.
select isnt_empty(
  format($$ select wod_id from public.club_wods where wod_id = %L $$, :w1),
  'and a WOD with NO server copy at all published fine (w1 above) - cloud backup is opt-out, so refusing that case would make publishing permanently impossible for a coach who turned sync off');

-- =====================================================================
-- 6. THE SNAPSHOT RULE
-- =====================================================================
select is(
  (select public.club_wod_publish(:w1, 'Coach Special', 'time', '21-15-9 Thrusters & Pull-ups') ->> 'name'),
  'Coach Special',
  'publishing the IDENTICAL definition again returns the existing row - a double tap on the button, or a retry after a dropped response, is safe');
select is(
  (select count(*)::int from public.club_wods where wod_id = :w1),
  1,
  '...and does not duplicate the row');
-- admin_actions_read_analytics needs community.analytics.view, which the
-- coach does not hold, so every audit assertion in this file drops to the
-- bootstrap superuser first and re-impersonates afterwards. Reading the log
-- as the coach would silently return zero rows and turn these into
-- assertions that pass for the wrong reason.
select tests.clear_auth();
select is(
  (select count(*)::int from public.admin_actions
   where action_type = 'club_wod_published' and after_data ->> 'wod_id' = :w1),
  1,
  '...and writes no second audit row, because a retry is not a second decision');
select tests.set_auth(tests.uid('coach'));

select throws_ok(
  format($$ select public.club_wod_publish(%L, 'Coach Special v2', 'time', 'now with 30 burpees') $$, :w1),
  'P0001', 'wod already published',
  'THE SNAPSHOT RULE: re-publishing a CHANGED definition RAISES rather than overwriting. Silently overwriting would change what a running challenge asks of people, mid-week, with scores already on the board - the same class of defect this branch has been fixing - and would leave the coach believing a local edit had propagated when it had not');
select is(
  (select description from public.club_wods where wod_id = :w1),
  '21-15-9 Thrusters & Pull-ups',
  'and the club copy is untouched by that attempt');

-- =====================================================================
-- 7. READS
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select isnt_empty(
  format($$ select wod_id from public.club_wods where wod_id = %L $$, :w1),
  'THE READ: an ordinary member can read a WOD the coach published - which is the whole mechanism, since the members who must resolve the challenge key are the ones who never had the WOD');
select is(
  (select j ->> 'id' from public.club_wods_list() j where j ->> 'id' = :w1),
  :w1,
  'club_wods_list() returns it, keyed by the CLIENT id (the wod_id) so allWods() can merge it with no remapping');
select is(
  (select j ->> 'category' from public.club_wods_list() j where j ->> 'id' = :w1),
  'Club',
  'with category ''Club'', which is what makes cloud.js challengeKeyChoices() stop skipping it (it skips "Custom") and app.js deleteCustomWod() refuse it (it requires "Custom") - a member cannot delete club programming off their own device');
select results_eq(
  format($$ select (select array_agg(k order by k) from jsonb_object_keys(j) k)
            from public.club_wods_list() j where j ->> 'id' = %L $$, :w1),
  $$ values (array['category','desc','emomMinutes','emomMovements','emomTargetReps','id','name','publishedAt','publishedBy','retiredAt','scoreType','timeCapSeconds']) $$,
  'and the shape is exactly sanitizeCustomWod()''s field set plus publish/retire metadata, every key always present so the client never tests for absence');

select tests.set_auth(tests.uid('norec'));
select throws_ok(
  $$ select * from public.club_wods_list() $$,
  'P0001', 'recovery method required',
  'a member with no verified recovery method cannot list the catalogue - it is club content, and an anonymous sign-in session holds a real authenticated JWT and nothing else');
select is_empty(
  $$ select wod_id from public.club_wods $$,
  'and the policy says the same thing directly on the table, so the RPC is not the only thing standing there');

-- =====================================================================
-- 8. EMOM
-- =====================================================================
-- EMOM can never be a challenge (wodShareCandidate returns a null
-- comparisonKey for it and the picker skips it) but is worth publishing on
-- its own: members can log the coach's programming.
select tests.set_auth(tests.uid('coach'));
select throws_ok(
  format($$ select public.club_wod_publish(%L, 'Club EMOM', 'emom', 'x', '[]'::jsonb, '[]'::jsonb, 12) $$, :w3),
  'P0001', 'an emom needs at least one movement',
  'an EMOM with no rotation is refused - the log form draws one reps field per movement, so an empty rotation is an unloggable workout');
select throws_ok(
  format($$ select public.club_wod_publish(%L, 'Club EMOM', 'emom', 'x',
             '["Burpees","Wall Balls"]'::jsonb, '[10]'::jsonb, 12) $$, :w3),
  'P0001', 'emom target reps must match the movements',
  'and a target-reps array that does not line up positionally with the movements is refused rather than padded with zeroes - the pairing is positional, and inventing a zero would publish a client bug');
select lives_ok(
  format($$ select public.club_wod_publish(%L, 'Club EMOM', 'emom', 'Alternating',
             '["Burpees","Wall Balls"]'::jsonb, '[10,15]'::jsonb, 12) $$, :w3),
  'a well-formed EMOM publishes - it can never be a challenge, but members can log it');
select results_eq(
  format($$ select j -> 'emomMovements', j -> 'emomTargetReps', j ->> 'emomMinutes'
            from public.club_wods_list() j where j ->> 'id' = %L $$, :w3),
  $$ values ('["Burpees", "Wall Balls"]'::jsonb, '[10, 15]'::jsonb, '12'::text) $$,
  'and the rotation survives the round trip in the shape renderWodLogSection() reads');
select ok(
  (select j -> 'emomMovements' = '[]'::jsonb from public.club_wods_list() j where j ->> 'id' = :w1),
  'while a non-EMOM carries an empty rotation rather than a missing key - a stable shape, so the client never branches on absence');

-- =====================================================================
-- 9. RETIREMENT
-- =====================================================================
-- w2 is referenced by the live challenge inserted in section 3.
select throws_ok(
  format($$ select public.club_wod_retire(%L, 'no longer programmed') $$, :w2),
  'P0001', 'wod is used by a live challenge',
  'a WOD a running challenge references cannot be retired - a coach must not be able to pull the workout out from under a challenge that is scoring right now');

select tests.clear_auth();
update public.weekly_challenges
   set starts_on = current_date - 20, ends_on = current_date - 14
 where id = '40890000-0000-4000-8000-000000000001';
select tests.set_auth(tests.uid('coach'));
select lives_ok(
  format($$ select public.club_wod_retire(%L, 'no longer programmed') $$, :w2),
  'once that challenge has ended, retirement goes through');
select isnt(
  (select retired_at from public.club_wods where wod_id = :w2), null,
  'the row is flagged, not deleted...');
select is(
  (select j ->> 'retiredAt' is not null from public.club_wods_list() j where j ->> 'id' = :w2), true,
  '...and club_wods_list() STILL RETURNS IT, carrying retiredAt. This is load-bearing: the id is referenced by that finished challenge, by workout_posts.comparison_key and by every member''s local wod_entries, so a client that stopped resolving it would render a member''s own logged history as an unknown workout. Hiding a retired WOD is a picker decision, not a catalogue one');
select tests.clear_auth();
select is(
  (select count(*)::int from public.admin_actions where action_type = 'club_wod_retired'), 1,
  'the retirement is audited...');
select is(
  (select note from public.admin_actions where action_type = 'club_wod_retired'),
  'no longer programmed',
  '...with the coach''s reason in admin_actions.note, where 202609060022 put every other staff justification');
select tests.set_auth(tests.uid('coach'));

select lives_ok(
  format($$ select public.club_wod_retire(%L, 'again') $$, :w2),
  'retiring an already-retired WOD is a no-op rather than an error - a retry is not a new decision');
select tests.clear_auth();
select is(
  (select count(*)::int from public.admin_actions where action_type = 'club_wod_retired'), 1,
  '...and writes no second audit row');
select tests.set_auth(tests.uid('coach'));

select lives_ok(
  format($$ select public.club_wod_restore(%L) $$, :w2),
  'and retirement is reversible');
select is(
  (select retired_at from public.club_wods where wod_id = :w2), null,
  'restore clears the flag...');
select tests.clear_auth();
select is(
  (select before_data ->> 'retired_reason' from public.admin_actions where action_type = 'club_wod_restored'),
  'no longer programmed',
  '...and the audit row keeps the retirement it undid, so the log holds both halves of the decision');
select tests.set_auth(tests.uid('coach'));

select throws_ok(
  $$ select public.club_wod_retire('customwod-deadbeef-0000-4000-8000-000000000000') $$,
  'P0001', 'wod not found',
  'retiring something that was never published says so');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  format($$ select public.club_wod_retire(%L) $$, :w1),
  'P0001', 'not authorized',
  'and a plain member can retire nothing');

-- =====================================================================
-- 10. EDIT - the narrow correction path
-- =====================================================================
select tests.set_auth(tests.uid('coach'));
select is(
  (select public.club_wod_edit(:w1, 'Coach Special', '21-15-9 Thrusters and Pull-ups') ->> 'desc'),
  '21-15-9 Thrusters and Pull-ups',
  'a typo in the description is correctable - without this path the catalogue would have no delete grant AND no way to fix a mistake, which is a trap rather than a policy');
select is(
  (select score_type from public.club_wods where wod_id = :w1), 'time',
  'and score_type is untouched by it - there is no parameter for it, because score_type is in the comparison key and changing it would repoint every future entry at a key the challenge was not created with');

-- w2's challenge was moved into the past in section 9. A finished board is a
-- record of what people did against a STATED workout.
select throws_ok(
  format($$ select public.club_wod_edit(%L, 'Club Cindy', 'AMRAP 25 now') $$, :w2),
  'P0001', 'wod is locked by a challenge',
  'a WOD whose challenge has already STARTED - finished ones included - cannot be edited: a leaderboard is a record of what people did against a stated workout, and rewriting the workout afterwards falsifies it');
select lives_ok(
  format($$ select public.club_wod_edit(%L, 'Club Cindy', 'AMRAP 20') $$, :w2),
  'while a no-op edit on that same locked WOD returns unchanged instead of raising - the lock is about changing meaning, not about touching the row');

select tests.set_auth(tests.uid('m1'));
select throws_ok(
  format($$ select public.club_wod_edit(%L, 'Hijacked', 'x') $$, :w1),
  'P0001', 'not authorized',
  'and a plain member can edit nothing');

-- =====================================================================
-- 11. THE AUDIT TRAIL
-- =====================================================================
select tests.clear_auth();
select is(
  (select count(distinct action_type)::int from public.admin_actions
   where action_type like 'club\_wod\_%'),
  4,
  'all four club-WOD actions are distinguishable in the log - publish, edit, retire and restore each carry their own action_type, because a log that cannot tell taking something down from putting it back is the exact defect 202609060022 was written to fix');
select is(
  (select count(*)::int from public.admin_actions
   where action_type like 'club\_wod\_%' and target_type <> 'club_wod'),
  0,
  'every one of them targets ''club_wod''');
select is(
  (select count(*)::int from public.admin_actions
   where action_type like 'club\_wod\_%' and target_user_id is not null),
  0,
  'and none names a target MEMBER, correctly: publishing a workout is an action on club content, not on a person');
select is(
  (select count(*)::int from public.admin_actions
   where action_type like 'club\_wod\_%' and admin_display is null),
  0,
  'while every row does name the acting staff member, through log_admin_action''s own snapshot');
select ok(
  (select target_id in (select id from public.club_wods) from public.admin_actions
   where action_type = 'club_wod_published' and after_data ->> 'wod_id' = :w1),
  'and target_id is the catalogue row''s surrogate uuid, which is the only reason the table carries one - admin_actions.target_id is uuid and the meaningful key is text');

select * from finish();
rollback;
