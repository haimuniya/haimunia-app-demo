# COMM-318 Member profile photo upload

Phase: 3 (post-hoc — not among the original 17 titles, no forward reference
existed anywhere in `contracts.md`/`backlog.md`; fell through the cracks
between Phase 2 and Phase 3 and never got a ticket until now)
Agent: schema (half A) / identity-privacy or engagement (half B, not yet
assigned — profile/avatar rendering touches both areas)
Status: in progress — schema half shipped (202609010010_avatar_photo.sql,
commit 96157a8), client half not started. Held deliberately: the client
half touches `avatarHtml()` and ~20 render call sites across the same
areas of `cloud.js` COMM-317's QA sweep is actively working in — starting
concurrently risks exactly the kind of collision this project has hit
before (see the Track 1 nav-menu/tabbtn coupling, and Phase 3's own
admin-analytics cluster coordination). Waiting for COMM-317 to land and
be committed before starting half B.
Attendance-blocked: no

## User outcome

A member can upload and replace their own profile photo, and see it
(instead of an initials badge) everywhere their identity already appears
in the app — feed posts, comments, the member directory, attendee lists,
coach tools, their own profile card.

## Acceptance criteria

- [x] A member can upload a photo from their own account/profile area;
  it's resized and compressed client-side (reusing the existing
  `window.HaimuniaImage.prepareImage()` helper, COMM-015 — no new
  resize/compress logic) before upload.
- [x] The upload writes to a dedicated `avatar-photos` Storage bucket,
  own-path-only via RLS, independent of `public.profiles`' existing RLS
  (no changes needed there — see Resolution below).
- [ ] `avatarHtml()`, the single avatar-rendering function used at 20+
  call sites app-wide, renders the real photo when `avatar_url` is set,
  falling back to today's initials badge otherwise — updated once, every
  call site follows (per the function's own pre-existing code comment
  anticipating this exact change).
- [ ] A member can remove their photo, reverting every surface back to
  initials.
- [ ] Re-uploading a replacement photo is visible everywhere promptly (no
  stale-cached image surviving a replace).

## Frontend states

- No photo set: initials badge (today's only behavior, unchanged).
- Uploading: a `processing` status shown next to the photo control,
  mirroring the existing PR-share photo attach flow's state machine.
- Upload failed: `"הקובץ אינו תמונה"` for a non-image file (the one
  `prepareImage()` rejection code both existing photo flows special-case),
  `"העלאת התמונה נכשלה"` for anything else — no fuller error map than
  precedent already has.
- Photo set: the real image, `object-fit:cover`, same circular
  `.avatar-badge` treatment as the initials badge, everywhere `avatarHtml()`
  is called with the URL threaded through.

## Client calls and contracts

- New: `uploadAvatarPhoto(file)` (`cloud.js`, near `uploadPreparedPhoto`) —
  calls `prepareImage(file, {maxEdge:320, thumbEdges:[], targetBytes:60*1024,
  hardCapBytes:300*1024})` (avatar-sized, not the 1600px feed-photo default),
  uploads to `avatar-photos` at `{user_id}/avatar.{ext}` with `upsert:true`,
  best-effort removes the previous path if the resolved extension changed,
  returns `getPublicUrl(...)  + "?t=" + Date.now()` (cache-busting — see
  Resolution).
- New: `saveAvatarUrl(url)` — `profiles.upsert({id, avatar_url: url})`,
  fires immediately on upload success or remove (matching
  `savePrivacyField`'s immediate-save pattern, not `saveProfile`'s
  bundled-into-form-submit pattern — a photo change is already a
  committed action the moment the bytes are in Storage).
- Changed: `avatarHtml(name, size, avatarUrl)` — new optional 3rd param;
  `saveProfile()` itself is unchanged (avatar writes are a separate path).

## Validation rules and limits

- Same MIME allow-list as `post-photos` (jpeg/png/webp), enforced by both
  the bucket's `allowed_mime_types` and `prepareImage()`'s own type
  handling.
- 2MB bucket cap (vs. `post-photos`' 5MB) — avatars are pre-compressed to
  a 300KB hard cap client-side, so this is headroom, not the binding limit.
- One object per member by convention (deterministic overwrite path), not
  enforced by a count check the way `post-photos`' 20-object cap is — there
  is no accumulation to cap.

## Migration outline (shipped, 202609010010_avatar_photo.sql)

- `avatar-photos` bucket: `public=true` (deliberate divergence from
  `post-photos`' private+signed pattern — see Resolution), 2MB limit,
  jpeg/png/webp.
- `can_write_own_avatar(p_name text)`: same ownership shape as
  `can_upload_post_photo` (real, non-deleted, invite-redeemed profile;
  object path prefixed with the caller's own uid) minus the object-count
  cap, since avatars don't accumulate.
- INSERT, UPDATE, and DELETE policies on `storage.objects`, all gated by
  `can_write_own_avatar`. UPDATE is required (not just INSERT) because the
  client uploads with `upsert:true` — Storage evaluates that as
  `INSERT ... ON CONFLICT DO UPDATE`, checked against the UPDATE policy.
  `post-photos` never needed one because it never upserts.
- A `select`-all policy, added for admin-tooling/Studio consistency only —
  not required for the feature (a public bucket serves objects
  unauthenticated, bypassing SELECT RLS entirely).
- No changes to `public.profiles` or its RLS.

## Dependencies

- `src/image.js` (COMM-015) — reused as-is, no changes.
- The account tab's existing `#communityProfile` form (`cloud.js`) — the
  new photo control lives there, alongside handle/display-name/bio.

## Resolution, schema half (202609010010, commit 96157a8)

Full reasoning is in the migration's own comments; summarized here per
this project's convention of recording the real judgment calls, not just
the acceptance criteria:

- **New bucket, public, not a `post-photos` reuse or its private+signed
  pattern.** `post-photos` is private because a workout photo's visibility
  must track its *post's* visibility, which Storage RLS is the only place
  that can enforce. An avatar has no independent visibility rule — it
  belongs to `profiles`, which already has exactly one visibility gate
  (`profiles_read_authenticated`) covering `display_name`/`handle`/`bio`
  today; a photo under the same policy isn't a new privacy surface.
  Mechanically: `avatarHtml()` is a *synchronous* function called inline
  at 20+ template-literal call sites — private+signed would force it
  async everywhere (replicating `resolvePhotoUrl()`/`photoUrlCache`'s
  render-side-effect pattern at every site, plus re-signing every ~55 min
  for anything kept on screen a long time) for no real privacy gain.
  Residual, knowingly-accepted risk: a public URL, once fetched, stays
  byte-fetchable by anyone holding it even after a row-visibility change,
  with no revocation short of overwriting/deleting the object — the same
  residual exposure this app's existing profile-field model already
  accepts for the name/bio sitting in the same row.
- **Deterministic overwrite path (`{user_id}/avatar.{ext}`, `upsert:true`)
  over `post-photos`' unique-timestamped-per-upload pattern.** An avatar
  is one-per-member; there's no reason to accumulate old ones the way
  posts' photos legitimately do. Cache-busting via a `?t=<timestamp>`
  suffix appended to the *stored* `avatar_url` (never the bare
  `getPublicUrl()` result) is load-bearing, not optional — overwriting the
  same storage path means a re-upload can silently fail to visibly update
  anywhere without it.
- **No `profiles` RLS change.** `profiles_update_self` is already
  unrestricted by column for `id = auth.uid()`, and `avatar_url` is not
  one of `protect_is_admin()`'s pinned columns. A member can already write
  it through the policy that exists today.
- **Verification convention correction, applied**: this repo's actual
  convention for verifying Storage bucket/RLS SQL is a regex assertion in
  the regular `npm test` suite (`test/community-avatar-photo.test.mjs`,
  mirroring `test/community-engagement.test.mjs`/
  `test/security-hardening.test.mjs`'s existing `post-photos` assertions),
  not pgTAP — confirmed directly against those files before writing this
  migration's own tests. pgTAP (1958/1958) stays unchanged; this migration
  adds no pgTAP-covered surface.

## Open item for the client half

Update all ~20 confirmed `avatarHtml()` call sites in the same commit, not
a subset — grouped: feed/comments (including the legacy non-`post_type`
feed branch and the optimistic just-published-post stub, two sites easy to
miss), directory/search, attendee lists, coach engagement list, the
classmates card (whose own existing comment already anticipated this
exact change), the profile card. One confirmed exception: the club-logo
fallback renders the *club's* mark from `club.name`, not a member row —
leave its call arity as `avatarHtml(name, size)`, no third argument.
