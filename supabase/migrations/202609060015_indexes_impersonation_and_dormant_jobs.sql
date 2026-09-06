begin;

-- Production-readiness audit, 2026-09-06, part 6. Closes the remaining
-- P2/P3 schema items: DB-M2/DB-M3 (unindexed FK columns), SEC-019
-- (display-name staff impersonation), FEAT-004 (a function nothing
-- schedules) and FEAT-010 (a schedule that runs a no-op).

-- =====================================================================
-- 1. DB-M3 - cascade-path FK columns with no supporting index
-- =====================================================================
-- Every one of these is a sequential scan on the child table each time a
-- parent row is deleted. That is invisible at today's size and is exactly
-- the kind of thing that stops being invisible during the first real
-- account purge, which cascades through many of them at once.
--
-- The list was produced by querying pg_constraint/pg_index on the live
-- database for FK columns that do not lead any index, not by reading the
-- migrations by eye - so it is complete rather than a sample.
--
-- `if not exists` throughout: purely additive, safe to re-run, and cannot
-- collide with an index a future migration adds under a different name.
create index if not exists announcements_author_idx on public.announcements(author_id);
create index if not exists blocks_blocked_idx on public.blocks(blocked_id);
create index if not exists challenge_progress_entered_by_idx on public.challenge_progress(entered_by);
create index if not exists challenge_progress_team_idx on public.challenge_progress(team_id);
create index if not exists challenge_progress_user_only_idx on public.challenge_progress(user_id);
create index if not exists challenge_teams_captain_idx on public.challenge_teams(captain_id);
create index if not exists challenges_created_by_idx on public.challenges(created_by);
create index if not exists coach_engagement_flags_reviewed_by_idx on public.coach_engagement_flags(reviewed_by);
create index if not exists events_created_by_idx on public.events(created_by);
create index if not exists intro_carousel_content_updated_by_idx on public.intro_carousel_content(updated_by);
create index if not exists invite_attempts_user_idx on public.invite_attempts(user_id);
create index if not exists invite_redemptions_invite_idx on public.invite_redemptions(invite_id);
create index if not exists invite_redemptions_person_invite_idx on public.invite_redemptions(person_invite_id);
create index if not exists invite_redemptions_role_idx on public.invite_redemptions(role);
create index if not exists invites_created_by_idx on public.invites(created_by);
create index if not exists invites_redeemed_by_idx on public.invites(redeemed_by);
create index if not exists invites_revoked_by_idx on public.invites(revoked_by);
create index if not exists member_achievements_achievement_idx on public.member_achievements(achievement_id);
create index if not exists member_of_week_post_idx on public.member_of_week(post_id);
create index if not exists member_of_week_published_by_idx on public.member_of_week(published_by);
create index if not exists onboarding_step_content_updated_by_idx on public.onboarding_step_content(updated_by);
create index if not exists post_comments_deleted_by_idx on public.post_comments(deleted_by);
create index if not exists posting_restrictions_source_report_idx on public.posting_restrictions(source_report_id);
create index if not exists reports_post_idx on public.reports(post_id);
create index if not exists reports_reviewed_by_idx on public.reports(reviewed_by);
create index if not exists role_permissions_permission_idx on public.role_permissions(permission_code);
create index if not exists saved_posts_post_idx on public.saved_posts(post_id);
create index if not exists weekly_challenges_created_by_idx on public.weekly_challenges(created_by);

-- =====================================================================
-- 2. DB-M2 - club_id
-- =====================================================================
-- 28 of 31 club-scoped tables have no index leading on club_id. Deleting a
-- club would trigger that many unindexed FK checks, and every club-scoped
-- read path has nothing to lean on the day a second club exists.
--
-- DELIBERATELY NOT INDEXED HERE. With exactly one club row (an invariant
-- 202609060012 now enforces with a trigger), club_id is a single-valued
-- column: an index on it would be read by nothing, chosen by no planner,
-- and would cost a write on every insert to 31 tables. Adding 31 indexes
-- that are provably useless today to satisfy a finding whose own severity
-- note says "invisible on a single-club deployment" would be cargo-culting
-- the recommendation rather than acting on it.
--
-- The finding is real but its trigger condition is the SECOND club, not
-- today. That is now enforceable rather than hoped for: clubs_guard_single_row()
-- refuses a second row outright, so this cannot silently become a problem -
-- somebody has to remove that trigger first, and this comment is what they
-- will find when they do. Recorded in DATABASE_AUDIT.md as a documented
-- multi-club precondition, not as an open index gap.

-- =====================================================================
-- 3. SEC-019 - display_name staff impersonation
-- =====================================================================
-- handle is unique and format-constrained, so handle impersonation is
-- impossible; display_name had only a length cap, so any member could set
-- theirs to "מאמן דנה" or copy another member's exactly. The real coach
-- badge comes from member_roles() and is rendered separately, which bounds
-- the damage - but notification bodies and several surfaces show a name
-- with no badge beside it.
--
-- A uniqueness constraint was considered and rejected: display names are
-- not identifiers, two real members can legitimately share one, and a
-- unique index would fail live inserts for an honest duplicate. What is
-- actually being prevented is claiming STAFF STATUS in a free-text field,
-- so that is what this checks - a narrow, enumerated list of role words,
-- refused only for members who do not hold the role they are claiming.
create or replace function public.profiles_guard_staff_impersonation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  if coalesce(auth.role(), '') <> 'authenticated' then return new; end if;
  if new.display_name is not distinct from old.display_name then return new; end if;

  v_name := lower(btrim(coalesce(new.display_name, '')));
  -- Hebrew and English staff words, matched as whole-ish tokens rather
  -- than substrings so a legitimate name that merely contains one of these
  -- sequences is not blocked.
  if v_name ~ '(^|[^a-zא-ת])(מאמן|מאמנת|מנהל|מנהלת|צוות|admin|coach|staff|moderator|owner)([^a-zא-ת]|$)'
     and not public.is_staff()
     and not exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin and p.deleted_at is null)
  then
    raise exception 'display name may not claim a staff role';
  end if;
  return new;
end $$;
revoke all on function public.profiles_guard_staff_impersonation() from public, anon, authenticated;

drop trigger if exists profiles_guard_staff_impersonation_trigger on public.profiles;
create trigger profiles_guard_staff_impersonation_trigger
  before update of display_name on public.profiles
  for each row execute function public.profiles_guard_staff_impersonation();

comment on function public.profiles_guard_staff_impersonation() is
  'Launch-readiness audit, SEC-019. BEFORE UPDATE OF display_name on profiles. Raises ''display name may not claim a staff role'' (P0001) when a non-staff, non-admin member sets a display name containing a staff word (מאמן/מאמנת/מנהל/מנהלת/צוות/admin/coach/staff/moderator/owner) as a whole token. Real staff are exempt, so a coach may of course call themselves a coach. Deliberately NOT a uniqueness constraint: display names are not identifiers and two real members may share one; what is being prevented is claiming a ROLE, not collision.';

-- =====================================================================
-- 4. FEAT-004 - community_health_generate() had no producer at all
-- =====================================================================
-- Defined and correct since 202609010009, called by nothing: not the
-- client, not an Edge Function, and not one of the scheduled jobs. So
-- community_health_scores has always been empty and every surface reading
-- it renders as "no data". Weekly on Monday matches the module's existing
-- weekly rhythm (feed-weights 04:17, recap-weekly 05:11), on its own
-- minute so three weekly jobs do not stampede.
-- p_week_start has a default, so the no-argument call resolves and the job
-- summarises the current week each run.
select cron.schedule('community-health', '43 4 * * 1',
  $$select public.community_health_generate()$$);

-- =====================================================================
-- 5. FEAT-010 - a weekly cron job that runs a deliberate no-op
-- =====================================================================
-- recompute_feed_weights() has an intentionally empty body (202608310006
-- says so in its own comment and calls itself "A DELIBERATE NO-OP STUB"),
-- because the derivation it needs was never built. 202609050005 scheduled
-- it anyway. The result is a weekly job that always succeeds having done
-- nothing, which reads as "personalized ranking is working" to anyone
-- checking cron.job_run_details - the most misleading possible state.
--
-- THE DECISION: unschedule it. Personalized feed weights are a real
-- feature that is NOT built; the honest representation of that is no job,
-- not a green job. Every member continues to get feed_page's fixed default
-- weights, which is exactly what happens today. Re-scheduling is one line
-- in whichever migration finally implements the derivation.
select cron.unschedule('feed-weights-recompute');

comment on function public.recompute_feed_weights(integer) is
  'A DELIBERATE NO-OP STUB. The per-member weight derivation was never built (202608310006), so this writes nothing and every member falls back to feed_page''s fixed defaults. UNSCHEDULED by 202609060015 (launch-readiness audit, FEAT-010): 202609050005 had it running weekly, which made an unbuilt feature look like a working one in cron.job_run_details. Whoever implements the derivation should re-add the cron.schedule call in the same migration.';

commit;
