import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const sql = fs.readFileSync(new URL("../supabase/migrations/202608270004_community_engagement.sql", import.meta.url), "utf8");

test("protect_is_admin only clobbers is_admin for real 'authenticated' API requests, not a direct SQL editor session", () => {
  const fn = sql.slice(sql.indexOf("create or replace function public.protect_is_admin"), sql.indexOf("-- 2. Photo attachment"));
  assert.match(fn, /if auth\.role\(\) = 'authenticated' then/i);
  assert.match(fn, /new\.is_admin = old\.is_admin;/i);
});

test("post_comments is RLS-enabled and gated on the same post_visible_to_viewer rule reactions use", () => {
  assert.match(sql, /alter table public\.post_comments enable row level security/i);
  assert.match(sql, /create policy post_comments_visible on public\.post_comments for select to authenticated using \(public\.post_visible_to_viewer\(post_id\)\)/i);
  assert.match(sql, /create policy post_comments_insert_self on public\.post_comments for insert to authenticated with check \(author_id = auth\.uid\(\) and public\.post_visible_to_viewer\(post_id\)\)/i);
  assert.match(sql, /create policy post_comments_delete_self on public\.post_comments for delete to authenticated using \(author_id = auth\.uid\(\)\)/i);
});

test("community_feed now surfaces comment_count and photo_path", () => {
  const view = sql.slice(sql.indexOf("create or replace view public.community_feed"));
  assert.match(view, /count\(distinct c\.id\)::integer as comment_count/i);
  assert.match(view, /p\.photo_path/i);
  assert.match(view, /left join public\.post_comments c on c\.post_id = p\.id/i);
});

test("coach_new_members mirrors coach_inactive_members: admin-gated, looks at the earliest ping not the latest", () => {
  const fn = sql.slice(sql.indexOf("create or replace function public.coach_new_members"));
  assert.match(fn, /if not exists \(select 1 from public\.profiles where id = auth\.uid\(\) and is_admin and deleted_at is null\) then\s*raise exception/i);
  assert.match(fn, /min\(ap\.activity_date\)/i);
  assert.match(fn, /revoke all on function public\.coach_new_members\(integer\) from public, anon/i);
  assert.match(fn, /grant execute on function public\.coach_new_members\(integer\) to authenticated/i);
});

test("post-photos bucket is private with a size/type limit, and Storage RLS scopes uploads to the uploader's own folder", () => {
  assert.match(sql, /insert into storage\.buckets \(id, name, public, file_size_limit, allowed_mime_types\)/i);
  assert.match(sql, /'post-photos', 'post-photos', false, 5242880/i);
  assert.match(sql, /storage\.foldername\(name\)\)\[1\] = auth\.uid\(\)::text/);
  assert.match(sql, /create policy post_photos_select_if_post_visible on storage\.objects for select to authenticated/i);
  assert.match(sql, /public\.post_visible_to_viewer\(p\.id\)/);
});

test("announcements gained a nullable pinned_date column for the daily WOD note", () => {
  assert.match(sql, /alter table public\.announcements add column pinned_date date/i);
});

// Regression: this exact ordering broke a live run — "column p.photo_path
// does not exist" — because community_feed was originally recreated
// before the column it selects was added. Migrations run top to bottom;
// a column has to exist before any statement can reference it.
test("workout_posts.photo_path is added before community_feed is recreated to select it", () => {
  const addColumnAt = sql.indexOf("alter table public.workout_posts add column photo_path text");
  const viewAt = sql.indexOf("create or replace view public.community_feed");
  assert.ok(addColumnAt > -1 && viewAt > -1, "both statements must exist");
  assert.ok(addColumnAt < viewAt, "photo_path must be added before the view that selects p.photo_path");
});
