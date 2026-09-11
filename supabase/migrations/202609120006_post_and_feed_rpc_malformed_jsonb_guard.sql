begin;

-- Security hunt, round 7 (2026-09-12), malformed-RPC-parameter agent.
--
-- post_create's media-item loop and feed_record_impressions both cast
-- caller-supplied jsonb scalars straight to typed columns (::smallint,
-- ::integer, ::uuid) with no validation first. Confirmed live against
-- real local Postgres and real local PostgREST: a media item with
-- "position": 999999 (out of smallint range) or "width": "abc"
-- (non-numeric) raised a raw, unhandled Postgres error
-- (22003/invalid_text_representation) instead of a clean rejection, and
-- feed_record_impressions with a non-UUID post_id/feed_session_id or an
-- out-of-clamp-range position did the same (22P02). PostgREST does not
-- forward the CONTEXT block (no schema/table/column leak - confirmed via
-- curl against the local REST endpoint, which returns only the bare
-- Postgres code/message), so this is a robustness gap, not a disclosure
-- one: low severity, fixed the same way the rest of both functions
-- already validate/filter caller input rather than let a bad cast throw.
--
-- Fix: validate each field's shape before casting. Both functions already
-- silently drop/default malformed items in other places (missing
-- post_id/feed_session_id, missing storage_path is the one exception that
-- correctly still raises, since that one is not a "bad type," it is a
-- request with no photo at all) - this brings position/width/height/
-- post_id/feed_session_id in line with that same shape.

create or replace function public.feed_record_impressions(p_rows jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_uuid_re text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be a json array';
  end if;
  if jsonb_array_length(p_rows) > 50 then
    raise exception 'at most 50 impressions per call';
  end if;

  insert into public.feed_impressions (user_id, post_id, "position", feed_session_id, shown_at)
  select
    v_uid,
    (r ->> 'post_id')::uuid,
    least(greatest(
      case when r ->> 'position' ~ '^-?[0-9]{1,9}$' then (r ->> 'position')::integer else 0 end,
      0), 32767)::smallint,
    (r ->> 'feed_session_id')::uuid,
    coalesce((r ->> 'shown_at')::timestamptz, now())
  from jsonb_array_elements(p_rows) r
  where r ->> 'post_id' ~ v_uuid_re
    and r ->> 'feed_session_id' ~ v_uuid_re
  on conflict (user_id, feed_session_id, post_id) do nothing;
end $$;
revoke all on function public.feed_record_impressions(jsonb) from public, anon;
grant execute on function public.feed_record_impressions(jsonb) to authenticated;

create or replace function public.post_create(
  body text,
  visibility public.post_visibility,
  media jsonb,
  links jsonb,
  p_idempotency_key uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_body text;
  v_media_count integer := 0;
  v_post_type public.post_type;
  v_metadata jsonb := '{}'::jsonb;
  v_post_id uuid;
  v_item jsonb;
  v_idx integer := 0;
  v_replay boolean;
  v_prior jsonb;
  v_pos_text text;
  v_pos smallint;
  v_width_text text;
  v_height_text text;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('post_create', p_idempotency_key) i;
  if v_replay then return nullif(v_prior #>> '{}', '')::uuid; end if;

  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if not public.has_perm('community.post.create') then raise exception 'not authorized'; end if;
  -- COMM-153 enforcement, before the rate limit so a restricted member burns
  -- no budget and gets the accurate reason.
  if public.is_posting_restricted(v_uid) then raise exception 'posting_restricted'; end if;
  if not public.check_rate_limit('post_create', 20, 10) then raise exception 'rate_limited'; end if;

  v_body := regexp_replace(
    coalesce(body, ''),
    '[' || chr(1) || '-' || chr(8) || chr(11) || '-' || chr(31) || ']',
    '', 'g');
  v_body := left(btrim(v_body), 1000);

  if media is not null and jsonb_typeof(media) = 'array' then
    v_media_count := jsonb_array_length(media);
  end if;
  if v_media_count > 4 then raise exception 'at most 4 photos per post'; end if;
  if v_body = '' and v_media_count = 0 then
    raise exception 'a post needs text or at least one photo';
  end if;

  if links is not null and jsonb_typeof(links) = 'object' then
    if coalesce(links ->> 'workout_id', '') <> '' then
      v_metadata := v_metadata || jsonb_build_object('workout_id', links ->> 'workout_id');
    end if;
    if coalesce(links ->> 'achievement_id', '') <> '' then
      v_metadata := v_metadata || jsonb_build_object('achievement_id', links ->> 'achievement_id');
    end if;
    if coalesce(links ->> 'event_id', '') <> '' then
      v_metadata := v_metadata || jsonb_build_object('event_id', links ->> 'event_id');
    end if;
  end if;

  v_post_type := case
    when v_media_count > 0 and v_body = '' then 'POST_PHOTO'::public.post_type
    else 'POST_TEXT'::public.post_type
  end;

  perform set_config('app.allow_unrated_post_insert', 'on', true);
  insert into public.workout_posts (author_id, post_type, visibility, body, metadata, status, published_at)
  values (v_uid, v_post_type, coalesce(visibility, 'club'),
          nullif(v_body, ''), v_metadata, 'active', now())
  returning id into v_post_id;
  perform set_config('app.allow_unrated_post_insert', 'off', true);

  if v_media_count > 0 then
    for v_item in select value from jsonb_array_elements(media)
    loop
      if coalesce(v_item ->> 'storage_path', '') = '' then
        raise exception 'each media item needs a storage_path';
      end if;

      -- Security hunt round 7: a "position" outside smallint range or a
      -- non-numeric "width"/"height" used to reach the column cast
      -- directly and raise a raw Postgres error. Validate the shape first
      -- and fall back to this item's own index / null, the same way a
      -- missing key already did, instead of letting the type mismatch
      -- surface as an unhandled exception.
      v_pos_text := v_item ->> 'position';
      if v_pos_text is not null and v_pos_text ~ '^-?[0-9]{1,9}$'
         and v_pos_text::bigint between -32768 and 32767 then
        v_pos := v_pos_text::smallint;
      else
        v_pos := v_idx::smallint;
      end if;

      v_width_text := nullif(v_item ->> 'width', '');
      if v_width_text is not null and v_width_text !~ '^[0-9]{1,9}$' then
        v_width_text := null;
      end if;

      v_height_text := nullif(v_item ->> 'height', '');
      if v_height_text is not null and v_height_text !~ '^[0-9]{1,9}$' then
        v_height_text := null;
      end if;

      insert into public.post_media (post_id, storage_path, alt_text, decorative, "position", width, height)
      values (
        v_post_id,
        v_item ->> 'storage_path',
        nullif(v_item ->> 'alt_text', ''),
        coalesce((v_item ->> 'decorative')::boolean, false),
        v_pos,
        v_width_text::integer,
        v_height_text::integer
      );
      v_idx := v_idx + 1;
    end loop;
  end if;

  perform public.idem_complete('post_create', p_idempotency_key, to_jsonb(v_post_id));
  return v_post_id;
end $$;
revoke all on function public.post_create(text, public.post_visibility, jsonb, jsonb, uuid) from public, anon;
grant execute on function public.post_create(text, public.post_visibility, jsonb, jsonb, uuid) to authenticated;

commit;
