begin;

-- Security hunt, round 2 (2026-09-11), file-upload security agent. Wires
-- the sanitize_upload Edge Function (supabase/functions/sanitize_upload/)
-- to fire after every write to post-photos/avatar-photos, closing the two
-- confirmed findings: a spoofed Content-Type header can get non-image
-- bytes past the bucket's allowed_mime_types allowlist, and EXIF/GPS
-- stripping is otherwise a client-side-only property of src/image.js with
-- no server-side backstop. See that function's own header and
-- supabase/functions/_shared/imageSanitize.mjs's header for the full
-- finding and fix.
--
-- SAME BRIDGE 202609050005 ALREADY BUILT, reused rather than duplicated:
-- net.http_post to <edge_functions_base_url>/<slug> with an
-- `Authorization: Bearer <edge_functions_service_role_key>` header, both
-- read from Supabase Vault at call time and NEVER written into a
-- migration. cron_invoke_edge_function() already does exactly this for a
-- pg_cron schedule; storage_invoke_sanitize() below is the same shape
-- wired to an AFTER INSERT/UPDATE trigger on storage.objects instead of a
-- time-based schedule. Both are equally fire-and-forget (pg_net queues the
-- request and returns immediately - a trigger cannot synchronously block
-- an insert on an external HTTP round trip without risking the whole
-- upload transaction on that call's latency, so this is eventual, not a
-- synchronous gate) and both are equally INERT on local/CI until the real
-- project's Vault secrets are set - the same state recap_weekly and
-- purge_abandoned_profiles have been in since 202609050005, so this is not
-- a new gap this migration introduces, only one more caller of an already
-- accepted bridge.
create or replace function public.storage_invoke_sanitize()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_base text;
  v_key text;
begin
  select s.decrypted_secret into v_base
    from vault.decrypted_secrets s where s.name = 'edge_functions_base_url';
  select s.decrypted_secret into v_key
    from vault.decrypted_secrets s where s.name = 'edge_functions_service_role_key';

  if v_base is null or v_key is null
     or v_base like '%PROJECT-REF-NOT-SET%'
     or v_key = 'SERVICE-ROLE-KEY-NOT-SET' then
    -- Same inert-until-configured behavior cron_invoke_edge_function()
    -- documents; no raise notice here since this fires per-upload rather
    -- than per-scheduled-run and would otherwise spam the log on every
    -- local/CI test upload.
    return new;
  end if;

  perform net.http_post(
    url := rtrim(v_base, '/') || '/sanitize_upload',
    body := jsonb_build_object('bucket', new.bucket_id, 'path', new.name),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    timeout_milliseconds := 30000
  );
  return new;
end $$;
revoke all on function public.storage_invoke_sanitize() from public, anon, authenticated;
comment on function public.storage_invoke_sanitize() is
  'Security hunt round 2 (202609110003). AFTER INSERT/UPDATE trigger function on storage.objects (post-photos/avatar-photos only, see sanitize_upload_after_write trigger). Fires a fire-and-forget net.http_post at <edge_functions_base_url>/sanitize_upload with {bucket, path}, same Vault-secret bridge cron_invoke_edge_function() (202609050005) already established. Inert (returns immediately, no request sent) while the edge_functions_* Vault secrets are unset or still placeholders - the state of every local/CI stack, matching recap_weekly and purge_abandoned_profiles.';

-- AFTER, not BEFORE: the object already exists in Storage's backing store
-- by the time a row lands in storage.objects (this table is metadata for
-- an object PostgREST/Storage already accepted), so there is nothing a
-- BEFORE trigger here could prevent - sanitize_upload's own job is to
-- download what was already written and fix it up or remove it after the
-- fact. UPDATE is included because avatar-photos uploads with upsert:true
-- (an avatar re-upload replaces the same path, so it emits an UPDATE, not
-- an INSERT, from the second upload onward).
drop trigger if exists sanitize_upload_after_write on storage.objects;
create trigger sanitize_upload_after_write
  after insert or update on storage.objects
  for each row
  when (new.bucket_id in ('post-photos', 'avatar-photos'))
  execute function public.storage_invoke_sanitize();

commit;
