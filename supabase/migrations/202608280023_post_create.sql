begin;

-- COMM-102 / COMM-103, the missing post write path.
--
-- post_create did not exist in the database at all. cloud.js publishComposer()
-- calls rpc("post_create", { body, visibility, media, links }) and the compose
-- flow failed end to end without it. This is the one consistent server write
-- path for a member-authored POST_TEXT or POST_PHOTO, the same role
-- add_post_comment plays for comments.
--
-- SECURITY DEFINER for the usual reason: it writes public.workout_posts and
-- public.post_media directly, so it runs past posts_insert_self and
-- post_media_insert_author rather than through them. Every gate those policies
-- carry is therefore re-checked here by hand, in the same order the policy and
-- add_post_comment use:
--   1. a real caller
--   2. is_community_member()          -> recovery method set + invite redeemed
--   3. has_perm('community.post.create')
--   4. not is_posting_restricted()    -> COMM-153 speech sanction
--   5. a per-action rate limit, so a scripted client cannot flood the feed
--      the same way add_post_comment / toggle_reaction / ach_claim are capped
-- The ownership trigger on post_media (enforce_post_media_ownership) and the
-- alt-text normaliser (post_media_normalize_alt, 202608280022) still fire on
-- the inserts below, because triggers run regardless of definer rights - that
-- is what actually pins each storage_path to the author's own uid prefix and
-- keeps "decorative" and "has alt text" from disagreeing in one row.
--
-- The media item shape is the one the composer sends and the one 202608280022
-- documented: { storage_path, alt_text, decorative, position, width, height }.
-- decorative is passed straight through; the trigger owns the alt_text rule so
-- this function does not reconcile a decorative item that still carries text.
--
-- POST_CREATED: there is no server-side product-event bus in this repo (the
-- bus is window.HaimuniaEvents, client only). publishComposer() emits
-- POST_CREATED itself after this RPC returns, exactly the way addComment emits
-- COMMENT_CREATED and react emits REACTION_CREATED after their RPCs. Nothing is
-- emitted from inside this function because there is nowhere server-side to
-- emit to; when the notification trigger set lands (follow-up 3) it hangs off
-- an AFTER INSERT on workout_posts, not off a call from here.

create or replace function public.post_create(
  body text,
  visibility public.post_visibility,
  media jsonb,
  links jsonb
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
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if not public.has_perm('community.post.create') then raise exception 'not authorized'; end if;
  -- COMM-153 enforcement, before the rate limit so a restricted member burns
  -- no budget and gets the accurate reason.
  if public.is_posting_restricted(v_uid) then raise exception 'posting_restricted'; end if;
  if not public.check_rate_limit('post_create', 20, 10) then raise exception 'rate_limited'; end if;

  -- Control characters stripped, trimmed, then capped - the same normalisation
  -- cleanPostBody() does on the client, repeated here because the client guard
  -- is not the boundary. The stripped class is 0x01-0x08 and 0x0B-0x1F: tab
  -- (0x09) and newline (0x0A) are kept, since the card renders the body
  -- white-space: pre-wrap, and a text value can never carry 0x00. The bracket
  -- expression is built with chr() rather than written as [[:cntrl:]] so it
  -- does not depend on the database LC_CTYPE, and not [[:print:]] so a
  -- C-locale build cannot strip every Hebrew character.
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

  -- links is optional { workout_id, achievement_id, event_id }. The present
  -- keys are merged into metadata as top-level ids, which is where feed_page
  -- (202608280019) already looks for event_id and challenge_id.
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

  -- Matches the client's optimistic rule: photo-only is POST_PHOTO, anything
  -- with text (with or without photos) is POST_TEXT. The workout_posts
  -- default_post_type trigger would otherwise pick this, but it is set
  -- explicitly so a caption-plus-photo post is not misfiled as POST_PHOTO.
  v_post_type := case
    when v_media_count > 0 and v_body = '' then 'POST_PHOTO'::public.post_type
    else 'POST_TEXT'::public.post_type
  end;

  insert into public.workout_posts (author_id, post_type, visibility, body, metadata, status, published_at)
  values (v_uid, v_post_type, coalesce(visibility, 'club'),
          nullif(v_body, ''), v_metadata, 'active', now())
  returning id into v_post_id;

  if v_media_count > 0 then
    for v_item in select value from jsonb_array_elements(media)
    loop
      if coalesce(v_item ->> 'storage_path', '') = '' then
        raise exception 'each media item needs a storage_path';
      end if;
      insert into public.post_media (post_id, storage_path, alt_text, decorative, "position", width, height)
      values (
        v_post_id,
        v_item ->> 'storage_path',
        nullif(v_item ->> 'alt_text', ''),
        coalesce((v_item ->> 'decorative')::boolean, false),
        coalesce((v_item ->> 'position')::smallint, v_idx::smallint),
        nullif(v_item ->> 'width', '')::integer,
        nullif(v_item ->> 'height', '')::integer
      );
      v_idx := v_idx + 1;
    end loop;
  end if;

  return v_post_id;
end $$;

revoke all on function public.post_create(text, public.post_visibility, jsonb, jsonb) from public, anon;
grant execute on function public.post_create(text, public.post_visibility, jsonb, jsonb) to authenticated;

commit;
