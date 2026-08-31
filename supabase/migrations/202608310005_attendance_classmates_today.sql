begin;

-- COMM-307, the schema half, closing the parked COMM-P05. "Who else trained
-- today", as one function and nothing else.
--
-- WHAT LANDS HERE
--   * public.attendance_classmates_today(p_limit int default 6) returns
--     setof jsonb - new, security definer, granted to authenticated.
-- No new table, so no new RLS policy. The two tables it reads
-- (attendance_log, profiles) already have their own. No existing function is
-- re-created, no existing signature moves, and no client call changes: the
-- feed-top card, the follow action and the classmates_card_viewed analytics
-- event are COMM-307's client half and are still open.
--
-- THE FORWARD REFERENCE THIS CLOSES, VERBATIM. contracts.md, "Needs from
-- schema, feed (Phase 3)":
--   "attendance_classmates_today() returns setof jsonb,
--    {user_id, display_name, handle, avatar_url} - security definer, same
--    boundary-crossing shape as people_suggestions. Distinct from COMM-302's
--    signal: 'today' only, no window, no historical count. COMM-307, closing
--    COMM-P05."
-- That is what this is, plus one defaulted parameter the reference did not
-- name (see THE LIMIT below), so the promised zero-argument call form still
-- resolves verbatim - the same accommodation COMM-301 made when it gave
-- relationship_score a defaulted p_as_of.
--
-- WHY THIS IS NOT classmate_day_counts() WITH A DIFFERENT WINDOW
-- It reads the same table with the same privacy gate, and it is still a
-- genuinely different query rather than a special case of the COMM-302
-- helper, so it is written out rather than layered on top:
--
--   classmate_day_counts()          this function
--   ------------------------------  --------------------------------------
--   trailing 60 days                one day, current_date, both sides
--   counts overlapping days         no count at all
--   ranks a suggestion / a post     lists people, in no ranked order
--   absent means 0 to its callers   absent means "did not train today"
--   internal, ungranted             a client entry point
--
-- Reusing the helper would mean asking for a 60-day overlap and then throwing
-- 59 days of it away, which is both wrong (a member who trained beside the
-- caller last Tuesday and not today would come back with shared_days >= 1)
-- and slower. contracts.md tells a dependent ticket to reuse it "rather than
-- re-derive the overlap"; the overlap this function needs is not that
-- overlap. What IS reused, deliberately and to the letter, is the privacy
-- gating: the same can_view_profile_field(candidate, 'show_attendance') call,
-- applied the same way, at the same point (after the candidate set is built,
-- so it runs once per member who actually trained today rather than once per
-- club member), carrying the same block check and the same admin
-- short-circuit. See PRIVACY below.
--
-- SECURITY DEFINER, for exactly one boundary, the one people_suggestions
-- already documents: attendance_log's policies are own-row plus staff
-- (202608310001), so a member cannot see who else has a row in it. Without
-- elevation this function could only ever return the caller's own row, which
-- is the one row it excludes. auth.uid() is checked first, before anything is
-- read, and a null caller raises rather than returning empty - it is an entry
-- point, not a helper.
--
-- WHAT LEAVES THE FUNCTION. Four keys per member: user_id, display_name,
-- handle, avatar_url. No date, no time, no attendance count, no streak, no
-- session detail. A caller learns that these members trained today, which is
-- the whole of what the card says; they do not learn anything about any other
-- day. Those four keys are also exactly the header community_profile
-- (202608280022) already returns to any member for any member, so this
-- publishes no field that was not already reachable for a member who passes
-- the gate below.

-- ---------------------------------------------------------------------------
-- attendance_classmates_today
-- ---------------------------------------------------------------------------
-- THE CALLER'S OWN show_attendance IS ENFORCED HERE, IN THE FUNCTION, and
-- that is the one real product decision in this file rather than a formality.
-- COMM-307's acceptance criteria: "the caller's own show_attendance gates
-- whether they can see the card's content at all (off means the card never
-- renders for them, even though their own attendance is still logged and
-- still counts elsewhere)". It could have been left to the client, which
-- already knows the member's own toggle from their settings screen and could
-- simply skip the call. It is not, for three reasons:
--
--   1. The repo's standing rule. Every boundary in this module is enforced
--      server-side, never by a UI check alone. The vendored Supabase client
--      is in the browser and every RPC in this module is directly callable
--      from a console; a client-side skip is a rendering decision, not a
--      gate. This particular one governs who may learn that another member
--      trained today, which is precisely the kind of thing that has to hold
--      when the client is not asked.
--   2. It is a reciprocity rule, and reciprocity has to be symmetric. The
--      card's whole premise is a mutual exchange: every member on it has
--      opted into being seen training. A member who has opted out of being
--      seen but can still read the list is taking one side of a trade they
--      declined - and the module already makes the same call in the same
--      direction elsewhere, where COMM-306 removed current_streak from a
--      member's OWN profile payload for other viewers rather than trusting a
--      client not to render it.
--   3. One place, not two. 202608310001 wrote the standing rule down - every
--      member-facing Phase 3 reader applies show_attendance in its own body -
--      and COMM-302 and COMM-306 both did. A gate that lives in one client
--      surface is a gate the next surface forgets.
--
-- IT IS A DIRECT COLUMN READ, NOT can_view_profile_field(v_uid, ...), and
-- that is load-bearing rather than a shortcut: can_view_profile_field returns
-- true for p_target = auth.uid() BEFORE it consults any toggle (202608280003,
-- and the property COMM-306 relies on to keep a member on their own board).
-- Asking it about the caller would therefore always answer true and the gate
-- would silently do nothing. The two questions are genuinely different - "may
-- this viewer see that member's attendance" versus "has this member opted in
-- at all" - and only the second one is being asked here.
--
-- One consequence of the direct read, stated rather than discovered: it does
-- NOT carry can_view_profile_field's is_admin() short-circuit, so an admin
-- who has not opted in gets an empty card like anybody else. That is correct.
-- The short-circuit exists so staff can see members' data; it is not a licence
-- to opt an admin into a reciprocal surface they declined. The short-circuit
-- still applies in full to the per-candidate gate below, so an opted-in admin
-- does see members who opted out - the module-wide behaviour of the one
-- resolution point, as feed_leaderboard's contract already records.
--
-- AN OPTED-OUT CALLER GETS AN EMPTY SET, NOT A RAISE. The card is already
-- specified to render nothing at all - no heading, no empty state - when the
-- member has not trained today or nobody else has (COMM-232's "on no signal,
-- show nothing" precedent, which COMM-307 adopts by name). Empty therefore
-- needs no new client branch and no new error path, and the three ways to get
-- no card are indistinguishable from outside, which is itself the privacy
-- answer: nothing about the caller's setting leaks into the response shape.
-- A raise would turn a privacy preference into an error the client would have
-- to special-case, and error paths are where surfaces regain a heading.
--
-- PRIVACY, per candidate: can_view_profile_field(candidate,
-- 'show_attendance'), the identical call classmate_day_counts() (202608310003)
-- makes, applied after the candidate set is built for the identical reason.
-- It carries three things with it and none of them is re-implemented here:
--   * BLOCKS in either direction, settled before any toggle is consulted -
--     the same thing people_suggestions relies on for all four of its signals.
--   * DELETED PROFILES, which fail the `deleted_at is null` lookup inside it.
--   * visible_to_club, which it requires before it will answer about any
--     other field - so a member hidden from the club is not on this card
--     either, without a second predicate saying so.
-- show_attendance DEFAULTS TO FALSE, so out of the box this card is empty for
-- everybody and every member on it has made a deliberate choice. A member with
-- it off still logs attendance, still earns attendance achievements from it
-- (COMM-305) and still ranks on the consistency board with it (COMM-306);
-- what they do not do is appear here.
--
-- TODAY MEANS current_date ON BOTH SIDES OF THE JOIN, and nothing else. The
-- caller's own row for current_date is the anchor: no row, no card, which is
-- the join's own doing rather than a separate check. current_date is the
-- server's day (UTC on Supabase), the same day attendance_log's trigger
-- compares against when it applies its one-day future slack, so a member's
-- "today" here is the same "today" that wrote their row.
--
-- NO VIEWER PARAMETER, the same refusal classmate_day_counts() documents:
-- can_view_profile_field resolves its viewer from auth.uid() and cannot be
-- told to answer for anybody else, so a p_viewer argument would be honoured by
-- the join and silently ignored by the privacy gate. This function only ever
-- answers for the authenticated caller.
--
-- THE ORDER, and why it is not alphabetical. Every member in the set trained
-- today, so there is no signal to rank them by and any order is a choice.
-- Most recently recorded first, then the display-name/handle/id tie-break
-- people_suggestions already uses to make an order total. Two reasons: the
-- card is a post-class moment, so the members who logged closest to the
-- caller's own log are the likeliest to have actually been in the room; and
-- in a club bigger than p_limit an alphabetical cut would show the same few
-- members every single day, while a recency cut shows a truthful sample of
-- today. recorded_at is when the row was written, not when the member
-- trained - attendance_log records a day, not a time, and has no better
-- column - which is why it is only the first key of a total order and not a
-- claim the card makes.
--
-- THE LIMIT is p_limit, clamped 1..20 the way people_suggestions clamps its
-- own, defaulting to 6. COMM-307 asks for "a small fixed number... matching
-- people_suggestions's own limit shape, clamp 1..20, default a smaller number
-- appropriate to a card rather than a full strip". 6 is that number: a card in
-- the feed top area (COMM-115's slot) is two rows of three avatars or six list
-- rows, where people_suggestions' 10 is a horizontally scrolling strip. The
-- clamp is the server's and is fixed here; the default inside it is the feed
-- agent's to revisit from the client half by passing an argument, which is why
-- there is a parameter at all rather than a hard-coded 6.
create or replace function public.attendance_classmates_today(p_limit int default 6)
returns setof jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_limit int;
  v_opted_in boolean;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  -- The same read gate people_suggestions and feed_leaderboard use: a real
  -- seat in the club, not the recovery-verification write gate. Reads are not
  -- gated behind is_community_member() anywhere in this module.
  if public.my_role_code() is null then raise exception 'not authorized'; end if;

  v_limit := greatest(1, least(coalesce(p_limit, 6), 20));

  -- The caller's own toggle. Direct column read on purpose - see the header:
  -- can_view_profile_field() answers true for the caller before it reads any
  -- toggle, so it cannot be used to ask this question. A missing or deleted
  -- profile coalesces to false, which is the same empty card and not an error.
  select p.show_attendance into v_opted_in
  from public.profiles p
  where p.id = v_uid and p.deleted_at is null;
  if not coalesce(v_opted_in, false) then return; end if;

  return query
  with today as (
    -- attendance_log to itself on current_date. `me` is at most one row - the
    -- table's unique (user_id, occurred_on) key guarantees it - so this fans
    -- out to exactly one row per other member who trained today, and no
    -- caller row means no rows at all, which is the omitted card.
    select o.user_id as cand, o.recorded_at as logged_at
    from public.attendance_log me
    join public.attendance_log o
      on o.occurred_on = me.occurred_on
     and o.user_id <> me.user_id
    where me.user_id = v_uid
      and me.occurred_on = current_date
  )
  select jsonb_build_object(
    'user_id', t.cand,
    'display_name', pr.display_name,
    'handle', pr.handle,
    'avatar_url', pr.avatar_url
  )
  from today t
  join public.profiles pr on pr.id = t.cand
  where public.can_view_profile_field(t.cand, 'show_attendance')
  order by t.logged_at desc,
           coalesce(nullif(btrim(pr.display_name), ''), pr.handle) asc,
           t.cand asc
  limit v_limit;
  -- Nobody else today, or nobody else who opted in: no rows. The client shows
  -- no card rather than an empty one, the same answer people_suggestions gives
  -- a member with no signal.
end $$;

revoke all on function public.attendance_classmates_today(int) from public, anon;
grant execute on function public.attendance_classmates_today(int) to authenticated;

comment on function public.attendance_classmates_today(int) is
  'COMM-307 post-class trained-with-you card, closing COMM-P05. Members other than the caller who have an attendance_log row for current_date, when the caller has one too - today only, on both sides of the join, with no window, no lookback and no count, which is the entire distinction from COMM-302''s classmate_day_counts(). Returns setof jsonb {user_id, display_name, handle, avatar_url}; no date, no time, no session detail. Each candidate must pass can_view_profile_field(candidate, ''show_attendance''), which also settles block edges in both directions, deleted profiles and visible_to_club; show_attendance defaults false, so a member appears here only by deliberate choice while their own rows still count for their achievements and their leaderboard rank. The CALLER''s own show_attendance is enforced too, as a direct profiles column read rather than through can_view_profile_field (which answers true for the caller before reading any toggle): off means an empty set, indistinguishable from having trained alone, never a raise. Self excluded. Ordered most recently recorded first, then display name then id. p_limit clamped 1..20, null means 6 - a card-sized number, not a strip-sized one. security definer for one boundary: attendance_log is own-row plus staff, so no member could otherwise see who else trained. Raises not authorized for a null auth.uid() or a caller with no my_role_code().';

commit;
