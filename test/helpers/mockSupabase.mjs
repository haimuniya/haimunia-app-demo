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
  // COMM-150..156. Shared helpers for the admin-moderation stand-ins below.
  const MOCK_ROLE_PERMS = {
    member: ["community.post.create"],
    coach: ["community.post.create", "community.comment.moderate", "community.challenge.create", "community.event.manage", "community.announcement.publish"],
    head_coach: ["community.post.create", "community.comment.moderate", "community.challenge.create", "community.event.manage", "community.announcement.publish", "community.post.delete_any", "community.member.restrict", "community.content.pin"],
    staff: ["community.post.create", "community.event.manage", "community.announcement.publish", "community.content.pin"],
    admin: ["community.post.create", "community.post.delete_any", "community.comment.moderate", "community.challenge.create", "community.event.manage", "community.analytics.view", "community.member.restrict", "community.announcement.publish", "community.content.pin"],
  };
  MOCK_ROLE_PERMS.owner = MOCK_ROLE_PERMS.admin.slice();
  function roleOf(uid) {
    const prof = rows("profiles").find((p) => p.id === uid);
    if (prof && prof.is_admin) return "admin";
    const red = rows("invite_redemptions").find((r) => r.user_id === uid);
    return (red && red.role) || null;
  }
  function permHas(uid, code) {
    const role = roleOf(uid);
    return !!role && (MOCK_ROLE_PERMS[role] || []).indexOf(code) >= 0;
  }
  function auditRow(adminId, actionType, targetType, targetId, before, after) {
    return {
      id: `aa-${++uidCounter}`, admin_id: adminId, action_type: actionType,
      target_type: targetType, target_id: targetId, before_data: before || null,
      after_data: after || null, created_at: new Date().toISOString(),
    };
  }
  // The real cursor carries the session anchor so every page of one session
  // scores against the same now(). The mock has no scoring, but it carries
  // the same field so a test reading a cursor sees the same shape.
  const anchor = new Date().toISOString();
  function tokenAnchor() { return anchor; }

  // COMM-201..207. A faithful-enough stand-in for the two challenge_progress
  // triggers (202608290003/202608290004): challenge_progress_stamp_team
  // (BEFORE INSERT, snapshots the contributor's current team_id) and
  // challenge_progress_apply (AFTER INSERT, bumps
  // challenge_participants.progress_value, flips individual_target/
  // individual_performance to completed at target_value, and - cooperative
  // only - posts one authorless POST_CHALLENGE milestone the first time the
  // running club_total crosses 25/50/75/100% of target_value). Every
  // challenge_progress write in cloud.js is a direct RLS insert (never an
  // RPC), so this is the one place in the mock that has to run the trigger
  // logic, the same way the real table's triggers would.
  function applyChallengeProgressInserts(insertedRows) {
    let seq = 0;
    for (const row of insertedRows) {
      if (!row || row.delta == null) continue;
      row.id = row.id || `cp-${++uidCounter}-${++seq}`;
      row.created_at = row.created_at || new Date().toISOString();
      const challenge = rows("challenges").find((c) => c.id === row.challenge_id);
      const participant = rows("challenge_participants").find((p) => p.challenge_id === row.challenge_id && p.user_id === row.user_id);
      if (row.team_id === undefined || row.team_id === null) row.team_id = participant ? (participant.team_id || null) : null;
      if (!challenge) continue;
      if (participant) {
        const newTotal = Number(participant.progress_value || 0) + Number(row.delta);
        participant.progress_value = newTotal;
        const canComplete = participant.status !== "completed"
          && ["individual_target", "individual_performance"].includes(challenge.challenge_type)
          && challenge.target_value != null && newTotal >= Number(challenge.target_value);
        if (canComplete) { participant.status = "completed"; participant.completed_at = new Date().toISOString(); }
      }
      if (challenge.challenge_type === "cooperative" && challenge.target_value) {
        const total = rows("challenge_progress").filter((p) => p.challenge_id === challenge.id).reduce((s, p) => s + Number(p.delta || 0), 0);
        const pct = (total / Number(challenge.target_value)) * 100;
        for (const threshold of [25, 50, 75, 100]) {
          if (pct < threshold) continue;
          const already = rows("workout_posts").some((p) => p.post_type === "POST_CHALLENGE" && p.metadata
            && String(p.metadata.challenge_id) === String(challenge.id) && Number(p.metadata.milestone) === threshold);
          if (already) continue;
          rows("workout_posts").push({
            id: `chpost-${++uidCounter}`, author_id: null, post_type: "POST_CHALLENGE", visibility: "club",
            body: `${threshold}% of the way to ${challenge.title}`,
            metadata: { challenge_id: challenge.id, challenge_title: challenge.title, milestone: threshold, club_total: total, target_value: challenge.target_value },
            status: "active", created_at: new Date().toISOString(), published_at: new Date().toISOString(),
          });
        }
      }
    }
  }

  // COMM-308. Mirrors challenge_teams_release_captain (schema half): a
  // captain who is no longer an active (not withdrawn) participant on the
  // team they captain stops being its captain. Covers every path that can
  // change challenge_participants' team_id/status for a real client
  // session - leave (delete), pickChallengeTeam/autoAssignChallengeTeam
  // (update), coach entry status flips, and chal_reassign_team below - not
  // only the one function this ticket adds, the same "one rule, three
  // paths, one trigger" shape the schema comment describes.
  function releaseInvalidCaptains(challengeId) {
    if (!challengeId) return;
    for (const t of rows("challenge_teams").filter((x) => x.challenge_id === challengeId)) {
      if (!t.captain_id) continue;
      const stillActive = rows("challenge_participants").some((p) => p.challenge_id === challengeId && p.user_id === t.captain_id && p.team_id === t.id && p.status !== "withdrawn");
      if (!stillActive) t.captain_id = null;
    }
  }

  function chain(table) {
    let filters = [];
    let mode = "select";
    let pendingPayload = null;
    const api = {
      select() { return api; },
      eq(col, val) { filters.push((r) => r[col] === val); return api; },
      neq(col, val) { filters.push((r) => r[col] !== val); return api; },
      // COMM-229. push_subscriptions' own `where revoked_at is null` reads
      // and writes need real IS NULL semantics - a real Postgrest client
      // treats .eq(col, null) differently (it never matches), so this is
      // its own method rather than reusing eq() for it.
      is(col, val) { filters.push((r) => (val === null ? (r[col] === null || r[col] === undefined) : r[col] === val)); return api; },
      // COMM-309. Monthly club recap's member-facing read needs the real
      // Postgrest `.not(col, "is", null)` negation - "published_at IS NOT
      // NULL" - which is what actually enforces "no draft ever appears on
      // the member surface" in the mock, since (unlike the RPC stand-ins
      // above) plain `.from()` reads here carry no RLS simulation at all.
      // Only the "is" operator is implemented, the one caller in this file
      // needs; any other operator falls back to a plain inequality.
      not(col, op, val) {
        filters.push((r) => {
          if (op === "is") return val === null ? !(r[col] === null || r[col] === undefined) : r[col] !== val;
          return r[col] !== val;
        });
        return api;
      },
      gt(col, val) { filters.push((r) => r[col] > val); return api; },
      // COMM-221. Recap week browsing needs the "strictly before/after"
      // and "on or after/before" pairs a real Postgrest client has -
      // added alongside gt() rather than duplicating its shape.
      lt(col, val) { filters.push((r) => r[col] < val); return api; },
      gte(col, val) { filters.push((r) => r[col] >= val); return api; },
      lte(col, val) { filters.push((r) => r[col] <= val); return api; },
      in(col, vals) { const set = new Set(vals || []); filters.push((r) => set.has(r[col])); return api; },
      or() { return api; },
      order(col, opts) { api._orderCol = col; api._orderAsc = !opts || opts.ascending !== false; return api; },
      // COMM-231. Was a no-op until the members directory needed a real
      // page-size cap on a direct .from("profiles") read to test against
      // (rather than an RPC, which every other paginated surface here
      // already used and which the mock has always been able to cap
      // per-call). Verified against the full suite before this change
      // landed: nothing relied on the old no-op behavior.
      limit(n) { api._limit = n; return api; },
      insert(payload) { mode = "insert"; pendingPayload = payload; return api; },
      upsert(payload, opts) { mode = "upsert"; pendingPayload = payload; api._onConflict = opts && opts.onConflict; return api; },
      update(payload) { mode = "update"; pendingPayload = payload; return api; },
      delete() { mode = "delete"; return api; },
      maybeSingle() {
        const matched = rows(table).filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: matched[0] || null, error: null });
      },
      // The real @supabase/postgrest-js builder is only a thenable - it
      // defines .then() and nothing else, so app code must never chain
      // .catch()/.finally() directly on one (wrap it in Promise.resolve()
      // first, as feed_record_impressions/feed_record_interaction do).
      // This mock's own catch()/finally() below are a convenience for
      // test code, delegating to a real Promise so every Promise method
      // works - but that convenience is exactly what let pingActivity()
      // and dismissOnboardingStep() ship with a direct .catch() that threw
      // "is not a function" against the real client while every test here
      // passed. Don't take this mock's shape as a spec for what the real
      // builder supports.
      _resolve() {
        if (mode === "insert") {
          const list = Array.isArray(pendingPayload) ? pendingPayload : [pendingPayload];
          for (const p of list) rows(table).push(p);
          // COMM-201..207. See applyChallengeProgressInserts() above - the
          // one table whose direct-insert write path has a real trigger
          // behind it in production.
          if (table === "challenge_progress") applyChallengeProgressInserts(list);
          return { error: null, data: list };
        }
        if (mode === "update") {
          const matched = rows(table).filter((r) => filters.every((f) => f(r)));
          for (const r of matched) Object.assign(r, pendingPayload);
          // COMM-308. See releaseInvalidCaptains() above.
          if (table === "challenge_participants") {
            const cids = new Set(matched.map((r) => r.challenge_id));
            for (const cid of cids) releaseInvalidCaptains(cid);
          }
          return { error: null, data: matched };
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
          const matched = rows(table).filter((r) => filters.every((f) => f(r)));
          db[table] = rows(table).filter((r) => !filters.every((f) => f(r)));
          // COMM-308. See releaseInvalidCaptains() above - a captain who
          // leaves the challenge (challenge_participants_leave_self) stops
          // captaining their old team, same as a reassignment or a
          // withdrawal.
          if (table === "challenge_participants") {
            const cids = new Set(matched.map((r) => r.challenge_id));
            for (const cid of cids) releaseInvalidCaptains(cid);
          }
          return { error: null };
        }
        let matched = rows(table).filter((r) => filters.every((f) => f(r)));
        if (api._orderCol) matched = matched.slice().sort((a, b) => (a[api._orderCol] > b[api._orderCol] ? 1 : -1) * (api._orderAsc ? 1 : -1));
        if (api._limit != null) matched = matched.slice(0, api._limit);
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
    // COMM-362. gotrue-js fires the exact same SIGNED_OUT event both when a
    // caller signs out on purpose and when its own background access-token
    // refresh fails (expired/revoked refresh token) - cloud.js's
    // onAuthStateChange handler makes no distinction, by design, so this
    // reuses that one code path rather than inventing a second one. Named
    // separately from client.auth.signOut() purely so a test reads as "the
    // session died out from under the app" rather than "the user clicked
    // sign out" - the mechanics are identical on purpose.
    expireSession() {
      currentUser = null;
      queueMicrotask(() => authCb && authCb("SIGNED_OUT", null));
    },
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
        // Post-Phase-3 fix. loadMemberRoles() used to read invite_redemptions
        // directly; that read only ever worked under real RLS for the
        // caller's own row (202608270003's own-row-only policy was never
        // widened), so it moved to member_roles(uuid[]) (202609010011), a
        // definer function returning only {user_id, role} for the requested
        // ids. This mock has no RLS to get wrong, so it can just answer from
        // the seeded table directly - the real privacy boundary (own row
        // only under RLS, any row through the function) is Postgres and is
        // asserted in pgTAP, not here; this only proves the client calls the
        // RPC with the right ids and reads the response shape it returns.
        if (name === "member_roles") {
          const ids = new Set((args && Array.isArray(args.p_ids) ? args.p_ids : []).map(String));
          const data = rows("invite_redemptions")
            .filter((r) => ids.has(String(r.user_id)))
            .map((r) => ({ user_id: r.user_id, role: r.role }));
          return Promise.resolve({ data, error: null });
        }
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
        // COMM-213..217. A faithful stand-in for public.event_rsvp()
        // (202608280010): capacity and deadline are enforced here exactly
        // as the real enforce_event_capacity() trigger enforces them - the
        // going count excludes the row being written (so a going->going
        // update on a full event stays idempotent, per COMM-214), and
        // deadline/capacity are both real-time checks against the mock's
        // clock, not a precomputed flag. This is a built-in (not a
        // per-test onRpc(), unlike post_create) because the capacity race
        // and deadline enforcement tests need the real branching logic,
        // not a canned response.
        if (name === "event_rsvp") {
          if (!currentUser) return Promise.resolve({ data: null, error: { message: "not authorized" } });
          const eventId = args && args.p_event_id;
          const response = args && args.p_response;
          if (!["going", "interested", "not_going"].includes(response)) {
            return Promise.resolve({ data: null, error: { message: `unknown rsvp response ${response}` } });
          }
          const event = rows("events").find((e) => e.id === eventId);
          if (!event || event.status !== "published") {
            return Promise.resolve({ data: null, error: { message: "event not open for rsvp" } });
          }
          if (response === "going") {
            if (event.registration_deadline && new Date() > new Date(event.registration_deadline)) {
              return Promise.resolve({ data: null, error: { message: "registration_closed" } });
            }
            if (event.capacity != null) {
              const going = rows("event_attendees").filter((a) => a.event_id === eventId && a.response === "going" && a.user_id !== currentUser.id).length;
              if (going >= event.capacity) return Promise.resolve({ data: null, error: { message: "event_full" } });
            }
          }
          const existing = rows("event_attendees").find((a) => a.event_id === eventId && a.user_id === currentUser.id);
          if (existing) { existing.response = response; existing.registered_at = new Date().toISOString(); }
          else rows("event_attendees").push({ event_id: eventId, user_id: currentUser.id, response, registered_at: new Date().toISOString() });
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
        // COMM-140..144. The three notification RPCs. Notification rows
        // are created only server-side (the table has no insert grant), so
        // a test seeds `notifications` directly; these read and mark-read
        // the caller's own rows the way the shipped functions do.
        if (name === "notif_list") {
          const uid = currentUser && currentUser.id;
          const limit = Math.min(Math.max(Number((args && args.p_limit) || 20), 1), 40);
          let list = rows("notifications").filter((n) => n.user_id === uid);
          list = list.slice().sort((a, b) => (a.created_at > b.created_at ? -1 : a.created_at < b.created_at ? 1 : 0));
          if (args && args.p_cursor) list = list.filter((n) => n.created_at < args.p_cursor);
          return Promise.resolve({ data: list.slice(0, limit), error: null });
        }
        if (name === "notif_mark_read") {
          const uid = currentUser && currentUser.id;
          const ids = (args && args.p_ids) || [];
          if (ids.length > 100) return Promise.resolve({ data: null, error: { message: "at most 100 ids per call" } });
          const stamp = new Date().toISOString();
          for (const n of rows("notifications")) {
            if (n.user_id === uid && ids.indexOf(n.id) >= 0 && !n.read_at) n.read_at = stamp;
          }
          return Promise.resolve({ data: null, error: null });
        }
        if (name === "notif_unread_count") {
          const uid = currentUser && currentUser.id;
          return Promise.resolve({ data: rows("notifications").filter((n) => n.user_id === uid && !n.read_at).length, error: null });
        }
        // COMM-150..156 admin-moderation cluster. In-memory stand-ins for
        // the trusted functions the client calls. A test-supplied onRpc()
        // still wins over every one of these.
        //
        // The role -> permission mapping mirrors migration 202608280001.
        // owner short-circuits to every permission the same way has_perm()
        // does server-side.
        if (name === "my_permissions") {
          const role = roleOf(currentUser && currentUser.id);
          return Promise.resolve({ data: role ? (MOCK_ROLE_PERMS[role] || []).slice() : [], error: null });
        }
        if (name === "report") {
          const uid = currentUser && currentUser.id;
          if (!uid) return Promise.resolve({ data: null, error: { message: "not authorized" } });
          const tt = args && args.p_target_type;
          const tid = args && args.p_target_id;
          const reason = args && args.p_reason;
          if (!["post", "comment"].includes(tt)) return Promise.resolve({ data: null, error: { message: "unknown target type" } });
          if (!["harassment", "spam", "inappropriate", "privacy", "unsafe_advice", "other"].includes(reason)) {
            return Promise.resolve({ data: null, error: { message: "unknown reason" } });
          }
          const rs = rows("reports");
          const existing = rs.find((r) => r.reporter_id === uid && r.target_type === tt && r.target_id === tid);
          if (existing) {
            // Duplicate by the same reporter collapses - reason/note refresh,
            // reporter_count does not move.
            existing.reason = reason;
            existing.note = String((args && args.p_note) || "").slice(0, 500);
            return Promise.resolve({ data: null, error: null });
          }
          rs.push({
            id: `rep-${++uidCounter}`, reporter_id: uid, target_type: tt, target_id: tid,
            reason, note: String((args && args.p_note) || "").slice(0, 500),
            status: "open", created_at: new Date().toISOString(),
          });
          return Promise.resolve({ data: null, error: null });
        }
        if (name === "mod_queue") {
          const uid = currentUser && currentUser.id;
          const prof = rows("profiles").find((p) => p.id === uid);
          const red = rows("invite_redemptions").find((r) => r.user_id === uid);
          const role = (prof && prof.is_admin) ? "admin" : (red && red.role) || null;
          const canModerate = ["coach", "head_coach", "admin", "owner"].includes(role);
          if (!canModerate) return Promise.resolve({ data: null, error: { message: "not authorized" } });
          const status = (args && args.p_status) || "open";
          const limit = Math.min(Number((args && args.p_limit) || 50), 50);
          // Group the raw report rows by target, the way the real function
          // returns one queue row per reported item.
          const byTarget = {};
          for (const r of rows("reports")) {
            const key = `${r.target_type}:${r.target_id}`;
            if (!byTarget[key]) byTarget[key] = { rows: [], reporters: new Set() };
            byTarget[key].rows.push(r);
            byTarget[key].reporters.add(r.reporter_id);
          }
          let items = Object.keys(byTarget).map((key) => {
            const g = byTarget[key];
            const first = g.rows[0];
            const content = first.target_type === "post"
              ? rows("workout_posts").find((p) => p.id === first.target_id)
              : rows("post_comments").find((c) => c.id === first.target_id);
            const authorId = content && (content.author_id);
            const authorProf = rows("profiles").find((p) => p.id === authorId);
            const qStatus = g.rows.some((x) => x.status === "open") ? "open"
              : g.rows.some((x) => x.status === "reviewing") ? "reviewing"
              : g.rows.some((x) => x.status === "dismissed") ? "dismissed" : "action_taken";
            return {
              report_id: first.id,
              target_type: first.target_type,
              target_id: first.target_id,
              content_excerpt: content ? (content.body || content.title || "") : "",
              content_author_id: authorId || null,
              content_author_name: authorProf ? (authorProf.display_name || "@" + authorProf.handle) : null,
              reporter_count: g.reporters.size,
              reasons: Array.from(new Set(g.rows.map((x) => x.reason))),
              latest_reason: g.rows[g.rows.length - 1].reason,
              note: g.rows.map((x) => x.note).filter(Boolean).slice(-1)[0] || "",
              status: qStatus,
              created_at: first.created_at,
              reporters: Array.from(g.reporters).map((id) => {
                const rp = rows("profiles").find((p) => p.id === id);
                return { id, name: rp ? (rp.display_name || "@" + rp.handle) : id };
              }),
            };
          });
          if (status !== "all") items = items.filter((it) => it.status === status);
          items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
          return Promise.resolve({ data: items.slice(0, limit), error: null });
        }
        if (name === "mod_review") {
          const uid = currentUser && currentUser.id;
          const prof = rows("profiles").find((p) => p.id === uid);
          const red = rows("invite_redemptions").find((r) => r.user_id === uid);
          const role = (prof && prof.is_admin) ? "admin" : (red && red.role) || null;
          if (!["coach", "head_coach", "admin", "owner"].includes(role)) {
            return Promise.resolve({ data: null, error: { message: "not authorized" } });
          }
          const decision = args && args.p_decision;
          if (!["remove", "warn", "restrict_temp", "restrict_permanent", "dismiss"].includes(decision)) {
            return Promise.resolve({ data: null, error: { message: "unknown decision" } });
          }
          const report = rows("reports").find((r) => r.id === (args && args.p_report_id));
          if (!report) return Promise.resolve({ data: null, error: { message: "report not found" } });
          const before = { status: report.status };
          // Content removal.
          if (decision === "remove") {
            if (report.target_type === "post") {
              const p = rows("workout_posts").find((x) => x.id === report.target_id);
              if (p) { p.status = "removed"; p.deleted_at = new Date().toISOString(); }
              rows("admin_actions").push(auditRow(uid, "content_delete", "post", report.target_id, null, { via: "mod_review" }));
            } else {
              const c = rows("post_comments").find((x) => x.id === report.target_id);
              if (c) { c.status = "removed"; c.deleted_at = new Date().toISOString(); }
              rows("admin_actions").push(auditRow(uid, "content_delete", "comment", report.target_id, null, { via: "comment_moderate" }));
            }
          }
          // Posting restriction.
          if (decision === "restrict_temp" || decision === "restrict_permanent") {
            const content = report.target_type === "post"
              ? rows("workout_posts").find((x) => x.id === report.target_id)
              : rows("post_comments").find((x) => x.id === report.target_id);
            const targetUser = content && content.author_id;
            rows("posting_restrictions").push({
              id: `pr-${++uidCounter}`, user_id: targetUser,
              restriction_type: decision === "restrict_temp" ? "temporary" : "permanent",
              expires_at: decision === "restrict_temp" ? (args && args.p_expires_at) || null : null,
              reason: String((args && args.p_note) || "").slice(0, 500),
              moderator_id: uid, source_report_id: report.id, created_at: new Date().toISOString(), lifted_at: null,
            });
            rows("admin_actions").push(auditRow(uid, "member_restrict", "member", targetUser, null, { decision }));
          }
          // Every decision records the trusted transition and one audit row.
          report.status = decision === "dismiss" ? "dismissed" : "action_taken";
          report.reviewed_by = uid;
          report.reviewed_at = new Date().toISOString();
          report.review_note = String((args && args.p_note) || "").slice(0, 500);
          rows("admin_actions").push(auditRow(uid, "report_review", "report", report.id, before, { status: report.status, decision }));
          return Promise.resolve({ data: null, error: null });
        }
        if (name === "pin_set") {
          const uid = currentUser && currentUser.id;
          if (!permHas(uid, "community.content.pin")) return Promise.resolve({ data: null, error: { message: "not authorized" } });
          const tt = args && args.p_target_type;
          const tid = args && args.p_target_id;
          if (!["announcement", "challenge", "event", "post"].includes(tt)) {
            return Promise.resolve({ data: null, error: { message: "unknown pin target type" } });
          }
          const ps = rows("pins");
          if (ps.some((p) => p.target_type === tt && p.target_id === tid)) return Promise.resolve({ data: null, error: null });
          const used = new Set(ps.map((p) => p.slot));
          let slot = null;
          for (let s = 0; s <= 2; s++) if (!used.has(s)) { slot = s; break; }
          if (slot === null) return Promise.resolve({ data: null, error: { message: "pin_limit_reached" } });
          ps.push({ id: `pin-${++uidCounter}`, target_type: tt, target_id: tid, slot, note: String((args && args.p_note) || "").slice(0, 200), pinned_by: uid, created_at: new Date().toISOString() });
          rows("admin_actions").push(auditRow(uid, "content_pin", tt, tid, null, { slot }));
          return Promise.resolve({ data: null, error: null });
        }
        if (name === "pin_clear") {
          const uid = currentUser && currentUser.id;
          if (!permHas(uid, "community.content.pin")) return Promise.resolve({ data: null, error: { message: "not authorized" } });
          const tt = args && args.p_target_type;
          const tid = args && args.p_target_id;
          const ps = rows("pins");
          const idx = ps.findIndex((p) => p.target_type === tt && p.target_id === tid);
          if (idx < 0) return Promise.resolve({ data: null, error: null });
          const [removed] = ps.splice(idx, 1);
          rows("admin_actions").push(auditRow(uid, "content_unpin", tt, tid, { slot: removed.slot }, null));
          return Promise.resolve({ data: null, error: null });
        }
        if (name === "admin_actions_page") {
          const uid = currentUser && currentUser.id;
          if (!permHas(uid, "community.analytics.view")) return Promise.resolve({ data: null, error: { message: "not authorized" } });
          const limit = Math.min(Math.max(Number((args && args.p_limit) || 25), 1), 100);
          const filters = (args && args.p_filters) || {};
          let list = rows("admin_actions").slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
          if (args && args.p_cursor) list = list.filter((a) => a.created_at < args.p_cursor);
          if (filters.action_type) list = list.filter((a) => a.action_type === filters.action_type);
          if (filters.admin_id) list = list.filter((a) => a.admin_id === filters.admin_id);
          return Promise.resolve({ data: list.slice(0, limit), error: null });
        }
        if (name === "admin_grant_coach") {
          const uid = currentUser && currentUser.id;
          const prof = rows("profiles").find((p) => p.id === uid);
          if (!prof || !prof.is_admin) return Promise.resolve({ data: null, error: { message: "not authorized" } });
          const role = (args && args.p_role) || "coach";
          const target = args && args.p_user_id;
          const red = rows("invite_redemptions").find((r) => r.user_id === target);
          const before = red ? { role: red.role } : null;
          if (red) red.role = role; else rows("invite_redemptions").push({ user_id: target, invite_id: "inv-x", role, redeemed_at: new Date().toISOString() });
          rows("admin_actions").push(auditRow(uid, "role_change", "member", target, before, { role }));
          return Promise.resolve({ data: null, error: null });
        }
        if (name === "admin_revoke_coach") {
          const uid = currentUser && currentUser.id;
          const prof = rows("profiles").find((p) => p.id === uid);
          if (!prof || !prof.is_admin) return Promise.resolve({ data: null, error: { message: "not authorized" } });
          const target = args && args.p_user_id;
          const red = rows("invite_redemptions").find((r) => r.user_id === target);
          const before = red ? { role: red.role } : null;
          if (red) red.role = "member";
          rows("admin_actions").push(auditRow(uid, "role_change", "member", target, before, { role: "member" }));
          return Promise.resolve({ data: null, error: null });
        }
        // COMM-201..207. chal_progress(challenge_id) - the one read shape
        // every challenge_type shares (202608290003). Mirrors the real
        // function's null-vs-zero rule: a field that does not apply to this
        // challenge_type is left null/undefined, never zeroed.
        if (name === "chal_progress") {
          const uid = currentUser && currentUser.id;
          if (!uid) return Promise.resolve({ data: null, error: { message: "not authorized" } });
          const cid = args && args.challenge_id;
          const challenge = rows("challenges").find((c) => c.id === cid);
          if (!challenge) return Promise.resolve({ data: null, error: { message: "challenge not found" } });
          if (challenge.status === "draft" && challenge.created_by !== uid && !permHas(uid, "community.challenge.create")) {
            return Promise.resolve({ data: null, error: { message: "challenge not found" } });
          }
          const result = {
            challenge_id: challenge.id, challenge_type: challenge.challenge_type, title: challenge.title,
            ends_at: challenge.end_at, target_value: challenge.target_value != null ? challenge.target_value : null,
            my_progress: null, my_status: null, participant_count: 0,
            club_total: null, team_totals: null, leaderboard: null,
          };
          const myP = rows("challenge_participants").find((p) => p.challenge_id === cid && p.user_id === uid);
          if (myP) { result.my_progress = myP.progress_value; result.my_status = myP.status; }
          result.participant_count = rows("challenge_participants").filter((p) => p.challenge_id === cid && p.status !== "withdrawn").length;
          if (challenge.challenge_type === "cooperative") {
            result.club_total = rows("challenge_progress").filter((p) => p.challenge_id === cid).reduce((s, p) => s + Number(p.delta || 0), 0);
          }
          if (challenge.challenge_type === "team") {
            const teams = rows("challenge_teams").filter((t) => t.challenge_id === cid);
            result.team_totals = teams.map((t) => ({
              team_id: t.id, name: t.name,
              total: rows("challenge_progress").filter((p) => p.challenge_id === cid && p.team_id === t.id).reduce((s, p) => s + Number(p.delta || 0), 0),
            })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          }
          if (["individual_performance", "coach"].includes(challenge.challenge_type)) {
            const ranked = rows("challenge_participants").filter((p) => p.challenge_id === cid && p.status !== "withdrawn")
              .slice().sort((a, b) => Number(b.progress_value || 0) - Number(a.progress_value || 0)).slice(0, 20);
            result.leaderboard = ranked.map((p) => {
              const prof = rows("profiles").find((pr) => pr.id === p.user_id) || {};
              return { user_id: p.user_id, name: prof.display_name || prof.handle || null, handle: prof.handle || null, avatar_url: prof.avatar_url || null, value: p.progress_value };
            });
          }
          return Promise.resolve({ data: result, error: null });
        }
        // COMM-206. chal_record_progress - the coach-entry write path
        // (202608290005). Mirrors the real function's error text exactly,
        // since the client keys its own message off a generic failure, not
        // this string, but a test may still want to assert it.
        if (name === "chal_record_progress") {
          const uid = currentUser && currentUser.id;
          if (!uid) return Promise.resolve({ data: null, error: { message: "not authorized" } });
          if (!permHas(uid, "community.challenge.create")) return Promise.resolve({ data: null, error: { message: "not authorized" } });
          const cid = args && args.p_challenge_id;
          const targetUser = args && args.p_user_id;
          const delta = args && args.p_delta;
          if (!cid || !targetUser) return Promise.resolve({ data: null, error: { message: "challenge and target participant are required" } });
          if (delta == null) return Promise.resolve({ data: null, error: { message: "delta is required" } });
          const participant = rows("challenge_participants").find((p) => p.challenge_id === cid && p.user_id === targetUser && p.status === "active");
          if (!participant) return Promise.resolve({ data: null, error: { message: "not an active participant" } });
          const note = String((args && args.p_note) || "").trim().slice(0, 500) || null;
          const id = `cp-${++uidCounter}`;
          const row = { id, challenge_id: cid, user_id: targetUser, delta: Number(delta), source_type: "coach_entry", note, entered_by: uid, created_at: new Date().toISOString() };
          rows("challenge_progress").push(row);
          applyChallengeProgressInserts([row]);
          return Promise.resolve({ data: id, error: null });
        }
        // COMM-308. chal_reassign_team(p_challenge_id, p_user_id, p_team_id)
        // - the coach moves a member between teams (202609010005). Mirrors
        // the real function's checks in the same order (auth, required
        // args, challenge exists, challenge_type = 'team', target is an
        // active participant, target team belongs to this challenge) and
        // its one side effect: challenge_participants.team_id changes and
        // nothing else - no challenge_progress row is touched, so a
        // member's historical team_totals contribution stays with their old
        // team exactly as chal_progress already sums it. p_team_id null
        // clears the participant's team. releaseInvalidCaptains() then
        // mirrors challenge_teams_release_captain firing in the same
        // transaction.
        if (name === "chal_reassign_team") {
          const uid = currentUser && currentUser.id;
          if (!uid) return Promise.resolve({ data: null, error: { message: "not authorized" } });
          if (!permHas(uid, "community.challenge.create")) return Promise.resolve({ data: null, error: { message: "not authorized" } });
          const cid = args && args.p_challenge_id;
          const targetUser = args && args.p_user_id;
          if (!cid || !targetUser) return Promise.resolve({ data: null, error: { message: "challenge and target participant are required" } });
          const challenge = rows("challenges").find((c) => c.id === cid);
          if (!challenge) return Promise.resolve({ data: null, error: { message: "challenge not found" } });
          if (challenge.challenge_type !== "team") return Promise.resolve({ data: null, error: { message: "not a team challenge" } });
          const participant = rows("challenge_participants").find((p) => p.challenge_id === cid && p.user_id === targetUser);
          if (!participant || participant.status === "withdrawn") return Promise.resolve({ data: null, error: { message: "not an active participant" } });
          const teamId = (args && args.p_team_id) || null;
          if (teamId != null && !rows("challenge_teams").some((t) => t.id === teamId && t.challenge_id === cid)) {
            return Promise.resolve({ data: null, error: { message: "team does not belong to this challenge" } });
          }
          const before = participant.team_id;
          participant.team_id = teamId;
          rows("admin_actions").push(auditRow(uid, "challenge_edit", "challenge_participant", targetUser, { challenge_id: cid, team_id: before }, { challenge_id: cid, team_id: teamId }));
          releaseInvalidCaptains(cid);
          return Promise.resolve({ data: null, error: null });
        }
        // COMM-308. chal_set_captain(p_team_id, p_user_id) - names or clears
        // a team's captain (202609010005). Mirrors the real function's
        // checks in order (auth, team required, team exists, and - for a
        // non-null p_user_id - the target must be an active participant on
        // this exact team). p_user_id null always clears the captain.
        if (name === "chal_set_captain") {
          const uid = currentUser && currentUser.id;
          if (!uid) return Promise.resolve({ data: null, error: { message: "not authorized" } });
          if (!permHas(uid, "community.challenge.create")) return Promise.resolve({ data: null, error: { message: "not authorized" } });
          const teamId = args && args.p_team_id;
          if (!teamId) return Promise.resolve({ data: null, error: { message: "team is required" } });
          const team = rows("challenge_teams").find((t) => t.id === teamId);
          if (!team) return Promise.resolve({ data: null, error: { message: "team not found" } });
          const userId = (args && args.p_user_id) || null;
          if (userId != null) {
            const active = rows("challenge_participants").some((p) => p.challenge_id === team.challenge_id && p.user_id === userId && p.team_id === teamId && p.status !== "withdrawn");
            if (!active) return Promise.resolve({ data: null, error: { message: "captain must be an active participant on this team" } });
          }
          const before = team.captain_id;
          team.captain_id = userId;
          rows("admin_actions").push(auditRow(uid, "challenge_edit", "challenge_team", teamId, { challenge_id: team.challenge_id, captain_id: before }, { challenge_id: team.challenge_id, captain_id: userId }));
          return Promise.resolve({ data: null, error: null });
        }
        // COMM-228. community_search(p_query, p_limit) - the grouped search
        // the UI calls once per keystroke (202608290008). Mirrors the real
        // function's sanitization (%_,() stripped), its under-2-characters
        // short circuit, its per-group cap, and each group's visibility
        // rule. The one deliberate difference: a fixture profile that never
        // set visible_to_club is treated as visible, the same leniency
        // can_view_profile_field above already applies, so a test does not
        // have to spell out every privacy column to search for a member.
        if (name === "community_search") {
          const uid = currentUser && currentUser.id;
          if (!uid) return Promise.resolve({ data: null, error: { message: "not authorized" } });
          const q = String((args && args.p_query) || "").replace(/[%_,()]/g, "").trim();
          const limit = Math.max(1, Math.min(Number((args && args.p_limit) != null ? args.p_limit : 10), 50));
          const empty = { members: [], events: [], challenges: [] };
          if (q.length < 2) return Promise.resolve({ data: empty, error: null });
          const needle = q.toLowerCase();
          const like = (v) => String(v || "").toLowerCase().includes(needle);
          const isAdminCaller = !!(rows("profiles").find((p) => p.id === uid) || {}).is_admin;
          const members = rows("profiles").filter((p) => {
            if (p.deleted_at || p.id === uid) return false;
            if (!like(p.handle) && !like(p.display_name)) return false;
            const blocked = rows("blocks").some((b) => (b.blocker_id === uid && b.blocked_id === p.id) || (b.blocker_id === p.id && b.blocked_id === uid));
            if (blocked) return false;
            return p.visible_to_club !== false || isAdminCaller;
          }).slice(0, limit).map((p) => ({
            id: p.id, handle: p.handle, display_name: p.display_name,
            bio: p.bio || null, avatar_url: p.avatar_url || null,
            allow_follows: p.allow_follows !== undefined ? p.allow_follows : null,
          }));
          const events = rows("events").filter((e) => like(e.title)
            && (e.status !== "draft" || e.created_by === uid || permHas(uid, "community.event.manage")))
            .slice(0, limit)
            .map((e) => ({ id: e.id, title: e.title, event_type: e.event_type || null, status: e.status || null, start_at: e.start_at || null }));
          const challenges = rows("challenges").filter((c) => like(c.title)
            && (c.status !== "draft" || c.created_by === uid || permHas(uid, "community.challenge.create")))
            .slice(0, limit)
            .map((c) => ({ id: c.id, title: c.title, challenge_type: c.challenge_type || null, status: c.status || null, start_at: c.start_at || null, end_at: c.end_at || null }));
          return Promise.resolve({ data: { members, events, challenges }, error: null });
        }
        // COMM-210/211/212. feed_leaderboard(p_mode, p_challenge_id, p_scope,
        // p_limit) - the one ranked board both modes and both scopes share
        // (202608290015). Mirrors the four behaviours the client actually
        // depends on, because getting any of them wrong changes what the UI
        // renders: (1) rank is a real, contiguous, tie-broken position, never
        // an array index; (2) zero is a ranked value, so a club of members who
        // have logged nothing comes back as rows-with-value-0, not as no rows;
        // (3) the caller's own row is always present, appended AFTER the top
        // p_limit rows with its real rank when it fell outside them; (4) the
        // in_leaderboards / visible_to_club / block filtering happens here, so
        // the client never re-filters. The consistency value is read off the
        // community_streaks fixture rows - the streak arithmetic itself is
        // Postgres (consistency_week_streaks) and is pinned there by pgTAP; a
        // JS re-implementation would only ever assert itself.
        if (name === "feed_leaderboard") {
          const uid = currentUser && currentUser.id;
          if (!uid) return Promise.resolve({ data: null, error: { message: "not authorized" } });
          const mode = String((args && args.p_mode) || "").trim().toLowerCase();
          const scopeRaw = String((args && args.p_scope) == null ? "club" : args.p_scope).trim().toLowerCase();
          const scope = scopeRaw || "club";
          if (!["consistency", "progress"].includes(mode)) {
            return Promise.resolve({ data: null, error: { message: `unknown leaderboard mode ${args && args.p_mode}` } });
          }
          if (!["club", "friends"].includes(scope)) {
            return Promise.resolve({ data: null, error: { message: `unknown leaderboard scope ${args && args.p_scope}` } });
          }
          const cid = (args && args.p_challenge_id) || null;
          if (mode === "progress") {
            if (!cid) return Promise.resolve({ data: null, error: { message: "challenge required" } });
            const ch = rows("challenges").find((c) => c.id === cid);
            if (!ch) return Promise.resolve({ data: null, error: { message: "challenge not found" } });
            if (ch.status === "draft" && ch.created_by !== uid && !permHas(uid, "community.challenge.create")) {
              return Promise.resolve({ data: null, error: { message: "challenge not found" } });
            }
          }
          const limit = Math.max(1, Math.min(Number((args && args.p_limit) != null ? args.p_limit : 50), 100));
          const isAdminCaller = !!(rows("profiles").find((p) => p.id === uid) || {}).is_admin;
          const mutual = (other) => rows("follows").some((f) => f.follower_id === uid && f.followed_id === other)
            && rows("follows").some((f) => f.follower_id === other && f.followed_id === uid);
          const cand = rows("profiles").filter((p) => {
            if (p.deleted_at) return false;
            if (scope === "friends" && p.id !== uid && !mutual(p.id)) return false;
            if (p.id === uid) return true;
            // can_view_profile_field settles a block edge in either direction
            // before it looks at any toggle; the is_admin short-circuit is the
            // module-wide behaviour of that resolution point.
            if (isAdminCaller) return true;
            const blocked = rows("blocks").some((b) => (b.blocker_id === uid && b.blocked_id === p.id) || (b.blocker_id === p.id && b.blocked_id === uid));
            if (blocked) return false;
            return p.visible_to_club !== false && p.in_leaderboards !== false;
          }).map((p) => {
            const red = rows("invite_redemptions").find((r) => r.user_id === p.id);
            return {
              user_id: p.id, display_name: p.display_name || null, handle: p.handle || null,
              avatar_url: p.avatar_url || null, is_self: p.id === uid,
              joined_at: (red && red.redeemed_at) || p.created_at || "",
            };
          });
          let valued;
          if (mode === "consistency") {
            const streaks = rows("community_streaks");
            valued = cand.map((c) => {
              const s = streaks.find((r) => r.user_id === c.user_id);
              return Object.assign({}, c, { value: Number((s && s.current_streak) || 0) });
            });
          } else {
            valued = cand.map((c) => {
              const p = rows("challenge_participants").find((r) => r.challenge_id === cid && r.user_id === c.user_id && r.status !== "withdrawn");
              return p ? Object.assign({}, c, { value: Number(p.progress_value || 0) }) : null;
            }).filter(Boolean);
          }
          const nameKey = (r) => String(r.display_name || "").trim() || String(r.handle || "");
          valued.sort((a, b) => (b.value - a.value)
            || String(a.joined_at).localeCompare(String(b.joined_at))
            || nameKey(a).localeCompare(nameKey(b))
            || String(a.user_id).localeCompare(String(b.user_id)));
          const ranked = valued.map((r, i) => ({
            user_id: r.user_id, display_name: r.display_name, handle: r.handle,
            avatar_url: r.avatar_url, rank: i + 1, value: r.value, is_self: r.is_self,
          }));
          const top = ranked.filter((r) => r.rank <= limit);
          const self = ranked.find((r) => r.is_self && r.rank > limit);
          return Promise.resolve({ data: self ? top.concat([self]) : top, error: null });
        }
        // COMM-232. people_suggestions(p_limit) - the non-attendance
        // "people you may know" fallback (202608290015). Mirrors the real
        // function's exclusions (self, a follow edge in either direction, a
        // block edge in either direction, visible_to_club / allow_follows) and
        // its lexicographic priority: one shared live challenge outranks any
        // number of shared interactions, which outrank shared events. A
        // candidate with no signal at all is never returned, so a brand new
        // member gets a genuinely empty strip.
        if (name === "people_suggestions") {
          const uid = currentUser && currentUser.id;
          if (!uid) return Promise.resolve({ data: null, error: { message: "not authorized" } });
          const limit = Math.max(1, Math.min(Number((args && args.p_limit) != null ? args.p_limit : 10), 20));
          const since = Date.now() - 60 * 86400000;
          const fresh = (v) => !!v && new Date(v).getTime() >= since;
          const myChallenges = rows("challenge_participants").filter((p) => p.user_id === uid && p.status !== "withdrawn");
          const liveChallenge = (id) => {
            const c = rows("challenges").find((x) => x.id === id);
            return !!c && c.status === "active" && (!c.end_at || new Date(c.end_at).getTime() >= Date.now());
          };
          const myPosts = new Set(rows("feed_interactions")
            .filter((i) => i.user_id === uid && ["react", "comment"].includes(i.kind) && fresh(i.created_at))
            .map((i) => i.post_id));
          const myEvents = new Set(rows("event_attendees")
            .filter((a) => a.user_id === uid && a.response === "going" && fresh(a.registered_at))
            .map((a) => a.event_id));
          const out = [];
          for (const p of rows("profiles")) {
            if (p.deleted_at || p.id === uid) continue;
            if (rows("follows").some((f) => (f.follower_id === uid && f.followed_id === p.id) || (f.follower_id === p.id && f.followed_id === uid))) continue;
            if (rows("blocks").some((b) => (b.blocker_id === uid && b.blocked_id === p.id) || (b.blocker_id === p.id && b.blocked_id === uid))) continue;
            if (p.visible_to_club === false || p.allow_follows === false) continue;
            const sharedChallenges = new Set(rows("challenge_participants")
              .filter((r) => r.user_id === p.id && r.status !== "withdrawn"
                && myChallenges.some((m) => m.challenge_id === r.challenge_id) && liveChallenge(r.challenge_id))
              .map((r) => r.challenge_id)).size;
            const sharedInteractions = new Set(rows("feed_interactions")
              .filter((i) => i.user_id === p.id && ["react", "comment"].includes(i.kind) && fresh(i.created_at) && myPosts.has(i.post_id))
              .map((i) => i.post_id)).size;
            const sharedEvents = new Set(rows("event_attendees")
              .filter((a) => a.user_id === p.id && a.response === "going" && fresh(a.registered_at) && myEvents.has(a.event_id))
              .map((a) => a.event_id)).size;
            if (!sharedChallenges && !sharedInteractions && !sharedEvents) continue;
            out.push({
              user_id: p.id, display_name: p.display_name || null, handle: p.handle || null,
              avatar_url: p.avatar_url || null,
              reason: sharedChallenges ? "challenge" : sharedInteractions ? "interaction" : "event",
              signals: { shared_challenges: sharedChallenges, shared_interactions: sharedInteractions, shared_events: sharedEvents },
            });
          }
          const nameOf = (r) => String(r.display_name || "").trim() || String(r.handle || "");
          out.sort((a, b) => (b.signals.shared_challenges - a.signals.shared_challenges)
            || (b.signals.shared_interactions - a.signals.shared_interactions)
            || (b.signals.shared_events - a.signals.shared_events)
            || nameOf(a).localeCompare(nameOf(b))
            || String(a.user_id).localeCompare(String(b.user_id)));
          return Promise.resolve({ data: out.slice(0, limit), error: null });
        }
        // COMM-307. attendance_classmates_today(p_limit) - "who else trained
        // today" (202608310005). A stand-in for the four behaviours the client
        // half actually depends on, and no more: (1) the returned rows carry
        // exactly the four documented keys, so a card that renders a fifth
        // would have nothing to render it from; (2) the ORDER is the server's
        // (recorded_at desc, then display name falling back to handle, then
        // id) and the cut at p_limit happens after it, so a test can prove the
        // client never re-sorts; (3) an empty set is the one answer for all
        // three server-side empties - the caller did not train today, the
        // caller trained alone, or the CALLER's own show_attendance is off -
        // because the whole card hangs on those being indistinguishable; and
        // (4) p_limit clamps 1..20 with null meaning 6.
        //
        // "Today" is the mock's own current date, matching the real function's
        // current_date, so a fixture seeds attendance_log rows with an
        // occurred_on of today to be on the card at all.
        //
        // The per-candidate privacy gate is spelled out here rather than
        // delegated, because it is what makes the empty-card fixtures honest -
        // but it is NOT what this file is proving. The gate, the block edges,
        // the deleted/visible_to_club fallout, the admin short-circuit and the
        // ordering itself are Postgres and are pinned by 35 assertions in
        // supabase/tests/0041_attendance_classmates_today_test.sql.
        if (name === "attendance_classmates_today") {
          const uid = currentUser && currentUser.id;
          if (!uid) return Promise.resolve({ data: null, error: { message: "not authorized" } });
          const limit = Math.max(1, Math.min(Number((args && args.p_limit) != null ? args.p_limit : 6), 20));
          const today = new Date().toISOString().slice(0, 10);
          const me = rows("profiles").find((p) => p.id === uid && !p.deleted_at);
          // The caller's own toggle, a direct column read the way the real
          // function does it - can_view_profile_field answers true for the
          // caller before it reads any toggle, so it cannot express this.
          if (!me || me.show_attendance !== true) return Promise.resolve({ data: [], error: null });
          const mine = rows("attendance_log").find((r) => r.user_id === uid && r.occurred_on === today);
          if (!mine) return Promise.resolve({ data: [], error: null });
          const isAdminCaller = !!me.is_admin;
          const out = [];
          for (const row of rows("attendance_log")) {
            if (row.occurred_on !== today || row.user_id === uid) continue;
            const p = rows("profiles").find((x) => x.id === row.user_id);
            if (!p || p.deleted_at) continue;
            if (!isAdminCaller) {
              const blocked = rows("blocks").some((b) => (b.blocker_id === uid && b.blocked_id === p.id) || (b.blocker_id === p.id && b.blocked_id === uid));
              if (blocked) continue;
              if (p.visible_to_club === false) continue;
              if (p.show_attendance !== true) continue;
            }
            out.push({
              user_id: p.id, display_name: p.display_name || null,
              handle: p.handle || null, avatar_url: p.avatar_url || null,
              _at: row.recorded_at || "",
            });
          }
          const nameOf = (r) => String(r.display_name || "").trim() || String(r.handle || "");
          out.sort((a, b) => String(b._at).localeCompare(String(a._at))
            || nameOf(a).localeCompare(nameOf(b))
            || String(a.user_id).localeCompare(String(b.user_id)));
          return Promise.resolve({
            data: out.slice(0, limit).map((r) => ({ user_id: r.user_id, display_name: r.display_name, handle: r.handle, avatar_url: r.avatar_url })),
            error: null,
          });
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
        from: (bucket) => ({
          createSignedUrl: () => Promise.resolve({ data: { signedUrl: "https://mock/signed" }, error: null }),
          upload: () => Promise.resolve({ error: null }),
          // COMM-318. avatar-photos is public - no signed URL, a plain
          // deterministic public URL the client cache-busts itself.
          getPublicUrl: (path) => ({ data: { publicUrl: `https://mock/public/${bucket}/${path}` } }),
          remove: () => Promise.resolve({ error: null }),
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
