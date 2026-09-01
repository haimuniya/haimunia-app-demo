import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

// COMM-318, schema half. Storage bucket/RLS SQL in this repo is verified
// by regex assertion against the migration's raw text, not pgTAP — see
// the equivalent post-photos assertions in test/community-engagement.test.mjs
// and test/security-hardening.test.mjs, which this file mirrors.
const sql = fs.readFileSync(new URL("../supabase/migrations/202609010010_avatar_photo.sql", import.meta.url), "utf8");

test("avatar-photos bucket is public with a 2MB / 3-mime limit", () => {
  assert.match(sql, /insert into storage\.buckets \(id, name, public, file_size_limit, allowed_mime_types\)/i);
  assert.match(sql, /'avatar-photos', 'avatar-photos', true, 2097152/i);
  assert.match(sql, /array\['image\/jpeg','image\/png','image\/webp'\]/i);
});

test("can_write_own_avatar requires a real, non-deleted, invite-redeemed profile whose id matches the object's path prefix", () => {
  const fn = sql.slice(sql.indexOf("create or replace function public.can_write_own_avatar"), sql.indexOf("create policy avatar_photos_insert_own"));
  assert.match(fn, /split_part\(p_name, '\/', 1\) = auth\.uid\(\)::text/i);
  assert.match(fn, /join public\.invite_redemptions/i);
  assert.match(fn, /p\.deleted_at is null/i);
  assert.match(fn, /revoke all on function public\.can_write_own_avatar\(text\) from public, anon/i);
  assert.match(fn, /grant execute on function public\.can_write_own_avatar\(text\) to authenticated/i);
  // Deliberately no object-count cap, unlike can_upload_post_photo - an
  // avatar is one-per-member by convention, not an accumulating list.
  assert.doesNotMatch(fn, /count\(\*\)/i);
});

test("insert AND update policies both exist, gated the same way (upsert:true needs both, not just insert)", () => {
  assert.match(sql, /create policy avatar_photos_insert_own on storage\.objects for insert to authenticated\s*with check \(bucket_id = 'avatar-photos' and public\.can_write_own_avatar\(name\)\)/i);
  assert.match(sql, /create policy avatar_photos_update_own on storage\.objects for update to authenticated\s*using \(bucket_id = 'avatar-photos' and public\.can_write_own_avatar\(name\)\)\s*with check \(bucket_id = 'avatar-photos' and public\.can_write_own_avatar\(name\)\)/i);
});

test("delete policy lets a member remove their own avatar object", () => {
  assert.match(sql, /create policy avatar_photos_delete_own on storage\.objects for delete to authenticated\s*using \(bucket_id = 'avatar-photos' and public\.can_write_own_avatar\(name\)\)/i);
});

test("a select-all policy exists for tooling, explicitly noted as not required for the feature itself", () => {
  assert.match(sql, /create policy avatar_photos_select_all on storage\.objects for select\s*using \(bucket_id = 'avatar-photos'\)/i);
  assert.match(sql, /not required for the feature itself/i);
});

test("the migration explains why public.profiles and its RLS are untouched, rather than leaving that silent", () => {
  assert.match(sql, /profiles_update_self/i);
  assert.match(sql, /protect_is_admin/i);
  assert.match(sql, /nothing to add here/i);
});
