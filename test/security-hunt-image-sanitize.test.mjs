// Security hunt, round 2 (2026-09-11), file-upload security agent.
// Regression coverage for supabase/functions/_shared/imageSanitize.mjs, the
// byte-level logic behind the sanitize_upload Edge Function
// (202609110003_sanitize_upload_trigger.sql). Confirmed live against real
// local Storage: a direct authenticated upload with a spoofed
// Content-Type: image/jpeg header got raw HTML bytes past the bucket's
// allowed_mime_types allowlist, and a real JPEG with GPS EXIF was stored
// and later downloaded byte-for-byte untouched by a second member -
// src/image.js's "images only" and "GPS does not survive the round trip"
// guarantees hold only for the one blessed browser upload path. This file
// tests the shared module directly (no live Storage/Edge Function needed)
// so the fix is verified on every `npm test` run, not only when the local
// Supabase stack is up.
import { test } from "node:test";
import assert from "node:assert";
import {
  detectImageType,
  stripJpegMetadata,
  stripPngMetadata,
  stripWebpMetadata,
  sanitizeImageBytes,
} from "../supabase/functions/_shared/imageSanitize.mjs";

function u32be(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function u32le(n) { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]; }
function pngChunk(type, data) {
  const t = [...type].map((c) => c.charCodeAt(0));
  return [...u32be(data.length), ...t, ...data, 0, 0, 0, 0]; // CRC not validated by our reader, zeros are fine
}
function webpChunk(fourcc, data) {
  const pad = data.length % 2 ? [0] : [];
  return [...[...fourcc].map((c) => c.charCodeAt(0)), ...u32le(data.length), ...data, ...pad];
}
function buildJpegWithExif() {
  const soi = [0xff, 0xd8];
  const app0 = [0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46]; // JFIF, must survive
  const app1 = [0xff, 0xe1, 0x00, 0x0a, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xaa, 0xbb]; // fake EXIF payload
  const sos = [0xff, 0xda, 0x00, 0x02];
  const entropy = [0x11, 0x22, 0x33];
  const eoi = [0xff, 0xd9];
  return new Uint8Array([...soi, ...app0, ...app1, ...sos, ...entropy, ...eoi]);
}
function buildPngWithExif() {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = pngChunk("IHDR", new Array(13).fill(0));
  const exif = pngChunk("eXIf", [1, 2, 3, 4]);
  const iend = pngChunk("IEND", []);
  return new Uint8Array([...sig, ...ihdr, ...exif, ...iend]);
}
function buildWebpWithExif() {
  const vp8 = webpChunk("VP8 ", [9, 9, 9, 9]);
  const exif = webpChunk("EXIF", [5, 5, 5]);
  const body = [...vp8, ...exif];
  const riffSize = 4 + body.length;
  return new Uint8Array([0x52, 0x49, 0x46, 0x46, ...u32le(riffSize), 0x57, 0x45, 0x42, 0x50, ...body]);
}

test("detectImageType recognizes real JPEG/PNG/WebP signatures and rejects everything else - closes the spoofed-Content-Type finding", () => {
  assert.strictEqual(detectImageType(buildJpegWithExif()), "jpeg");
  assert.strictEqual(detectImageType(buildPngWithExif()), "png");
  assert.strictEqual(detectImageType(buildWebpWithExif()), "webp");
  const disguisedHtml = new TextEncoder().encode("<html><body><script>alert(document.cookie)</script>");
  assert.strictEqual(detectImageType(disguisedHtml), null, "raw HTML bytes are never treated as an image, however the uploader labels them");
});

test("sanitizeImageBytes refuses non-image bytes regardless of any claimed content type", () => {
  const disguisedHtml = new TextEncoder().encode("<html>not a photo</html>");
  const result = sanitizeImageBytes(disguisedHtml);
  assert.strictEqual(result.ok, false, "the caller's declared Content-Type never enters this function - only the bytes do");
});

test("stripJpegMetadata removes the EXIF (APP1) segment but keeps the image intact and valid", () => {
  const jpeg = buildJpegWithExif();
  const stripped = stripJpegMetadata(jpeg);
  assert.strictEqual(stripped[0], 0xff, "still starts with SOI");
  assert.strictEqual(stripped[1], 0xd8);
  assert.strictEqual(stripped[stripped.length - 2], 0xff, "still ends with EOI");
  assert.strictEqual(stripped[stripped.length - 1], 0xd9);
  let sawExif = false;
  for (let i = 0; i < stripped.length - 1; i++) {
    if (stripped[i] === 0xff && stripped[i + 1] === 0xe1) sawExif = true;
  }
  assert.ok(!sawExif, "no APP1/EXIF marker survives - this is the GPS/EXIF leak this fix closes");
  assert.ok(stripped.length < jpeg.length, "the file actually got smaller");
});

test("stripPngMetadata removes the eXIf ancillary chunk and leaves IHDR/IEND intact", () => {
  const png = buildPngWithExif();
  const stripped = stripPngMetadata(png);
  const view = new DataView(stripped.buffer, stripped.byteOffset, stripped.byteLength);
  let offset = 8;
  const types = [];
  while (offset + 8 <= stripped.length) {
    const len = view.getUint32(offset);
    const type = String.fromCharCode(stripped[offset + 4], stripped[offset + 5], stripped[offset + 6], stripped[offset + 7]);
    types.push(type);
    offset += 12 + len;
    if (type === "IEND") break;
  }
  assert.deepStrictEqual(types, ["IHDR", "IEND"], "eXIf is gone, IHDR and IEND survive untouched");
});

test("stripWebpMetadata removes the EXIF chunk and rewrites a correct RIFF size", () => {
  const webp = buildWebpWithExif();
  const stripped = stripWebpMetadata(webp);
  const view = new DataView(stripped.buffer, stripped.byteOffset, stripped.byteLength);
  let offset = 12;
  const fourccs = [];
  while (offset + 8 <= stripped.length) {
    const fourcc = String.fromCharCode(stripped[offset], stripped[offset + 1], stripped[offset + 2], stripped[offset + 3]);
    const size = view.getUint32(offset + 4, true);
    fourccs.push(fourcc);
    offset += 8 + size + (size % 2);
  }
  assert.deepStrictEqual(fourccs, ["VP8 "], "the EXIF chunk is gone, the real image chunk survives");
  assert.strictEqual(view.getUint32(4, true), stripped.length - 8, "RIFF size field is recomputed, not left stale");
});

test("sanitizeImageBytes end-to-end: a real JPEG with GPS-shaped EXIF comes back verified and metadata-free", () => {
  const result = sanitizeImageBytes(buildJpegWithExif());
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.contentType, "image/jpeg");
  let sawExif = false;
  for (let i = 0; i < result.bytes.length - 1; i++) {
    if (result.bytes[i] === 0xff && result.bytes[i + 1] === 0xe1) sawExif = true;
  }
  assert.ok(!sawExif, "the EXIF segment that would have carried GPS coordinates is gone from the object that gets re-uploaded");
});
