begin;

-- COMM-318. Member profile photo upload — the storage half.
--
-- profiles.avatar_url has existed since the foundation migration and is
-- already selected in every profile-carrying query, but nothing has ever
-- written to it: no bucket, no RLS, no upload path. This closes that gap
-- on the storage side only; avatarHtml() (cloud.js) still needs its own
-- follow-up change to actually render a photo instead of initials, and
-- nothing here depends on that landing first.
--
-- Deliberately a NEW bucket, not a reuse of post-photos, and deliberately
-- PUBLIC where post-photos is private:
--
-- post-photos is private + signed-URL because a workout photo's
-- visibility must track its *post's* visibility (post_visible_to_viewer),
-- which can change per post, per viewer — Storage RLS is the only place
-- that rule can live, since a photo's bytes have no visibility of their
-- own. An avatar has no independent visibility rule: it belongs to
-- profiles, and profiles already has exactly one visibility gate
-- (profiles_read_authenticated) covering display_name/handle/bio today.
-- A photo sitting next to those fields under the same policy isn't a new
-- privacy surface to protect — the row already decides who sees it.
--
-- Also deliberately NOT touching public.profiles or its RLS: the
-- existing profiles_update_self policy (invite_gate migration) is
-- `using (id = auth.uid()) with check (id = auth.uid())` — unrestricted
-- by column — and avatar_url is not one of the columns
-- protect_is_admin()'s trigger pins back to its old value. A member can
-- already write avatar_url through the policy that exists today —
-- nothing to add here.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('avatar-photos', 'avatar-photos', true, 2097152, array['image/jpeg','image/png','image/webp'])
  on conflict (id) do nothing;

-- Same ownership shape as can_upload_post_photo (a real profile, not
-- deleted, invite redeemed, and the object's own path prefixed with the
-- caller's uid) but with no object-count cap: an avatar is one-per-member
-- by convention (the client always uploads to
-- {auth.uid()}/avatar.{ext} with upsert:true), unlike post-photos where
-- many photos legitimately accumulate per member across many posts.
create or replace function public.can_write_own_avatar(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
    and split_part(p_name, '/', 1) = auth.uid()::text
    and exists (
      select 1 from public.profiles p join public.invite_redemptions ir on ir.user_id = p.id
      where p.id = auth.uid() and p.deleted_at is null
    );
$$;
revoke all on function public.can_write_own_avatar(text) from public, anon;
grant execute on function public.can_write_own_avatar(text) to authenticated;

-- Both INSERT and UPDATE are required, not just INSERT: the client
-- uploads with upsert:true (an avatar is overwritten in place, never
-- accumulated), and Storage evaluates a real object's upsert as
-- INSERT ... ON CONFLICT DO UPDATE — the conflict path is checked
-- against the UPDATE policy. post-photos never needed one because it
-- never upserts (upload(..., { upsert: false })).
create policy avatar_photos_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'avatar-photos' and public.can_write_own_avatar(name));
create policy avatar_photos_update_own on storage.objects for update to authenticated
  using (bucket_id = 'avatar-photos' and public.can_write_own_avatar(name))
  with check (bucket_id = 'avatar-photos' and public.can_write_own_avatar(name));
-- Lets a member clear their own photo, and lets the client clean up the
-- old object after a successful re-upload to a different extension (rare
-- — only when prepareImage()'s resolved output type changes between
-- uploads).
create policy avatar_photos_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'avatar-photos' and public.can_write_own_avatar(name));
-- Not required for the feature itself: a public bucket serves objects
-- through the unauthenticated /object/public/ endpoint, which does not
-- evaluate SELECT RLS at all. Added only so client.storage.from(...).list()/
-- .download() and the Studio dashboard behave predictably for any future
-- admin tooling (an orphan sweep analogous to list_orphaned_post_photos).
create policy avatar_photos_select_all on storage.objects for select
  using (bucket_id = 'avatar-photos');

commit;
