-- Club WOD board: tell a restricted member BEFORE they tap, not after.
--
-- THE BUG. club_wod_attach_result() (202609080002) refuses in five ways, in
-- this order: no community.post.create ('not authorized'), posting restricted
-- ('posting_restricted'), cancelled, future, expired. club_wod_board_json()
-- computed viewer.closed_reason from only the LAST THREE, so a member under a
-- posting restriction - a moderation sanction - was handed can_attach true, an
-- offer to put their result on the club board, and a refusal only once they
-- had tapped it.
--
-- Nothing was lost and nothing leaked: the RPC held. What failed was the
-- promise club_wod_board_json's own comment makes, that the board and the
-- write path agree, and it failed at the worst moment to deliver a sanction -
-- after the member has decided to take part.
--
-- The client could not fix this. It reads can_attach off the board precisely
-- so that it never re-derives a rule it does not own; had it hardcoded a
-- restriction check of its own, that check would be the next thing to drift.
-- So the fix belongs here, in the one definition of "a board".
--
-- WHAT CHANGES: two new closed_reason values, 'not_permitted' and
-- 'restricted', asked FIRST because that is the order the write path asks
-- them in. can_attach is (v_closed is null) and so narrows automatically.
--
-- WHAT DOES NOT CHANGE: can_detach. club_wod_detach_result() has no
-- permission check, no restriction check and no window check by design - a
-- member must always be able to take their own result off a club surface, and
-- a restriction exists to stop someone ADDING content, not to trap what they
-- already added. A restricted member therefore still sees, and can still use,
-- the detach control on a board they are attached to.
--
-- No table, column, policy or grant changes. One function body, replaced.

begin;

create or replace function public.club_wod_board_json(p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_s public.club_wod_sessions;
  v_w public.club_wods;
  v_has_wod boolean := false;
  v_results jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_viewer jsonb;
  v_closed text;
  v_by jsonb;
begin
  if v_uid is null then return null; end if;
  select * into v_s from public.club_wod_sessions s where s.id = p_session_id;
  if not found then return null; end if;

  select * into v_w from public.club_wods w where w.wod_id = v_s.wod_id;
  v_has_wod := found;

  -- The board. Ordered by attached_at - the order people trained in - and
  -- NEVER by anything score-shaped; see decision 6.
  --
  -- result_count is COUNTED OVER THE SAME FILTERED SET as the list, so it
  -- can never disclose the existence of a member the viewer may not see.
  select coalesce(jsonb_agg(t.j order by t.attached_at, t.user_id), '[]'::jsonb),
         count(*)::integer
    into v_results, v_count
  from (
    select r.user_id, r.attached_at,
           jsonb_build_object(
             'user_id', r.user_id,
             'display_name', p.display_name,
             'handle', p.handle,
             'avatar_url', p.avatar_url,
             'is_viewer', (r.user_id = v_uid),
             'result_text', case when g.may_see_result then r.result_text else null end,
             -- The client can say "hidden" rather than "no result", which
             -- are different facts about a member.
             'result_hidden', (r.result_text is not null and not g.may_see_result),
             'score_type', r.score_type,
             'rx', r.rx,
             'occurred_on', r.occurred_on,
             'attached_at', r.attached_at
           ) as j
    from public.club_wod_results r
    join public.profiles p on p.id = r.user_id and p.deleted_at is null
    cross join lateral (
      select
        -- LISTED: consented by attaching, still subject to the member's own
        -- club visibility and to a block edge in either direction.
        (r.user_id = v_uid or public.can_view_profile_field(r.user_id, 'visible_to_club')) as may_list,
        -- THE FIGURE: show_workout_results, which DEFAULTS FALSE.
        (r.user_id = v_uid or public.can_view_profile_field(r.user_id, 'show_workout_results')) as may_see_result
    ) g
    where r.session_id = v_s.id
      and g.may_list
  ) t;

  -- The viewer's own row, always full: can_view_profile_field returns true
  -- for the subject themselves, so nothing of theirs is ever stripped.
  select jsonb_build_object(
           'attached', true,
           'result_text', r.result_text,
           'score_type', r.score_type,
           'rx', r.rx,
           'occurred_on', r.occurred_on,
           'attached_at', r.attached_at)
    into v_viewer
  from public.club_wod_results r
  where r.session_id = v_s.id and r.user_id = v_uid;

  if v_viewer is null then
    v_viewer := jsonb_build_object(
      'attached', false, 'result_text', null, 'score_type', null,
      'rx', null, 'occurred_on', null, 'attached_at', null);
  end if;

  -- Why the attach control is unavailable, so the client can SAY it rather
  -- than hide a button. THE SAME FIVE CONDITIONS club_wod_attach_result()
  -- raises on, asked in the same order, so the board and the write agree.
  --
  -- 202609080004 added the first two. They were missing, and the gap was not
  -- cosmetic: a member the club has restricted from posting was told
  -- can_attach true, shown the control, and refused by the RPC with
  -- 'posting_restricted' only after tapping it. That is the worst moment to
  -- deliver a sanction - the member has already decided to take part - and
  -- the client could not have fixed it without re-deriving a rule it does
  -- not own. can_detach is deliberately NOT narrowed the same way: detach
  -- carries no permission or restriction check at all, because taking your
  -- own result off a club surface must never be blocked by a sanction that
  -- exists to stop someone ADDING content.
  v_closed := case
    when not public.has_perm('community.post.create') then 'not_permitted'
    when public.is_posting_restricted(v_uid) then 'restricted'
    when v_s.cancelled_at is not null then 'cancelled'
    when v_s.session_date > current_date then 'future'
    when v_s.session_date < current_date - 14 then 'expired'
    else null
  end;

  v_viewer := v_viewer
    || jsonb_build_object(
         'can_attach', (v_closed is null),
         -- Detaching is ALWAYS available, including from a cancelled or
         -- expired board. A member must be able to take their result down.
         'can_detach', (v_viewer ->> 'attached')::boolean,
         'closed_reason', v_closed);

  select jsonb_build_object(
           'id', pf.id, 'display_name', pf.display_name,
           'handle', pf.handle, 'avatar_url', pf.avatar_url)
    into v_by
  from public.profiles pf where pf.id = v_s.published_by and pf.deleted_at is null;

  return jsonb_build_object(
    'session_id', v_s.id,
    'session_date', v_s.session_date,
    'note', v_s.note,
    'post_id', v_s.post_id,
    'published_at', v_s.published_at,
    'published_by', v_by,
    'cancelled_at', v_s.cancelled_at,
    'wod', case when v_has_wod then public.club_wod_json(v_w) else null end,
    'result_count', v_count,
    'results', v_results,
    'viewer', v_viewer
  );
end $$;

revoke all on function public.club_wod_board_json(uuid) from public, anon, authenticated;

comment on function public.club_wod_board_json(uuid) is
  'Internal. The single definition of "a club WOD board": {session_id, session_date, note, post_id, published_at, published_by{id,display_name,handle,avatar_url}|null, cancelled_at, wod (club_wod_json shape, null if the catalogue row vanished), result_count, results[], viewer{attached,result_text,score_type,rx,occurred_on,attached_at,can_attach,can_detach,closed_reason}}. Returned by both reads AND by all four write RPCs, so the board rendered after attaching and the board rendered after reloading cannot disagree. EVERY KEY IS ALWAYS PRESENT, so the empty, cancelled and not-yet-attached states need no absence tests. SECURITY DEFINER with no client grant: it crosses club_wod_results_read in ONE direction only, to reveal a member''s participation (consented by attaching) while the policy keeps refusing their figure. Each row is listed only when the viewer passes can_view_profile_field(member, ''visible_to_club'') - which also settles block edges both ways - and carries result_text only when they pass can_view_profile_field(member, ''show_workout_results''), which DEFAULTS FALSE; otherwise result_text is null and result_hidden is true. result_count is counted over the SAME filtered set as the list, so it cannot disclose a member the viewer may not see. Ordered by attached_at, never by score: there is no ranking here and no column to build one from. Returns null for an unknown session or a null caller. Unpaged: one board is one club-day, and its ceiling is the club''s daily attendance. CLOSED_REASON (202609080004) mirrors club_wod_attach_result()''s five refusals in ITS order: ''not_permitted'' (no community.post.create), ''restricted'' (is_posting_restricted), ''cancelled'', ''future'', ''expired'', else null. can_attach is exactly (closed_reason is null). can_detach is NOT narrowed by the first two - detach has no permission or restriction gate at all, because removing your own result must never be blocked by a sanction against adding content.';

commit;
