begin;

-- COMM-150..156, the moderation reshape. Reads the columns and the enum label
-- added in 202608280024.
--
-- Shipped here:
--   * report(p_target_type, p_target_id, p_reason, p_note) - supersedes
--     submit_report(p_post_id, p_reason), which stays as a thin wrapper.
--   * post_delete(post_id) - the trusted post-removal path, for the author's
--     own menu action and for a moderator. Did not exist; mod_review's remove
--     decision needs it and cloud.js already calls it directly.
--   * comment_moderate(p_comment_id, p_action) - the comment equivalent.
--   * mod_queue_item + mod_queue(p_status, p_cursor, p_limit) - one row per
--     reported item.
--   * mod_review(p_report_id, p_decision, p_note, p_expires_at) - the trusted
--     status transition plus the decision side effects.
--   * admin_grant_coach(p_user_id, p_role) - the two-argument form, plus an
--     audit row on both grant paths and on admin_revoke_coach.
--
-- The moderation gate throughout is has_perm('community.comment.moderate') OR
-- real is_admin (the profiles.is_admin column, matching the
-- posts_select_admin_review bypass). That is wider than "real is_admin" so a
-- head_coach who can see the queue can also act on it, which COMM-152/153
-- require.

-- ---------------------------------------------------------------------------
-- report() and the submit_report wrapper
-- ---------------------------------------------------------------------------
create or replace function public.report(
  p_target_type text,
  p_target_id uuid,
  p_reason text,
  p_note text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_post_id uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if p_target_type not in ('post', 'comment') then
    raise exception 'unknown target type %', p_target_type;
  end if;
  if p_reason not in ('harassment', 'spam', 'inappropriate', 'privacy', 'unsafe_advice', 'other') then
    raise exception 'unknown reason %', p_reason;
  end if;
  if not public.check_rate_limit('report', 10, 10) then raise exception 'rate_limited'; end if;

  if p_target_type = 'post' then
    select id into v_post_id from public.workout_posts where id = p_target_id;
    if v_post_id is null then raise exception 'target not found'; end if;
  else
    if not exists (select 1 from public.post_comments where id = p_target_id) then
      raise exception 'target not found';
    end if;
    v_post_id := null;
  end if;

  -- A duplicate by the same reporter on the same target collapses on the
  -- unique key. The reporter count (distinct reporter_id in mod_queue) does
  -- not move; reason and the reporter note refresh.
  insert into public.reports (reporter_id, post_id, target_type, target_id, reason, details)
  values (v_uid, v_post_id, p_target_type, p_target_id, p_reason, left(coalesce(p_note, ''), 500))
  on conflict (reporter_id, target_type, target_id) do update
    set reason = excluded.reason,
        details = excluded.details;
end $$;
revoke all on function public.report(text, uuid, text, text) from public, anon;
grant execute on function public.report(text, uuid, text, text) to authenticated;

-- Kept so a caller still on the two-argument shape keeps working, same pattern
-- as add_post_comment and redeem_invite_code. cloud.js no longer calls it.
create or replace function public.submit_report(p_post_id uuid, p_reason text default 'inappropriate') returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.report('post', p_post_id, coalesce(p_reason, 'inappropriate'), '');
end $$;
revoke all on function public.submit_report(uuid, text) from public, anon;
grant execute on function public.submit_report(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- post_delete()
-- ---------------------------------------------------------------------------
-- Auth: the author, or a moderator (community.post.delete_any OR
-- community.comment.moderate OR real is_admin). The comment.moderate branch is
-- wider than the contract's original "author or community.post.delete_any"
-- line, and deliberately: COMM-152/153 route every queue action through
-- mod_review, and a coach who can see a reported post in the queue has to be
-- able to remove it. A moderator removal writes a content_delete audit row; an
-- author removing their own post does not.
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

  -- Idempotent.
  if v_row.deleted_at is not null and v_row.status = 'removed' then return; end if;

  update public.workout_posts
    set deleted_at = now(), status = 'removed'
  where id = post_id;

  if v_row.author_id is distinct from v_uid then
    perform public.log_admin_action(
      'content_delete', 'post', post_id,
      jsonb_build_object('status', v_row.status::text, 'deleted_at', v_row.deleted_at),
      jsonb_build_object('status', 'removed')
    );
  end if;
end $$;
revoke all on function public.post_delete(uuid) from public, anon;
grant execute on function public.post_delete(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- comment_moderate()
-- ---------------------------------------------------------------------------
-- post_comments has no UPDATE grant, so this is the only moderator path to a
-- comment's status. It stamps deleted_by with the moderator, the mirror of
-- comment_delete (202608280021) stamping the author; both return early on an
-- already-in-target-state row so neither overwrites the other.
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
      jsonb_build_object('status', 'removed')
    );
  else
    if v_row.status = 'active' and v_row.deleted_at is null then return; end if;
    update public.post_comments
      set status = 'active', deleted_at = null, deleted_by = null
    where id = p_comment_id;
    perform public.log_admin_action(
      'content_delete', 'comment', p_comment_id,
      jsonb_build_object('status', v_row.status::text),
      jsonb_build_object('status', 'active')
    );
  end if;
end $$;
revoke all on function public.comment_moderate(uuid, text) from public, anon;
grant execute on function public.comment_moderate(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- mod_queue()
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'mod_queue_item'
  ) then
    create type public.mod_queue_item as (
      report_id uuid,
      target_type text,
      target_id uuid,
      content_excerpt text,
      content_author_id uuid,
      content_author_name text,
      reporter_count integer,
      reasons text[],
      latest_reason text,
      note text,
      status text,
      created_at timestamptz,
      reporters jsonb
    );
  end if;
end $$;

create or replace function public.mod_queue(
  p_status text,
  p_cursor timestamptz,
  p_limit integer
) returns setof public.mod_queue_item
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_limit integer;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not (public.has_perm('community.comment.moderate')
          or exists (select 1 from public.profiles where id = v_uid and is_admin and deleted_at is null)) then
    raise exception 'not authorized';
  end if;
  v_limit := least(greatest(coalesce(p_limit, 50), 1), 50);

  return query
  with grp as (
    select
      r.target_type,
      r.target_id,
      min(r.created_at) as created_at,
      (array_agg(r.id order by r.created_at asc))[1] as report_id,
      count(distinct r.reporter_id)::integer as reporter_count,
      array_agg(distinct r.reason) as reasons,
      (array_agg(r.reason order by r.created_at desc))[1] as latest_reason,
      (array_remove(
        array_agg(nullif(btrim(r.details), '') order by r.created_at desc), null))[1] as note,
      case
        when bool_or(r.status = 'open') then 'open'
        when bool_or(r.status = 'reviewing') then 'reviewing'
        when bool_or(r.status = 'dismissed') then 'dismissed'
        else 'action_taken'
      end as status
    from public.reports r
    group by r.target_type, r.target_id
  )
  select
    g.report_id,
    g.target_type,
    g.target_id,
    coalesce(left(
      case
        when g.target_type = 'post'
          then (select coalesce(p.body, p.title, '') from public.workout_posts p where p.id = g.target_id)
        else (select coalesce(c.body, '') from public.post_comments c where c.id = g.target_id)
      end, 240), '') as content_excerpt,
    a.id as content_author_id,
    case when a.id is null then null
         else coalesce(nullif(a.display_name, ''), '@' || a.handle) end as content_author_name,
    g.reporter_count,
    g.reasons,
    g.latest_reason,
    coalesce(g.note, '') as note,
    g.status,
    g.created_at,
    (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', pr.id,
               'name', coalesce(nullif(pr.display_name, ''), '@' || pr.handle))), '[]'::jsonb)
      from (
        select distinct rr.reporter_id
        from public.reports rr
        where rr.target_type = g.target_type and rr.target_id = g.target_id
      ) d
      join public.profiles pr on pr.id = d.reporter_id
    ) as reporters
  from grp g
  left join lateral (
    select pr.id, pr.display_name, pr.handle
    from public.profiles pr
    where pr.id = case
      when g.target_type = 'post'
        then (select p.author_id from public.workout_posts p where p.id = g.target_id)
      else (select c.author_id from public.post_comments c where c.id = g.target_id)
    end
  ) a on true
  where (p_status = 'all' or g.status = p_status)
    and (p_cursor is null or g.created_at < p_cursor)
  order by g.created_at desc
  limit v_limit;
end $$;
revoke all on function public.mod_queue(text, timestamptz, integer) from public, anon;
grant execute on function public.mod_queue(text, timestamptz, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- mod_review()
-- ---------------------------------------------------------------------------
-- Four-argument. p_expires_at is read only for restrict_temp; every other
-- decision ignores it. Every decision, warn and dismiss included, stamps the
-- whole group of reports on the target and writes one report_review audit row.
-- The remove and restrict decisions delegate to functions that write their own
-- audit rows, so a remove leaves two entries (content_delete + report_review),
-- which is intentional.
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
  else
    select author_id into v_author from public.post_comments where id = v_tid;
  end if;

  if p_decision = 'remove' then
    if v_tt = 'post' then
      perform public.post_delete(v_tid);
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

  perform public.log_admin_action(
    'report_review', 'report', p_report_id,
    jsonb_build_object('status', v_before_status),
    jsonb_build_object('status', v_new_status, 'decision', p_decision)
  );
end $$;
revoke all on function public.mod_review(uuid, text, text, timestamptz) from public, anon;
grant execute on function public.mod_review(uuid, text, text, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- admin_grant_coach() two-argument form, plus audit on every role path
-- ---------------------------------------------------------------------------
-- COMM-154: a role change writes a role_change admin_actions row. before_data
-- carries the prior invite_redemptions.role, after_data the new one. The
-- one-argument admin_grant_coach from 202608270011 now delegates here so it
-- audits too, and admin_revoke_coach gets the same treatment.
--
-- p_role carries NO default. A default would make admin_grant_coach(uuid)
-- ambiguous against the one-argument overload kept below - Postgres cannot
-- pick a candidate and every one-argument call fails. The one-argument form is
-- the "grant coach" shorthand; this two-argument form is always called with
-- both args.
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
    jsonb_build_object('role', p_role)
  );
end $$;
revoke all on function public.admin_grant_coach(uuid, text) from public, anon;
grant execute on function public.admin_grant_coach(uuid, text) to authenticated;

create or replace function public.admin_grant_coach(p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.admin_grant_coach(p_user_id, 'coach');
end $$;

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
    jsonb_build_object('role', 'member')
  );
end $$;

commit;
