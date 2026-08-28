# COMM-015 Client-side image resize and compress before upload

Phase: 0
Agent: platform
Status: todo
Attendance-blocked: no

## User outcome

A member can attach a phone photo to a post and it uploads fast, without the
app shipping a huge file.

## Acceptance criteria

- [ ] A helper `prepareImage(file, opts)` returns a resized and compressed
  blob plus width and height.
- [ ] Default output: longest edge 1600 px, JPEG or WebP quality near 0.8,
  target under 400 KB.
- [ ] The helper also produces a thumbnail at longest edge 400 px.
- [ ] EXIF orientation is respected. Location EXIF is stripped.
- [ ] Non-image files are rejected before upload.
- [ ] Uses `createImageBitmap` and `OffscreenCanvas` where available, with a
  `<canvas>` fallback. No dependency, no build step.
- [ ] An aggregate per-account byte budget check is exposed for the photo
  quota work.

## Frontend states

- Loading: a spinner on the attachment tile while processing.
- Error: "This file is not an image" or "This image could not be processed".

## Client calls and contracts

- No RPC. Consumes the Storage upload path already used by `publishWorkout`.

## Validation rules and limits

- Reject files over 25 MB before processing.
- Output hard cap 1 MB. Over that, drop quality once, then reject.

## Migration outline

- None. The photo quota is object-count based today (migration 202608270006).
  A byte-budget column is a later schema ticket, out of Phase 0 scope.

## Dependencies

- None.
