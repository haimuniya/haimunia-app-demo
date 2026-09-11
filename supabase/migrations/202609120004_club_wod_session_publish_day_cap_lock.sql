begin;

-- Security hunt, round 7 (2026-09-12), race-condition agent.
--
-- club_wod_session_publish()'s per-day cap (202609080002) is a
-- count-then-insert check with no lock behind it, and the function's own
-- doc comment calls this cap "the STRUCTURAL bound on how many of these
-- cards the feed can gain" - the explicit reason the function carries no
-- rate limit. Confirmed live against real local Postgres: with 3 live
-- sessions already posted for one date (cap 4), two staff sessions each
-- publishing a different WOD to that same date, concurrently, both read
-- count=3 before either committed and both landed - 5 live sessions (and
-- 5 POST_CLUB_WOD feed cards) against a stated cap of 4.
--
-- There is no single row to SELECT ... FOR UPDATE here (the cap is over a
-- set of rows that does not exist yet for a fresh date), so this uses a
-- transaction-scoped advisory lock keyed by club + date to serialize the
-- count-check-insert section across concurrent callers targeting the same
-- day - the standard fix for a count-bound with no natural row to lock.

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
  v_club_id uuid;
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

  -- Security hunt round 7: serialize the day cap's count-check-insert
  -- section per (club, date) before counting. Held for the rest of this
  -- transaction, so it also covers the insert further down - a second
  -- concurrent caller for the same day blocks here until the first
  -- commits, then counts the now-committed row.
  v_club_id := public.default_club_id();
  perform pg_advisory_xact_lock(hashtext('club_wod_session_publish:' || v_club_id::text || ':' || v_date::text));

  -- The per-day cap, counted over LIVE sessions. Applied on the re-publish
  -- path too: the cap is about the feed, not about this row's history.
  if (select count(*) from public.club_wod_sessions s
       where s.club_id = v_club_id
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
  'Programs one catalogue WOD to one day: creates the club_wod_sessions row and its single POST_CLUB_WOD feed card, and returns the club_wod_board_json board. AUTH: security definer; auth.uid() (''not authorized''), is_community_member() (''recovery method required''), then has_perm(''community.challenge.create'') (''not authorized'') - the same permission club_wod_publish requires, and NOT is_staff(), which 202609060005 moved this family away from. DELIBERATELY SEPARATE FROM club_wod_publish(): a WOD published to the catalogue in March is programmed in September, and folding the two would mean re-publishing to re-program, which club_wod_publish refuses. p_session_date defaults to today and must be within ONE DAY of today (''a session can only be posted for yesterday, today or tomorrow''); with a cap of 4 live sessions per day (''too many sessions posted for that day'') that is the STRUCTURAL bound on how many of these cards the feed can gain, which is why the function is not rate limited and why the card''s insert runs inside the app.allow_unrated_post_insert pin. The count-check-insert for that cap runs behind a transaction-scoped advisory lock keyed by (club, date) (security hunt round 7, 202609120004) - there is no row to SELECT ... FOR UPDATE for a cap over a set of rows that may not exist yet, so two concurrent callers targeting the same day now serialize instead of both reading a pre-insert count. Raises ''wod not found'' and ''wod is retired''. p_note is control-stripped and capped at 500 exactly as cleanStr does, and lands both on the session row and in the card''s body. IDEMPOTENT twice over: the optional p_idempotency_key (202609060014), whose replay RE-READS the board rather than returning a stored copy, and the natural (wod_id, session_date) unique - a repeat call with an IDENTICAL note returns the existing board and writes nothing, while a CHANGED note raises ''session already posted'' rather than silently dropping the edit (club_wod_publish''s snapshot rule; cancel and re-publish is the correction path). Re-publishing a CANCELLED session is treated as a new decision: it clears the cancellation, mints a FRESH card and audits again, and THE BOARD SURVIVES because results are keyed on the session, not the post. The card carries no member figures of any kind - no result_text, comparison_key, score_value or rx - and leaves source_type/source_id null; the session id travels in metadata as club_wod_session_id alongside club_wod_id, session_date and score_type. SIDE EFFECTS: one club_wod_sessions row created or revived, one workout_posts row, one admin_actions row (''club_wod_session_published'' on target_type ''club_wod_session'', no target_user_id - programming a day is an action on club content, not on a person).';

commit;
