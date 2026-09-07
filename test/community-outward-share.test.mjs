// Five-persona UX audit, outward sharing.
//
// The audit's most socially-engaged persona ranked "outward flow" above
// wearable sync and called the product "a closed silo with its one internal
// door locked" - zero navigator.share, zero WhatsApp/Instagram, no image
// export. This file covers the outward door: the card image, the Web Share
// API path, its two fallbacks, and - the part that most needs a guard - the
// rule that an outward card carries the member's own data and nothing about
// the club or about anybody else.
//
// Three things are exercised for real rather than regex-matched:
//   * the layout, against a recording 2D context (jsdom has no canvas, so the
//     production paint path is driven with HTMLCanvasElement.getContext
//     stubbed - the code under test is unchanged and unaware),
//   * navigator.share, asserted on the exact payload it is handed,
//   * the clipboard fallback, on a window where navigator.share does not
//     exist at all.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const src = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const VERIFIED = new Date().toISOString();

const FSI = "⁨";
const PDI = "⁩";

const RECORD = {
  record_id: "rec-42",
  movement: "Deadlift",
  new_result: '180 ק"ג',
  previous_result: '172.5 ק"ג',
  improvement: '+7.5 ק"ג',
  achieved_on: "2026-08-28",
};

function seeded(profile) {
  const mock = createMockSupabase({
    profiles: [Object.assign({
      id: "u1", handle: "dana", display_name: "דנה כהן", is_admin: false,
      recovery_verified_at: VERIFIED, visible_to_club: true,
      show_prs: false, show_workout_results: false, show_achievements: true,
    }, profile || {})],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    community_feed: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  mock.onRpc("pr_share", (args, ctx) => { ctx.db.__prShare = args; return { data: "pr-post-1", error: null }; });
  return mock;
}

// A recording 2D context. Records every draw call together with the style
// state at the moment of the call, which is what lets the layout assertions
// below check colour, font, alignment and - the load-bearing one - the base
// direction the text was painted with.
function recordingContext() {
  const calls = [];
  const ctx = {
    direction: "inherit", textAlign: "start", textBaseline: "alphabetic",
    fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, lineCap: "butt", font: "10px sans-serif",
    fillRect(x, y, w, h) { calls.push({ op: "fillRect", x, y, w, h, fillStyle: ctx.fillStyle }); },
    fillText(text, x, y) {
      calls.push({ op: "fillText", text, x, y, fillStyle: ctx.fillStyle, font: ctx.font, textAlign: ctx.textAlign, direction: ctx.direction });
    },
    measureText(text) { return { width: String(text).length * 18 }; },
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arcTo() {},
    arc(x, y, r) { calls.push({ op: "arc", x, y, r, fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle }); },
    fill() { calls.push({ op: "fill", fillStyle: ctx.fillStyle }); },
    stroke() { calls.push({ op: "stroke", strokeStyle: ctx.strokeStyle, lineWidth: ctx.lineWidth }); },
    save() {}, restore() {},
  };
  ctx.calls = calls;
  return ctx;
}

// Installs a canvas backend in the jsdom window: every getContext("2d")
// returns a fresh recording context and toBlob hands back a small Blob. The
// last context painted is kept on window.__lastCtx so a test can inspect the
// exact card cloud.js produced through its own render path.
function installCanvas(window) {
  const contexts = [];
  window.HTMLCanvasElement.prototype.getContext = function () {
    const ctx = recordingContext();
    contexts.push(ctx);
    window.__lastCtx = ctx;
    return ctx;
  };
  window.HTMLCanvasElement.prototype.toBlob = function (cb) {
    cb(new window.Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }));
  };
  if (!window.URL.createObjectURL) {
    let n = 0;
    window.URL.createObjectURL = () => "blob:https://example.test/card-" + (++n);
    window.URL.revokeObjectURL = () => {};
  }
  return contexts;
}

async function bootReady(mock, opts) {
  const window = await bootCommunity(mock, Object.assign({ syncEnabled: false }, opts || {}));
  await waitFor(() => window.isCommunitySignedIn && window.isCommunitySignedIn(), 3000);
  installCanvas(window);
  return window;
}

function texts(ctx) {
  return ctx.calls.filter((c) => c.op === "fillText").map((c) => c.text);
}
function joined(ctx) { return texts(ctx).join(" | "); }

// ===== the spec builder: rule 2, the privacy allow-list ===================

test("the share text never leaks an unterminated bidi isolate, even when the cap truncates it", async () => {
  const window = await bootReady(seeded());
  const api = window.communityOutwardShare;
  const spec = api.buildSpec({ kind: "pr", title: "א".repeat(80), newResult: "ב".repeat(60) }, { caption: "ג".repeat(140) });
  const text = api.text(spec);
  const opens = (text.match(/[⁦⁧⁨]/g) || []).length;
  const closes = (text.match(/⁩/g) || []).length;
  assert.ok(text.length <= 281, `the cap must hold: ${text.length}`);
  assert.equal(opens, closes, "an unterminated isolate would swallow whatever the recipient types after the paste");
});

test("the card is built from a per-kind allow-list, so nothing about the club or another member can reach it", async () => {
  const window = await bootReady(seeded());
  const api = window.communityOutwardShare;
  // Every forbidden name cloud.js writes down, stuffed onto one subject
  // alongside the legitimate fields. This is the assertion that a future
  // ticket trips if it starts reading a field off the source row.
  const hostile = { kind: "pr", title: "Deadlift", newResult: '180 ק"ג', dateText: "2026-08-28" };
  for (const key of api.NEVER) hostile[key] = "LEAK_" + key;
  const spec = api.buildSpec(hostile, {});
  const serialised = JSON.stringify(spec);
  assert.ok(api.NEVER.length >= 15, "the never-list must stay a real list, not an empty one");
  for (const key of api.NEVER) {
    assert.ok(!serialised.includes("LEAK_" + key), `${key} reached the card spec`);
  }
  assert.equal(spec.title, "Deadlift");
  assert.equal(spec.hero, '180 ק"ג');

  // And the same on the painted output, not only the spec - the canvas is
  // what actually leaves the device.
  const ctx = recordingContext();
  api.paint(ctx, spec, { width: api.CARD.WIDTH, height: api.CARD.HEIGHT });
  assert.ok(!joined(ctx).includes("LEAK_"), "a forbidden field was painted onto the card");
});

test("a subject cannot smuggle a display name onto the card - the name comes from the caller, never the row", async () => {
  const window = await bootReady(seeded());
  const api = window.communityOutwardShare;
  const spec = api.buildSpec({ kind: "pr", title: "Deadlift", newResult: "180", name: "מישהו אחר", displayName: "מישהו אחר" }, {});
  assert.equal(spec.name, "", "name must only ever come from opts, which openOutwardShare fills from the caller's own profile");
});

test("the share text carries no URL, no club and no other member", async () => {
  const window = await bootReady(seeded());
  const api = window.communityOutwardShare;
  const spec = api.buildSpec({ kind: "pr", title: "Deadlift", newResult: '180 ק"ג', dateText: "2026-08-28" }, { name: "דנה כהן" });
  const text = api.text(spec);
  assert.doesNotMatch(text, /https?:\/\//, "V1 has no public post page - a link would point at a login wall");
  assert.match(text, /שיא אישי חדש/);
  assert.match(text, /Deadlift/);
  assert.match(text, /האימוניה/);
});

// ===== rule 4: mixed script ==============================================

test("every Latin and numeric run on the card is bidi-isolated, so a Hebrew card cannot reorder it", async () => {
  const window = await bootReady(seeded());
  const api = window.communityOutwardShare;
  const spec = api.buildSpec({
    kind: "workout", title: "21-15-9 Thrusters", result: "8:42", scoreType: "For Time", effortLabel: "Rx", dateText: "2026-08-28",
  }, { name: "דנה כהן", caption: "האימון של היום" });
  const ctx = recordingContext();
  api.paint(ctx, spec, { width: api.CARD.WIDTH, height: api.CARD.HEIGHT });

  // The base direction of the whole card is RTL, which is the thing a
  // detached canvas gets wrong by default (it resolves to ltr).
  const rtlText = ctx.calls.filter((c) => c.op === "fillText" && c.direction === "rtl");
  assert.ok(rtlText.length > 4, "the card body must paint with an explicit rtl base direction");

  // "21-15-9 Thrusters" is the exact string two personas saw render as
  // 9-15-21. On a canvas the isolation has to be the Unicode controls,
  // because there is no <bdi>.
  const all = texts(ctx);
  const title = all.find((t) => t.includes("Thrusters"));
  assert.ok(title, "the workout name must be on the card");
  assert.ok(title.startsWith(FSI) && title.endsWith(PDI), `the title run is not FSI/PDI isolated: ${JSON.stringify(title)}`);
  for (const needle of ["8:42", "For Time", "Rx", "2026-08-28"]) {
    const line = all.find((t) => t.includes(needle));
    assert.ok(line, `${needle} is missing from the card`);
    assert.ok(line.includes(FSI) && line.includes(PDI), `${needle} is painted without a bidi isolate`);
  }
  // A pure-Hebrew label is NOT isolated - isolating it would be noise, and
  // the point of the isolate is the run that fights its surroundings.
  assert.ok(all.includes("שיא אישי חדש") === false);
  assert.ok(all.some((t) => t === "אימון הושלם"), "the Hebrew headline is painted as-is");
});

test("a mixed sentence that merely STARTS with a Latin word keeps an RTL base, so the weight is not stranded from its unit", async () => {
  // 'Rx 43/30 ק"ג. נשבר לי הראש' under FSI's first-strong rule resolves LTR
  // off that leading "Rx" and pushes the ק"ג to the far end of the line from
  // the 43/30 it belongs to - the second of the two symptoms the personas
  // reported. Prose containing any Hebrew gets U+2067 RLI instead.
  const RLI = "⁧";
  const window = await bootReady(seeded());
  const api = window.communityOutwardShare;
  const spec = api.buildSpec({ kind: "workout", title: "21-15-9 Thrusters", result: "8:42" }, {
    caption: 'Rx 43/30 ק"ג. נשבר לי הראש בסיבוב האחרון.',
  });
  const ctx = recordingContext();
  api.paint(ctx, spec, { width: api.CARD.WIDTH, height: api.CARD.HEIGHT });
  const caption = texts(ctx).find((t) => t.includes("נשבר"));
  assert.ok(caption, "the caption must be on the card");
  assert.ok(caption.startsWith(RLI), `a Hebrew sentence must get an explicit RTL base: ${JSON.stringify(caption)}`);
  // A run with no Hebrew in it at all still uses first-strong.
  const title = texts(ctx).find((t) => t.includes("Thrusters"));
  assert.ok(title.startsWith(FSI), "an all-Latin run keeps FSI's first-strong rule");
});

test("a wrapped line is isolated per line, never split across an unterminated isolate", async () => {
  const window = await bootReady(seeded());
  const api = window.communityOutwardShare;
  const spec = api.buildSpec({ kind: "workout", title: "21-15-9 Thrusters and Pull-ups and Box Jumps and Wall Balls", result: "8:42" }, {});
  const ctx = recordingContext();
  api.paint(ctx, spec, { width: api.CARD.WIDTH, height: api.CARD.HEIGHT });
  const titleLines = texts(ctx).filter((t) => /Thrusters|Pull-ups|Box|Wall/.test(t));
  assert.ok(titleLines.length >= 2, "this title must actually wrap for the test to mean anything");
  for (const l of titleLines) {
    const opens = (l.match(/[⁦⁧⁨]/g) || []).length;
    const closes = (l.match(/⁩/g) || []).length;
    assert.equal(opens, closes, `unbalanced isolate on a wrapped line: ${JSON.stringify(l)}`);
    assert.equal(opens, 1, `each wrapped line carries exactly one isolate: ${JSON.stringify(l)}`);
  }
});

test("the plain-text share keeps the isolates too, so WhatsApp shows the rep scheme the right way round", async () => {
  const window = await bootReady(seeded());
  const api = window.communityOutwardShare;
  const spec = api.buildSpec({ kind: "workout", title: "21-15-9 Thrusters", result: "8:42" }, {});
  const text = api.text(spec);
  assert.ok(text.includes(FSI + "21-15-9 Thrusters" + PDI), "the LTR run must stay isolated in the share text");
});

// ===== the card itself ===================================================

test("the card paints the app's own dark navy ground and orange accent, whatever theme the app is in", async () => {
  const window = await bootReady(seeded(), { localStorage: { "haimunia-demo:theme": "light" } });
  const api = window.communityOutwardShare;
  const ctx = recordingContext();
  api.paint(ctx, api.buildSpec({ kind: "pr", title: "Deadlift", newResult: "180" }, {}), { width: api.CARD.WIDTH, height: api.CARD.HEIGHT });
  const rects = ctx.calls.filter((c) => c.op === "fillRect");
  const ground = rects[0];
  assert.equal(ground.fillStyle, "#152342", "the ground is the dark theme's --bg, not whatever theme is active");
  assert.equal(ground.w, api.CARD.WIDTH);
  assert.equal(ground.h, api.CARD.HEIGHT);
  assert.ok(rects.some((r) => r.fillStyle === "#E85D3D"), "the energy accent must appear on the card");
  assert.ok(texts(ctx).includes("האימוניה"), "the wordmark is the only branding, and there is no URL");
});

test("an achievement card draws the bumper-plate medal, in the tier the code earns", async () => {
  const window = await bootReady(seeded());
  const api = window.communityOutwardShare;
  const gold = api.buildSpec({ kind: "achievement", code: "sessions_250", title: "250 אימונים", explanation: "250 ימי אימון מתועדים." }, {});
  assert.equal(gold.plate, "gold");
  const ctx = recordingContext();
  api.paint(ctx, gold, { width: api.CARD.WIDTH, height: api.CARD.HEIGHT });
  const discs = ctx.calls.filter((c) => c.op === "arc");
  assert.ok(discs.length >= 3, "the plate is a disc, a ring and a hub at minimum");
  // #002E84 is sampled from assets/medal-gold.png, the 20 KG plate.
  assert.ok(discs.some((d) => d.fillStyle === "#002E84"), "the gold tier is the blue 20 KG plate the app already uses");
  assert.ok(texts(ctx).some((t) => t.includes("20 KG")), "the plate carries its printed weight");

  const bronze = api.buildSpec({ kind: "achievement", code: "first_workout", title: "האימון הראשון" }, {});
  assert.equal(bronze.plate, "bronze", "an unlisted code falls back to bronze rather than to no medal");
  // A PR is not an achievement, so it gets no plate.
  assert.equal(api.buildSpec({ kind: "pr", title: "Deadlift", newResult: "180" }, {}).plate, null);
});

// ===== the sheet, end to end ============================================

test("a PR never shares outward on its own - the sheet only opens on a tap, and nothing has left before a second one", async () => {
  const mock = seeded();
  const window = await bootReady(mock);
  const shared = [];
  window.navigator.share = async (payload) => { shared.push(payload); };
  window.navigator.canShare = () => true;

  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record: RECORD });
  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);
  assert.equal(window.document.getElementById("outwardShare"), null, "the outward sheet must not open by itself");
  assert.equal(shared.length, 0, "nothing may be shared by the event alone");

  window.document.querySelector('[data-community-action="outward-pr"]').click();
  await waitFor(() => !!window.document.getElementById("outwardShare"), 3000);
  assert.equal(shared.length, 0, "opening the sheet is not sharing");
  assert.equal(mock.db.__prShare, undefined, "an outward share must not post to the club feed");
});

test("the share button hands navigator.share a PNG File plus the text, and never a url", async () => {
  const window = await bootReady(seeded());
  const shared = [];
  window.navigator.share = async (payload) => { shared.push(payload); };
  window.navigator.canShare = (payload) => !!(payload && payload.files && payload.files.length);

  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record: RECORD });
  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);
  window.document.querySelector('[data-community-action="outward-pr"]').click();
  await waitFor(() => !!window.document.querySelector('[data-outward-preview="ready"]'), 3000);

  window.document.querySelector('[data-community-action="outward-go"]').click();
  await waitFor(() => shared.length > 0, 3000);
  const payload = shared[0];
  assert.ok(Array.isArray(payload.files) && payload.files.length === 1, "the image must go as a file, not as a link");
  assert.equal(payload.files[0].type, "image/png");
  assert.match(payload.files[0].name, /\.png$/);
  assert.match(payload.text, /Deadlift/);
  assert.match(payload.text, /שיא אישי חדש/);
  assert.equal(payload.url, undefined, "V1 ships no public post page - there is deliberately no url");
  await waitFor(() => !!window.document.querySelector('[data-outward-result="shared_image"]'), 3000);
});

test("a browser with share() but no file support degrades to a text share rather than dropping the tap", async () => {
  const window = await bootReady(seeded());
  const shared = [];
  window.navigator.share = async (payload) => { shared.push(payload); };
  // Chrome on desktop Linux: share() exists, canShare({files}) is false.
  window.navigator.canShare = () => false;

  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record: RECORD });
  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);
  window.document.querySelector('[data-community-action="outward-pr"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="outward-go"]:not([disabled])'), 3000);
  window.document.querySelector('[data-community-action="outward-go"]').click();
  await waitFor(() => shared.length > 0, 3000);
  assert.equal(shared[0].files, undefined);
  assert.match(shared[0].text, /Deadlift/);
  await waitFor(() => !!window.document.querySelector('[data-outward-result="shared_text"]'), 3000);
  // The image is still reachable: the download control is the way out.
  assert.ok(window.document.querySelector('[data-community-action="outward-download"]:not([disabled])'));
});

test("with no Web Share API at all the tap copies the text and says so - the fallback runs for real", async () => {
  const window = await bootReady(seeded());
  // Feature detection must be a real absence, not a stub that returns false.
  assert.equal(typeof window.navigator.share, "undefined", "jsdom must not already provide navigator.share");
  const copied = [];
  window.navigator.clipboard = { writeText: async (t) => { copied.push(t); } };

  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record: RECORD });
  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);
  window.document.querySelector('[data-community-action="outward-pr"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="outward-go"]:not([disabled])'), 3000);
  const primary = window.document.querySelector('[data-community-action="outward-go"]');
  // The primary control renames itself rather than promising a share the
  // browser cannot perform.
  assert.match(primary.textContent, /העתקת הטקסט/);
  primary.click();
  await waitFor(() => copied.length > 0, 3000);
  assert.match(copied[0], /Deadlift/);
  await waitFor(() => !!window.document.querySelector('[data-outward-result="copied"]'), 3000);
  const note = window.document.querySelector('[data-outward-result="copied"]');
  assert.match(note.textContent, /הועתק/);
});

test("a cancelled share is reported as cancelled, and says nothing left the device", async () => {
  const window = await bootReady(seeded());
  window.navigator.share = async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; };
  window.navigator.canShare = () => true;
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record: RECORD });
  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);
  window.document.querySelector('[data-community-action="outward-pr"]').click();
  await waitFor(() => !!window.document.querySelector('[data-community-action="outward-go"]:not([disabled])'), 3000);
  window.document.querySelector('[data-community-action="outward-go"]').click();
  await waitFor(() => !!window.document.querySelector('[data-outward-result="cancelled"]'), 3000);
  assert.match(window.document.querySelector('[data-outward-result="cancelled"]').textContent, /לא יצא מהמכשיר/);
});

// ===== the name switch ===================================================

test("the name switch repaints the card, because the preview is the payload", async () => {
  const window = await bootReady(seeded());
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record: RECORD });
  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);
  window.document.querySelector('[data-community-action="outward-pr"]').click();
  await waitFor(() => !!window.document.querySelector('[data-outward-preview="ready"]'), 3000);

  const box = window.document.querySelector("[data-outward-name]");
  assert.equal(box.checked, true, "visible_to_club is true for this member, so the name is on by default");
  assert.ok(joined(window.__lastCtx).includes("דנה כהן"), "the name should be on the first card");

  box.checked = false;
  box.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => !joined(window.__lastCtx).includes("דנה כהן"), 3000);
  assert.ok(joined(window.__lastCtx).includes("Deadlift"), "turning the name off must not empty the card");
});

test("a member who has hidden their profile from the club gets the name switch off by default", async () => {
  const window = await bootReady(seeded({ visible_to_club: false }));
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record: RECORD });
  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);
  window.document.querySelector('[data-community-action="outward-pr"]').click();
  await waitFor(() => !!window.document.querySelector("[data-outward-name]"), 3000);
  assert.equal(window.document.querySelector("[data-outward-name]").checked, false);
  await waitFor(() => !!window.__lastCtx, 3000);
  assert.ok(!joined(window.__lastCtx).includes("דנה כהן"));
});

test("show_prs and show_workout_results are NOT a gate on the member's own outward share", async () => {
  // Both default FALSE in 202608280003 and govern what OTHER members may read
  // (can_view_profile_field). Gating on them would have shipped a feature
  // that is dead for every member who never opened the privacy panel.
  const window = await bootReady(seeded({ show_prs: false, show_workout_results: false }));
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record: RECORD });
  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);
  assert.ok(window.document.querySelector('[data-community-action="outward-pr"]'), "the outward control must still be offered");
  window.document.querySelector('[data-community-action="outward-pr"]').click();
  await waitFor(() => !!window.document.querySelector('[data-outward-preview="ready"]'), 3000);
  assert.ok(joined(window.__lastCtx).includes("Deadlift"));
});

// ===== the sheet as a dialog ============================================

test("the outward sheet is a registered dialog: Escape closes it and leaves the prompt underneath open", async () => {
  const window = await bootReady(seeded());
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record: RECORD });
  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);
  window.document.querySelector('[data-community-action="outward-pr"]').click();
  await waitFor(() => !!window.document.getElementById("outwardShare"), 3000);
  window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await waitFor(() => !window.document.getElementById("outwardShare"), 3000);
  assert.ok(window.document.getElementById("prPrompt"), "Escape must close the stacked sheet, not the dialog under it");
});

test("the preview image gets a real alt describing the card, never alt=\"\"", async () => {
  const window = await bootReady(seeded());
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record: RECORD });
  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);
  window.document.querySelector('[data-community-action="outward-pr"]').click();
  await waitFor(() => !!window.document.querySelector('img[data-outward-preview="ready"]'), 3000);
  const alt = window.document.querySelector('img[data-outward-preview="ready"]').getAttribute("alt");
  assert.ok(alt && alt.length > 20, "the preview is the subject of the dialog - a decorative alt would hide it");
  assert.match(alt, /Deadlift/);
  assert.match(alt, /שיא אישי חדש/);
});

test("the disclosure line on the sheet says exactly what is and is not on the image", async () => {
  const window = await bootReady(seeded());
  window.HaimuniaEvents.emit(window.PRODUCT_EVENTS.PR_CREATED, { record: RECORD });
  await waitFor(() => !!window.document.getElementById("prPrompt"), 3000);
  window.document.querySelector('[data-community-action="outward-pr"]').click();
  await waitFor(() => !!window.document.getElementById("outwardShare"), 3000);
  const sheet = window.document.getElementById("outwardShare");
  assert.match(sheet.textContent, /שמות של חברי מועדון אחרים/);
  assert.match(sheet.textContent, /שם המועדון/);
  assert.match(sheet.textContent, /קישור אין/);
});

// ===== entry points =====================================================

test("an own workout, PR or achievement post offers the outward control; nothing else does", async () => {
  const window = await bootReady(seeded());
  const api = window.communityOutwardShare;
  const own = (type, metadata) => ({ id: "p-" + type, post_type: type, author_id: "u1", metadata: metadata || {}, created_at: VERIFIED });

  assert.ok(api.subjectFromPost(own("POST_PR", { movement: "Snatch", new_result: '70 ק"ג' })));
  assert.ok(api.subjectFromPost(own("POST_WORKOUT", { workout_name: "Fran", result_text: "3:41", effort: "rx" })));
  assert.ok(api.subjectFromPost(own("POST_ACHIEVEMENT", { code: "pr_10", title: "10 שיאים" })));
  for (const type of ["POST_TEXT", "POST_PHOTO", "POST_ANNOUNCEMENT", "POST_EVENT", "POST_CHALLENGE", "POST_NEW_MEMBER", "POST_SYSTEM", "POST_COACH", "POST_ATTENDANCE_MILESTONE"]) {
    assert.equal(api.subjectFromPost(own(type, { title: "x" })), null, `${type} must not be outward-shareable`);
  }
  // Somebody else's post, of a shareable type, is still not shareable.
  assert.equal(api.subjectFromPost({ id: "p9", post_type: "POST_PR", author_id: "u2", metadata: { movement: "Snatch" } }), null);
});

test("the own-post menu opens the sheet for a workout post, and offers nothing on somebody else's", async () => {
  const mock = seeded();
  const NOW = new Date().toISOString();
  mock.db.community_feed = [
    { id: "w1", post_type: "POST_WORKOUT", author_id: "u1", display_name: "דנה כהן", published_at: NOW, body: 'Rx 43/30 ק"ג. קשה.', metadata: { workout_name: "21-15-9 Thrusters", workout_date: "2026-09-05", result_text: "8:42", score_type: "For Time", effort: "rx" } },
    { id: "w2", post_type: "POST_WORKOUT", author_id: "u2", display_name: "רון", published_at: NOW, metadata: { workout_name: "Fran", result_text: "3:21" } },
  ];
  const window = await bootReady(mock);
  window.document.getElementById("tabCommunityBtn").click();
  // Wait for the real cards, not the skeletons - which also carry .post-card.
  await waitFor(() => window.document.querySelectorAll("[data-post-id]").length >= 2, 4000);

  window.document.querySelector('.post-card[data-post-id="w2"] [data-community-action="toggle-post-menu"]').click();
  await waitFor(() => !!window.document.querySelector('.post-card[data-post-id="w2"] .post-menu'), 3000);
  assert.equal(window.document.querySelector('.post-card[data-post-id="w2"] [data-community-action="outward-post"]'), null,
    "somebody else's post must never offer an outward share");

  window.document.querySelector('.post-card[data-post-id="w1"] [data-community-action="toggle-post-menu"]').click();
  await waitFor(() => !!window.document.querySelector('.post-card[data-post-id="w1"] [data-community-action="outward-post"]'), 3000);
  window.document.querySelector('.post-card[data-post-id="w1"] [data-community-action="outward-post"]').click();
  await waitFor(() => !!window.document.querySelector('[data-outward-preview="ready"]'), 4000);
  const painted = joined(window.__lastCtx);
  assert.ok(painted.includes("21-15-9 Thrusters"), "the card is built from the post's own metadata");
  assert.ok(painted.includes("8:42"));
  assert.ok(!painted.includes("רון"), "the other member's post must not bleed into this card");
});

test("an only_me achievement offers no outward control, matching the club control beside it", () => {
  // Unlike the profile-wide toggles, this is an item-level flag the member
  // set on this exact decoration, and it defaults to "club" - so honouring it
  // costs the feature nothing.
  const section = src.slice(src.indexOf("function renderMyAchievements()"), src.indexOf("// OUTWARD SHARING"));
  assert.match(section, /const outward = r\.visibility === "only_me"\s*\n\s*\? ""/);
  const celebration = src.slice(src.indexOf("function renderAchievementUnlockCelebration()"), src.indexOf("function renderMyAchievements()"));
  assert.match(celebration, /\$\{canShare \? `<button class="chip-btn" data-community-action="outward-ach">/);
});

// ===== the guarantees that are easier to assert on the source ============

test("the card image is rendered locally and never uploaded", () => {
  const block = src.slice(src.indexOf("// OUTWARD SHARING"), src.indexOf("// ---- Member profile community section"));
  assert.doesNotMatch(block, /client\.(rpc|from|storage|functions)/,
    "an outward share must not touch Supabase - no upload, no post, no analytics row");
  assert.match(block, /navigator\.share/);
  assert.match(block, /navigator\.canShare/);
  assert.match(block, /navigator\.clipboard/);
});

test("the never-list and the allow-list are disjoint, so the two halves of rule 2 cannot drift apart", async () => {
  const window = await bootReady(seeded());
  const api = window.communityOutwardShare;
  const allowed = new Set(Object.values(api.FIELDS).flat());
  for (const key of api.NEVER) {
    assert.ok(!allowed.has(key), `${key} is on both the allow-list and the never-list`);
  }
});
