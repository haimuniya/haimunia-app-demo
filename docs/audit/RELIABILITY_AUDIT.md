# Reliability audit

Commit `d2e6408`, branch `main`. All line numbers are against that commit and were
re-verified after the mid-audit merge described in `COMMANDS_AND_TEST_RESULTS.md`.

---

## 1. The offline outbox — the documented claim is true, and narrower than it sounds

### The claim

`COMMUNITY_SETUP.md:260`:

> *"Local writes are authoritative while offline and enter IndexedDB's `syncOutbox`.
> Once authenticated and online, the outbox upserts them into owner-only
> `private_records`."*

**Verified — this exists and works as described.** Note the claim is in
`COMMUNITY_SETUP.md`, not `README.md`; `README.md` says only "offline-first PWA" and
"fully usable offline", and makes no outbox retry claim of its own.

### The implementation

| Piece | Location |
|---|---|
| IndexedDB store | `src/db.js:7` — `OUTBOXSTORE = "syncOutbox"` in DB `haimunia-demo-db` |
| Store accessors | `src/db.js:323` `dbPutSyncOutboxRow`, `:332` `dbLoadSyncOutbox`, `:340` `dbDeleteSyncOutbox` |
| Enqueue | `app.js:1141` **`queueSyncRecord(recordType, record, deleted)`** |
| Bulk enqueue (opt-in history migration) | `app.js:1150` `queueAllLocalRecordsForSync()` |
| **Flush / retry** | `cloud.js:3964` **`flushOutbox()`** |
| Conflict resolution on pull | `app.js:1164` `shouldApplyRemote()` |
| Pull with cursor | `cloud.js:3985` `pullPrivateRecords()` |

`queueSyncRecord` is invoked from **13 call sites in `src/db.js`** — every local mutation
(`movement`, `wod_entry`, `custom_wod`, `bodyweight`, `measure_type`, `measurement`,
`strength_entry`, plus soft-deletes) enqueues on `tx.oncomplete`, i.e. only after the
IndexedDB transaction actually committed.

The retry loop itself:

```js
// cloud.js:3964
async function flushOutbox() {
  if (!client || !state.user || !state.syncEnabled || typeof window.dbLoadSyncOutbox !== "function") return;
  const rows = await window.dbLoadSyncOutbox();
  for (const row of rows) {
    const payload = { user_id: state.user.id, record_type: row.recordType, record_id: row.recordId,
                      payload: row.payload || {}, deleted_at: ..., updated_at: ... };
    const { error } = await client.from("private_records")
      .upsert(payload, { onConflict: "user_id,record_type,record_id" });
    if (!error) {
      await window.dbDeleteSyncOutbox(row.id);
      // After the write succeeded, never before: a failed sync is not a
      // session, and the row stays in the outbox to be retried.
      noteAttendanceRecorded(row);
    }
  }
}
```

**"Retries after connectivity returns" is literally wired:**

```js
window.addEventListener("online", flushOutbox);                 // cloud.js:12204
window.addEventListener("haimunia-sync-needed", () => { ... flushOutbox(); ... }); // 12205
```

plus on `onAuthStateChange` (`cloud.js:12224`) and at boot (`cloud.js:927`, `3929`).

### What is genuinely well built here

- **Idempotent by construction.** The upsert keys on `(user_id, record_type, record_id)`
  with a **client-derived** `record_id` (`app.js:1144`: `id: \`${recordType}:${record.id}\``).
  Replaying the same outbox row any number of times converges to one server row. This is
  a correct idempotency key.
- **Delete-after-success only.** A failed write leaves the row queued.
- **No head-of-line blocking.** The `for...of` continues past a failing row rather than
  aborting, so one permanently-rejected record cannot stall the rest of the queue.
- **Real conflict detection, not blind last-write-wins.** `shouldApplyRemote()`
  (`app.js:1164`) compares timestamps for the four record types that carry `ts`; an older
  remote write does not clobber a newer local one, and the local copy's outbox row still
  pushes out.
- **A subtle race already fixed.** `syncApplyingRemote` is a `Set` keyed per record
  (`app.js:1141`), replacing what the comment says was a global boolean that "silently
  dropped" concurrent local edits during a remote pull — "a real, silent backup gap".
- **Side effects gated on success.** `noteAttendanceRecorded()` fires only after the
  upsert succeeds.

### Finding R1 — the outbox covers the training log only; **no community write is queued or retried**

This is the important scoping limit and it is not stated in the docs.

`flushOutbox()` writes to exactly one table: **`private_records`**. Every Community
write — posts, comments, reactions, RSVPs, challenge progress, follows, blocks, reports,
moderation decisions, admin role changes — is a direct `await client.rpc(...)` or
`await client.from(...)` with **no queue, no automatic retry, and no backoff**.

Searches for automatic retry machinery across `cloud.js`, `app.js` and `src/`:

- `backoff` → **0 hits**
- `retryCount` / `attempts` → **0 hits** (the only `attempt` match is a server-side
  rate-limit comment at `cloud.js:1067`)
- `setTimeout(... flushOutbox ...)` → **0 hits**
- `navigator.onLine` → **0 hits**

What exists instead is 28 **manual, user-tapped** retry affordances — buttons labelled
`ניסיון חוזר` ("try again") wired to `*-retry` actions (leaderboard, directory, roster,
mod-queue, audit, challenges, events, coach tools, analytics, retention, comments…).

That is a legitimate design for a small club — an explicit retry is honest and avoids
silent duplicate writes. But it means:

- A post composed on a flaky connection is **lost** unless the member notices the error
  banner (`"פרסום הפוסט נכשל, אפשר לנסות שוב"`, `cloud.js:9190`) and taps again.
- Going offline mid-session degrades Community to read-only-with-errors, while the
  training log continues to work perfectly. The asymmetry is real and undocumented.
- The one exception is worth noting: `cloud.js:7152` deliberately avoids permanently
  burning a member's weekly consistency credit when a write fails.

---

## 2. Idempotency of write RPCs

The question: after a **client-perceived timeout** where the server actually committed,
does resubmitting create a duplicate?

### Idempotent — safe to replay

| Path | Mechanism | Location |
|---|---|---|
| Outbox → `private_records` | `upsert onConflict (user_id, record_type, record_id)`, **client-derived key** | `cloud.js:3969` |
| `event_rsvp` | `insert … on conflict (event_id, user_id) do update set response = excluded.response` | `202608280010_events.sql:126–128` |
| `workout_posts` share | `upsert onConflict "author_id,source_type,source_record_id"` | `cloud.js:3072`, `4211` |
| `activity_pings` | `upsert onConflict "user_id,activity_date", ignoreDuplicates: true` | `cloud.js:1143` |
| `challenge_teams`, `challenges` (create) | **client-generated** `newFeedId()` = `crypto.randomUUID()` used as the row `id` | `cloud.js:6727, 7084, 7091, 8177` |
| `notif_mark_read` | Naturally idempotent (sets `read_at`), chunked 100 ids/call | `cloud.js:10338, 10354` |

Note `newFeedId()` (`cloud.js:3137`) already exists and is already used as a
client-generated primary key for challenges, teams and events. The pattern is in the
codebase — it simply was not extended to the engagement writes below.

### Finding R2 (HIGH) — `post_create`, `add_post_comment` and `challenge_progress` have no dedup key

**`post_create`** — `cloud.js:9182`:

```js
const { data, error } = await client.rpc("post_create", { body, visibility: c.visibility, media, links });
if (error || !data) {
  c.publishing = false;
  c.error = "פרסום הפוסט נכשל, אפשר לנסות שוב";   // ← invites the retry
  return rerender();
}
```

Server side (`supabase/migrations/202608280023_post_create.sql:41`):
`post_create(body, visibility, media, links) returns uuid` — **four parameters, none an
idempotency key.** The row id is `gen_random_uuid()`. The only guard is
`check_rate_limit('post_create', 20, 10)` (20 per 10 min), which caps abuse but does
nothing about a duplicate.

`c.publishing` prevents *double-taps within one page session*. It does **not** cover the
timeout case: a request that commits server-side but never returns a response leaves
`error` truthy, resets `publishing = false`, and shows a message explicitly telling the
member to try again. **Tapping it produces a second post.** Six `post_create` call sites
share this shape (`cloud.js:1736, 1966, 6972, 8280, 8856, 9182`), including
coach reach-out and celebrate flows.

**`add_post_comment`** — same shape. Insert into `public.post_comments` with a generated
id (`202608280016_comment_threads.sql:147`), no unique constraint on
`(post_id, author_id, body)`, no client key. Retry → duplicate comment. Three call sites.

**`challenge_progress`** — `cloud.js:6824`, the worst of the three:

```js
const { error } = await client.from("challenge_progress")
  .insert({ challenge_id: v.id, user_id: state.user.id, delta, source_type: "manual", note });
```

Table definition (`202608280009_challenges.sql:56–65`): `id uuid primary key default
gen_random_uuid()`, plus a `source_id uuid` column that is **available as a natural
idempotency key and is not populated on this path**. There is no unique constraint on
`(challenge_id, user_id, source_id)` or any other tuple.

A retried progress log **silently double-counts**, inflating both the member's own
progress and the cooperative/team aggregate. Unlike a duplicate post, this is not
visually obvious — nobody sees a duplicate row, they see a wrong number on a leaderboard.
`v.logForm.busy` guards double-taps only.

**Suggested fix shape** (not applied — no source was modified): pass a client-generated
`newFeedId()` as a `p_client_id` and add `on conflict do nothing` against a unique index.
`newFeedId()` and the `source_id` column both already exist.

### Finding R3 (MEDIUM) — `toggle_reaction` is a toggle, so a retry *inverts* rather than duplicates

`cloud.js:3490`:

```js
const { error } = await client.rpc("toggle_reaction", { p_post_id: postId });
```

`public.reactions` has `primary key (post_id, user_id, kind)`
(`202608260001_community_foundation.sql:68–73`), so a duplicate row is impossible —
good. But the RPC branches on current state
(`202608280005_post_visibility_and_media.sql:115/121`): `delete … if present, else
insert`.

So a request that commits but whose response is lost leaves the client showing the
pre-toggle state; the member taps again and **un-does** the reaction that actually
landed. Not data corruption, but a real "my reaction won't stick" bug class on poor
connectivity. The client rolls back optimistic state on error and has a `reactionBusy`
guard, neither of which addresses the lost-response case. An explicit
`set_reaction(post_id, kind, desired_state)` would be idempotent; a toggle cannot be.

---

## 3. Service-worker update behaviour while the app is open

`CHANGES.md` describes a prior service-worker rewrite. **All three claims verified
against the current files at `d2e6408`:**

### (a) No `skipWaiting()` in the `install` handler — ✅

`install` handler spans `sw.js:84–103`. The only `self.skipWaiting()` in the file is at
**line 125**, inside the `message` handler. At `sw.js:100`, closing the install handler:

```js
  // No skipWaiting() here on purpose. The page shows an update banner and the
  // user decides when to swap; activating under a running page would leave the
  // old app.js talking to a new cache.
```

The install handler also splits precaching correctly: `REQUIRED_ASSETS` via a strict
`Promise.all` (a miss fails the install, old SW keeps control) and `OPTIONAL_ASSETS` via
`Promise.allSettled` (a miss degrades one feature only). `cloud.js` is OPTIONAL, so a
Community fetch failure can never take down the offline training log.

### (b) `SKIP_WAITING` postMessage flow — ✅

Receiver, `sw.js:124–125`:

```js
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});
```

Sender, `app.js:3980` inside `applyUpdate()`:

```js
function applyUpdate() {
  const worker = pendingWorker;
  pendingWorker = null; // guard against a second trigger firing before the reload lands
  if (worker) {
    swapRequested = true;
    try { worker.postMessage({ type: "SKIP_WAITING" }); return; } catch (e) { swapRequested = false; }
  }
  location.reload();   // app.js:3982 — fallback
}
```

### (c) Reload on `controllerchange` — ✅

`app.js:4447–4452`:

```js
let reloading = false;
navigator.serviceWorker.addEventListener("controllerchange", () => {
  if (!swapRequested) return; // e.g. the first-ever clients.claim() — nothing to reload for
  if (reloading) return;
  reloading = true;
  location.reload();
});
```

Two correctness guards worth calling out:

- **`swapRequested`** (`app.js:3974`, set at `3979`) distinguishes "we asked for this
  swap" from the first-ever `clients.claim()`, which fires `controllerchange` on a page
  that never had a controller. The comment records that reloading on that event "was
  wiping out whatever someone had just started typing, every single first visit."
- **`reloading`** prevents a double reload.

### Registration and update policy — sound

`app.js:4420–4443`: registers, offers `reg.waiting` if a controller already exists,
listens for `updatefound` → `statechange === "installed"`, and forces `reg.update()` on
every `visibilitychange` to `visible` — because `updatefound` alone relies on the
browser's own ~24 h throttle, which could leave a daily user on a stale build.

`offerUpdate()` (`app.js:3992`) applies immediately when the page is hidden, and shows a
banner when it is visible — deliberately not reloading mid-set and dropping unsaved
input. `update-flow.mjs` passes in the browser-check suite, asserting both the banner
path and the automatic reload on visibility regain.

**Verdict: `sw.js` and `app.js` match what `CHANGES.md` describes. No drift.**

### One residual note (low)

`activate` calls `self.clients.claim()` (`sw.js:118`) while the page it claims may be
running the *previous* `app.js`. This is safe in the normal flow (the page reloads
immediately via `controllerchange` because `swapRequested` is set), but on the
`applyUpdate()` fallback path — where `postMessage` threw and `swapRequested` was reset
to `false` — the listener returns early and the reload comes from `location.reload()` at
`app.js:3982` instead. Both paths do reload; the ordering is just less tightly coupled
in the fallback. Not a defect found in practice, and `update-flow.mjs` covers the
primary path.

---

## Summary — ranked

| # | Finding | Severity | Evidence |
|---|---|---|---|
| **R2** | `post_create`, `add_post_comment` and `challenge_progress` take no idempotency key; ids are `gen_random_uuid()` with no dedup constraint. A retry after a lost response duplicates a post/comment and **silently double-counts** challenge progress. `challenge_progress.source_id` and `newFeedId()` both already exist unused for this. | **High** | `cloud.js:9182, 6824`; `202608280023_post_create.sql:41`; `202608280009_challenges.sql:56–65` |
| **R1** | The IndexedDB outbox covers `private_records` only. **Zero** community writes are queued or auto-retried — no backoff, no `navigator.onLine`, no retry timer; only 28 manual "try again" buttons. Offline degrades Community to read-only-with-errors while the training log stays fully functional. | **Medium-High** | `cloud.js:3964`; 0 hits for `backoff`/`retryCount`/`navigator.onLine` |
| **R3** | `toggle_reaction` is state-flipping, so a retry after a lost response **inverts** the reaction instead of converging. PK prevents duplicates but not this. | Medium | `cloud.js:3490`; `202608280005_post_visibility_and_media.sql:115/121` |
| R4 | No dead-letter path or size cap on the outbox: a permanently-rejected row is retried forever with no user-visible surface. Mitigated by the loop not head-of-line-blocking. | Low | `cloud.js:3964–3977` |
| ✅ | SW update handshake fully matches `CHANGES.md` — no `skipWaiting()` in `install` (`sw.js:100`), `SKIP_WAITING` flow (`sw.js:125` ↔ `app.js:3980`), guarded `controllerchange` reload (`app.js:4447–4452`) | — | verified, `update-flow.mjs` passes |
| ✅ | Outbox idempotency, delete-after-success, no head-of-line blocking, timestamp-based conflict resolution | — | `cloud.js:3969`; `app.js:1164` |

**Not measured here:** behaviour under real network loss/flap on a device, Supabase
outage or 5xx response handling end-to-end, IndexedDB quota exhaustion, iOS Safari's
7-day eviction, clock skew between devices, or concurrent multi-device sync. None of
these were reproducible in this environment — all findings above are from executed
greps, read source, and the pgTAP/browser fixtures that do exist.
