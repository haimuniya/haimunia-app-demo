begin;

-- COMM-303. Personalized feed ranking: the STORAGE and the READER.
--
-- WHAT LANDS HERE
--   * public.member_feed_weights            - new table, own-row select only,
--                                             no client write grant at all.
--   * public.feed_weights_resolve(uuid, jsonb) - new, internal, no grants.
--                                             The redistribution algorithm,
--                                             stated once.
--   * public.recompute_feed_weights(integer)   - new, service_role only, a
--                                             DELIBERATE NO-OP STUB. See below.
--   * public.feed_page(cursor, limit, scope) re-created: the eight weights in
--     its weight block stop being `constant` and are resolved per caller.
--     Same signature, same returned columns, same scoring expression text.
--
-- WHAT DOES *NOT* LAND HERE, AND MUST NOT BE MISTAKEN FOR SHIPPED
-- The actual weight-derivation algorithm. Nothing in this migration ever
-- writes a row to member_feed_weights, and nothing derives a multiplier from
-- a member's feed_interactions history. Until a later ticket writes that
-- body, EVERY member has no row, so every member gets today's fixed weights
-- and the feed order this module has always produced. That is the intended
-- end state of this ticket, not a gap in it: the same "storage exists,
-- computation/delivery does not" shape 202608280028 (notification_batches
-- written, nothing scheduled to flush them) and 202608290011 (weekly_recaps
-- written, recap_weekly's own cron gap) already carry, and recorded as such
-- in docs/community/backlog.md so it is not read as a finished personalization
-- feature.
--
-- =========================================================================
-- THE NUMBER "104", WHICH IS STALE, AND WHAT THIS TICKET DOES ABOUT IT
-- =========================================================================
-- COMM-303's acceptance criteria say the positive weights "still sum to a
-- constant total per member (the existing '104, so they read as rough
-- percentages' property)". They do sum to a constant. That constant is no
-- longer 104.
--
-- 202608280019 wrote the comment "The positive weights sum to 104" when
-- v_w_class was declared at 6 and multiplied by `v_class_connection constant
-- numeric := 0` - a hard zero, reserved for COMM-P01. Seven live weights,
-- 40+18+10+8+6+10+12 = 104. Correct at the time.
--
-- COMM-302 (202608310003) turned the class component on and left the comment
-- untouched. Since that migration the eight declared weights have summed to
-- 40+18+10+8+6+10+12+6 = 110, and 104 has been a stale comment carried
-- forward twice.
--
-- This ticket does NOT renormalise anything to 104. Scaling the defaults by
-- 104/110 would move every existing feed score for every member on day one,
-- which is the exact opposite of this ticket's most important acceptance
-- criterion ("a member with no stored weights gets exactly today's fixed
-- weights, so this ticket changes no existing feed order until a weight is
-- actually personalized"). No weight moves here. What this migration does
-- instead is stop hardcoding the total at all: the invariant enforced below
-- is "a personalized weight set sums to exactly what THE DEFAULT BLOCK sums
-- to", computed from the defaults themselves at call time. That is the
-- property the criterion is actually about - personalization redistributes
-- emphasis rather than inflating the score - and it survives the next
-- retune of any weight without a second number needing to be edited to
-- match. The stale comment is corrected in feed_page's weight block below.
--
-- =========================================================================
-- THE TWO TUNING NUMBERS, RESOLVED BY THE USER, AND REVISABLE
-- =========================================================================
-- COMM-303's "Open question" flagged both rather than guessing. Both are
-- settled here, and both are tunable numbers rather than architecture:
--
--   * CLAMP BOUNDS: 40% to 250% of each component's default weight. The
--     ticket's own worked example, adopted as the real value. Stated once,
--     in feed_weights_resolve, as v_lo/v_hi.
--   * RECOMPUTATION CADENCE: WEEKLY. It matches the cadence this schema
--     already runs its other periodic recomputations on - consistency
--     streaks are a week-shaped question (202608290015) and recap_weekly is
--     literally weekly (202608290011) - so the module has one periodic
--     rhythm rather than three. It is a SCHEDULED-JOB PARAMETER, not a hard
--     architectural constraint: nothing in this migration encodes it except
--     the cron line commented on recompute_feed_weights() below, and moving
--     it to daily or fortnightly is an edit to that one scheduler entry with
--     no schema change behind it.

-- ===========================================================================
-- member_feed_weights (COMM-303)
-- ===========================================================================
-- One row per member, generated server-side, holding how that member's feed
-- weights differ from the club default. The member may read their own; nobody
-- with a client key writes it at all.
--
-- WHY THE STORED SHAPE IS MULTIPLIERS, NOT ABSOLUTE WEIGHTS.
-- `weights` is a flat object of component key -> multiplier relative to that
-- component's default, where 1.0 means "exactly the default":
--
--     {"recency": 0.8, "relationship": 1.4, "class": 2.1}
--
-- Absolute weights were the obvious alternative and are worse for one
-- concrete reason: the default block has already been retuned twice in this
-- module's short life (202608310002 and 202608310003 both re-created it), and
-- with absolute weights every stored row silently becomes wrong the next time
-- a default moves, with no way to tell a stale row from a deliberate one.
-- With multipliers a retune of a default carries every member's
-- personalization along with it, which is what "personalization on top of the
-- same defaults, not a second scoring engine" means. It also makes the
-- no-signal case literally the identity: all-1.0 is the default set exactly,
-- so an empty object is not a special case that needs its own branch, it is
-- just the point where every multiplier happens to be 1.
--
-- A KEY MAY BE ABSENT and means 1.0. The recomputation job is expected to
-- write only the components it actually has evidence about, so a member with
-- a clear signal on coach content and nothing else is one key, not eight.
-- Unknown keys are ignored by the reader rather than rejected here, so a
-- later ticket that adds a ninth component can start writing its key before
-- feed_page learns to read it.
--
-- '{}' IS THE THIN-SIGNAL ANSWER and is deliberately not distinguished from
-- having no row at all. COMM-303 requires that "a member who never engages
-- enough to produce a signal keeps the fixed defaults, this ticket never
-- produces a personalized weight set from zero data". Both spellings of that
-- - no row, and a row whose object is empty - resolve to the defaults by the
-- same early return in feed_weights_resolve, so a recomputation job that
-- prefers to record "I looked at this member on Monday and found nothing"
-- can write a row with a computed_at and an empty object without that row
-- meaning anything different for the feed.
--
-- NO club_id, unlike weekly_recaps. COMM-303's migration outline names three
-- columns and this is three columns. The row is not a club-scoped record of
-- anything that happened; it is a private ranking artifact about one member,
-- read by exactly one function on behalf of exactly that member. Nothing
-- aggregates it per club, so a club_id would be a column that only ever
-- needed maintaining. (It also means this table needs no default_club_id()
-- grant, which is the one thing 202608290011 had to add for its own
-- service-role writer.)
create table if not exists public.member_feed_weights (
  user_id uuid primary key references public.profiles(id) on delete cascade,

  -- The CHECK is one line of insurance on the one column a service-role
  -- writer can put anything in. feed_weights_resolve defends against a
  -- non-object anyway (it has to - it also has to survive a row written
  -- before this constraint existed), but a table that can hold `[1,2,3]` or
  -- `"hello"` in a column every reader treats as an object is a table that
  -- will eventually hold one.
  weights jsonb not null default '{}'::jsonb
    constraint member_feed_weights_object check (jsonb_typeof(weights) = 'object'),

  computed_at timestamptz not null default now()
);

alter table public.member_feed_weights enable row level security;

revoke all on public.member_feed_weights from public, anon;
grant select on public.member_feed_weights to authenticated;

-- Own-row read, and that is the entire client surface. There is no insert,
-- update or delete grant and no policy for any of the three, not even for the
-- member who owns the row - the same shape weekly_recaps (202608290011) and
-- notification_batches (202608280018) use, and for a sharper reason than
-- either. A member who could write here could hand themselves a 2.5x
-- multiplier on every component they like and a 0.4x on the rest, which is a
-- client-supplied ranking input: precisely what COMM-303's own contract
-- section refuses when it says the weights are "never passed as a parameter".
-- The read is granted because there is nothing private in a member's own
-- weights and a support conversation about "why is my feed like this" is
-- easier when the answer is inspectable.
create policy member_feed_weights_self_select on public.member_feed_weights
  for select to authenticated
  using (user_id = auth.uid());

comment on table public.member_feed_weights is
  'COMM-303. Per-member feed ranking weights, as multipliers relative to feed_page''s default weight block (1.0 = the default, key absent = 1.0, empty object = no personalization). Own-row select for authenticated; NO insert, update or delete grant or policy for any client role - only a service_role writer, the weekly recomputation. Read by public.feed_weights_resolve() on behalf of public.feed_page(). NOTHING WRITES THIS TABLE YET: the derivation from feed_interactions history is not built by COMM-303, so every member currently has no row and therefore the fixed defaults.';

comment on column public.member_feed_weights.weights is
  'Component key -> multiplier relative to that component''s default weight. Keys feed_page reads: recency, relationship, coach, achievement, challenge, engagement, personal, class. Absent key means 1.0; unknown keys are ignored by the reader, not rejected; values are clamped to 0.40..2.50 and then rescaled so the set sums to the defaults'' own total. See public.feed_weights_resolve().';

comment on column public.member_feed_weights.computed_at is
  'When the recomputation job last derived this row. Not read by feed_page - it exists so a job can find stale rows and so "we looked and found no signal" (an empty weights object with a recent computed_at) is distinguishable from "never looked" for the job, though not for the feed, which treats both as the defaults.';

-- ===========================================================================
-- feed_weights_resolve  (COMM-303)
-- ===========================================================================
-- "What weights should this member's feed actually use", as a jsonb object
-- with the same keys as the defaults it was handed. The one copy of the
-- redistribution arithmetic.
--
-- WHY IT EXISTS AT ALL, given COMM-303's outline named only the table, the
-- feed_page re-creation and the recompute job. Same reason COMM-302 added
-- classmate_day_counts() beyond its own outline: the alternative is a
-- forty-line procedural block inlined in feed_page where nothing can assert
-- anything about it. The invariants below - sums to the default total, every
-- component inside its bounds, degrades to the defaults rather than to a
-- distorted feed - are the whole substance of this ticket, and they are only
-- checkable from a pgTAP file if they have a callable name. 0042 asserts them
-- directly against pathological stored rows that no fixture feed could
-- produce.
--
-- WHY IT TAKES THE DEFAULTS AS A PARAMETER rather than holding them.
-- The numbers stay stated exactly once, in feed_page's weight block, which is
-- what that block's own comment has promised since 202608280019 ("This block
-- is the only place any of them appear"). A helper with its own copy of the
-- eight defaults would be a second place, and the module already knows what
-- two copies cost - community_profile's inline streak versus
-- consistency_week_streaks() needs a standing assertion to stop it drifting.
-- So this function owns the ALGORITHM and feed_page owns the NUMBERS, and
-- there is no pair to drift. It also means the function is componentwise
-- agnostic: it never mentions `recency` or `class` by name, so adding a ninth
-- component to feed_page needs no edit here.
--
-- =========================================================================
-- THE ALGORITHM, AND WHY THE SUM IS GUARANTEED
-- =========================================================================
-- Let d_i be the default weights, D = sum(d_i), and m_i the stored multiplier
-- for component i (1.0 where absent). LO = 0.40, HI = 2.50.
--
-- The naive reading of "clamp each component to 40%..250%" - take w_i = d_i *
-- clamp(m_i) and use it - does NOT sum to D. Boosting one component would
-- inflate the whole score, which COMM-303 explicitly rules out ("redistributes
-- emphasis rather than inflating the whole score"). So a rescale is needed.
-- But a plain rescale is not enough either: scaling every clamped target by
-- D/sum(targets) restores the sum and can push a component back outside the
-- bounds it was just clamped into. Worked example on this module's real
-- numbers: m = {recency: 2.5, everything else: 0.4} gives sum(targets) = 128,
-- scale = 110/128 = 0.859, and the seven un-boosted components land at
-- 0.344x their default - below the 0.40 floor the clamp was there to hold.
-- Clamp-then-rescale and rescale-then-clamp each break the other's invariant.
--
-- What runs below is the standard bounded proportional rescale (water
-- filling), which satisfies both exactly:
--
--   1. Clamp the raw stored multipliers into [LO, HI]. Anything missing,
--      null, or not a json number is 1.0.
--   2. Repeat, at most once per component: scale every not-yet-pinned
--      component by (remaining budget / sum of its unscaled targets). Any
--      component whose scaled multiplier leaves [LO, HI] is PINNED at that
--      bound, its weight is subtracted from the remaining budget, and the
--      next pass redistributes what is left over the components still free.
--   3. When a pass pins nothing, the free components take their scaled
--      values and the loop ends.
--
-- The sum is then D by construction and not by luck:
--     sum(all) = sum(pinned) + sum(free)
--              = (D - budget) + budget * (sum_free d_i m_i / sum_free d_i m_i)
--              = D
-- and every component is in bounds by construction too - a pinned one sits
-- exactly on a bound, a free one survived the test that pins.
--
-- Termination: each pass either pins at least one component or exits, so at
-- most n passes. A solution always exists - m_i == 1 for all i is feasible,
-- and the total sum(d_i * clamp(m_i * s)) is continuous and non-decreasing in
-- s from LO*D up to HI*D, which brackets D because LO < 1 < HI.
--
-- =========================================================================
-- AND THEN IT IS VERIFIED ANYWAY, BEFORE IT IS USED
-- =========================================================================
-- The proof above is about the algorithm. The guarantee this function
-- actually makes is about the OUTPUT: the resolved set is summed and
-- bounds-checked before it is returned, and any failure returns the defaults
-- unchanged. So the worst a wrong multiplier, a wrong future edit to this
-- loop, or a service-role writer having a bad day can do to a member's feed
-- is give them the same feed everybody else gets. That is a stronger claim
-- than "the algorithm is correct", it is the claim a reviewer can check in
-- ten lines, and it is the one 0042 asserts. The tolerance is 1e-9, which is
-- nine orders of magnitude above the ~1e-19 rounding a single numeric
-- division introduces and far below any difference a person could see.
--
-- WHY IT RETURNS THE DEFAULTS *OBJECT*, NOT A RECOMPUTED COPY, when there is
-- no personalization. The most important acceptance criterion in COMM-303 is
-- that a member with no stored weights gets EXACTLY today's feed order. The
-- early returns below hand back p_defaults itself - the same jsonb value
-- feed_page passed in - so in the overwhelmingly common case (which is, today,
-- every member) there is no arithmetic to be byte-identical to: none runs.
--
-- SECURITY INVOKER with no grant to any role - the shape relationship_score()
-- (202608310002) and classmate_day_counts() (202608310003) both use. Called
-- from feed_page, which is SECURITY DEFINER and owned by the migration owner,
-- it runs with that owner's rights and so reads member_feed_weights past
-- member_feed_weights_self_select. Called from anywhere a client can reach, it
-- cannot be called at all. Note that this is the one internal helper here that
-- takes a p_user: unlike classmate_day_counts(), it consults no privacy toggle
-- that would silently ignore the parameter, so there is no trap in honouring
-- it - and no client can pass one anyway.
create or replace function public.feed_weights_resolve(
  p_user uuid,
  p_defaults jsonb
) returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  -- COMM-303's clamp bounds. 40% and 250% of a component's default weight,
  -- the ticket's own worked example adopted as the real value. Stated once,
  -- here, for every component: personalization may shift emphasis but may
  -- never zero out a component or let one dominate, so the feed stays
  -- recognisably the same ranking system for every member.
  v_lo  constant numeric := 0.40;
  v_hi  constant numeric := 2.50;
  -- The verification tolerance. See the header.
  v_eps constant numeric := 0.000000001;

  v_stored  jsonb;
  v_keys    text[];
  v_d       numeric[];
  v_m       numeric[];
  v_w       numeric[];
  v_pinned  boolean[];
  v_raw     jsonb;
  v_out     jsonb;
  v_n       integer;
  v_i       integer;
  v_pass    integer;
  v_total   numeric := 0;
  v_budget  numeric;
  v_base    numeric;
  v_scale   numeric;
  v_free_n  integer;
  v_moved   boolean := false;
  v_any     boolean;
  v_sum     numeric := 0;
begin
  -- Nothing to resolve without a member or without a default set to resolve
  -- against. Returns p_defaults rather than raising: this is a helper on a
  -- read path, and its one caller has already refused a null uid itself.
  if p_user is null or p_defaults is null or jsonb_typeof(p_defaults) <> 'object' then
    return p_defaults;
  end if;

  select w.weights into v_stored
  from public.member_feed_weights w
  where w.user_id = p_user;

  -- THE FALLBACK, and it is first because it is the only path that runs
  -- today. No row, an empty object, or a value that is not an object at all
  -- returns the defaults untouched and unexamined.
  if v_stored is null
     or jsonb_typeof(v_stored) <> 'object'
     or v_stored = '{}'::jsonb then
    return p_defaults;
  end if;

  -- The default set, as parallel arrays in key order. Every default must be a
  -- positive json number for a multiplier to mean anything; if the caller
  -- hands over anything else, it gets its own object straight back.
  select array_agg(e.key order by e.key),
         array_agg((e.value #>> '{}')::numeric order by e.key)
    into v_keys, v_d
  from jsonb_each(p_defaults) e
  where jsonb_typeof(e.value) = 'number' and (e.value #>> '{}')::numeric > 0;

  v_n := coalesce(array_length(v_keys, 1), 0);
  if v_n = 0 or v_n <> (select count(*) from jsonb_each(p_defaults)) then
    return p_defaults;
  end if;

  -- The stored multipliers, clamped. An absent key, a json null, a string, an
  -- object, or a key feed_page does not know about is 1.0 - never an error,
  -- because a malformed row must cost a member their personalization and not
  -- their feed.
  v_m := array_fill(1.0::numeric, array[v_n]);
  for v_i in 1 .. v_n loop
    v_raw := v_stored -> v_keys[v_i];
    if v_raw is not null and jsonb_typeof(v_raw) = 'number' then
      v_m[v_i] := least(v_hi, greatest(v_lo, (v_raw #>> '{}')::numeric));
      if v_m[v_i] <> 1.0 then v_moved := true; end if;
    end if;
    v_total := v_total + v_d[v_i];
  end loop;

  -- A row that says nothing - every key absent, unreadable, or exactly 1.0 -
  -- is the same answer as no row. Short-circuited so it takes the same path,
  -- and so a uniform multiplier can never arrive at the rescale below (where
  -- it would correctly cancel to the defaults anyway, but through arithmetic
  -- rather than through this identity).
  if not v_moved or v_total <= 0 then
    return p_defaults;
  end if;

  -- --- the bounded proportional rescale ------------------------------------
  v_pinned := array_fill(false, array[v_n]);
  v_w      := array_fill(0::numeric, array[v_n]);
  v_budget := v_total;

  for v_pass in 1 .. v_n loop
    v_base := 0;
    v_free_n := 0;
    for v_i in 1 .. v_n loop
      if not v_pinned[v_i] then
        v_base := v_base + v_d[v_i] * v_m[v_i];
        v_free_n := v_free_n + 1;
      end if;
    end loop;
    -- No free component left to absorb the budget. Cannot happen for a
    -- feasible input; if it ever does, the verification below catches it and
    -- the member gets the defaults.
    exit when v_free_n = 0 or v_base <= 0;

    v_scale := v_budget / v_base;

    v_any := false;
    for v_i in 1 .. v_n loop
      if not v_pinned[v_i] then
        if v_m[v_i] * v_scale > v_hi then
          v_pinned[v_i] := true;
          v_w[v_i] := v_d[v_i] * v_hi;
          v_budget := v_budget - v_w[v_i];
          v_any := true;
        elsif v_m[v_i] * v_scale < v_lo then
          v_pinned[v_i] := true;
          v_w[v_i] := v_d[v_i] * v_lo;
          v_budget := v_budget - v_w[v_i];
          v_any := true;
        end if;
      end if;
    end loop;

    -- A pass that pinned nothing is the answer: every free component's
    -- scaled multiplier is inside the bounds, and the free set absorbs
    -- exactly the remaining budget.
    if not v_any then
      for v_i in 1 .. v_n loop
        if not v_pinned[v_i] then
          v_w[v_i] := v_d[v_i] * v_m[v_i] * v_scale;
        end if;
      end loop;
      exit;
    end if;
  end loop;

  -- --- verify, then and only then return it --------------------------------
  for v_i in 1 .. v_n loop
    if v_w[v_i] is null
       or v_w[v_i] < v_d[v_i] * v_lo - v_eps
       or v_w[v_i] > v_d[v_i] * v_hi + v_eps then
      return p_defaults;
    end if;
    v_sum := v_sum + v_w[v_i];
  end loop;
  if abs(v_sum - v_total) > v_eps then
    return p_defaults;
  end if;

  v_out := '{}'::jsonb;
  for v_i in 1 .. v_n loop
    v_out := v_out || jsonb_build_object(v_keys[v_i], v_w[v_i]);
  end loop;
  return v_out;
end $$;

revoke all on function public.feed_weights_resolve(uuid, jsonb)
  from public, anon, authenticated;

comment on function public.feed_weights_resolve(uuid, jsonb) is
  'Internal. COMM-303. Resolves p_user''s personalized feed weights on top of the p_defaults object handed in, returning an object with the same keys. Reads public.member_feed_weights; no row, an empty object, a non-object, or a set of multipliers that are all 1.0 returns p_defaults itself, unexamined, so an unpersonalized member''s feed does no extra arithmetic and scores exactly as before. Otherwise each stored multiplier is clamped to 0.40..2.50 of its default and the set is redistributed by bounded proportional rescale so that it sums to EXACTLY the sum of p_defaults - personalization moves emphasis between components, it never inflates the total. The result is summed and bounds-checked before it is returned and ANY violation returns p_defaults unchanged, so a bad stored row costs a member their personalization and never their feed. Component-agnostic: it names no component, so a ninth weight needs no edit here. No grants: only definer functions that have already resolved auth.uid() call it. Nothing writes member_feed_weights yet - see public.recompute_feed_weights().';

-- ===========================================================================
-- recompute_feed_weights  (COMM-303) - A DELIBERATE NO-OP STUB
-- ===========================================================================
-- COMM-303's migration outline names "a recompute_feed_weights() service role
-- function or scheduled job, not client-reachable, mirroring
-- notif_batch_flush_due's auth shape", and the ticket's own validation rules
-- put the derivation itself out of scope ("same 'infra not built here' shape
-- as the notification batch flusher and recap_weekly's own cron gap").
--
-- IT IS SHIPPED, AND IT DOES NOTHING. That is the deliberate choice, over the
-- two alternatives:
--   * Omitting it would leave feed_page reading a table with no named writer
--     at all, and the next reader of this schema would have to work out from
--     the grants alone whether one was ever intended.
--   * Guessing the derivation - "engaged with coach posts more than the club
--     average, so multiply coach by 1.3" - would ship an unreviewed heuristic
--     straight into ranking for every member. COMM-303 does not specify one,
--     the club-average baseline it would need is not defined anywhere, and a
--     wrong one is invisible: nobody can see that their feed is subtly wrong.
-- So the signature, the grants, the return convention and the auth boundary
-- are all pinned now, by 0042, and the body is the only thing a later ticket
-- writes. A no-op that writes no row cannot distort anybody's feed, which is
-- not true of any placeholder that writes one.
--
-- RETURNS the number of member rows written, the same "rows written" integer
-- convention notif_batch_flush_due() returns. Today that is always 0, and a
-- scheduler wiring this up early gets a harmless no-op rather than an error.
-- p_limit is the batch bound the real body will honour, mirroring
-- notif_batch_flush_due(p_limit); it is accepted and unused today, on purpose,
-- so the call site a scheduler writes now does not change when the body lands.
--
-- SCHEDULER: nothing is scheduled here, for the reason 202608280028 gives at
-- length - pg_cron is not guaranteed present in the CI Supabase stack, and
-- scheduling is infra rather than schema. Wire it up as EITHER:
--   - a pg_cron entry once the extension is enabled on the project. The
--     cadence resolved for COMM-303 is WEEKLY, and this is the single place
--     that cadence is expressed:
--       select cron.schedule('feed-weights-recompute', '17 4 * * 1',
--         $$select public.recompute_feed_weights()$$);
--     (Monday 04:17 UTC - off the hour, and the same day of the week
--      recap_weekly's own job runs on, so the module has one weekly rhythm.)
--   - or a Supabase Edge Function on a weekly schedule calling it with the
--     service role.
-- Changing the cadence is an edit to that one line. Nothing in the schema,
-- in member_feed_weights, or in feed_weights_resolve depends on it.
--
-- SECURITY DEFINER with grants as the only gate and NO auth.uid() check, the
-- same documented exception notif_batch_flush_due(), notif_queue_batched(),
-- seed_onboarding_progress() and post_new_member_on_join() already carry:
-- service_role has no auth.uid() to check, and the execute grant is what
-- stands in for one. Definer rather than invoker so that the boundary the
-- real body will cross - reading every member's feed_interactions, which is
-- self-select only - is the boundary 0042 pins today, before there is a body
-- to move it.
--
-- TODO (a later ticket, not COMM-303): the derivation. It has to read the
-- caller-agnostic history in feed_interactions (COMM-114) per member, compare
-- each member's engagement rate per component against the club's own average
-- rather than against an absolute threshold, refuse to emit anything for a
-- member below a minimum interaction count (COMM-303: "never produces a
-- personalized weight set from zero data" - an empty weights object with a
-- fresh computed_at is the right way to record having looked), and upsert one
-- row per member keyed on user_id. It does NOT need to clamp or normalise
-- what it writes: feed_weights_resolve does both on every read, so a job that
-- writes an out-of-range multiplier produces a clamped feed, never a broken
-- one.
create or replace function public.recompute_feed_weights(p_limit integer default 500)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_written integer := 0;
begin
  -- Intentionally empty. See the header above. Writing nothing is the
  -- behaviour, not an unfinished edit: every member therefore has no
  -- member_feed_weights row and feed_page falls back to its fixed defaults.
  return v_written;
end $$;

revoke all on function public.recompute_feed_weights(integer)
  from public, anon, authenticated;
grant execute on function public.recompute_feed_weights(integer) to service_role;

comment on function public.recompute_feed_weights(integer) is
  'COMM-303. service_role only; revoked from public, anon and authenticated. A DELIBERATE NO-OP STUB: it writes no member_feed_weights row and always returns 0. The signature, grants and auth boundary are shipped so a later ticket writes only the body; the derivation from feed_interactions history (per-member engagement per component against the club average, with a minimum-signal floor) is explicitly out of COMM-303''s scope. Returns the number of member rows written, the same convention notif_batch_flush_due() uses. p_limit is the batch bound the real body will honour and is accepted and unused today. Nothing schedules it: the resolved cadence is WEEKLY and lives in the commented cron line in 202608310006, which is the only place it is expressed. security definer with the execute grant as the only gate and no auth.uid() check - the same documented exception notif_batch_flush_due() carries, since service_role has no uid.';

-- ===========================================================================
-- feed_page, re-created. COMM-110/111/112/113, personalized by COMM-303.
-- ===========================================================================
-- Identical to 202608310003 apart from three hunks, all of them about where
-- the eight weights come from and none of them about what is done with them:
--   * the declare block: the eight v_w_* weights lose the word `constant`
--     and keep their values, character for character. Their comment block
--     gains COMM-303's note and loses the stale "104" (see the top of this
--     file). One new variable, v_w_defaults jsonb, joins them.
--   * one new section in the body, immediately after the handle lookup and
--     before the cursor is decoded: the defaults are packed into a jsonb
--     object, handed to feed_weights_resolve(), and unpacked back into the
--     same eight variables.
--   * nothing else. The scoring expression is the previous file's text
--     UNCHANGED - it still reads v_w_recency, v_w_relationship, v_w_coach,
--     v_w_achievement, v_w_challenge, v_w_engagement, v_w_personal and
--     v_w_class, in the same order, with the same components and the same
--     normalisation. So do the candidate filters, the repetition penalty, the
--     cursor, the row projection and the diversity pass.
--
-- WHY THE DIVERSITY PASS IS UNTOUCHED, stated because COMM-303 asks for it
-- explicitly: feed_diversity (COMM-112) runs where it always ran, after the
-- scoring query has produced v_page and against exactly the rows that query
-- returned. Personalization changes the SCORE and therefore which rows reach
-- the page and in what score order; it does not change, reorder, or bypass a
-- single one of the run limits applied afterwards. The four diversity
-- constants are in their own block and no line of this migration touches
-- them. A member who has boosted every component to the ceiling still cannot
-- get three consecutive posts from one author.
--
-- WHY THE UNPACK IS UNCONDITIONAL, rather than "if there is a row, override".
-- With no stored row feed_weights_resolve returns the object it was handed,
-- so the unpack reads each weight straight back out of the object the line
-- above put it into. jsonb stores a json number as a PostgreSQL `numeric`,
-- not a float, and ->> renders it losslessly, so the round trip is exact and
-- not approximately exact - 40 comes back as 40. A branch would have bought
-- nothing and left a second, rarely-executed code path through the weight
-- block. The coalesce on each line is the belt to that braces: a resolver
-- that somehow returned an object missing a key leaves that weight at its
-- default rather than at null, which would otherwise make every score in the
-- page null.
--
-- WHAT THIS CHANGES FOR MEMBERS TODAY: nothing at all, and that is the
-- acceptance criterion rather than a caveat. member_feed_weights has no
-- writer yet, so every member takes the fallback path and scores on the same
-- eight numbers this function has used since 202608310003. 0042 pins that
-- against the same three fixture posts and the same three six-decimal-place
-- literals 0038 captured from the pre-COMM-301 function.
create or replace function public.feed_page(
  p_cursor text default null,
  p_limit integer default 20,
  p_scope text default 'for_you'
)
returns table (
  id uuid,
  post_type public.post_type,
  author_id uuid,
  author jsonb,
  body text,
  title text,
  result_text text,
  occurred_on date,
  visibility public.post_visibility,
  created_at timestamptz,
  published_at timestamptz,
  metadata jsonb,
  media jsonb,
  reaction_count integer,
  comment_count integer,
  feed_score numeric,
  next_cursor text
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  -- =========================================================================
  -- SCORING WEIGHTS. This block is the only place any of them appear.
  -- Every component is normalised to 0..1 first and then multiplied by its
  -- weight here, so a weight is directly comparable to every other weight
  -- and tuning one is a one-line change with no other arithmetic to redo.
  -- The positive weights sum to 110. Nothing depends on that number, it is
  -- only there so they read as rough percentages.
  --
  -- IT SAID 104 UNTIL NOW, and that had been wrong since 202608310003. The
  -- 104 was the seven live weights while v_w_class was declared at 6 and
  -- multiplied by a hard 0; COMM-302 turned that component on and left the
  -- comment behind. Corrected here rather than acted on: NO WEIGHT MOVES IN
  -- THIS MIGRATION. Renormalising the block back down to 104 would change
  -- every existing feed score on deploy day, which is the one thing COMM-303
  -- must not do.
  --
  -- COMM-303. These eight are no longer `constant`: they are the DEFAULTS,
  -- and the section marked "per-user weights" in the body below may replace
  -- each of them with this member's own resolved weight before the scoring
  -- query runs. What it may not do is change their total - a personalized
  -- set sums to exactly what this block sums to, so personalization moves
  -- emphasis between components and never inflates the score. That total is
  -- computed from these values at call time and is nowhere hardcoded, so the
  -- next retune of any weight here needs no second edit anywhere.
  -- =========================================================================
  v_w_recency        numeric := 40;  -- how fresh the post is
  v_w_relationship   numeric := 18;  -- who the author is to the viewer
  v_w_coach          numeric := 10;  -- coach voice carries further
  v_w_achievement    numeric := 8;   -- PRs, achievements, milestones
  v_w_challenge      numeric := 6;   -- challenge and event content
  v_w_engagement     numeric := 10;  -- what the club already did with it
  v_w_personal       numeric := 12;  -- it is about, or involves, the viewer
  -- COMM-302, closing COMM-P01. This weight was reserved and multiplied by a
  -- hard 0 from 202608280019 until now, so that wiring an attendance source
  -- would be a value change here and nothing else. It is: the value now comes
  -- from public.classmate_day_counts(), normalised below. The weight itself
  -- has not moved. COMM-303 personalizes it exactly like the other seven -
  -- it is not special-cased as immovable, so a member who trains with the
  -- same people every week can have the class component carry more of their
  -- ranking than the club default gives it.
  v_w_class          numeric := 6;   -- the viewer and the author train together

  -- COMM-303. The defaults above, packed for feed_weights_resolve(). Built
  -- in the body from the eight variables themselves, so this is not a second
  -- copy of the numbers.
  v_w_defaults jsonb;
  v_weights    jsonb;

  -- Component shaping constants. Same block, same reason.
  -- Recency is an exponential half-life, not a cliff: 36 hours means
  -- yesterday's post is worth half of this morning's and a week-old post
  -- about 1.5% of it.
  v_recency_half_life_hours constant numeric := 36;
  -- COMM-301: the relationship component's own constants (mutual, follow,
  -- interaction, window) moved into public.relationship_score(), which is
  -- called below with v_anchor so the 30-day interaction window is measured
  -- from the same frozen session anchor as every other term. Only its weight
  -- is still stated here.
  -- Coach: an explicitly coach-voiced post is the full component, anything
  -- else written by a member at coach rank or above is half of it.
  v_coach_post       constant numeric := 1.0;
  v_coach_author     constant numeric := 0.5;
  -- Engagement is CAPPED. A comment is worth two reactions because it costs
  -- more to leave, and the whole term saturates, so a post that goes loud
  -- cannot outrank a week of everything else on volume alone.
  v_comment_weight   constant numeric := 2.0;
  v_engagement_saturation constant numeric := 12.0;
  -- COMM-302. The class component SATURATES, on the same reasoning and in
  -- the same shape as engagement above: eight days trained alongside this
  -- author inside classmate_day_counts()' 60-day window is the full
  -- component, and more does not buy more. Eight is roughly twice a week for
  -- a month - a real training partnership rather than a coincidence - and
  -- past that the answer to "do these two train together" stops changing.
  -- Scaling by the window length instead would make even a daily training
  -- partner worth a fraction of a point.
  v_class_saturation constant numeric := 8.0;
  -- Personal relevance: each signal adds, the sum is capped at 1.
  v_pers_mention     constant numeric := 1.0;  -- the body names the viewer
  v_pers_reply       constant numeric := 0.8;  -- someone replied to the viewer here
  v_pers_thread      constant numeric := 0.5;  -- the viewer is in this thread
  v_pers_participant constant numeric := 0.6;  -- viewer is in the linked challenge or event
  -- Repetition penalty: the Nth post by one member inside the window costs
  -- (N-1) steps, capped, so a member emptying their training log does not
  -- take the whole page. Subtracted from the total, never applied to an
  -- authorless system post.
  v_repetition_window_hours constant numeric := 24;
  v_repetition_step  constant numeric := 6;
  v_repetition_max   constant numeric := 18;

  -- =========================================================================
  -- DIVERSITY LIMITS (COMM-112). Also one place, also tunable.
  -- =========================================================================
  v_max_same_author  constant integer := 2;  -- consecutive posts by one member
  v_max_system_run   constant integer := 2;  -- consecutive system-generated posts
  v_max_workout_run  constant integer := 3;  -- consecutive workout cards
  -- After a run of this many workout cards the next slot prefers an
  -- achievement, coach, challenge or event card, when the page holds one.
  v_prefer_after_workouts constant integer := 2;

  -- How far back a page may reach and how many rows one session may rank.
  -- The cap is what keeps the scoring pass bounded; past it the feed ends
  -- with the caught-up marker rather than scanning the whole table.
  v_window_days      constant integer := 90;
  v_candidate_cap    constant integer := 600;

  v_uid uuid;
  v_handle text;
  v_limit integer;
  v_scope text;
  v_anchor timestamptz;
  v_cur_score numeric;
  v_cur_pub timestamptz;
  v_cur_id uuid;
  v_tail jsonb := '[]'::jsonb;
  v_tail_out jsonb := '[]'::jsonb;
  v_token jsonb;
  v_page jsonb := '[]'::jsonb;
  v_last jsonb;
  v_next text;

  -- diversity working set
  v_cand_id uuid[];
  v_cand_author uuid[];
  v_cand_kind text[];
  v_cand_score numeric[];
  v_used boolean[];
  v_ids uuid[] := array[]::uuid[];
  v_out_author uuid[] := array[]::uuid[];
  v_out_kind text[] := array[]::text[];
  v_out_score numeric[] := array[]::numeric[];
  v_n integer;
  v_slot integer;
  v_i integer;
  v_pick integer;
  v_run_author uuid;
  v_run_author_n integer := 0;
  v_run_system_n integer := 0;
  v_run_workout_n integer := 0;
  v_prefer boolean;
  v_e jsonb;
  v_a uuid;
  v_k text;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  v_limit := least(greatest(coalesce(p_limit, 20), 1), 40);
  v_scope := lower(coalesce(p_scope, 'for_you'));
  -- COMM-111: an unknown scope falls back to for_you rather than raising, so
  -- an old client that has not learned a scope name still gets a feed.
  if v_scope not in ('for_you', 'following', 'achievements', 'coach', 'my_classes') then
    v_scope := 'for_you';
  end if;
  -- my_classes STAYS PARKED, deliberately, even though COMM-300 gave the
  -- module an attendance source and this migration wires it into the ranking
  -- above. A class-connection SCORE and a my-classes SCOPE are two different
  -- questions: the score asks "how much do these two members train
  -- together", which shared attendance days answer, and the scope asks
  -- "which posts belong to a class I attend", which they do not -
  -- attendance_log records days, not classes, and carries no class identity
  -- to filter a post by. Unparking the chip needs a source that has one, plus
  -- the client change to enable it, and neither is COMM-302. So this still
  -- answers empty rather than quietly answering something else, and the
  -- client still renders that chip disabled.
  if v_scope = 'my_classes' then
    return;
  end if;

  select p.handle into v_handle from public.profiles p where p.id = v_uid;

  -- --- per-user weights (COMM-303) ---------------------------------------
  -- The eight defaults out, this member's eight resolved weights back. For a
  -- member with no member_feed_weights row - which is every member today,
  -- since nothing writes that table yet - feed_weights_resolve returns the
  -- object it was handed, so the unpack below reads each weight straight back
  -- out of the object the line above put it into and every score in this page
  -- is the one 202608310003 would have produced.
  --
  -- Placed HERE, after the auth check and after the parked my_classes scope
  -- has already returned, and before anything is scored: one lookup per feed
  -- request, never one per candidate row or one per page of a session. The
  -- weights are then fixed for the whole call, exactly like v_anchor, so
  -- diversity, the repetition penalty and the cursor all see one weight set.
  --
  -- This function is definer, so this reads past member_feed_weights_self_select
  -- - but only ever for v_uid, which is the one row that policy would have
  -- granted the caller anyway.
  v_w_defaults := jsonb_build_object(
    'recency',      v_w_recency,
    'relationship', v_w_relationship,
    'coach',        v_w_coach,
    'achievement',  v_w_achievement,
    'challenge',    v_w_challenge,
    'engagement',   v_w_engagement,
    'personal',     v_w_personal,
    'class',        v_w_class);
  v_weights := coalesce(public.feed_weights_resolve(v_uid, v_w_defaults), v_w_defaults);
  if jsonb_typeof(v_weights) <> 'object' then v_weights := v_w_defaults; end if;

  -- Each coalesce leaves that weight at its default if the key is missing,
  -- so a short object costs a component its personalization rather than
  -- turning every score on the page null.
  v_w_recency      := coalesce((v_weights ->> 'recency')::numeric,      v_w_recency);
  v_w_relationship := coalesce((v_weights ->> 'relationship')::numeric, v_w_relationship);
  v_w_coach        := coalesce((v_weights ->> 'coach')::numeric,        v_w_coach);
  v_w_achievement  := coalesce((v_weights ->> 'achievement')::numeric,  v_w_achievement);
  v_w_challenge    := coalesce((v_weights ->> 'challenge')::numeric,    v_w_challenge);
  v_w_engagement   := coalesce((v_weights ->> 'engagement')::numeric,   v_w_engagement);
  v_w_personal     := coalesce((v_weights ->> 'personal')::numeric,     v_w_personal);
  v_w_class        := coalesce((v_weights ->> 'class')::numeric,        v_w_class);

  -- --- cursor ------------------------------------------------------------
  -- Opaque on the wire: base64 of a small json object. A null, malformed or
  -- stale token restarts from the top instead of raising, because holding a
  -- stale cursor is a normal thing for a client to do.
  v_anchor := now();
  if p_cursor is not null and length(p_cursor) between 8 and 4000 then
    begin
      v_token := convert_from(decode(p_cursor, 'base64'), 'utf8')::jsonb;
      v_anchor := (v_token ->> 'a')::timestamptz;
      v_cur_score := (v_token ->> 's')::numeric;
      v_cur_pub := (v_token ->> 't')::timestamptz;
      v_cur_id := (v_token ->> 'i')::uuid;
      v_tail := coalesce(v_token -> 'p', '[]'::jsonb);
    exception when others then
      v_anchor := null; v_cur_score := null; v_cur_pub := null; v_cur_id := null;
      v_tail := '[]'::jsonb;
    end;
  end if;
  if v_anchor is null then v_anchor := now(); end if;
  -- A half-decoded token is treated as no token at all: a partial keyset
  -- would compare to null and silently return an empty page forever.
  if v_cur_score is null or v_cur_pub is null or v_cur_id is null then
    v_cur_score := null; v_cur_pub := null; v_cur_id := null;
  end if;

  -- --- score, then cut the page on the keyset ----------------------------
  select coalesce(
    jsonb_agg(jsonb_build_object('id', s.pid, 'a', s.aid, 'k', s.kind, 's', s.total, 't', s.pub)
              order by s.total desc, s.pub desc, s.pid desc),
    '[]'::jsonb)
  into v_page
  from (
    select sc.pid, sc.aid, sc.kind, sc.pub, sc.total
    from (
      with cand as (
        select p.id as pid,
               p.author_id as aid,
               p.post_type as ptype,
               p.published_at as pub,
               p.body as pbody,
               ((extract(epoch from (v_anchor - p.published_at)) / 3600.0))::numeric as age_hours,
               -- The three diversity classes plus a neutral one. An
               -- announcement is coach voice, not a system notice, so it is
               -- deliberately not counted against the system run.
               case
                 when p.post_type in ('POST_SYSTEM', 'POST_NEW_MEMBER') then 'system'
                 when p.post_type = 'POST_WORKOUT' then 'workout'
                 when p.post_type in (
                   'POST_ACHIEVEMENT', 'POST_PR', 'POST_ATTENDANCE_MILESTONE',
                   'POST_COACH', 'POST_ANNOUNCEMENT', 'POST_CHALLENGE', 'POST_EVENT'
                 ) then 'boost'
                 else 'other'
               end as kind,
               case when coalesce(p.metadata ->> 'challenge_id', '') ~ '^[0-9a-fA-F]{8}-'
                    then (p.metadata ->> 'challenge_id')::uuid else p.source_id end as challenge_ref,
               case when coalesce(p.metadata ->> 'event_id', '') ~ '^[0-9a-fA-F]{8}-'
                    then (p.metadata ->> 'event_id')::uuid else p.source_id end as event_ref
        from public.workout_posts p
        where p.deleted_at is null
          and p.status = 'active'
          and p.published_at <= v_anchor
          and p.published_at >= v_anchor - make_interval(days => v_window_days)
          -- COMM-108: a post the member muted never comes back.
          and not exists (
            select 1 from public.hidden_posts h where h.user_id = v_uid and h.post_id = p.id)
          -- Reporting a post hides it from the reporter immediately, which
          -- is what the client already promises when a report is filed.
          and not exists (
            select 1 from public.reports rp where rp.post_id = p.id and rp.reporter_id = v_uid)
          -- COMM-125 block edges, in either direction. post_visible_to_viewer
          -- checks the same thing; this is stated separately because "the
          -- feed excludes blocked authors" has to be readable as its own rule.
          -- It is also what makes a block strictly stronger than the class
          -- component COMM-302 added: a blocked author never reaches the
          -- scoring pass at all, whatever their overlap with the viewer.
          and not exists (
            select 1 from public.blocks b
            where (b.blocker_id = v_uid and b.blocked_id = p.author_id)
               or (b.blocker_id = p.author_id and b.blocked_id = v_uid))
          -- The one place that says what each visibility label means. This
          -- function is definer, so RLS is not doing the filtering here and
          -- this call is what stands in for it.
          and public.post_visible_to_viewer(p.id)
          -- COMM-111 scopes.
          and (v_scope <> 'following' or exists (
                select 1 from public.follows f
                where f.follower_id = v_uid and f.followed_id = p.author_id))
          and (v_scope <> 'achievements' or p.post_type in (
                'POST_PR', 'POST_ACHIEVEMENT', 'POST_ATTENDANCE_MILESTONE'))
          and (v_scope <> 'coach' or p.post_type in ('POST_COACH', 'POST_ANNOUNCEMENT'))
        order by p.published_at desc
        limit v_candidate_cap
      ),
      -- Relationship, class connection and author role depend on the author,
      -- not the post, so they resolve once per distinct author instead of
      -- once per row.
      authors as (
        select distinct c.aid as aid from cand c where c.aid is not null
      ),
      author_facts as (
        select a.aid as aid,
               -- COMM-301. Was an inline case/exists block here; identical
               -- arithmetic, same anchor, one copy.
               public.relationship_score(v_uid, a.aid, v_anchor) as rel_value,
               -- COMM-302. Was the constant 0. The helper is evaluated once
               -- for the whole page, not once per author, and it carries the
               -- show_attendance gate and the block check with it - an author
               -- who keeps their attendance private simply has no row here,
               -- so the coalesce below scores them 0.
               coalesce(cd.shared_days, 0) as class_days,
               (exists (select 1 from public.invite_redemptions ir
                        where ir.user_id = a.aid and public.role_rank(ir.role) >= 20)
                or exists (select 1 from public.profiles pf
                           where pf.id = a.aid and pf.is_admin and pf.deleted_at is null)
               ) as author_is_staff
        from authors a
        left join public.classmate_day_counts(v_anchor) cd on cd.user_id = a.aid
      ),
      counted as (
        select c.pid as pid,
               (select count(*) from public.reactions r where r.post_id = c.pid) as reactions,
               (select count(*) from public.post_comments pc
                where pc.post_id = c.pid and pc.deleted_at is null and pc.status = 'active') as comments
        from cand c
      ),
      -- The Nth post by one author inside the repetition window. Ordering
      -- the partition newest first means every post counted ahead of an
      -- in-window post is itself in the window, so a plain row_number is
      -- exact and no second window predicate is needed.
      repeated as (
        select c.pid as pid,
               case when c.aid is null or c.age_hours > v_repetition_window_hours then 0
                    else (row_number() over (partition by c.aid order by c.pub desc))::integer - 1
               end as rep_index
        from cand c
      )
      select c.pid, c.aid, c.kind, c.pub,
             round(
                 v_w_recency * power(0.5::numeric, c.age_hours / v_recency_half_life_hours)
               + v_w_relationship * coalesce(af.rel_value, 0)
               + v_w_coach * (case
                   when c.ptype in ('POST_COACH', 'POST_ANNOUNCEMENT') then v_coach_post
                   when coalesce(af.author_is_staff, false) then v_coach_author
                   else 0 end)
               + v_w_achievement * (case
                   when c.ptype in ('POST_PR', 'POST_ACHIEVEMENT', 'POST_ATTENDANCE_MILESTONE')
                   then 1 else 0 end)
               + v_w_challenge * (case
                   when c.ptype in ('POST_CHALLENGE', 'POST_EVENT') then 1 else 0 end)
               + v_w_engagement * least(1.0,
                   (cnt.comments * v_comment_weight + cnt.reactions) / v_engagement_saturation)
               + v_w_personal * least(1.0,
                   (case when v_handle is not null and v_handle <> ''
                          and position(lower('@' || v_handle) in lower(coalesce(c.pbody, ''))) > 0
                         then v_pers_mention else 0 end)
                   + (case when exists (
                         select 1 from public.post_comments rc
                         join public.post_comments pc on pc.id = rc.parent_comment_id
                         where rc.post_id = c.pid and rc.deleted_at is null and pc.author_id = v_uid)
                       then v_pers_reply else 0 end)
                   + (case when exists (
                         select 1 from public.post_comments pc
                         where pc.post_id = c.pid and pc.author_id = v_uid and pc.deleted_at is null)
                       then v_pers_thread else 0 end)
                   + (case when exists (
                         select 1 from public.challenge_participants chp
                         where chp.user_id = v_uid and chp.challenge_id = c.challenge_ref)
                       or exists (
                         select 1 from public.event_attendees ea
                         where ea.user_id = v_uid and ea.event_id = c.event_ref)
                       then v_pers_participant else 0 end))
               -- COMM-302, closing COMM-P01. Shared training days over a
               -- saturation constant, capped at 1 - the engagement term's
               -- shape - so this reaches the same 0..1 ceiling every other
               -- component does before v_w_class applies. No shared days is
               -- 0, not a missing term.
               + v_w_class * least(1.0, coalesce(af.class_days, 0) / v_class_saturation)
               - least(rep.rep_index * v_repetition_step, v_repetition_max)
             , 6) as total
      from cand c
      left join author_facts af on af.aid = c.aid
      join counted cnt on cnt.pid = c.pid
      join repeated rep on rep.pid = c.pid
    ) sc
    where v_cur_score is null
       or (sc.total, sc.pub, sc.pid) < (v_cur_score, v_cur_pub, v_cur_id)
    order by sc.total desc, sc.pub desc, sc.pid desc
    limit v_limit
  ) s;

  v_n := jsonb_array_length(v_page);
  if v_n = 0 then
    return;
  end if;

  -- --- diversity (COMM-112) ---------------------------------------------
  select array_agg((e ->> 'id')::uuid order by ord),
         array_agg(nullif(e ->> 'a', '')::uuid order by ord),
         array_agg(e ->> 'k' order by ord),
         array_agg((e ->> 's')::numeric order by ord)
  into v_cand_id, v_cand_author, v_cand_kind, v_cand_score
  from jsonb_array_elements(v_page) with ordinality t(e, ord);

  v_used := array_fill(false, array[v_n]);

  -- Seed the run counters from the tail of the previous page, so the limits
  -- hold across a page boundary and not only inside one page.
  begin
    for v_e in select value from jsonb_array_elements(v_tail) loop
      v_a := case when v_e ->> 'a' ~ '^[0-9a-fA-F]{8}-' then (v_e ->> 'a')::uuid else null end;
      v_k := coalesce(v_e ->> 'k', 'other');
      if v_a is not null and v_a = v_run_author then v_run_author_n := v_run_author_n + 1;
      else v_run_author := v_a; v_run_author_n := case when v_a is null then 0 else 1 end;
      end if;
      v_run_system_n := case when v_k = 'system' then v_run_system_n + 1 else 0 end;
      v_run_workout_n := case when v_k = 'workout' then v_run_workout_n + 1 else 0 end;
    end loop;
  exception when others then
    v_run_author := null; v_run_author_n := 0; v_run_system_n := 0; v_run_workout_n := 0;
  end;

  for v_slot in 1 .. v_n loop
    v_pick := null;
    -- After a workout run, prefer an achievement, coach, challenge or event
    -- card. A preference, not a rule: it applies only while the page still
    -- holds one.
    v_prefer := v_run_workout_n >= v_prefer_after_workouts;

    if v_prefer then
      for v_i in 1 .. v_n loop
        if not v_used[v_i] and v_cand_kind[v_i] = 'boost'
           and not (v_cand_author[v_i] is not null and v_cand_author[v_i] = v_run_author
                    and v_run_author_n >= v_max_same_author)
        then v_pick := v_i; exit; end if;
      end loop;
    end if;

    if v_pick is null then
      for v_i in 1 .. v_n loop
        if not v_used[v_i]
           and not (v_cand_author[v_i] is not null and v_cand_author[v_i] = v_run_author
                    and v_run_author_n >= v_max_same_author)
           and not (v_cand_kind[v_i] = 'system' and v_run_system_n >= v_max_system_run)
           and not (v_cand_kind[v_i] = 'workout' and v_run_workout_n >= v_max_workout_run)
        then v_pick := v_i; exit; end if;
      end loop;
    end if;

    -- COMM-112 validation rule: when the candidate set cannot satisfy a
    -- limit, relax that limit rather than return a shorter page.
    if v_pick is null then
      for v_i in 1 .. v_n loop
        if not v_used[v_i] then v_pick := v_i; exit; end if;
      end loop;
    end if;

    v_used[v_pick] := true;
    v_ids := v_ids || v_cand_id[v_pick];
    v_out_author := v_out_author || v_cand_author[v_pick];
    v_out_kind := v_out_kind || v_cand_kind[v_pick];
    v_out_score := v_out_score || v_cand_score[v_pick];

    if v_cand_author[v_pick] is not null and v_cand_author[v_pick] = v_run_author then
      v_run_author_n := v_run_author_n + 1;
    else
      v_run_author := v_cand_author[v_pick];
      v_run_author_n := case when v_cand_author[v_pick] is null then 0 else 1 end;
    end if;
    v_run_system_n := case when v_cand_kind[v_pick] = 'system' then v_run_system_n + 1 else 0 end;
    v_run_workout_n := case when v_cand_kind[v_pick] = 'workout' then v_run_workout_n + 1 else 0 end;
  end loop;

  -- --- next cursor -------------------------------------------------------
  -- A short page is the end of the feed, so it carries no cursor and the
  -- client shows the caught-up marker instead of a load-more control. The
  -- boundary row is the last one in SCORE order, which is v_page's last
  -- element, not the last one on screen after the diversity reorder.
  if v_n >= v_limit then
    v_last := v_page -> (v_n - 1);
    for v_i in greatest(1, v_n - 2) .. v_n loop
      v_tail_out := v_tail_out || jsonb_build_array(
        jsonb_build_object('a', v_out_author[v_i], 'k', v_out_kind[v_i]));
    end loop;
    v_next := translate(encode(convert_to(
      jsonb_build_object(
        'a', v_anchor,
        's', (v_last ->> 's')::numeric,
        't', (v_last ->> 't')::timestamptz,
        'i', v_last ->> 'id',
        'p', v_tail_out
      )::text, 'utf8'), 'base64'), E'\n', '');
  end if;

  -- --- the rows ----------------------------------------------------------
  return query
  select p.id,
         p.post_type,
         p.author_id,
         case when p.author_id is null then null
              else jsonb_build_object(
                     'display_name', pr.display_name,
                     'handle', pr.handle,
                     'avatar_url', pr.avatar_url) end,
         p.body,
         p.title,
         -- COMM-018. show_workout_results off means the result is stripped
         -- from the row, NOT that the post disappears: the member still
         -- posted, the number is just not this viewer's to read.
         case when priv.hide_result then null else p.result_text end,
         p.occurred_on,
         p.visibility,
         p.created_at,
         p.published_at,
         case when priv.hide_result
              then p.metadata - 'result_text' - 'new_result' - 'previous_result' - 'improvement'
              else p.metadata end,
         coalesce(
           (select jsonb_agg(jsonb_build_object(
                     'storage_path', m.storage_path,
                     'alt_text', m.alt_text,
                     'position', m."position",
                     'width', m.width,
                     'height', m.height) order by m."position")
            from public.post_media m where m.post_id = p.id),
           case when p.photo_path is not null
                then jsonb_build_array(jsonb_build_object('storage_path', p.photo_path, 'position', 0))
                else '[]'::jsonb end),
         (select count(*)::integer from public.reactions r where r.post_id = p.id),
         (select count(*)::integer from public.post_comments pc
          where pc.post_id = p.id and pc.deleted_at is null and pc.status = 'active'),
         v_out_score[o.ord],
         v_next
  from unnest(v_ids) with ordinality o(pid, ord)
  join public.workout_posts p on p.id = o.pid
  left join public.profiles pr on pr.id = p.author_id
  cross join lateral (
    select (p.author_id is not null
            and p.post_type in ('POST_WORKOUT', 'POST_PR')
            and not public.can_view_profile_field(p.author_id, 'show_workout_results')) as hide_result
  ) priv
  order by o.ord;
end $$;

revoke all on function public.feed_page(text, integer, text) from public, anon;
grant execute on function public.feed_page(text, integer, text) to authenticated;

comment on function public.feed_page(text, integer, text) is
  'COMM-110/111/112/113, personalized by COMM-303. Ranked and diversified feed page for auth.uid(). Same signature and same returned columns since 202608280019. Its eight scoring weights are now resolved per caller by public.feed_weights_resolve(auth.uid(), the default block): a member with no member_feed_weights row - which is every member today, since nothing writes that table yet - gets the fixed defaults and therefore exactly the ranking this function has produced since 202608310003. A personalized member gets the same eight components, redistributed, summing to the same total as the defaults and each within 0.40..2.50 of its own default. COMM-112 diversity runs after scoring, unchanged by personalization. security definer, execute granted to authenticated only.';

commit;
