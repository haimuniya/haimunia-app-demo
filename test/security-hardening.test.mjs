import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const sql = fs.readFileSync(new URL("../supabase/migrations/202608270006_security_hardening.sql", import.meta.url), "utf8");
const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const indexHtml = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("legacy plaintext invite codes are removed and revoked", () => {
  assert.match(sql, /set code_hash = encode\(extensions\.digest\(code, 'sha256'\), 'hex'\)/i);
  assert.match(sql, /revoked_at = coalesce\(revoked_at, now\(\)\)/i);
  assert.match(sql, /alter table public\.invite_codes drop column code/i);
  assert.match(sql, /alter table public\.invite_redemptions drop column code/i);
});

// Regression: unqualified pgcrypto calls broke a live run — "function
// gen_random_bytes(integer) does not exist" (42883). Every function here
// that calls a pgcrypto function sets `search_path = ''` (a deliberate
// hardening against search-path-hijacking in security-definer
// functions), and pgcrypto on this project is installed into the
// `extensions` schema, not `public` — pg_catalog is always implicitly
// searched regardless of search_path, but extension functions are not,
// so every digest()/gen_random_bytes() call inside one of these
// functions has to be schema-qualified.
test("every pgcrypto call (digest/gen_random_bytes) is schema-qualified with extensions., since these functions run with search_path = ''", () => {
  assert.doesNotMatch(sql, /[^.]\bdigest\(/i, "digest() must always be qualified as extensions.digest(), never called bare");
  assert.doesNotMatch(sql, /[^.]\bgen_random_bytes\(/i, "gen_random_bytes() must always be qualified as extensions.gen_random_bytes(), never called bare");
  assert.match(sql, /extensions\.digest\(/i);
  assert.match(sql, /extensions\.gen_random_bytes\(/i);
});

// Regression: this exact ordering broke a live run — "there is no unique
// constraint matching given keys for referenced table 'invite_codes'"
// (42830). A foreign key's target column needs a unique/primary-key
// constraint to already exist at the moment the FK is created — the new
// invite_redemptions_invite_id_fkey (referencing invite_codes.id) must
// come after invite_codes.id becomes the primary key, not before.
test("invite_codes' primary key moves to id before the new FK referencing id is created", () => {
  const pkDropAt = sql.indexOf("alter table public.invite_codes drop constraint invite_codes_pkey");
  const pkAddAt = sql.indexOf("alter table public.invite_codes add constraint invite_codes_pkey primary key (id)");
  const fkAddAt = sql.indexOf("alter table public.invite_redemptions add constraint invite_redemptions_invite_id_fkey");
  assert.ok(pkDropAt > -1 && pkAddAt > -1 && fkAddAt > -1, "all three statements must exist");
  assert.ok(pkDropAt < pkAddAt, "the old code-based primary key must be dropped before the new id-based one is added");
  assert.ok(pkAddAt < fkAddAt, "invite_codes.id must become the primary key before any FK references it");
});

test("member invites are high entropy, expiring, bounded, hashed, and service-role only", () => {
  const fn = sql.slice(sql.indexOf("create or replace function public.create_member_invite"), sql.indexOf("create or replace function public.grant_coach_role"));
  assert.match(fn, /encode\(extensions\.gen_random_bytes\(24\), 'hex'\)/i);
  assert.match(fn, /encode\(extensions\.digest\(v_code, 'sha256'\), 'hex'\)/i);
  assert.match(fn, /p_expires_at/i);
  assert.match(fn, /p_max_uses/i);
  assert.match(fn, /revoke all .* from public, anon, authenticated/i);
  assert.match(fn, /grant execute .* to service_role/i);
});

test("ordinary invite redemption is throttled and never grants coach", () => {
  const fn = sql.slice(sql.indexOf("create or replace function public.redeem_invite_code"), sql.indexOf("create or replace function public.create_member_invite"));
  assert.match(fn, /interval '15 minutes'/i);
  assert.match(fn, /if v_attempts > 5/i);
  assert.match(fn, /return 'rate_limited'/i);
  assert.match(fn, /and role = 'member'/i);
  assert.match(fn, /values \(auth\.uid\(\), v_invite_id, 'member'\)/i);
  const redemptionInsert = fn.slice(fn.indexOf("insert into public.invite_redemptions"));
  assert.doesNotMatch(redemptionInsert, /on conflict/i);
  assert.doesNotMatch(redemptionInsert, /set role/i);
});

test("coach promotion is a separate service-role operation", () => {
  const fn = sql.slice(sql.indexOf("create or replace function public.grant_coach_role"), sql.indexOf("-- Replace the arbitrary-user"));
  assert.match(fn, /set role = 'coach'/i);
  assert.match(fn, /revoke all .* from public, anon, authenticated/i);
  assert.match(fn, /grant execute .* to service_role/i);
});

test("authenticated callers only receive the caller-scoped is_staff function", () => {
  assert.match(sql, /create or replace function public\.is_staff\(\) returns boolean/i);
  assert.match(sql, /where id = auth\.uid\(\) and is_admin/i);
  assert.match(sql, /drop function public\.is_staff\(uuid\)/i);
  // Exactly once: CREATE OR REPLACE can't remove an existing default
  // parameter value (42P13), so 202608270005's is_staff(uuid default
  // auth.uid()) has to be dropped outright, not replaced — and only
  // once, not dropped again later after already being removed.
  const dropCount = (sql.match(/drop function public\.is_staff\(uuid\)/gi) || []).length;
  assert.equal(dropCount, 1, "is_staff(uuid) must be dropped exactly once, not replaced-then-dropped");
});

// Regression: this exact ordering broke a live run — "cannot drop
// function is_staff(uuid) because other objects depend on it" (2BP01),
// naming these three policies. Unlike a PL/pgSQL function body, a
// policy's USING/WITH CHECK clause is dependency-tracked against
// whichever function overload it resolved to at CREATE POLICY time —
// these three were created (in 202608270005) while is_staff(uuid) was
// the only overload, so they must be dropped before it, and only
// recreated after the new is_staff() exists.
test("the three is_staff-dependent policies are dropped before is_staff(uuid), and recreated only after the new is_staff() exists", () => {
  const dropIsStaffAt = sql.indexOf("drop function public.is_staff(uuid)");
  const newIsStaffAt = sql.indexOf("create or replace function public.is_staff() returns boolean");
  assert.ok(dropIsStaffAt > -1 && newIsStaffAt > -1, "both statements must exist");
  for (const policy of ["announcements_insert_admin", "announcements_update_admin", "weekly_challenges_insert_admin"]) {
    const dropAt = sql.indexOf(`drop policy ${policy}`);
    const createAt = sql.lastIndexOf(`create policy ${policy}`);
    assert.ok(dropAt > -1 && createAt > -1, `${policy} must have both a drop and a create statement`);
    assert.ok(dropAt < dropIsStaffAt, `${policy} must be dropped before is_staff(uuid) is dropped`);
    assert.ok(createAt > newIsStaffAt, `${policy} must be recreated only after the new is_staff() exists`);
  }
});

test("post photo paths are bound to the author and visible posts", () => {
  assert.match(sql, /split_part\(new\.photo_path, '\/', 1\) <> new\.author_id::text/i);
  assert.match(sql, /create trigger workout_posts_photo_owner/i);
  assert.match(sql, /split_part\(storage\.objects\.name, '\/', 1\) = p\.author_id::text/i);
  assert.match(sql, /public\.post_visible_to_viewer\(p\.id\)/i);
});

test("photo uploads require an active redeemed profile and enforce an object quota", () => {
  const fn = sql.slice(sql.indexOf("create or replace function public.can_upload_post_photo"), sql.indexOf("drop policy post_photos_insert_own"));
  assert.match(fn, /join public\.invite_redemptions/i);
  assert.match(fn, /p\.deleted_at is null/i);
  assert.match(fn, /count\(\*\).*storage\.objects/is);
  assert.match(fn, /\) < 20/i);
});

test("report review is admin-only and records an audit trail", () => {
  const fn = sql.slice(sql.indexOf("create or replace function public.review_report"));
  assert.match(fn, /where id = auth\.uid\(\) and is_admin and deleted_at is null/i);
  assert.match(fn, /reviewed_by = auth\.uid\(\)/i);
  assert.match(fn, /reviewed_at = now\(\)/i);
  assert.match(fn, /grant execute .* to authenticated/i);
});

test("the invite UI handles invalid and rate-limited results", () => {
  assert.match(cloudJs, /data === "rate_limited"/);
  assert.match(cloudJs, /data !== "member"/);
});

test("CSP allows only the configured Supabase project and permits signed post images", () => {
  assert.doesNotMatch(indexHtml, /https:\/\/\*\.supabase\.co/);
  assert.match(indexHtml, /img-src[^;]*https:\/\/jajmlyrjlkhclgphbfbb\.supabase\.co/);
  assert.match(indexHtml, /connect-src[^;]*https:\/\/jajmlyrjlkhclgphbfbb\.supabase\.co[^;]*wss:\/\/jajmlyrjlkhclgphbfbb\.supabase\.co/);
});
