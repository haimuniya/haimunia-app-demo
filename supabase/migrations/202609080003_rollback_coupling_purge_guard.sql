begin;

-- Rollback coupling for the purge data-loss guard (202609070001).
--
-- WHY A COMMENT AND NOT A DOCUMENT. The rule this records only matters at one
-- moment: when somebody reverts 202609070001. That person is in psql on
-- production, not reading a markdown file in a repository, so the warning has
-- to be in the catalog they are already looking at. ROLLBACK_PLAN.md points
-- here rather than restating the rule, so the prose and the catalog cannot
-- drift into two versions that disagree.
--
-- WHY ON THE BRIDGE AND NOT ON THE FUNCTION AT RISK. `comment on` REPLACES,
-- it does not append. Both 202609010004:121 and 202609070001:266 carry a
-- `comment on function public.purge_abandoned_profiles(integer)`, so any
-- revert that restores the pre-guard definition also restores the pre-guard
-- comment - and a warning parked there is erased by the exact event it exists
-- to warn about. cron_invoke_edge_function() is untouched by that revert, so
-- the warning survives it. That property is the whole reason for the
-- placement.
--
-- The existing comment text is REPRODUCED VERBATIM below and appended to, for
-- the same replace semantics: it is load-bearing (the slug regex, the
-- fire-and-forget rationale, the Vault secret names, the granted-to-no-role
-- note), and losing any of it to a warning about losing things would be a
-- poor outcome. It was copied programmatically out of 202609050005 rather
-- than retyped.
comment on function public.cron_invoke_edge_function(text) is
  'Scheduler bridge, 202609050005. POSTs an empty JSON body to <edge_functions_base_url>/<p_slug> with an Authorization: Bearer <service_role key> header via pg_net, and returns net.http_post''s request id. Both values are read at run time from Supabase Vault (vault.decrypted_secrets, names ''edge_functions_base_url'' and ''edge_functions_service_role_key''); NEITHER is ever written into a migration. Returns NULL and raises a NOTICE without making any request while either secret is missing or still its committed placeholder - which is the state of every local and CI stack, so the two Edge Function cron jobs are inert there. p_slug must match ^[a-z][a-z0-9_-]{2,63}$ or it raises ''unknown edge function %'', so it cannot contain a slash or a scheme and cannot redirect the call at another host. Asynchronous: pg_net queues the request, so this returns before the function has run and a failure surfaces in net._http_response, not here. SECURITY DEFINER to read vault.decrypted_secrets, with NO auth.uid() check - the documented scheduled-job exception - and GRANTED TO NO ROLE, so only the cron job owner can call it. Used by the ''recap-weekly'' and ''purge-abandoned-profiles'' jobs. ROLLBACK COUPLING, added 202609080003. This bridge is the ONLY path to public.purge_abandoned_profiles() - 202609050005 schedules it here and nowhere else, and the function is revoked from public, anon and authenticated with execute granted to service_role alone. 202609070001 fixed a DATA LOSS defect in that function: before it, the sweep deleted from auth.users, private_records cascades from auth.users, and cloud backup opens an anonymous account on a member''s first saved set - so it destroyed the entire training history of every member who logged workouts and never joined the community, on day 31. Reverting 202609070001 restores that predicate. If it is EVER reverted, the ''purge-abandoned-profiles'' schedule must be unscheduled, or the edge_functions_* Vault secrets reset to their placeholders, IN THE SAME CHANGE - so this bridge goes inert with it and the 03:31 UTC run cannot resume deleting logs. The warning lives HERE rather than on purge_abandoned_profiles() deliberately: `comment on` replaces rather than appends, and both 202609010004:121 and 202609070001:266 comment that function, so a revert restores the pre-guard comment and erases any warning left there - the exact event it would exist to warn about. This bridge is untouched by that revert. supabase/tests/0090_purge_training_data_guard_test.sql is the complementary gate: a revert arriving through a PR fails pgTAP in CI. This comment covers what CI cannot see - someone in psql on production.';

commit;
