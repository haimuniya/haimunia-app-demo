begin;

-- ===========================================================================
-- Contracts review of 202609060019: pr_share() reports a success it did not
-- perform. contracts.md raised it at line 1082 ("FLAGGED, not yet resolved")
-- and left the choice open. This migration makes it.
--
-- ---------------------------------------------------------------------------
-- THE DEFECT, and why it is ordinary rather than adversarial
-- ---------------------------------------------------------------------------
-- pr_share's natural-idempotency probe (202609060019, line 250) matches a
-- prior post on (author_id, source_type in ('strength_entry','wod_entry'),
-- source_record_id) and does NOT filter on post_type. The unique constraint
-- it is standing in for - workout_posts(author_id, source_type,
-- source_record_id), shipped in 202608260001 - does not include post_type
-- either, so one logged record owns exactly one slot in that table.
--
-- publishWorkout() (cloud.js) has always written into that same slot: it
-- upserts source_type = item.type ('strength_entry'/'wod_entry') and
-- source_record_id = item.id - the SAME entry.id pr_share is keyed on - with
-- on conflict (author_id, source_type, source_record_id) and no post_type,
-- so workout_posts_default_post_type() labels it POST_WORKOUT.
--
-- The reachable sequence is four ordinary taps:
--   1. member logs a set and shares that workout to the feed  -> POST_WORKOUT
--   2. the same set was a PR, so the app raises the PR prompt
--   3. member taps "שיתוף"
--   4. pr_share finds the POST_WORKOUT, returns ITS id, and inserts nothing
-- The client then shows "השיא שותף לקהילה" and emits POST_CREATED with
-- post_type "POST_PR" for a post that is a POST_WORKOUT. The member is told
-- their PR was shared, the note and photo they attached are discarded, and
-- the analytics stream records a POST_PR that does not exist.
--
-- Reproduced before this migration was written (m1, record 'set-repro'):
-- pr_share returned the POST_WORKOUT's id, `select count(*) ... where
-- post_type = 'POST_PR'` came back 0, and the note 'שיא חדש!' was nowhere.
--
-- ---------------------------------------------------------------------------
-- THE RESOLUTION: one record yields one post, and the PR share UPGRADES the
-- member's existing workout card into the PR card they asked for.
-- ---------------------------------------------------------------------------
-- The review offered three directions. Taking them in turn:
--
-- (A) Add post_type to the lookup AND to the unique constraint, so a workout
--     share and a PR share coexist as two posts.
--     REJECTED, and it is the one option that cannot land on its own.
--     Making the constraint four-column means DROPPING the three-column one,
--     and that three-column unique is the arbiter for publishWorkout()'s
--     `on conflict author_id,source_type,source_record_id`. With no matching
--     unique index Postgres raises 42P10 on that upsert, so the legacy
--     workout share - a path that works today for every member - breaks the
--     moment this deploys, and the repair lives in a file this agent does
--     not own. A migration that requires a simultaneous client change to
--     avoid a regression is not a safe migration.
--
-- (B) Give a PR share its own source_type so the two never contend.
--     REJECTED on product grounds, and on a second, concrete one. It is
--     landable alone, but it still ships two cards for one logged set, and
--     it destroys the one thing source_type is for on these rows: recording
--     which KIND of record the post came from. pr_share computes v_source_type
--     from the record precisely so the card's "פתיחת האימון" deep link
--     (renderPostCard emits data-source-type="${m.source_type ||
--     post.source_type || 'workout'}") points at the right kind of thing; a
--     literal 'pr' would hand the client's open-source handler a value it has
--     never seen. It would also need a new value in
--     workout_posts_source_type_check for no gain.
--
-- (C) Decide that one record yields one post, and make the member-visible
--     outcome true. CHOSEN, in its strong form: not "return the workout post
--     and reword the toast", but "turn that post into the PR post".
--
-- WHY ONE POST IS THE RIGHT PRODUCT ANSWER, not merely the cheap one.
-- Two cards for one set is noise in a club feed, and this feed's own ranking
-- makes it worse rather than absorbing it. feed_page classifies POST_WORKOUT
-- as diversity class 'workout' and POST_PR as class 'boost', and the
-- diversity pass explicitly PREFERS a boost card once a workout run reaches
-- its threshold. Two near-identical cards from one member about one set are
-- therefore actively steered ADJACENT to each other. The repetition penalty
-- (-6 per additional post by one author inside 24h, capped at -18) does not
-- undo that; it just also penalises the member's genuinely separate posts
-- later the same day. The member gets one worse feed slot and the club gets
-- the same set twice.
--
-- Upgrading in place gives the member exactly what the prompt promised: the
-- card for that set becomes the PR card, carrying their note, their photo,
-- and the improvement figures recomputed server-side. "השיא שותף לקהילה"
-- becomes a true sentence and POST_CREATED { post_type: "POST_PR" } names a
-- post that really is one - WITH NO CLIENT CHANGE REQUIRED. That is the
-- whole point of choosing this shape over the other two.
--
-- ---------------------------------------------------------------------------
-- WHAT THE UPGRADE DELIBERATELY DOES NOT TOUCH
-- ---------------------------------------------------------------------------
-- visibility. publishWorkout writes 'followers' (or 'public'); pr_share's
--   INSERT path writes 'club'. Promoting an existing 'followers' post to
--   'club' would widen a published post's audience without the member asking,
--   which is an identity-privacy boundary and not this function's to cross.
--   The upgraded post keeps the visibility it was published with - the same
--   principle ach_share already applies by inheriting the achievement's
--   visibility instead of hardcoding 'club'.
--
-- published_at. Bumping it to now() would let any member re-float an old post
--   to the top of every feed by calling pr_share on an old record id, which is
--   an amplification vector for a function reachable directly over PostgREST.
--   In the real flow the workout share and the PR prompt are seconds apart, so
--   holding the original timestamp costs nothing and closes that.
--
-- comparison_key. Left alone; the INSERT path never set it either, and the
--   leaderboard key belongs to the workout share that computed it.
--
-- A MODERATED POST IS REFUSED, NOT REVIVED. If status is 'hidden' or
--   'removed' a moderator acted on that card, and letting the author
--   re-publish the same content under a new post_type would be moderation
--   evasion. It raises 'post is not available' - an honest failure the client
--   already renders as "השיתוף נכשל", which is the correct thing to tell
--   someone whose post was removed.
--
-- A SOFT-DELETED POST IS REVIVED, because the member is at this moment
--   explicitly asking to publish this record to the feed. deleted_at is
--   cleared rather than the share silently doing nothing - the exact failure
--   mode this migration exists to end.
--
-- REACTIONS AND COMMENTS SURVIVE the upgrade. They are attached to the card
--   for that set, and it is still the card for that set. This is a considered
--   consequence, not an oversight.
--
-- THE MODERATED-FIELDS PIN. workout_posts_guard_moderated_fields
--   (202609060011) raises 'field is server derived' on any authenticated
--   UPDATE of status/deleted_at/score_value/score_direction/comparison_key/
--   published_at/is_pinned. The upgrade legitimately moves deleted_at,
--   score_value and score_direction - replacing publishWorkout's
--   CLIENT-SUPPLIED score with the one recomputed here from the caller's own
--   private_records - so it runs inside the transaction-local
--   app.allow_moderation_write pin, the same mechanism post_delete(),
--   request_account_deletion() and admin_remove_member() already use. The pin
--   is set and cleared around the single UPDATE and nowhere else.
--
-- THE NATURAL KEY, and why it still holds. Nothing about the unique
--   constraint changes, so there is NO migration cost on existing rows: no
--   constraint is dropped, no index is rebuilt, no row is rewritten, and
--   publishWorkout's on-conflict target keeps its arbiter. A repeat tap on
--   "שיתוף" now finds a POST_PR and returns it untouched, so the double-tap
--   convergence 202609060019 was built for is preserved exactly - and, as
--   before, it costs no rate-limit budget.
-- ===========================================================================

create or replace function public.pr_share(
  record_id text,
  note text default '',
  media jsonb default '[]'::jsonb,
  p_idempotency_key uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_body text;
  v_media_count integer := 0;
  v_post_id uuid;
  v_item jsonb;
  v_idx integer := 0;
  v_replay boolean;
  v_prior jsonb;
  v_rec public.private_records;
  v_prior_post public.workout_posts;
  v_upgrade boolean := false;
  v_payload jsonb := '{}'::jsonb;
  v_source_type text := 'strength_entry';
  v_metadata jsonb := '{}'::jsonb;
  v_title text;
  v_result text;
  v_prev_result text;
  v_improvement text;
  v_occurred date;
  v_weight numeric;
  v_reps numeric;
  v_duration numeric;
  v_est numeric;
  v_prev numeric;
  v_score numeric;
  v_exercise text;
  v_ts numeric;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('pr_share', p_idempotency_key) i;
  if v_replay then return nullif(v_prior #>> '{}', '')::uuid; end if;

  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if not public.has_perm('community.post.create') then raise exception 'not authorized'; end if;
  if public.is_posting_restricted(v_uid) then raise exception 'posting_restricted'; end if;

  -- 160 is private_records.record_id's own CHECK: an id longer than that
  -- cannot name a record in this database, so it is rejected as malformed
  -- rather than silently treated as case (c).
  if record_id is null or btrim(record_id) = '' or char_length(record_id) > 160 then
    raise exception 'record is required';
  end if;

  -- Case (a): the caller's own row. deleted_at is honoured - a record the
  -- member has since deleted is not something to publish figures from.
  select * into v_rec
  from public.private_records r
  where r.user_id = v_uid
    and r.record_type in ('strength_entry', 'wod_entry')
    and r.record_id = pr_share.record_id
    and r.deleted_at is null;

  if found then
    v_payload := coalesce(v_rec.payload, '{}'::jsonb);
    v_source_type := v_rec.record_type;
  else
    -- Case (b). Checked only when the caller does not own the id, so the
    -- normal path never pays for it.
    if exists (
      select 1 from public.private_records r
      where r.record_id = pr_share.record_id
        and r.record_type in ('strength_entry', 'wod_entry')
        and r.user_id <> v_uid
    ) then
      raise exception 'not authorized';
    end if;
    -- Case (c) falls through with an empty payload and publishes no figures.
  end if;

  -- ---------------------------------------------------------------
  -- The prior-post probe. THIS is what 202609060019 got wrong: it
  -- returned whatever post held the record's unique slot without ever
  -- asking what KIND of post it was.
  -- ---------------------------------------------------------------
  select * into v_prior_post
  from public.workout_posts p
  where p.author_id = v_uid
    and p.source_type in ('strength_entry', 'wod_entry')
    and p.source_record_id = pr_share.record_id
  limit 1;

  if found then
    -- Already the PR post. True idempotency: a double tap on "שיתוף", or a
    -- retry after a dropped response, converges on the first post and writes
    -- nothing. Ahead of the rate limit, so it costs no budget.
    if v_prior_post.post_type = 'POST_PR' then
      perform public.idem_complete('pr_share', p_idempotency_key, to_jsonb(v_prior_post.id));
      return v_prior_post.id;
    end if;

    -- The legacy workout share for this same record. Upgrade it in place;
    -- see the header for every field this does and does not move.
    if v_prior_post.post_type = 'POST_WORKOUT' then
      if v_prior_post.status <> 'active' then
        raise exception 'post is not available';
      end if;
      v_upgrade := true;
    else
      -- Not reachable from any shipped writer - post_create never sets
      -- source_record_id, and publishWorkout/pr_share are the only producers
      -- of a strength_entry/wod_entry row - but refusing loudly beats
      -- silently rewriting a post whose shape this function does not know.
      raise exception 'this record already has a post';
    end if;
  end if;

  if not public.check_rate_limit('post_create', 20, 10) then raise exception 'rate_limited'; end if;

  -- Body normalisation is post_create's, byte for byte.
  v_body := regexp_replace(
    coalesce(note, ''),
    '[' || chr(1) || '-' || chr(8) || chr(11) || '-' || chr(31) || ']',
    '', 'g');
  v_body := left(btrim(v_body), 1000);

  if media is not null and jsonb_typeof(media) = 'array' then
    v_media_count := jsonb_array_length(media);
  end if;
  if v_media_count > 4 then raise exception 'at most 4 photos per post'; end if;

  -- ---------------------------------------------------------------
  -- Everything below is recomputed from the record. Nothing is read
  -- from the request.
  -- ---------------------------------------------------------------
  if v_payload ->> 'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    v_occurred := (v_payload ->> 'date')::date;
  end if;

  v_exercise := nullif(v_payload ->> 'exerciseId', '');
  v_weight   := public.private_record_number(v_payload, 'weight');
  v_reps     := public.private_record_number(v_payload, 'reps');
  v_duration := public.private_record_number(v_payload, 'durationSeconds');
  v_est      := public.private_record_number(v_payload, 'est1RM');
  v_ts       := public.private_record_number(v_payload, 'ts');

  -- Only a custom movement is ever synced, so this resolves for some PRs
  -- and not others by design; see 202609060019's header.
  if v_exercise is not null then
    select nullif(left(btrim(coalesce(m.payload ->> 'name', '')), 120), '')
      into v_title
    from public.private_records m
    where m.user_id = v_uid and m.record_type = 'movement'
      and m.record_id = v_exercise and m.deleted_at is null;
  end if;

  if coalesce(v_payload ->> 'type', '') = 'duration' and v_duration is not null and v_duration > 0 then
    v_result := trim(trailing '.' from to_char(v_duration, 'FM999999990.99')) || ' שנ׳';
    if v_weight is not null and v_weight > 0 then
      v_result := trim(trailing '.' from to_char(v_weight, 'FM999999990.99')) || ' ק"ג · ' || v_result;
    end if;
    v_score := v_duration;
  elsif v_weight is not null and v_reps is not null and v_reps > 0 then
    v_result := trim(trailing '.' from to_char(v_weight, 'FM999999990.99')) || ' ק"ג × '
             || trim(trailing '.' from to_char(v_reps, 'FM999999990'));
    v_score := coalesce(v_est, v_weight);
  end if;

  -- The previous best for the SAME movement at the SAME rep count, from the
  -- caller's own history, excluding this record and anything logged after
  -- it. The only source of previous_result / improvement anywhere here.
  if v_exercise is not null and v_weight is not null and v_reps is not null and v_reps > 0 then
    select max(public.private_record_number(r.payload, 'weight')) into v_prev
    from public.private_records r
    where r.user_id = v_uid
      and r.record_type = 'strength_entry'
      and r.deleted_at is null
      and r.record_id <> pr_share.record_id
      and r.payload ->> 'exerciseId' = v_exercise
      and public.private_record_number(r.payload, 'reps') = v_reps
      and (v_ts is null or coalesce(public.private_record_number(r.payload, 'ts'), 0) < v_ts);

    if v_prev is not null and v_prev > 0 and v_weight > v_prev then
      v_prev_result := trim(trailing '.' from to_char(v_prev, 'FM999999990.99')) || ' ק"ג × '
                    || trim(trailing '.' from to_char(v_reps, 'FM999999990'));
      v_improvement := '+' || trim(trailing '.' from to_char(v_weight - v_prev, 'FM999999990.99')) || ' ק"ג';
    end if;
  end if;

  if v_title is not null then
    v_metadata := v_metadata || jsonb_build_object('movement', v_title);
  end if;
  if v_result is not null then
    v_metadata := v_metadata || jsonb_build_object('new_result', v_result);
  end if;
  if v_prev_result is not null then
    v_metadata := v_metadata || jsonb_build_object('previous_result', v_prev_result, 'improvement', v_improvement);
  end if;
  if v_occurred is not null then
    v_metadata := v_metadata || jsonb_build_object('achieved_on', v_occurred);
  end if;

  -- post_create's rule, asked of this shape: a card with no figures, no
  -- caption and no photo says nothing at all. On the upgrade path the card
  -- already exists and already carries a title and a result, so the check
  -- applies only to what is actually on the row.
  if v_result is null and v_body = '' and v_media_count = 0
     and (not v_upgrade
          or coalesce(v_prior_post.result_text, v_prior_post.title, v_prior_post.body) is null)
  then
    raise exception 'a post needs text or at least one photo';
  end if;

  if v_upgrade then
    -- deleted_at, score_value and score_direction are guarded by
    -- workout_posts_guard_moderated_fields; the pin is the documented way a
    -- trusted server function moves them, and it is transaction-local.
    -- visibility, published_at and comparison_key are absent from this SET
    -- list on purpose - see the header.
    perform set_config('app.allow_moderation_write', 'on', true);
    update public.workout_posts p
       set post_type       = 'POST_PR',
           source_type     = v_source_type,
           body            = coalesce(nullif(v_body, ''), p.body),
           title           = coalesce(v_title, p.title),
           result_text     = coalesce(v_result, p.result_text),
           occurred_on     = coalesce(v_occurred, p.occurred_on),
           score_value     = coalesce(v_score, p.score_value),
           score_direction = case when coalesce(v_score, p.score_value) is null
                                  then null else 'higher' end,
           metadata        = coalesce(p.metadata, '{}'::jsonb) || v_metadata,
           deleted_at      = null
     where p.id = v_prior_post.id
    returning p.id into v_post_id;
    perform set_config('app.allow_moderation_write', 'off', true);

    -- The PR prompt has its own photo picker, so the media it sends IS the
    -- card's media. Only ever runs when the caller actually supplied some:
    -- a PR share with no photo destroys nothing. publishWorkout's own photo
    -- lives in workout_posts.photo_path, a different column, and survives
    -- either way.
    if v_media_count > 0 then
      delete from public.post_media pm where pm.post_id = v_post_id;
    end if;
  else
    perform set_config('app.allow_unrated_post_insert', 'on', true);
    insert into public.workout_posts (
      author_id, post_type, visibility, body, title, result_text,
      source_type, source_record_id, occurred_on, score_value, score_direction,
      metadata, status, published_at)
    values (
      v_uid, 'POST_PR', 'club', nullif(v_body, ''), v_title, v_result,
      v_source_type, pr_share.record_id, coalesce(v_occurred, current_date), v_score,
      case when v_score is null then null else 'higher' end,
      v_metadata, 'active', now())
    returning id into v_post_id;
    perform set_config('app.allow_unrated_post_insert', 'off', true);
  end if;

  if v_media_count > 0 then
    for v_item in select value from jsonb_array_elements(media)
    loop
      if coalesce(v_item ->> 'storage_path', '') = '' then
        raise exception 'each media item needs a storage_path';
      end if;
      insert into public.post_media (post_id, storage_path, alt_text, decorative, "position", width, height)
      values (
        v_post_id,
        v_item ->> 'storage_path',
        nullif(v_item ->> 'alt_text', ''),
        coalesce((v_item ->> 'decorative')::boolean, false),
        coalesce((v_item ->> 'position')::smallint, v_idx::smallint),
        nullif(v_item ->> 'width', '')::integer,
        nullif(v_item ->> 'height', '')::integer
      );
      v_idx := v_idx + 1;
    end loop;
  end if;

  perform public.idem_complete('pr_share', p_idempotency_key, to_jsonb(v_post_id));
  return v_post_id;
end $$;

-- create or replace preserves the existing grants; restated so this file
-- alone describes the reachable surface.
revoke all on function public.pr_share(text, text, jsonb, uuid) from public, anon;
grant execute on function public.pr_share(text, text, jsonb, uuid) to authenticated;

comment on function public.pr_share(text, text, jsonb, uuid) is
  'Publishes a POST_PR for one of the caller''s own logged records. SECURITY DEFINER; auth.uid() checked first. Signature unchanged from 202609060019: ARGUMENT NAMES are the shipped client''s (record_id, note, media), not p_-prefixed, because PostgREST resolves by name; record_id is TEXT, not uuid - the id is uid("set") output ("set-<uuid>"). CONTRACTS REVIEW OF 202609060019, resolved here: the prior-post probe did not filter on post_type, and workout_posts(author_id, source_type, source_record_id) is unique WITHOUT post_type, so a member who had already shared that workout through publishWorkout() got the POST_WORKOUT''s id back, no POST_PR was created, and the client still reported success and emitted POST_CREATED{post_type:POST_PR}. RESOLUTION: one record yields ONE post. A prior POST_WORKOUT for the same record is UPGRADED IN PLACE to the POST_PR - post_type, source_type, title, result_text, occurred_on, score_value/score_direction (server-recomputed, replacing publishWorkout''s client-supplied score), metadata and body are set, deleted_at is cleared, and supplied media REPLACES the card''s post_media. visibility, published_at and comparison_key are deliberately NOT moved: promoting ''followers'' to ''club'' would widen a published post''s audience unasked, and bumping published_at would let any member re-float an old post to the top of the feed. The UPDATE runs inside the transaction-local app.allow_moderation_write pin because deleted_at/score_value/score_direction are guarded by workout_posts_guard_moderated_fields (202609060011). Reactions and comments survive the upgrade. No constraint or index changes, so publishWorkout()''s on-conflict target is untouched and no existing row is rewritten. Gates, in post_create''s order: ''not authorized'' (null caller, or a record_id owned by another member), ''recovery method required'', ''not authorized'' (no community.post.create), ''posting_restricted'', ''record is required'' (null, blank or over 160 chars), ''post is not available'' (the prior post''s status is hidden or removed - a moderator acted on it, and re-publishing the same content under a new post_type would be moderation evasion), ''this record already has a post'' (a prior post that is neither POST_WORKOUT nor POST_PR; unreachable from any shipped writer), ''rate_limited'' past 20 per 10 minutes on post_create''s OWN key, ''at most 4 photos per post'', ''each media item needs a storage_path'', ''a post needs text or at least one photo'' (only when there is no server copy of the record, no note, no photo, and no prior card to upgrade). OWNERSHIP unchanged: the caller''s own private_records row is the only source of every figure published; a record_id held by a DIFFERENT member is refused; a record_id nobody holds is allowed and publishes note and photo only, because cloud backup is opt-out. IDEMPOTENT twice over: the optional p_idempotency_key (202609060014) and, with no key, the natural (author_id, source_type, source_record_id) - a repeat share now finds a POST_PR, returns its id, writes nothing and costs no rate-limit budget. SIDE EFFECTS: one workout_posts row created OR one upgraded, up to 4 post_media rows (replacing any existing set when media is supplied), one post_create rate-limit token. RETURNS the post id, which is now always the id of a POST_PR.';

commit;
