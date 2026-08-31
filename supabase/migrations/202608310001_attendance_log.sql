begin;

-- COMM-300. The attendance source, and nothing that reads it.
--
-- The 2026-08-30 resolution in docs/community/backlog.md settled what
-- attendance IS in this product: a member logging a training session in the
-- training log they already use. Never Arbox, never a dedicated in-app
-- check-in flow. So this file adds no new client call and no new
-- affordance. It hangs one trigger off `private_records` (202608260001),
-- the table the offline outbox already upserts every `strength_entry` and
-- `wod_entry` into, and derives one attendance day per member per calendar
-- day from what is already flowing through it.
--
-- The practical consequence, and the reason the ticket insisted on a
-- trigger rather than a new RPC: a member running a months-old cached build
-- starts producing attendance rows the moment their existing sync runs. No
-- client version gate, no migration of member behaviour.
--
-- WHAT `occurred_on` IS READ FROM
-- `payload` is a client-owned jsonb blob - this is the first time the
-- schema has had to parse one, so the shape was confirmed against the real
-- producer rather than assumed. `cloud.js`'s `flushOutbox()` sends
-- `payload: row.payload`, and `app.js`'s `queueSyncRecord()` sets
-- `payload: record` - the whole local record object, unwrapped. For the two
-- session-bearing types that object is whatever `sanitizeEntry()` /
-- `sanitizeWodEntry()` in `src/sanitize.js` returned, and both of those
-- carry the logged day as a top-level `date` key that has already passed
-- `cleanISODate()`:
--
--   strength_entry: {id, exerciseId, date, type, weight, reps, sets, ts, ...}
--   wod_entry:      {id, wodId, date, scoreType, ts, rx, isPR, ...}
--
-- `cleanISODate()` is `/^\d{4}-\d{2}-\d{2}$/` plus a real Date parse, so a
-- synced entry's `date` is always a bare ISO calendar day with no time and
-- no offset. The regex below is that same shape, re-asserted server-side
-- rather than trusted: `private_records` takes a direct RLS insert, so the
-- payload is member-controlled and a hand-crafted request can put anything
-- in it. Anything that is not exactly that shape produces no attendance
-- row, silently.
--
-- `bodyweight` and `measurement` records carry a `date` key of the same
-- shape and are deliberately NOT session-bearing: stepping on a scale is
-- not training. The filter is on `record_type`, not on the presence of a
-- date, which is what makes that distinction hold.
--
-- APPEND-ONLY
-- `on conflict (user_id, occurred_on) do nothing`, and the trigger never
-- deletes. Three lifts logged on one day are one attendance day. A later
-- soft-delete of the source record does not retract a day already logged -
-- same "correct forward, not backward" shape `challenge_progress`
-- established in 202608280009, and a deliberate choice rather than a bug
-- deferred: a member who trained, logged it, and then tidied their training
-- log still trained.
--
-- WHO CAN WRITE IT
-- Nobody. There is no insert, update, or delete grant and no policy for any
-- of the three, for any client role, admin included - the same "no client
-- write, the function owns it" shape `pins` (202608280017) and
-- `notification_batches` (202608280018) already use. The trigger below is
-- the only writer. This matters more here than it looks: Phase 3 hangs
-- achievements (COMM-305), coach engagement flags (COMM-304) and a
-- consistency leaderboard (COMM-306) off this table, and a member who could
-- insert their own rows could mint all three.

create table public.attendance_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  occurred_on date not null,
  -- Which record type first produced this day, and its client-side id.
  -- Nullable and deliberately not a foreign key: `private_records` is keyed
  -- (user_id, record_type, record_id) and the row it points at may be
  -- soft-deleted or hard-deleted later without touching the attendance day,
  -- which is exactly the append-only rule above. This is provenance for a
  -- human reading the table, not a join key.
  source_record_type text,
  source_record_id text,
  recorded_at timestamptz not null default now(),
  -- The whole point of the table: one row per member per calendar day.
  unique (user_id, occurred_on)
);

-- The unique constraint already indexes (user_id, occurred_on), which
-- serves every own-history read. This one is for the cross-member day
-- window reads COMM-302 (classmate overlap), COMM-304 (attendance decline)
-- and COMM-307 (trained-with-you today) will all issue.
create index attendance_log_club_day_idx on public.attendance_log(club_id, occurred_on desc);

-- The session-bearing set in one place, so the trigger's WHEN clause, a
-- pgTAP assertion and any later Phase 3 reader assert against the same
-- value and none of them can drift. Same reasoning
-- `notification_batch_window()` used in 202608280018.
--
-- `private_records.record_type` also allows movement, custom_wod,
-- bodyweight, measure_type, measurement and session_note. None of those is
-- a training session: the first, second and fourth are definitions rather
-- than events, the third and fifth are body metrics, and `session_note` has
-- no producer in app.js at all (it is in the CHECK constraint and nothing
-- writes it), so admitting it would be admitting a shape nobody has ever
-- verified.
create or replace function public.attendance_session_record_types() returns text[]
language sql immutable set search_path = '' as $$
  select array['strength_entry', 'wod_entry']::text[];
$$;
revoke all on function public.attendance_session_record_types() from public, anon;
grant execute on function public.attendance_session_record_types() to authenticated;

-- The one place a client-owned `payload ->> 'date'` becomes a date, so the
-- trigger and the backfill at the bottom cannot disagree about what counts
-- as readable, and a pgTAP test can hit the parser directly.
--
-- Returns null rather than raising, for every rejection. The regex is the
-- shape `cleanISODate()` guarantees, but it is not sufficient on its own:
-- '2026-13-45' matches it and casting that raises 22008. The client can
-- never send such a string (JS ISO-8601 parsing rejects out-of-range
-- components, which is what makes cleanISODate return null), but
-- `private_records` takes a direct RLS insert, so a hand-crafted request
-- can. An uncaught raise inside the trigger would wedge that member's
-- outbox forever - `flushOutbox()` only deletes an outbox row after a
-- successful upsert - so the cast is caught, not trusted.
create or replace function public.attendance_parse_day(p_raw text) returns date
language plpgsql immutable set search_path = '' as $$
begin
  if p_raw is null or p_raw !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  return p_raw::date;
exception when others then
  return null;
end $$;
revoke all on function public.attendance_parse_day(text) from public, anon;
grant execute on function public.attendance_parse_day(text) to authenticated;

alter table public.attendance_log enable row level security;

revoke all on public.attendance_log from public, anon;
grant select on public.attendance_log to authenticated;

create policy attendance_log_self_select on public.attendance_log for select to authenticated
  using (user_id = auth.uid());

-- The cross-member read COMM-304 and COMM-306 need. Two separate permissive
-- policies rather than one OR'd predicate so a member's own read never pays
-- for the has_perm()/is_staff() lookups.
--
-- Note what this is NOT gated on: `can_view_profile_field(user_id,
-- 'show_attendance')`. That toggle governs what one MEMBER may see about
-- another member's attendance, and every Phase 3 member-facing reader
-- (COMM-302, COMM-306, COMM-307) is required to apply it in its own body.
-- This policy is the staff/analytics boundary, which is the same boundary
-- `analytics_events` (202608280012) and `admin_actions` (202608280002)
-- already draw with the same permission.
create policy attendance_log_staff_select on public.attendance_log for select to authenticated
  using (public.has_perm('community.analytics.view') or public.is_staff());

-- The only writer.
--
-- `security definer` and it does NOT check auth.uid() first, which is the
-- documented exception to that rule rather than an oversight - the same one
-- `notif_queue_batched()` records in 202608280018. The identity this
-- function acts for is `new.user_id`, and the row it is reading was already
-- pinned to the caller by `private_records_self_insert` /
-- `private_records_self_update` (202608260001), which is a stronger check
-- than re-reading auth.uid() here would be. An auth.uid() gate would also
-- break the backfill at the bottom of this file and any future service-role
-- repair, both of which legitimately have no session.
--
-- It is definer for exactly one reason: to cross the "no client write"
-- boundary on `attendance_log` on purpose. Nothing else in it needs
-- elevation.
create or replace function public.attendance_log_from_record() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_day date;
begin
  -- A missing, null, non-string, differently-shaped or impossible date is
  -- not an error: the source record still syncs, it just produces no
  -- attendance day. See attendance_parse_day() above for why nothing here
  -- is allowed to raise.
  v_day := public.attendance_parse_day(new.payload ->> 'date');
  if v_day is null then return new; end if;

  -- The future-date rule (COMM-300 "validation rules and limits"). A
  -- malformed local clock must not let a member bank attendance early, and
  -- because this table is append-only there is no way to take a wrong day
  -- back later - so a suspect date is refused rather than clamped. Clamping
  -- to today would have invented an attendance day the member never
  -- claimed, permanently.
  --
  -- The refusal is of the attendance row, not of the transaction: same
  -- reasoning as the malformed-date branch above. A member with a broken
  -- clock loses the attendance credit for that entry, not the ability to
  -- sync their training log.
  --
  -- One day of slack, not zero. `current_date` is the server's (UTC on
  -- Supabase); the client writes a local calendar day. A member in
  -- Asia/Jerusalem logging at 01:00 local produces a `date` that is
  -- "tomorrow" in UTC through no fault of their clock, and every real
  -- timezone is inside +/- 14 hours. Zero slack would silently drop those
  -- entries every single night.
  if v_day > current_date + 1 then return new; end if;

  -- `private_records.user_id` references auth.users; `attendance_log.user_id`
  -- references profiles (the contract COMM-302/304/306/307 were written
  -- against, since all four join to profiles anyway). A signed-in member who
  -- has not created a profile yet - the COMM-016 gate window - can therefore
  -- legally hold private_records rows with no profile row to point at.
  -- Skipping is the only correct answer: the alternative is a foreign key
  -- violation that would break their sync outright.
  if not exists (select 1 from public.profiles p where p.id = new.user_id) then
    return new;
  end if;

  insert into public.attendance_log (user_id, occurred_on, source_record_type, source_record_id)
  values (new.user_id, v_day, new.record_type, new.record_id)
  on conflict (user_id, occurred_on) do nothing;

  return new;
end $$;
revoke all on function public.attendance_log_from_record() from public, anon, authenticated;

-- The WHEN clause carries the two cheap filters so the function body is not
-- entered at all for a movement definition, a bodyweight reading, or a
-- soft-delete. `new.deleted_at is null` is what makes a soft-delete UPDATE a
-- no-op rather than a re-log; combined with the trigger never deleting, it
-- is the whole of the append-only rule.
--
-- INSERT OR UPDATE, not INSERT only: `flushOutbox()` upserts on
-- (user_id, record_type, record_id), so a record that already exists
-- server-side arrives as an UPDATE. An INSERT-only trigger would miss every
-- edited entry and every re-sync from a second device.
create trigger private_records_attendance_log
  after insert or update on public.private_records
  for each row
  when (new.deleted_at is null and new.record_type = any (public.attendance_session_record_types()))
  execute function public.attendance_log_from_record();

-- One-time backfill of the sessions already synced before this migration.
--
-- Not in COMM-300's migration outline; added deliberately. Without it every
-- existing member's attendance history starts at zero on deploy day, and
-- COMM-306's consistency leaderboard and COMM-304's decline detection would
-- both read a club that has apparently never trained. It is also strictly
-- safer to do it here than later: COMM-305 adds an AFTER INSERT trigger on
-- this table that mints achievements and posts milestones, and that trigger
-- does not exist yet, so this backfill cannot spam anybody's feed or
-- notifications. Run after COMM-305, the same rows would.
--
-- Same four rules as the trigger, expressed as WHERE clauses: session-bearing
-- types only, non-deleted only, well-formed date only, not future-dated. The
-- distinct-on picks the earliest-recorded source record for a day so
-- `source_record_*` matches what the trigger would have written had it
-- existed at the time.
insert into public.attendance_log (user_id, occurred_on, source_record_type, source_record_id, recorded_at)
select distinct on (d.user_id, d.day)
  d.user_id, d.day, d.record_type, d.record_id, d.created_at
from (
  select r.user_id,
         public.attendance_parse_day(r.payload ->> 'date') as day,
         r.record_type, r.record_id, r.created_at
  from public.private_records r
  join public.profiles p on p.id = r.user_id
  where r.deleted_at is null
    and r.record_type = any (public.attendance_session_record_types())
) d
where d.day is not null
  and d.day <= current_date + 1
order by d.user_id, d.day, d.created_at
on conflict (user_id, occurred_on) do nothing;

commit;
