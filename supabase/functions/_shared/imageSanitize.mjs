// Security hunt, round 2 (2026-09-11), file-upload security agent.
//
// THE FINDING (two, sharing one root cause). src/image.js's decode -> canvas
// -> re-encode pipeline genuinely strips EXIF/GPS metadata and genuinely
// requires a real decodable image - but only for the one blessed browser code
// path (composer/avatar/PR-share). Both properties are enforced nowhere else.
// Confirmed live against the real local Storage container, bypassing that
// pipeline entirely with a direct authenticated upload (same thing any member
// can already do from their own devtools console, since the anon key and
// their own session ship in every installed copy of the app):
//   1. A file containing raw HTML/script bytes, uploaded with a spoofed
//      `Content-Type: image/jpeg` header, was accepted - the bucket allowlist
//      (post-photos/avatar-photos, both image/jpeg|png|webp only) checks the
//      CALLER-DECLARED header, not the bytes.
//   2. A real JPEG carrying GPS EXIF, uploaded the same way, was stored
//      byte-for-byte untouched and then downloaded fully intact by a SECOND
//      member through the app's own normal authenticated-read path - the
//      "GPS does not survive the round trip" privacy property image.js's own
//      header comment promises is a client-side behavior with no server-side
//      backstop.
//
// THE FIX. This module is the shared, dependency-free byte-level logic for a
// real server-side backstop: verify the upload is actually one of the three
// allowed image formats by its own magic bytes (not the header the uploader
// chose to send), and strip the metadata segments/chunks that can carry
// EXIF/GPS/XMP from each of the three formats this module's two buckets
// allow. It is imported by both sides of the fix:
//   - supabase/functions/sanitize_upload/ (Deno): the real enforcement,
//     invoked after every write to post-photos/avatar-photos (see
//     202609110003_sanitize_upload_trigger.sql).
//   - test/security-hunt-image-sanitize.test.mjs (Node): the regression
//     test, run as part of the normal `npm test` gate rather than requiring
//     a live edge-function invocation to verify the byte manipulation itself.
// Deliberately plain, portable JS (Uint8Array/DataView only, no Buffer, no
// npm/esm.sh import) so the exact same file runs unmodified under Deno and
// under Node.

const JPEG_SOI = 0xd8;
const JPEG_EOI = 0xd9;
const JPEG_SOS = 0xda;
// APP1 (EXIF, and often XMP) and APP13 (Photoshop IRB / IPTC) are the two
// segment types that actually carry the metadata this fix exists to remove.
// APP0 (JFIF) is left alone: some decoders expect it, and it never carries
// GPS/EXIF.
const JPEG_STRIP_MARKERS = new Set([0xe1, 0xed]);
const PNG_STRIP_CHUNKS = new Set(["eXIf", "tEXt", "zTXt", "iTXt"]);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function detectImageType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return "png";
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // "RIFF"
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // "WEBP"
  ) return "webp";
  return null;
}

function concatChunks(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export function stripJpegMetadata(bytes) {
  const chunks = [bytes.subarray(0, 2)]; // SOI
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      // Malformed / already inside entropy-coded data with no marker where
      // one was expected - copy the remainder verbatim rather than guess.
      chunks.push(bytes.subarray(offset));
      offset = bytes.length;
      break;
    }
    const marker = bytes[offset + 1];
    if (marker === JPEG_EOI) {
      chunks.push(bytes.subarray(offset, offset + 2));
      offset += 2;
      break;
    }
    if (marker === JPEG_SOS) {
      // Entropy-coded scan data follows with no further length-prefixed
      // markers (restart markers aside, which need no special handling
      // here) - copy everything remaining and stop.
      chunks.push(bytes.subarray(offset));
      offset = bytes.length;
      break;
    }
    // Markers with no length field: 0x01 (TEM) and 0xD0-0xD7 (restart).
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      chunks.push(bytes.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    if (offset + 3 >= bytes.length) {
      chunks.push(bytes.subarray(offset));
      break;
    }
    const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3]; // includes the 2 length bytes
    const segEnd = Math.min(offset + 2 + segLen, bytes.length);
    if (!JPEG_STRIP_MARKERS.has(marker)) {
      chunks.push(bytes.subarray(offset, segEnd));
    }
    offset = segEnd;
  }
  return concatChunks(chunks);
}

export function stripPngMetadata(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [bytes.subarray(0, 8)]; // signature
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const len = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const chunkEnd = Math.min(offset + 12 + len, bytes.length);
    if (!PNG_STRIP_CHUNKS.has(type)) {
      chunks.push(bytes.subarray(offset, chunkEnd));
    }
    offset = chunkEnd;
    if (type === "IEND") break;
  }
  return concatChunks(chunks);
}

export function stripWebpMetadata(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kept = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const size = view.getUint32(offset + 4, true);
    const padded = size + (size % 2);
    const chunkEnd = Math.min(offset + 8 + padded, bytes.length);
    if (fourcc !== "EXIF" && fourcc !== "XMP ") {
      kept.push(bytes.subarray(offset, chunkEnd));
    }
    offset = chunkEnd;
  }
  const body = concatChunks(kept);
  const out = new Uint8Array(12 + body.length);
  out.set(bytes.subarray(0, 4), 0); // "RIFF"
  out.set(body, 12);
  out[8] = 0x57; out[9] = 0x45; out[10] = 0x42; out[11] = 0x50; // "WEBP"
  const outView = new DataView(out.buffer);
  outView.setUint32(4, 4 + body.length, true); // RIFF size excludes the 8-byte RIFF header itself
  return out;
}

// Returns { ok:false } when bytes don't start with a real image-format
// signature regardless of any Content-Type header the uploader claimed -
// closes finding 1. Returns { ok:true, bytes, contentType } with metadata
// segments/chunks removed - closes finding 2. contentType is derived from
// the verified bytes, never from caller input.
export function sanitizeImageBytes(bytes) {
  const type = detectImageType(bytes);
  if (!type) return { ok: false };
  if (type === "jpeg") return { ok: true, bytes: stripJpegMetadata(bytes), contentType: "image/jpeg" };
  if (type === "png") return { ok: true, bytes: stripPngMetadata(bytes), contentType: "image/png" };
  return { ok: true, bytes: stripWebpMetadata(bytes), contentType: "image/webp" };
}
