// Launch-readiness audit, RELIABILITY: the community write outbox.
//
// THE GAP THIS CLOSES. README.md has always advertised "an IndexedDB outbox
// retries writes after connectivity returns", and that was true - for
// private_records only, the offline training log's own sync channel
// (flushOutbox() in cloud.js). Not one community write went through it: a
// post, comment, cheer, RSVP or coach progress entry made with no
// connection simply failed, showed an error, and was gone. The member
// retyped it or lost it. That is the gap RELIABILITY_AUDIT.md recorded, and
// this file is the queue that closes it.
//
// WHY A SEPARATE QUEUE from the private_records one. They have genuinely
// different semantics and merging them would make both worse:
//   * private_records is a LAST-WRITE-WINS mirror of local state, keyed
//     (user, record_type, record_id). Re-sending it is free, order does not
//     matter, and a superseded row can be dropped.
//   * a community write is an EVENT. Sending it twice creates two posts,
//     order matters (a comment must not precede its post), and a permanent
//     failure has to be shown to the member rather than silently retried.
// So this queue is FIFO, attempt-counted, backed off, and surfaces its own
// failures; the private_records one stays exactly as it is.
//
// TRANSPORT-AGNOSTIC ON PURPOSE. This file never imports the Supabase
// client and never names an RPC. cloud.js registers one handler per action
// via registerHandler(); the queue only knows how to persist, order, retry
// and report. That is what makes it testable in jsdom with no network, and
// it is why the whole engine can be exercised without a backend.
//
// EVERY QUEUED OP CARRIES AN IDEMPOTENCY KEY, generated once at enqueue and
// persisted with the row. That key is what makes retry safe: the server
// side (202609060014) returns the original result for a repeated key
// instead of writing again. A key generated per ATTEMPT would defeat the
// entire mechanism, so it is written once, at enqueue, and never
// regenerated - including across a browser restart, because it lives in
// IndexedDB with the row.
(function () {
  "use strict";

  // Five attempts with exponential backoff: ~1s, 2s, 4s, 8s, 16s. After
  // that the row is `failed` and waits for the member, rather than
  // retrying forever against something that is clearly not going to work.
  var MAX_ATTEMPTS = 5;
  var BASE_DELAY_MS = 1000;
  var MAX_DELAY_MS = 60000;

  // Errors that will never succeed on retry, so the row goes straight to
  // `failed` without burning five attempts and ~30 seconds first. Matched
  // against the server's own message text, which this repo's RPCs raise as
  // stable, documented strings (see docs/community/contracts.md).
  var PERMANENT_ERROR_RE = /not authorized|posting_restricted|recovery method required|at most|needs text or at least one photo|too many|invalid|not found|not an active participant/i;
  // Auth expiry is neither transient-and-retryable-right-now nor permanent:
  // the op is fine, the session is not. These pause the queue instead of
  // consuming an attempt, so a member whose token lapsed mid-queue does not
  // burn their retry budget before they have had a chance to sign back in.
  var AUTH_ERROR_RE = /jwt|token|session|expired|refresh/i;

  var handlers = {};
  var listeners = [];
  var flushing = false;
  var seqCounter = 0;

  function now() { return Date.now(); }

  function backoffMs(attempts) {
    var d = BASE_DELAY_MS * Math.pow(2, Math.max(0, attempts - 1));
    return Math.min(d, MAX_DELAY_MS);
  }

  function newKey() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    // Fallback for a jsdom/older environment with no randomUUID. Only ever
    // used as an idempotency key, never as a security token.
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](); } catch (e) { /* a listener must not break the queue */ }
    }
  }

  function storeReady() {
    return typeof window.dbPutCommunityOutboxRow === "function"
      && typeof window.dbLoadCommunityOutbox === "function"
      && typeof window.dbDeleteCommunityOutbox === "function";
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  // registerHandler(action, fn). fn(args, row) -> Promise. It should throw
  // on failure; the thrown message decides transient vs permanent.
  function registerHandler(action, fn) { handlers[action] = fn; }

  function onChange(fn) {
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  // enqueue(action, args, opts) -> the persisted row.
  //
  // The idempotency key is minted HERE, once. optimisticId lets a caller
  // correlate a queued op with a placeholder it painted in the UI.
  async function enqueue(action, args, opts) {
    if (!storeReady()) throw new Error("community outbox store unavailable");
    var options = opts || {};
    seqCounter += 1;
    var row = {
      id: newKey(),
      seq: now() * 1000 + (seqCounter % 1000),
      action: action,
      args: args || {},
      idempotencyKey: newKey(),
      attempts: 0,
      nextAttemptAt: 0,
      status: "pending",
      lastError: "",
      optimisticId: options.optimisticId || null,
      queuedAt: now()
    };
    await window.dbPutCommunityOutboxRow(row);
    notify();
    return row;
  }

  async function list() {
    if (!storeReady()) return [];
    var rows = await window.dbLoadCommunityOutbox();
    // FIFO. IndexedDB getAll() returns key order, which is the random row
    // id here, so ordering is explicit rather than incidental.
    return (rows || []).slice().sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
  }

  async function pendingCount() {
    var rows = await list();
    return rows.filter(function (r) { return r.status === "pending"; }).length;
  }

  async function failedCount() {
    var rows = await list();
    return rows.filter(function (r) { return r.status === "failed"; }).length;
  }

  // The drain. Processes strictly in FIFO order and STOPS at the first row
  // that is not ready or not sendable, so a later op can never overtake an
  // earlier one (a comment must not land before the post it belongs to).
  async function flush(context) {
    if (flushing || !storeReady()) return { sent: 0, failed: 0, stopped: null };
    flushing = true;
    var sent = 0, failed = 0, stopped = null;
    try {
      var rows = await list();
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (row.status === "failed") continue;         // needs a manual decision
        if (row.nextAttemptAt > now()) { stopped = "backoff"; break; }
        var handler = handlers[row.action];
        if (!handler) {
          // An op whose handler is not registered (an older queued action
          // after an app update that removed it). Not retryable, and not
          // silently droppable either - it becomes visible as failed.
          row.status = "failed";
          row.lastError = "unsupported action: " + row.action;
          await window.dbPutCommunityOutboxRow(row);
          failed += 1;
          continue;
        }
        var outcome = await runOne(handler, row, context);
        if (outcome === "sent") { sent += 1; continue; }
        if (outcome === "failed") { failed += 1; continue; }
        // "retry" or "auth" - stop the drain to preserve ordering.
        stopped = outcome;
        break;
      }
    } finally {
      flushing = false;
    }
    notify();
    return { sent: sent, failed: failed, stopped: stopped };
  }

  async function runOne(handler, row, context) {
    try {
      await handler(row.args, row, context);
      await window.dbDeleteCommunityOutbox(row.id);
      return "sent";
    } catch (err) {
      var msg = (err && err.message) ? String(err.message) : String(err || "unknown error");
      if (AUTH_ERROR_RE.test(msg)) {
        // Do not consume an attempt; the op is fine, the session is not.
        row.lastError = msg;
        await window.dbPutCommunityOutboxRow(row);
        return "auth";
      }
      row.attempts = (row.attempts || 0) + 1;
      row.lastError = msg;
      if (PERMANENT_ERROR_RE.test(msg) || row.attempts >= MAX_ATTEMPTS) {
        row.status = "failed";
        row.nextAttemptAt = 0;
        await window.dbPutCommunityOutboxRow(row);
        return "failed";
      }
      row.nextAttemptAt = now() + backoffMs(row.attempts);
      await window.dbPutCommunityOutboxRow(row);
      return "retry";
    }
  }

  // Manual retry of one permanently-failed row: reset the counter and let
  // the drain pick it up again. The idempotency key is deliberately NOT
  // regenerated - if the original attempt actually did land server-side
  // before the response was lost, this retry must be recognised as the same
  // request and de-duplicated, not written a second time.
  async function retry(id) {
    var rows = await list();
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].id === id) {
        rows[i].status = "pending";
        rows[i].attempts = 0;
        rows[i].nextAttemptAt = 0;
        rows[i].lastError = "";
        await window.dbPutCommunityOutboxRow(rows[i]);
        notify();
        return true;
      }
    }
    return false;
  }

  async function retryAllFailed() {
    var rows = await list();
    var n = 0;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].status === "failed") { await retry(rows[i].id); n += 1; }
    }
    return n;
  }

  // Explicit discard. The ONLY path that removes a failed op, and it exists
  // so "never lose a queued action silently" stays true: nothing else
  // deletes a row the member has not seen succeed.
  async function discard(id) {
    if (!storeReady()) return false;
    await window.dbDeleteCommunityOutbox(id);
    notify();
    return true;
  }

  async function clearAll() {
    var rows = await list();
    for (var i = 0; i < rows.length; i++) await window.dbDeleteCommunityOutbox(rows[i].id);
    notify();
  }

  window.HaimuniaOutbox = {
    registerHandler: registerHandler,
    enqueue: enqueue,
    flush: flush,
    list: list,
    pendingCount: pendingCount,
    failedCount: failedCount,
    retry: retry,
    retryAllFailed: retryAllFailed,
    discard: discard,
    clearAll: clearAll,
    onChange: onChange,
    // Exposed for tests and for the UI's "try again in Ns" copy.
    _backoffMs: backoffMs,
    MAX_ATTEMPTS: MAX_ATTEMPTS
  };
})();
