begin;

-- Community Phase 2, events cluster (COMM-213 to COMM-217): the one schema
-- change the cluster needs, exactly as "Needs from schema, events" in
-- docs/community/contracts.md states it.
--
-- Everything else in the cluster is client work on tables that already
-- exist: `events`, `event_attendees`, `event_rsvp`, and the
-- capacity/deadline trigger all shipped in 202608280010 (COMM-007). Event
-- comments (COMM-216) reuse a companion POST_EVENT `workout_posts` row and
-- its `post_comments`, so `events` gets no `post_id` column here. Add to
-- Calendar (COMM-215) is a client-built .ics from columns that already
-- exist. Creating, editing, and cancelling an event stay direct RLS writes
-- under the `community.event.manage` policies from 202608280010. No table,
-- no column, no policy change in this file - one trigger and one line of
-- the preference map.

------------------------------------------------------------------------
-- 1. `event_cancelled` -> the `events` preference key.
------------------------------------------------------------------------
-- Additive re-declaration of the 202608280026 map: every existing arm is
-- unchanged, one arm is added. `event_cancelled` is a new type that nothing
-- emitted before this migration, so this cannot alter any shipped
-- behaviour.
--
-- Why the arm is needed at all: `notif_pref_key`'s fallback maps an unknown
-- type to itself, so without this line an `off` preference would only
-- suppress `event_cancelled` if a member had a row keyed literally
-- `event_cancelled`. The client's Preferences panel (COMM-144,
-- `NOTIF_PREF_TYPES` in cloud.js) writes the coarse key `events` for the
-- "אירועים" toggle, and `NOTIF_TYPES.event_cancelled.pref` is `events`.
-- Mapping the type onto that key is what makes the routing table's "an off
-- preference suppresses the immediate insert" true for this type rather
-- than merely documented.
--
-- NOT fixed here, deliberately, and logged in contracts.md instead: the
-- same drift exists for `comment_reply` (client key `replies`),
-- `comment_on_post` / `comment_also` (client key `comments`),
-- `achievement_unlocked` (client key `achievements`), and
-- `challenge_ending_soon` / `challenge_update` (client key `challenges`).
-- Those types are already shipped and already notifying members, so
-- re-keying them is a behaviour change belonging to the notifications
-- cluster (COMM-218/219), not a side effect of the events cluster.
create or replace function public.notif_pref_key(p_type text) returns text
language sql immutable set search_path = '' as $$
  select case p_type
    when 'comment_reply'        then 'comment_reply'
    when 'comment_on_post'      then 'comment_on_post'
    when 'comment_also'         then 'comment_on_post'
    when 'mention'              then 'mentions'
    when 'coach_mention'        then 'mentions'
    when 'reaction'             then 'reactions'
    when 'announcement'         then 'announcements'
    when 'friend_achievement'   then 'friend_achievements'
    when 'achievement_unlocked' then 'achievement_unlocked'
    when 'event_cancelled'      then 'events'
    else p_type
  end;
$$;
revoke all on function public.notif_pref_key(text) from public, anon, authenticated;

------------------------------------------------------------------------
-- 2. notif_on_event_cancelled: immediate `event_cancelled` to every RSVP.
------------------------------------------------------------------------
-- Same shape as notif_on_challenge_complete (202608290006): AFTER UPDATE OF
-- status, and the real guard lives in the function body, not in the trigger
-- declaration. `AFTER UPDATE OF status` fires on any UPDATE whose SET list
-- mentions `status`, including one that writes the same value back, so the
-- function re-checks the actual transition (`new.status = 'cancelled' and
-- old.status <> 'cancelled'`) before it does anything. Re-cancelling an
-- already cancelled event fans out nothing.
--
-- Delivery is immediate per the routing table, so every recipient goes
-- through `notif_create`, which is where the block edge, the `off`
-- preference, the never-notify-the-actor rule, and the dedupe window are
-- applied - exactly as notif_on_comment's and notif_on_mention's immediate
-- branches do it. Concretely, for this trigger that means:
--   - the staff member who cancelled the event is the actor
--     (`auth.uid()`), so their own RSVP never notifies them;
--   - an attendee on either side of a block edge with the canceller is
--     skipped;
--   - the dedupe key is (recipient, 'event_cancelled', event id) inside
--     `notif_dedupe_window()`, so a cancel -> republish -> cancel inside
--     that window is treated as one cancellation, not two.
-- No check is duplicated here that notif_create already makes; the batched
-- helpers are the ones that need a caller-side pref/block check, and
-- nothing on this path is batched.
--
-- Only `going` and `interested` are notified. A `not_going` RSVP is a
-- deliberate opt-out and gets nothing. A draft event has no attendees at
-- all (event_attendees_rsvp_self requires a published event), so a
-- draft -> cancelled transition needs no special case: the loop is empty.
create or replace function public.notif_on_event_cancelled() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_attendee uuid;
begin
  if new.status <> 'cancelled' or old.status = 'cancelled' then
    return new;
  end if;

  for v_attendee in
    select a.user_id
    from public.event_attendees a
    where a.event_id = new.id
      and a.response in ('going', 'interested')
  loop
    perform public.notif_create(
      v_attendee, 'event_cancelled', 'events',
      'Event cancelled',
      new.title,
      'event', new.id,
      '/community/feed?event=' || new.id::text
    );
  end loop;

  return new;
end $$;
revoke all on function public.notif_on_event_cancelled() from public, anon, authenticated;

create trigger events_notify_cancelled after update of status on public.events
  for each row execute function public.notif_on_event_cancelled();

commit;
