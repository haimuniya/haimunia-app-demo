// ⚠ THIS FILE POINTS AT PRODUCTION, AND IT IS COMMITTED.
// The URL below is a live Supabase project with real members' data, and this
// file is what the GitHub Pages build serves. Repointing it at localhost for
// testing and committing that aims every installed PWA at a machine that is
// not there. To test locally, override it at RUNTIME instead - serve a copy,
// or set window.HAIMUNIA_CONFIG before this script loads - and leave the
// tracked file alone.
//
// Public browser configuration only. The publishable key is intentionally
// safe to ship when every exposed table is protected by RLS. Never put a
// Supabase secret/service-role key in this repository.
window.HAIMUNIA_CONFIG = Object.freeze({
  supabaseUrl: "https://jajmlyrjlkhclgphbfbb.supabase.co",
  supabasePublishableKey: "sb_publishable_DBnlKZMDKGR83DUtk-4VAA_nFlOdDI4",
  // COMM-229. VAPID public key, base64url, the uncompressed EC point (0x04
  // || X || Y) `PushManager.subscribe({applicationServerKey})` expects. A
  // VAPID public key is meant to be exposed to the browser - the private
  // half is what has to stay secret, and it is NOT in this repo. This
  // demo keypair was generated with Node's crypto.generateKeyPair('ec',
  // {namedCurve: 'prime256v1'}) as a one-off script (no `web-push`
  // dependency added just for key generation). Whoever builds
  // `notif_push_send` (the actual server-side Web Push send, out of
  // COMM-229's scope - see docs/community/contracts.md, "Needs from
  // schema, notifications (Phase 2)") needs the matching private key
  // provisioned as a Supabase Edge Function secret (e.g. `VAPID_PRIVATE_KEY`
  // via `supabase secrets set`), never committed here or anywhere else in
  // the repo. Behind NOTIF_PUSH_ENABLED / state.featureFlags.notifPush,
  // which stays default off in production until that provisioning happens.
  notifPushVapidPublicKey: "BD16mHSAcS-jU5cV2xEqkNy09hCQ7MTjkY22CK8UrRw1JpI_5kjReL7tME6O4BFmQhuiaOVCWQ-nqsnoa1_0nAo",

  // Launch-readiness audit, SEC-004: bot protection on account creation.
  //
  // Anonymous sign-in is enabled (it is how every signup bootstraps - see
  // COMMUNITY_SETUP.md "Sign-in has no email"), so without a CAPTCHA an
  // attacker can mint unlimited free `authenticated` identities in a loop.
  // That is the raw material for feed scraping, telemetry/storage flooding
  // and invite-code guessing at scale.
  //
  // A SITE KEY IS PUBLIC by design - it is meant to ship in the browser,
  // exactly like supabasePublishableKey above. The matching SECRET key is
  // never in this repo: it goes in the Supabase dashboard only
  // (Authentication -> Bot and Abuse Protection), which is what actually
  // verifies the token server-side.
  //
  // LEAVE THIS EMPTY STRING to keep CAPTCHA off. The client treats "" as
  // "not configured" and behaves exactly as it did before this feature
  // existed, so a project that has not enabled it in the dashboard yet is
  // not broken by this file. Turning it on is: set the provider + secret
  // in the dashboard, paste the site key here, deploy.
  // See COMMUNITY_SETUP.md "CAPTCHA on sign-up" for the full runbook.
  captchaProvider: "turnstile", // "turnstile" | "hcaptcha"
  captchaSiteKey: "",
});
