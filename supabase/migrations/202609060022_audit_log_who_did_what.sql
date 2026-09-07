begin;

-- Five-persona UX audit, defect 2 (LAUNCH BLOCKER): the audit log cannot
-- answer "who did what".
--
-- WHAT WAS OBSERVED. A real moderation decision was taken and the only
-- durable record of it reads:
--
--     מנהל/ת f70f95f5 · לפני 3 דקות
--
-- - the first eight characters of a uuid, a relative timestamp, and nothing
-- else. No admin name. No indication of WHO it was done to. No indication of
-- WHICH decision was taken. No note. An audit log exists to review, defend
-- and reverse a decision, and none of those three is possible from that row.
--
-- WHY THE ROW IS THAT THIN. admin_actions (202608280002) stores admin_id,
-- action_type, target_type, target_id, before_data, after_data, created_at.
-- Everything the reader needs is either absent or buried:
--   * admin_id is a bare uuid. profiles is NOT joinable from the audit
--     screen, and deliberately: the table has no FK to profiles so an audit
--     row outlives the account that produced it, which also means a join
--     resolves to nothing for exactly the admin most worth identifying.
--   * target_id is a bare uuid of a POST or a COMMENT or a REPORT. The
--     member the action landed on - the fact any review starts from - is one
--     to two joins away and is not recorded at all.
--   * The specific decision was stored only inside after_data for ONE writer
--     (mod_review's 'decision' key) and nowhere at all for the others.
--     comment_moderate is the sharpest case: it logs action_type
--     'content_delete' for BOTH 'remove' and 'restore', so the log cannot
--     distinguish taking a comment down from putting it back.
--   * The moderator's note - which mod_review, mod_restrict_member and
--     mod_lift_restriction all already collect, and which is the entire
--     justification for the decision - never reached admin_actions.
--
-- THE FIX HAS THREE PARTS.
--
-- 1. FIVE COLUMNS on admin_actions, all nullable, no default: admin_display,
--    target_user_id, target_display, action_detail, note.
--
-- 2. THE RESOLUTION HAPPENS IN THE WRITER, ONCE. log_admin_action() gains
--    three optional parameters and fills admin_display, target_user_id and
--    target_display ITSELF for every caller. There are ~40 log_admin_action
--    call sites across 20 migrations; making each one resolve identities by
--    hand would have been 40 chances to disagree about what a display name
--    is. Every existing caller therefore gains a named admin and a resolved
--    target with no edit at all, and only the writers that have a DECISION
--    or a NOTE to record are touched below.
--
-- 3. admin_display IS A SNAPSHOT, NOT A JOIN. It is resolved at write time
--    and frozen. This is the same reasoning that kept admin_id from being a
--    foreign key: the row must still name its actor after the actor's
--    account is gone, and a decision must be defensible under the name the
--    person was actually using when they took it, not the name they use now.
--
-- BACKWARD COMPATIBILITY. No existing signature changes. log_admin_action's
-- three new parameters are defaulted and it is not client-callable in any
-- case. admin_actions_page() keeps its exact signature and its `setof
-- public.admin_actions` return type, so the five columns simply appear in
-- the rows cloud.js already receives - nothing breaks if the client renderer
-- is updated later, or never.
--
-- ONE NEW action_type LABEL: 'member_remove'. admin_remove_member() soft
-- deletes a member's profile AND every post they ever wrote and, until this
-- migration, wrote no audit row whatsoever. That is the single most
-- destructive staff action in the module and it was completely untracked.

-- ===========================================================================
-- 1. The columns
-- ===========================================================================
alter table public.admin_actions
  add column if not exists admin_display text
    check (admin_display is null or char_length(admin_display) <= 160),
  add column if not exists target_user_id uuid,
  add column if not exists target_display text
    check (target_display is null or char_length(target_display) <= 160),
  add column if not exists action_detail text
    check (action_detail is null or char_length(action_detail) <= 80),
  add column if not exists note text
    check (note is null or char_length(note) <= 1000);

-- Deliberately NOT a foreign key to profiles, for admin_id's own reason
-- (202608280002): the audit row has to outlive the account it points at.
create index if not exists admin_actions_target_user_idx
  on public.admin_actions(target_user_id, created_at desc)
  where target_user_id is not null;

comment on column public.admin_actions.admin_display is
  'The acting admin''s display identity AS IT WAS when the action was taken - display name, else @handle, else null. A snapshot, never a join: admin_id has no FK to profiles precisely so the row outlives the account, and a decision must stay defensible under the name its author was actually using. Rows written before 202609060022 carry a value resolved ONCE during that migration from profiles as they read at that moment, which is a late resolution of a real identity, not a snapshot - and null where the account was already gone.';
comment on column public.admin_actions.target_user_id is
  'The MEMBER the action landed on, when there is one. Filled by log_admin_action() from the target itself: target_id for a member target, the author for a post or comment, the reported content''s author (or the reported member) for a report. Null for a club, challenge, invite or onboarding target, which have no member. No FK, for admin_id''s reason.';
comment on column public.admin_actions.target_display is
  'target_user_id''s display identity, snapshot at write time, same rule and same caveat as admin_display.';
comment on column public.admin_actions.action_detail is
  'WHICH action was chosen, inside the broader action_type: mod_review''s decision (remove | warn | restrict_temp | restrict_permanent | dismiss), comment_moderate''s remove | restore (which action_type alone cannot distinguish - both log content_delete), the granted role for a role_change, temporary | permanent for a restriction. Free text, capped at 80. Null where the action_type is already total.';
comment on column public.admin_actions.note is
  'The acting admin''s own free-text justification, capped at 1000 - the moderator note that mod_review, mod_restrict_member and mod_lift_restriction already collected and that never reached this table. Null when none was given.';

-- ---------------------------------------------------------------------------
-- The one-time backfill.
-- ---------------------------------------------------------------------------
-- Every statement below RESTATES a value the row already carries or resolves
-- an identity the row already points at. Nothing is inferred, guessed or
-- invented, and nothing that cannot be derived from the existing row is
-- filled - a pre-existing row with no decision recorded keeps a null
-- action_detail rather than acquiring a plausible one.
update public.admin_actions a
   set admin_display = coalesce(nullif(btrim(p.display_name), ''), '@' || p.handle)
  from public.profiles p
 where p.id = a.admin_id and a.admin_display is null;

update public.admin_actions a
   set target_user_id = a.target_id
 where a.target_type = 'member' and a.target_id is not null and a.target_user_id is null;

update public.admin_actions a
   set target_display = coalesce(nullif(btrim(p.display_name), ''), '@' || p.handle)
  from public.profiles p
 where p.id = a.target_user_id and a.target_display is null;

-- mod_review has always written its decision into after_data; role_change
-- has always written the new role there. Both are lifted into the column
-- that now owns them. No other action_type stored a decision anywhere, so
-- no other action_type gets one.
update public.admin_actions
   set action_detail = left(after_data ->> 'decision', 80)
 where action_type = 'report_review' and action_detail is null
   and coalesce(after_data ->> 'decision', '') <> '';

update public.admin_actions
   set action_detail = left(after_data ->> 'role', 80)
 where action_type = 'role_change' and action_detail is null
   and coalesce(after_data ->> 'role', '') <> '';

update public.admin_actions
   set action_detail = left(after_data ->> 'restriction_type', 80)
 where action_type = 'member_restrict' and action_detail is null
   and coalesce(after_data ->> 'restriction_type', '') <> '';

update public.admin_actions
   set note = left(after_data ->> 'reason', 1000)
 where action_type = 'member_restrict' and note is null
   and coalesce(after_data ->> 'reason', '') <> '';

update public.admin_actions
   set note = left(after_data ->> 'lift_reason', 1000)
 where action_type = 'member_unrestrict' and note is null
   and coalesce(after_data ->> 'lift_reason', '') <> '';

-- The new label. Restated in full, the module's convention for this
-- constraint (nine migrations have widened it the same way).
alter table public.admin_actions drop constraint if exists admin_actions_action_type_check;
alter table public.admin_actions add constraint admin_actions_action_type_check check (action_type in (
  'content_delete', 'content_hide', 'member_restrict', 'member_unrestrict',
  'role_change', 'challenge_edit', 'achievement_edit', 'privacy_config',
  'content_pin', 'content_unpin', 'report_review', 'member_of_week_publish',
  'monthly_recap_publish', 'club_feature_toggle', 'invite_created',
  'invite_revoked', 'shared_code_created', 'shared_code_status_changed',
  'onboarding_content_updated', 'member_password_reset', 'announcement_edit',
  'member_remove'
));

-- ===========================================================================
-- 2. Identity resolution, in one place
-- ===========================================================================
-- Display name first, @handle second, null third - the same order
-- mod_queue's content_author_name and the roster already use, so the audit
-- screen and the moderation queue cannot name one member two ways.
--
-- SECURITY DEFINER with NO GRANT TO ANY CLIENT ROLE. It reads profiles past
-- profiles_read_authenticated, which is the whole point (a soft-deleted or
-- blocked admin must still resolve inside the log), and that is exactly why
-- it must never be callable directly - granted to `authenticated` it would
-- be a uuid-to-name oracle over every member in the club, blocks and
-- visible_to_club included. Only log_admin_action() calls it.
create or replace function public.audit_identity_label(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select left(coalesce(nullif(btrim(pf.display_name), ''), '@' || pf.handle), 160)
  from public.profiles pf
  where pf.id = p_user;
$$;
revoke all on function public.audit_identity_label(uuid) from public, anon, authenticated;

comment on function public.audit_identity_label(uuid) is
  'Internal. One member id to one human label: display_name, else @handle, else null for an unknown or already-purged account. SECURITY DEFINER so it resolves past profiles_read_authenticated - a soft-deleted or blocked admin must still be nameable inside the audit log - and therefore granted to NO client role: exposed, it would be a uuid-to-display-name oracle over the whole club. Only log_admin_action() calls it.';

-- ===========================================================================
-- 3. log_admin_action(), the single write path, now recording identity
-- ===========================================================================
-- Signature grows by three DEFAULTED parameters, so every one of the ~40
-- existing 3-, 4- and 5-argument call sites keeps working untouched and
-- gains admin_display, target_user_id and target_display for free. plpgsql
-- resolves a called function by name at runtime, so dropping the old
-- 5-argument form below cannot break a caller's stored body.
--
-- p_target_user_id is an OVERRIDE, not a requirement: a caller that already
-- holds the affected member (mod_review has resolved the content author
-- before it decides anything) passes it and saves the lookup; every caller
-- that does not gets the same answer derived here.
--
-- The derivation is deliberately total over the target types that HAVE a
-- member behind them and silent for the ones that do not - a club feature
-- toggle or an onboarding copy edit has no target member, and inventing one
-- would be worse than leaving it null.
create or replace function public.log_admin_action(
  p_action_type text,
  p_target_type text,
  p_target_id uuid default null,
  p_before jsonb default null,
  p_after jsonb default null,
  p_action_detail text default null,
  p_note text default null,
  p_target_user_id uuid default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_target_user uuid;
  v_rep_type text;
  v_rep_id uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if p_before is not null and pg_column_size(p_before) > 8192 then
    raise exception 'before_data exceeds 8 KB';
  end if;
  if p_after is not null and pg_column_size(p_after) > 8192 then
    raise exception 'after_data exceeds 8 KB';
  end if;

  v_target_user := p_target_user_id;

  if v_target_user is null and p_target_id is not null then
    if p_target_type = 'member' then
      v_target_user := p_target_id;
    elsif p_target_type = 'post' then
      select w.author_id into v_target_user from public.workout_posts w where w.id = p_target_id;
    elsif p_target_type = 'comment' then
      select c.author_id into v_target_user from public.post_comments c where c.id = p_target_id;
    elsif p_target_type = 'report' then
      -- One extra hop, and the one that matters most: a report_review row's
      -- target_id is the REPORT, so without this the single most reviewed
      -- action type in the log never names the member it was about.
      select r.target_type, r.target_id into v_rep_type, v_rep_id
      from public.reports r where r.id = p_target_id;
      if v_rep_type = 'post' then
        select w.author_id into v_target_user from public.workout_posts w where w.id = v_rep_id;
      elsif v_rep_type = 'comment' then
        select c.author_id into v_target_user from public.post_comments c where c.id = v_rep_id;
      elsif v_rep_type = 'profile' then
        v_target_user := v_rep_id;
      end if;
    end if;
  end if;

  insert into public.admin_actions (
    admin_id, action_type, target_type, target_id, before_data, after_data,
    admin_display, target_user_id, target_display, action_detail, note)
  values (
    v_uid, p_action_type, p_target_type, p_target_id, p_before, p_after,
    public.audit_identity_label(v_uid),
    v_target_user,
    public.audit_identity_label(v_target_user),
    nullif(left(btrim(coalesce(p_action_detail, '')), 80), ''),
    nullif(left(btrim(coalesce(p_note, '')), 1000), ''));
end $$;
revoke all on function public.log_admin_action(text, text, uuid, jsonb, jsonb, text, text, uuid)
  from public, anon, authenticated;

-- Exactly one log_admin_action, the same discipline 202609060014 applied to
-- post_create: leaving the 5-argument form alive would leave a write path
-- that records no identity, and every 5-argument call resolves to the new
-- function with the three new parameters defaulted.
drop function if exists public.log_admin_action(text, text, uuid, jsonb, jsonb);

comment on function public.log_admin_action(text, text, uuid, jsonb, jsonb, text, text, uuid) is
  'COMM-009, extended by the five-persona UX audit (defect 2). The ONE write path into admin_actions; granted to no role, so a client can never forge or amend a row and the log stays append-only for everyone including admins. Called from inside another SECURITY DEFINER function immediately before it returns, so a failed log fails the whole action. Params: p_action_type, p_target_type, p_target_id, p_before, p_after (each blob capped at 8 KB, P0001 ''before_data exceeds 8 KB'' / ''after_data exceeds 8 KB''), and the three added here, all optional - p_action_detail (WHICH action was chosen, trimmed to 80), p_note (the admin''s justification, trimmed to 1000), p_target_user_id (an override for callers that already hold the affected member). Fills three fields ITSELF for every caller, old and new: admin_display and target_display through audit_identity_label() as SNAPSHOTS at write time, and target_user_id derived from the target - target_id for a member, the author for a post or a comment, and for a report the reported content''s author or the reported member. Null target_user_id for targets that have no member behind them (club, challenge, invite, onboarding_step). Raises ''not authorized'' when auth.uid() is null.';

-- ===========================================================================
-- 4. admin_actions_page(): one filter added, signature untouched
-- ===========================================================================
-- Same signature, same `setof public.admin_actions` return type, so the five
-- new columns reach cloud.js with no client change at all. The added
-- p_filters key is target_user_id, because the question a review actually
-- starts from is "everything ever done to this member", and until now the
-- only filters were action_type and admin_id - "everything this admin did",
-- never "everything done to this person".
create or replace function public.admin_actions_page(
  p_cursor timestamptz default null,
  p_limit integer default 25,
  p_filters jsonb default '{}'::jsonb
) returns setof public.admin_actions
language plpgsql stable security invoker set search_path = '' as $$
declare v_limit integer;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if not public.has_perm('community.analytics.view') then raise exception 'not authorized'; end if;
  v_limit := least(greatest(coalesce(p_limit, 25), 1), 100);
  return query
    select a.* from public.admin_actions a
    where (p_cursor is null or a.created_at < p_cursor)
      and (coalesce(p_filters ->> 'action_type', '') = '' or a.action_type = p_filters ->> 'action_type')
      and (coalesce(p_filters ->> 'admin_id', '') = '' or a.admin_id = (p_filters ->> 'admin_id')::uuid)
      and (coalesce(p_filters ->> 'target_user_id', '') = '' or a.target_user_id = (p_filters ->> 'target_user_id')::uuid)
    order by a.created_at desc
    limit v_limit;
end $$;
revoke all on function public.admin_actions_page(timestamptz, integer, jsonb) from public, anon;
grant execute on function public.admin_actions_page(timestamptz, integer, jsonb) to authenticated;

comment on function public.admin_actions_page(timestamptz, integer, jsonb) is
  'COMM-009. One page of the admin audit log, newest first, cursor-paginated on created_at. AUTH: security invoker; auth.uid() first, then has_perm(''community.analytics.view''), and the admin_actions_read_analytics policy underneath it. p_limit clamped 1..100. p_filters accepts action_type, admin_id and - added by the five-persona UX audit - target_user_id, which is what "show me everything ever done to this member" needs. RETURNS setof public.admin_actions, so it carries the identity columns added in 202609060022 (admin_display, target_user_id, target_display, action_detail, note) with no signature change. Read-only.';

-- ===========================================================================
-- 5. The writers that have a decision or a note to record
-- ===========================================================================
-- Every function below is byte-identical to its live definition except for
-- the arguments added to its log_admin_action() call. Recreated in full
-- because that is the only form Postgres offers. No signature changes, so
-- no cloud.js call site moves.

-- mod_review: the decision and the note the audit was actually missing.
create or replace function public.mod_review(
  p_report_id uuid,
  p_decision text,
  p_note text,
  p_expires_at timestamptz default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_rep public.reports;
  v_tt text;
  v_tid uuid;
  v_author uuid;
  v_before_status text;
  v_new_status text;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not (public.has_perm('community.comment.moderate')
          or exists (select 1 from public.profiles where id = v_uid and is_admin and deleted_at is null)) then
    raise exception 'not authorized';
  end if;
  if p_decision not in ('remove', 'warn', 'restrict_temp', 'restrict_permanent', 'dismiss') then
    raise exception 'unknown decision %', p_decision;
  end if;

  select * into v_rep from public.reports where id = p_report_id;
  if not found then raise exception 'report not found'; end if;
  v_tt := v_rep.target_type;
  v_tid := v_rep.target_id;
  v_before_status := v_rep.status::text;

  if v_tt = 'post' then
    select author_id into v_author from public.workout_posts where id = v_tid;
  elsif v_tt = 'profile' then
    -- A profile is its own author, so restrict_temp / restrict_permanent act
    -- on the reported member. Resolved through profiles rather than assigned
    -- blindly so a member deleted between report and review still lands on the
    -- existing 'content author is no longer available' path below.
    select id into v_author from public.profiles where id = v_tid and deleted_at is null;
  else
    select author_id into v_author from public.post_comments where id = v_tid;
  end if;

  if p_decision = 'remove' then
    if v_tt = 'post' then
      perform public.post_delete(v_tid);
    elsif v_tt = 'profile' then
      -- Named refusal rather than a silent no-op or a misleading 'comment not
      -- found'. A profile report has nothing to take down; restrict_temp,
      -- restrict_permanent and dismiss are its real decisions.
      raise exception 'a profile report has no content to remove';
    else
      perform public.comment_moderate(v_tid, 'remove');
    end if;
  elsif p_decision = 'restrict_temp' then
    if v_author is null then raise exception 'content author is no longer available'; end if;
    perform public.mod_restrict_member(v_author, 'temporary', p_expires_at, p_note, p_report_id);
  elsif p_decision = 'restrict_permanent' then
    if v_author is null then raise exception 'content author is no longer available'; end if;
    perform public.mod_restrict_member(v_author, 'permanent', null, p_note, p_report_id);
  end if;

  v_new_status := case when p_decision = 'dismiss' then 'dismissed' else 'action_taken' end;

  update public.reports
    set status = v_new_status::public.report_status,
        reviewed_by = v_uid,
        reviewed_at = now(),
        review_note = left(coalesce(p_note, ''), 500)
  where target_type = v_tt and target_id = v_tid;

  -- v_author is passed explicitly rather than left to log_admin_action's own
  -- derivation: it is already resolved here, and for a 'remove' decision the
  -- post it would have been derived from is soft-deleted by the time this
  -- line runs.
  perform public.log_admin_action(
    'report_review', 'report', p_report_id,
    jsonb_build_object('status', v_before_status),
    jsonb_build_object('status', v_new_status, 'decision', p_decision),
    p_decision, p_note, v_author
  );
end $$;
revoke all on function public.mod_review(uuid, text, text, timestamptz) from public, anon;
grant execute on function public.mod_review(uuid, text, text, timestamptz) to authenticated;

-- comment_moderate: the one writer whose action_type genuinely could not
-- tell its two decisions apart. Both branches logged 'content_delete'; the
-- restore branch now says so in action_detail.
create or replace function public.comment_moderate(p_comment_id uuid, p_action text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_row public.post_comments;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if p_action not in ('remove', 'restore') then
    raise exception 'unknown action %', p_action;
  end if;
  if not (public.has_perm('community.comment.moderate')
          or exists (select 1 from public.profiles where id = v_uid and is_admin and deleted_at is null)) then
    raise exception 'not authorized';
  end if;

  select * into v_row from public.post_comments where id = p_comment_id;
  if not found then raise exception 'comment not found'; end if;

  if p_action = 'remove' then
    if v_row.status = 'removed' and v_row.deleted_at is not null then return; end if;
    update public.post_comments
      set status = 'removed', deleted_at = now(), deleted_by = v_uid
    where id = p_comment_id;
    perform public.log_admin_action(
      'content_delete', 'comment', p_comment_id,
      jsonb_build_object('status', v_row.status::text),
      jsonb_build_object('status', 'removed'),
      'remove', null, v_row.author_id
    );
  else
    if v_row.status = 'active' and v_row.deleted_at is null then return; end if;
    update public.post_comments
      set status = 'active', deleted_at = null, deleted_by = null
    where id = p_comment_id;
    perform public.log_admin_action(
      'content_delete', 'comment', p_comment_id,
      jsonb_build_object('status', v_row.status::text),
      jsonb_build_object('status', 'active'),
      'restore', null, v_row.author_id
    );
  end if;
end $$;
revoke all on function public.comment_moderate(uuid, text) from public, anon;
grant execute on function public.comment_moderate(uuid, text) to authenticated;

-- post_delete: the author is passed explicitly because the row is already
-- soft-deleted when the log line runs, and it is the whole point of the
-- entry - a removal that does not say whose post it was is not reviewable.
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
      jsonb_build_object('status', 'removed'),
      'remove', null, v_row.author_id
    );
  end if;
end $$;
revoke all on function public.post_delete(uuid) from public, anon;
grant execute on function public.post_delete(uuid) to authenticated;

-- mod_restrict_member / mod_lift_restriction: both already collected a
-- reason and threw it away at the audit boundary.
create or replace function public.mod_restrict_member(
  p_user uuid,
  p_type text,
  p_expires_at timestamptz default null,
  p_reason text default '',
  p_report_id uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_id uuid;
  v_expires timestamptz;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.has_perm('community.member.restrict') then raise exception 'not authorized'; end if;
  if p_user is null then raise exception 'target member required'; end if;
  if p_user = v_uid then raise exception 'cannot restrict yourself'; end if;
  if p_type not in ('temporary', 'permanent') then
    raise exception 'unknown restriction type %', p_type;
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_user and p.deleted_at is null) then
    raise exception 'member not found';
  end if;

  -- A permanent restriction ignores any expiry the caller passed rather
  -- than rejecting it, so a UI that always sends the date picker value
  -- cannot accidentally create a row the CHECK refuses.
  v_expires := case when p_type = 'temporary' then p_expires_at else null end;
  if p_type = 'temporary' and (v_expires is null or v_expires <= now()) then
    raise exception 'a temporary restriction needs an end time in the future';
  end if;

  insert into public.posting_restrictions
    (user_id, restriction_type, expires_at, reason, moderator_id, source_report_id)
  values
    (p_user, p_type, v_expires, left(coalesce(p_reason, ''), 500), v_uid, p_report_id)
  returning id into v_id;

  perform public.log_admin_action(
    'member_restrict', 'member', p_user,
    null,
    jsonb_build_object(
      'restriction_id', v_id,
      'restriction_type', p_type,
      'expires_at', v_expires,
      'reason', left(coalesce(p_reason, ''), 500),
      'source_report_id', p_report_id
    ),
    p_type, p_reason, p_user
  );
  return v_id;
end $$;
revoke all on function public.mod_restrict_member(uuid, text, timestamptz, text, uuid) from public, anon;
grant execute on function public.mod_restrict_member(uuid, text, timestamptz, text, uuid) to authenticated;

create or replace function public.mod_lift_restriction(p_restriction_id uuid, p_reason text default '')
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_row public.posting_restrictions;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.has_perm('community.member.restrict') then raise exception 'not authorized'; end if;

  select * into v_row from public.posting_restrictions where id = p_restriction_id;
  if not found then raise exception 'restriction not found'; end if;
  if v_row.lifted_at is not null then return; end if;

  update public.posting_restrictions
    set lifted_at = now(), lifted_by = v_uid, lift_reason = left(coalesce(p_reason, ''), 500)
  where id = p_restriction_id;

  perform public.log_admin_action(
    'member_unrestrict', 'member', v_row.user_id,
    jsonb_build_object(
      'restriction_id', v_row.id,
      'restriction_type', v_row.restriction_type,
      'expires_at', v_row.expires_at
    ),
    jsonb_build_object(
      'restriction_id', v_row.id,
      'lifted_at', now(),
      'lift_reason', left(coalesce(p_reason, ''), 500)
    ),
    'lift', p_reason, v_row.user_id
  );
end $$;
revoke all on function public.mod_lift_restriction(uuid, text) from public, anon;
grant execute on function public.mod_lift_restriction(uuid, text) to authenticated;

-- The role changes: which role, not just "a role changed".
create or replace function public.admin_grant_coach(p_user_id uuid, p_role text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_before text;
begin
  v_uid := auth.uid();
  if not exists (select 1 from public.profiles where id = v_uid and is_admin and deleted_at is null) then
    raise exception 'not authorized';
  end if;
  -- Phase 1 exposes coach and head_coach only. staff and owner are modelled
  -- server-side but are not grantable through this path.
  if p_role not in ('coach', 'head_coach') then
    raise exception 'role % cannot be granted here', p_role;
  end if;

  select role into v_before from public.invite_redemptions where user_id = p_user_id;
  update public.invite_redemptions set role = p_role where user_id = p_user_id;
  if not found then
    raise exception 'user must redeem a member invite before coach access is granted';
  end if;

  perform public.log_admin_action(
    'role_change', 'member', p_user_id,
    jsonb_build_object('role', v_before),
    jsonb_build_object('role', p_role),
    p_role, null, p_user_id
  );
end $$;
revoke all on function public.admin_grant_coach(uuid, text) from public, anon;
grant execute on function public.admin_grant_coach(uuid, text) to authenticated;

create or replace function public.admin_revoke_coach(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_before text;
begin
  v_uid := auth.uid();
  if not exists (select 1 from public.profiles where id = v_uid and is_admin and deleted_at is null) then
    raise exception 'not authorized';
  end if;
  select role into v_before from public.invite_redemptions where user_id = p_user_id;
  update public.invite_redemptions set role = 'member' where user_id = p_user_id;
  if v_before is null or v_before = 'member' then return; end if;
  perform public.log_admin_action(
    'role_change', 'member', p_user_id,
    jsonb_build_object('role', v_before),
    jsonb_build_object('role', 'member'),
    'member', null, p_user_id
  );
end $$;
revoke all on function public.admin_revoke_coach(uuid) from public, anon;
grant execute on function public.admin_revoke_coach(uuid) to authenticated;

-- admin_remove_member: the destructive action that had NO audit row at all.
-- Body otherwise unchanged, including the moderation-write pin.
create or replace function public.admin_remove_member(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_posts integer;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and is_admin and deleted_at is null) then
    raise exception 'not authorized';
  end if;
  if p_user_id = auth.uid() then raise exception 'use account deletion for your own account'; end if;
  insert into public.account_deletion_requests(user_id) values (p_user_id)
    on conflict (user_id) do update set requested_at = now(), purge_after = now() + interval '30 days';
  update public.profiles set deleted_at = now() where id = p_user_id;
  perform set_config('app.allow_moderation_write', 'on', true);
  with removed as (
    update public.workout_posts set deleted_at = now() where author_id = p_user_id returning 1
  ) select count(*) into v_posts from removed;
  perform set_config('app.allow_moderation_write', 'off', true);

  -- Logged AFTER the writes, like every other writer here, so a failed
  -- removal leaves no audit row claiming it happened. The identity snapshot
  -- is taken by log_admin_action() from the profile that was just soft
  -- deleted, which still resolves: audit_identity_label() reads past
  -- profiles_read_authenticated by design.
  perform public.log_admin_action(
    'member_remove', 'member', p_user_id,
    null,
    jsonb_build_object('posts_removed', v_posts, 'purge_after', now() + interval '30 days'),
    'remove', null, p_user_id
  );
end $$;
revoke all on function public.admin_remove_member(uuid) from public, anon;
grant execute on function public.admin_remove_member(uuid) to authenticated;

comment on function public.admin_remove_member(uuid) is
  'COMM. An admin removes another member: an immediate soft delete of the profile and of every post they authored, plus a 30-day scheduled purge - the same effect request_account_deletion() has, triggered by staff instead. AUTH: security definer, inline profiles.is_admin check; raises ''not authorized'', and ''use account deletion for your own account'' for self. SIDE EFFECTS: one account_deletion_requests row (upserted), profiles.deleted_at set, every workout_posts row by that author soft deleted, and - added by the five-persona UX audit, defect 2 - ONE admin_actions row (member_remove / member / target_id = the removed member), which this function did not write at all before. after_data carries posts_removed and purge_after.';

-- review_report: the legacy report path, which wrote NO audit row at all.
-- It is superseded by mod_review for the client, but it is still granted to
-- authenticated and still resolves reports, so an admin can move a report
-- through it and leave no trace. Body otherwise unchanged.
create or replace function public.review_report(
  p_report_id uuid, p_status public.report_status, p_resolution_notes text default ''
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_before text;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and is_admin and deleted_at is null) then
    raise exception 'not authorized';
  end if;
  if p_status = 'open' then raise exception 'review transition must move the report out of open'; end if;
  select status::text into v_before from public.reports where id = p_report_id;
  update public.reports set status = p_status,
    resolution_notes = left(coalesce(p_resolution_notes, ''), 1000),
    reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_report_id;
  if not found then raise exception 'report not found'; end if;

  perform public.log_admin_action(
    'report_review', 'report', p_report_id,
    jsonb_build_object('status', v_before),
    jsonb_build_object('status', p_status::text),
    p_status::text, p_resolution_notes, null
  );
end $$;
revoke all on function public.review_report(uuid, public.report_status, text) from public, anon;
grant execute on function public.review_report(uuid, public.report_status, text) to authenticated;

comment on function public.review_report(uuid, public.report_status, text) is
  'The Phase 0 report-review transition, superseded for the client by mod_review() but still granted to authenticated and still able to resolve a report. AUTH: security definer, inline profiles.is_admin check. Raises ''not authorized'', ''review transition must move the report out of open'' and ''report not found''. Sets reports.status / resolution_notes / reviewed_by / reviewed_at for the ONE named report (mod_review stamps the whole target group instead). SIDE EFFECT added by the five-persona UX audit, defect 2: one report_review admin_actions row, with the new status as action_detail and the resolution notes as note. Before this it wrote no audit row at all, so this path could resolve a report invisibly.';

-- Pins: the note staff already type when pinning.
create or replace function public.pin_set(p_target_type text, p_target_id uuid, p_note text default '')
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_club uuid;
  v_slot smallint;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.has_perm('community.content.pin') then raise exception 'not authorized'; end if;
  if p_target_type not in ('announcement', 'challenge', 'event', 'post') then
    raise exception 'unknown pin target type %', p_target_type;
  end if;
  if p_target_id is null then raise exception 'pin target required'; end if;

  v_club := public.default_club_id();

  -- Serialises slot selection so two staff pinning at the same moment get a
  -- clean "already three pinned" instead of a raw unique violation. The
  -- unique constraint is still the real guarantee; this only makes the
  -- error message honest.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('community.pins'));

  if exists (
    select 1 from public.pins
    where club_id = v_club and target_type = p_target_type and target_id = p_target_id
  ) then
    return;
  end if;

  select pg_catalog.min(s)::smallint into v_slot
  from pg_catalog.generate_series(0, 2) s
  where not exists (select 1 from public.pins p where p.club_id = v_club and p.slot = s);
  if v_slot is null then raise exception 'pin_limit_reached'; end if;

  insert into public.pins (club_id, target_type, target_id, slot, pinned_by, note)
  values (v_club, p_target_type, p_target_id, v_slot, v_uid, left(coalesce(p_note, ''), 200));

  perform public.log_admin_action(
    'content_pin', p_target_type, p_target_id,
    null,
    jsonb_build_object('slot', v_slot, 'note', left(coalesce(p_note, ''), 200)),
    'slot ' || v_slot::text, p_note, null
  );
end $$;
revoke all on function public.pin_set(text, uuid, text) from public, anon;
grant execute on function public.pin_set(text, uuid, text) to authenticated;

create or replace function public.pin_clear(p_target_type text, p_target_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_row public.pins;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.has_perm('community.content.pin') then raise exception 'not authorized'; end if;

  select * into v_row from public.pins
  where club_id = public.default_club_id()
    and target_type = p_target_type and target_id = p_target_id;
  -- Unpinning something already unpinned is a no-op, not an error, so a
  -- double tap does not surface a failure to a member of staff.
  if not found then return; end if;

  delete from public.pins where id = v_row.id;

  perform public.log_admin_action(
    'content_unpin', p_target_type, p_target_id,
    jsonb_build_object('slot', v_row.slot, 'note', v_row.note),
    null,
    'slot ' || v_row.slot::text, v_row.note, null
  );
end $$;
revoke all on function public.pin_clear(text, uuid) from public, anon;
grant execute on function public.pin_clear(text, uuid) to authenticated;

commit;
