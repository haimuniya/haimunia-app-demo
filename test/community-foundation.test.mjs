import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootApp } from "./helpers/boot.mjs";

test("community share candidates omit private notes, measurements, partner tags, and bodyweight", async () => {
  const window = await bootApp();
  await window.addMovement("Community Test Squat", "Squat");
  window.applyFieldValue("step", "weight", 100);
  window.applyFieldValue("step", "reps", 5);
  await window.saveSet();
  const candidates = window.communityShareCandidates();
  assert.ok(candidates.length > 0);
  const serialized = JSON.stringify(candidates);
  for (const forbidden of ["notes", "partnerTag", "bodyweight", "measurements", "email"]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} must not enter a social snapshot`);
  }
});

test("community migration enables RLS on every exposed base table and keeps private records owner-scoped", () => {
  const sql = fs.readFileSync(new URL("../supabase/migrations/202608260001_community_foundation.sql", import.meta.url), "utf8");
  for (const table of ["profiles", "private_records", "follows", "blocks", "workout_posts", "reactions", "reports", "account_deletion_requests"]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
  }
  assert.match(sql, /private_records_self_select[\s\S]*user_id = auth\.uid\(\)/i);
  assert.match(sql, /revoke all on function public\.purge_due_accounts\(\) from public, anon, authenticated/i);
});
