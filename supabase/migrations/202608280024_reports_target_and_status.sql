begin;

-- COMM-151 / COMM-152, the schema shape the reshaped report path needs. The
-- functions that use these columns and the new enum label land in the next
-- migration, 202608280025, because a value added to an enum by ALTER TYPE ...
-- ADD VALUE cannot be USED until the transaction that added it has committed -
-- the same split 202608280004 / 202608280005 used for the post_visibility
-- labels.
--
-- What changes here:
--   * reports gains target_type ('post' | 'comment') and target_id, so a
--     report can point at a comment, not only a post. post_id stays and stays
--     populated for a post target (equal to target_id), so the reporter
--     self-hide in feed_page (202608280019) and the two legacy feed views,
--     all keyed to reports.post_id, keep working untouched. A comment report
--     leaves post_id null, which is why post_id loses its NOT NULL.
--   * the reason CHECK gains 'unsafe_advice' (COMM-151 reason list).
--   * a review_note column for the reviewer note mod_review writes, kept
--     separate from details, which is the reporter's own note.
--   * the unique key moves from (reporter_id, post_id) to
--     (reporter_id, target_type, target_id) so a duplicate report on the same
--     comment collapses the same way a duplicate on the same post does.
--   * report_status gains 'action_taken', the label COMM-152 and the client
--     render for a report that had a decision applied. 'resolved' stays in
--     the enum for the older review_report path and is not remapped.

alter table public.reports
  add column target_type text not null default 'post'
    check (target_type in ('post', 'comment')),
  add column target_id uuid,
  add column review_note text not null default ''
    check (char_length(review_note) <= 500);

-- Existing rows are all post reports. target_id mirrors post_id, target_type
-- already defaulted to 'post'.
update public.reports set target_id = post_id where target_id is null;
alter table public.reports alter column target_id set not null;
alter table public.reports alter column post_id drop not null;

-- Widen the reason list. The constraint was declared inline in 202608260001,
-- so its name is whatever Postgres generated - it is looked up rather than
-- guessed, the same way 202608280016 handled the comment body CHECK.
do $$
declare v_name text;
begin
  select conname into v_name from pg_constraint
  where conrelid = 'public.reports'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%reason%';
  if v_name is not null then
    execute format('alter table public.reports drop constraint %I', v_name);
  end if;
end $$;
alter table public.reports
  add constraint reports_reason_check
  check (reason in ('spam', 'harassment', 'privacy', 'inappropriate', 'unsafe_advice', 'other'));

-- Swap the uniqueness key. Same lookup approach for the old inline name.
do $$
declare v_name text;
begin
  select conname into v_name from pg_constraint
  where conrelid = 'public.reports'::regclass
    and contype = 'u'
    and pg_get_constraintdef(oid) ilike '%reporter_id, post_id%';
  if v_name is not null then
    execute format('alter table public.reports drop constraint %I', v_name);
  end if;
end $$;
alter table public.reports
  add constraint reports_reporter_target_key unique (reporter_id, target_type, target_id);

-- The grouping key mod_queue() reads.
create index if not exists reports_target_idx
  on public.reports(target_type, target_id, created_at);

-- Committed here, first used in 202608280025.
alter type public.report_status add value if not exists 'action_taken';

commit;
