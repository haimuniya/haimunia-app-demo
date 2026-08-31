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
});
