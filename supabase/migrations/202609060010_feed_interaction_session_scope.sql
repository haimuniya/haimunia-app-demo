begin;

-- Launch-readiness fix pass: feed_record_interaction() back-stamps every
-- impression a member has ever recorded for a post, not the one from the
-- session where the interaction happened.
--
-- =====================================================================
-- THE BUG
-- =====================================================================
-- 202608280006 shipped feed_impressions with `feed_session_id uuid not null`
-- and `unique (user_id, feed_session_id, post_id)`. That column exists for
-- exactly one reason: one appearance of a post in one feed session is one
-- row. A member who scrolls past the same post on Monday, Wednesday and
-- Friday has three impression rows, and `opened` / `engaged` are per-row
-- measurements of what happened to THAT appearance.
--
-- The UPDATE at the bottom of feed_record_interaction() never used it:
--
--     update public.feed_impressions
--     set opened = opened or p_kind = 'open',
--         engaged = engaged or p_kind in ('react', 'comment', 'share', 'save')
--     where user_id = v_uid and post_id = p_post_id;
--
-- Scoped by (user_id, post_id) only, so opening the post once on Friday sets
-- opened = true on Monday's and Wednesday's rows too, retroactively, and
-- every future session's row gets the same treatment the first time it is
-- touched. The flags are monotonic (`opened or ...` never clears), so the
-- corruption only ever accumulates - there is no self-correcting pass.
--
-- WHAT READS THESE TWO COLUMNS, i.e. why this is a real bug and not a
-- cosmetic one:
--   * personalised feed weights (202608310006) treat an unopened impression
--     as negative evidence - "shown and ignored". Back-stamping erases that
--     signal wholesale, so a post a member scrolled past three times and
--     opened once looks like three opens, and the ranker learns the opposite
--     of what happened.
--   * the analytics dashboard (202609010006) divides engaged/opened counts by
--     impression counts. With the back-stamp, open-rate and engagement-rate
--     are inflated by however many past sessions each post accumulated, i.e.
--     the more a post was shown the better it appears to have performed.
-- Both were already live, so the numbers a coach is looking at today are
-- wrong in a direction that flatters the feed. This is the only change that
-- fixes them going forward; historical rows are left as they are, because
-- there is no record of which of a member's rows the flag originally belonged
-- to - that information is precisely what the bug destroyed.
--
-- =====================================================================
-- WHY DROP AND RECREATE RATHER THAN `create or replace`
-- =====================================================================
-- Postgres identifies a function by its FULL argument signature, so
-- `create or replace function ... (uuid, text, uuid)` does not replace
-- `(uuid, text)` - it creates a SECOND function next to it, and both stay
-- callable forever. The two-argument one would keep the broken UPDATE and
-- keep its `authenticated` execute grant, and PostgREST would go on resolving
-- a two-key body to it. Nothing about the fix would reach a client that had
-- not been redeployed, and nothing would ever say so.
--
-- That is not hypothetical here: add_post_comment carries three coexisting
-- overloads today (202608280005, 202608270010, 202608280016, 202608280021)
-- and a client RPC call silently resolving to the wrong one of them was a
-- real, separately-fixed bug in this same pass. So this migration drops the
-- two-argument function explicitly - which drops its grants with it, leaving
-- the grant lines below as the complete and only privilege statement about
-- this name - and the DO block at the end refuses to let the migration commit
-- if more than one `feed_record_interaction` exists when it is done. There is
-- to be exactly one, at all times.
--
-- Nothing in the schema calls feed_record_interaction from PL/pgSQL, so the
-- drop breaks no server-side caller. The only caller anywhere is
-- cloud.js:3286, which is being updated to pass the third argument.
--
-- =====================================================================
-- p_feed_session_id IS REQUIRED. NO DEFAULT.
-- =====================================================================
-- The bug IS an over-broad fallback, so a `default null` meaning "then stamp
-- every session" would re-introduce it under a nicer name, and a caller that
-- simply forgot the argument would silently get the broken behaviour back.
-- With no default, PostgREST cannot resolve a two-key body at all: a caller
-- that forgets gets PGRST202 / 404, which is loud, immediate, and shows up
-- the first time anyone runs the feed.
--
-- The transition cost is bounded and worth naming: between this migration
-- landing and the client being redeployed, the old two-key call fails. That
-- call is fire-and-forget on the client (`.catch(() => {})` inside a
-- try/catch), so the failure is telemetry loss for that window and nothing a
-- member can see. Losing telemetry loudly for one deploy beats writing wrong
-- telemetry quietly forever.
--
-- A caller that supplies the key with a NULL VALUE is a narrower case and is
-- handled differently, on purpose: the interaction row is still written and
-- the UPDATE is skipped. Raising there would roll back the
-- feed_interactions insert too, and since the caller is fire-and-forget the
-- whole interaction would vanish silently - strictly more data lost than the
-- flag alone. feed_impressions.feed_session_id is NOT NULL, so a null
-- argument could never match a row anyway; the `if` below just says so out
-- loud instead of leaving it to SQL null semantics.
--
-- =====================================================================
-- WHAT DOES NOT CHANGE
-- =====================================================================
-- The auth.uid() check, the p_kind allow-list (all seven kinds, unchanged),
-- the check_rate_limit('feed_interaction', 300, 10) call, the
-- post_visible_to_viewer() check, the feed_interactions insert and the
-- monotonic `opened or` / `engaged or` expressions are byte-for-byte what
-- 202608280006 shipped, in the same order. feed_impressions still has no
-- UPDATE grant and no UPDATE policy, so this function remains the only thing
-- in the system that can flip either flag. `hide` and `profile_open` still
-- flip neither, as before.

drop function if exists public.feed_record_interaction(uuid, text);

create function public.feed_record_interaction(
  p_post_id uuid,
  p_kind text,
  p_feed_session_id uuid
) returns void
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if p_kind not in ('open', 'react', 'comment', 'share', 'hide', 'save', 'profile_open') then
    raise exception 'unknown interaction kind %', p_kind;
  end if;
  if not public.check_rate_limit('feed_interaction', 300, 10) then raise exception 'rate_limited'; end if;
  if not public.post_visible_to_viewer(p_post_id) then raise exception 'not authorized'; end if;

  insert into public.feed_interactions (user_id, post_id, kind) values (v_uid, p_post_id, p_kind);

  -- THE FIX. Three predicates, not two. feed_impressions.feed_session_id is
  -- NOT NULL and (user_id, feed_session_id, post_id) is unique, so this
  -- touches at most one row: the impression from the session the member is
  -- actually looking at.
  --
  -- Zero rows is a legitimate outcome and is not an error. An interaction can
  -- reach a post that has no impression row for this session - a post opened
  -- from a notification, a permalink, a profile, or a search result rather
  -- than off the feed - and the feed_interactions row above is still the
  -- correct and complete record of it.
  if p_feed_session_id is not null then
    update public.feed_impressions
    set opened = opened or p_kind = 'open',
        engaged = engaged or p_kind in ('react', 'comment', 'share', 'save')
    where user_id = v_uid
      and post_id = p_post_id
      and feed_session_id = p_feed_session_id;
  end if;
end $$;

revoke all on function public.feed_record_interaction(uuid, text, uuid) from public, anon;
grant execute on function public.feed_record_interaction(uuid, text, uuid) to authenticated;

comment on function public.feed_record_interaction(uuid, text, uuid) is
  'Launch-readiness fix pass, replaces the (uuid, text) version from 202608280006, which is DROPPED - there must never be two overloads of this name. Records one feed interaction and flips opened/engaged on the single feed_impressions row matching (auth.uid(), p_post_id, p_feed_session_id). The old version scoped that UPDATE by (user_id, post_id) only and so back-stamped every impression the member had ever recorded for the post, across all past sessions, corrupting the negative "shown and ignored" signal the personalised feed weights read and inflating the open/engagement rates the analytics dashboard divides. p_feed_session_id is REQUIRED with no default, so a caller that omits it fails loudly at PostgREST resolution rather than silently getting the old fan-out; a caller that passes it as NULL still gets its interaction row recorded and simply flips no flag. Rate limited at 300 per 10 minutes, refuses a post the caller cannot see, and is still the only write path to opened/engaged - feed_impressions has no UPDATE grant or policy.';

-- The invariant this whole migration is about, enforced at apply time rather
-- than asserted in a comment. If a later migration reintroduces a
-- two-argument overload with `create or replace`, this fails the
-- migration-check job instead of quietly restoring the bug.
do $$
declare v_count integer;
begin
  select count(*) into v_count
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'feed_record_interaction';
  if v_count <> 1 then
    raise exception 'expected exactly one public.feed_record_interaction, found %', v_count;
  end if;
end $$;

commit;
