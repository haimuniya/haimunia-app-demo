begin;

-- A third reportable target: a member's PROFILE.
--
-- Until now a member could report a post or a comment and nothing else, so the
-- one kind of abuse that is not attached to a single piece of content - a
-- handle, display name, bio or avatar that is itself the problem - had no path
-- at all. `reports.target_type` was pinned closed to ('post', 'comment') by
-- 202608280024 and `report()` (202608280025) refuses anything else by name.
--
-- Three things change, in the order a reviewer should read them:
--   1. the target_type CHECK is widened to admit 'profile';
--   2. report() gains a 'profile' branch that validates the target against
--      public.profiles and leaves post_id null, exactly the way the 'comment'
--      branch already does;
--   3. mod_queue() and mod_review() learn what a profile target is.
--
-- =====================================================================
-- WHY (3) IS HERE AND NOT LEFT FOR LATER
-- =====================================================================
-- This is a deliberate widening of the brief that asked for (1) and (2) only,
-- and the reason is that (1) + (2) alone ship a reporting path whose REVIEW
-- side is broken in two concrete, reachable ways. Both were traced through the
-- 202608280025 bodies rather than assumed:
--
--   * mod_queue()'s `content_excerpt` and its author lateral join are written
--     as a two-way `case when target_type = 'post' ... else <read
--     post_comments> end`. A profile target falls into the `else` and reads
--     post_comments by a profiles id, which matches nothing - so the row shows
--     an empty excerpt and a null author, i.e. a queue entry a moderator
--     cannot identify.
--   * mod_review() resolves `v_author` with the same two-way case, so for a
--     profile target v_author is null. `restrict_temp` and
--     `restrict_permanent` - the ONLY sensible decisions on a reported
--     profile - then raise 'content author is no longer available', and
--     `remove` calls comment_moderate() on a profiles id and raises 'comment
--     not found'. Every action except `dismiss` fails, with an error message
--     that describes something untrue.
--
-- Shipping a report button that cannot be acted on is worse than not shipping
-- it, so the two `case` expressions grow a third arm. The post and comment
-- arms are byte-identical to 202608280025; nothing about an existing report
-- changes.
--
-- =====================================================================
-- WHAT A 'profile' REPORT MEANS, precisely
-- =====================================================================
--   target_id  = the reported member's profiles.id
--   post_id    = NULL, like a comment report. The reporter self-hide in
--                feed_page and the two legacy feed views are keyed on
--                reports.post_id and are unaffected, which is the same
--                reasoning 202608280024 recorded for comment reports.
--   the author = the reported member themselves. A profile has no separate
--                author, so mod_review's restrict decisions restrict exactly
--                the person who was reported. That is the whole point.
--   the excerpt = the member's display name (or @handle) and their bio, which
--                is the content actually under review.
--   `remove`   = REFUSED, with its own message. There is no "content" to take
--                down; the decisions that make sense are restrict or dismiss.
--                Refusing loudly beats silently doing nothing or deleting an
--                account by accident.
--
-- A member can report their own profile, and that is left possible on purpose:
-- report() has never checked self-targeting for posts or comments either, the
-- duplicate key still collapses it to one row, and adding a bespoke refusal
-- here would be the only place in the function that treats the reporter
-- specially.

-- ---------------------------------------------------------------------------
-- 1. reports.target_type
-- ---------------------------------------------------------------------------
-- 202608280024 declared this one inline, so the name is the deterministic
-- single-column inline-check name. `drop constraint if exists` + `add
-- constraint` is the same widening shape 202609030004 and 202609010001 use on
-- admin_actions; Postgres cannot alter a CHECK expression in place.
alter table public.reports drop constraint if exists reports_target_type_check;
alter table public.reports add constraint reports_target_type_check
  check (target_type in ('post', 'comment', 'profile'));

-- ---------------------------------------------------------------------------
-- 2. report()
-- ---------------------------------------------------------------------------
-- `drop function if exists ... ; create function ...` rather than `create or
-- replace`, the convention 202609030007 and 202609030008 set for amending an
-- existing RPC in place: the drop clears the old grants with the old body, so
-- the grant lines below are the complete and only privilege statement about
-- this function, and nothing can survive from the previous definition by
-- accident. Signature, argument names and return type are unchanged, so no
-- caller changes.
--
-- submit_report() (202608280025) calls report() by name from PL/pgSQL, which
-- re-resolves at execution time, so dropping and recreating does not break it.
drop function if exists public.report(text, uuid, text, text);
create function public.report(
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
  if p_target_type not in ('post', 'comment', 'profile') then
    raise exception 'unknown target type %', p_target_type;
  end if;
  if p_reason not in ('harassment', 'spam', 'inappropriate', 'privacy', 'unsafe_advice', 'other') then
    raise exception 'unknown reason %', p_reason;
  end if;
  if not public.check_rate_limit('report', 10, 10) then raise exception 'rate_limited'; end if;

  if p_target_type = 'post' then
    select id into v_post_id from public.workout_posts where id = p_target_id;
    if v_post_id is null then raise exception 'target not found'; end if;
  elsif p_target_type = 'comment' then
    if not exists (select 1 from public.post_comments where id = p_target_id) then
      raise exception 'target not found';
    end if;
    v_post_id := null;
  else
    -- A deleted profile is not reportable: `deleted_at is not null` is the
    -- module's "this member is gone" state everywhere else, and a report on a
    -- gone member has nothing a moderator can act on.
    if not exists (
      select 1 from public.profiles where id = p_target_id and deleted_at is null
    ) then
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
comment on function public.report(text, uuid, text, text) is
  'COMM-151. The single report path. Auth: any signed-in member who passes is_community_member() (a recovery method is required to write); rate limited to 10 per 10 minutes through check_rate_limit(''report''). p_target_type is ''post'', ''comment'' or ''profile'' - anything else raises ''unknown target type %''; p_reason is one of harassment/spam/inappropriate/privacy/unsafe_advice/other. Validates the target exists (a profile must also have deleted_at is null) and raises ''target not found'' otherwise. post_id is set only for a post target and stays NULL for a comment or a profile, which is what keeps the reports.post_id-keyed reporter self-hide in feed_page correct. Repeating a report on the same target as the same reporter UPSERTs on (reporter_id, target_type, target_id): reason and note refresh, no second row, so mod_queue''s distinct reporter count does not move. Side effect beyond the row itself: the AFTER INSERT trigger reports_notify_moderators (202609050003) notifies the club''s moderators, and only on a genuinely new row - the ON CONFLICT path fires UPDATE triggers, not INSERT ones.';

-- ---------------------------------------------------------------------------
-- 3a. mod_queue() - the third arm in the excerpt and the author lateral
-- ---------------------------------------------------------------------------
-- Everything else in this body is 202608280025 verbatim: the same auth gate,
-- the same grouping CTE, the same status folding, the same reporters jsonb,
-- the same cursor and limit. `create or replace` is enough here because the
-- signature, the return type and the grants are all unchanged and the previous
-- grant state is exactly the state wanted.
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
        when g.target_type = 'profile'
          -- The reported content IS the profile text: the name the member
          -- shows and the bio they wrote. Newline-joined so a moderator sees
          -- both without a second query.
          then (select btrim(coalesce(nullif(pf.display_name, ''), '@' || pf.handle) ||
                             case when btrim(coalesce(pf.bio, '')) = '' then ''
                                  else E'\n' || pf.bio end)
                from public.profiles pf where pf.id = g.target_id)
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
      -- A profile is its own author. This is what makes content_author_id
      -- usable by the client's existing "act on this member" controls without
      -- a special case on the render side.
      when g.target_type = 'profile' then g.target_id
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
comment on function public.mod_queue(text, timestamptz, integer) is
  'COMM-152. One row per reported TARGET, not per report: every report on the same (target_type, target_id) folds into a single mod_queue_item whose reporter_count is the distinct reporter count and whose status is the strongest of the group (open > reviewing > dismissed > action_taken). Auth: has_perm(''community.comment.moderate'') OR a real profiles.is_admin row; anything else raises ''not authorized''. SECURITY DEFINER so the queue can read reported content and reporter identities past their own RLS. p_status is a single status or ''all''; p_cursor pages backwards on the group''s earliest created_at; p_limit is clamped to 1..50. Handles three target types: for a post the excerpt is the post body or title and the author is the post author, for a comment the comment body and its author, for a PROFILE (202609050002) the excerpt is the member''s display name or @handle plus their bio and the author IS the reported member. Read-only: writes nothing and audits nothing.';

-- ---------------------------------------------------------------------------
-- 3b. mod_review() - the third arm in the author resolution, and one refusal
-- ---------------------------------------------------------------------------
-- Unchanged from 202608280025 apart from the two marked blocks: same auth
-- gate, same decision list, same group-wide status stamp, same single
-- report_review audit row.
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

  perform public.log_admin_action(
    'report_review', 'report', p_report_id,
    jsonb_build_object('status', v_before_status),
    jsonb_build_object('status', v_new_status, 'decision', p_decision)
  );
end $$;
revoke all on function public.mod_review(uuid, text, text, timestamptz) from public, anon;
grant execute on function public.mod_review(uuid, text, text, timestamptz) to authenticated;
comment on function public.mod_review(uuid, text, text, timestamptz) is
  'COMM-152/153. Applies one decision to the WHOLE group of reports on the target the given report points at, and stamps every one of them with status, reviewed_by, reviewed_at and review_note. Auth: has_perm(''community.comment.moderate'') OR a real profiles.is_admin row. p_decision is remove | warn | restrict_temp | restrict_permanent | dismiss; dismiss sets ''dismissed'' and every other decision sets ''action_taken''. p_expires_at is read only by restrict_temp. Side effects by decision: remove delegates to post_delete() for a post and comment_moderate(''remove'') for a comment and RAISES ''a profile report has no content to remove'' for a profile target (202609050002); restrict_temp / restrict_permanent delegate to mod_restrict_member() against the content author - which for a profile target is the reported member themselves - and raise ''content author is no longer available'' when that member is gone; warn and dismiss have no side effect beyond the stamp. Every decision writes exactly one report_review admin_actions row, so a remove leaves two audit rows (content_delete + report_review), which is intentional.';

commit;
