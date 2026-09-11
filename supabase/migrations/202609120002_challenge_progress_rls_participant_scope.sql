begin;

-- Security hunt, round 7 (2026-09-12), malformed-RPC-parameter agent.
--
-- challenge_progress_insert_self (202608290005) meant to check "is the
-- inserting user an active participant OF THE CHALLENGE THE ROW IS FOR":
--
--   exists (
--     select 1 from public.challenge_participants cp
--     where cp.challenge_id = challenge_id and cp.user_id = auth.uid() and cp.status = 'active'
--   )
--
-- The bare `challenge_id` on the right of `cp.challenge_id = challenge_id`
-- is ambiguous between the row being inserted and the subquery's own `cp`
-- alias, and Postgres resolves it to the closer scope - it compiles to
-- `cp.challenge_id = cp.challenge_id`, a tautology, confirmed live via
-- `select pg_get_expr(polwithcheck, polrelid) ...` on the running policy.
-- The check silently degrades from "active participant of THIS challenge"
-- to "active participant of ANY challenge at all" - trivial to satisfy,
-- since joining any open challenge is self-service.
--
-- Confirmed live against real local Postgres: a member active in challenge
-- C1 only could insert a challenge_progress row for challenge C2, which
-- they never joined, with an arbitrary delta - and challenge_progress_apply
-- sums delta across all rows for a cooperative challenge with no relation
-- to participation, so the forged delta pushed C2 past its milestones and
-- auto-posted real, feed-visible completion cards nobody earned. A member
-- with zero participation anywhere was correctly rejected (existing test
-- coverage only ever exercised that case, which is why this passed green).
--
-- Fix: qualify the outer row's column against the table name, the same
-- way every other insert-self policy in this schema already does when a
-- subquery in its WITH CHECK could otherwise shadow the column.
--
-- Also widens 'active' to 'active' OR 'completed' while fixing this,
-- caught by 0035_challenge_progress_notifications_test's own pre-existing
-- coverage of a compensating negative delta logged AFTER a participant
-- has already crossed target_value ("a completed challenge never
-- un-completes" - challenge_progress_apply, 202608290004, explicitly
-- keeps summing delta past completion). That test only ever passed
-- because the tautology this migration fixes let it through via m1's
-- unrelated active participation in a second challenge in the same
-- fixture, not because the original 'active'-only check was actually
-- correct - qualifying the column without widening the status list would
-- have turned a real, already-relied-upon feature into a fresh
-- regression. 'withdrawn' stays excluded: leaving a challenge still ends
-- a member's ability to log anything further into it.
drop policy challenge_progress_insert_self on public.challenge_progress;
create policy challenge_progress_insert_self on public.challenge_progress for insert to authenticated
  with check (
    user_id = auth.uid()
    and entered_by is null
    and public.is_community_member()
    and exists (
      select 1 from public.challenge_participants cp
      where cp.challenge_id = challenge_progress.challenge_id
        and cp.user_id = auth.uid()
        and cp.status in ('active', 'completed')
    )
  );

commit;
