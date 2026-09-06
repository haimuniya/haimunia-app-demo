begin;

-- Fixes a false-positive in scheduled_job_health() (202609060016), found by
-- reading the real production output rather than the local one.
--
-- THE BUG. `healthy` used a single fixed staleness window - "last run within
-- 8 days" - for every job. That is wrong for anything slower than weekly:
--
--   recap_monthly runs '41 4 1 * *', i.e. on the 1st of each month.
--
-- From roughly the 9th onward its last run is more than 8 days old, so it
-- reported unhealthy for about 23 days out of every 30, forever, while being
-- perfectly fine. The documented alert query is
-- `select ... where not healthy`, so that is a permanent false positive on a
-- monitoring surface whose entire job is to be trusted.
--
-- A gate that cries wolf gets muted, and a muted gate is how
-- purge_due_accounts sat unscheduled and unnoticed for the life of the
-- project in the first place. So this is not cosmetic.
--
-- THE FIX. Derive the window from each job's own cron cadence and allow
-- roughly two intervals, so a single missed run is tolerated but two in a
-- row are not:
--
--   day-of-month pinned  -> monthly  -> 35 days
--   day-of-week pinned   -> weekly   ->  9 days
--   hour pinned          -> daily    ->  2 days
--   otherwise            -> hourly or faster -> 3 hours
--
-- "never run" still reports unhealthy regardless of cadence. That is
-- deliberate and is the single most important behaviour here: it is exactly
-- the state purge_due_accounts was in. A freshly deployed job therefore
-- reads unhealthy until its first successful run, which is correct - it has
-- genuinely not been proven to work yet.
create or replace function public.scheduled_job_health()
returns table (
  jobname text,
  schedule text,
  active boolean,
  last_run timestamptz,
  last_status text,
  seconds_since_last_run numeric,
  healthy boolean
)
language sql stable security definer set search_path = '' as $$
  with last_runs as (
    select d.jobid, max(d.start_time) as last_run
      from cron.job_run_details d
     group by d.jobid
  ),
  latest as (
    select d.jobid, d.status, d.start_time
      from cron.job_run_details d
      join last_runs l on l.jobid = d.jobid and l.last_run = d.start_time
  )
  select j.jobname::text,
         j.schedule::text,
         j.active,
         latest.start_time as last_run,
         coalesce(latest.status, 'never run')::text as last_status,
         extract(epoch from (now() - latest.start_time))::numeric as seconds_since_last_run,
         coalesce(
           j.active
           and latest.status = 'succeeded'
           and latest.start_time > now() - (
             case
               -- field 3 = day of month; pinned means monthly or rarer
               when split_part(j.schedule, ' ', 3) <> '*' then interval '35 days'
               -- field 5 = day of week; pinned means weekly
               when split_part(j.schedule, ' ', 5) <> '*' then interval '9 days'
               -- field 2 = hour; pinned means once a day
               when split_part(j.schedule, ' ', 2) <> '*' then interval '2 days'
               -- everything else runs at least hourly
               else interval '3 hours'
             end
           ), false) as healthy
    from cron.job j
    left join latest on latest.jobid = j.jobid
   order by j.jobname;
$$;
revoke all on function public.scheduled_job_health() from public, anon, authenticated;
grant execute on function public.scheduled_job_health() to service_role;

comment on function public.scheduled_job_health() is
  'Launch-readiness audit, MON-1. One row per pg_cron job: schedule, active flag, last run, that run''s status, and a `healthy` boolean. The staleness window is derived from the job''s OWN cadence (monthly 35d / weekly 9d / daily 2d / hourly-or-faster 3h, i.e. roughly two intervals) - 202609060016 used a flat 8 days, which made recap_monthly report unhealthy for ~23 days of every month and would have trained everyone to ignore the alert. A job that has NEVER run is unhealthy at any cadence, which is precisely the state purge_due_accounts sat in undetected. Read it with `select * from public.scheduled_job_health() where not healthy;`. service_role only. See docs/ops/MONITORING.md.';

commit;
