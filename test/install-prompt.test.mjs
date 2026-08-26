// Coverage gap closed (full-codebase audit): the beforeinstallprompt/
// install-banner flow had zero automated coverage. Chrome/Android fire
// beforeinstallprompt once, early, and expect the page to call
// e.preventDefault() and stash it to replay later via evt.prompt() — this
// drives that whole handshake with a synthetic event carrying a fake
// prompt()/userChoice, the same shape a real browser's event has.
// iOS Safari never fires this event at all — there's nothing to test for
// that path beyond "the banner simply never appears," which is already
// true by construction (showInstallBanner() is never called).
import { test } from "node:test";
import assert from "node:assert";
import { bootApp } from "./helpers/boot.mjs";

function fireBeforeInstallPrompt(window, { promptCalls, outcome = "accepted" } = {}) {
  const evt = new window.Event("beforeinstallprompt", { cancelable: true });
  evt.prompt = () => { if (promptCalls) promptCalls.count++; };
  evt.userChoice = Promise.resolve({ outcome });
  window.dispatchEvent(evt);
  return evt;
}

test("beforeinstallprompt shows the install banner, deferring the browser's own prompt", async () => {
  const window = await bootApp();
  const banner = window.document.getElementById("installBanner");
  assert.notEqual(banner.style.display, "block", "the banner should be hidden until the event fires");

  fireBeforeInstallPrompt(window);
  assert.equal(banner.style.display, "block", "beforeinstallprompt should reveal the install banner");
});

test("tapping install replays the deferred native prompt and hides the banner", async () => {
  const window = await bootApp();
  const promptCalls = { count: 0 };
  fireBeforeInstallPrompt(window, { promptCalls });

  window.document.querySelector("[data-action='install-app']").click();
  await new Promise((r) => setTimeout(r, 0)); // installApp() awaits evt.userChoice

  assert.equal(promptCalls.count, 1, "tapping install should call the deferred event's own prompt()");
  assert.equal(window.document.getElementById("installBanner").style.display, "none", "the banner should hide once install is triggered");
});

test("dismissing the banner hides it and it does not reappear for the rest of the session", async () => {
  const window = await bootApp();
  fireBeforeInstallPrompt(window);
  window.document.querySelector("[data-action='dismiss-install-hint']").click();
  assert.equal(window.document.getElementById("installBanner").style.display, "none");

  // showInstallBanner() checks sessionStorage before showing again — a
  // second beforeinstallprompt-shaped call (unlikely in a real browser,
  // which only fires it once, but exercises the same guard) must not
  // reopen it after a dismissal this session.
  window.showInstallBanner();
  assert.equal(window.document.getElementById("installBanner").style.display, "none", "a dismissed banner should stay dismissed for the session");
});

test("the appinstalled event hides the banner and clears the deferred prompt so a stray tap does nothing", async () => {
  const window = await bootApp();
  const promptCalls = { count: 0 };
  fireBeforeInstallPrompt(window, { promptCalls });
  assert.equal(window.document.getElementById("installBanner").style.display, "block");

  window.dispatchEvent(new window.Event("appinstalled"));
  assert.equal(window.document.getElementById("installBanner").style.display, "none", "appinstalled should hide the banner");

  // installApp() no-ops when there's no deferred prompt left.
  window.document.querySelector("[data-action='install-app']").click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(promptCalls.count, 0, "a tap after appinstalled must not replay a stale prompt");
});
