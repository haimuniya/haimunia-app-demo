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
  // COMM-110..114. Every feed_page/club_summary/telemetry call the client
  // made, in order, so a test can assert the arguments it sent rather than
  // only the rows it rendered.
  const rpcCalls = [];

  function rows(table) { return (db[table] = db[table] || []); }
  // The real cursor carries the session anchor so every page of one session
  // scores against the same now(). The mock has no scoring, but it carries
  // the same field so a test reading a cursor sees the same shape.
  const anchor = new Date().toISOString();
  function tokenAnchor() { return anchor; }

  function chain(table) {
    let filters = [];
    let mode = "select";
    let pendingPayload = null;
    const api = {
      select() { return api; },
      eq(col, val) { filters.push((r) => r[col] === val); return api; },
      neq(col, val) { filters.push((r) => r[col] !== val); return api; },
      gt(col, val) { filters.push((r) => r[col] > val); return api; },
      in(col, vals) { const set = new Set(vals || []); filters.push((r) => set.has(r[col])); return api; },
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
    rpcCalls,
    callsTo(name) { return rpcCalls.filter((c) => c.name === name).map((c) => c.args); },
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
        rpcCalls.push({ name, args });
        // A registered onRpc() handler wins over every built-in, so a test
        // can make redeem_invite_code return "rate_limited" (COMM-017) or
        // make mark_recovery_verified fail (COMM-016) without the built-in
        // shortcut masking it.
        const handler = rpcHandlers[name];
        if (handler) return Promise.resolve(handler(args, { db, currentUser }));
        // COMM-110..113. A stand-in for public.feed_page() that is honest
        // about what it is: it serves fixture rows in the order the fixture
        // lists them, cuts pages on an opaque cursor, and answers the scope
        // and limit it was given. It does NOT rank and does NOT diversify.
        // Ranking and diversity are Postgres, are unit-tested in
        // supabase/tests/0019_feed_page_test.sql, and a JS re-implementation
        // here would only ever assert itself. What this DOES let a test
        // assert for real is the client half: that the returned order is
        // rendered untouched, that the cursor round-trips, that a page is
        // twenty rows, and that a scope reaches the server.
        if (name === "feed_page") {
          const all = rows("feed_page_rows").length ? rows("feed_page_rows") : rows("community_feed");
          const scope = (args && args.p_scope) || "for_you";
          const limit = Math.min(Math.max(Number((args && args.p_limit) || 20), 1), 40);
          const following = new Set(rows("follows").filter((f) => currentUser && f.follower_id === currentUser.id).map((f) => f.followed_id));
          const hidden = new Set(rows("hidden_posts").filter((h) => currentUser && h.user_id === currentUser.id).map((h) => h.post_id));
          const inScope = (r) => {
            if (hidden.has(r.id)) return false;
            if (scope === "following") return following.has(r.author_id);
            if (scope === "achievements") return ["POST_PR", "POST_ACHIEVEMENT", "POST_ATTENDANCE_MILESTONE"].includes(r.post_type);
            if (scope === "coach") return ["POST_COACH", "POST_ANNOUNCEMENT"].includes(r.post_type);
            if (scope === "my_classes") return false; // COMM-P01, parked server-side too
            return true;
          };
          const pool = all.filter(inScope);
          let start = 0;
          if (args && args.p_cursor) {
            try {
              const tok = JSON.parse(Buffer.from(String(args.p_cursor), "base64").toString("utf8"));
              // Same property the real cursor has: the boundary is a row
              // identity, not an offset, so a row inserted at the top while
              // paginating cannot shift a later page.
              const at = pool.findIndex((r) => String(r.id) === String(tok.i));
              start = at < 0 ? pool.length : at + 1;
            } catch (e) { start = 0; }
          }
          const page = pool.slice(start, start + limit);
          const more = start + limit < pool.length;
          const next = more && page.length
            ? Buffer.from(JSON.stringify({ a: tokenAnchor(), i: page[page.length - 1].id }), "utf8").toString("base64")
            : null;
          return Promise.resolve({ data: page.map((r) => ({ ...r, next_cursor: next })), error: null });
        }
        if (name === "club_summary") {
          const club = rows("clubs")[0] || null;
          if (!club) return Promise.resolve({ data: null, error: null });
          return Promise.resolve({
            data: {
              name: club.name || "",
              image_url: club.image_url || null,
              member_count: rows("profiles").filter((p) => !p.deleted_at).length,
              active_challenge: club.active_challenge || null,
              unread_notifications: rows("notifications").filter((n) => currentUser && n.user_id === currentUser.id && !n.read_at).length,
            },
            error: null,
          });
        }
        // COMM-003 telemetry. The real functions are definer-side; these
        // record what the client actually sent, including the de-dupe the
        // unique (user_id, feed_session_id, post_id) gives for free.
        if (name === "feed_record_impressions") {
          const payload = (args && args.p_rows) || [];
          if (payload.length > 50) return Promise.resolve({ data: null, error: { message: "at most 50 impressions per call" } });
          for (const r of payload) {
            if (!r || !r.post_id || !r.feed_session_id) continue;
            const dupe = rows("feed_impressions").some((x) => x.user_id === (currentUser && currentUser.id) && x.feed_session_id === r.feed_session_id && x.post_id === r.post_id);
            if (dupe) continue;
            rows("feed_impressions").push({ user_id: currentUser && currentUser.id, post_id: r.post_id, position: r.position, feed_session_id: r.feed_session_id, shown_at: r.shown_at, opened: false, engaged: false });
          }
          return Promise.resolve({ data: null, error: null });
        }
        if (name === "feed_record_interaction") {
          const kind = args && args.p_kind;
          const postId = args && args.p_post_id;
          if (!["open", "react", "comment", "share", "hide", "save", "profile_open"].includes(kind)) {
            return Promise.resolve({ data: null, error: { message: `unknown interaction kind ${kind}` } });
          }
          rows("feed_interactions").push({ user_id: currentUser && currentUser.id, post_id: postId, kind });
          for (const imp of rows("feed_impressions")) {
            if (imp.user_id !== (currentUser && currentUser.id) || imp.post_id !== postId) continue;
            if (kind === "open") imp.opened = true;
            if (["react", "comment", "share", "save"].includes(kind)) imp.engaged = true;
          }
          return Promise.resolve({ data: null, error: null });
        }
        if (name === "redeem_invite_code") {
          rows("invite_redemptions").push({ user_id: currentUser.id, invite_id: "inv-1", role: "member", redeemed_at: new Date().toISOString() });
          return Promise.resolve({ data: "member", error: null });
        }
        // COMM-016. The real RPC refuses unless Auth confirms a real email
        // plus password; the mock stamps whenever the current user has a
        // registered credential pair, which is the same precondition the
        // app enforces before it ever calls this.
        // COMM-120..125 engagement cluster. In-memory stand-ins for the
        // definer functions so an engagement test does not have to re-register
        // each one. A test-supplied onRpc() still wins over all of these.
        if (name === "toggle_reaction") {
          const pid = args && args.p_post_id;
          const uid = currentUser && currentUser.id;
          const rs = rows("reactions");
          const idx = rs.findIndex((r) => r.post_id === pid && r.user_id === uid && (r.kind || "cheer") === "cheer");
          if (idx >= 0) { rs.splice(idx, 1); return Promise.resolve({ data: false, error: null }); }
          rs.push({ post_id: pid, user_id: uid, kind: "cheer", created_at: new Date().toISOString() });
          return Promise.resolve({ data: true, error: null });
        }
        if (name === "add_post_comment") {
          const pid = args && args.p_post_id;
          const parent = (args && args.p_parent_comment_id) || null;
          const body = String((args && args.p_body) || "").slice(0, 1000);
          const cs = rows("post_comments");
          if (parent) {
            const p = cs.find((c) => c.id === parent);
            if (!p) return Promise.resolve({ data: null, error: { message: "parent comment not found" } });
            if (p.post_id !== pid) return Promise.resolve({ data: null, error: { message: "parent comment is on another post" } });
            if (p.parent_comment_id) return Promise.resolve({ data: null, error: { message: "reply depth is capped at 2" } });
          }
          const id = `c-${++uidCounter}`;
          cs.push({ id, post_id: pid, author_id: currentUser && currentUser.id, body, parent_comment_id: parent, created_at: new Date().toISOString(), edited_at: null, deleted_at: null, status: "active" });
          return Promise.resolve({ data: id, error: null });
        }
        if (name === "comment_edit") {
          const c = rows("post_comments").find((x) => x.id === (args && args.p_comment_id));
          if (!c) return Promise.resolve({ data: null, error: { message: "comment not found" } });
          if (c.author_id !== (currentUser && currentUser.id)) return Promise.resolve({ data: null, error: { message: "not authorized" } });
          const body = String((args && args.p_body) || "").slice(0, 1000);
          if (!body.trim()) return Promise.resolve({ data: null, error: { message: "comment body required" } });
          c.body = body;
          c.edited_at = new Date().toISOString();
          return Promise.resolve({ data: null, error: null });
        }
        if (name === "can_view_profile_field") {
          const target = args && args.p_target;
          const field = args && args.p_field;
          const me = currentUser && currentUser.id;
          if (!target || target === me) return Promise.resolve({ data: true, error: null });
          const blocked = rows("blocks").some((b) => (b.blocker_id === me && b.blocked_id === target) || (b.blocker_id === target && b.blocked_id === me));
          if (blocked) return Promise.resolve({ data: false, error: null });
          const prof = rows("profiles").find((p) => p.id === target);
          if (prof && field in prof && prof[field] === false) return Promise.resolve({ data: false, error: null });
          return Promise.resolve({ data: true, error: null });
        }
        // COMM-130. Client-trust claim path for non-attendance milestones.
        // Honours enabled + non-attendance + client_claimable when
        // achievement_definitions is seeded; accepts any code as a
        // non-repeatable unlock when it is not, so a test can skip seeding.
        if (name === "ach_claim") {
          const uid = currentUser && currentUser.id;
          if (!uid) return Promise.resolve({ data: null, error: { message: "auth required" } });
          const codes = Array.isArray(args && args.p_codes) ? args.p_codes.map(String) : [];
          if (codes.length > 50) return Promise.resolve({ data: null, error: { message: "at most 50 codes per call" } });
          const defs = rows("achievement_definitions");
          const ma = rows("member_achievements");
          const out = [];
          for (const code of codes) {
            const def = defs.length ? defs.find((d) => d.code === code) : null;
            if (defs.length) {
              if (!def || def.enabled === false) continue;
              if (def.trigger_type === "ATTENDANCE_RECORDED") continue;
              if (!(def.config && def.config.client_claimable === true)) continue;
            }
            const repeatable = def ? !!def.repeatable : false;
            if (!repeatable && ma.some((r) => r.user_id === uid && r.code === code)) continue;
            const id = `ma-${++uidCounter}`;
            const visibility = (def && def.visibility) || "club";
            ma.push({ id, user_id: uid, achievement_id: def ? def.id : null, code, visibility, shared_at: null, unlocked_at: new Date().toISOString(), repeatable, achievement_definitions: { code, name: def ? def.name : code, icon: def ? def.icon : null } });
            out.push({ code, member_achievement_id: id, visibility });
          }
          return Promise.resolve({ data: out, error: null });
        }
        if (name === "ach_share") {
          const uid = currentUser && currentUser.id;
          const rec = rows("member_achievements").find((r) => r.id === (args && args.member_achievement_id));
          if (!rec) return Promise.resolve({ data: null, error: { message: "achievement not found" } });
          if (rec.user_id !== uid) return Promise.resolve({ data: null, error: { message: "not the owner" } });
          if (rec.visibility === "only_me") return Promise.resolve({ data: null, error: { message: "private achievement" } });
          rec.shared_at = new Date().toISOString();
          const id = `ach-post-${++uidCounter}`;
          rows("workout_posts").push({ id, author_id: uid, post_type: "POST_ACHIEVEMENT", source_type: "achievement", source_id: rec.achievement_id, created_at: rec.shared_at });
          return Promise.resolve({ data: id, error: null });
        }
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
