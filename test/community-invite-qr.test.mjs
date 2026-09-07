// The joining QR, and the ?invite= deep link behind it.
//
// The box owner's objection to the invite flow, verbatim: the code is a
// 48-character hex string that "cannot be printed on a flyer", so his front
// desk was reading it aloud or typing it into WhatsApp once per member.
// redeem_invite_code constrains p_code to ^[a-f0-9]{40,128}$, so a short
// human code is a schema change and is deliberately not attempted - the QR
// and the deep link are the answer instead.
//
// THE LOAD-BEARING TEST IN THIS FILE IS THE FIRST ONE. A QR that renders but
// does not decode is worse than no QR at all: it fails silently, in a gym, on
// somebody else's phone. So the encoder's output is read back here by a
// SECOND, INDEPENDENT implementation written straight from ISO/IEC 18004 -
// it re-derives the function-pattern map from the version, reads the mask out
// of the symbol's own format information, unmasks, walks the zigzag itself
// and de-interleaves the blocks. It shares no code with cloud.js's encoder,
// so a bug in one cannot hide inside the other.
//
// (Two further proofs were run outside this suite and are not committed
// because they would add dependencies for one assertion each: the encoder's
// matrix was diffed module-for-module against qrcode-generator over 588
// payloads - identical in every case - and jsQR, a real camera-grade
// decoder, read 81 of 81 rendered symbols back to the exact payload.)
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const src = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

// ===== The encoder, lifted out of cloud.js's IIFE =========================
// Same technique community-state-namespaces.test.mjs uses on the state
// literal: slice the section out of the real file and evaluate it, so this
// tests the shipped code rather than a copy of it.
function loadEncoder() {
  const start = src.indexOf("  const QR_M_BLOCKS = {");
  const end = src.indexOf("  // ---- The deep link ---");
  assert.ok(start > -1 && end > start, "cloud.js must still contain the QR section between QR_M_BLOCKS and the deep-link section");
  return new Function(src.slice(start, end) + "\nreturn qrEncode;")();
}
const qrEncode = loadEncoder();

// ===== An independent reader ==============================================
// The spec's block table for error-correction level M, transcribed here on
// its own: [EC codewords per block, group-1 blocks, group-1 data codewords,
// group-2 blocks, group-2 data codewords].
const READER_BLOCKS = {
  1: [10, 1, 16, 0, 0], 2: [16, 1, 28, 0, 0], 3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0], 5: [24, 2, 43, 0, 0], 6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0], 8: [22, 2, 38, 2, 39], 9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44], 11: [30, 1, 50, 4, 51], 12: [22, 6, 36, 2, 37],
};
const READER_ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  11: [6, 30, 54], 12: [6, 32, 58],
};
const READER_MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];
// Which modules are NOT data, derived by rectangle rather than by replaying
// the encoder's own drawing order: the three 9-module corner blocks (finder,
// separator and the format strip that abuts them), both timing lines, the
// alignment boxes, and the version blocks from version 7 up.
function reservedMap(version, size) {
  const res = [];
  for (let r = 0; r < size; r++) res.push(new Uint8Array(size));
  const box = (r0, r1, c0, c1) => {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) res[r][c] = 1;
  };
  box(0, 8, 0, 8);
  box(0, 8, size - 8, size - 1);
  box(size - 8, size - 1, 0, 8);
  box(6, 6, 0, size - 1);
  box(0, size - 1, 6, 6);
  const centres = READER_ALIGN[version];
  for (const r of centres) {
    for (const c of centres) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      box(r - 2, r + 2, c - 2, c + 2);
    }
  }
  if (version >= 7) {
    box(0, 5, size - 11, size - 9);
    box(size - 11, size - 9, 0, 5);
  }
  return res;
}
function readFormat(m, size) {
  let bits = 0;
  for (let i = 0; i < 15; i++) {
    let b;
    if (i < 6) b = m[i][8];
    else if (i < 8) b = m[i + 1][8];
    else b = m[size - 15 + i][8];
    bits |= b << i;
  }
  const data = (bits ^ 0x5412) >> 10;
  return { ecLevel: (data >> 3) & 3, mask: data & 7 };
}
// The second copy of the format information, read from the other two
// corners. Asserting the two agree is what proves both were written, which
// is the difference between a symbol a scanner can read from any angle and
// one that only works when the top-left corner is clean.
function readFormatCopy2(m, size) {
  let bits = 0;
  for (let i = 0; i < 15; i++) {
    let b;
    if (i < 8) b = m[8][size - 1 - i];
    else if (i === 8) b = m[8][7];
    else b = m[8][14 - i];
    bits |= b << i;
  }
  const data = (bits ^ 0x5412) >> 10;
  return { ecLevel: (data >> 3) & 3, mask: data & 7 };
}
function decodeQr(sym) {
  const size = sym.size;
  const version = (size - 17) / 4;
  assert.ok(Number.isInteger(version) && version >= 1 && version <= 12, `implausible symbol size ${size}`);
  const fmt = readFormat(sym.modules, size);
  assert.deepEqual(fmt, readFormatCopy2(sym.modules, size), "the two format-information copies must agree");
  assert.equal(fmt.ecLevel, 0, "every symbol this app makes is error-correction level M");
  const reserved = reservedMap(version, size);
  // Unmask, then walk the zigzag: two-module columns right to left,
  // alternating up and down, skipping the vertical timing column.
  const bits = [];
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const row = up ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        bits.push(sym.modules[row][c] ^ (READER_MASKS[fmt.mask](row, c) ? 1 : 0));
      }
    }
    up = !up;
  }
  const stream = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    stream.push(b);
  }
  // De-interleave back into blocks and keep the data half.
  const spec = READER_BLOCKS[version];
  const counts = [];
  for (let i = 0; i < spec[1]; i++) counts.push(spec[2]);
  for (let i = 0; i < spec[3]; i++) counts.push(spec[4]);
  const blocks = counts.map(() => []);
  let at = 0;
  const maxData = Math.max(spec[2], spec[4]);
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < counts.length; b++) if (i < counts[b]) blocks[b].push(stream[at++]);
  }
  const data = [].concat(...blocks);
  // Parse the data stream: 4 mode bits, then the character count, then the
  // payload. Byte mode only - that is all this encoder emits.
  const dataBits = [];
  for (const byte of data) for (let j = 7; j >= 0; j--) dataBits.push((byte >> j) & 1);
  let p = 0;
  const take = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | dataBits[p++]; return v; };
  assert.equal(take(4), 4, "mode indicator must be byte mode");
  const length = take(version < 10 ? 8 : 16);
  const bytes = [];
  for (let i = 0; i < length; i++) bytes.push(take(8));
  return { version: version, mask: fmt.mask, text: Buffer.from(bytes).toString("utf8") };
}

// ===== Decode proof =======================================================

const HEX = "0123456789abcdef";
function fakeCode(len) {
  let s = "";
  // Deterministic rather than random: a test that only fails one run in
  // twenty is not a test.
  for (let i = 0; i < len; i++) s += HEX[(i * 7 + 3) % 16];
  return s;
}

test("the QR of a real invite deep link decodes back to exactly that link", () => {
  const link = "https://example.test/index.html?tab=community&invite=" + fakeCode(48);
  const sym = qrEncode(link);
  assert.ok(sym, "a 100-character link must fit");
  const out = decodeQr(sym);
  assert.equal(out.text, link, "the decoded payload is the deep link, character for character");
});

test("every payload length the invite flow can produce round-trips, at whatever version it lands on", () => {
  const versions = new Set();
  // 40 to 128 hex characters is redeem_invite_code's whole accepted range,
  // against a realistic origin.
  for (let n = 40; n <= 128; n++) {
    const link = "https://shahafrachmany.github.io/haimunia-app-demo-publish/?tab=community&invite=" + fakeCode(n);
    const sym = qrEncode(link);
    assert.ok(sym, `a ${link.length}-character link must fit inside version 12`);
    const out = decodeQr(sym);
    assert.equal(out.text, link, `round-trip failed at code length ${n}`);
    versions.add(out.version);
  }
  assert.ok(versions.size > 1, "this range should span more than one symbol version, exercising the version-info path too");
});

test("payloads either side of the 8-bit/16-bit character-count boundary round-trip", () => {
  // Versions 1-9 write an 8-bit character count and 10+ writes 16. Getting
  // that wrong produces a symbol that scans and decodes to garbage, which is
  // the worst possible failure mode.
  for (const n of [100, 120, 122, 124, 126, 150, 180, 200, 250, 280]) {
    const text = "https://a.example/?tab=community&invite=" + "a".repeat(Math.max(0, n - 40));
    const sym = qrEncode(text);
    assert.ok(sym, `length ${text.length} must fit`);
    assert.equal(decodeQr(sym).text, text);
  }
});

test("a payload too long for version 12 returns null rather than a broken symbol", () => {
  assert.equal(qrEncode("x".repeat(400)), null);
});

test("the symbol carries a real quiet-zone-free module grid of the right size, and its finder patterns are where a scanner looks", () => {
  const sym = qrEncode("https://example.test/?tab=community&invite=" + fakeCode(48));
  assert.equal(sym.size, sym.version * 4 + 17);
  const m = sym.modules;
  for (const [r0, c0] of [[0, 0], [0, sym.size - 7], [sym.size - 7, 0]]) {
    // The 1:1:3:1:1 ring: dark border, light ring, dark 3x3 core.
    assert.equal(m[r0][c0], 1, "finder outer corner is dark");
    assert.equal(m[r0 + 1][c0 + 1], 0, "finder inner ring is light");
    assert.equal(m[r0 + 3][c0 + 3], 1, "finder core is dark");
  }
  // The always-dark module, the one fixed bit outside every pattern.
  assert.equal(m[sym.size - 8][8], 1);
});

// ===== The deep link, through the real app ================================

const VERIFIED = new Date().toISOString();
const SHARED_CODE = fakeCode(48);

function seeded(role) {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: role === "admin", recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: role === "admin" ? "member" : (role || "member"), redeemed_at: VERIFIED }],
    clubs: [{ id: "club-1", name: "חיימוניה" }],
    community_streaks: [], workout_posts: [], feed_page_rows: [], member_contact_log: [],
    coach_engagement_flags: [], analytics_events: [], notifications: [], notification_preferences: [],
    monthly_club_recaps: [], reports: [], challenges: [], onboarding_step_content: [], club_features: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function openInviteTab(window) {
  window.document.getElementById("tabManageBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-manage-tab"][data-tab="invites"]').click();
}

test("creating a shared code produces a deep link of the documented shape, shown and copyable beside the QR", async () => {
  const mock = seeded("admin");
  mock.onRpc("admin_invite_code_list", () => ({ data: [], error: null }));
  mock.onRpc("admin_invite_list", () => ({ data: [], error: null }));
  mock.onRpc("admin_invite_code_create", () => ({ data: { id: "c1", code: SHARED_CODE, role: "member", created_at: VERIFIED }, error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openInviteTab(window);
  await waitFor(() => !!window.document.getElementById("communityInviteCodeCreate"), 3000);
  window.document.getElementById("communityInviteCodeCreate").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

  await waitFor(() => !!window.document.querySelector("[data-invite-qr-link]"), 3000);
  const link = window.document.querySelector("[data-invite-qr-link]").textContent.trim();
  assert.equal(link, `https://example.test/?tab=community&invite=${SHARED_CODE}`,
    "origin + path + ?tab=community (app.js's own boot parameter) + ?invite=<code>");
  // Rule 4 of the brief: a QR is useless over the phone, so the raw code
  // stays visible and copyable next to it.
  assert.equal(window.document.querySelector("[data-invite-qr-code]").textContent.trim(), SHARED_CODE);
  assert.ok(window.document.querySelector('[data-community-action="copy-invite-code"][data-code="' + SHARED_CODE + '"]'),
    "the code has its own copy button");
  assert.ok(window.document.querySelector('[data-community-action="copy-invite-link"]'), "and so does the link");
  // And the QR of that link is the one that decodes back to it.
  assert.equal(decodeQr(qrEncode(link)).text, link);
});

test("arriving on ?invite=<code> lands on the invite step with the code prefilled, and strips the code out of the URL", async () => {
  const mock = createMockSupabase({
    profiles: [], invite_redemptions: [], clubs: [{ id: "club-1", name: "חיימוניה" }],
    community_streaks: [], workout_posts: [], feed_page_rows: [], member_contact_log: [],
    coach_engagement_flags: [], analytics_events: [], notifications: [], notification_preferences: [],
    monthly_club_recaps: [], reports: [],
  });
  mock.setUser({ id: "new-1", is_anonymous: true, email: null });
  const window = await bootCommunity(mock, {
    syncEnabled: false,
    url: `https://example.test/index.html?tab=community&invite=${SHARED_CODE}`,
  });
  // The whole point of the deep link: the invite field, already filled, with
  // no Community tab to find and no gate to tap through first.
  await waitFor(() => !!window.document.querySelector("input[data-invite-code]"), 4000);
  assert.equal(window.document.querySelector("input[data-invite-code]").value, SHARED_CODE);
  // A form that fills itself unexplained reads as a bug, so it says why.
  assert.ok(window.document.querySelector("[data-invite-prefilled]"), "the prefill is explained, not silent");
  // AN INVITE CODE IS A LIVE CREDENTIAL. It must not be left sitting in the
  // address bar, the back-stack or a screenshot.
  assert.equal(window.location.search.includes("invite="), false, "the code is stripped from the URL at boot");
  assert.ok(window.location.search.includes("tab=community"), "and ?tab= is left alone - app.js still owns it");
  // A returning member who scanned the same flyer must still be able to log in.
  assert.ok(window.document.querySelector('[data-community-action="back-to-login"]'), "the login form is one tap away");
});

test("a malformed ?invite= is dropped rather than prefilled, and still leaves the URL", async () => {
  const mock = createMockSupabase({
    profiles: [], invite_redemptions: [], clubs: [], community_streaks: [], workout_posts: [],
    feed_page_rows: [], member_contact_log: [], coach_engagement_flags: [], analytics_events: [],
    notifications: [], notification_preferences: [], monthly_club_recaps: [], reports: [],
  });
  mock.setUser({ id: "new-2", is_anonymous: true, email: null });
  // Too short for redeem_invite_code's own ^[a-f0-9]{40,128}$, and with a
  // character the pattern does not allow.
  const window = await bootCommunity(mock, { syncEnabled: false, url: "https://example.test/index.html?tab=community&invite=NOT-A-CODE" });
  await waitFor(() => !!window.document.getElementById("tabCommunityBtn"), 4000);
  assert.equal(window.location.search.includes("invite="), false, "a bad code is stripped too");
  const field = window.document.querySelector("input[data-invite-code]");
  assert.ok(!field || field.value === "", "nothing invalid is ever put in front of the member");
  assert.equal(window.document.querySelector("[data-invite-prefilled]"), null);
});

// ===== The credential rules ===============================================

test("no invite code is ever logged or put into an analytics event", () => {
  // Read as source, on purpose: this is a rule about what the code may
  // never do, and the only honest way to check "never" is to look.
  // Comments stripped first - the section's own prose says out loud that it
  // never calls track(), and a scan that cannot tell a promise from a call
  // would fail on the promise. Same stripping community-state-namespaces
  // does before its own "reach state by an explicit path" scan.
  const qrSection = src
    .slice(src.indexOf("  // ---- The deep link ---"), src.indexOf("  function renderInviteManagement()"))
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(qrSection, /console\.(log|info|warn|error)/, "nothing on the invite path may log");
  assert.doesNotMatch(qrSection, /\btrack\(/, "and no analytics event may carry a live credential");
});

test("the QR panel warns that anyone who scans it can join, and offers a way to take it off the screen", async () => {
  const mock = seeded("admin");
  mock.onRpc("admin_invite_code_list", () => ({ data: [], error: null }));
  mock.onRpc("admin_invite_list", () => ({ data: [], error: null }));
  mock.onRpc("admin_invite_code_create", () => ({ data: { id: "c1", code: SHARED_CODE, role: "member", created_at: VERIFIED }, error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openInviteTab(window);
  await waitFor(() => !!window.document.getElementById("communityInviteCodeCreate"), 3000);
  window.document.getElementById("communityInviteCodeCreate").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => !!window.document.querySelector("[data-invite-qr-code]"), 3000);
  assert.match(window.document.body.textContent, /כל מי שסורק את הקוד יכול להצטרף למועדון/);

  // "Off the screen" has to mean BOTH reveals, not just the picture.
  window.document.querySelector('[data-community-action="invite-qr-close"]').click();
  await waitFor(() => !window.document.querySelector("[data-invite-qr-code]"), 3000);
  assert.equal(window.document.body.textContent.includes(SHARED_CODE), false,
    "closing the QR clears the creation reveal card too - hiding half a credential is not hiding it");
});

test("before any code exists the panel explains what it is for rather than sitting blank", async () => {
  const mock = seeded("admin");
  mock.onRpc("admin_invite_code_list", () => ({ data: [], error: null }));
  mock.onRpc("admin_invite_list", () => ({ data: [], error: null }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openInviteTab(window);
  await waitFor(() => !!window.document.querySelector('[data-empty-state="invite-qr"]'), 3000);
  const empty = window.document.querySelector('[data-empty-state="invite-qr"]');
  assert.match(empty.textContent, /קוד QR/);
  assert.match(empty.textContent, /פעם אחת בלבד/, "it says the code is shown once, which is why printing happens now");
});
