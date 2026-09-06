begin;

-- Production-readiness audit, MON-1. Observability for the scheduled jobs.
--
-- THE PROBLEM this exists to make impossible again. purge_due_accounts()
-- was written, correct, granted, and never scheduled - and nothing noticed
-- for the entire life of the project, because a job that does not run
-- produces no error, no row, and no signal of any kind. PRIVACY.md promised
-- members their data would be erased after 30 days and nothing was erasing
-- it. That is not a bug a test catches; it is a bug MONITORING catches.
--
-- pg_cron records every run in cron.job_run_details, but that table is
-- owned by the postgres role and is not readable by anything the app or an
-- ops dashboard can reach. This wraps it in one SECURITY DEFINER read that
-- answers the only question that matters: is every job that should be
-- running actually running, and did it succeed.

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
    select d.jobid,
           max(d.start_time) as last_run
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
         -- "Healthy" is deliberately conservative: a job that has NEVER run
         -- is unhealthy, not unknown. That is exactly the state
         -- purge_due_accounts() sat in undetected.
         --
         -- coalesce(..., false) is load-bearing. Without it a never-run job
         -- yields NULL here (latest.status is NULL, so the AND is NULL),
         -- and `where not healthy` - the obvious alert query - silently
         -- SKIPS those rows, because NULL is not true. The one job state
         -- this function exists to catch would have been the one state it
         -- failed to report.
         coalesce(j.active
                  and latest.status = 'succeeded'
                  and latest.start_time > now() - interval '8 days', false) as healthy
    from cron.job j
    left join latest on latest.jobid = j.jobid
   order by j.jobname;
$$;
revoke all on function public.scheduled_job_health() from public, anon, authenticated;
grant execute on function public.scheduled_job_health() to service_role;

comment on function public.scheduled_job_health() is
  'Launch-readiness audit, MON-1. One row per pg_cron job: its schedule, whether it is active, when it last ran, that run''s status, and a conservative `healthy` boolean (active AND last run succeeded AND within 8 days - the window is wider than the weekly jobs'' cadence so a weekly job is not flagged the day before it is due). A job that has NEVER run reports last_status = ''never run'' and healthy = false, which is precisely the state purge_due_accounts() was in, undetected, for the life of the project. service_role only: cron.job_run_details is not otherwise reachable. See docs/ops/MONITORING.md for the alert query.';

commit;
