// COMM-102 / COMM-103. The post composer: text up to 1000 chars, a
// visibility select, up to four photos each through prepareImage with alt
// text or an explicit decorative choice, writing through post_create.
//
// These drive the real composer opened from the feed "כתיבת פוסט" button,
// the real publishComposer() path against a mock post_create, and the real
// alt-text and photo-cap gating.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

function seeded() {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
    community_feed: [],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  mock.onRpc("post_create", (args, ctx) => {
    ctx.db.__lastPostCreate = args;
    const id = "post-" + ((ctx.db.__postSeq = (ctx.db.__postSeq || 0) + 1));
    ctx.db.workout_posts = ctx.db.workout_posts || [];
    ctx.db.workout_posts.push({ id, body: args.body, visibility: args.visibility });
    return { data: id, error: null };
  });
  return mock;
}

async function openComposer(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="open-composer"]').click();
  await waitFor(() => !!window.document.getElementById("postComposer"), 3000);
}

function typeBody(window, text) {
  const ta = window.document.querySelector("[data-composer-body]");
  ta.value = text;
  ta.dispatchEvent(new window.Event("input", { bubbles: true }));
  return ta;
}

function stubImage(window) {
  window.HaimuniaImage.prepareImage = async () => ({
    type: "image/webp",
    source: { width: 1200, height: 900 },
    render: { blob: { size: 900, type: "image/webp" }, bytes: 900, quality: 0.8, width: 1200, height: 900, type: "image/webp" },
    thumbnail: { edge: 400, blob: { size: 200, type: "image/webp" } },
    thumbnails: [],
  });
}

function addPhoto(window) {
  const input = window.document.querySelector("[data-composer-file]");
  const file = { name: "lift.jpg", type: "image/jpeg", size: 4000 };
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
}

test("the Share button opens a composer dialog; Publish is disabled with no text and no media", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  await openComposer(window);
  const publish = window.document.querySelector('[data-community-action="composer-publish"]');
  assert.ok(publish.disabled, "Publish is disabled on an empty composer");
  assert.ok(window.document.querySelector("[data-composer-visibility]"), "a visibility select is present");
});

test("typing text enables Publish, and publishing writes a POST_TEXT through post_create with the chosen visibility", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openComposer(window);

  typeBody(window, "  בוקר טוב מהקהילה  ");
  const publish = window.document.querySelector('[data-community-action="composer-publish"]');
  assert.equal(publish.disabled, false, "Publish enabled once there is text");

  const sel = window.document.querySelector("[data-composer-visibility]");
  sel.value = "only_me";
  sel.dispatchEvent(new window.Event("change", { bubbles: true }));

  publish.click();
  await waitFor(() => !!mock.db.__lastPostCreate, 3000);
  assert.equal(mock.db.__lastPostCreate.body, "בוקר טוב מהקהילה", "control chars/whitespace trimmed");
  assert.equal(mock.db.__lastPostCreate.visibility, "only_me");
  assert.deepEqual(mock.db.__lastPostCreate.media, []);

  await waitFor(() => !window.document.getElementById("postComposer"), 3000);
  await waitFor(() => !!window.document.querySelector('.post-card[data-post-type="POST_TEXT"]'), 3000);
  assert.match(window.document.querySelector('.post-card[data-post-type="POST_TEXT"]').textContent, /בוקר טוב מהקהילה/);
});

test("text over 1000 characters is truncated to the limit before it reaches post_create", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openComposer(window);
  typeBody(window, "x".repeat(1200));
  const counter = window.document.querySelector("[data-composer-counter]");
  assert.match(counter.textContent, /1000\/1000/, "the counter shows once past 900");
  window.document.querySelector('[data-community-action="composer-publish"]').click();
  await waitFor(() => !!mock.db.__lastPostCreate, 3000);
  assert.equal(mock.db.__lastPostCreate.body.length, 1000);
});

test("a photo blocks Publish until it has alt text, then post_create gets the media row", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  stubImage(window);
  await openComposer(window);
  addPhoto(window);

  await waitFor(() => /תמונה מוכנה/.test(window.document.getElementById("postComposer").textContent), 3000);
  const publish = () => window.document.querySelector('[data-community-action="composer-publish"]');
  assert.ok(publish().disabled, "Publish blocked while a photo has no alt text and is not decorative");

  const alt = window.document.querySelector("[data-composer-alt]");
  alt.value = "מרימה מעל הראש";
  alt.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(publish().disabled, false, "alt text unblocks Publish");

  publish().click();
  await waitFor(() => !!mock.db.__lastPostCreate, 3000);
  assert.equal(mock.db.__lastPostCreate.media.length, 1);
  assert.equal(mock.db.__lastPostCreate.media[0].alt_text, "מרימה מעל הראש");
  assert.equal(mock.db.__lastPostCreate.media[0].decorative, false);
  assert.equal(mock.db.__lastPostCreate.media[0].position, 0);
  assert.match(mock.db.__lastPostCreate.media[0].storage_path, /^u1\//, "stored under the author's own folder");
});

test("the decorative checkbox satisfies the alt-text rule without typing a description", async () => {
  const mock = seeded();
  const window = await bootCommunity(mock, { syncEnabled: false });
  stubImage(window);
  await openComposer(window);
  addPhoto(window);
  await waitFor(() => /תמונה מוכנה/.test(window.document.getElementById("postComposer").textContent), 3000);

  const dec = window.document.querySelector("[data-composer-decorative]");
  dec.checked = true;
  dec.dispatchEvent(new window.Event("change", { bubbles: true }));
  await waitFor(() => window.document.querySelector('[data-community-action="composer-publish"]').disabled === false, 3000);

  window.document.querySelector('[data-community-action="composer-publish"]').click();
  await waitFor(() => !!mock.db.__lastPostCreate, 3000);
  assert.equal(mock.db.__lastPostCreate.media[0].decorative, true);
  assert.equal(mock.db.__lastPostCreate.media[0].alt_text, "");
});

test("the composer caps photos at four", async () => {
  const window = await bootCommunity(seeded(), { syncEnabled: false });
  stubImage(window);
  await openComposer(window);
  for (let i = 0; i < 4; i++) {
    addPhoto(window);
    await waitFor(() => window.document.querySelectorAll("[data-photo-id]").length === i + 1, 3000);
  }
  assert.equal(window.document.querySelector("[data-composer-file]"), null, "the Add Photo control is gone at four");
  assert.match(window.document.getElementById("postComposer").textContent, /מקסימום 4 תמונות/);
});

test("a failed publish keeps the composer open with the text intact and shows an error", async () => {
  const mock = seeded();
  mock.onRpc("post_create", () => ({ data: null, error: { message: "boom" } }));
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openComposer(window);
  typeBody(window, "טקסט שלא ייעלם");
  window.document.querySelector('[data-community-action="composer-publish"]').click();
  await waitFor(() => /פרסום הפוסט נכשל/.test(window.document.getElementById("postComposer").textContent), 3000);
  assert.equal(window.document.querySelector("[data-composer-body]").value, "טקסט שלא ייעלם", "text is preserved for a retry");
});
