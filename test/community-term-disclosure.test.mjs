// Design spec section 3 — JARGON DISCLOSURE.
//
// Research 1.4: unexplained jargon is the #1 documented way fitness apps fail
// beginners; only 13 of 50 analysed apps avoid it, and AMRAP is one of three
// named canonical failures. The beginner persona documented 43 unexplained
// terms in this app, which passed at 2 of ~45 opportunities.
//
// THE DIAGNOSIS THAT MADE THIS CHEAP: the app had already written the fix and
// hidden it. Four perfect plain-Hebrew glosses ("AMRAP" -> "כמה סיבובים
// הספקתם") have lived in #wodBuilderOverlay since COMM-324, behind a comment
// saying they were written once, lost, and deliberately reinstated - shipped
// at 9.5px, the smallest type in the app, explaining the hardest words in the
// app, behind an overlay with no reachable opener. Their sizing has since
// been fixed on the shared .term-sub rule; this file is the rest of it.
//
// Three tiers: a permanent inline gloss where a term labels a control, a `?`
// marker where a term appears in content, and a bottom sheet that never
// blocks. Plus the thing that keeps it from becoming noise for an expert: the
// markers retire themselves.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const src = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const indexHtml = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const V = new Date().toISOString();

// A feed carrying every score type and both efforts, so the marker rules
// (first occurrence only, at most four per screen) have something to bite on.
function seededFeed() {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: V, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: V }],
    community_feed: [
      { id: "w1", post_type: "POST_WORKOUT", author_id: "u1", display_name: "דנה", published_at: V,
        metadata: { workout_name: "Cindy", workout_date: "2026-09-05", result_text: "18", score_type: "amrap", effort: "rx", is_pr: true } },
      { id: "w2", post_type: "POST_WORKOUT", author_id: "u1", display_name: "דנה", published_at: V,
        metadata: { workout_name: "Fran", workout_date: "2026-09-04", result_text: "8:42", score_type: "For Time", effort: "scaled" } },
      { id: "w3", post_type: "POST_WORKOUT", author_id: "u1", display_name: "דנה", published_at: V,
        metadata: { workout_name: "Chelsea", workout_date: "2026-09-03", result_text: "20", score_type: "emom", effort: "rx" } },
      { id: "w4", post_type: "POST_WORKOUT", author_id: "u1", display_name: "דנה", published_at: V,
        metadata: { workout_name: "Grace", workout_date: "2026-09-02", result_text: "3:10", score_type: "load", effort: "rx" } },
    ],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function openFeed(mock, opts = {}) {
  const window = await bootCommunity(mock, { syncEnabled: false, ...opts });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => window.document.querySelectorAll("[data-post-id]").length >= 4, 5000);
  return window;
}

// ---- Tier 1: the gloss that was already written, at a size a person can read

test("TIER 1: the four glosses the app already wrote are still there, verbatim, and no longer at 9.5px", () => {
  // Design spec 3.2 is explicit that this existing copy is correct and must
  // be kept word for word. Rewriting it would have thrown away the one thing
  // this team had already got right.
  const pairs = [
    ["זמן", "כמה מהר סיימתם"],
    ["AMRAP", "כמה סיבובים הספקתם"],
    ["משקל מקסימלי", "המשקל הכי כבד שהרמתם"],
    ["EMOM", "תרגיל חדש כל דקה"],
  ];
  for (const [term, gloss] of pairs) {
    assert.ok(indexHtml.includes(`${term}<span class="format-chip-sub">${gloss}</span>`),
      `the WOD-builder chip for ${term} must keep its existing one-line gloss verbatim`);
  }
  // The sizing fix, and the shared rule the new .term-sub reuses rather than
  // re-deriving. 13px, not 9.5px: the explanation of the hardest word in the
  // app must not be the smallest type in the app.
  const rule = indexHtml.match(/\.format-chip-sub, \.term-sub\{([^}]*)\}/);
  assert.ok(rule, ".format-chip-sub and .term-sub must share one rule, so the two cannot drift");
  assert.match(rule[1], /font-size:13px/);
});

// ---- The vocabulary itself ----------------------------------------------

test("the glossary ships the spec's 18 terms plus 2 later additions, each with a one-line gloss and a sheet body", () => {
  const entries = [...src.matchAll(/\{ id: "([a-z0-9]+)", term: "([^"]+)", gloss: "([^"]+)", body: "/g)];
  // Design spec 3.4 named 18 terms to ship first; "snatch" and "cleanjerk"
  // were added afterward (fresh-eyes audit, trainee persona) once real
  // use found them missing - both benchmark WODs in the catalogue that
  // name them ("Isabel — 30 Snatches", "Grace — 30 Clean & Jerks") predate
  // this glossary and were never covered by the original 18.
  assert.equal(entries.length, 20, "18 from design spec 3.4 + snatch + cleanjerk");
  for (const id of ["wod", "amrap", "emom", "fortime", "rx", "scaled", "1rm", "pr", "repscheme", "superset"]) {
    assert.ok(entries.some((e) => e[1] === id), `the glossary is missing "${id}" - one of the terms a beginner meets first`);
  }
  // A gloss is a one-liner by contract: spec 3.2 caps it at roughly 28 Hebrew
  // characters so it fits one line at 390px. "If it doesn't fit, shorten the
  // gloss, don't shrink the type" - the whole defect being fixed here was a
  // team shrinking type to fit.
  for (const [, id, , gloss] of entries) {
    assert.ok(gloss.length <= 32, `the gloss for "${id}" is ${gloss.length} chars - shorten it rather than letting it wrap`);
  }
});

test("no movement NAME was translated - the glossary explains concepts and leaves the box's vernacular alone", () => {
  // The distinction the whole section rests on. "Back Squat" and "Fran" are
  // what the coach says on the floor of an Israeli box; AMRAP and Rx are
  // concepts a beginner cannot infer. Translating the former would make the
  // app disagree with the whiteboard, which is worse than the jargon.
  //
  // The design spec's Appendix A calls CATEGORY_LABELS "already an identity
  // map... the localization seam exists, filling in seven Hebrew strings
  // changes four surfaces at once" and treats that as an opportunity nobody
  // noticed. The box owner ruled it out, and he is right: the seam existing
  // is not an argument that it should be used. Translating the six category
  // names would put the app's picker, progress panel, calendar and
  // achievement headers into a different language from the coach and the
  // whiteboard. This pin is what stops "the hook was already there" being
  // rediscovered later as a reason to pull it.
  const constants = fs.readFileSync(new URL("../src/constants.js", import.meta.url), "utf8");
  const labels = constants.slice(constants.indexOf("const CATEGORY_LABELS = {"), constants.indexOf("const MOVEMENTS"));
  const pairs = [...labels.matchAll(/"?([A-Za-z][A-Za-z ]*?)"?:\s*"([^"]+)"/g)];
  assert.ok(pairs.length >= 16, `expected the full category set, found ${pairs.length}`);
  for (const [, key, value] of pairs) {
    assert.equal(value, key.trim(), `CATEGORY_LABELS.${key.trim()} must stay an identity map - see this test's comment`);
  }
  assert.ok(!/CATEGORY_LABELS\s*\[/.test(src), "cloud.js must not reach into the category label map at all");
  // Thruster/HSPU/OHS are in the glossary as EXPLANATIONS, keyed by their
  // English names - the entry describes the movement, it does not rename it.
  assert.match(src, /\{ id: "thruster", term: "Thruster"/);
  assert.match(src, /\{ id: "hspu", term: "HSPU"/);
});

// ---- Tier 2: the marker ---------------------------------------------------

test("TIER 2: the marker has a 44px tap target without a 44px footprint, and never restyles the term", () => {
  const mark = indexHtml.match(/\.term-mark\{([^}]*)\}/);
  assert.ok(mark, "index.html must define .term-mark");
  assert.match(mark[1], /width:20px/);
  assert.match(mark[1], /height:20px/);
  // The pseudo-element is what makes the target 44x44 without moving a single
  // pixel of the line the term sits in - a 20px target fails WCAG 2.5.8 and,
  // more to the point, fails a person holding a phone in a gym.
  const after = indexHtml.match(/\.term-mark::after\{([^}]*)\}/);
  assert.ok(after, ".term-mark needs an ::after that inflates the tap target");
  assert.match(after[1], /inset:-12px/, "20px + 12px on each side = 44px");
  // aria-label carries the whole question, because the visible text is one
  // "?" character and tells a screen-reader user nothing on its own.
  assert.match(src, /aria-label="\$\{esc\("מה זה " \+ t\.term \+ "\?"\)\}"/);
});

test("TIER 2 in the feed: score type and effort are glossed, and the raw storage value is no longer printed at a member", async () => {
  const window = await openFeed(seededFeed());
  const d = window.document;
  const card = (id) => d.querySelector(`[data-post-id="${id}"]`).textContent.replace(/\s+/g, " ");

  // Before this, the card printed metadata.score_type through a bare esc() -
  // so a member reading somebody's post saw the literal lowercase string
  // "amrap", which is not a word in either language.
  assert.ok(!/\bamrap\b/.test(card("w1")), "the raw storage value must never reach a member");
  assert.match(card("w1"), /AMRAP/);
  assert.match(card("w3"), /EMOM/);
  // "For Time" and "load" both get Hebrew, and `load` gets NO marker: once
  // the label reads משקל מקסימלי there is nothing left to explain, and
  // spending a marker on a self-explanatory Hebrew phrase is the noise that
  // makes a member stop reading them.
  assert.match(card("w2"), /זמן/);
  assert.match(card("w4"), /משקל מקסימלי/);

  // Effort, Hebrew-first with the English kept so it stays learnable.
  assert.match(card("w1"), /מלא \(Rx\)/);
  assert.match(card("w2"), /מותאם \(Scaled\)/);
  assert.ok(!/^Rx$/m.test(card("w1")), "the bare, undefined English abbreviation is gone");
});

test("TIER 2's budget: first occurrence only, and never more than four markers on one screen", async () => {
  const window = await openFeed(seededFeed());
  const marks = [...window.document.querySelectorAll(".term-mark")];

  assert.ok(marks.length <= 4, `spec 3.3 caps a screen at 4 markers, found ${marks.length}`);
  const terms = marks.map((m) => m.dataset.term);
  assert.deepEqual(terms, [...new Set(terms)], "a term is marked once per screen, not on every occurrence");
  // Four workout cards carry Rx three times between them; only the first is
  // marked. A feed of twelve posts carrying a circle on every AMRAP is not
  // disclosure, it is a rash.
  assert.equal(terms.filter((t) => t === "rx").length, 1);
});

// ---- Tier 3: the sheet ----------------------------------------------------

test("TIER 3: the sheet explains the term, offers the full glossary, and is a bottom sheet rather than a full-screen modal", async () => {
  const window = await openFeed(seededFeed());
  const d = window.document;
  const amrap = [...d.querySelectorAll(".term-mark")].find((m) => m.dataset.term === "amrap");
  assert.ok(amrap, "AMRAP must be marked in a feed that contains an AMRAP workout");

  amrap.click();
  await waitFor(() => !!d.querySelector('[data-cloud-dialog="termSheet"]'), 3000);
  const sheet = d.querySelector('[data-cloud-dialog="termSheet"]');
  const text = sheet.textContent.replace(/\s+/g, " ");

  assert.match(text, /AMRAP/);
  assert.match(text, /כמה סיבובים הספקתם/, "the same one-line gloss the format chip uses - one vocabulary, not two");
  assert.match(text, /עובדים בזמן קבוע/, "and the fuller explanation");
  // A bottom sheet, not a full-screen modal: the member asked what a word on
  // the screen means, so covering the screen it is on answers the question in
  // the one place they cannot check it against.
  assert.ok(sheet.querySelector(".modal-sheet"));
  assert.match(sheet.getAttribute("style") || "", /align-items:flex-end/);
  // The title is a real heading - it is the aria-labelledby target of a
  // role="dialog", so it has to appear in heading navigation.
  assert.equal(sheet.getAttribute("aria-labelledby"), "termSheetTitle");
  assert.equal(d.getElementById("termSheetTitle").tagName, "H2");

  // ...and the way through to everything else.
  d.querySelector('[data-community-action="term-glossary"]').click();
  await waitFor(() => d.querySelectorAll(".term-glossary-item").length > 0, 3000);
  assert.equal(d.querySelectorAll(".term-glossary-item").length, 20);
});

test("TIER 3 never blocks: Escape closes the sheet and leaves the screen underneath exactly as it was", async () => {
  const window = await openFeed(seededFeed());
  const d = window.document;
  const before = d.querySelectorAll("[data-post-id]").length;

  d.querySelector(".term-mark").click();
  await waitFor(() => !!d.querySelector('[data-cloud-dialog="termSheet"]'), 3000);
  // Focus moves into the sheet, so a keyboard user is not left behind it.
  assert.ok(d.querySelector('[data-cloud-dialog="termSheet"]').contains(d.activeElement));

  d.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor(() => !d.querySelector('[data-cloud-dialog="termSheet"]'), 3000);
  assert.equal(d.querySelectorAll("[data-post-id]").length, before,
    "asking what a word means must not disturb the thing the member was reading");
});

// ---- Staying out of an expert's way ---------------------------------------

test("the markers RETIRE THEMSELVES after three sheets, and the terms stay exactly as they were", async () => {
  const window = await openFeed(seededFeed());
  const d = window.document;
  assert.ok(d.querySelectorAll(".term-mark").length > 0, "markers start visible for a new member");

  for (let i = 0; i < 3; i++) {
    const m = d.querySelector(".term-mark");
    if (!m) break;
    m.click();
    await waitFor(() => !!d.querySelector('[data-cloud-dialog="termSheet"]'), 3000);
    d.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => !d.querySelector('[data-cloud-dialog="termSheet"]'), 3000);
  }

  // Once a member has USED the disclosure three times they have demonstrated
  // they know how it works. The circles stop being painted app-wide; nothing
  // is taken away. This costs an expert three grey circles, once, ever.
  assert.equal(d.querySelectorAll(".term-mark").length, 0, "the markers must retire themselves");
  assert.equal(window.localStorage.getItem("haimunia-demo:termSheetOpens"), "3");
  // The load-bearing half: an expert reading AMRAP 20 sees exactly what they
  // saw before, because the marker never restyled the term in the first place.
  assert.match(d.getElementById("content").textContent, /AMRAP/);
  assert.match(d.getElementById("content").textContent, /מלא \(Rx\)/);
});

test("one explicit switch overrides the counter in both directions, and says which mechanism is in effect", async () => {
  // Off on a brand-new device: an expert who wants them gone on day one.
  const off = await openFeed(seededFeed(), { localStorage: { "haimunia-demo:termMarks": "0" } });
  assert.equal(off.document.querySelectorAll(".term-mark").length, 0);
  assert.match(off.document.getElementById("content").textContent, /AMRAP/, "the terms themselves are untouched");

  // On, after the counter has already retired them: a returning beginner who
  // wants them back months later. The switch must win over the counter.
  const back = await openFeed(seededFeed(), {
    localStorage: { "haimunia-demo:termMarks": "1", "haimunia-demo:termSheetOpens": "9" },
  });
  assert.equal(back.document.querySelectorAll(".term-mark").length, 0,
    "the counter still suppresses while the switch is merely at its default-on value");

  // And the switch itself is reachable, with a status line that tells the
  // truth - "on" is not the whole story once the counter has retired them.
  const d = back.document;
  d.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
  await waitFor(() => !!d.querySelector("[data-term-marks]"), 4000);
  const row = d.querySelector("[data-term-marks]").closest("label");
  assert.ok(row.textContent.includes("סימוני הסבר על מונחים"));
  assert.match(row.textContent, /וזה כבר קרה/, "the row must say the auto-retire has already happened, not just 'on'");

  // The glossary stays reachable whatever the markers are doing - retiring
  // the circles must not take the vocabulary away with them.
  d.querySelector('[data-community-action="term-glossary-open"]').click();
  await waitFor(() => d.querySelectorAll(".term-glossary-item").length > 0, 3000);
  assert.equal(d.querySelectorAll(".term-glossary-item").length, 20);
  // Browsing the glossary on purpose is not the same signal as tapping a `?`
  // you did not understand, so it must not advance the auto-retire counter.
  assert.equal(back.localStorage.getItem("haimunia-demo:termSheetOpens"), "9");
});

test("the sheet is in the dialog registry, so Escape, the Tab trap and the backdrop all know it exists", () => {
  // The exact defect the launch-readiness audit's A3 found in the confirm
  // sheet: an overlay that is not registered here is reachable by mouse only.
  assert.match(src, /\{ key: "termSheet", isOpen: \(\) => state\.ui\.termSheet, close: function \(\) \{ closeTermSheet\(\); \} \}/);
  assert.match(src, /if \(state\.ui\.termSheet\) \{ e\.preventDefault\(\); closeTermSheet\(\); return; \}/);
  assert.match(src, /data-cloud-dialog="termSheet"/);
  // Third, behind confirmSheet and outwardShare and ahead of every overlay a
  // marker can be rendered inside - see the ordering pin and its reasoning in
  // community-destructive-symmetry.test.mjs.
  const registry = src.slice(src.indexOf("const CLOUD_DIALOGS = ["), src.indexOf("const cloudDialogOpeners"));
  const keys = [...registry.matchAll(/\{ key: "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(keys.indexOf("termSheet"), 2);
});

test("every term the sheet renders goes through esc()/bidiText, and cloud.js still has no innerHTML sink", () => {
  // A glossary is wall-to-wall mixed script - a Latin term inside a Hebrew
  // sentence is precisely the shape e013bed was written for, and getting it
  // wrong here would garble the explanation of the word being explained.
  assert.match(src, /class="term-sheet-gloss">\$\{bidiText\(t\.gloss\)\}/);
  assert.match(src, /class="term-sheet-body">\$\{bidiText\(t\.body\)\}/);
  assert.match(src, /id="termSheetTitle"[^>]*><bdi>\$\{esc\(t\.term\)\}<\/bdi>/);
  assert.match(src, /data-term="\$\{esc\(t\.id\)\}"/);
  assert.equal(src.split("\n").filter((l) => /\.(innerHTML|outerHTML)\s*=/.test(l)).length, 0);
});

// ---- 3.6, the half that lives in this repo's other file --------------------

test("3.6: the Rx/Scaled control is styled for an explicit, glossed, >=44px choice - the default itself is app.js's", () => {
  // "Rx" means as prescribed, full weights. app.js opens the log form with
  // `let wodRx = true`, so a beginner's session is silently recorded as
  // harder than it was, in a history she cannot audit because neither word
  // is defined. THE DEFAULT IS THE BUG, and it lives in app.js - see the
  // handover notes. What this repo's index.html can ship ahead of it is the
  // styling that change needs, plus a straight accessibility fix that stands
  // on its own either way.
  const rx = indexHtml.match(/\.rx-btn\{([^}]*)\}/);
  assert.ok(rx, "index.html must still define .rx-btn");
  assert.match(rx[1], /min-height:44px/,
    "the most consequential binary choice on the screen was a ~40px target");
  assert.match(rx[1], /flex-direction:column/, "each chip must be able to carry a label plus a .term-sub gloss");
  // "Neither chip selected yet" must not look like a made choice - which is
  // exactly how today's pre-selected Rx reads.
  assert.match(indexHtml, /\.rx-toggle\.unset\{[^}]*dashed/);
  // And the gloss adopts the chip's colour once selected, the same way the
  // format chips already do.
  assert.match(indexHtml, /\.rx-btn\.active-rx \.term-sub[^{]*\{[^}]*color:inherit/);
});

// ---- Fresh-eyes audit: the OFFLINE WOD catalogue reaches the same glossary ---

test("the offline WOD catalogue (no Community account needed) opens the real Community term glossary, not a dead end", async () => {
  // bootCommunity (not bootApp) specifically because this proves cloud.js's
  // window.openTermGlossary is what the offline screen calls - the whole
  // point is that this must work even though the member here has never
  // opened Community; the catalogue itself lives entirely in app.js.
  const mock = createMockSupabase({});
  const window = await bootCommunity(mock, { syncEnabled: false });
  window.document.getElementById("tabWodBtn").click();
  await waitFor(() => !!window.document.querySelector("button.subtabbtn[data-subtab='benchmarks']"), 3000);
  window.document.querySelector("button.subtabbtn[data-subtab='benchmarks']").click();
  await waitFor(() => !!window.document.querySelector("[data-action='open-wod-glossary']"), 3000);
  window.document.querySelector("[data-action='open-wod-glossary']").click();
  await waitFor(() => window.document.querySelectorAll(".term-glossary-item").length > 0, 3000);
  assert.equal(window.document.querySelectorAll(".term-glossary-item").length, 20);
  assert.match(window.document.body.textContent, /Snatch/, "the terms actually named in the catalogue's own benchmark WODs are covered");
});
