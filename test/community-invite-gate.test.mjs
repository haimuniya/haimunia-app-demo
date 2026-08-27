import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootApp } from "./helpers/boot.mjs";

const sql = fs.readFileSync(new URL("../supabase/migrations/202608270003_invite_gate.sql", import.meta.url), "utf8");

test("invite_codes and invite_redemptions are RLS-enabled, and invite_codes is never granted to authenticated directly", () => {
  assert.match(sql, /alter table public\.invite_codes enable row level security/i);
  assert.match(sql, /alter table public\.invite_redemptions enable row level security/i);
  assert.doesNotMatch(sql, /grant\s+[a-z, ]*\bon public\.invite_codes\b/i, "invite_codes must only ever be reached through redeem_invite_code(), never a direct grant");
});

test("redeem_invite_code is security definer, locked away from anon, and only inserts a redemption for a real active code", () => {
  assert.match(sql, /create or replace function public\.redeem_invite_code\(p_code text\) returns text/i);
  assert.match(sql, /security definer/i);
  assert.match(sql, /where code = p_code and active/i);
  assert.match(sql, /revoke all on function public\.redeem_invite_code\(text\) from public, anon/i);
  assert.match(sql, /grant execute on function public\.redeem_invite_code\(text\) to authenticated/i);
});

test("profile creation requires a redeemed invite code, and is_admin stays impossible to self-set even with a coach-role redemption", () => {
  const policy = sql.slice(sql.indexOf("create policy profiles_insert_self"), sql.indexOf("-- Bug found"));
  assert.match(policy, /is_admin = false/i);
  assert.match(policy, /exists \(select 1 from public\.invite_redemptions ir where ir\.user_id = auth\.uid\(\)\)/i);
  assert.doesNotMatch(policy, /role = 'coach'/i, "a coach-code redemption must not be treated as equivalent to is_admin until real coach-scoped permissions exist");
});

test("a trigger pins is_admin to its stored value on every update, so no client-side path can change it after creation", () => {
  assert.match(sql, /new\.is_admin = old\.is_admin/i);
  assert.match(sql, /create trigger profiles_protect_is_admin before update on public\.profiles for each row execute function public\.protect_is_admin\(\)/i);
});

test("cloud.js gates the profile form behind a redeemed invite code and wires the redeem form", async () => {
  const window = await bootApp();
  // cloud.js isn't loaded in the jsdom boot (no window.HAIMUNIA_CONFIG /
  // network), so this only asserts the source shape, matching the pattern
  // the other cloud.js-facing tests in this repo already use.
  const fs2 = await import("node:fs");
  const src = fs2.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
  assert.match(src, /state\.redemption/);
  assert.match(src, /async function loadRedemption\(\)/);
  assert.match(src, /async function redeemCode\(form\)/);
  assert.match(src, /if \(!state\.redemption\) return/);
  assert.match(src, /event\.target\.id === "communityInviteCode"/);
  void window;
});
