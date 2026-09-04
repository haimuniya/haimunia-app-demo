// Community promoted from hamburger-only to a real 5th bottom-bar tab,
// same footing as WOD (which already proved a bottom-bar tab can carry its
// own sub-nav). Not tied to a COMM ticket - a direct product-owner design
// call, not a filed audit finding. See app.js's getNavItems() comment for
// the full reasoning.
import { test } from "node:test";
import assert from "node:assert";
import { bootApp } from "./helpers/boot.mjs";

test("Community is a real bottom-bar tab now, not hamburger-only", async () => {
  const window = await bootApp();
  const bottomBarBtn = window.document.querySelector("#bottomTabBar #tabCommunityBtn");
  assert.ok(bottomBarBtn, "the bottom tab bar renders a Community button");
  assert.ok(bottomBarBtn.classList.contains("tabbtn"), "it carries the same tabbtn class every bottom-bar button does");

  // Exactly one #tabCommunityBtn in the whole document - the mobile
  // hamburger's onlyOther list is empty now that every item is `main:
  // true`, so it can never render a second, id-colliding copy.
  assert.equal(window.document.querySelectorAll("#tabCommunityBtn").length, 1);
});

test("tapping the bottom-bar Community tab switches to it like any other main tab", async () => {
  const window = await bootApp();
  window.document.getElementById("tabCommunityBtn").click();
  assert.equal(window.document.getElementById("tabCommunityBtn").getAttribute("aria-selected"), "true");
  assert.equal(window.document.getElementById("tabCommunityBtn").closest("#bottomTabBar") !== null, true);
});

test("the desktop sidebar still lists Community alongside the other 4 tabs, unaffected", async () => {
  const window = await bootApp();
  const sidebarLabels = Array.from(window.document.querySelectorAll("#desktopSidebar .navrow .nav-label")).map((el) => el.textContent);
  assert.ok(sidebarLabels.includes("קהילה"), "Community still appears in the always-visible desktop sidebar");
});
