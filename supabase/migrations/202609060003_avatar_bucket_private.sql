begin;

-- Launch-readiness audit, finding 3: the avatar-photos bucket is public.
--
-- THE HOLE, verified live with curl and no session at all: an
-- unauthenticated GET of
-- /storage/v1/object/public/avatar-photos/{uuid}/avatar.webp returns the
-- image bytes. A public bucket is served by an endpoint that does not
-- evaluate SELECT RLS AT ALL - 202609010010's own comment says so - so the
-- three policies it added were decoration on the read side. Two consequences,
-- both real:
--
--   1. Every member's face is on the public internet to anyone who has, or
--      can guess, the URL. The URL is not a secret: it is stored in
--      profiles.avatar_url and handed to any authenticated session, which
--      since anonymous sign-in is enabled means anybody at all (see
--      202609060001).
--   2. The path is {member uuid}/avatar.{ext}, so the object listing is an
--      enumeration of member UUIDs.
--
-- 202609010010 argued that an avatar "has no independent visibility rule: it
-- belongs to profiles, and profiles already has exactly one visibility gate".
-- The premise is right and the conclusion does not follow. If the bytes
-- belong under profiles' gate, then they have to be BEHIND a gate, and a
-- public bucket is behind none. post-photos got this right from the start
-- (202608270004: private, plus a signed URL per read); this makes the avatar
-- bucket match it.
--
-- Client half, shipped with this migration (cloud.js): avatarHtml() now
-- resolves a short-lived signed URL through an avatarUrlCache, exactly the
-- photoUrlCache/resolvePhotoUrl shape post-photos already uses, and falls
-- back to the initials badge for the one paint before it arrives.
-- profiles.avatar_url keeps storing the /object/public/ form. That is
-- deliberate: it is now a stable IDENTIFIER for the object (and the carrier
-- for the ?t= cache-bust), not a fetchable URL - it will 400 if anyone hits
-- it directly, which is the entire point - and keeping the shape means every
-- already-stored row stays valid, avatarPathFromUrl() keeps parsing, and the
-- ^https?:// CHECK added in 202609060006 stays honest.

update storage.buckets set public = false where id = 'avatar-photos';

-- =====================================================================
-- The SELECT policy
-- =====================================================================
-- avatar_photos_select_all was `for select` with NO `to` clause, which means
-- `to public` - the anon role included. With the bucket public that was
-- merely unreachable; with it private it would BE the hole. Replaced, not
-- widened.
--
-- The replacement is the rule 202609010010 said it wanted and could not
-- enforce: the bytes are readable exactly as far as the profiles row they
-- belong to. Same construction post_photos_select_if_post_visible uses -
-- resolve the owner from the object's own path prefix, then ask the owning
-- row's visibility question - so the storage boundary cannot drift from the
-- table boundary.
--
--   * own object: always, unconditionally. A member must be able to see the
--     photo they just uploaded, including during onboarding before
--     is_community_member() is true.
--   * anyone else's: is_community_member() (finding 1's gate - an anonymous
--     session is `authenticated` and must not read the club) AND
--     can_view_profile_field(owner, 'visible_to_club'), which is the same
--     one resolution point profiles_read_authenticated resolves through and
--     which settles block edges in both directions on the way.
--
-- Compared by text, never by a uuid cast: an object name is arbitrary text
-- and split_part() on a name that is not '{uuid}/...' would raise on cast
-- rather than simply fail to match.
drop policy if exists avatar_photos_select_all on storage.objects;
create policy avatar_photos_select_own_or_visible on storage.objects for select to authenticated
  using (
    bucket_id = 'avatar-photos'
    and (
      split_part(storage.objects.name, '/', 1) = auth.uid()::text
      or (
        public.is_community_member()
        and exists (
          select 1 from public.profiles p
          where p.id::text = split_part(storage.objects.name, '/', 1)
            and p.deleted_at is null
            and public.can_view_profile_field(p.id, 'visible_to_club')
        )
      )
    )
  );

commit;
