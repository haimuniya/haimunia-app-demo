// Admin-triggered member password reset - closes the "no way back in"
// gap the 2026-09-05 launch-readiness audit found: login emails are
// synthetic (usernameToEmail(), cloud.js), so Supabase's own
// email-a-reset-link flow has no real address to deliver to, and no
// self-service path exists. This is the deliberately chosen alternative:
// an admin sets a new temporary password and relays it to the member
// directly, matching what PRIVACY.md already tells members to do
// ("contact your coach").
//
// Third Edge Function in this repo, after `recap_weekly` (COMM-220) and
// `purge_abandoned_profiles` (COMM-314). Different auth shape than both of
// those on purpose: they run only for a scheduler/ops operator holding the
// real service-role key. This one is invoked directly by a real logged-in
// admin from the app with their OWN session access token - the
// service-role key never leaves this function's environment.
//
// Local test/invoke path: `supabase functions serve admin_reset_password`
// (or `supabase start`), then
// `curl -X POST http://127.0.0.1:54321/functions/v1/admin_reset_password \
//   -H "Authorization: Bearer <a real admin's access token>" \
//   -H "Content-Type: application/json" \
//   -d '{"target_user_id":"<uuid>"}'`.
//
// WHY THIS DOES NOT UPDATE auth.users DIRECTLY FROM SQL: GoTrue owns
// auth.users' encrypted_password (bcrypt), and no migration in this repo
// has ever reached into that table to set one - inventing that here would
// duplicate GoTrue's own hashing logic outside its control. The Admin SDK's
// `auth.admin.updateUserById()` is the officially supported way to set a
// user's password from server code, so that is the only privileged
// operation this file performs.
//
// AUDIT LOGGING: `log_admin_action()` (202608280002_admin_actions.sql) is
// not grantable to `authenticated` - only callable from inside another
// SECURITY DEFINER function, same as every other admin action in this
// repo. So the actual audit row is written by calling the
// `admin_log_password_reset(p_user_id uuid)` RPC (see the schema migration
// that added the `member_password_reset` action_type) using a client
// scoped to the CALLER's own JWT, not service_role - so auth.uid() inside
// that definer function resolves to the real admin, and its own is_admin()
// check is real defense-in-depth, not just this file's say-so.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const RESET_VERSION = 2;

// Launch-readiness audit, SEC-011. This function is the only one of the
// three Edge Functions in this repo ever called from a browser (the other
// two are service-role-only, invoked by pg_cron via the Vault bridge) -
// cloud.js:3063 invokes it with the caller's own Authorization header,
// which forces a CORS preflight. Scoped to the app's real origins rather
// than "*", since this endpoint resets a password.
const ALLOWED_ORIGINS = new Set([
  "https://haimuniya.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("Origin") || "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Vary": "Origin",
  };
  if (ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] = "authorization, content-type";
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
  }
  return headers;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function generateTempPassword(): string {
  // Server-generated only - never accept a password from the client, so a
  // compromised admin session can't be used to set a known/weak one.
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

Deno.serve(async (req: Request) => {
  // Preflight: the browser sends this before the real POST because
  // cloud.js:3063 attaches an Authorization header. Answered before any
  // credential/env check below, same as any other CORS preflight.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    console.error(`admin_reset_password v${RESET_VERSION}: missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY`);
    return new Response(JSON.stringify({ error: "missing service credentials" }), {
      status: 500,
      headers: corsHeaders(req),
    });
  }

  const authHeader = req.headers.get("Authorization") || "";
  const callerJwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!callerJwt) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: corsHeaders(req),
    });
  }

  // Identify the caller from their OWN token - never trust a client-sent
  // "I am an admin" flag.
  const callerClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${callerJwt}` } },
  });
  const { data: userData, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: corsHeaders(req),
    });
  }

  let body: { target_user_id?: string };
  try {
    body = await req.json();
  } catch (_e) {
    body = {};
  }
  const targetUserId = typeof body.target_user_id === "string" ? body.target_user_id : "";
  if (!targetUserId || !UUID_RE.test(targetUserId)) {
    return new Response(JSON.stringify({ error: "target_user_id must be a uuid" }), {
      status: 400,
      headers: corsHeaders(req),
    });
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  // Real admin check, server-side, via the service-role client (bypasses
  // RLS safely here since we already know exactly who the caller is).
  const { data: profile, error: profileErr } = await adminClient
    .from("profiles")
    .select("is_admin")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (profileErr || !profile?.is_admin) {
    return new Response(JSON.stringify({ error: "not authorized" }), {
      status: 403,
      headers: corsHeaders(req),
    });
  }

  // Launch-readiness audit, SEC-011 (rate limit). Checked with the CALLING
  // ADMIN's own JWT, before anything is changed, so a compromised or
  // hijacked admin session cannot loop a club-wide password-reset lockout.
  // admin_check_password_reset_rate_limit() (202609060012) re-checks
  // is_admin() itself server-side too - defense in depth, not just this
  // file's say-so.
  const { error: rateLimitErr } = await callerClient.rpc("admin_check_password_reset_rate_limit");
  if (rateLimitErr) {
    const limited = /rate_limited/i.test(rateLimitErr.message);
    return new Response(JSON.stringify({ error: limited ? "rate_limited" : "not authorized" }), {
      status: limited ? 429 : 403,
      headers: corsHeaders(req),
    });
  }

  // Launch-readiness audit, SEC-011 (target validation). The UUID format
  // check above only rules out garbage; this confirms the target is an
  // actual, non-deleted club member rather than an arbitrary auth.users row
  // (a ghost, a backup-only session - COMMUNITY_SETUP.md SS Offline
  // synchronization confirms these exist).
  const { data: targetProfile, error: targetErr } = await adminClient
    .from("profiles")
    .select("id")
    .eq("id", targetUserId)
    .is("deleted_at", null)
    .maybeSingle();
  if (targetErr || !targetProfile) {
    return new Response(JSON.stringify({ error: "target is not a club member" }), {
      status: 404,
      headers: corsHeaders(req),
    });
  }

  const tempPassword = generateTempPassword();
  const { error: updateErr } = await adminClient.auth.admin.updateUserById(targetUserId, { password: tempPassword });
  if (updateErr) {
    console.error(`admin_reset_password v${RESET_VERSION}: updateUserById failed`, updateErr.message);
    return new Response(JSON.stringify({ error: "password reset failed" }), {
      status: 500,
      headers: corsHeaders(req),
    });
  }

  // Audit row, via the caller's own JWT so auth.uid() inside the definer
  // function is the real admin, not service_role. A failure here does not
  // undo the password reset (it already happened and the admin already
  // has the new password to relay) - it's logged and surfaced, not silently
  // swallowed, matching this repo's error-surfacing convention.
  const { error: auditErr } = await callerClient.rpc("admin_log_password_reset", { p_user_id: targetUserId });
  if (auditErr) {
    console.error(`admin_reset_password v${RESET_VERSION}: audit log failed`, auditErr.message);
  }

  return new Response(
    JSON.stringify({ version: RESET_VERSION, temp_password: tempPassword, audited: !auditErr }),
    { headers: corsHeaders(req) },
  );
});
