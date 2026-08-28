# COMM-103 Composer: photo attach up to four with alt text

Phase: 1
Agent: posts
Status: todo
Attendance-blocked: no

## User outcome

A member can add up to four photos to a post, each with a short description
for screen readers.

## Acceptance criteria

- [ ] "Add Photo" adds a tile. Maximum four tiles.
- [ ] Each tile has an alt-text field and a remove control.
- [ ] Publish is blocked until each photo has alt text or an explicit
  "decorative" checkbox is ticked.
- [ ] Photos pass through `prepareImage` from COMM-015 before upload.
- [ ] Upload failure on one photo keeps the composer open and marks that tile
  failed with a retry.
- [ ] On publish, `post_media` rows are created with `position` and
  `alt_text`.
- [ ] The picker control has visible text, not an icon alone.

## Frontend states

- Empty: "Add Photo" only.
- Loading: per-tile spinner while processing and uploading.
- Error: per-tile "Upload failed, retry" and a composer-level message if all
  fail.
- Populated: thumbnails with alt-text fields.

## Client calls and contracts

- Storage upload path as used by `publishWorkout`.
- `prepareImage(file, opts)` from COMM-015.
- Media array passed to `post_create`.

## Validation rules and limits

- Max 4 photos. Alt text max 200 characters.
- Reject non-image files with a clear message.

## Migration outline

- None. Uses COMM-002.

## Dependencies

- COMM-002, COMM-015, COMM-102.
