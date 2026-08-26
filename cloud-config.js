// Public browser configuration only. The publishable key is intentionally
// safe to ship when every exposed table is protected by RLS. Never put a
// Supabase secret/service-role key in this repository.
window.HAIMUNIA_CONFIG = Object.freeze({
  supabaseUrl: "",
  supabasePublishableKey: "",
});
