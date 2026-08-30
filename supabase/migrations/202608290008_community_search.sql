begin;

-- Community Phase 2, search cluster (COMM-228). community_search(p_query,
-- p_limit) is one round trip returning members, events, and challenges
-- instead of the three separate queries a grouped search UI would
-- otherwise need. It is SECURITY DEFINER purely to cross the RLS boundary
-- on purpose for events and challenges (a caller has no direct select
-- grant shaped for "search across everything I'm allowed to see one row at
-- a time"), not to see anything wider than three unions of rules that
-- already exist as RLS policies:
--   - members: the exact visibility profiles_read_authenticated
--     (202608280003) already enforces - self excluded, no block edge in
--     either direction, and either visible_to_club or the caller is an
--     admin. Same column list and .neq(id, self) shape searchPeople
--     (cloud.js) already returns, unchanged for that caller.
--   - events: the exact rule events_read (202608280010) already enforces -
--     any status other than draft, or the caller created it, or the
--     caller holds community.event.manage.
--   - challenges: the exact rule challenges_read (202608280009) already
--     enforces - any status other than draft, or the caller created it, or
--     the caller holds community.challenge.create (challenges has no
--     separate .manage permission; .create is the one permission that
--     gates every challenges write, so it is also the one that widens
--     read).
-- This function does not invent a looser or stricter rule than any of
-- those three policies already state; it just answers all three in one
-- call.

create or replace function public.community_search(p_query text, p_limit int default 10)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_q text;
  v_limit int;
  v_pattern text;
  v_members jsonb;
  v_events jsonb;
  v_challenges jsonb;
begin
  if v_uid is null then raise exception 'not authorized'; end if;

  -- Same sanitization searchPeople (cloud.js) already does client-side
  -- before building its ilike pattern: strip %, _, comma and parens so a
  -- raw query cannot turn into an unintended wildcard or break the
  -- concatenated pattern. Replicated here because this function receives
  -- the raw string over RPC, not the client's already-sanitized copy.
  v_q := btrim(regexp_replace(coalesce(p_query, ''), '[%_,()]', '', 'g'));
  v_limit := greatest(1, least(coalesce(p_limit, 10), 50));

  -- Matches searchPeople's existing client-side threshold: under 2
  -- characters is empty results, not a query, and not an error.
  if char_length(v_q) < 2 then
    return jsonb_build_object(
      'members', '[]'::jsonb,
      'events', '[]'::jsonb,
      'challenges', '[]'::jsonb
    );
  end if;

  v_pattern := '%' || v_q || '%';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id,
    'handle', m.handle,
    'display_name', m.display_name,
    'bio', m.bio,
    'avatar_url', m.avatar_url,
    'allow_follows', m.allow_follows
  )), '[]'::jsonb)
  into v_members
  from (
    select p.id, p.handle, p.display_name, p.bio, p.avatar_url, p.allow_follows
    from public.profiles p
    where p.deleted_at is null
      and p.id <> v_uid
      and (p.handle ilike v_pattern or p.display_name ilike v_pattern)
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = v_uid and b.blocked_id = p.id)
           or (b.blocker_id = p.id and b.blocked_id = v_uid)
      )
      and (p.visible_to_club or public.is_admin())
    order by p.display_name nulls last, p.handle
    limit v_limit
  ) m;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', ev.id,
    'title', ev.title,
    'event_type', ev.event_type,
    'status', ev.status,
    'start_at', ev.start_at
  )), '[]'::jsonb)
  into v_events
  from (
    select e.id, e.title, e.event_type, e.status, e.start_at
    from public.events e
    where e.title ilike v_pattern
      and (
        e.status <> 'draft'
        or e.created_by = v_uid
        or public.has_perm('community.event.manage')
      )
    order by e.start_at asc
    limit v_limit
  ) ev;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'title', c.title,
    'challenge_type', c.challenge_type,
    'status', c.status,
    'start_at', c.start_at,
    'end_at', c.end_at
  )), '[]'::jsonb)
  into v_challenges
  from (
    select ch.id, ch.title, ch.challenge_type, ch.status, ch.start_at, ch.end_at
    from public.challenges ch
    where ch.title ilike v_pattern
      and (
        ch.status <> 'draft'
        or ch.created_by = v_uid
        or public.has_perm('community.challenge.create')
      )
    order by ch.end_at desc
    limit v_limit
  ) c;

  return jsonb_build_object('members', v_members, 'events', v_events, 'challenges', v_challenges);
end $$;

revoke all on function public.community_search(text, int) from public, anon;
grant execute on function public.community_search(text, int) to authenticated;

commit;
