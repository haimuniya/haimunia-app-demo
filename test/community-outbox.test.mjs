// Launch-readiness audit, RELIABILITY: the community write outbox.
//
// The full offline-to-online lifecycle, driven against the real
// src/outbox.js engine with a fake IndexedDB store, so every assertion is
// about the shipped queue rather than a model of it.
//
// What is covered here, in the order the audit asked for it: persistent
// storage, queue ordering, retry, exponential backoff, authentication
// expiry, duplicate prevention (the idempotency key), conflict/permanent
// failure handling, failed-operation visibility, safe manual retry, queue
// cleanup, and browser-restart survival.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outboxSrc = fs.readFileSync(path.join(root, "src", "outbox.js"), "utf8");

// A minimal window with the three store calls src/outbox.js needs, backed
// by a plain Map so a "browser restart" is just building a new engine over
// the same Map.
function makeEnv(seed) {
  const store = seed || new Map();
  const win = {
    crypto: { randomUUID: () => "k" + Math.random().toString(16).slice(2) + Date.now().toString(16) },
    async dbPutCommunityOutboxRow(row) { store.set(row.id, JSON.parse(JSON.stringify(row))); },
    async dbLoadCommunityOutbox() { return [...store.values()].map((r) => JSON.parse(JSON.stringify(r))); },
    async dbDeleteCommunityOutbox(id) { store.delete(id); },
  };
  // src/outbox.js is a classic script that publishes to `window`; eval it
  // with `window` bound to our fake, the same way boot.mjs loads it.
  const factory = new Function("window", "crypto", outboxSrc + "\nreturn window.HaimuniaOutbox;");
  const api = factory(win, win.crypto);
  return { api, store, win };
}

test("a queued write is persisted, so it survives a browser restart", async () => {
  const { api, store } = makeEnv();
  await api.enqueue("post_create", { body: "hello" });
  assert.equal(store.size, 1, "the op is in IndexedDB, not just in memory");

  // "Restart": a brand-new engine over the same store.
  const restarted = makeEnv(store);
  const rows = await restarted.api.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, "post_create");
  assert.equal(rows[0].args.body, "hello");
});

test("each queued op carries an idempotency key, minted once and never regenerated", async () => {
  const { api } = makeEnv();
  const row = await api.enqueue("post_create", { body: "x" });
  assert.ok(row.idempotencyKey, "a key is generated at enqueue");

  // A manual retry must NOT mint a new key: if the original attempt landed
  // server-side before the response was lost, the retry has to be
  // recognised as the same request and de-duplicated.
  await api.retry(row.id);
  const after = (await api.list())[0];
  assert.equal(after.idempotencyKey, row.idempotencyKey,
    "the key is stable across a retry - regenerating it would defeat server-side de-duplication");
});

test("a successful flush sends the op once and removes it from the queue", async () => {
  const { api, store } = makeEnv();
  let calls = 0;
  api.registerHandler("post_create", async () => { calls += 1; });
  await api.enqueue("post_create", { body: "x" });

  const result = await api.flush();
  assert.equal(result.sent, 1);
  assert.equal(calls, 1, "the handler ran exactly once");
  assert.equal(store.size, 0, "and the row is gone once it succeeded");
});

test("ordering is FIFO, and the drain stops at the first transient failure so a later op cannot overtake an earlier one", async () => {
  const { api } = makeEnv();
  const seen = [];
  api.registerHandler("post_create", async (args) => {
    seen.push(args.n);
    if (args.n === 2) throw new Error("Failed to fetch");
  });
  await api.enqueue("post_create", { n: 1 });
  await api.enqueue("post_create", { n: 2 });
  await api.enqueue("post_create", { n: 3 });

  await api.flush();
  assert.deepEqual(seen, [1, 2], "op 3 was never attempted - the queue stopped at the failure");
  const rows = await api.list();
  assert.equal(rows.length, 2, "ops 2 and 3 are both still queued");
  assert.equal(rows[0].args.n, 2, "and 2 is still ahead of 3");
});

test("a transient failure backs off exponentially instead of hammering", async () => {
  const { api } = makeEnv();
  api.registerHandler("post_create", async () => { throw new Error("Failed to fetch"); });
  await api.enqueue("post_create", { body: "x" });

  const before = Date.now();
  await api.flush();
  const row = (await api.list())[0];
  assert.equal(row.attempts, 1);
  assert.equal(row.status, "pending", "one network blip does not fail the op");
  assert.ok(row.nextAttemptAt > before, "and it is scheduled for a later attempt");

  // The delay grows with the attempt count.
  assert.ok(api._backoffMs(1) < api._backoffMs(2));
  assert.ok(api._backoffMs(2) < api._backoffMs(3));
  assert.ok(api._backoffMs(99) <= 60000, "and is capped rather than growing without bound");
});

test("a flush during backoff does not re-send early", async () => {
  const { api } = makeEnv();
  let calls = 0;
  api.registerHandler("post_create", async () => { calls += 1; throw new Error("Failed to fetch"); });
  await api.enqueue("post_create", { body: "x" });

  await api.flush();
  assert.equal(calls, 1);
  const second = await api.flush();
  assert.equal(calls, 1, "the immediate second flush respected the backoff window");
  assert.equal(second.stopped, "backoff");
});

test("an op gives up after MAX_ATTEMPTS and becomes visibly failed rather than retrying forever", async () => {
  const { api, store } = makeEnv();
  api.registerHandler("post_create", async () => { throw new Error("Failed to fetch"); });
  const row = await api.enqueue("post_create", { body: "x" });

  for (let i = 0; i < api.MAX_ATTEMPTS; i++) {
    // Clear the backoff directly in the store so the test does not have to
    // sleep through it. Deliberately NOT via api.retry(), which also resets
    // the attempt counter and would make this loop never terminate.
    const stored = store.get(row.id);
    if (!stored) break;
    stored.nextAttemptAt = 0;
    store.set(row.id, stored);
    await api.flush();
  }
  const final = (await api.list())[0];
  assert.equal(final.status, "failed");
  assert.equal(final.attempts, api.MAX_ATTEMPTS);
  assert.equal(await api.failedCount(), 1, "and it is surfaced as failed, not silently dropped");
  assert.ok(final.lastError, "with the reason kept for the UI to show");
  assert.equal(final.id, row.id);
});

test("a permanent server error fails immediately instead of burning five attempts", async () => {
  const { api } = makeEnv();
  let calls = 0;
  api.registerHandler("post_create", async () => { calls += 1; throw new Error("not authorized"); });
  await api.enqueue("post_create", { body: "x" });

  await api.flush();
  const row = (await api.list())[0];
  assert.equal(row.status, "failed", "a permanent error is recognised as permanent");
  assert.equal(row.attempts, 1, "and does not retry - retrying 'not authorized' can never succeed");
  assert.equal(calls, 1);
});

test("an expired session pauses the queue without consuming the retry budget", async () => {
  const { api } = makeEnv();
  api.registerHandler("post_create", async () => { throw new Error("JWT expired"); });
  await api.enqueue("post_create", { body: "x" });

  const result = await api.flush();
  assert.equal(result.stopped, "auth", "the drain stops so the rest of the queue is not burned too");
  const row = (await api.list())[0];
  assert.equal(row.attempts, 0, "an auth lapse is not the op's fault - no attempt is consumed");
  assert.equal(row.status, "pending", "and the op stays queued for after the member signs back in");
});

test("an op whose handler no longer exists fails visibly instead of vanishing", async () => {
  const { api } = makeEnv();
  await api.enqueue("some_removed_action", { body: "x" });
  await api.flush();
  const row = (await api.list())[0];
  assert.equal(row.status, "failed");
  assert.match(row.lastError, /unsupported action/);
});

test("a failed op can be manually retried and then succeeds", async () => {
  const { api, store } = makeEnv();
  let shouldFail = true;
  api.registerHandler("post_create", async () => { if (shouldFail) throw new Error("not authorized"); });
  const row = await api.enqueue("post_create", { body: "x" });
  await api.flush();
  assert.equal((await api.list())[0].status, "failed");

  shouldFail = false;
  await api.retry(row.id);
  const retried = (await api.list())[0];
  assert.equal(retried.status, "pending");
  assert.equal(retried.attempts, 0, "the attempt counter is reset for a manual retry");

  await api.flush();
  assert.equal(store.size, 0, "and the op finally went out");
});

test("discard is the only thing that removes a failed op, so nothing is lost silently", async () => {
  const { api, store } = makeEnv();
  api.registerHandler("post_create", async () => { throw new Error("not authorized"); });
  const row = await api.enqueue("post_create", { body: "x" });
  await api.flush();

  // Repeated flushes never quietly clean it up.
  await api.flush();
  await api.flush();
  assert.equal(store.size, 1, "a failed op survives every subsequent flush");

  await api.discard(row.id);
  assert.equal(store.size, 0, "only an explicit discard removes it");
});

test("failed ops are skipped by the drain but do not block the ops behind them", async () => {
  const { api } = makeEnv();
  const sent = [];
  api.registerHandler("post_create", async (args) => {
    if (args.n === 1) throw new Error("not authorized");
    sent.push(args.n);
  });
  await api.enqueue("post_create", { n: 1 });
  await api.enqueue("post_create", { n: 2 });

  await api.flush();          // op 1 fails permanently
  await api.flush();          // op 2 should now go
  assert.deepEqual(sent, [2], "a permanently-failed op is parked, not a permanent blockage");
  assert.equal(await api.failedCount(), 1);
  assert.equal(await api.pendingCount(), 0);
});

test("onChange fires so the UI can keep its pending/failed counts live", async () => {
  const { api } = makeEnv();
  let fired = 0;
  api.onChange(() => { fired += 1; });
  await api.enqueue("post_create", { body: "x" });
  assert.ok(fired >= 1, "enqueue notifies");
  const before = fired;
  api.registerHandler("post_create", async () => {});
  await api.flush();
  assert.ok(fired > before, "and so does a flush that changed something");
});
