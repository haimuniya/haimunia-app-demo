// COMM-015. Client-side image resize and compression.
//
// A phone photo off a modern camera is 3 to 12 MB and 4000 px on the
// long edge. The post-photos bucket caps a single object at 5 MB
// (migration 202608270004) and accepts only image/jpeg, image/png and
// image/webp, so an unprocessed HEIC or a large JPEG is either rejected
// outright or uploaded at ten times the size the feed ever renders.
// Everything that reaches Storage goes through prepareImage() first.
//
// Re-encoding through a canvas is also what strips metadata. A canvas
// holds pixels, not EXIF, so the GPS tag on a photo taken at the box
// does not survive the round trip. That is a privacy property, not a
// side effect, and it is the reason this helper never passes the
// original File through untouched even when it is already small enough.
//
// Phase 0 ships the utility and its tests with nothing wired to it.
// posts consumes it in Phase 1 (COMM-103).
(function () {
  "use strict";

  const MAX_INPUT_BYTES = 25 * 1024 * 1024;
  const RENDER_MAX_EDGE = 1600;
  // Thumbnails, largest first. 400 is the feed tile, 200 is the comment
  // and profile strip. Both are produced from the decoded source, not
  // from the render, so a thumbnail is never a re-compression of an
  // already-compressed image.
  const THUMB_EDGES = Object.freeze([400, 200]);
  const TARGET_BYTES = 400 * 1024;
  // Hard ceiling. Over this the helper drops quality once more and then
  // gives up, rather than grinding a pathological image down forever.
  const HARD_CAP_BYTES = 1024 * 1024;
  const DEFAULT_QUALITY = 0.8;
  const MIN_QUALITY = 0.5;
  const LAST_RESORT_QUALITY = 0.4;
  // The bucket's own allow-list. Output must be one of these or Storage
  // refuses the object.
  const OUTPUT_TYPES = Object.freeze(["image/webp", "image/jpeg"]);

  function fail(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  // Reject anything that is not an image before a single byte is
  // decoded. Both checks are cheap and both map to a user-facing string
  // the composer already has: not_an_image and file_too_large.
  function validateFile(file, opts) {
    const o = opts || {};
    const maxInput = o.maxInputBytes || MAX_INPUT_BYTES;
    if (!file || typeof file !== "object") throw fail("not_an_image", "no file given");
    const type = typeof file.type === "string" ? file.type : "";
    if (!/^image\//i.test(type)) throw fail("not_an_image", "not an image: " + (type || "unknown type"));
    const size = typeof file.size === "number" ? file.size : 0;
    if (size > maxInput) throw fail("file_too_large", "file is " + size + " bytes, over the " + maxInput + " byte limit");
    return true;
  }

  // Scale to fit inside maxEdge on the long side, never up. Integer
  // output with a floor of 1, so a 4000x3 panorama does not round to a
  // zero-height canvas.
  function fitDimensions(width, height, maxEdge) {
    const w = Math.max(1, Math.round(width || 0));
    const h = Math.max(1, Math.round(height || 0));
    const edge = Math.max(1, Math.round(maxEdge || 0));
    const longest = Math.max(w, h);
    if (longest <= edge) return { width: w, height: h, scaled: false };
    const ratio = edge / longest;
    return { width: Math.max(1, Math.round(w * ratio)), height: Math.max(1, Math.round(h * ratio)), scaled: true };
  }

  // The per-account aggregate byte budget check, exposed for the photo
  // quota work. The quota is object-count based today (202608270006); a
  // byte-budget column is a later schema ticket, so this reads its
  // numbers from the caller rather than assuming a column exists.
  function checkByteBudget(opts) {
    const o = opts || {};
    const budget = Number(o.budgetBytes) || 0;
    const used = Math.max(0, Number(o.usedBytes) || 0);
    const adding = Math.max(0, Number(o.addedBytes) || 0);
    const remaining = budget - used;
    return {
      ok: budget <= 0 ? true : adding <= remaining,
      budgetBytes: budget,
      usedBytes: used,
      addedBytes: adding,
      remainingBytes: Math.max(0, remaining),
      overBy: Math.max(0, adding - remaining),
    };
  }

  // --- browser backend -------------------------------------------------
  // Decode, canvas creation and encoding are behind one small object so
  // the pure sizing and budget logic above stays testable without a real
  // canvas, and so a later ticket can move the work into a worker by
  // swapping the backend rather than rewriting prepareImage().

  function hasOffscreen() {
    return typeof OffscreenCanvas === "function" && typeof new OffscreenCanvas(1, 1).convertToBlob === "function";
  }

  const browserBackend = {
    async decode(file) {
      if (typeof createImageBitmap === "function") {
        // imageOrientation "from-image" is what applies the EXIF
        // orientation tag. Without it a portrait phone photo decodes
        // sideways, because the pixels really are landscape and only the
        // tag says otherwise - and the tag is exactly what the canvas
        // re-encode is about to throw away.
        try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (err) { /* fall through */ }
      }
      return await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(fail("decode_failed", "could not decode the image")); };
        img.src = url;
      });
    },
    createCanvas(width, height) {
      if (hasOffscreen()) return new OffscreenCanvas(width, height);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas;
    },
    draw(canvas, source, width, height) {
      const ctx = canvas.getContext("2d");
      if (!ctx) throw fail("encode_failed", "no 2d context");
      ctx.drawImage(source, 0, 0, width, height);
    },
    async encode(canvas, type, quality) {
      if (typeof canvas.convertToBlob === "function") return await canvas.convertToBlob({ type, quality });
      return await new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(fail("encode_failed", "toBlob returned null"))), type, quality);
      });
    },
    supportsType(type) {
      if (type === "image/jpeg") return true;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 1; canvas.height = 1;
        return canvas.toDataURL(type).indexOf("data:" + type) === 0;
      } catch (err) {
        return false;
      }
    },
    close(bitmap) { if (bitmap && typeof bitmap.close === "function") bitmap.close(); },
  };

  function pickType(backend, requested) {
    if (requested && OUTPUT_TYPES.indexOf(requested) >= 0) return requested;
    for (const type of OUTPUT_TYPES) if (backend.supportsType(type)) return type;
    return "image/jpeg";
  }

  function blobBytes(blob) { return (blob && typeof blob.size === "number") ? blob.size : 0; }

  // Encode one canvas down a quality ladder until it fits targetBytes,
  // then check the hard cap. The ladder is a loop rather than a binary
  // search on purpose: each step is a full re-encode, and three or four
  // linear steps cost less than a search that lands on a slightly better
  // quality nobody can see.
  async function encodeToBudget(backend, canvas, type, opts) {
    const target = opts.targetBytes;
    const hardCap = opts.hardCapBytes;
    let quality = opts.quality;
    let blob = await backend.encode(canvas, type, quality);
    if (!blob) throw fail("encode_failed", "the image could not be encoded");

    while (blobBytes(blob) > target && quality > opts.minQuality + 1e-9) {
      quality = Math.max(opts.minQuality, Math.round((quality - 0.1) * 100) / 100);
      blob = await backend.encode(canvas, type, quality);
      if (!blob) throw fail("encode_failed", "the image could not be encoded");
    }

    // Over the hard cap: drop quality once more, then reject. A file
    // still over 1 MB at this quality is not a photo of a workout.
    if (blobBytes(blob) > hardCap) {
      quality = opts.lastResortQuality;
      blob = await backend.encode(canvas, type, quality);
      if (!blob || blobBytes(blob) > hardCap) throw fail("image_too_large", "the image is still over the size cap after recompressing");
    }
    return { blob, quality, bytes: blobBytes(blob) };
  }

  async function renderAt(backend, source, sourceWidth, sourceHeight, maxEdge, type, encodeOpts) {
    const dims = fitDimensions(sourceWidth, sourceHeight, maxEdge);
    const canvas = backend.createCanvas(dims.width, dims.height);
    backend.draw(canvas, source, dims.width, dims.height);
    const encoded = await encodeToBudget(backend, canvas, type, encodeOpts);
    return { blob: encoded.blob, bytes: encoded.bytes, quality: encoded.quality, width: dims.width, height: dims.height, type };
  }

  // Resize, compress and strip metadata from one file.
  //
  // Resolves to:
  //   { type, source: {width,height,bytes,type},
  //     render:    {blob,bytes,quality,width,height,type},
  //     thumbnail: {...the 400 px entry...},
  //     thumbnails: [ {edge,...}, ... ] }
  //
  // Rejects with an Error carrying .code: not_an_image, file_too_large,
  // decode_failed, encode_failed, image_too_large. The composer maps
  // not_an_image to "This file is not an image" and everything else to
  // "This image could not be processed".
  async function prepareImage(file, opts) {
    const o = opts || {};
    const backend = o.backend || browserBackend;
    validateFile(file, o);

    let source;
    try {
      source = await backend.decode(file);
    } catch (err) {
      throw (err && err.code) ? err : fail("decode_failed", "could not decode the image");
    }

    const sourceWidth = source.width || source.naturalWidth || 0;
    const sourceHeight = source.height || source.naturalHeight || 0;
    if (!sourceWidth || !sourceHeight) {
      backend.close(source);
      throw fail("decode_failed", "the decoded image has no dimensions");
    }

    const type = pickType(backend, o.type);
    const encodeOpts = {
      quality: typeof o.quality === "number" ? o.quality : DEFAULT_QUALITY,
      minQuality: typeof o.minQuality === "number" ? o.minQuality : MIN_QUALITY,
      lastResortQuality: typeof o.lastResortQuality === "number" ? o.lastResortQuality : LAST_RESORT_QUALITY,
      targetBytes: o.targetBytes || TARGET_BYTES,
      hardCapBytes: o.hardCapBytes || HARD_CAP_BYTES,
    };

    try {
      const render = await renderAt(backend, source, sourceWidth, sourceHeight, o.maxEdge || RENDER_MAX_EDGE, type, encodeOpts);
      const edges = o.thumbEdges || THUMB_EDGES;
      const thumbnails = [];
      for (const edge of edges) {
        // A thumbnail is already tiny, so it is held to its own budget
        // rather than the render's: the ladder would otherwise never
        // trigger and the quality step would be dead code.
        const thumbOpts = { ...encodeOpts, targetBytes: Math.max(24 * 1024, Math.round(encodeOpts.targetBytes / 8)), hardCapBytes: encodeOpts.hardCapBytes };
        const thumb = await renderAt(backend, source, sourceWidth, sourceHeight, edge, type, thumbOpts);
        thumbnails.push({ edge, ...thumb });
      }
      return {
        type,
        source: { width: sourceWidth, height: sourceHeight, bytes: typeof file.size === "number" ? file.size : 0, type: file.type || "" },
        render,
        thumbnail: thumbnails[0] || null,
        thumbnails,
      };
    } finally {
      backend.close(source);
    }
  }

  window.HaimuniaImage = {
    MAX_INPUT_BYTES,
    RENDER_MAX_EDGE,
    THUMB_EDGES,
    TARGET_BYTES,
    HARD_CAP_BYTES,
    DEFAULT_QUALITY,
    OUTPUT_TYPES,
    prepareImage,
    validateFile,
    fitDimensions,
    checkByteBudget,
    browserBackend,
  };
})();
