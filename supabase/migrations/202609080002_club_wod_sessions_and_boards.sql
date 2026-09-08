begin;

-- =====================================================================
-- THE FEED WRITES ITSELF: club programming as a shared artefact, with
-- members' own logged results attached to it.
-- =====================================================================
-- A five-persona audit plus market research reached one conclusion:
-- THE COMMUNITY LAYER COMPETES WITH WHATSAPP ON TYPED POSTS AND LOSES.
-- WhatsApp is at 99% penetration and 99% daily use in Israel; the club
-- already has a group. An in-house feed that asks people to type is asking
-- for a behaviour that will not move.
--
-- There is a second, structural reason to stop asking. Every computed
-- community surface in this schema - the coach's retention signals, the
-- consistency streak, feed_leaderboard's consistency mode - is fed by
-- public.attendance_log, which is trigger-written from the training log.
-- So community was gated on log adoption, and the log was meant to be
-- driven by community. This feature breaks that circularity from the
-- other end: it produces a card from data the app ALREADY has, and it is
-- worth reading at ZERO member contributions, because the programming
-- itself is content WhatsApp cannot produce on its own.
--
-- WHAT IS BUILT: a coach posts "this is what we are doing today" from the
-- club WOD catalogue (202609060028). That produces ONE feed card and ONE
-- board. A member who logs the workout attaches their own result to the
-- board with a single tap from the log they were already filling in. The
-- club opens the app and sees today's programming and how everyone did.
--
-- =====================================================================
-- DECISION 1: THE ARTEFACT IS A DATED SESSION, AND ITS CARD IS A POST
-- =====================================================================
-- A club_wods row is a DEFINITION ("Fran"). Programming is an EVENT ("we
-- are doing Fran on Thursday"), and the same definition is programmed
-- again six weeks later. So a published-to-feed flag on club_wods was
-- rejected outright: it is a boolean where the domain needs a date, and
-- the second time the coach programmed the same workout it would either
-- overwrite the first board or refuse. public.club_wod_sessions is the
-- (wod, date) instance, and it is the row every result hangs off.
--
-- The session ALSO gets a workout_posts row, POST_CLUB_WOD, because the
-- feed is where the club already looks and everything the card needs
-- already exists there: ranking, comments, reactions, reports, mute
-- (hidden_posts), block edges, pinning, moderation. Rebuilding any of
-- that beside the feed would be a second, worse feed.
--
-- THE FLOOD RISK THE BRIEF NAMES IS ANSWERED STRUCTURALLY, NOT BY TUNING.
-- "A programming card that collects fifteen results must not flood the
-- feed." Fifteen results produce FIFTEEN ROWS IN club_wod_results AND ZERO
-- EXTRA POSTS. Attaching is deliberately cheaper AND quieter than posting:
-- it costs no feed slot, which is the whole reason a member will do it.
-- Two further bounds are in the schema rather than in hope:
--   * a session may only be posted for yesterday, today or tomorrow, so a
--     coach cannot drop a week of programming into the feed at once;
--   * at most 4 live sessions per calendar day (a strength piece, a
--     metcon, a skill and one spare is already generous).
-- The feed therefore gains at most a handful of cards a day no matter how
-- many members take part - which is the opposite of the current shape,
-- where fifteen members sharing one workout is fifteen cards.
--
-- WHY THE DIVERSITY CLASS IS LEFT AT 'other', DELIBERATELY.
-- feed_page's kind CASE has no arm for POST_CLUB_WOD, so it falls to
-- 'other' - neutral, like POST_TEXT and POST_PHOTO: not run-limited, not
-- preferred. That is the right class and NOT an oversight:
--   * 'workout' would be actively wrong. That class exists to suppress
--     RUNS of one-member workout cards (v_max_workout_run), and it is also
--     the class feed_page's hide_result lateral keys on - a POST_CLUB_WOD
--     there would have the coach's programming hidden behind the COACH's
--     personal show_workout_results toggle.
--   * 'boost' exists to break a workout run. A card that appears once or
--     twice a day cannot be relied on to break anything, so promoting it
--     would buy nothing while making 202609060025's finding worse - the
--     diversity pass steers boost cards adjacent to workout runs, and a
--     programming card wedged between two members' shares of THAT SAME
--     WORKOUT is precisely the near-identical-cards-adjacent defect.
--   * the card is already lifted without touching the ranking: it is
--     authored by the coach, so author_is_staff is true and it collects
--     v_w_coach * v_coach_author on every viewer's page.
-- Recreating 600 lines of tuned ranking to change one CASE arm is a risk
-- with no matching benefit. If the club later wants the card boosted, that
-- is a one-arm migration against a feed_page nobody is mid-change on.
--
-- =====================================================================
-- DECISION 2: RESULTS ATTACH EXPLICITLY. comparison_key MATCHING WAS
-- REJECTED, AND IT IS THE MOST IMPORTANT REJECTION IN THIS FILE.
-- =====================================================================
-- workout_posts.comparison_key already carries wod:<wod_id>:<type>:<rx|
-- scaled>, so "every post whose key names this WOD and whose occurred_on
-- is the session date" is a board with no new write path at all. It is
-- wrong three times over:
--
--   a. IT PUBLISHES WITHOUT ASKING, AT A NEW GRANULARITY. A member who
--      shared a workout at 'followers' visibility has a matching key.
--      Sweeping that row onto a club-wide board widens the audience of an
--      already-published post without the member asking - the exact
--      boundary 202609060025 refused to cross when it declined to promote
--      'followers' to 'club' during the PR upgrade.
--   b. IT INFERS PARTICIPATION. occurred_on is the entry's own date. A
--      member who happened to do Fran alone on Thursday would be listed as
--      part of Thursday's class. This schema already refuses that class of
--      inference: feed_page's my_classes scope stays parked because
--      "attendance_log records days, not classes, and carries no class
--      identity". A board is a stronger claim than a scope filter.
--   c. IT SPLITS THE BOARD ON rx. The key's fourth segment is rx|scaled,
--      so matching on the whole key puts scaled athletes on a different
--      board - and matching on only the second segment means the key is
--      being parsed, not used as a key.
--
-- So attaching is an EXPLICIT ACT by the member, and public.club_wod_results
-- is its own table rather than a column on workout_posts - because a column
-- there would mean attaching implies a post, and the entire point is that it
-- does not.
--
-- IT IS STILL NOT TYPING. The brief's target is typed composition, not
-- consent. The client raises the attach control inside the log form the
-- member is already completing; the payload is a record id, and the result
-- is FORMATTED SERVER-SIDE from structured fields. NO FREE TEXT REACHES
-- THIS TABLE AT ALL - which also means the board can never be used to
-- smuggle a message past post moderation.
--
-- THE THREE CASES THE BRIEF ASKS ABOUT:
--   * LOGS IT THREE DAYS LATER - fine. Attaching is not tied to when the
--     entry was made. The board accepts attachments until the session is
--     14 days old, and carries each row's own occurred_on so the client can
--     say "logged Thursday" when it differs from the session date.
--   * SCALES IT - the row carries rx and the result text already carries
--     the client's own "@ <scaled weight> kg" suffix. There is no second
--     board and no separation: a scaled result sits in the same list, in
--     the same order, as an Rx one.
--   * LOGS IT TWICE - the primary key is (session_id, user_id). One member
--     is one row on one board, forever. A second attach REPLACES the
--     figure, because the member is explicitly choosing which of their
--     attempts the club sees; re-attaching the identical record writes
--     nothing at all.
--
-- =====================================================================
-- DECISION 3: PUBLISHING IS A SEPARATE, EXPLICIT STAFF ACT. NOTHING
-- AUTO-PUBLISHES, IN EITHER DIRECTION.
-- =====================================================================
-- club_wod_session_publish() is NOT folded into club_wod_publish(). A WOD
-- published to the catalogue in March is programmed in September; fusing
-- them would mean re-publishing to re-program, which club_wod_publish()
-- explicitly refuses ('wod already published'). It also leaves that
-- function's shipped contract byte-identical - it is already in production
-- and already wired into cloud.js.
--
-- The permission is has_perm('community.challenge.create'), for
-- 202609060028's reasons restated: it is the permission that gates the
-- programming-shaped staff writes, and NOT is_staff(), which 202609060005
-- deliberately moved this family away from because is_staff() also admits
-- the `staff` role, which holds no such permission. Every role that holds
-- it (coach 20, head_coach 30, admin 50, owner 60) also clears the
-- role_rank >= 20 bar in workout_posts_guard_privileged_type, so the guard
-- and the RPC can never disagree about who may author the card - checked
-- against the seeds in 202608280001, not assumed.
--
-- NOTHING MAY AUTO-PUBLISH A MEMBER'S PRIVATE LOG, and that is structural
-- here, not a convention: there is NO TRIGGER anywhere from
-- private_records, attendance_log or workout_posts to club_wod_results,
-- and there must never be one. The only writer is
-- club_wod_attach_result(), called by the member, for their own record,
-- with auth.uid() checked first. Syncing your training log and publishing
-- it stay two different acts.
--
-- =====================================================================
-- DECISION 4: PARTICIPATION AND THE FIGURE ARE TWO DIFFERENT PERMISSIONS
-- =====================================================================
-- visible_to_club defaults TRUE. show_workout_results defaults FALSE. The
-- board respects both, separately, exactly as feed_page already does for a
-- POST_WORKOUT (COMM-018: the toggle strips the result from the row, it
-- does not remove the post):
--
--   LISTED AT ALL   can_view_profile_field(member, 'visible_to_club')
--                   The member attached deliberately, so being listed is
--                   consented. A member hidden from the club is still not
--                   listed to others, and a block edge in either direction
--                   removes the row - can_view_profile_field settles both
--                   plus the self case in one call.
--   THE FIGURE      can_view_profile_field(member, 'show_workout_results')
--                   Off - which is the DEFAULT - means result_text comes
--                   back NULL with result_hidden true. The member is on the
--                   board; the number is not this viewer's to read.
--
-- THIS MEANS THE HONEST SHIPPED BEHAVIOUR IS A BOARD OF NAMES WITH FEW
-- NUMBERS UNTIL MEMBERS OPT IN, and that is stated here rather than
-- papered over. It is also not a bad first state: the beginner persona
-- found leaderboards intimidating, and "eight people did this today" is
-- the roll call this feature is for. THE CLIENT MUST NOT FLIP
-- show_workout_results ON THE MEMBER'S BEHALF, or offer to; the only
-- correct affordance is a link to the privacy screen they already own.
--
-- result_count IS VIEWER-RELATIVE: it counts the rows this viewer may
-- list, so there is no aggregate that leaks the existence of members the
-- viewer cannot see. A count that disagrees with the list is a side
-- channel, and this one cannot.
--
-- NO TWELFTH TOGGLE. A per-attachment "hide my number" was considered and
-- rejected: the eleven server-enforced toggles are the model members
-- already understand, and fragmenting result privacy across a global
-- toggle and a per-row flag would make the guarantee harder to state, not
-- easier. Detaching is always available and is the per-row control.
--
-- DATA MINIMISATION. club_wod_results stores the FORMATTED result and four
-- scalars (record_id, score_type, rx, occurred_on) - not the entry. The
-- board needs nothing more, and a club-visible table is the wrong place to
-- keep a copy of anyone's log.
--
-- =====================================================================
-- DECISION 5: THE EMPTY AND PARTIAL STATES ARE THE FEATURE
-- =====================================================================
-- Every read returns a complete board object with EVERY key present, so
-- the client never tests for absence and every state is renderable:
--   * NOBODY HAS ATTACHED - results [], result_count 0, and the wod object
--     is still there. The card is worth opening at zero results, which is
--     what breaks the log-adoption circularity described at the top.
--   * THE VIEWER HAS NOT LOGGED IT - viewer.attached false. The SERVER
--     CANNOT KNOW whether they logged it: the log is local-first and cloud
--     backup is opt-out, so private_records may simply not have it. The
--     client holds that fact and must decide the call to action from its
--     OWN log; the server reports only the board.
--   * THE VIEWER HAS NO SERVER COPY OF THE ENTRY - the attach still
--     succeeds and records participation with result_text null. A member
--     with backup switched off is not a second-class member.
--   * THE BOARD IS CLOSED - viewer.closed_reason is 'future' (posted for
--     tomorrow), 'expired' (over 14 days old) or 'cancelled', so the client
--     can say WHY instead of hiding a control.
--   * A CANCELLED SESSION still returns its board by id, with
--     cancelled_at set, and DETACHING STILL WORKS. A member must always be
--     able to take their result down.
--
-- =====================================================================
-- DECISION 6: NOT A LEADERBOARD, AND UNABLE TO BECOME ONE
-- =====================================================================
-- weekly_challenges is the ranked feature and stays so. This board:
--   * has NO score_value, NO score_direction and NO rank column, so there
--     is nothing to sort by even from a direct query;
--   * ORDERS BY attached_at - the order people did it in, which is the
--     honest shape of a training day and is stable across viewers;
--   * does not separate rx from scaled;
--   * and is per-session, so nothing accumulates across days.
-- Adding ranking later would require new columns, which is the point.

-- =====================================================================
-- 1. THE FORMATTERS
-- =====================================================================
-- app.js formatWodEntry() is the only definition of what a WOD result
-- LOOKS LIKE, and it lives on the client. Reproducing it here is what lets
-- the board be built from structured fields with no free text - and what
-- lets the figure be recomputed from the member's OWN private_records row
-- rather than trusted from the request, which is pr_share's rule.
--
-- The two are split because normalisation and formatting answer different
-- questions and one of them runs on data this database did not write:
-- private_records.payload is client-written JSON with no schema at all.

-- wod_entry_normalize(): sanitizeWodEntry()'s clamps, applied to whatever
-- shape actually arrived. Run over BOTH sources - the server copy as well
-- as the client fallback - because a synced payload has been through
-- sanitizeWodEntry on SOME device at SOME app version, which is not the
-- same as being trustworthy now.
create or replace function public.wod_entry_normalize(p_entry jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_type text;
  v_out jsonb;
  v_reps jsonb;
  v_n numeric;
begin
  if p_entry is null or jsonb_typeof(p_entry) <> 'object' then return null; end if;

  v_type := coalesce(p_entry ->> 'scoreType', '');
  if v_type not in ('time', 'amrap', 'load', 'emom') then return null; end if;

  v_out := jsonb_build_object(
    'scoreType', v_type,
    -- Carried so the caller can prove the entry is for the WOD it is being
    -- attached to. Not length-capped here: it is compared for equality
    -- against a club_wods.wod_id that already carries its own CHECK.
    'wodId', nullif(btrim(coalesce(p_entry ->> 'wodId', '')), ''),
    -- sanitizeWodEntry: `rx: e.rx !== false`. Anything that is not an
    -- explicit JSON false is Rx. Typed rather than cast, so a hand-edited
    -- import carrying rx:"maybe" cannot abort the attach.
    'rx', case when jsonb_typeof(p_entry -> 'rx') = 'boolean'
               then (p_entry ->> 'rx')::boolean else true end,
    'date', case when p_entry ->> 'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                 then p_entry ->> 'date' else null end
  );

  -- LIMITS from src/constants.js: minutes 999 (so timeSeconds caps at
  -- 999*60+59), rounds 9999, reps 1000, weight 1000, emomMovements 20.
  if v_type = 'time' then
    v_n := public.private_record_number(p_entry, 'timeSeconds');
    if v_n is not null then
      v_out := v_out || jsonb_build_object('timeSeconds', least(59999, greatest(0, round(v_n))));
    end if;
  elsif v_type = 'amrap' then
    v_n := public.private_record_number(p_entry, 'rounds');
    if v_n is not null then
      v_out := v_out || jsonb_build_object('rounds', least(9999, greatest(0, round(v_n))));
    end if;
    v_n := public.private_record_number(p_entry, 'reps');
    if v_n is not null then
      v_out := v_out || jsonb_build_object('reps', least(1000, greatest(0, round(v_n))));
    end if;
  elsif v_type = 'load' then
    v_n := public.private_record_number(p_entry, 'weight');
    if v_n is not null then
      v_out := v_out || jsonb_build_object('weight', least(1000, greatest(0, round(v_n, 2))));
    end if;
  else
    if jsonb_typeof(p_entry -> 'emomReps') = 'array' then
      select coalesce(jsonb_agg(
               least(1000, greatest(0, round(coalesce(
                 public.private_record_number(jsonb_build_object('v', t.x), 'v'), 0))))
               order by t.ord), '[]'::jsonb)
        into v_reps
        from jsonb_array_elements(p_entry -> 'emomReps') with ordinality t(x, ord)
       where t.ord <= 20;
      v_out := v_out || jsonb_build_object('emomReps', coalesce(v_reps, '[]'::jsonb));
    end if;
  end if;

  -- scaledWeight is not per-score-type: formatWodEntry appends it whenever
  -- the entry is scaled, whatever the score type is.
  v_n := public.private_record_number(p_entry, 'scaledWeight');
  if v_n is not null and v_n > 0 then
    v_out := v_out || jsonb_build_object('scaledWeight', least(1000, greatest(0, round(v_n, 2))));
  end if;

  return v_out;
end $$;
revoke all on function public.wod_entry_normalize(jsonb) from public, anon, authenticated;

comment on function public.wod_entry_normalize(jsonb) is
  'Internal. One wod_entry payload - from private_records or from an attach call - clamped to sanitizeWodEntry()''s shape and LIMITS (timeSeconds 0..59999, rounds 0..9999, reps 0..1000, weight and scaledWeight 0..1000, at most 20 emomReps), returning null when scoreType is not one of time/amrap/load/emom. Applied to the SERVER copy as well as the client fallback: private_records.payload is client-written JSON with no schema, and having passed sanitizeWodEntry on some device at some app version is not the same as being trustworthy now. Carries wodId through so the caller can prove the entry belongs to the session it is being attached to. No client grant.';

-- wod_entry_result_text(): app.js formatWodEntry(), in SQL, over an already
-- normalised entry.
--
-- ONE DELIBERATE DIVERGENCE FROM THE CLIENT, in the safe direction. cleanNum
-- defaults every missing number to 0, so a half-filled entry renders on the
-- client as "0:00" or "0+0". Publishing that to the club board would be a
-- figure that is worse than no figure, so a zero score returns NULL here and
-- the row is listed as participation with no result. The board is designed
-- to render exactly that state; the client's own screens are unaffected.
create or replace function public.wod_entry_result_text(p_entry jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_type text;
  v_rx boolean;
  v_base text;
  v_secs numeric;
  v_rounds numeric;
  v_reps numeric;
  v_weight numeric;
  v_scaled numeric;
  v_list text;
begin
  if p_entry is null or jsonb_typeof(p_entry) <> 'object' then return null; end if;
  v_type := coalesce(p_entry ->> 'scoreType', '');
  v_rx := case when jsonb_typeof(p_entry -> 'rx') = 'boolean'
               then (p_entry ->> 'rx')::boolean else true end;

  if v_type = 'time' then
    -- formatClock(): `${Math.floor(t/60)}:${String(t%60).padStart(2,"0")}`.
    v_secs := public.private_record_number(p_entry, 'timeSeconds');
    if v_secs is not null and v_secs > 0 then
      v_base := (floor(v_secs / 60))::bigint::text || ':'
             || lpad((floor(v_secs)::bigint % 60)::text, 2, '0');
    end if;
  elsif v_type = 'amrap' then
    v_rounds := public.private_record_number(p_entry, 'rounds');
    v_reps := public.private_record_number(p_entry, 'reps');
    if coalesce(v_rounds, 0) > 0 or coalesce(v_reps, 0) > 0 then
      v_base := to_char(coalesce(v_rounds, 0), 'FM999999990') || '+'
             || to_char(coalesce(v_reps, 0), 'FM999999990');
    end if;
  elsif v_type = 'load' then
    v_weight := public.private_record_number(p_entry, 'weight');
    if v_weight is not null and v_weight > 0 then
      v_base := trim(trailing '.' from to_char(v_weight, 'FM999999990.99')) || ' ק"ג';
    end if;
  elsif v_type = 'emom' then
    if jsonb_typeof(p_entry -> 'emomReps') = 'array' then
      select string_agg(
               to_char(coalesce(public.private_record_number(jsonb_build_object('v', t.x), 'v'), 0),
                       'FM999999990'),
               ' · ' order by t.ord)
        into v_list
        from jsonb_array_elements(p_entry -> 'emomReps') with ordinality t(x, ord);
      -- An all-zero rotation is an untouched form, not a result.
      if v_list is not null and v_list ~ '[1-9]' then v_base := v_list; end if;
    end if;
  end if;

  if v_base is null then return null; end if;

  if not v_rx then
    v_scaled := public.private_record_number(p_entry, 'scaledWeight');
    if v_scaled is not null and v_scaled > 0 then
      v_base := v_base || ' @ ' || trim(trailing '.' from to_char(v_scaled, 'FM999999990.99')) || ' ק"ג';
    end if;
  end if;

  -- club_wod_results.result_text and workout_posts.result_text share the
  -- same 240 ceiling; nothing this function builds approaches it, and the
  -- cap is here so a future score type cannot make the INSERT the place
  -- that finds out.
  return left(v_base, 240);
end $$;
revoke all on function public.wod_entry_result_text(jsonb) from public, anon, authenticated;

comment on function public.wod_entry_result_text(jsonb) is
  'Internal. app.js formatWodEntry() in SQL, over a wod_entry_normalize() output: time as m:ss, amrap as rounds+reps, load as <weight> kg, emom as the rep rotation joined with a middle dot, plus the client''s own " @ <scaledWeight> kg" suffix on a scaled entry. ONE DELIBERATE DIVERGENCE: a zero score returns NULL rather than the client''s "0:00" / "0+0", because cleanNum defaults every missing number to 0 and publishing that to the club board would be a figure worse than no figure - the board renders participation with no result instead. Capped at 240, matching result_text everywhere else. No client grant.';

-- =====================================================================
-- 2. public.club_wod_sessions - one day's programming
-- =====================================================================
create table if not exists public.club_wod_sessions (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null default public.default_club_id() references public.clubs(id),

  -- The catalogue entry, by its meaningful key. on delete restrict is
  -- belt-and-braces: club_wods has no delete grant for any client role
  -- (202609060028 decision 4), and this states in the schema why - a
  -- session, its board and every member's local wod_entries all reference
  -- the id.
  wod_id text not null references public.club_wods(wod_id) on delete restrict,

  -- The DAY the club did it. This, not published_at, is what the card and
  -- the board are about, and it is why a published-to-feed flag on
  -- club_wods could not have worked: the same definition is programmed
  -- again weeks later and needs a second, separate board.
  session_date date not null,

  -- The coach's one-line note ("Rx is 43/30kg"), control-stripped at the
  -- RPC. Held HERE as well as on the post because the post can be removed
  -- and the session is the record of what was programmed.
  note text not null default '' check (char_length(note) <= 500),

  -- on delete set null, not cascade: the session and its board outlive the
  -- card. workout_posts cascades from profiles, so a departing coach takes
  -- their posts with them - as they already do for every other coach post -
  -- and the club must not lose the record of what it trained.
  post_id uuid references public.workout_posts(id) on delete set null,

  published_by uuid references public.profiles(id) on delete set null,
  published_at timestamptz not null default now(),

  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles(id) on delete set null,
  cancelled_reason text check (cancelled_reason is null or char_length(cancelled_reason) <= 500),

  -- One board per (workout, day). This is what makes a double tap on
  -- "post today's WOD" idempotent, and what stops two coaches posting the
  -- same workout twice and splitting the club's results across two boards.
  unique (wod_id, session_date),

  constraint club_wod_sessions_cancelled_shape check (
    (cancelled_at is null and cancelled_by is null and cancelled_reason is null)
    or cancelled_at is not null
  )
);

-- The range read's index. Partial on live sessions because that is what
-- club_wod_boards() asks for; a cancelled board is only ever fetched by id.
create index if not exists club_wod_sessions_date_idx
  on public.club_wod_sessions(session_date desc, published_at desc)
  where cancelled_at is null;

-- DB-M3 (202609060015), asserted as a PROPERTY over pg_constraint in
-- 0081_indexes_impersonation_and_dormant_jobs_test: every public FK column
-- outside club_id must LEAD an index, or a cascade sequentially scans the
-- child table. wod_id already leads the unique above; these are the other
-- three. club_id is the documented exclusion (one club row exists).
create index if not exists club_wod_sessions_post_idx
  on public.club_wod_sessions(post_id) where post_id is not null;
create index if not exists club_wod_sessions_published_by_idx
  on public.club_wod_sessions(published_by) where published_by is not null;
create index if not exists club_wod_sessions_cancelled_by_idx
  on public.club_wod_sessions(cancelled_by) where cancelled_by is not null;

comment on table public.club_wod_sessions is
  'One day''s club programming: a (club_wods entry, date) instance, its feed card and the board members attach their own results to. The DATED INSTANCE is the artefact rather than a published-to-feed flag on club_wods, because a definition is programmed again weeks later and needs a second, separate board. Each live session owns exactly ONE workout_posts row of post_type POST_CLUB_WOD; member results are rows in club_wod_results and are NOT posts, which is what keeps fifteen results from becoming fifteen feed cards. Two structural bounds on the feed, not tuning: a session may only be posted for yesterday, today or tomorrow, and at most 4 live sessions may exist per calendar day. WRITES: none by RLS - no insert/update/delete grant to any client role. Everything goes through club_wod_session_publish / club_wod_session_cancel, both gated on community.challenge.create and both audited. READS: every is_community_member(), cancelled rows included, because a member holding a result on a cancelled board must still be able to resolve it and detach.';

comment on column public.club_wod_sessions.session_date is
  'The day the club trained this. Bounded to yesterday, today or tomorrow at publish time so a week of programming cannot be dropped into the feed at once, and it is the anchor for the 14-day attach window. Distinct from published_at, which is when the card was posted.';
comment on column public.club_wod_sessions.post_id is
  'The POST_CLUB_WOD card in the feed, or null once that card is gone. on delete set null, not cascade: the club''s record of what it trained, and every member''s attached result, outlive the card. Null also after club_wod_session_cancel(), which withdraws the card by stamping workout_posts.deleted_at while leaving the board readable by id.';

alter table public.club_wod_sessions enable row level security;
revoke all on public.club_wod_sessions from public, anon, authenticated;
grant select on public.club_wod_sessions to authenticated;

-- is_community_member(), not `true`: an anonymous sign-in session holds a
-- real authenticated JWT and nothing else (202609060001). Same predicate
-- club_wods_read, announcements_read and weekly_challenges_read carry.
drop policy if exists club_wod_sessions_read on public.club_wod_sessions;
create policy club_wod_sessions_read on public.club_wod_sessions
  for select to authenticated
  using (public.is_community_member());

-- =====================================================================
-- 3. public.club_wod_results - one member's result on one board
-- =====================================================================
create table if not exists public.club_wod_results (
  session_id uuid not null references public.club_wod_sessions(id) on delete cascade,

  -- on delete cascade, unlike every other profile reference in this file:
  -- this row is the MEMBER'S OWN DATA on a club surface, and it must leave
  -- with them. A departing member's result is not the club's record.
  user_id uuid not null references public.profiles(id) on delete cascade,

  -- The private_records / IndexedDB entry id this figure came from. Kept so
  -- a repeat attach of the same entry writes nothing and so the client can
  -- deep-link the member to their own logged workout. Null when the member
  -- attached with no resolvable entry.
  record_id text check (record_id is null or char_length(record_id) between 1 and 160),

  -- SERVER-FORMATTED, always: wod_entry_result_text() over a normalised
  -- entry. No caller-supplied string ever lands here, so the board cannot
  -- carry a message past post moderation. Null is a real, rendered state -
  -- participation with no figure.
  result_text text check (result_text is null or char_length(result_text) between 1 and 240),

  score_type text check (score_type is null or score_type in ('time', 'amrap', 'load', 'emom')),
  rx boolean,
  -- The entry's OWN date, which is not always the session date - a member
  -- who did Thursday's programming on Friday attaches honestly and the
  -- client can say so.
  occurred_on date,

  attached_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- ONE MEMBER, ONE ROW, ONE BOARD. This is the answer to "what if they log
  -- it twice": a second attach replaces the figure, because the member is
  -- choosing which attempt the club sees.
  primary key (session_id, user_id)
);

-- session_id leads the primary key. user_id needs its own for the profile
-- cascade (DB-M3) and for "my results" lookups.
create index if not exists club_wod_results_user_idx
  on public.club_wod_results(user_id, attached_at desc);

drop trigger if exists club_wod_results_touch on public.club_wod_results;
create trigger club_wod_results_touch before update on public.club_wod_results
  for each row execute function public.touch_updated_at();

comment on table public.club_wod_results is
  'One member''s own result attached to one club_wod_sessions board. NOTHING AUTO-PUBLISHES INTO THIS TABLE: there is no trigger from private_records, attendance_log or workout_posts and there must never be one. The only writer is club_wod_attach_result(), called by the member, for their own record id, with auth.uid() checked first - syncing your training log and publishing it stay two different acts. Results are NOT posts, deliberately: attaching costs no feed slot, which is both why a member will do it and why fifteen results cannot become fifteen cards. PRIVACY, in two independent layers matching feed_page: being LISTED is governed by the subject''s visible_to_club (they attached deliberately, so participation is consented), and the FIGURE is governed by their show_workout_results, which DEFAULTS FALSE - result_text comes back null with result_hidden true, exactly as COMM-018 strips a POST_WORKOUT''s result without removing the post. The RLS policy is the harder of the two: a direct select can only ever return the caller''s own row or a row whose owner''s show_workout_results the caller may view, so no figure escapes over PostgREST even if a read RPC were wrong. Stores the FORMATTED result and four scalars only - never the entry - because a club-visible table is the wrong place to keep a copy of anyone''s log. NOT A LEADERBOARD and unable to become one: no score_value, no score_direction, no rank, ordered by attached_at, rx and scaled in one list.';

comment on column public.club_wod_results.result_text is
  'Server-formatted by wod_entry_result_text() from the member''s OWN normalised entry - the private_records copy when one exists, the attach call''s p_entry when cloud backup is off. No caller string is ever stored, so the board cannot smuggle text past post moderation. NULL is a real state the board renders: participation with no figure, which is what a member with no server copy and no supplied entry gets, and what a half-filled log entry gets (a zero score is deliberately not published as "0:00").';

alter table public.club_wod_results enable row level security;
revoke all on public.club_wod_results from public, anon, authenticated;
grant select on public.club_wod_results to authenticated;

-- THE PROOF OBLIGATION FROM THE BRIEF, AS A POLICY: "a member cannot see
-- another member's result when show_workout_results is false".
--
-- This is intentionally STRICTER than the read RPC. The RPC is security
-- definer and crosses this boundary on purpose to reveal LESS than the row
-- - the member's name with the figure stripped - which is the shape COMM-018
-- established. The policy is the floor underneath it: over PostgREST, a
-- direct select on this table returns the caller's own rows and rows whose
-- owner's show_workout_results the caller may view, and nothing else. A bug
-- in a future read function therefore cannot leak a figure that the table
-- itself refuses to hand over.
--
-- can_view_profile_field() settles blocks in both directions, the
-- visible_to_club precondition and the caller's own rows in one call; the
-- explicit user_id = auth.uid() arm restates the self case so the policy
-- reads as its own rule rather than depending on that helper's first line.
drop policy if exists club_wod_results_read on public.club_wod_results;
create policy club_wod_results_read on public.club_wod_results
  for select to authenticated
  using (
    public.is_community_member()
    and (
      user_id = auth.uid()
      or public.can_view_profile_field(user_id, 'show_workout_results')
    )
  );

-- No insert, update or delete grant, for anyone. club_wod_attach_result()
-- and club_wod_detach_result() are the only write paths, which is what lets
-- attach carry the ownership probe, the session-window check, the
-- wodId match and the server-side formatting as one thing a client cannot
-- step around.

-- =====================================================================
-- 4. THE AUDIT LABELS
-- =====================================================================
-- Both constraints restated IN FULL by the migration that widens them last,
-- the module's convention since 202609010001. Two action types, not one:
-- 202609060022 was written because comment_moderate logged the same label
-- for taking a comment down and putting it back.
alter table public.admin_actions drop constraint if exists admin_actions_action_type_check;
alter table public.admin_actions add constraint admin_actions_action_type_check check (action_type in (
  'content_delete', 'content_hide', 'member_restrict', 'member_unrestrict',
  'role_change', 'challenge_edit', 'achievement_edit', 'privacy_config',
  'content_pin', 'content_unpin', 'report_review', 'member_of_week_publish',
  'monthly_recap_publish', 'club_feature_toggle', 'invite_created',
  'invite_revoked', 'shared_code_created', 'shared_code_status_changed',
  'onboarding_content_updated', 'member_password_reset', 'announcement_edit',
  'member_remove', 'invite_reclaimed',
  'club_wod_published', 'club_wod_edited', 'club_wod_retired', 'club_wod_restored',
  -- Programming a club WOD to a day, and withdrawing it.
  'club_wod_session_published', 'club_wod_session_cancelled'
));

alter table public.admin_actions drop constraint if exists admin_actions_target_type_check;
alter table public.admin_actions add constraint admin_actions_target_type_check check (target_type in (
  'post', 'comment', 'member', 'role', 'challenge', 'achievement',
  'event', 'announcement', 'report', 'club',
  'monthly_club_recap',
  'challenge_participant', 'challenge_team',
  'invite', 'invite_code',
  'onboarding_step',
  'club_wod',
  -- No member behind it, so log_admin_action() leaves target_user_id null:
  -- programming a day is an action on club content, not on a person. A
  -- MEMBER attaching their own result is not audited here at all -
  -- admin_actions is the staff log, and a member publishing their own
  -- result is not a staff act.
  'club_wod_session'
));

-- =====================================================================
-- 5. POST_CLUB_WOD IS A PRIVILEGED LABEL
-- =====================================================================
-- 202609060004's guard, widened by exactly one label. Without this a member
-- could PATCH their own POST_TEXT to POST_CLUB_WOD and mint a card the
-- client renders as club programming with a board under it.
--
-- The predicate is unchanged and is deliberately the same one feed_page
-- computes as author_is_staff. Every role holding
-- community.challenge.create - the permission club_wod_session_publish()
-- requires - is ranked at or above coach (20), so the RPC and this guard
-- can never disagree about who may author the card.
create or replace function public.workout_posts_guard_privileged_type() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- An UPDATE that names post_type in its SET list fires this trigger even
  -- when the value does not move. Editing the caption of a real coach post
  -- must not be refused.
  if tg_op = 'UPDATE' and new.post_type is not distinct from old.post_type then
    return new;
  end if;

  if new.post_type not in (
    'POST_COACH', 'POST_ANNOUNCEMENT', 'POST_SYSTEM', 'POST_NEW_MEMBER',
    'POST_CLUB_WOD'
  ) then
    return new;
  end if;

  -- Server-authored rows. Every real producer of these labels is here.
  if new.author_id is null then
    return new;
  end if;

  if exists (
        select 1 from public.invite_redemptions ir
        where ir.user_id = new.author_id and public.role_rank(ir.role) >= 20
      )
     or exists (
        select 1 from public.profiles pf
        where pf.id = new.author_id and pf.is_admin and pf.deleted_at is null
      )
  then
    return new;
  end if;

  raise exception 'post type is staff only';
end $$;
revoke all on function public.workout_posts_guard_privileged_type() from public, anon, authenticated;

comment on function public.workout_posts_guard_privileged_type() is
  'Launch-readiness audit, widened for POST_CLUB_WOD. BEFORE INSERT OR UPDATE OF post_type on workout_posts. Raises ''post type is staff only'' (P0001) when a row would carry POST_COACH, POST_ANNOUNCEMENT, POST_SYSTEM, POST_NEW_MEMBER or POST_CLUB_WOD and its author_id is a member who is neither redeemed at role_rank >= 20 nor profiles.is_admin - the identical predicate feed_page computes as author_is_staff, so the badge, the +10 coach ranking weight and the coach feed scope cannot be self-awarded, and a member cannot mint a card the client renders as club programming. Every role holding community.challenge.create, which club_wod_session_publish() requires, is ranked at or above coach (20), so the RPC and this guard cannot disagree. author_id is null is exempt: every legitimate producer of the authorless labels writes an authorless row. An UPDATE that leaves post_type unchanged returns early. Applies on every write path including the service role: the rule is a fact about the row''s author, not about the session.';

-- =====================================================================
-- 6. club_wod_board_json() - the one definition of "a board"
-- =====================================================================
-- Shared by the two reads and returned by all four write RPCs, so the
-- board a client renders after attaching is the same object it renders
-- after reloading and the two can never disagree - club_wod_json()'s
-- reason (202609060028 section 2), applied to a shape with privacy in it.
--
-- SECURITY DEFINER, with NO CLIENT GRANT. It crosses club_wod_results_read
-- on purpose and in one direction only: to reveal a member's PARTICIPATION
-- (which they consented to by attaching) while the policy underneath keeps
-- refusing their FIGURE. Every privacy decision in the board is here, once.
--
-- EVERY KEY IS ALWAYS PRESENT. The empty board, the cancelled board and the
-- board the viewer has not attached to are all renderable without the
-- client testing for absence - see decision 5.
create or replace function public.club_wod_board_json(p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_s public.club_wod_sessions;
  v_w public.club_wods;
  v_has_wod boolean := false;
  v_results jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_viewer jsonb;
  v_closed text;
  v_by jsonb;
begin
  if v_uid is null then return null; end if;
  select * into v_s from public.club_wod_sessions s where s.id = p_session_id;
  if not found then return null; end if;

  select * into v_w from public.club_wods w where w.wod_id = v_s.wod_id;
  v_has_wod := found;

  -- The board. Ordered by attached_at - the order people trained in - and
  -- NEVER by anything score-shaped; see decision 6.
  --
  -- result_count is COUNTED OVER THE SAME FILTERED SET as the list, so it
  -- can never disclose the existence of a member the viewer may not see.
  select coalesce(jsonb_agg(t.j order by t.attached_at, t.user_id), '[]'::jsonb),
         count(*)::integer
    into v_results, v_count
  from (
    select r.user_id, r.attached_at,
           jsonb_build_object(
             'user_id', r.user_id,
             'display_name', p.display_name,
             'handle', p.handle,
             'avatar_url', p.avatar_url,
             'is_viewer', (r.user_id = v_uid),
             'result_text', case when g.may_see_result then r.result_text else null end,
             -- The client can say "hidden" rather than "no result", which
             -- are different facts about a member.
             'result_hidden', (r.result_text is not null and not g.may_see_result),
             'score_type', r.score_type,
             'rx', r.rx,
             'occurred_on', r.occurred_on,
             'attached_at', r.attached_at
           ) as j
    from public.club_wod_results r
    join public.profiles p on p.id = r.user_id and p.deleted_at is null
    cross join lateral (
      select
        -- LISTED: consented by attaching, still subject to the member's own
        -- club visibility and to a block edge in either direction.
        (r.user_id = v_uid or public.can_view_profile_field(r.user_id, 'visible_to_club')) as may_list,
        -- THE FIGURE: show_workout_results, which DEFAULTS FALSE.
        (r.user_id = v_uid or public.can_view_profile_field(r.user_id, 'show_workout_results')) as may_see_result
    ) g
    where r.session_id = v_s.id
      and g.may_list
  ) t;

  -- The viewer's own row, always full: can_view_profile_field returns true
  -- for the subject themselves, so nothing of theirs is ever stripped.
  select jsonb_build_object(
           'attached', true,
           'result_text', r.result_text,
           'score_type', r.score_type,
           'rx', r.rx,
           'occurred_on', r.occurred_on,
           'attached_at', r.attached_at)
    into v_viewer
  from public.club_wod_results r
  where r.session_id = v_s.id and r.user_id = v_uid;

  if v_viewer is null then
    v_viewer := jsonb_build_object(
      'attached', false, 'result_text', null, 'score_type', null,
      'rx', null, 'occurred_on', null, 'attached_at', null);
  end if;

  -- Why the attach control is unavailable, so the client can SAY it rather
  -- than hide a button. The same three conditions club_wod_attach_result()
  -- raises on, asked in the same order, so the board and the write agree.
  v_closed := case
    when v_s.cancelled_at is not null then 'cancelled'
    when v_s.session_date > current_date then 'future'
    when v_s.session_date < current_date - 14 then 'expired'
    else null
  end;

  v_viewer := v_viewer
    || jsonb_build_object(
         'can_attach', (v_closed is null),
         -- Detaching is ALWAYS available, including from a cancelled or
         -- expired board. A member must be able to take their result down.
         'can_detach', (v_viewer ->> 'attached')::boolean,
         'closed_reason', v_closed);

  select jsonb_build_object(
           'id', pf.id, 'display_name', pf.display_name,
           'handle', pf.handle, 'avatar_url', pf.avatar_url)
    into v_by
  from public.profiles pf where pf.id = v_s.published_by and pf.deleted_at is null;

  return jsonb_build_object(
    'session_id', v_s.id,
    'session_date', v_s.session_date,
    'note', v_s.note,
    'post_id', v_s.post_id,
    'published_at', v_s.published_at,
    'published_by', v_by,
    'cancelled_at', v_s.cancelled_at,
    'wod', case when v_has_wod then public.club_wod_json(v_w) else null end,
    'result_count', v_count,
    'results', v_results,
    'viewer', v_viewer
  );
end $$;
revoke all on function public.club_wod_board_json(uuid) from public, anon, authenticated;

comment on function public.club_wod_board_json(uuid) is
  'Internal. The single definition of "a club WOD board": {session_id, session_date, note, post_id, published_at, published_by{id,display_name,handle,avatar_url}|null, cancelled_at, wod (club_wod_json shape, null if the catalogue row vanished), result_count, results[], viewer{attached,result_text,score_type,rx,occurred_on,attached_at,can_attach,can_detach,closed_reason}}. Returned by both reads AND by all four write RPCs, so the board rendered after attaching and the board rendered after reloading cannot disagree. EVERY KEY IS ALWAYS PRESENT, so the empty, cancelled and not-yet-attached states need no absence tests. SECURITY DEFINER with no client grant: it crosses club_wod_results_read in ONE direction only, to reveal a member''s participation (consented by attaching) while the policy keeps refusing their figure. Each row is listed only when the viewer passes can_view_profile_field(member, ''visible_to_club'') - which also settles block edges both ways - and carries result_text only when they pass can_view_profile_field(member, ''show_workout_results''), which DEFAULTS FALSE; otherwise result_text is null and result_hidden is true. result_count is counted over the SAME filtered set as the list, so it cannot disclose a member the viewer may not see. Ordered by attached_at, never by score: there is no ranking here and no column to build one from. Returns null for an unknown session or a null caller. Unpaged: one board is one club-day, and its ceiling is the club''s daily attendance.';

-- =====================================================================
-- 7. THE READS
-- =====================================================================
-- SECURITY DEFINER, with the two gates stated inline in the module's order
-- (202609060009): auth.uid() first, then is_community_member(), so an
-- anonymous-session JWT gets an honest message and not an empty list.
create or replace function public.club_wod_board(p_session_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_board jsonb;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if p_session_id is null then raise exception 'session not found'; end if;
  v_board := public.club_wod_board_json(p_session_id);
  if v_board is null then raise exception 'session not found'; end if;
  return v_board;
end $$;
revoke all on function public.club_wod_board(uuid) from public, anon;
grant execute on function public.club_wod_board(uuid) to authenticated;

comment on function public.club_wod_board(uuid) is
  'One club WOD board by session id, in the club_wod_board_json shape. This is what the client calls from a POST_CLUB_WOD feed card, whose metadata carries club_wod_session_id. AUTH: security definer; auth.uid() (''not authorized''), then is_community_member() (''recovery method required''). Raises ''session not found'' for a null or unknown id. RETURNS A CANCELLED SESSION TOO, with cancelled_at set and viewer.closed_reason ''cancelled'': a member who has a result on a board that was withdrawn must still be able to see it and detach. Read-only.';

-- The range read. Defaults to TODAY, which is the whole product: "open the
-- club and see today's programming and how everyone did".
--
-- Cancelled sessions are excluded here and only here. The list answers
-- "what is the club doing"; a withdrawn session is not an answer to that,
-- and club_wod_board() by id remains the way to reach one.
create or replace function public.club_wod_boards(
  p_from date default null,
  p_to date default null
) returns setof jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_from date;
  v_to date;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;

  v_from := coalesce(p_from, current_date);
  v_to := coalesce(p_to, v_from);
  -- Clamped rather than raised on: a reversed or absurd range is a client
  -- bug, and returning the day the caller clearly meant beats an error the
  -- member sees. 14 days is the attach window, so a wider one could only
  -- return boards nobody can still contribute to.
  if v_to < v_from then v_to := v_from; end if;
  if v_to > v_from + 13 then v_to := v_from + 13; end if;

  return query
    select public.club_wod_board_json(s.id)
    from public.club_wod_sessions s
    where s.club_id = public.default_club_id()
      and s.session_date between v_from and v_to
      and s.cancelled_at is null
    order by s.session_date desc, s.published_at desc;
end $$;
revoke all on function public.club_wod_boards(date, date) from public, anon;
grant execute on function public.club_wod_boards(date, date) to authenticated;

comment on function public.club_wod_boards(date, date) is
  'Live club WOD boards for a date range, newest day first, each in the club_wod_board_json shape. BOTH ARGUMENTS DEFAULT TO NULL AND THAT MEANS TODAY - club_wod_boards() with no arguments is the "today''s programming" call the club home strip is built from; p_to defaults to p_from when only one is given. The range is CLAMPED, not refused: a reversed range collapses to one day and a span over 14 days is truncated to p_from + 13, because 14 days is the attach window and a wider range could only return boards nobody can still contribute to. EXCLUDES CANCELLED SESSIONS - the list answers "what is the club doing", and club_wod_board(id) is how a withdrawn board is still reached. AUTH: security definer; auth.uid() (''not authorized''), then is_community_member() (''recovery method required''). Read-only.';

-- =====================================================================
-- 8. club_wod_session_publish()
-- =====================================================================
-- Gates in the module's standing order: a real caller, the idempotency
-- claim, is_community_member(), then the permission.
--
-- NOT RATE LIMITED, and the app.allow_unrated_post_insert pin is set around
-- the card's INSERT so publishing does not spend the coach's composer
-- budget either. That is not a gap: the bound on this write is STRUCTURAL
-- and stronger than a rate limit - the session date must be within one day
-- of today and at most 4 live sessions may exist per day, so the feed can
-- gain at most a handful of these cards a day no matter how often the RPC
-- is called. club_wod_publish() is unrated for the same reason.
create or replace function public.club_wod_session_publish(
  p_wod_id text,
  p_session_date date default null,
  p_note text default '',
  p_idempotency_key uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_replay boolean;
  v_prior jsonb;
  v_ctrl text;
  v_wod_id text;
  v_date date;
  v_note text;
  v_wod public.club_wods;
  v_existing public.club_wod_sessions;
  v_found boolean := false;
  v_session public.club_wod_sessions;
  v_post_id uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('club_wod_session_publish', p_idempotency_key) i;
  -- A replay re-reads the board rather than returning a stored copy of it,
  -- so a retried request never hands back a stale roll call.
  if v_replay then
    return public.club_wod_board_json(nullif(v_prior #>> '{}', '')::uuid);
  end if;

  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if not public.has_perm('community.challenge.create') then raise exception 'not authorized'; end if;

  v_wod_id := btrim(coalesce(p_wod_id, ''));
  select * into v_wod from public.club_wods w where w.wod_id = v_wod_id;
  if not found then raise exception 'wod not found'; end if;
  -- A retired WOD is still READABLE (a member's history depends on it) but
  -- is out of circulation for new logs and new challenges - programming it
  -- to a day would be putting it straight back in.
  if v_wod.retired_at is not null then raise exception 'wod is retired'; end if;

  v_date := coalesce(p_session_date, current_date);
  -- The feed bound, decision 1. Yesterday covers a coach who forgot;
  -- tomorrow covers posting tonight for the morning class. A week of
  -- programming at once is a SCHEDULING feature and is deliberately not
  -- this one.
  if v_date < current_date - 1 or v_date > current_date + 1 then
    raise exception 'a session can only be posted for yesterday, today or tomorrow';
  end if;

  -- cleanStr()'s class exactly: 0x01-0x1F and 0x7F, built with chr() rather
  -- than [[:cntrl:]] for post_create's reason (202608280023) - a character
  -- class must not depend on the database LC_CTYPE when the text is Hebrew.
  v_ctrl := '[' || chr(1) || '-' || chr(31) || chr(127) || ']';
  v_note := left(btrim(regexp_replace(coalesce(p_note, ''), v_ctrl, '', 'g')), 500);

  select * into v_existing from public.club_wod_sessions s
   where s.wod_id = v_wod_id and s.session_date = v_date;
  v_found := found;

  if v_found and v_existing.cancelled_at is null then
    -- Idempotent for a double tap or a retried request: the identical note
    -- returns the board that is already there and writes nothing, not even
    -- an audit row.
    if v_existing.note = v_note then
      perform public.idem_complete('club_wod_session_publish', p_idempotency_key,
                                   to_jsonb(v_existing.id));
      return public.club_wod_board_json(v_existing.id);
    end if;
    -- club_wod_publish()'s snapshot rule, asked of this shape: a coach who
    -- retyped the note is TOLD it did not land, instead of quietly
    -- believing it did. Cancel and re-publish is the correction path, and
    -- it keeps the board.
    raise exception 'session already posted';
  end if;

  -- The per-day cap, counted over LIVE sessions. Applied on the re-publish
  -- path too: the cap is about the feed, not about this row's history.
  if (select count(*) from public.club_wod_sessions s
       where s.club_id = public.default_club_id()
         and s.session_date = v_date
         and s.cancelled_at is null) >= 4 then
    raise exception 'too many sessions posted for that day';
  end if;

  if v_found then
    -- Re-publishing a cancelled session is a NEW DECISION, not a retry, so
    -- it gets a fresh card and a fresh audit row. THE BOARD SURVIVES: the
    -- results are keyed on the session, not on the post, so members who had
    -- already attached do not have to do it again.
    update public.club_wod_sessions
       set cancelled_at = null, cancelled_by = null, cancelled_reason = null,
           note = v_note, published_by = v_uid, published_at = now(), post_id = null
     where id = v_existing.id
    returning * into v_session;
  else
    insert into public.club_wod_sessions (wod_id, session_date, note, published_by)
    values (v_wod_id, v_date, v_note, v_uid)
    returning * into v_session;
  end if;

  -- THE CARD. It carries NO member figures at all - no result_text, no
  -- comparison_key, no score_value, no rx - because it is programming, and
  -- every result lives in club_wod_results where the privacy rules are.
  -- That is also why feed_page's hide_result lateral (POST_WORKOUT and
  -- POST_PR only) has nothing to strip from it.
  --
  -- source_type and source_id are left NULL on purpose: source_type drives
  -- the client's "open the workout" deep link, and this card opens a BOARD.
  -- The session id travels in metadata, which feed_page passes through
  -- untouched for every post type outside POST_WORKOUT / POST_PR.
  perform set_config('app.allow_unrated_post_insert', 'on', true);
  insert into public.workout_posts (
    author_id, post_type, visibility, title, body, occurred_on,
    metadata, status, published_at)
  values (
    v_uid, 'POST_CLUB_WOD', 'club', v_wod.name, nullif(v_note, ''), v_date,
    jsonb_build_object(
      'club_wod_session_id', v_session.id,
      'club_wod_id', v_wod.wod_id,
      'session_date', v_date,
      'score_type', v_wod.score_type),
    'active', now())
  returning id into v_post_id;
  perform set_config('app.allow_unrated_post_insert', 'off', true);

  update public.club_wod_sessions set post_id = v_post_id
   where id = v_session.id
  returning * into v_session;

  perform public.log_admin_action(
    'club_wod_session_published', 'club_wod_session', v_session.id,
    null,
    jsonb_build_object('wod_id', v_wod.wod_id, 'name', v_wod.name,
                       'session_date', v_date, 'post_id', v_post_id),
    v_wod.score_type);

  perform public.idem_complete('club_wod_session_publish', p_idempotency_key,
                               to_jsonb(v_session.id));
  return public.club_wod_board_json(v_session.id);
end $$;
revoke all on function public.club_wod_session_publish(text, date, text, uuid) from public, anon;
grant execute on function public.club_wod_session_publish(text, date, text, uuid) to authenticated;

comment on function public.club_wod_session_publish(text, date, text, uuid) is
  'Programs one catalogue WOD to one day: creates the club_wod_sessions row and its single POST_CLUB_WOD feed card, and returns the club_wod_board_json board. AUTH: security definer; auth.uid() (''not authorized''), is_community_member() (''recovery method required''), then has_perm(''community.challenge.create'') (''not authorized'') - the same permission club_wod_publish requires, and NOT is_staff(), which 202609060005 moved this family away from. DELIBERATELY SEPARATE FROM club_wod_publish(): a WOD published to the catalogue in March is programmed in September, and folding the two would mean re-publishing to re-program, which club_wod_publish refuses. p_session_date defaults to today and must be within ONE DAY of today (''a session can only be posted for yesterday, today or tomorrow''); with a cap of 4 live sessions per day (''too many sessions posted for that day'') that is the STRUCTURAL bound on how many of these cards the feed can gain, which is why the function is not rate limited and why the card''s insert runs inside the app.allow_unrated_post_insert pin. Raises ''wod not found'' and ''wod is retired''. p_note is control-stripped and capped at 500 exactly as cleanStr does, and lands both on the session row and in the card''s body. IDEMPOTENT twice over: the optional p_idempotency_key (202609060014), whose replay RE-READS the board rather than returning a stored copy, and the natural (wod_id, session_date) unique - a repeat call with an IDENTICAL note returns the existing board and writes nothing, while a CHANGED note raises ''session already posted'' rather than silently dropping the edit (club_wod_publish''s snapshot rule; cancel and re-publish is the correction path). Re-publishing a CANCELLED session is treated as a new decision: it clears the cancellation, mints a FRESH card and audits again, and THE BOARD SURVIVES because results are keyed on the session, not the post. The card carries no member figures of any kind - no result_text, comparison_key, score_value or rx - and leaves source_type/source_id null; the session id travels in metadata as club_wod_session_id alongside club_wod_id, session_date and score_type. SIDE EFFECTS: one club_wod_sessions row created or revived, one workout_posts row, one admin_actions row (''club_wod_session_published'' on target_type ''club_wod_session'', no target_user_id - programming a day is an action on club content, not on a person).';

-- =====================================================================
-- 9. club_wod_session_cancel()
-- =====================================================================
-- The correction path, and the reason the "changed note raises" rule above
-- is livable. It WITHDRAWS the card and closes the board; it does not
-- delete anything. Members' attached results survive so that a re-publish
-- restores the day intact, and so that a member can still detach.
create or replace function public.club_wod_session_cancel(
  p_session_id uuid,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_existing public.club_wod_sessions;
  v_row public.club_wod_sessions;
  v_reason text;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if not public.has_perm('community.challenge.create') then raise exception 'not authorized'; end if;

  select * into v_existing from public.club_wod_sessions s where s.id = p_session_id;
  if not found then raise exception 'session not found'; end if;
  -- Already cancelled: idempotent, no second audit row. Cancelling twice is
  -- a retry, not a new decision.
  if v_existing.cancelled_at is not null then
    return public.club_wod_board_json(v_existing.id);
  end if;

  v_reason := nullif(left(btrim(regexp_replace(coalesce(p_reason, ''),
                 '[' || chr(1) || '-' || chr(31) || chr(127) || ']', '', 'g')), 500), '');

  update public.club_wod_sessions
     set cancelled_at = now(), cancelled_by = v_uid, cancelled_reason = v_reason
   where id = v_existing.id
  returning * into v_row;

  -- deleted_at ONLY, and status left 'active'. Every reader filters
  -- deleted_at is null, so the card leaves the feed - but status 'removed'
  -- is the MODERATION label (post_delete sets both), and a coach
  -- withdrawing their own programming is not a moderator acting on content.
  -- The write needs the transaction-local app.allow_moderation_write pin
  -- because workout_posts_guard_moderated_fields (202609060011) refuses any
  -- authenticated change to deleted_at; this is the same documented
  -- mechanism post_delete(), request_account_deletion() and
  -- admin_remove_member() use, set and cleared around this one UPDATE.
  if v_existing.post_id is not null then
    perform set_config('app.allow_moderation_write', 'on', true);
    update public.workout_posts p
       set deleted_at = now()
     where p.id = v_existing.post_id and p.deleted_at is null;
    perform set_config('app.allow_moderation_write', 'off', true);
  end if;

  perform public.log_admin_action(
    'club_wod_session_cancelled', 'club_wod_session', v_row.id,
    jsonb_build_object('wod_id', v_row.wod_id, 'session_date', v_row.session_date,
                       'cancelled_at', null, 'post_id', v_existing.post_id),
    jsonb_build_object('wod_id', v_row.wod_id, 'session_date', v_row.session_date,
                       'cancelled_at', v_row.cancelled_at),
    null, v_reason);

  return public.club_wod_board_json(v_row.id);
end $$;
revoke all on function public.club_wod_session_cancel(uuid, text) from public, anon;
grant execute on function public.club_wod_session_cancel(uuid, text) to authenticated;

comment on function public.club_wod_session_cancel(uuid, text) is
  'Withdraws a programmed session: stamps cancelled_at/by/reason, removes the card from the feed and closes the board to new attachments. THE ONLY EXIT, and it DELETES NOTHING - members'' attached results survive, so a re-publish through club_wod_session_publish() restores the day intact and a member can still detach from a withdrawn board. AUTH: security definer; auth.uid(), is_community_member(), has_perm(''community.challenge.create''). Raises ''session not found''. Cancelling an already-cancelled session returns its board unchanged and writes no second audit row (a retry is not a new decision). The card is removed by setting workout_posts.deleted_at ONLY, leaving status ''active'': every reader filters deleted_at, but ''removed'' is the moderation label and a coach withdrawing their own programming is not a moderator acting on content. That UPDATE runs inside the transaction-local app.allow_moderation_write pin because workout_posts_guard_moderated_fields (202609060011) refuses any authenticated change to deleted_at. p_reason is control-stripped, capped at 500 and lands in admin_actions.note. Returns the club_wod_board_json board with cancelled_at set. Audits ''club_wod_session_cancelled'' with before and after.';

-- =====================================================================
-- 10. club_wod_attach_result() - the member-facing write
-- =====================================================================
-- THE ONLY WRITER TO club_wod_results, and the whole privacy boundary of
-- this feature. Read decision 2 and decision 3 before changing it.
--
-- WHAT IT WILL NOT DO, stated as code below and as a promise here:
--   * it will not read another member's record (the ownership probe);
--   * it will not store a caller-supplied string (the figure is FORMATTED
--     here from structured, clamped fields);
--   * it will not attach a result for a DIFFERENT workout to this board;
--   * and there is no trigger anywhere that calls it, so no logging,
--     syncing or attendance write can ever publish a member's result.
--
-- THE FIGURE'S SOURCE, in pr_share()'s three-case shape (202609060019):
--   a. the caller's own private_records wod_entry -> USED. This is the
--      normal path and the figure is recomputed here, not trusted.
--   b. no server copy of this record_id anywhere  -> the call's p_entry is
--      used instead, normalised identically. Cloud backup is opt-OUT
--      (enableSyncIfAllowed / backupOptedOut), so a member may simply have
--      no server copy, and reading only from private_records would make
--      this feature fail for exactly the members most protective of their
--      data. Nothing about p_entry is trusted for access: it names no
--      member, grants nothing, and every number in it is clamped to
--      sanitizeWodEntry's LIMITS before it is formatted.
--   c. the record_id is SOMEBODY ELSE'S wod_entry -> REFUSED,
--      'not authorized'. Without this a member could attach under another
--      member's entry id.
-- With neither (a) nor (b) the attach still SUCCEEDS with result_text null:
-- participation without a figure is a real, rendered state (decision 5).
create or replace function public.club_wod_attach_result(
  p_session_id uuid,
  p_record_id text,
  p_entry jsonb default null,
  p_idempotency_key uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_replay boolean;
  v_prior jsonb;
  v_s public.club_wod_sessions;
  v_record text;
  v_payload jsonb;
  v_entry jsonb;
  v_result text;
  v_score text;
  v_rx boolean;
  v_occurred date;
  v_existing public.club_wod_results;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('club_wod_attach_result', p_idempotency_key) i;
  if v_replay then
    return public.club_wod_board_json(nullif(v_prior #>> '{}', '')::uuid);
  end if;

  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  -- community.post.create, held by every role including member: putting a
  -- result on the club board is contributing content, and a member the club
  -- has restricted from posting must not be able to route around that.
  if not public.has_perm('community.post.create') then raise exception 'not authorized'; end if;
  if public.is_posting_restricted(v_uid) then raise exception 'posting_restricted'; end if;

  select * into v_s from public.club_wod_sessions s where s.id = p_session_id;
  if not found then raise exception 'session not found'; end if;

  -- The three closed states, in club_wod_board_json's order so the board's
  -- closed_reason and this function's refusal always agree.
  if v_s.cancelled_at is not null then raise exception 'this board is closed'; end if;
  if v_s.session_date > current_date then raise exception 'the session has not happened yet'; end if;
  -- Attaching stays open for 14 days: "I did Thursday's WOD on Saturday" is
  -- ordinary, and so is logging late. A board that never closed would let a
  -- year-old card change under a club that has long stopped looking at it.
  if v_s.session_date < current_date - 14 then raise exception 'this board is closed'; end if;

  -- 160 is private_records.record_id's own CHECK: an id longer than that
  -- cannot name a record in this database.
  v_record := btrim(coalesce(p_record_id, ''));
  if v_record = '' or char_length(v_record) > 160 then raise exception 'record is required'; end if;

  -- Case (c), checked before anything is read.
  if exists (
    select 1 from public.private_records pr
    where pr.record_type = 'wod_entry'
      and pr.record_id = v_record
      and pr.user_id <> v_uid
  ) then
    raise exception 'not authorized';
  end if;

  -- Case (a), then case (b).
  select pr.payload into v_payload
  from public.private_records pr
  where pr.user_id = v_uid
    and pr.record_type = 'wod_entry'
    and pr.record_id = v_record
    and pr.deleted_at is null;
  if not found then v_payload := p_entry; end if;

  v_entry := public.wod_entry_normalize(v_payload);
  if v_entry is not null then
    -- THE BOARD IS FOR ONE WORKOUT. Without this a member could attach
    -- their Fran time to the Murph board - by accident from a stale client
    -- as easily as on purpose - and the club would read a figure that means
    -- nothing. An entry whose wodId is absent cannot be confirmed and is
    -- refused for the same reason.
    if coalesce(v_entry ->> 'wodId', '') <> v_s.wod_id then
      raise exception 'that result is for a different workout';
    end if;
    v_result := public.wod_entry_result_text(v_entry);
    v_score := v_entry ->> 'scoreType';
    v_rx := (v_entry ->> 'rx')::boolean;
    v_occurred := nullif(v_entry ->> 'date', '')::date;
  end if;

  select * into v_existing from public.club_wod_results r
   where r.session_id = v_s.id and r.user_id = v_uid;
  -- Nothing to change: a double tap, or a retry after a dropped response,
  -- converges on the row already there and writes nothing. Ahead of the
  -- rate limit, so it costs no budget.
  if found
     and v_existing.record_id is not distinct from v_record
     and v_existing.result_text is not distinct from v_result
     and v_existing.score_type is not distinct from v_score
     and v_existing.rx is not distinct from v_rx
     and v_existing.occurred_on is not distinct from v_occurred then
    perform public.idem_complete('club_wod_attach_result', p_idempotency_key, to_jsonb(v_s.id));
    return public.club_wod_board_json(v_s.id);
  end if;

  -- Its OWN key, not post_create's: attaching must never spend a member's
  -- composer budget, and a member who attaches to four boards in a morning
  -- must not then be unable to post.
  if not public.check_rate_limit('club_wod_attach', 20, 10) then
    raise exception 'rate_limited';
  end if;

  -- One member, one row, one board. A second attach REPLACES the figure -
  -- the member is choosing which of their attempts the club sees - and
  -- attached_at is deliberately NOT bumped, so re-attaching cannot be used
  -- to move up a board that is ordered by it.
  insert into public.club_wod_results
    (session_id, user_id, record_id, result_text, score_type, rx, occurred_on)
  values
    (v_s.id, v_uid, v_record, v_result, v_score, v_rx, v_occurred)
  on conflict (session_id, user_id) do update
    set record_id = excluded.record_id,
        result_text = excluded.result_text,
        score_type = excluded.score_type,
        rx = excluded.rx,
        occurred_on = excluded.occurred_on;

  perform public.idem_complete('club_wod_attach_result', p_idempotency_key, to_jsonb(v_s.id));
  return public.club_wod_board_json(v_s.id);
end $$;
revoke all on function public.club_wod_attach_result(uuid, text, jsonb, uuid) from public, anon;
grant execute on function public.club_wod_attach_result(uuid, text, jsonb, uuid) to authenticated;

comment on function public.club_wod_attach_result(uuid, text, jsonb, uuid) is
  'Attaches the CALLER''S OWN logged result to a club WOD board and returns the whole updated board (club_wod_board_json), so the client re-renders in one round trip. THE ONLY WRITER TO club_wod_results: there is no trigger from private_records, attendance_log or workout_posts and there must never be one, so no logging or syncing act can ever publish a member''s result. AUTH: security definer; auth.uid() (''not authorized''), is_community_member() (''recovery method required''), has_perm(''community.post.create'') (''not authorized''), is_posting_restricted (''posting_restricted''). Raises ''session not found''; ''this board is closed'' (cancelled, or the session date is over 14 days old); ''the session has not happened yet'' (a session posted for tomorrow); ''record is required'' (blank or over 160 chars); ''not authorized'' again when p_record_id is a DIFFERENT member''s wod_entry; ''that result is for a different workout'' when the entry''s wodId is not this session''s, or is absent and so cannot be confirmed; and ''rate_limited'' past 20 per 10 minutes on its OWN club_wod_attach key, never post_create''s - attaching must not spend a member''s composer budget. THE FIGURE IS RECOMPUTED, NEVER TRUSTED: it is wod_entry_result_text() over wod_entry_normalize() of the caller''s own private_records wod_entry, falling back to p_entry (same normalisation, same clamps) only when NO server copy of that record_id exists, because cloud backup is opt-out. With neither, the attach still succeeds with result_text null - participation without a figure is a real state the board renders. NO CALLER STRING IS EVER STORED. IDEMPOTENT twice over: the optional p_idempotency_key, whose replay re-reads the board, and the natural (session_id, user_id) primary key - an attach that would change nothing writes nothing and costs no rate-limit budget, while a second attach with a different entry REPLACES the figure without bumping attached_at, so re-attaching cannot move a member up a board ordered by it. Writes no admin_actions row: a member publishing their own result is not a staff act.';

-- =====================================================================
-- 11. club_wod_detach_result()
-- =====================================================================
-- THE PER-ROW PRIVACY CONTROL, and the reason no twelfth toggle was added.
-- It carries NO permission check and NO restriction check beyond being a
-- real community member, and NO window check: taking your own result off a
-- club surface must never be blocked - not by a cancelled board, not by an
-- expired one, and not by a posting restriction, which exists to stop
-- someone ADDING content.
create or replace function public.club_wod_detach_result(p_session_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_board jsonb;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;

  v_board := public.club_wod_board_json(p_session_id);
  if v_board is null then raise exception 'session not found'; end if;

  -- Deleting nothing is a success, not an error: a double tap on "remove"
  -- means the row is gone, which is what the member asked for.
  delete from public.club_wod_results r
   where r.session_id = p_session_id and r.user_id = v_uid;

  return public.club_wod_board_json(p_session_id);
end $$;
revoke all on function public.club_wod_detach_result(uuid) from public, anon;
grant execute on function public.club_wod_detach_result(uuid) to authenticated;

comment on function public.club_wod_detach_result(uuid) is
  'Removes the caller''s own result from a club WOD board and returns the updated board. THE PER-ROW PRIVACY CONTROL, and the reason no twelfth privacy toggle was added for club boards. AUTH: security definer; auth.uid() (''not authorized'') then is_community_member() (''recovery method required'') and NOTHING ELSE - deliberately no permission check, no is_posting_restricted check and no session-window check, because taking your own result off a club surface must never be blocked: not by a cancelled board, not by an expired one, and not by a restriction that exists to stop someone ADDING content. Raises ''session not found'' for an unknown session. Deleting nothing is a success - a double tap means the row is gone, which is what was asked. Writes no admin_actions row.';

commit;
