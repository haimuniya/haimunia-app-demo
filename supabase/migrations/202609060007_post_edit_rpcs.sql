begin;

-- Launch-readiness audit, finding 8: post_edit_caption() and
-- post_set_visibility() were never built.
--
-- contracts.md has documented both since Phase 1 ("### post_set_visibility
-- (post_id uuid, visibility post_visibility) returns void" and
-- "### post_edit_caption(post_id uuid, body text) returns void"), sitting
-- immediately above post_delete's entry, which is marked "Shipped in
-- 202608280025". Neither function exists. cloud.js has a complete, wired,
-- fully rendered UI for both - the own-post menu's "עריכת כיתוב" and
-- "שינוי נראוּת" items, postStartCaptionEdit/postSaveCaption and
-- postStartVisibilityEdit/postApplyVisibility, both calling
-- client.rpc() by these exact names with these exact argument names - and
-- both have therefore been dead since the day they shipped: PostgREST
-- answers PGRST202 (no such function), the client shows
-- "עריכת הכיתוב נכשלה" / "שינוי הנראוּת נכשל", and the member is stuck.
--
-- Building them rather than deleting the buttons was confirmed as the
-- decision before this migration was written.
--
-- ARGUMENT NAMES ARE `post_id`, `body` and `visibility`, not the module's
-- more usual p_ prefix. That is not a slip: PostgREST resolves an RPC by its
-- named arguments, so these are the names the already-shipped client sends,
-- and they are the names contracts.md already published. post_delete
-- (post_id uuid) sits right next to them with the same unprefixed shape, so
-- the file is internally consistent either way. Renaming to p_ would ship
-- two functions nobody can call.
--
-- SHAPED AFTER comment_edit() (202608280016), not invented. That function is
-- the module's existing answer to "the author edits their own words": author
-- only, one column, every community-write gate applied, rate limited, and an
-- edit that can never be silent. Every difference below is deliberate and
-- noted.
--
-- WHAT THESE FUNCTIONS DO NOT DO, stated plainly so the next reader does not
-- over-trust them. Unlike post_comments, workout_posts DOES carry an UPDATE
-- grant and posts_update_self permits an author any column of their own row,
-- so these are not a boundary the way comment_edit is - they are the
-- supported path, and the gates below are the rule the supported path
-- follows. Making them the ONLY path would mean revoking UPDATE on
-- workout_posts, which several shipped writes still need (the two staff
-- POST_COACH promotions, pinning, the client's own optimistic patches). That
-- is a separate change with its own blast radius and is not smuggled in
-- here.

-- ---------------------------------------------------------------------------
-- post_edit_caption(post_id uuid, body text) returns void
-- ---------------------------------------------------------------------------
-- Body normalisation is byte-identical to post_create's (202608280023): the
-- same control-character class built with chr() so it does not depend on
-- LC_CTYPE, the same btrim, the same 1000-character cap. Two functions that
-- normalise the same column differently is how a post that was legal to
-- create becomes illegal to edit.
--
-- The empty-caption rule is post_create's rule, asked the other way round: a
-- post may end up with no text only if it still has a photo. Checked against
-- both media carriers, because the schema has two - post_media rows
-- (202608280005) and the legacy single workout_posts.photo_path - and
-- feed_page renders either.
--
-- An edit is a community write, so it carries the same gates a create does,
-- for the reason comment_edit's own comment gives: rewriting an old post
-- into new content is the obvious way around COMM-153's posting restriction.
-- Rate limited under its own key at the same 30-per-10-minutes comment_edit
-- uses.
--
-- No edited_at stamp, unlike comment_edit: workout_posts has no such column.
-- It has updated_at, and the workout_posts_touch BEFORE UPDATE trigger
-- (202608280004) stamps it automatically, so the edit is recorded either way
-- without adding a column and a backfill to this migration.
create or replace function public.post_edit_caption(post_id uuid, body text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_row public.workout_posts;
  v_body text;
  v_has_media boolean;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  select * into v_row from public.workout_posts where id = post_id;
  if not found then raise exception 'post not found'; end if;
  if v_row.author_id is distinct from v_uid then raise exception 'not authorized'; end if;
  if v_row.deleted_at is not null or v_row.status <> 'active' then
    raise exception 'post is no longer editable';
  end if;

  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if public.is_posting_restricted(v_uid) then raise exception 'posting_restricted'; end if;
  if not public.check_rate_limit('post_edit_caption', 30, 10) then raise exception 'rate_limited'; end if;

  v_body := regexp_replace(
    coalesce(body, ''),
    '[' || chr(1) || '-' || chr(8) || chr(11) || '-' || chr(31) || ']',
    '', 'g');
  v_body := left(btrim(v_body), 1000);

  if v_body = '' then
    v_has_media := v_row.photo_path is not null
      or exists (select 1 from public.post_media m where m.post_id = v_row.id);
    if not v_has_media then
      raise exception 'a post needs text or at least one photo';
    end if;
  end if;

  update public.workout_posts set body = nullif(v_body, '') where id = post_id;
end $$;
revoke all on function public.post_edit_caption(uuid, text) from public, anon;
grant execute on function public.post_edit_caption(uuid, text) to authenticated;

comment on function public.post_edit_caption(uuid, text) is
  'The author edits their own post''s caption. security definer; auth.uid() checked first. Argument names are post_id/body, not p_-prefixed, because PostgREST resolves by argument name and these are the names the shipped client and contracts.md already use. Refuses (all P0001): ''not authorized'' for a null caller or a non-author, ''post not found'', ''post is no longer editable'' for a deleted or non-active post, ''recovery method required'' when not is_community_member(), ''posting_restricted'' under an active COMM-153 restriction, ''rate_limited'' past 30 calls per 10 minutes under the post_edit_caption key, and ''a post needs text or at least one photo'' when the normalised body is empty and the post carries neither a post_media row nor a legacy photo_path. Body normalisation is post_create''s, exactly: control characters 0x01-0x08 and 0x0B-0x1F stripped, trimmed, capped at 1000, empty stored as NULL. Side effects: sets workout_posts.body and nothing else; updated_at is stamped by the workout_posts_touch trigger. Returns void.';

-- ---------------------------------------------------------------------------
-- post_set_visibility(post_id uuid, visibility post_visibility) returns void
-- ---------------------------------------------------------------------------
-- Typed as the enum, not as text, matching post_create's own
-- `visibility public.post_visibility` parameter and contracts.md's published
-- signature. The enum IS the validation - an unknown label is refused by
-- Postgres before the body runs - and post_create already proves PostgREST
-- casts the client's plain JSON string ("club") into it. The client only ever
-- sends the three labels POST_VISIBILITY_OPTIONS offers (club, friends,
-- only_me), but all five enum labels are accepted here because 'public' and
-- 'followers' are still carried by real rows created before 202608280004 and
-- an author must be able to move a legacy post without a migration.
--
-- Deliberately NOT gated on is_community_member(): changing who can see
-- words you already published is not a new community write, and the same
-- reasoning comment_delete and toggle_reaction give applies - a member must
-- always be able to pull their own content back.
--
-- The posting restriction is applied ONLY to a widening, which is the precise
-- version of the rule rather than the blunt one. Under a COMM-153
-- restriction, only_me -> club would be publishing during the restriction and
-- is refused; club -> only_me is the restricted member taking their own post
-- down and must always be allowed. The audience ordering below is the same
-- one the client's own visibilityLabel()/normalizeVisibility() imply, with
-- the two legacy labels folded onto their modern equivalents.
--
-- A no-op set (same value) returns early, before the restriction check, so a
-- double tap on the already-selected option is never an error.
create or replace function public.post_set_visibility(post_id uuid, visibility public.post_visibility) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_row public.workout_posts;
  v_old_rank integer;
  v_new_rank integer;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if visibility is null then raise exception 'visibility is required'; end if;

  select * into v_row from public.workout_posts where id = post_id;
  if not found then raise exception 'post not found'; end if;
  if v_row.author_id is distinct from v_uid then raise exception 'not authorized'; end if;
  if v_row.deleted_at is not null or v_row.status <> 'active' then
    raise exception 'post is no longer editable';
  end if;

  if v_row.visibility = visibility then return; end if;

  v_old_rank := case v_row.visibility
    when 'only_me' then 0
    when 'friends' then 1 when 'followers' then 1
    else 2 end;
  v_new_rank := case visibility
    when 'only_me' then 0
    when 'friends' then 1 when 'followers' then 1
    else 2 end;

  if v_new_rank > v_old_rank and public.is_posting_restricted(v_uid) then
    raise exception 'posting_restricted';
  end if;

  update public.workout_posts set visibility = post_set_visibility.visibility where id = post_id;
end $$;
revoke all on function public.post_set_visibility(uuid, public.post_visibility) from public, anon;
grant execute on function public.post_set_visibility(uuid, public.post_visibility) to authenticated;

comment on function public.post_set_visibility(uuid, public.post_visibility) is
  'The author changes their own post''s audience. security definer; auth.uid() checked first. Argument names are post_id/visibility, not p_-prefixed, because PostgREST resolves by argument name and these are the names the shipped client and contracts.md already use. The parameter is the post_visibility ENUM, exactly as post_create''s is, so an unknown label is refused by the type before the body runs; all five labels are accepted, including the legacy ''public'' and ''followers'' that pre-202608280004 rows still carry. Refuses (all P0001): ''not authorized'' for a null caller or a non-author, ''visibility is required'' for null, ''post not found'', ''post is no longer editable'' for a deleted or non-active post, and ''posting_restricted'' when a COMM-153-restricted member tries to WIDEN the audience (only_me < friends/followers < club/public). Narrowing is always allowed, restricted or not - a member must be able to take their own content down. Setting the value it already has returns early and is never an error. NOT gated on is_community_member(): re-aiming words already published is not a new community write. Side effects: sets workout_posts.visibility and nothing else, which re-evaluates posts_feed_select for every viewer. Returns void.';

commit;
