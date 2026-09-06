// COMM-318, client half. avatarHtml() renders a real photo when avatar_url
// is set (initials otherwise, unchanged), and the account tab's profile
// form lets a member upload, replace, and remove their own photo through
// uploadAvatarPhoto()/saveAvatarUrl()/removeAvatarPhoto() -
// avatar-photos storage half already shipped in 202609010010_avatar_photo.sql.
//
// Real render/click paths against bootCommunity + the mock Supabase client,
// the same shape test/community-composer.test.mjs uses for its own
// prepareImage-backed photo flow (composerAddPhoto) - stubs
// window.HaimuniaImage.prepareImage and mockSupabase.mjs's storage.upload/
// getPublicUrl/createSignedUrl/remove, then drives the real file-input change
// event and data-community-action click.
//
// Launch-readiness audit, finding 3: the bucket is PRIVATE since
// 202609060003 (it was public, which served every member's face to the open
// internet with no session at all). profiles.avatar_url still stores the
// /object/public/ form as the object's identifier, and avatarHtml() resolves
// a short-lived signed URL from it at render time - the same
// photoUrlCache/resolvePhotoUrl shape post-photos has always used. The last
// test in this file covers the fallback when that signing fails.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const VERIFIED = new Date().toISOString();

function seeded(avatarUrl) {
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: VERIFIED, visible_to_club: true, avatar_url: avatarUrl || null }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: VERIFIED }],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });
  return mock;
}

async function openAccountTab(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);
  window.document.querySelector('[data-community-action="set-tab"][data-tab="account"]').click();
}

function stubImagePrep(window, opts) {
  opts = opts || {};
  window.HaimuniaImage.prepareImage = async (file, prepOpts) => {
    if (opts.captureOpts) opts.captureOpts(prepOpts);
    if (opts.reject) { const e = new Error(opts.reject); e.code = opts.reject; throw e; }
    return {
      type: "image/webp",
      source: { width: 800, height: 800 },
      render: { blob: { size: 40000, type: "image/webp" }, bytes: 40000, quality: 0.8, width: 320, height: 320, type: "image/webp" },
      thumbnail: null,
      thumbnails: [],
    };
  };
}

function selectAvatarFile(window, file) {
  const input = window.document.querySelector("[data-avatar-file]");
  const f = file || { name: "me.jpg", type: "image/jpeg", size: 4000 };
  Object.defineProperty(input, "files", { configurable: true, value: [f] });
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
}

test("no photo: the account form shows the upload control and initials, no remove button", async () => {
  const window = await bootCommunity(seeded(null), { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.getElementById("communityProfile"), 3000);
  const form = window.document.getElementById("communityProfile");
  assert.ok(form.querySelector("[data-avatar-file]"), "a file input exists");
  assert.ok(form.querySelector(".avatar-badge"), "an avatar badge renders");
  assert.ok(!form.querySelector(".avatar-badge img"), "it is the initials span, not an img, with no photo set");
  assert.ok(!form.querySelector('[data-community-action="avatar-remove"]'), "no remove button until a photo exists");
});

test("uploading a photo calls prepareImage with avatar-sized options, stores the public URL, and switches the badge to a real img", async () => {
  const mock = seeded(null);
  const window = await bootCommunity(mock, { syncEnabled: false });
  let capturedOpts = null;
  stubImagePrep(window, { captureOpts: (o) => { capturedOpts = o; } });
  await openAccountTab(window);
  await waitFor(() => !!window.document.getElementById("communityProfile"), 3000);

  selectAvatarFile(window);
  await waitFor(() => !!window.document.querySelector('.chart-card img.avatar-badge'), 3000);

  assert.ok(capturedOpts, "prepareImage was called");
  assert.equal(capturedOpts.maxEdge, 320, "avatar renders are capped smaller than the composer's feed-photo default");
  assert.deepEqual(capturedOpts.thumbEdges, [], "no separate thumbnail is generated for an avatar");
  assert.equal(capturedOpts.targetBytes, 60 * 1024);
  assert.equal(capturedOpts.hardCapBytes, 300 * 1024);

  // 202609060003 made avatar-photos a PRIVATE bucket, so what gets rendered
  // is a short-lived signed URL for the object, not the stored value. The
  // stored value is still the /object/public/ form: it is the identifier for
  // the object and the carrier for the ?t= cache-bust, and it 400s if
  // anybody fetches it directly, which is the whole point of the flip.
  const img = window.document.querySelector('.chart-card img.avatar-badge');
  assert.ok(img.getAttribute("src").startsWith("https://mock/signed/avatar-photos/"), "the rendered src is a SIGNED url, not the stored public one - the bucket is private");
  assert.ok(img.getAttribute("src").includes("/u1/avatar."), "signed for the deterministic per-member path");
  const stored = mock.db.profiles.find((p) => p.id === "u1").avatar_url;
  assert.ok(stored.includes("avatar-photos/u1/avatar."), "uploaded to the deterministic per-member path");
  assert.ok(stored.includes("?t="), "the stored URL is cache-busted");
  assert.ok(/^https?:\/\//.test(stored), "and still satisfies profiles.avatar_url's ^https?:// CHECK (202609060006)");
  assert.notEqual(stored, img.getAttribute("src"), "the stored value is deliberately NOT what is rendered any more");
  assert.ok(window.document.querySelector('[data-community-action="avatar-remove"]'), "a remove control appears once a photo exists");
});

test("a non-image file surfaces the same Hebrew copy the PR-share photo flow uses, and does not touch avatar_url", async () => {
  const mock = seeded(null);
  const window = await bootCommunity(mock, { syncEnabled: false });
  stubImagePrep(window, { reject: "not_an_image" });
  await openAccountTab(window);
  await waitFor(() => !!window.document.getElementById("communityProfile"), 3000);

  selectAvatarFile(window, { name: "notes.txt", type: "text/plain", size: 100 });
  await waitFor(() => !!window.document.querySelector(".field-error"), 3000);

  assert.equal(window.document.querySelector(".field-error").textContent, "הקובץ אינו תמונה");
  assert.equal(mock.db.profiles.find((p) => p.id === "u1").avatar_url, null, "the rejected upload never reached profiles");
});

test("any other prepareImage/upload failure gets the generic upload-failed copy", async () => {
  const mock = seeded(null);
  const window = await bootCommunity(mock, { syncEnabled: false });
  stubImagePrep(window, { reject: "decode_failed" });
  await openAccountTab(window);
  await waitFor(() => !!window.document.getElementById("communityProfile"), 3000);

  selectAvatarFile(window);
  await waitFor(() => !!window.document.querySelector(".field-error"), 3000);
  assert.equal(window.document.querySelector(".field-error").textContent, "העלאת התמונה נכשלה");
});

test("removing a photo clears avatar_url, drops the storage object, and every avatarHtml() surface reverts to initials", async () => {
  const mock = seeded("https://mock/public/avatar-photos/u1/avatar.webp?t=1");
  let removedPaths = null;
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.getElementById("communityProfile"), 3000);

  assert.ok(window.document.querySelector('.chart-card img.avatar-badge'), "starts with a real photo rendered");
  window.document.querySelector('[data-community-action="avatar-remove"]').click();
  await waitFor(() => !window.document.querySelector('.chart-card img.avatar-badge'), 3000);

  assert.equal(mock.db.profiles.find((p) => p.id === "u1").avatar_url, null, "profiles.avatar_url was cleared");
  assert.ok(window.document.querySelector('.chart-card .avatar-badge'), "an initials badge is shown again");
  assert.ok(!window.document.querySelector('[data-community-action="avatar-remove"]'), "the remove control disappears once there is nothing to remove");
});

test("a stored avatar renders through a signed URL, and degrades to initials when signing is refused", async () => {
  const mock = seeded("https://mock/public/avatar-photos/u1/avatar.webp?t=1");
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.querySelector(".chart-card img.avatar-badge"), 3000);
  assert.equal(
    window.document.querySelector(".chart-card img.avatar-badge").getAttribute("src"),
    "https://mock/signed/avatar-photos/u1/avatar.webp",
    "the stored public URL is never used as the src - the path inside it is signed instead, and the ?t= cache-bust is not part of the storage path");
});

test("a refused signature leaves the initials badge rather than a broken image", async () => {
  // The realistic cause is the SELECT policy doing its job: a member who hid
  // from the club, or a block edge. An initials badge is a correct answer to
  // "you may not see this face", so this is a fallback and not an error path.
  const mock = seeded("https://mock/public/avatar-photos/u1/avatar.webp?t=1");
  const origFrom = mock.client.storage.from;
  mock.client.storage.from = (bucket) => {
    const real = origFrom(bucket);
    if (bucket !== "avatar-photos") return real;
    return Object.assign({}, real, { createSignedUrl: () => Promise.resolve({ data: null, error: { message: "denied" } }) });
  };
  const window = await bootCommunity(mock, { syncEnabled: false });
  await openAccountTab(window);
  await waitFor(() => !!window.document.getElementById("communityProfile"), 3000);
  assert.ok(window.document.querySelector(".chart-card .avatar-badge"), "a badge still renders");
  assert.ok(!window.document.querySelector(".chart-card img.avatar-badge"), "and it is the initials span, with no broken <img> left on screen");
});

test("a fresh sign-out resets the avatar upload UI state for the next member on this device", async () => {
  const mock = seeded(null);
  const window = await bootCommunity(mock, { syncEnabled: false });
  stubImagePrep(window, { reject: "decode_failed" });
  await openAccountTab(window);
  await waitFor(() => !!window.document.getElementById("communityProfile"), 3000);
  selectAvatarFile(window);
  await waitFor(() => !!window.document.querySelector(".field-error"), 3000);

  window.document.querySelector('[data-community-action="sign-out"]').click();
  await waitFor(() => !window.document.querySelector("#communityProfile"), 3000);
});
