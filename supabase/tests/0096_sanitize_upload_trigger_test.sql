-- Security hunt round 2 (202609110003): the sanitize_upload trigger bridge.
-- Behavioural coverage matches 0063's own coverage of cron_invoke_edge_function
-- (the bridge this one reuses): structural existence, grants, and inert
-- behaviour while the Vault secrets are still committed placeholders - the
-- state of every local/CI stack. The image-sanitizing byte logic itself
-- (magic-byte detection, EXIF/metadata stripping) is regression-tested
-- separately in test/security-hunt-image-sanitize.test.mjs, which runs
-- against the exact same file this Edge Function imports.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

select has_function('public', 'storage_invoke_sanitize', 'the trigger function exists');
select ok(
  not has_function_privilege('authenticated', 'public.storage_invoke_sanitize()', 'EXECUTE'),
  'storage_invoke_sanitize is granted to no client role - it only runs as a trigger');

select isnt_empty(
  $$ select 1 from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
     join pg_proc p on p.oid = t.tgfoid
     where n.nspname = 'storage' and c.relname = 'objects'
       and t.tgname = 'sanitize_upload_after_write'
       and p.proname = 'storage_invoke_sanitize'
       and not t.tgisinternal $$,
  'sanitize_upload_after_write fires storage_invoke_sanitize() on storage.objects');

-- pg_trigger.tgtype bitmask (see trigger.h): 0x02 BEFORE, 0x04 INSERT,
-- 0x10 UPDATE. AFTER is the absence of the BEFORE bit (and this is a plain
-- row trigger, not INSTEAD OF, by construction).
select results_eq(
  $$ select (t.tgtype & 2 = 0), (t.tgtype & 4 <> 0), (t.tgtype & 16 <> 0)
     from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'storage' and c.relname = 'objects' and t.tgname = 'sanitize_upload_after_write' $$,
  $$ values (true, true, true) $$,
  'the trigger fires AFTER, on INSERT and on UPDATE - avatar re-uploads (upsert:true) emit UPDATE from the second write onward');

select matches(
  (select pg_get_triggerdef(t.oid) from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'storage' and c.relname = 'objects' and t.tgname = 'sanitize_upload_after_write'),
  $$post-photos.*avatar-photos$$,
  'the WHEN clause scopes the trigger to exactly the two photo buckets');

-- Inert while the Vault secrets are the committed placeholders (every
-- local/CI stack): a real INSERT into storage.objects for a watched bucket
-- must not error even though the trigger function runs on every row.
select lives_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     values ('post-photos', tests.uid('m1')::text || '/sec-hunt-test.jpg', tests.uid('m1')) $$,
  'inserting into the post-photos bucket does not error - the bridge is inert while Vault secrets are placeholders, same as cron_invoke_edge_function');

select lives_ok(
  $$ update storage.objects set name = tests.uid('m1')::text || '/sec-hunt-test-2.jpg'
     where bucket_id = 'post-photos' and name = tests.uid('m1')::text || '/sec-hunt-test.jpg' $$,
  'updating the same object (the upsert:true shape a real re-upload takes) also does not error');

select lives_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     values ('avatar-photos', tests.uid('m1')::text || '/avatar.webp', tests.uid('m1')) $$,
  'inserting into the avatar-photos bucket does not error either');

select tests.clear_auth();
select * from finish();
rollback;
