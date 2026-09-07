begin;

-- Follow-up to fbf5a43, second half: club_summary() forces a second
-- round-trip to answer a question it already has the answer to.
--
-- THE COST TODAY. club_summary() returns active_challenge as
-- {id, title, source, ends_at} - no comparison_key. cloud.js cannot tell
-- from that whether the challenge is one a member can actually join, so
-- loadWeeklyChallenge() issues a SECOND read of weekly_challenges, selecting
-- the same active row over again purely to get its key, on every club-home
-- render. Two queries, one answer.
--
-- =====================================================================
-- THE DECISION: return the KEY, not a validity BOOLEAN
-- =====================================================================
-- The boolean was the tempting option - it exposes less and reads as the
-- safer default - and it does not work here, for two independent reasons:
--
-- 1. A boolean computed in the database can only ever mean "the SHAPE is
--    valid", because shape is the only half Postgres can check; the movement
--    and WOD catalog lives in the client (see 202609060026's header). The
--    client's own answer is `shape AND names something real`. A boolean
--    would therefore be strictly weaker than what the caller needs, and the
--    caller would still have to fetch the key to finish the job - the
--    round-trip this migration exists to remove would survive it.
--
-- 2. After 202609060026 that boolean is a CONSTANT. Shape validity is now a
--    table invariant: every violating row was archived and the CHECK refuses
--    new ones. A field that can only ever say `true` is not a signal, it is
--    decoration that a later reader will mistake for a guarantee it does not
--    give.
--
-- WHAT THE KEY EXPOSES: nothing new. `movement:back-squat:est1rm` is a
-- content identifier, not a member identifier, and every community member
-- can already read it two ways - weekly_challenges_read (202609060011) is
-- `using (is_community_member())` over the whole row, and
-- weekly_challenge_leaderboard selects comparison_key by name. cloud.js is
-- reading it directly from the table on this very render. Withholding it
-- here while the table hands it over unchallenged would be theatre, and
-- would have made staff-only exposure meaningless anyway. club_summary()'s
-- own gates (auth.uid(), then is_community_member()) are unchanged.
--
-- ADDITIVE ONLY, so this is safe to land alone. Two new keys inside the
-- existing active_challenge object - comparison_key, and starts_at beside
-- the ends_at that was always there, so the object carries the whole row
-- loadWeeklyChallenge() currently re-fetches (id, title, key, both dates)
-- and the second read can go away entirely rather than merely shrink.
-- Nothing renamed, nothing removed, no
-- change to the function SIGNATURE. The shipped cloud.js reads
-- active_challenge.title and passes the object around - it ignores keys it
-- does not know, so it behaves exactly as it does today until it is updated.
--
-- FOR THE CLIENT CHANGE THIS ENABLES (cloud.js is owned elsewhere; reported,
-- not made): `source` was already in this payload and is what distinguishes
-- the two branches. comparison_key is null when source = 'challenge' because
-- the Phase-2 public.challenges model has no such column - that null means
-- "this challenge kind needs no key", NOT "invalid". Reading it as invalid
-- would hide a real Phase-2 challenge, so the branch must be on `source`.

CREATE OR REPLACE FUNCTION public.club_summary()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid;
  v_club public.clubs;
  v_members integer;
  v_challenge jsonb;
  v_unread integer;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.is_community_member() then raise exception 'recovery method required'; end if;

  select * into v_club from public.clubs c where c.id = public.default_club_id();
  -- Definer, so this is the real member count and not "everyone this viewer
  -- has not blocked", which is what a client-side count through
  -- profiles_read_authenticated would have produced.
  select count(*)::integer into v_members from public.profiles p where p.deleted_at is null;

  -- comparison_key is null on this branch by construction: public.challenges
  -- has no such column. Callers branch on `source`, not on the null.
  select jsonb_build_object('id', c.id, 'title', c.title, 'source', 'challenge',
                            'starts_at', c.start_at, 'ends_at', c.end_at,
                            'comparison_key', null)
    into v_challenge
  from public.challenges c
  where c.status = 'active' and now() >= c.start_at and now() <= c.end_at
  order by c.end_at asc
  limit 1;
  -- challenges is Phase 2 (COMM-201) and is empty today, so the current
  -- weekly challenge is the fallback and is what actually renders in V1.
  --
  -- Same row loadWeeklyChallenge() selects: current_date inside the window,
  -- `order by ends_on asc limit 1`. The two orderings have to stay identical
  -- or the client would validate one row and render another.
  if v_challenge is null then
    select jsonb_build_object('id', w.id, 'title', w.title, 'source', 'weekly',
                              'starts_at', w.starts_on, 'ends_at', w.ends_on,
                              'comparison_key', w.comparison_key)
      into v_challenge
    from public.weekly_challenges w
    where current_date >= w.starts_on and current_date <= w.ends_on
    order by w.ends_on asc
    limit 1;
  end if;

  select count(*)::integer into v_unread
  from public.notifications n where n.user_id = v_uid and n.read_at is null;

  return jsonb_build_object(
    'name', coalesce(v_club.name, ''),
    -- TODO COMM-115: clubs has no image column. The mark reads
    -- settings->>'image_url' when an admin has set one and the client falls
    -- back to a lettermark. Promote it to a real column when club branding
    -- gets its own ticket rather than inventing one here.
    'image_url', v_club.settings ->> 'image_url',
    'member_count', coalesce(v_members, 0),
    'active_challenge', v_challenge,
    'unread_notifications', coalesce(v_unread, 0)
  );
end $function$;
revoke all on function public.club_summary() from public, anon;
grant execute on function public.club_summary() to authenticated;

comment on function public.club_summary() is
  'Club-header card in one round trip. SECURITY DEFINER, STABLE; auth.uid() checked first (''not authorized''), then is_community_member() (''recovery method required''). Signature unchanged since 202608280019. Returns {name, image_url, member_count, active_challenge, unread_notifications}. active_challenge is the single active public.challenges row ending soonest, falling back to the weekly_challenges row whose date window contains today, ordered ends_on asc - the identical row and ordering cloud.js loadWeeklyChallenge() selects. ADDED BY 202609060027, additively: active_challenge.comparison_key and active_challenge.starts_at (start_at on the challenge branch, starts_on on the weekly branch, mirroring how ends_at has always been built). The key is what lets the caller decide whether the challenge is joinable without a second read of weekly_challenges; it is null when source = ''challenge'' because public.challenges has no such column, so callers must branch on `source` and not treat null as invalid. Returning the key exposes nothing new - weekly_challenges_read (202609060011) already lets every community member select the whole row, and weekly_challenge_leaderboard selects comparison_key by name. It carries SHAPE-checked keys only (weekly_challenges_comparison_key_shape, 202609060026); whether the key names a real movement or WOD is a client-catalog question Postgres cannot answer, and the caller still owns that half.';

commit;
