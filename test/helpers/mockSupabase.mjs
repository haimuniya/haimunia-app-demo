// A minimal, in-memory mock of the Supabase JS client - just enough
// surface (auth, .from() query chaining, .rpc(), .storage()) to boot
// cloud.js in jsdom and actually execute it under test, the way boot.mjs
// already does for app.js. This is what closes the gap an independent
// architecture review flagged directly: every cloud.js test before this
// one only regex-matched source text, which can prove a string exists
// but can't catch a wrong argument, a broken await chain, or a real
// state-machine bug - exactly the class of bug that let the
// refreshSession()-doesn't-flush-before-pulling regression ship
// undetected (see community-sync-ordering.test.mjs for the source-text
// version of that same guard; test/community-live-*.test.mjs are the
// executing versions this file makes possible).
export function createMockSupabase(seedTables = {}) {
  const db = {};
  for (const [table, rows] of Object.entries(seedTables)) db[table] = rows;

  let currentUser = null;
  let authCb = null;
  let uidCounter = 0;
  const rpcHandlers = {};

  function rows(table) { return (db[table] = db[table] || []); }

  function chain(table) {
    let filters = [];
    let mode = "select";
    let pendingPayload = null;
    const api = {
      select() { return api; },
      eq(col, val) { filters.push((r) => r[col] === val); return api; },
      neq(col, val) { filters.push((r) => r[col] !== val); return api; },
      gt(col, val) { filters.push((r) => r[col] > val); return api; },
      or() { return api; },
      order(col, opts) { api._orderCol = col; api._orderAsc = !opts || opts.ascending !== false; return api; },
      limit() { return api; },
      insert(payload) { mode = "insert"; pendingPayload = payload; return api; },
      upsert(payload, opts) { mode = "upsert"; pendingPayload = payload; api._onConflict = opts && opts.onConflict; return api; },
      delete() { mode = "delete"; return api; },
      maybeSingle() {
        const matched = rows(table).filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: matched[0] || null, error: null });
      },
      // A real Supabase query builder is a real thenable/Promise (code
      // in the app calls .catch()/.finally() on it, e.g. pingActivity's
      // upsert(...).catch(() => {})) - delegating to an actual Promise
      // here instead of hand-rolling `then` gives every Promise method
      // for free, rather than re-discovering each one a caller needs.
      _resolve() {
        if (mode === "insert") {
          const list = Array.isArray(pendingPayload) ? pendingPayload : [pendingPayload];
          for (const p of list) rows(table).push(p);
          return { error: null, data: list };
        }
        if (mode === "upsert") {
          const list = Array.isArray(pendingPayload) ? pendingPayload : [pendingPayload];
          const keyCols = (api._onConflict || "id").split(",");
          for (const p of list) {
            const idx = rows(table).findIndex((r) => keyCols.every((k) => r[k] === p[k]));
            if (idx >= 0) rows(table)[idx] = { ...rows(table)[idx], ...p }; else rows(table).push(p);
          }
          return { error: null };
        }
        if (mode === "delete") {
          db[table] = rows(table).filter((r) => !filters.every((f) => f(r)));
          return { error: null };
        }
        let matched = rows(table).filter((r) => filters.every((f) => f(r)));
        if (api._orderCol) matched = matched.slice().sort((a, b) => (a[api._orderCol] > b[api._orderCol] ? 1 : -1) * (api._orderAsc ? 1 : -1));
        return { data: matched, error: null };
      },
      then(onFulfilled, onRejected) { return Promise.resolve(api._resolve()).then(onFulfilled, onRejected); },
      catch(onRejected) { return Promise.resolve(api._resolve()).catch(onRejected); },
      finally(onFinally) { return Promise.resolve(api._resolve()).finally(onFinally);
      },
    };
    return api;
  }

  // COMM-014. A minimal Realtime surface: channel(), removeChannel() and
  // getChannels(), plus the bits of a RealtimeChannel the harness in
  // src/realtime.js actually touches (on/subscribe/unsubscribe). Enough
  // to observe that a subscription was opened, that a handler receives a
  // payload, and - the part that matters - that teardown really removed
  // the channel rather than only forgetting about it.
  const channels = [];
  function makeChannel(name) {
    const ch = {
      topic: name,
      bindings: [],
      subscribeCalls: 0,
      statusCallback: null,
      removed: false,
      on(kind, filter, cb) { ch.bindings.push({ kind, filter, cb }); return ch; },
      subscribe(cb) {
        ch.subscribeCalls++;
        ch.statusCallback = cb || null;
        // The real client answers asynchronously; a microtask keeps the
        // ordering honest without making every test await a timer.
        if (cb) queueMicrotask(() => { if (!ch.removed) cb("SUBSCRIBED", null); });
        return ch;
      },
      unsubscribe() { ch.removed = true; return Promise.resolve("ok"); },
    };
    return ch;
  }

  const mock = {
    db,
    channels,
    // Deliver one payload to every binding on a channel whose kind
    // matches, the way the server would push a postgres_changes row.
    emitRealtime(name, payload, kind = "postgres_changes") {
      const ch = channels.find((c) => c.topic === name && !c.removed);
      if (!ch) return 0;
      let delivered = 0;
      for (const b of ch.bindings) if (b.kind === kind) { delivered++; b.cb(payload); }
      return delivered;
    },
    // Drive a status callback by hand, for the reconnect and CLOSED paths.
    pushRealtimeStatus(name, status, err = null) {
      const ch = channels.find((c) => c.topic === name);
      if (ch && ch.statusCallback) ch.statusCallback(status, err);
      return !!ch;
    },
    openChannels() { return channels.filter((c) => !c.removed).map((c) => c.topic); },
    setUser(u) { currentUser = u; },
    getUser() { return currentUser; },
    // Register how a given RPC name should behave: (args, ctx) => ({ data, error }).
    // ctx exposes { db, currentUser } so a handler can read/write mock
    // tables the same way the real Postgres function would.
    onRpc(name, handler) { rpcHandlers[name] = handler; },
    client: {
      auth: {
        getSession: () => Promise.resolve({ data: { session: currentUser ? { user: currentUser } : null } }),
        signInAnonymously: () => {
          currentUser = { id: `anon-${++uidCounter}`, is_anonymous: true };
          queueMicrotask(() => authCb && authCb("SIGNED_IN", { user: currentUser }));
          return Promise.resolve({ data: {}, error: null });
        },
        updateUser: ({ email, password }) => {
          if (!currentUser) return Promise.resolve({ data: null, error: { message: "no session" } });
          if (rows("__credentials").some((c) => c.email === email)) return Promise.resolve({ data: null, error: { message: "email already registered" } });
          currentUser = { ...currentUser, is_anonymous: false, email };
          // Real Supabase persists the new credential for later sign-ins -
          // register it here too, instead of requiring every test to call
          // seedCredentials() by hand after going through the real upgrade
          // flow (that helper is for tests that want to skip straight to
          // "already has an account", not ones exercising setCredentials()
          // itself).
          rows("__credentials").push({ userId: currentUser.id, email, password });
          return Promise.resolve({ data: { user: currentUser }, error: null });
        },
        signInWithPassword: ({ email, password }) => {
          const found = rows("__credentials").find((c) => c.email === email && c.password === password);
          if (!found) return Promise.resolve({ error: { message: "invalid" } });
          currentUser = { id: found.userId, is_anonymous: false, email };
          queueMicrotask(() => authCb && authCb("SIGNED_IN", { user: currentUser }));
          return Promise.resolve({ error: null });
        },
        signOut: () => {
          currentUser = null;
          queueMicrotask(() => authCb && authCb("SIGNED_OUT", null));
          return Promise.resolve({ error: null });
        },
        onAuthStateChange: (cb) => { authCb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
      },
      from: (table) => chain(table),
      channel: (name) => { const ch = makeChannel(name); channels.push(ch); return ch; },
      removeChannel: (ch) => { if (ch) ch.removed = true; return Promise.resolve("ok"); },
      getChannels: () => channels.filter((c) => !c.removed),
      rpc: (name, args) => {
        // A registered onRpc() handler wins over every built-in, so a test
        // can make redeem_invite_code return "rate_limited" (COMM-017) or
        // make mark_recovery_verified fail (COMM-016) without the built-in
        // shortcut masking it.
        const handler = rpcHandlers[name];
        if (handler) return Promise.resolve(handler(args, { db, currentUser }));
        if (name === "redeem_invite_code") {
          rows("invite_redemptions").push({ user_id: currentUser.id, invite_id: "inv-1", role: "member", redeemed_at: new Date().toISOString() });
          return Promise.resolve({ data: "member", error: null });
        }
        // COMM-016. The real RPC refuses unless Auth confirms a real email
        // plus password; the mock stamps whenever the current user has a
        // registered credential pair, which is the same precondition the
        // app enforces before it ever calls this.
        if (name === "mark_recovery_verified") {
          const prof = rows("profiles").find((r) => currentUser && r.id === currentUser.id);
          const hasCreds = currentUser && (currentUser.email || rows("__credentials").some((c) => c.userId === currentUser.id));
          if (!prof || !hasCreds) return Promise.resolve({ data: null, error: { message: "recovery method not verified" } });
          prof.recovery_verified_at = prof.recovery_verified_at || new Date().toISOString();
          return Promise.resolve({ data: prof.recovery_verified_at, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      storage: {
        from: () => ({
          createSignedUrl: () => Promise.resolve({ data: { signedUrl: "https://mock/signed" }, error: null }),
          upload: () => Promise.resolve({ error: null }),
        }),
      },
    },
    // Test-only helper: registers a username+password pair as if
    // setCredentials() had already run for this user, so a test can
    // exercise signInWithPassword() without going through the full
    // anonymous->credentials upgrade flow first.
    seedCredentials(userId, email, password) { rows("__credentials").push({ userId, email, password }); },
  };
  return mock;
}
