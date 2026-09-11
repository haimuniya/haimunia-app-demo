begin;

-- Security hunt, round 10 (2026-09-12), admin/moderation-surface agent.
--
-- Row level security is row-level only - it decides which ROWS a query
-- can see, never which COLUMNS. Two moderation tables' "read your own
-- row" policies were written before staff-internal columns existed on
-- those tables, and were never revisited when those columns were added,
-- so a plain member reading their OWN row could also read exactly which
-- staff member acted on it and that staff member's private internal
-- notes - confirmed live against real local Postgres:
--
--   - public.reports: reviewed_by (deanonymizes which staff member
--     reviewed a report the member themselves filed - resolves to a
--     handle/display name via profiles) and review_note /
--     resolution_notes (docs/community/contracts.md documents review_note
--     as staff-internal commentary, explicitly distinct from the
--     reporter's own `details`). Confirmed nothing in cloud.js ever reads
--     this table directly at all (grepped for `.from("reports")` - zero
--     hits; the moderation queue reads it exclusively through the
--     mod_queue() RPC), so there is no legitimate client use for a
--     member reading their own filed report to close - the self-read
--     branch is removed outright rather than narrowed.
--
--   - public.posting_restrictions: moderator_id (same deanonymization,
--     for whoever restricted or lifted a restriction on the member) and
--     lift_reason/source_report_id. Unlike reports, this ONE has a real,
--     already-shipped client use - loadMyRestriction() (cloud.js) - and
--     its own comment already shows the client deliberately selects a
--     safe column subset (id, restriction_type, expires_at, reason,
--     created_at, lifted_at) instead of `select *`. That client-side
--     allowlist was never backed by a matching server-side one - a direct
--     table read from the browser's own devtools, same session, same
--     anon key, returns every column regardless of what the shipped
--     client asks for.
--
-- FIX. reports: drop the self-read branch: reporter_id = auth.uid() is no
-- longer sufficient to read a reports row directly (the admin branch is
-- untouched). posting_restrictions: replace the self-read branch with a
-- SECURITY DEFINER function returning exactly the column subset
-- loadMyRestriction() already asks for - the same shape
-- admin_incomplete_signups() already uses elsewhere in this schema to
-- strip a real login email down to its safe portion before a query can
-- ever see the rest. cloud.js is updated in the same commit to call the
-- function instead of the table.

drop policy reports_read_self_or_admin on public.reports;
create policy reports_read_self_or_admin on public.reports for select to authenticated using (
  exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
);

create or replace function public.my_posting_restrictions()
returns table(
  id uuid,
  restriction_type text,
  expires_at timestamptz,
  reason text,
  created_at timestamptz,
  lifted_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select r.id, r.restriction_type, r.expires_at, r.reason, r.created_at, r.lifted_at
  from public.posting_restrictions r
  where r.user_id = auth.uid() and r.lifted_at is null
  order by r.created_at desc
  limit 5;
$$;
revoke all on function public.my_posting_restrictions() from public, anon;
grant execute on function public.my_posting_restrictions() to authenticated;
comment on function public.my_posting_restrictions() is
  'Security hunt round 10 (202609120012). Returns the caller''s own not-yet-lifted posting_restrictions rows, exactly the column subset loadMyRestriction() (cloud.js) already asks for - id, restriction_type, expires_at, reason, created_at, lifted_at - never moderator_id/lifted_by/source_report_id/lift_reason, which the RLS self-read branch this replaces used to expose to a direct table read regardless of what the shipped client selected. Same 5-candidate/newest-first shape the client used, since overlapping unlifted rows are possible.';

drop policy posting_restrictions_read on public.posting_restrictions;
create policy posting_restrictions_read on public.posting_restrictions for select to authenticated using (
  public.has_perm('community.member.restrict')
  or public.has_perm('community.comment.moderate')
);

commit;
