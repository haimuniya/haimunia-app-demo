// @boxlog/safe-helpers — the low-level safety helpers shared by every Box Log
// client (COMM-368).
//
// THIS FILE IS THE SOURCE OF TRUTH for HTML escaping, CSS-selector escaping,
// prototype-safe accumulator objects, the untrusted-value cleaners, and id
// generation. Before COMM-368 the same nine functions existed as two
// byte-identical, independently-maintained copies — one here (split across
// src/format.js, src/sanitize.js and src/constants.js) and one in the sibling
// crossfit-pwa-Noam repo's app.js — with no mechanism to propagate a
// security-relevant fix from either side to the other.
//
// Contract for anyone editing this file — see src/shared/README.md for the
// full version/propagation protocol:
//
//   1. Bump VERSION below (and src/shared/package.json to match) on every
//      behavior change. Adding a helper is a minor bump; changing what an
//      existing helper returns for a given input is a major bump.
//   2. Never import anything. This module sits at the bottom of the
//      dependency graph on purpose: it is the first script index.html loads
//      and everything else — cloud.js, src/constants.js, src/format.js,
//      src/sanitize.js, src/db.js, app.js — is downstream of it.
//   3. Never touch the DOM, storage, or the network. Pure functions only, so
//      the module is trivially portable to any host that has a global object.
//
// Consumers reach it two ways, both of which are load-order safe because this
// script runs first:
//
//   * as bare identifiers, via the thin `const esc = SAFE.esc` bindings at the
//     top of src/format.js / src/sanitize.js / src/constants.js (classic
//     scripts share one global lexical environment, so app.js sees them);
//   * as `window.BoxLogSafe.*`, which is how cloud.js reaches it — cloud.js is
//     its own IIFE and already reaches every other platform module (eventbus,
//     analytics, realtime, image) through `window` for the same reason.
(function (global) {
  "use strict";

  // Bumped on every behavior change to any helper below. A consumer repo
  // records the version it vendored so a drift is visible without a diff.
  const VERSION = "1.0.0";

  // The only limit this module needs. Deliberately owned here rather than
  // read from src/constants.js's LIMITS: cleanId is a security boundary and
  // must not depend on a file that loads after this one. src/constants.js
  // reads LIMITS.idLen back off this object so there is still exactly one
  // number.
  const LIMITS = { idLen: 128 };

  // ---------- HTML escaping ----------
  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  // The one HTML escape in the product. Every string that reaches an
  // innerHTML/template-literal sink goes through this, including in cloud.js
  // (which had its own identical copy named safeText until COMM-367).
  function esc(str) { return String(str ?? "").replace(/[&<>"']/g, (c) => ESC_MAP[c]); }

  // ---------- CSS selector escaping ----------
  // Escape a value for use inside a CSS attribute selector.
  function cssSel(v) {
    if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(String(v ?? ""));
    return String(v ?? "").replace(/["\\\]]/g, "\\$&");
  }

  // ---------- Prototype-safe lookup tables ----------
  // Accumulator objects keyed by untrusted strings must have no prototype: a
  // record whose key is "__proto__" (only reachable through an imported
  // backup) must never resolve to Object.prototype.
  function bag() { return Object.create(null); }

  // ---------- Untrusted value cleaners ----------
  function cleanStr(v, max) {
    if (typeof v !== "string") return "";
    // strip control chars, collapse runaway whitespace, hard-cap length
    return v.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, max);
  }
  function cleanNum(v, min, max, fallback) {
    const n = typeof v === "number" ? v : parseFloat(v);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
  }
  function cleanId(v) {
    const raw = typeof v === "string" ? v : "";
    // opaque identifier: conservative charset, never reaches HTML as markup
    const id = raw.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, LIMITS.idLen);
    return id || null;
  }
  function cleanISODate(v) {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
    const d = new Date(v + "T00:00:00");
    return isNaN(d.getTime()) ? null : v;
  }
  function cleanTs(v) {
    const n = Number(v);
    if (!isFinite(n) || n <= 0 || n > 4102444800000) return Date.now(); // cap at year 2100
    return Math.floor(n);
  }

  // ---------- Id generation ----------
  function uid(prefix) {
    let r;
    try { r = (self.crypto && self.crypto.randomUUID) ? self.crypto.randomUUID() : null; } catch (e) { r = null; }
    if (!r) {
      try {
        const a = new Uint8Array(16); self.crypto.getRandomValues(a);
        r = Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
      } catch (e) { r = Date.now().toString(36) + Math.random().toString(36).slice(2); }
    }
    return prefix + "-" + r;
  }

  // Frozen so a later script cannot swap out an escape function under the
  // rest of the app — the whole point of having one copy is that there is
  // exactly one, and it is the one that was reviewed.
  global.BoxLogSafe = Object.freeze({
    VERSION,
    LIMITS: Object.freeze(LIMITS),
    esc, cssSel, bag,
    cleanStr, cleanNum, cleanId, cleanISODate, cleanTs,
    uid,
  });
})(typeof window !== "undefined" ? window : globalThis);
