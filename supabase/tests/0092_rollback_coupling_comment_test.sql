-- The rollback-coupling warning on public.cron_invoke_edge_function(text)
-- must survive, and must keep the text it was appended to.
--
-- WHY A TEST FOR A COMMENT. Because the hazard this comment describes is the
-- same hazard that can erase it. `comment on` REPLACES rather than appends,
-- so any later migration that re-comments this function silently drops the
-- warning, and nothing else in the repository would notice. That is exactly
-- how the warning ended up here rather than on purge_abandoned_profiles():
-- both 202609010004:121 and 202609070001:266 comment THAT function, so a
-- revert restores the pre-guard comment and takes any warning with it.
-- Moving the text somewhere a revert cannot reach is only half the job; this
-- file is the half that notices if a rewrite reaches it anyway.
--
-- WHAT IT PROTECTS. 202609070001 fixed a data-loss defect in
-- purge_abandoned_profiles(): the sweep deleted from auth.users,
-- private_records cascades from auth.users, and cloud backup opens an
-- anonymous account on a member's first saved set - so it destroyed the
-- whole training history of every member who logged workouts and never
-- joined the community. This bridge is the only path to that function, so
-- the bridge is where a reverter has to be told to make it inert.
--
-- 0090 is the complementary gate and covers the revert itself. This file
-- covers the instruction surviving to be read.
begin;
select plan(4);

select isnt(
  obj_description('public.cron_invoke_edge_function(text)'::regprocedure),
  null,
  'the bridge function still carries a comment at all'
);

-- The appended warning. Asserted on the OPERATIVE instruction rather than on
-- a stylistic phrase, so rewording the prose does not fail the test but
-- dropping the rule does.
select ok(
  obj_description('public.cron_invoke_edge_function(text)'::regprocedure) like '%202609070001%',
  'the comment still names the migration whose revert is dangerous'
);

select ok(
  obj_description('public.cron_invoke_edge_function(text)'::regprocedure) like '%IN THE SAME CHANGE%',
  'the comment still states that the schedule must be made inert in the SAME change as any revert'
);

-- The original text 202609050005 put here is load-bearing on its own - the
-- slug regex, the fire-and-forget rationale, the Vault secret names, the
-- granted-to-no-role note. 202609080003 appended to it rather than replacing
-- it, and this asserts that nothing since has quietly reverted to a
-- warning-only or an original-only version.
select ok(
  obj_description('public.cron_invoke_edge_function(text)'::regprocedure)
    like '%Used by the ''recap-weekly'' and ''purge-abandoned-profiles'' jobs.%',
  'the original 202609050005 comment text is still intact underneath the warning'
);

select * from finish();
rollback;
