begin;

-- Production-readiness audit, follow-up. FIXES A LIVE-BREAKING BUG THIS
-- AUDIT ITSELF INTRODUCED in 202609060014.
--
-- WHAT BROKE. cloud.js's communityRpc() attaches a p_idempotency_key to
-- EVERY action in OUTBOX_ACTIONS, which is five: post_create,
-- add_post_comment, toggle_reaction, chal_record_progress and event_rsvp.
-- 202609060014 added the parameter to four of them and missed this one, so
-- every RSVP became:
--
--   POST /rest/v1/rpc/event_rsvp {p_event_id, p_response, p_idempotency_key}
--   -> PGRST202 "Could not find the function public.event_rsvp(
--      p_event_id, p_idempotency_key, p_response)"
--
-- PostgREST resolves overloads by the exact set of named arguments, so an
-- extra parameter is not ignored - it fails to resolve at all. RSVP would
-- have been 100% dead on deploy: no member could mark themselves going,
-- interested or not going to any event.
--
-- WHY NOTHING CAUGHT IT. The pgTAP suite calls event_rsvp() directly in
-- SQL, where the client's extra argument does not exist. The browser
-- scenario goes through lib/mockCloud.mjs, whose rpc() stand-in accepts any
-- argument shape and returns a stub. The node tests assert source text. So
-- all three suites were green on a call path that could not work against a
-- real PostgREST - which is exactly why this was found by curling the real
-- endpoint instead of trusting the suites.
--
-- The fix is the parameter, not a client-side exception: an RSVP made
-- offline is queued and retried like any other community write, so it wants
-- the same replay protection. event_rsvp is already convergent (it upserts
-- a response rather than toggling), so the key is belt-and-braces here
-- rather than load-bearing - but consistency across all five queued actions
-- is worth more than saving one parameter.
--
-- Body is copied verbatim from pg_get_functiondef() of the live function,
-- with only the idempotency block added.
create or replace function public.event_rsvp(
  p_event_id uuid,
  p_response text,
  p_idempotency_key uuid default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_replay boolean;
  v_prior jsonb;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('event_rsvp', p_idempotency_key) i;
  if v_replay then return; end if;

  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if p_response not in ('going', 'interested', 'not_going') then
    raise exception 'unknown rsvp response %', p_response;
  end if;
  if not exists (select 1 from public.events e where e.id = p_event_id and e.status = 'published') then
    raise exception 'event not open for rsvp';
  end if;
  insert into public.event_attendees (event_id, user_id, response)
  values (p_event_id, v_uid, p_response)
  on conflict (event_id, user_id) do update set response = excluded.response, registered_at = now();

  perform public.idem_complete('event_rsvp', p_idempotency_key, to_jsonb(p_response));
end $$;
revoke all on function public.event_rsvp(uuid, text, uuid) from public, anon;
grant execute on function public.event_rsvp(uuid, text, uuid) to authenticated;

-- The old 2-arg signature is dropped so exactly one event_rsvp exists. A
-- 2-named-argument call still resolves to this function with the key
-- defaulted, so anything that has not been updated keeps working.
drop function if exists public.event_rsvp(uuid, text);

commit;
