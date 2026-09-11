// Security hunt, round 5 (2026-09-11), PWA/service-worker agent.
//
// THE FINDING. src/outbox.js's queue carried no notion of who enqueued a
// row. Confirmed live: a write typed while signed in as one member (a
// comment, a coach's chal_record_progress entry) and still pending when a
// DIFFERENT member signed in on the same device - a shared coach tablet is
// the real scenario - drained under the second member's session on
// reconnect, attributing the first member's words to someone who never
// sent them. Reproduced with two real members and the actual
// onAuthStateChange-driven sign-out/sign-in flow.
//
// THE FIX. enqueue() now stamps the enqueuing member's own id onto the row
// (cloud.js's communityRpc()); flush() refuses to send a row whose userId
// doesn't match the CURRENT session's userId - it stays pending, untouched,
// rather than being sent under the wrong identity or silently dropped
// (this queue's own standing "never lose a queued action" promise). A row
// from BEFORE this fix (no userId at all) still sends normally, under
// whoever is signed in - unchanged, since there is nothing to check it
// against.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outboxSrc = fs.readFileSync(path.join(root, "src", "outbox.js"), "utf8");

function makeEnv(seed) {
  const store = seed || new Map();
  const win = {
    crypto: { randomUUID: () => "k" + Math.random().toString(16).slice(2) + Date.now().toString(16) },
    async dbPutCommunityOutboxRow(row) { store.set(row.id, JSON.parse(JSON.stringify(row))); },
    async dbLoadCommunityOutbox() { return [...store.values()].map((r) => JSON.parse(JSON.stringify(r))); },
    async dbDeleteCommunityOutbox(id) { store.delete(id); },
  };
  const factory = new Function("window", "crypto", outboxSrc + "\nreturn window.HaimuniaOutbox;");
  const api = factory(win, win.crypto);
  return { api, store, win };
}

test("enqueue() stamps the enqueuing member's own id onto the row", async () => {
  const { api } = makeEnv();
  const row = await api.enqueue("add_post_comment", { p_body: "hi" }, { userId: "member-a" });
  assert.equal(row.userId, "member-a");
});

test("flush() refuses to send a row queued by a DIFFERENT member than the one currently signed in - the confirmed misattribution bypass", async () => {
  const { api } = makeEnv();
  let sentAs = [];
  api.registerHandler("add_post_comment", async (args) => { sentAs.push(args.p_body); });

  await api.enqueue("add_post_comment", { p_body: "member A's real words" }, { userId: "member-a" });

  const result = await api.flush({ userId: "member-b" });
  assert.deepStrictEqual(sentAs, [], "nothing was sent under member B's session");
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1, "the row is reported as skipped, not silently dropped");

  const remaining = await api.list();
  assert.equal(remaining.length, 1, "the row is still queued, not lost - this queue never silently drops an unsent write");
  assert.equal(remaining[0].userId, "member-a");
});

test("a foreign row does not block the CURRENT member's own rows behind it - only the foreign row is skipped", async () => {
  const { api } = makeEnv();
  const sentAs = [];
  api.registerHandler("add_post_comment", async (args) => { sentAs.push(args.p_body); });

  await api.enqueue("add_post_comment", { p_body: "member A's words" }, { userId: "member-a" });
  await api.enqueue("add_post_comment", { p_body: "member B's own first comment" }, { userId: "member-b" });
  await api.enqueue("add_post_comment", { p_body: "member B's own second comment" }, { userId: "member-b" });

  const result = await api.flush({ userId: "member-b" });
  assert.deepStrictEqual(sentAs, ["member B's own first comment", "member B's own second comment"],
    "both of member B's own rows sent, in order, despite member A's row sitting ahead of them in the queue");
  assert.equal(result.sent, 2);
  assert.equal(result.skipped, 1);

  const remaining = await api.list();
  assert.equal(remaining.length, 1, "member A's row is still there, waiting for member A");
});

test("once the row's own member signs back in, flush() sends it normally", async () => {
  const { api } = makeEnv();
  const sentAs = [];
  api.registerHandler("add_post_comment", async (args) => { sentAs.push(args.p_body); });
  await api.enqueue("add_post_comment", { p_body: "member A's real words" }, { userId: "member-a" });

  await api.flush({ userId: "member-b" });
  assert.equal((await api.list()).length, 1, "still pending after the wrong-session flush");

  await api.flush({ userId: "member-a" });
  assert.deepStrictEqual(sentAs, ["member A's real words"]);
  assert.equal((await api.list()).length, 0, "sent and removed once the rightful member is the one signed in");
});

test("a pre-fix row with no userId at all still sends normally - this fix does not orphan anything already queued", async () => {
  const { api } = makeEnv();
  const sentAs = [];
  api.registerHandler("add_post_comment", async (args) => { sentAs.push(args.p_body); });
  // Simulates a row written by an older build of this file, before userId
  // existed at all - enqueue() with no opts.userId produces exactly this
  // shape (row.userId === null).
  await api.enqueue("add_post_comment", { p_body: "queued before this fix shipped" }, {});

  const result = await api.flush({ userId: "whoever-is-signed-in-now" });
  assert.deepStrictEqual(sentAs, ["queued before this fix shipped"]);
  assert.equal(result.sent, 1);
  assert.equal(result.skipped, 0);
});
