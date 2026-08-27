import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const sql = fs.readFileSync(new URL("../supabase/migrations/202608270007_grant_coach_by_handle.sql", import.meta.url), "utf8");

test("grant_coach_role_by_handle looks up by profile handle and applies the exact same promotion as grant_coach_role(uuid), service-role only", () => {
  assert.match(sql, /select id into v_user_id from public\.profiles where handle = p_handle/i);
  assert.match(sql, /update public\.invite_redemptions set role = 'coach', redeemed_at = now\(\) where user_id = v_user_id/i);
  assert.match(sql, /revoke all on function public\.grant_coach_role_by_handle\(text\) from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.grant_coach_role_by_handle\(text\) to service_role/i);
});
