begin;

-- COMM-020. Two ownership-check triggers block a write with a plain
-- `raise exception`, which defaults to SQLSTATE P0001. Both checks are
-- authorization boundaries, not business rules: they exist only because
-- RLS cannot itself inspect a storage path's owner prefix. A boundary
-- like that should fail the same way RLS does (42501), so a caller
-- catching "permission denied" doesn't also have to know about this one
-- P0001 special case.
--
-- post_media: 202608280005_post_visibility_and_media.sql,
-- enforce_post_media_ownership(). Caught in pgTAP test
-- 0005_post_visibility_and_media_test.sql #19 ("a non-author cannot
-- attach media to the post"), which asserts 42501 and got P0001 instead.
--
-- workout_posts.photo_path: 202608270006_security_hardening.sql,
-- enforce_post_photo_ownership(). Same bug class - nothing in RLS on
-- workout_posts checks photo_path against its owner, so this trigger is
-- the only thing standing between a member and claiming someone else's
-- uploaded photo in their own post. No test exercises it today, but it
-- is the same shape of boundary as post_media's and should fail the
-- same way.
--
-- The sibling "media cannot be attached to an authorless post" /
-- "content author is no longer available" raises are left as P0001:
-- those are data-integrity checks (the referenced row's author is
-- missing), not an authorization decision about who is asking.
--
-- The errcode split below is deliberate, not a blanket swap to 42501.
-- Both checks compare a storage-path prefix against a post's real
-- author, and that comparison covers two different situations:
--   - the caller IS the post's author but supplied a path prefixed with
--     someone else's uid. RLS's own author_id = auth.uid() check would
--     have passed this row - the caller really does own the post - so
--     this is a self-inflicted data anomaly, not an authorization
--     decision about who is asking. Stays P0001. pgTAP test 0005 #18
--     ("a storage path not prefixed by the author uid is rejected by
--     the trigger", m1 posting into their own post) pins this.
--   - the caller is NOT the post's author. RLS's WITH CHECK would reject
--     this row anyway (42501); the trigger only gets there first because
--     BEFORE ROW triggers run before WITH CHECK is evaluated. That's the
--     masking failure #19 exists to catch, and it should read 42501 to
--     match what RLS would have said.

create or replace function public.enforce_post_media_ownership() returns trigger
language plpgsql set search_path = '' as $$
declare v_author uuid;
begin
  select author_id into v_author from public.workout_posts where id = new.post_id;
  if v_author is null then
    raise exception 'media cannot be attached to an authorless post';
  end if;
  if split_part(new.storage_path, '/', 1) <> v_author::text then
    if v_author is distinct from auth.uid() then
      raise exception 'media path must belong to the post author' using errcode = '42501';
    else
      raise exception 'media path must belong to the post author';
    end if;
  end if;
  return new;
end $$;

create or replace function public.enforce_post_photo_ownership() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.photo_path is not null and split_part(new.photo_path, '/', 1) <> new.author_id::text then
    if new.author_id is distinct from auth.uid() then
      raise exception 'photo path must belong to the post author' using errcode = '42501';
    else
      raise exception 'photo path must belong to the post author';
    end if;
  end if;
  return new;
end $$;

commit;
