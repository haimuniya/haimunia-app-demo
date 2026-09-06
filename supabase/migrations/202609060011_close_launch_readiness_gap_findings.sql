begin;

-- Production-readiness audit, 2026-09-06. Closes four independently-verified
-- findings left open after 202609060001's anonymous-read-gate fix and the
-- 202609060005 moderation-boundary work:
--
--   SEC-001 (P0): the anonymous read gate covered 3 relations; ~14 more
--   member-identifying relations were never gated, so a free, invite-free
--   `signInAnonymously()` session can still read the challenge roster, the
--   event calendar, member-of-week, and per-member achievement unlocks.
--
--   SEC-002/SEC-005 (P1/P2, one root cause): `posts_update_self` is
--   column-unrestricted, so a post's author can PATCH `status`/`deleted_at`
--   back to 'active'/null after a moderator's `post_delete()`, and can PATCH
--   `score_value`/`comparison_key`/`published_at`/`is_pinned` to forge the
--   comparison board and feed ranking.
--
--   Un-numbered finding from the same pass: `posts_delete_self` (a raw RLS
--   DELETE policy, never dropped when `post_delete()` shipped as the
--   moderator-aware soft-delete path) plus the standing table-level DELETE
--   grant let an author hard-DELETE their own reported post. `reports.post_id`
--   is `on delete cascade`, so this also destroys the report filed against it
--   - the offender can erase the moderation evidence, not just the post.
--
--   DB audit (HIGH): `purge_due_accounts()` (202608260001) was never given a
--   `cron.schedule` entry in 202609050005, so the 30-day account-deletion
--   promise in PRIVACY.md never executes. Separately, 5 FKs to `auth.users`
--   added after that function shipped carry no `ON DELETE` clause, so the
--   first blocked row would abort its one bulk DELETE statement for every
--   due account in the batch, not just the blocked one.
--
-- Not run against a live Postgres from this sandbox - no Supabase CLI, no
-- running Docker containers. Written to the exact style/predicates of the
-- migrations it amends; verify with a cold `supabase db reset` +
-- `supabase test db` before merge, per DATABASE_AUDIT.md.

-- =====================================================================
-- 1. SEC-001 - extend the anonymous read gate to every relation that
--    carries a member identifier (user_id / created_by) and was left on
--    `to authenticated using (true)` or an unauthenticated EXISTS check.
-- =====================================================================

drop policy if exists challenge_teams_read on public.challenge_teams;
create policy challenge_teams_read on public.challenge_teams for select to authenticated
  using (public.is_community_member() and exists (select 1 from public.challenges c where c.id = challenge_id));

drop policy if exists challenge_participants_read on public.challenge_participants;
create policy challenge_participants_read on public.challenge_participants for select to authenticated
  using (public.is_community_member() and exists (select 1 from public.challenges c where c.id = challenge_id));

drop policy if exists challenge_progress_read on public.challenge_progress;
create policy challenge_progress_read on public.challenge_progress for select to authenticated
  using (public.is_community_member() and exists (select 1 from public.challenges c where c.id = challenge_id));

drop policy if exists event_attendees_read on public.event_attendees;
create policy event_attendees_read on public.event_attendees for select to authenticated using (
  public.is_community_member()
  and (
    user_id = auth.uid()
    or public.has_perm('community.event.manage')
    or public.can_view_profile_field(user_id, 'show_in_attendee_lists')
  )
);

drop policy if exists events_read on public.events;
create policy events_read on public.events for select to authenticated using (
  public.is_community_member()
  and (
    status <> 'draft'
    or created_by = auth.uid()
    or public.has_perm('community.event.manage')
  )
  and public.club_feature_enabled('events')
);

drop policy if exists challenges_read on public.challenges;
create policy challenges_read on public.challenges for select to authenticated using (
  public.is_community_member()
  and (
    status <> 'draft'
    or created_by = auth.uid()
    or public.has_perm('community.challenge.create')
  )
  and public.club_feature_enabled('challenges')
);

-- Byte-identical to 202609010012's version except for the added
-- is_community_member() conjunct. Both the trailing
-- club_feature_enabled('achievements') gate AND the are_friends() helper are
-- preserved deliberately: an earlier draft of this migration re-typed the
-- policy from memory, dropped the module gate, and open-coded the mutual-
-- follow check - which silently re-enabled achievement reads for a club that
-- had switched the achievements module OFF. Caught by 0055_club_features_test
-- (tests 20-21) on the first real pgTAP run. Do not re-type this policy; copy
-- it.
drop policy if exists member_achievements_read on public.member_achievements;
create policy member_achievements_read on public.member_achievements for select to authenticated using (
  public.is_community_member()
  and (
    user_id = auth.uid()
    or (
      visibility = 'club'
      and public.can_view_profile_field(user_id, 'show_achievements')
    )
    or (
      visibility = 'friends'
      and public.are_friends(user_id)
      and public.can_view_profile_field(user_id, 'show_achievements')
    )
  )
  and public.club_feature_enabled('achievements')
);

drop policy if exists member_of_week_read on public.member_of_week;
create policy member_of_week_read on public.member_of_week for select to authenticated
  using (public.is_community_member());

drop policy if exists weekly_challenges_read on public.weekly_challenges;
create policy weekly_challenges_read on public.weekly_challenges for select to authenticated
  using (public.is_community_member());

drop policy if exists pins_read on public.pins;
create policy pins_read on public.pins for select to authenticated
  using (public.is_community_member());

-- Config/RBAC tables: no member identifier, so not part of the P0 (a ghost
-- learning the club's role/permission names is not a confidentiality
-- breach) - gated anyway per SEC-001's own "tidiness" recommendation, at
-- zero functional cost: a mid-onboarding member (redeemed but not yet
-- recovery-verified) reaches no screen that reads these (COMM-016's gate
-- card is the only thing rendered until recovery_verified_at is stamped,
-- per 202609060001's own header), and a fully redeemed member is always
-- is_community_member() = true.
drop policy if exists clubs_read on public.clubs;
create policy clubs_read on public.clubs for select to authenticated using (public.is_community_member());

drop policy if exists roles_read on public.roles;
create policy roles_read on public.roles for select to authenticated using (public.is_community_member());

drop policy if exists permissions_read on public.permissions;
create policy permissions_read on public.permissions for select to authenticated using (public.is_community_member());

drop policy if exists role_permissions_read on public.role_permissions;
create policy role_permissions_read on public.role_permissions for select to authenticated using (public.is_community_member());

drop policy if exists achievement_definitions_read on public.achievement_definitions;
create policy achievement_definitions_read on public.achievement_definitions for select to authenticated
  using (public.is_community_member());

drop policy if exists monthly_club_recaps_published_select on public.monthly_club_recaps;
create policy monthly_club_recaps_published_select on public.monthly_club_recaps
  for select to authenticated
  using (public.is_community_member() and published_at is not null);

-- Deliberately NOT gated (unchanged): onboarding_step_content, intro_carousel
-- _content, club_features - all three are pre-redemption onboarding screens
-- by design, carry no member field, and 202609060001:54-61 already argues
-- this. club_feature_enabled() (called above) reads club_features itself and
-- must stay callable pre-membership or every newly-gated policy above breaks
-- for a legitimate member whose is_community_member() is about to flip true.

-- =====================================================================
-- 2. SEC-002 / SEC-005 - a BEFORE UPDATE guard on workout_posts closing the
--    author-reverses-moderation and author-forges-ranking gaps in one
--    trigger, shaped exactly like challenge_participants_guard_progress()
--    (202609060005).
-- =====================================================================

create or replace function public.workout_posts_guard_moderated_fields() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_pinned boolean;
begin
  if coalesce(auth.role(), '') <> 'authenticated' then return new; end if;

  v_pinned := coalesce(current_setting('app.allow_moderation_write', true), '') = 'on';
  if v_pinned then return new; end if;

  if new.status is distinct from old.status
     or new.deleted_at is distinct from old.deleted_at
     or new.score_value is distinct from old.score_value
     or new.score_direction is distinct from old.score_direction
     or new.comparison_key is distinct from old.comparison_key
     or new.published_at is distinct from old.published_at
     or new.is_pinned is distinct from old.is_pinned
  then
    raise exception 'field is server derived';
  end if;

  return new;
end $$;
revoke all on function public.workout_posts_guard_moderated_fields() from public, anon, authenticated;

drop trigger if exists workout_posts_guard_moderated_fields_trigger on public.workout_posts;
create trigger workout_posts_guard_moderated_fields_trigger
  before update of status, deleted_at, score_value, score_direction, comparison_key, published_at, is_pinned
  on public.workout_posts
  for each row execute function public.workout_posts_guard_moderated_fields();

comment on function public.workout_posts_guard_moderated_fields() is
  'Launch-readiness audit. BEFORE UPDATE OF status, deleted_at, score_value, score_direction, comparison_key, published_at, is_pinned on workout_posts. Raises ''field is server derived'' (P0001) for any authenticated change to these seven columns, closing both SEC-002 (an author reversing a moderators post_delete() via PATCH) and SEC-005 (an author forging the comparison-board score or back/forward-dating published_at). Bypassed only inside the transaction-local app.allow_moderation_write pin, set by post_delete(), request_account_deletion() and admin_remove_member() around their own UPDATEs. Skipped entirely when auth.role() is not ''authenticated'' (service role, dashboard, backfills unaffected). post_set_visibility() and post_edit_caption() (202609060007) are untouched - neither column is in this list.';

-- post_delete(): pin the GUC around its one UPDATE. Recreated in full
-- (byte-identical apart from the two set_config calls) because that is the
-- only way Postgres offers to patch a function body.
create or replace function public.post_delete(post_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_row public.workout_posts;
  v_is_mod boolean;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  select * into v_row from public.workout_posts where id = post_id;
  if not found then raise exception 'post not found'; end if;

  v_is_mod := public.has_perm('community.post.delete_any')
              or public.has_perm('community.comment.moderate')
              or exists (select 1 from public.profiles where id = v_uid and is_admin and deleted_at is null);

  if v_row.author_id is distinct from v_uid and not v_is_mod then
    raise exception 'not authorized';
  end if;

  if v_row.deleted_at is not null and v_row.status = 'removed' then return; end if;

  perform set_config('app.allow_moderation_write', 'on', true);
  update public.workout_posts
    set deleted_at = now(), status = 'removed'
  where id = post_id;
  perform set_config('app.allow_moderation_write', 'off', true);

  if v_row.author_id is distinct from v_uid then
    perform public.log_admin_action(
      'content_delete', 'post', post_id,
      jsonb_build_object('status', v_row.status::text, 'deleted_at', v_row.deleted_at),
      jsonb_build_object('status', 'removed')
    );
  end if;
end $$;
revoke all on function public.post_delete(uuid) from public, anon;

-- request_account_deletion(): same pin around its own-posts UPDATE.
create or replace function public.request_account_deletion() returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.account_deletion_requests(user_id) values (auth.uid())
  on conflict (user_id) do update set requested_at = now(), purge_after = now() + interval '30 days';
  update public.profiles set deleted_at = now() where id = auth.uid();
  perform set_config('app.allow_moderation_write', 'on', true);
  update public.workout_posts set deleted_at = now() where author_id = auth.uid();
  perform set_config('app.allow_moderation_write', 'off', true);
end $$;
revoke all on function public.request_account_deletion() from public, anon;
grant execute on function public.request_account_deletion() to authenticated;

-- admin_remove_member(): same pin around its target-posts UPDATE.
create or replace function public.admin_remove_member(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and is_admin and deleted_at is null) then
    raise exception 'not authorized';
  end if;
  if p_user_id = auth.uid() then raise exception 'use account deletion for your own account'; end if;
  insert into public.account_deletion_requests(user_id) values (p_user_id)
    on conflict (user_id) do update set requested_at = now(), purge_after = now() + interval '30 days';
  update public.profiles set deleted_at = now() where id = p_user_id;
  perform set_config('app.allow_moderation_write', 'on', true);
  update public.workout_posts set deleted_at = now() where author_id = p_user_id;
  perform set_config('app.allow_moderation_write', 'off', true);
end $$;
revoke all on function public.admin_remove_member(uuid) from public, anon;
grant execute on function public.admin_remove_member(uuid) to authenticated;

-- =====================================================================
-- 3. Un-numbered finding - a member could hard-DELETE their own post via
--    the raw table grant, cascading away any report filed against it.
--    post_delete() (above) is the sole sanctioned removal path and it is
--    UPDATE-only (soft delete), so the DELETE grant/policy is legacy from
--    before that RPC existed and nothing legitimate needs it.
-- =====================================================================

drop policy if exists posts_delete_self on public.workout_posts;
revoke delete on public.workout_posts from authenticated;

-- =====================================================================
-- 4. DB audit (HIGH) - schedule purge_due_accounts(), and stop a single
--    unrelated FK from silently blocking the whole purge batch.
-- =====================================================================

-- created_by is NOT NULL with no ON DELETE today; the invite record should
-- outlive the admin who issued it, so this nullifies the attribution
-- instead of either blocking deletion (current behaviour) or cascading
-- away the invite (which would also delete a still-valid, still-in-use
-- code). revoked_by/redeemed_by are already nullable. The table is named
-- public.invites (202609030001) - "person_invites" is that migration's
-- filename slug, not the table name; a first draft of this migration got
-- that wrong and would have failed outright on `alter table
-- public.person_invites`, which does not exist.
alter table public.invites alter column created_by drop not null;
alter table public.invites drop constraint if exists invites_created_by_fkey;
alter table public.invites add constraint invites_created_by_fkey
  foreign key (created_by) references auth.users(id) on delete set null;

alter table public.invites drop constraint if exists invites_revoked_by_fkey;
alter table public.invites add constraint invites_revoked_by_fkey
  foreign key (revoked_by) references auth.users(id) on delete set null;

alter table public.invites drop constraint if exists invites_redeemed_by_fkey;
alter table public.invites add constraint invites_redeemed_by_fkey
  foreign key (redeemed_by) references auth.users(id) on delete set null;

alter table public.onboarding_step_content drop constraint if exists onboarding_step_content_updated_by_fkey;
alter table public.onboarding_step_content add constraint onboarding_step_content_updated_by_fkey
  foreign key (updated_by) references auth.users(id) on delete set null;

alter table public.intro_carousel_content drop constraint if exists intro_carousel_content_updated_by_fkey;
alter table public.intro_carousel_content add constraint intro_carousel_content_updated_by_fkey
  foreign key (updated_by) references auth.users(id) on delete set null;

-- Found while fixing the above (DATABASE_AUDIT.md DB-M3): reports.reviewed_by
-- references public.profiles(id) with no ON DELETE either
-- (202608270006_security_hardening.sql:225) - and profiles itself cascades
-- from auth.users, so a purged member who ever reviewed ANY report would
-- have blocked that same purge batch one join further out than the direct
-- auth.users FKs above. coach_engagement_flags.reviewed_by already got
-- ON DELETE SET NULL (202608280011); this gives reports.reviewed_by the
-- same treatment for the same reason - a review record should outlive the
-- reviewer's account.
alter table public.reports drop constraint if exists reports_reviewed_by_fkey;
alter table public.reports add constraint reports_reviewed_by_fkey
  foreign key (reviewed_by) references public.profiles(id) on delete set null;

-- With every FK to auth.users now carrying an explicit ON DELETE action,
-- there is no remaining schema-level way for one row to block
-- purge_due_accounts()'s bulk DELETE, so the function is unchanged below -
-- only its schedule was ever missing.
select cron.schedule('purge-due-accounts', '59 3 * * *',
  $$select public.purge_due_accounts()$$);

comment on function public.purge_due_accounts() is
  'Launch-readiness audit. Executes the 30-day account-erasure promise in PRIVACY.md: hard-deletes every auth.users row whose account_deletion_requests.purge_after has passed, cascading through every FK that references it. Scheduled daily at 03:59 UTC by 202609060011 (cron.schedule ''purge-due-accounts'') - it existed since 202608260001 but was never given a schedule entry when 202609050005 wired the other six jobs, so no account was ever actually purged. Runs as service_role via pg_cron; the browser can never call it directly (revoked from public, anon, authenticated).';

commit;
