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

const RESET_VERSION = 1;

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
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    console.error(`admin_reset_password v${RESET_VERSION}: missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY`);
    return new Response(JSON.stringify({ error: "missing service credentials" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const authHeader = req.headers.get("Authorization") || "";
  const callerJwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!callerJwt) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { target_user_id?: string };
  try {
    body = await req.json();
  } catch (_e) {
    body = {};
  }
  const targetUserId = typeof body.target_user_id === "string" ? body.target_user_id : "";
  if (!targetUserId) {
    return new Response(JSON.stringify({ error: "target_user_id required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
    });
  }

  const tempPassword = generateTempPassword();
  const { error: updateErr } = await adminClient.auth.admin.updateUserById(targetUserId, { password: tempPassword });
  if (updateErr) {
    console.error(`admin_reset_password v${RESET_VERSION}: updateUserById failed`, updateErr.message);
    return new Response(JSON.stringify({ error: "password reset failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
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
    { headers: { "Content-Type": "application/json" } },
  );
});
