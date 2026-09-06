// Architecture findings, deferred from the earlier audit: every login
// re-fetched and re-applied every private record (up to 20,000) from
// scratch even though almost nothing had changed, and both push and
// pull blindly overwrote by id with no timestamp comparison - two
// devices editing the same entry offline would silently clobber
// whichever one happened to sync last.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");
const appJs = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("pullPrivateRecords reads a per-user cursor and only queries records newer than it", () => {
  assert.match(cloudJs, /function syncCursorKey\(userId\) \{ return `haimunia-demo:syncCursor:\$\{userId\}`; \}/);
  assert.match(cloudJs, /if \(cursor\) query = query\.gt\("updated_at", cursor\);/);
});

test("the cursor advances to the newest row's updated_at after a successful pull", () => {
  const start = cloudJs.indexOf("async function pullPrivateRecords()");
  const end = cloudJs.indexOf("\n  }", start);
  const body = cloudJs.slice(start, end);
  assert.match(body, /const newest = \(data \|\| \[\]\)\.length \? data\[data\.length - 1\]\.updated_at : null;/);
  assert.match(body, /window\.dbSetSetting\(cursorKey, newest\)/);
});

test("shouldApplyRemote compares timestamps for the four record types that actually carry one, and always applies the rest", () => {
  const start = appJs.indexOf("function shouldApplyRemote(recordType, recordId, incomingTs)");
  const end = appJs.indexOf("\n}", start);
  const body = appJs.slice(start, end);
  assert.match(body, /if \(typeof incomingTs !== "number"\) return true;/);
  for (const type of ["strength_entry", "wod_entry", "bodyweight", "measurement"]) {
    assert.match(body, new RegExp(`recordType === "${type}"`));
  }
  assert.match(body, /return !existing \|\| incomingTs >= existing\.ts;/);
  assert.match(appJs, /if \(!deleted && clean && !shouldApplyRemote\(row\.record_type, row\.record_id, clean\.ts\)\) return;/);
});

test("a real second pull only fetches records newer than the cursor left by the first one", async () => {
  const now = Date.now();
  const mock = createMockSupabase({
    profiles: [{ id: "u1", handle: "dana", display_name: "דנה", is_admin: false, recovery_verified_at: new Date().toISOString() }],
    invite_redemptions: [{ user_id: "u1", invite_id: "inv-1", role: "member", redeemed_at: new Date().toISOString() }],
    private_records: [
      { user_id: "u1", record_type: "strength_entry", record_id: "e1", payload: { id: "e1", exerciseId: "back-squat", weight: 100, reps: 5, sets: 1, date: "2026-01-01", type: "reps", ts: now - 10000 }, deleted_at: null, updated_at: new Date(now - 10000).toISOString() },
    ],
  });
  mock.setUser({ id: "u1", is_anonymous: false, email: "dana@members.haimuniya.invalid" });

  const window = await bootCommunity(mock, { syncEnabled: true });
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.querySelector(".subtabbar"), 3000);

  // A second record lands on the server after the first pull already
  // ran (and set its cursor).
  mock.db.private_records.push({ user_id: "u1", record_type: "strength_entry", record_id: "e2", payload: { id: "e2", exerciseId: "back-squat", weight: 105, reps: 5, sets: 1, date: "2026-01-02", type: "reps", ts: now }, deleted_at: null, updated_at: new Date(now).toISOString() });

  let selectedRows = null;
  const realFrom = mock.client.from.bind(mock.client);
  mock.client.from = (table) => {
    const chain = realFrom(table);
    if (table === "private_records") {
      const realThen = chain.then.bind(chain);
      chain.then = (resolve) => realThen((result) => { selectedRows = result.data; return resolve(result); });
    }
    return chain;
  };

  mock.seedCredentials("u1", "dana@members.haimuniya.invalid", "CorrectHorse9");
  await mock.client.auth.signInWithPassword({ email: "dana@members.haimuniya.invalid", password: "CorrectHorse9" });
  await waitFor(() => selectedRows !== null, 3000);

  assert.equal(selectedRows.length, 1, "the second pull must only fetch the one record newer than the cursor, not both");
  assert.equal(selectedRows[0].record_id, "e2");
});
