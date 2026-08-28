// COMM-015. Client-side image resize and compression.
//
// jsdom has no canvas, so the encode/decode seam is exercised through
// the injectable backend prepareImage() already accepts - the same seam
// a later ticket would use to move the work into a worker. Everything
// above that seam (validation, sizing, the quality ladder, the hard cap,
// the byte budget) is the real shipped code.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootApp } from "./helpers/boot.mjs";

const KB = 1024;

// An object built inside the jsdom window carries that realm's
// Object.prototype, which deepStrictEqual reads as a mismatch even when
// the data agrees. JSON re-homes it in this realm.
const plain = (v) => JSON.parse(JSON.stringify(v));

// A stub backend. bytesFor(width, height, quality) decides how big the
// encoded blob comes out, which is what lets a test drive the quality
// ladder deterministically instead of hoping a real JPEG lands on a
// particular size.
function makeBackend(opts) {
  const o = opts || {};
  const calls = [];
  const backend = {
    calls,
    async decode() {
      if (o.decodeFails) throw new Error("could not decode");
      const width = "width" in o ? o.width : 4000;
      const height = "height" in o ? o.height : 3000;
      return { width, height, closed: false, close() { this.closed = true; } };
    },
    createCanvas(width, height) { return { width, height, getContext: () => ({ drawImage() {} }) }; },
    draw() {},
    async encode(canvas, type, quality) {
      calls.push({ width: canvas.width, height: canvas.height, type, quality });
      const size = o.bytesFor ? o.bytesFor(canvas.width, canvas.height, quality) : 100 * KB;
      return { size, type };
    },
    supportsType(type) { return o.supports ? o.supports.indexOf(type) >= 0 : true; },
    close(bitmap) { if (bitmap && bitmap.close) bitmap.close(); },
  };
  return backend;
}

function imageFile(overrides) {
  return { type: "image/jpeg", size: 4 * 1024 * 1024, name: "photo.jpg", ...(overrides || {}) };
}

test("the sizing helper caps the long edge, keeps the aspect ratio, and never upscales", async () => {
  const window = await bootApp();
  const fit = window.HaimuniaImage.fitDimensions;

  assert.deepStrictEqual(plain(fit(4000, 3000, 1600)), { width: 1600, height: 1200, scaled: true });
  assert.deepStrictEqual(plain(fit(3000, 4000, 1600)), { width: 1200, height: 1600, scaled: true });
  // Already small enough: left exactly as it is, not stretched up to the cap.
  assert.deepStrictEqual(plain(fit(800, 600, 1600)), { width: 800, height: 600, scaled: false });
  assert.deepStrictEqual(plain(fit(1600, 1200, 1600)), { width: 1600, height: 1200, scaled: false });
  // A panorama must not round its short edge to zero.
  const pano = fit(8000, 3, 400);
  assert.strictEqual(pano.width, 400);
  assert.ok(pano.height >= 1, "the short edge floors at 1 px, never 0");
});

test("a non-image file is rejected before anything is decoded", async () => {
  const window = await bootApp();
  const img = window.HaimuniaImage;
  const backend = makeBackend();

  await assert.rejects(() => img.prepareImage({ type: "application/pdf", size: 1000 }, { backend }), (err) => {
    assert.strictEqual(err.code, "not_an_image");
    return true;
  });
  await assert.rejects(() => img.prepareImage(null, { backend }), (err) => err.code === "not_an_image");
  await assert.rejects(() => img.prepareImage({ size: 1000 }, { backend }), (err) => err.code === "not_an_image");
  assert.strictEqual(backend.calls.length, 0, "nothing may be encoded for a rejected file");
});

test("a file over 25 MB is rejected before processing", async () => {
  const window = await bootApp();
  const img = window.HaimuniaImage;
  assert.strictEqual(img.MAX_INPUT_BYTES, 25 * 1024 * 1024);
  await assert.rejects(
    () => img.prepareImage(imageFile({ size: 26 * 1024 * 1024 }), { backend: makeBackend() }),
    (err) => err.code === "file_too_large"
  );
  // One byte under the limit still goes through.
  const ok = await img.prepareImage(imageFile({ size: img.MAX_INPUT_BYTES }), { backend: makeBackend() });
  assert.ok(ok.render.blob);
});

test("a photo produces a 1600 px render plus 400 and 200 px thumbnails, all from the decoded source", async () => {
  const window = await bootApp();
  const img = window.HaimuniaImage;
  const backend = makeBackend({ width: 4032, height: 3024, bytesFor: () => 120 * KB });

  const out = await img.prepareImage(imageFile(), { backend });

  assert.strictEqual(out.render.width, 1600);
  assert.strictEqual(out.render.height, 1200);
  assert.deepStrictEqual(Array.from(out.thumbnails, (t) => t.edge), [400, 200]);
  assert.strictEqual(out.thumbnails[0].width, 400);
  assert.strictEqual(out.thumbnails[0].height, 300);
  assert.strictEqual(out.thumbnails[1].width, 200);
  assert.strictEqual(out.thumbnail, out.thumbnails[0], "thumbnail is the 400 px entry the ticket asks for");
  assert.deepStrictEqual(plain(out.source), { width: 4032, height: 3024, bytes: 4 * 1024 * 1024, type: "image/jpeg" });
  // Every render is drawn from the same decoded source, so a thumbnail is
  // never a re-compression of the already-compressed render: each width
  // is encoded as its own contiguous run off the one decoded bitmap.
  const widthRuns = backend.calls.map((c) => c.width).filter((w, i, all) => i === 0 || all[i - 1] !== w);
  assert.deepStrictEqual(widthRuns, [1600, 400, 200]);
});

test("the decoded bitmap is released even when encoding blows up", async () => {
  const window = await bootApp();
  const img = window.HaimuniaImage;
  let bitmap = null;
  const backend = makeBackend();
  const realDecode = backend.decode;
  backend.decode = async function () { bitmap = await realDecode.call(this); return bitmap; };
  backend.encode = async () => null;

  await assert.rejects(() => img.prepareImage(imageFile(), { backend }), (err) => err.code === "encode_failed");
  assert.strictEqual(bitmap.closed, true, "a failed encode must still close the bitmap");
});

test("the quality ladder steps down until the render is under the 400 KB target", async () => {
  const window = await bootApp();
  const img = window.HaimuniaImage;
  // Size falls with quality: 0.8 -> 800 KB, 0.7 -> 700, 0.6 -> 600, 0.5 -> 500.
  const backend = makeBackend({
    bytesFor: (w, h, q) => (w === 1600 ? Math.round(q * 1000) * KB : 20 * KB),
  });

  const out = await img.prepareImage(imageFile(), { backend, hardCapBytes: 10 * 1024 * KB });

  const renderCalls = backend.calls.filter((c) => c.width === 1600);
  assert.deepStrictEqual(renderCalls.map((c) => c.quality), [0.8, 0.7, 0.6, 0.5]);
  assert.strictEqual(out.render.quality, 0.5, "the ladder stops at the minimum quality, it does not go lower");
  assert.strictEqual(out.render.bytes, 500 * KB);
});

test("a render already under target is encoded once, at the default quality", async () => {
  const window = await bootApp();
  const img = window.HaimuniaImage;
  const backend = makeBackend({ bytesFor: () => 90 * KB });
  const out = await img.prepareImage(imageFile(), { backend });
  assert.strictEqual(out.render.quality, 0.8);
  assert.strictEqual(backend.calls.filter((c) => c.width === 1600).length, 1);
});

test("past the hard cap the helper drops quality once, then rejects", async () => {
  const window = await bootApp();
  const img = window.HaimuniaImage;
  assert.strictEqual(img.HARD_CAP_BYTES, 1024 * KB);

  // Nothing ever gets under the cap, whatever the quality.
  const stubborn = makeBackend({ bytesFor: () => 5 * 1024 * KB });
  await assert.rejects(() => img.prepareImage(imageFile(), { backend: stubborn }), (err) => err.code === "image_too_large");
  const qualities = stubborn.calls.map((c) => c.quality);
  assert.strictEqual(qualities[qualities.length - 1], 0.4, "the last attempt is the one-off last-resort quality");

  // The last-resort drop is enough here, so the image is kept.
  const rescued = makeBackend({ bytesFor: (w, h, q) => (q <= 0.4 ? 900 * KB : 2 * 1024 * KB) });
  const out = await img.prepareImage(imageFile(), { backend: rescued });
  assert.strictEqual(out.render.quality, 0.4);
  assert.strictEqual(out.render.bytes, 900 * KB);
});

test("output type prefers webp and falls back to jpeg, always inside the bucket's allow-list", async () => {
  const window = await bootApp();
  const img = window.HaimuniaImage;
  // The post-photos bucket accepts only these three (migration 202608270004).
  for (const type of img.OUTPUT_TYPES) assert.ok(["image/jpeg", "image/png", "image/webp"].includes(type));

  const webp = await img.prepareImage(imageFile(), { backend: makeBackend({ supports: ["image/webp", "image/jpeg"] }) });
  assert.strictEqual(webp.type, "image/webp");
  assert.strictEqual(webp.render.type, "image/webp");

  const jpeg = await img.prepareImage(imageFile(), { backend: makeBackend({ supports: ["image/jpeg"] }) });
  assert.strictEqual(jpeg.type, "image/jpeg");

  // A caller can pin the type, but only to one the bucket accepts.
  const pinned = await img.prepareImage(imageFile(), { backend: makeBackend({ supports: ["image/webp"] }), type: "image/jpeg" });
  assert.strictEqual(pinned.type, "image/jpeg");
  const ignored = await img.prepareImage(imageFile(), { backend: makeBackend({ supports: ["image/webp"] }), type: "image/gif" });
  assert.strictEqual(ignored.type, "image/webp", "an unsupported request falls back rather than uploading something Storage refuses");
});

test("a decode failure surfaces as decode_failed, and a zero-dimension decode does not silently produce an empty canvas", async () => {
  const window = await bootApp();
  const img = window.HaimuniaImage;
  await assert.rejects(() => img.prepareImage(imageFile(), { backend: makeBackend({ decodeFails: true }) }), (err) => err.code === "decode_failed");
  await assert.rejects(() => img.prepareImage(imageFile(), { backend: makeBackend({ width: 0, height: 0 }) }), (err) => err.code === "decode_failed");
});

test("EXIF orientation is applied on decode, and the canvas re-encode is what strips the location tag", () => {
  const src = fs.readFileSync(new URL("../src/image.js", import.meta.url), "utf8");
  // createImageBitmap ignores the EXIF orientation tag unless asked. This
  // is not observable in jsdom, which has no createImageBitmap at all, so
  // it is pinned against the source.
  assert.match(src, /imageOrientation:\s*"from-image"/);
  assert.match(src, /GPS/, "the module must say why re-encoding is a privacy property, not an accident");
  // The helper must never hand the original File through untouched -
  // that would carry the EXIF straight to Storage.
  assert.doesNotMatch(src, /return\s+file\b/);
});

test("the per-account byte budget check answers with the remainder, not just a boolean", async () => {
  const window = await bootApp();
  const check = window.HaimuniaImage.checkByteBudget;

  const fits = check({ usedBytes: 4 * 1024 * KB, addedBytes: 400 * KB, budgetBytes: 5 * 1024 * KB });
  assert.strictEqual(fits.ok, true);
  assert.strictEqual(fits.remainingBytes, 1024 * KB);
  assert.strictEqual(fits.overBy, 0);

  const over = check({ usedBytes: 5 * 1024 * KB, addedBytes: 400 * KB, budgetBytes: 5 * 1024 * KB });
  assert.strictEqual(over.ok, false);
  assert.strictEqual(over.remainingBytes, 0);
  assert.strictEqual(over.overBy, 400 * KB);

  // An account already over budget reports a zero remainder rather than a
  // negative one, so a progress bar cannot render backwards.
  assert.strictEqual(check({ usedBytes: 9999, addedBytes: 1, budgetBytes: 100 }).remainingBytes, 0);
  // No budget configured means no limit - the quota is object-count based
  // today (202608270006) and the byte column is a later schema ticket.
  assert.strictEqual(check({ usedBytes: 1e9, addedBytes: 1e9 }).ok, true);
});
