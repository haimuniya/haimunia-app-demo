begin;

-- Community Phase 2, challenges cluster, part 2 of 4: challenge_progress_apply.
--
-- challenge_progress's insert grant (COMM-006, 202608280009) is append-only
-- on purpose: a member writes one delta row, never a running total, so a
-- correction is always a compensating entry, never an edit to history (see
-- that migration's own comment on the table). Nothing before this migration
-- ever read those rows back into challenge_participants.progress_value, so
-- every participant's progress sat at its insert default of 0 forever.
--
-- This is the AFTER INSERT trigger documented in contracts.md under "Needs
-- from schema, challenges". Two things happen in the same transaction as
-- every challenge_progress insert:
--   1. challenge_participants.progress_value is bumped by NEW.delta, and
--      for individual_target / individual_performance challenges, status
--      flips to completed (completed_at stamped) the first time the new
--      total reaches target_value. Once completed, a later negative
--      correction never flips it back - the CASE below only ever sets
--      'completed' when the row was not already there, and otherwise
--      leaves status exactly as it was.
--   2. For a cooperative challenge, the club-wide total is recomputed and
--      checked against 25/50/75/100% of target_value (COMM-203). Crossing
--      a threshold posts one authorless milestone update, at most once per
--      threshold per challenge - "already posted" is answered by looking
--      at workout_posts itself (a POST_CHALLENGE row already carrying that
--      challenge_id and that milestone in its metadata) rather than adding
--      a second piece of state that could drift from what was actually
--      posted. A `select ... for update` on the challenges row up front
--      serializes concurrent progress inserts on the same challenge, which
--      is what keeps two contributions landing in the same instant from
--      both deciding "not posted yet" and double-posting.
--
-- Authorless post pattern: there is no existing insert site for POST_SYSTEM
-- or POST_NEW_MEMBER to copy - grepping the migration history turns up only
-- the enum values and the 202608280004 comment saying workout_posts.author_id
-- is nullable "for the authorless POST_SYSTEM and POST_NEW_MEMBER rows
-- COMM-107 renders". COMM-107 was never actually built as a server insert.
-- The nearest real precedent is post_create (202608280023): a SECURITY
-- DEFINER function that inserts into workout_posts directly, past
-- posts_insert_self, because that policy requires author_id = auth.uid()
-- and a server-authored row has no author. This trigger follows the same
-- shape: SECURITY DEFINER, direct insert, author_id explicitly null,
-- post_type 'POST_CHALLENGE' (already in the enum since 202608280004 - no
-- add-value-then-use split needed here).

create or replace function public.challenge_progress_apply() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_challenge public.challenges;
  v_participant public.challenge_participants;
  v_new_total numeric;
  v_now_complete boolean;
  v_club_total numeric;
  v_pct numeric;
  v_threshold integer;
  v_already boolean;
begin
  select * into v_challenge from public.challenges where id = new.challenge_id for update;
  if not found then
    return new;
  end if;

  select * into v_participant from public.challenge_participants
    where challenge_id = new.challenge_id and user_id = new.user_id
    for update;

  if found then
    v_new_total := v_participant.progress_value + new.delta;
    v_now_complete := (
      v_participant.status <> 'completed'
      and v_challenge.challenge_type in ('individual_target', 'individual_performance')
      and v_challenge.target_value is not null
      and v_new_total >= v_challenge.target_value
    );

    update public.challenge_participants
    set progress_value = v_new_total,
        status = case when v_now_complete then 'completed' else status end,
        completed_at = case when v_now_complete then now() else completed_at end
    where challenge_id = new.challenge_id and user_id = new.user_id;
  end if;
  -- No participant row (e.g. a stray coach entry against a bad target) is
  -- silently a no-op here; chal_record_progress already refuses that case
  -- before it ever inserts, so this branch only guards against a future
  -- write path that skips that check.

  if v_challenge.challenge_type = 'cooperative'
     and v_challenge.target_value is not null
     and v_challenge.target_value > 0 then
    select coalesce(sum(delta), 0) into v_club_total
    from public.challenge_progress
    where challenge_id = new.challenge_id;

    v_pct := (v_club_total / v_challenge.target_value) * 100;

    foreach v_threshold in array array[25, 50, 75, 100] loop
      if v_pct >= v_threshold then
        select exists (
          select 1 from public.workout_posts
          where post_type = 'POST_CHALLENGE'
            and (metadata ->> 'challenge_id') = new.challenge_id::text
            and (metadata ->> 'milestone')::integer = v_threshold
        ) into v_already;

        if not v_already then
          insert into public.workout_posts
            (author_id, post_type, visibility, body, metadata, status, published_at, club_id)
          values (
            null, 'POST_CHALLENGE', 'club',
            v_threshold::text || '% of the way to ' || v_challenge.title,
            jsonb_build_object(
              'challenge_id', new.challenge_id,
              'challenge_title', v_challenge.title,
              'milestone', v_threshold,
              'club_total', v_club_total,
              'target_value', v_challenge.target_value
            ),
            'active', now(), v_challenge.club_id
          );
        end if;
      end if;
    end loop;
  end if;

  return new;
end $$;
revoke all on function public.challenge_progress_apply() from public, anon, authenticated;

create trigger challenge_progress_apply_trigger after insert on public.challenge_progress
  for each row execute function public.challenge_progress_apply();

-- Lookup used by the "already posted this threshold" check above, and
-- available to any future client query that filters the feed by challenge.
create index if not exists workout_posts_challenge_metadata_idx
  on public.workout_posts ((metadata ->> 'challenge_id'))
  where post_type = 'POST_CHALLENGE';

commit;
