// Security hunt, round 2 (2026-09-11), file-upload security agent.
// Fourth Edge Function in this repo, after `recap_weekly` (COMM-220),
// `purge_abandoned_profiles` (COMM-314) and `admin_reset_password`
// (SEC-011). Same server-to-server shape as the first two: runs as
// service_role only, never called from a browser, invoked by
// 202609110003_sanitize_upload_trigger.sql's AFTER INSERT trigger on
// storage.objects via the same net.http_post/Vault-secret bridge
// cron_invoke_edge_function() already established for recap_weekly and
// purge_abandoned_profiles - fire-and-forget, inert on local/CI until the
// two edge_functions_* Vault secrets are set on the real project.
//
// WHAT THIS CLOSES. See supabase/functions/_shared/imageSanitize.mjs's own
// header for the full finding: src/image.js's decode/re-encode pipeline is
// the only thing that (a) rejects non-image bytes and (b) strips
// EXIF/GPS/XMP metadata, and it is a purely client-side property - a
// direct, unauthenticated-by-the-app upload to Storage (any member's own
// devtools console, using the anon key and session already shipped in
// every installed copy of the PWA) bypasses it entirely. This function is
// the server-side backstop: for every object written to post-photos or
// avatar-photos, it downloads the object, verifies it by magic bytes
// (not the Content-Type header the uploader chose to send), and either
// re-uploads it with metadata segments/chunks stripped, or deletes it if
// it isn't actually one of the three allowed image formats.
//
// Local test/invoke path: `supabase functions serve sanitize_upload` (or
// `supabase start`), then
// `curl -X POST http://127.0.0.1:54321/functions/v1/sanitize_upload \
//   -H "Authorization: Bearer <service_role key>" \
//   -H "Content-Type: application/json" \
//   -d '{"bucket":"post-photos","path":"<uid>/example.jpg"}'`.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { sanitizeImageBytes } from "../_shared/imageSanitize.mjs";

const SANITIZE_VERSION = 1;
const ALLOWED_BUCKETS = new Set(["post-photos", "avatar-photos"]);

// Same fix as recap_weekly/purge_abandoned_profiles's own copy of this
// helper - plain `!==` short-circuits at the first differing byte, a
// genuine (if low-practicality-over-a-real-network) timing side channel on
// the service-role key. Not shared via an import: these files are deployed
// as independent Edge Functions.
function timingSafeEqualStrings(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error(`sanitize_upload v${SANITIZE_VERSION}: missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY`);
    return new Response(JSON.stringify({ error: "missing service credentials" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Runs as service_role only - see purge_abandoned_profiles's own comment
  // on why this check exists at all (the platform's verify_jwt only proves
  // SOME valid JWT was presented, and the anon key satisfies that just as
  // well). Without it, an unauthenticated caller could force this function
  // to fetch and overwrite arbitrary objects in either bucket on demand.
  if (!timingSafeEqualStrings(req.headers.get("Authorization") || "", `Bearer ${serviceRoleKey}`)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { bucket?: string; path?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const bucket = body.bucket;
  const path = body.path;
  if (!bucket || !ALLOWED_BUCKETS.has(bucket) || typeof path !== "string" || path.length === 0) {
    return new Response(JSON.stringify({ error: "unknown bucket or missing path" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  try {
    const { data: downloaded, error: downloadErr } = await supabase.storage.from(bucket).download(path);
    if (downloadErr || !downloaded) {
      // Already gone (deleted right after upload, or this is a retry of an
      // already-sanitized object) - nothing to do, not a failure.
      return new Response(JSON.stringify({ ok: true, action: "skipped-missing" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    const bytes = new Uint8Array(await downloaded.arrayBuffer());
    const result = sanitizeImageBytes(bytes);

    if (!result.ok) {
      // Bytes don't match any of the three allowed image signatures
      // regardless of what Content-Type the uploader declared - finding 1.
      // The object is a stored disguised-as-a-photo file at this point;
      // removing it is the correct response, same as the bucket's own
      // allowed_mime_types allowlist already tries (and fails) to do.
      const { error: removeErr } = await supabase.storage.from(bucket).remove([path]);
      console.log(`sanitize_upload v${SANITIZE_VERSION}: rejected non-image upload`, { bucket, removed: !removeErr });
      return new Response(JSON.stringify({ ok: true, action: "rejected-non-image" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const { error: uploadErr } = await supabase.storage.from(bucket).update(path, result.bytes, {
      contentType: result.contentType,
      upsert: true,
    });
    if (uploadErr) throw uploadErr;

    console.log(`sanitize_upload v${SANITIZE_VERSION}: sanitized`, {
      bucket,
      contentType: result.contentType,
      bytesBefore: bytes.length,
      bytesAfter: result.bytes.length,
    });
    return new Response(JSON.stringify({ ok: true, action: "sanitized", bytesRemoved: bytes.length - result.bytes.length }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (_err) {
    console.error(`sanitize_upload v${SANITIZE_VERSION}: run failed`, { bucket });
    return new Response(JSON.stringify({ error: "sanitize_upload run failed", version: SANITIZE_VERSION }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
