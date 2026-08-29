begin;

-- COMM-103 decorative media and COMM-180 the member profile community
-- section.

-- ---------------------------------------------------------------------------
-- 1. post_media.decorative
-- ---------------------------------------------------------------------------
-- The composer already lets an author mark a photo decorative, which is the
-- accessible answer for a photo that carries no information: a screen
-- reader should skip it, and forcing invented alt text on it is worse than
-- an empty alt. The client sends `decorative` in each post_create media item
-- and blanks alt_text at the same time. Both are accepted here: the column
-- stores the intent, and the trigger below normalizes the alt text so
-- "decorative" and "has alt text" can never disagree in the same row.
alter table public.post_media
  add column decorative boolean not null default false;

create or replace function public.normalize_post_media_alt() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.decorative then
    new.alt_text := null;
  elsif new.alt_text is not null and btrim(new.alt_text) = '' then
    -- An empty string is not alt text. Storing it as null keeps "no alt on
    -- a non-decorative image" a single, queryable state.
    new.alt_text := null;
  end if;
  return new;
end $$;
create trigger post_media_normalize_alt before insert or update of decorative, alt_text
  on public.post_media for each row execute function public.normalize_post_media_alt();

update public.post_media set alt_text = null where alt_text is not null and btrim(alt_text) = '';

-- Note for whoever writes post_create: there is no post_create function in
-- the database yet, so there is nothing here to update. When it lands, its
-- media item shape is {storage_path, alt_text, decorative, position, width,
-- height} and it can pass `decorative` straight through - the trigger owns
-- the alt_text rule.
--
-- feed_page (202608280019) builds its media objects without `decorative`.
-- That is not a gap in the rendered output: the client blanks alt_text for
-- a decorative photo before it is ever stored, so the alt attribute comes
-- out empty either way. Adding the key to feed_page means re-creating a
-- 500-line function, so it waits for the next change that touches it.

-- ---------------------------------------------------------------------------
-- 2. community_profile
-- ---------------------------------------------------------------------------
-- One call for the whole profile overlay, with every field filtered by
-- can_view_profile_field() against the caller. A key that is absent means
-- the field is hidden, and the client omits it rather than rendering a
-- blank - so "hidden" and "empty" stay distinguishable end to end. That is
-- why `prs` and `achievements` are omitted entirely when the toggle is off
-- and returned as an empty array when the toggle is on and there is
-- nothing to show.
--
-- The argument is named user_id, not p_user_id, because PostgREST matches
-- RPC arguments by name and the client (COMM-180) already calls
-- rpc("community_profile", { user_id }). It is copied into v_target on the
-- first line and never read again, so no column reference in this function
-- can collide with it.
--
-- SECURITY DEFINER for one specific reason: a target with visible_to_club
-- off is not selectable through profiles_read_authenticated, and the
-- contract still says a fully private member returns name, role, and member
-- since. Everything past those three fields is gated field by field, so
-- definer rights buy exactly one thing here - the ability to answer "this
-- member exists and is private" instead of "no such member".
create or replace function public.community_profile(user_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_target uuid;
  v_p public.profiles;
  v_out jsonb;
  v_role text;
  v_since timestamptz;
  v_hide_result boolean;
  v_days integer;
  v_freq numeric;
  v_anchor date;
  v_streak integer;
  v_json jsonb;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  v_target := coalesce(user_id, v_uid);

  -- A block edge in either direction ends the question before any row is
  -- read. can_view_profile_field() would return false for every field
  -- anyway, but returning the bare header to a blocked member is still a
  -- confirmation they should not get.
  if v_target <> v_uid and exists (
    select 1 from public.blocks b
    where (b.blocker_id = v_uid and b.blocked_id = v_target)
       or (b.blocker_id = v_target and b.blocked_id = v_uid)
  ) then
    raise exception 'not authorized';
  end if;

  select * into v_p from public.profiles p where p.id = v_target and p.deleted_at is null;
  if not found then raise exception 'profile not found'; end if;

  -- Role and tenure both come from the first invite redemption, which is
  -- the only server-side record of when a member joined the club and what
  -- they joined as. profiles.created_at is the fallback for a row that
  -- predates the invite gate.
  select ir.role, ir.redeemed_at into v_role, v_since
  from public.invite_redemptions ir
  where ir.user_id = v_target
  order by ir.redeemed_at asc
  limit 1;

  -- The three fields a fully private member still returns, plus handle,
  -- which the client needs to render a name at all when display_name is
  -- empty. profiles has no first_name or last_name column, so those two
  -- documented keys are simply absent and the client falls back to
  -- display_name, then handle.
  v_out := jsonb_build_object(
    'id', v_p.id,
    'display_name', nullif(v_p.display_name, ''),
    'handle', v_p.handle,
    'avatar_url', v_p.avatar_url,
    'role', coalesce(v_role, 'member'),
    'member_since', coalesce(v_since, v_p.created_at),
    -- False on your own profile, so the overlay does not offer you a
    -- Follow button pointed at yourself.
    'allow_follows', (v_target <> v_uid and public.can_view_profile_field(v_target, 'allow_follows'))
  );

  if not public.can_view_profile_field(v_target, 'visible_to_club') then
    return v_out;
  end if;

  v_out := v_out || jsonb_build_object(
    'follower_count', (select count(*)::integer from public.follows f where f.followed_id = v_target),
    'following_count', (select count(*)::integer from public.follows f where f.follower_id = v_target)
  );

  select jsonb_build_object('id', c.id, 'title', c.title, 'ends_at', c.end_at)
    into v_json
  from public.challenge_participants cp
  join public.challenges c on c.id = cp.challenge_id
  where cp.user_id = v_target
    and cp.status = 'active'
    and c.status = 'active'
    and now() >= c.start_at and now() <= c.end_at
  order by c.end_at asc
  limit 1;
  if v_json is not null then
    v_out := v_out || jsonb_build_object('active_challenge', v_json);
  end if;

  -- --- training numbers, COMM-018 --------------------------------------
  -- Everything below this point is derived from posts the member chose to
  -- publish, not from attendance, which has no source yet (COMM-P03). A
  -- member who trains and never posts reads as zero here, and that is the
  -- honest answer rather than an invented one.
  if public.can_view_profile_field(v_target, 'show_workout_results') then
    select count(distinct coalesce(p.occurred_on, p.created_at::date))::integer
      into v_days
    from public.workout_posts p
    where p.author_id = v_target
      and p.deleted_at is null and p.status = 'active'
      and p.post_type in ('POST_WORKOUT', 'POST_PR')
      and coalesce(p.occurred_on, p.created_at::date) >= current_date - 27;

    if coalesce(v_days, 0) > 0 then
      v_freq := round(v_days / 4.0, 1);
      v_out := v_out || jsonb_build_object('training_frequency',
        case when v_freq = trunc(v_freq) then trunc(v_freq)::integer::text
             else to_char(v_freq, 'FM990.9') end || ' בשבוע');
    end if;

    -- Week streak, counted the same way the consistency achievements count
    -- it: a week counts when the member logged anything in it, so a three
    -- times a week pattern scores exactly like a daily one. The streak may
    -- end on the current week or the previous one - a member who has not
    -- trained yet this week has not lost their streak.
    select max(w.wk) into v_anchor
    from (
      select distinct date_trunc('week', coalesce(p.occurred_on, p.created_at::date)::timestamp)::date as wk
      from public.workout_posts p
      where p.author_id = v_target
        and p.deleted_at is null and p.status = 'active'
        and p.post_type in ('POST_WORKOUT', 'POST_PR')
    ) w;

    v_streak := 0;
    if v_anchor is not null and v_anchor >= date_trunc('week', current_date::timestamp)::date - 7 then
      -- Once a week is missing, every later row falls behind the expected
      -- date and stays behind, so this counts the contiguous run and
      -- nothing after it.
      select count(*)::integer into v_streak
      from (
        select w.wk, row_number() over (order by w.wk desc) as rn
        from (
          select distinct date_trunc('week', coalesce(p.occurred_on, p.created_at::date)::timestamp)::date as wk
          from public.workout_posts p
          where p.author_id = v_target
            and p.deleted_at is null and p.status = 'active'
            and p.post_type in ('POST_WORKOUT', 'POST_PR')
        ) w
      ) s
      where s.wk = v_anchor - ((s.rn - 1) * 7)::integer;
    end if;
    v_out := v_out || jsonb_build_object('current_streak', coalesce(v_streak, 0));

    select coalesce(jsonb_agg(jsonb_build_object('title', r.title, 'date', r.d) order by r.d desc), '[]'::jsonb)
      into v_json
    from (
      select coalesce(nullif(p.title, ''), left(coalesce(p.body, ''), 80)) as title,
             coalesce(p.occurred_on, p.created_at::date) as d
      from public.workout_posts p
      where p.author_id = v_target
        and p.deleted_at is null and p.status = 'active'
        and p.post_type = 'POST_WORKOUT'
        and public.post_visible_to_viewer(p.id)
      order by coalesce(p.occurred_on, p.created_at::date) desc
      limit 5
    ) r;
    v_out := v_out || jsonb_build_object('recent_workouts', v_json);
  end if;

  -- --- PRs, gated by show_prs ------------------------------------------
  -- Absent key hides the Progress tab, empty array shows the no-PRs state.
  if public.can_view_profile_field(v_target, 'show_prs') then
    select coalesce(jsonb_agg(jsonb_build_object(
             'movement', r.movement, 'result', r.result, 'achieved_on', r.d) order by r.d desc), '[]'::jsonb)
      into v_json
    from (
      select coalesce(p.metadata ->> 'movement', nullif(p.title, ''), '') as movement,
             coalesce(p.metadata ->> 'new_result', nullif(p.result_text, ''), '') as result,
             coalesce(p.occurred_on, p.created_at::date) as d
      from public.workout_posts p
      where p.author_id = v_target
        and p.deleted_at is null and p.status = 'active'
        and p.post_type = 'POST_PR'
        and public.post_visible_to_viewer(p.id)
      order by coalesce(p.occurred_on, p.created_at::date) desc
      limit 20
    ) r;
    v_out := v_out || jsonb_build_object('prs', v_json);
  end if;

  -- --- achievements, gated by show_achievements ------------------------
  -- The per-unlock visibility column is applied on top of the toggle, the
  -- same three-way rule member_achievements_read spells out, so an
  -- only_me unlock never appears on someone else's screen.
  if public.can_view_profile_field(v_target, 'show_achievements') then
    select coalesce(jsonb_agg(jsonb_build_object(
             'title', r.title, 'badge_icon', r.icon, 'code', r.code,
             'unlocked_at', r.unlocked_at) order by r.unlocked_at desc), '[]'::jsonb)
      into v_json
    from (
      select d.name as title, d.icon as icon, d.code as code, ma.unlocked_at as unlocked_at
      from public.member_achievements ma
      join public.achievement_definitions d on d.id = ma.achievement_id
      where ma.user_id = v_target
        and (
          v_target = v_uid
          or ma.visibility = 'club'
          or (ma.visibility = 'friends' and public.are_friends(v_target))
        )
      order by ma.unlocked_at desc
      limit 24
    ) r;
    v_out := v_out || jsonb_build_object('achievements', v_json);
    if jsonb_array_length(v_json) > 0 then
      v_out := v_out || jsonb_build_object('recent_achievement', jsonb_build_object(
        'title', v_json -> 0 ->> 'title', 'badge_icon', v_json -> 0 ->> 'badge_icon'));
    end if;
  end if;

  -- --- posts -----------------------------------------------------------
  -- Card contract rows, the same shape feed_page returns, so
  -- renderPostCard() renders the Posts tab with no special case. Each row
  -- still passes post_visible_to_viewer(), so an only_me or friends post
  -- never reaches a viewer the author did not choose, profile tab or not.
  v_hide_result := not public.can_view_profile_field(v_target, 'show_workout_results');

  select coalesce(jsonb_agg(r.j order by r.ts desc), '[]'::jsonb) into v_json
  from (
    select jsonb_build_object(
             'id', p.id,
             'post_type', p.post_type::text,
             'author_id', p.author_id,
             'author', jsonb_build_object(
               'display_name', v_p.display_name, 'handle', v_p.handle, 'avatar_url', v_p.avatar_url),
             'display_name', v_p.display_name,
             'handle', v_p.handle,
             'body', p.body,
             'title', p.title,
             'result_text', case when v_hide_result and p.post_type in ('POST_WORKOUT', 'POST_PR')
                                 then null else p.result_text end,
             'occurred_on', p.occurred_on,
             'visibility', p.visibility::text,
             'created_at', p.created_at,
             'published_at', p.published_at,
             'metadata', case when v_hide_result and p.post_type in ('POST_WORKOUT', 'POST_PR')
                              then p.metadata - 'result_text' - 'new_result' - 'previous_result' - 'improvement'
                              else p.metadata end,
             'media', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'storage_path', m.storage_path,
                        'alt_text', m.alt_text,
                        'decorative', m.decorative,
                        'position', m."position",
                        'width', m.width,
                        'height', m.height) order by m."position")
               from public.post_media m where m.post_id = p.id),
               case when p.photo_path is not null
                    then jsonb_build_array(jsonb_build_object('storage_path', p.photo_path, 'position', 0))
                    else '[]'::jsonb end),
             'reaction_count', (select count(*)::integer from public.reactions rr where rr.post_id = p.id),
             'comment_count', (select count(*)::integer from public.post_comments pc
                               where pc.post_id = p.id and pc.deleted_at is null and pc.status = 'active')
           ) as j,
           coalesce(p.created_at, p.published_at) as ts
    from public.workout_posts p
    where p.author_id = v_target
      and p.deleted_at is null and p.status = 'active'
      and public.post_visible_to_viewer(p.id)
    order by coalesce(p.created_at, p.published_at) desc
    limit 10
  ) r;
  v_out := v_out || jsonb_build_object('posts', v_json);

  return v_out;
end $$;

revoke all on function public.community_profile(uuid) from public, anon;
grant execute on function public.community_profile(uuid) to authenticated;

commit;
