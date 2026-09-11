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
  const VERSION = "1.1.0";

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

  // ---------- Bidi isolation ----------
  //
  // WHY THIS IS A SAFETY HELPER AND NOT A FORMATTING ONE. The app is
  // `<html lang="he" dir="rtl">` and the training log is where mixed-script
  // content is the norm: rep schemes, English movement names, weights, times,
  // all typed into RTL Hebrew paragraphs. Interpolated bare, the Unicode
  // bidirectional algorithm reorders those runs and what is PAINTED stops
  // matching what was typed. That is not a garbled string a member notices
  // and ignores - it is a plausible, valid-looking, DIFFERENT workout they
  // follow to the letter. It belongs beside esc() for the same reason esc()
  // is here: one definition, reviewed once, with a failure mode nobody sees.
  //
  // Promoted out of app.js and cloud.js, which carried byte-identical copies
  // (3a85c76, d568aee). A copy-pasted one-line wrapper was a manageable risk;
  // a copy-pasted RUN FINDER is not, and its drift failure mode is silent -
  // one file quietly stops isolating and nothing looks broken.
  //
  // TWO HALVES OF ONE BUG.
  //
  // 1. LINE level, fixed by 3a85c76/d568aee and preserved here verbatim. A
  //    coach's `21-15-9 Thrusters + Pull-ups. Rx 43/30 ק"ג.` is fundamentally
  //    an LTR line; in an RTL paragraph it painted
  //    `.ג"ק Thrusters + Pull-ups. Rx 43/30 21-15-9`, with the unit stranded
  //    34 characters from its number. <bdi>'s implicit dir="auto" resolves
  //    each line from its own first strong character, so that line resolves
  //    LTR while an ordinary Hebrew line still resolves RTL. Per LINE, not
  //    per field, because a note routinely pairs a Hebrew intro line with an
  //    LTR rep-scheme line and one dir="auto" over the whole field would
  //    resolve from the first line only.
  //
  // OPEN, AND DELIBERATELY NOT RESOLVED HERE — read this before changing the
  // line-level rule. This module and the outward share card now DISAGREE
  // about the base direction of one shape: an LTR-FIRST sentence with a long
  // Hebrew tail.
  //
  //     Rx 43/30 ק"ג. נשבר לי הראש בסיבוב האחרון.
  //
  // Here, first-strong resolves that line LTR off the leading `Rx`, which
  // paints the `ק"ג` about eight characters from the 43/30 it belongs to.
  // cloud.js's bidiIsolateProse() (5c08110) deliberately does the opposite:
  // it treats any sentence containing Hebrew as a Hebrew sentence in a
  // Hebrew-first app and gives it an explicit RTL base (U+2067 RLI). Both
  // positions are defensible and they are currently both shipped, on
  // different surfaces.
  //
  // It is NOT resolved by the run-level fix below, and changing it is a
  // product decision rather than a bug fix: switching this module to the
  // card's rule would flip `21-15-9 Thrusters + Pull-ups. Rx 43/30 ק"ג.` to
  // an RTL base and break the assertion in
  // scripts/browser-check/bidi-rtl-geometry.mjs that the rep scheme paints at
  // the start of the line. Whoever picks this up should change both sites or
  // neither. The mirror of this note lives on bidiIsolateProse().
  //
  // 2. RUN level, the mirror case, fixed here. A Hebrew-FIRST line is
  //    correctly RTL - that is not a defect, that is Hebrew - but a
  //    Latin/numeric run embedded inside it still reorders against it.
  //    Measured in Chromium at 390x844/he-IL: `עשיתי 3×5 @ 60 היום` paints
  //    `3×5 @ 60` as `60 @ 5×3`. Wrapping the LINE changes nothing, because
  //    the line's direction is already right; the isolate has to go around
  //    the RUN INSIDE the line.
  //
  // THE RUN RULE, and why the boundary is drawn there. Inside a line whose
  // own base direction is RTL, take every maximal stretch containing no RTL
  // character; the run is the span from its FIRST anchor to its LAST anchor,
  // where an anchor is a Latin letter or a digit. That single rule puts all
  // three kinds of neutral where they belong:
  //
  //   * A neutral BETWEEN two anchors is INTERIOR - and is the entire bug.
  //     The bidi algorithm has European numbers act as R when it resolves
  //     adjacent neutrals (UBA N1), so the `×` and the `@` in `3×5 @ 60`
  //     resolve to the paragraph's RTL direction and split one logical run
  //     into three number runs laid out right to left.
  //   * A neutral between Hebrew and an anchor falls BEFORE the first anchor,
  //     so it stays outside. `עם תווית בלוק (A/B/C/D)` isolates `A/B/C/D`
  //     and leaves the parentheses to the paragraph, where the bidi
  //     algorithm's own bracket-pair rule (UBA N0) plus mirroring (L4)
  //     already paint them correctly - verified, not assumed.
  //   * A sentence-final `.` falls AFTER the last anchor, so it stays outside
  //     too.
  //
  // A stretch whose anchors are all CONTIGUOUS is left alone. Over an odd
  // (RTL) embedding level, UBA I2 raises both L and EN by one, so a
  // contiguous anchor stretch is a single directional run and cannot reorder
  // against itself - `Thrusters` and `40` were never at risk, and isolating
  // them would be markup for nothing.
  //
  // OVER-ISOLATING IS THE OTHER BUG, and two things stop it here:
  //
  //   * A run contains, by construction, ZERO right-to-left characters, so
  //     forcing it LTR cannot force any Hebrew LTR. That regression is
  //     structurally unreachable rather than merely avoided.
  //   * Run isolation is applied ONLY to lines whose first strong character
  //     is RTL. This is load-bearing, not caution. <bdi> is dir="auto", and
  //     HTML's first-strong scan SKIPS characters inside an isolate: isolating
  //     the leading `21-15-9 Thrusters...` run of an LTR line would hide it
  //     from that scan, hand the line's base direction to the `ק"ג` further
  //     along, and re-create the exact pre-fix paint
  //     `.ג"ק 21-15-9 Thrusters + Pull-ups. Rx 43/30`. Measured, in Chromium,
  //     before the gate was added. Gating on an RTL first strong character
  //     makes the line's own direction provably unchanged: if the first
  //     strong character is RTL then no strong LTR character precedes it, so
  //     hiding LTR characters inside isolates cannot move it.
  //
  // WHY <bdi dir="ltr"> AND NOT FSI/PDI. The outward share card
  // (bidiIsolateProse, 5c08110) had to use the Unicode isolate controls
  // because a canvas has no markup, and it found FSI's first-strong rule
  // actively wrong for prose. Here there IS markup, and markup is better on
  // both counts: <bdi> contributes no characters, so copy-pasting a coach's
  // note out of the app yields the text that was typed rather than the text
  // plus invisible U+2066/U+2069 that would then be stored back. And the
  // direction is stated rather than inferred: a run like `3×5 @ 60` has no
  // strong character at all, so dir="auto" would have to fall back on a rule
  // that is not identical across engines. dir="ltr" is the honest answer for
  // a run that has been proven to contain no RTL character.
  //
  // ESCAPING IS UNCHANGED AND NON-NEGOTIABLE. Run boundaries are computed on
  // the RAW text and every character of it still leaves through esc(); only
  // esc()'s OUTPUT is ever adjacent to markup. Boundaries have to be found
  // before escaping, not after: post-escape, `ק"ג` reads as `ק&quot;ג` and
  // the run finder would see the Latin word `quot` inside a Hebrew word.
  // Never use either function in an HTML attribute, inside <textarea>,
  // inside <option>, or inside SVG <text> - there the tag lands as literal
  // characters or breaks the element, and those contexts keep bare esc().
  // .mono runs keep bare esc() too: they already carry CSS isolation and are
  // LTR by construction.

  // Strong right-to-left. Hebrew (0590-05FF), Arabic, Syriac, Thaana, NKo,
  // Samaritan and Mandaic run contiguously to 08FF, plus the Hebrew and
  // Arabic presentation forms. Written as explicit ranges rather than
  // \p{Script=Hebrew} to keep this module a plain classic script with no
  // assumption about the oldest engine a consumer repo has to serve.
  const BIDI_RTL_RE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
  // The explicit bidi formatting controls. Not strong, but a run must never
  // swallow one: a forced-LTR isolate holding half of an unbalanced RLE/PDF
  // or RLI/PDI pair is a worse string than the one we started with. They
  // break a run instead.
  const BIDI_CONTROL_RE = /[\u200E-\u200F\u202A-\u202E\u2066-\u2069]/;
  // Strong left-to-right. Latin only, deliberately: a contiguous run of any
  // other LTR script (Cyrillic, Greek) is a single directional run that
  // cannot reorder against itself, so it needs nothing, and keeping the class
  // small keeps the anchor test honest - the Greek block, for instance,
  // carries punctuation that is not strong at all.
  const BIDI_LTR_RE = /[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]/;
  // Digits anchor a run without being strong. They are the single most common
  // thing a coach writes inside a Hebrew sentence, and `3×5 @ 60` is a run
  // made of nothing else.
  const BIDI_DIGIT_RE = /[0-9]/;
  // Tags and entities, for the already-HTML variant. See bidiAtomsFromHtml.
  const BIDI_HTML_TOKEN_RE = /(<[^>]*>|&[#0-9A-Za-z]{1,10};)/;

  // "R" strong right-to-left · "L" strong Latin letter · "D" digit ·
  // "B" opaque break (a bidi control, or a whole HTML tag) · "N" neutral.
  function bidiClassOf(ch) {
    if (BIDI_RTL_RE.test(ch)) return "R";
    if (BIDI_CONTROL_RE.test(ch)) return "B";
    if (BIDI_LTR_RE.test(ch)) return "L";
    if (BIDI_DIGIT_RE.test(ch)) return "D";
    return "N";
  }

  // A line as a list of atoms: `out` is emitted, `cls` is what the run finder
  // sees. For plain text an atom is one character.
  function bidiAtomsFromText(text) {
    const atoms = [];
    for (let i = 0; i < text.length; i++) atoms.push({ out: text[i], cls: bidiClassOf(text[i]) });
    return atoms;
  }

  // bidiHtml's input is ALREADY HTML - escaped text with markup spliced into
  // it (a comment body whose @mentions are <button>s). Two things must not be
  // misread as prose:
  //
  //   * A TAG. Wrapping half of one emits broken markup, so a tag is one
  //     opaque atom that also BREAKS a run. An isolate therefore can never
  //     straddle a tag, which makes the output well-formed by construction
  //     rather than by care.
  //   * An ENTITY. esc() turns `"` into `&quot;`, which character by
  //     character reads as the Latin word `quot`. Unhandled, `ק"ג` would have
  //     its own escape isolated as if it were an English word. An entity is
  //     one atom classed neutral - which is what all five of esc()'s outputs
  //     (&amp; &lt; &gt; &quot; &#39;) decode to.
  //
  // String.prototype.split with one capturing group interleaves the
  // separators at odd indices, so the parity is the token type; no shape
  // re-sniffing is needed.
  function bidiAtomsFromHtml(html) {
    const atoms = [];
    const parts = html.split(BIDI_HTML_TOKEN_RE);
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      if (!part) continue;
      if (p % 2 === 1) { atoms.push({ out: part, cls: part.charAt(0) === "<" ? "B" : "N" }); continue; }
      for (let i = 0; i < part.length; i++) atoms.push({ out: part[i], cls: bidiClassOf(part[i]) });
    }
    return atoms;
  }

  // HTML's first-strong rule (the one dir="auto" runs), over atoms. No strong
  // character means false: <bdi> already resolves such a line LTR, which is
  // the right answer for `3×5 @ 60` standing on its own, and leaving it
  // alone keeps this function from touching a line it cannot improve.
  function bidiBaseIsRtl(atoms) {
    for (let i = 0; i < atoms.length; i++) {
      if (atoms[i].cls === "R") return true;
      if (atoms[i].cls === "L") return false;
    }
    return false;
  }

  // The run finder. `escape` is applied to each emitted stretch - esc() for
  // plain text, identity for already-escaped HTML.
  function bidiWrapRuns(atoms, escape) {
    let out = "";
    const emit = (from, to) => {
      if (to <= from) return;
      let s = "";
      for (let k = from; k < to; k++) s += atoms[k].out;
      out += escape(s);
    };
    let i = 0;
    while (i < atoms.length) {
      if (atoms[i].cls === "R" || atoms[i].cls === "B") { emit(i, i + 1); i++; continue; }
      // A maximal stretch with no RTL character and no control/tag in it.
      let j = i;
      while (j < atoms.length && atoms[j].cls !== "R" && atoms[j].cls !== "B") j++;
      let first = -1, last = -1;
      for (let k = i; k < j; k++) {
        if (atoms[k].cls === "L" || atoms[k].cls === "D") { if (first < 0) first = k; last = k; }
      }
      let hasInteriorNeutral = false;
      if (first >= 0) {
        for (let k = first; k <= last; k++) if (atoms[k].cls === "N") { hasInteriorNeutral = true; break; }
      }
      if (hasInteriorNeutral) {
        emit(i, first);
        out += '<bdi dir="ltr">';
        emit(first, last + 1);
        out += "</bdi>";
        emit(last + 1, j);
      } else {
        emit(i, j);
      }
      i = j;
    }
    return out;
  }

  function bidiSame(v) { return v; }

  // Isolate a PLAIN-TEXT value for an innerHTML/template-literal sink.
  // Escapes, isolates each line, and isolates every embedded LTR run inside
  // an RTL line. Joining back on "\n" reproduces the original text exactly,
  // so a `white-space:pre-wrap` surface still breaks where it did and a
  // collapsing one still collapses.
  function bidiText(value) {
    return String(value ?? "")
      .split("\n")
      .map((line) => {
        const atoms = bidiAtomsFromText(line);
        return "<bdi>" + (bidiBaseIsRtl(atoms) ? bidiWrapRuns(atoms, esc) : esc(line)) + "</bdi>";
      })
      .join("\n");
  }

  // The same isolation for a run that is ALREADY HTML - a comment body whose
  // @mentions have been turned into buttons, and which is therefore escaped
  // already. One isolate over the whole run rather than per line: the
  // embedded markup makes splitting on "\n" unsafe, and a comment is short
  // enough that a single base direction is the right call. Run isolation
  // inside it works on the tokenised form, so no isolate straddles a tag.
  function bidiHtml(html) {
    const s = String(html ?? "");
    const atoms = bidiAtomsFromHtml(s);
    return "<bdi>" + (bidiBaseIsRtl(atoms) ? bidiWrapRuns(atoms, bidiSame) : s) + "</bdi>";
  }

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
  // Live bug hunt (2026-09-11): a missing/invalid ts used to always fall
  // back to Date.now() - fine for a genuinely new record, wrong for a
  // legacy one with no ts column at all (pre-existing local history from
  // before this field existed, or a hand-restored/imported record).
  // Confirmed live: reloading the SAME ts-less record twice produced two
  // DIFFERENT manufactured "now" values, and migrating it to Community
  // sync pushed a fabricated recency for a workout logged years earlier -
  // directly feeding shouldApplyRemote()'s last-write-wins conflict
  // resolution between devices, which trusts ts verbatim. `fallbackDateIso`
  // (every sanitizeEntry()-family caller already has the record's own
  // validated date in scope) makes the fallback a deterministic function
  // of data already on the record instead of the clock: the same input
  // always produces the same ts, and a 1991 workout gets a ts that reads
  // like 1991, not like it was just edited. No fallback date given (the
  // few callers with no date concept) keeps the original Date.now()
  // behavior unchanged.
  function cleanTs(v, fallbackDateIso) {
    const n = Number(v);
    if (isFinite(n) && n > 0 && n <= 4102444800000) return Math.floor(n); // cap at year 2100
    if (fallbackDateIso) {
      const d = new Date(fallbackDateIso + "T00:00:00Z");
      if (!isNaN(d.getTime())) return d.getTime();
    }
    return Date.now();
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
    bidiText, bidiHtml,
    cleanStr, cleanNum, cleanId, cleanISODate, cleanTs,
    uid,
  });
})(typeof window !== "undefined" ? window : globalThis);
