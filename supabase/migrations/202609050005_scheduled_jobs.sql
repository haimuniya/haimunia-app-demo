begin;

-- THE SCHEDULER. Six dormant jobs get a cadence, and telemetry retention gets
-- one for the first time.
--
-- Every periodic function this module has shipped since Phase 1 carries the
-- same paragraph in its own migration: "nothing is scheduled here, pg_cron is
-- not guaranteed present in the CI Supabase stack, and scheduling is infra
-- rather than schema." That was the right call each time and it is why
-- `notif_batch_flush_due()`, `recap_monthly_generate()`,
-- `recompute_feed_weights()`, `chal_notify_ending_soon()`,
-- `coach_detect_engagement_decline()`, `recap_weekly` and
-- `purge_abandoned_profiles` all exist, are tested, and have never once run on
-- their own. Batched notifications have been accumulating in
-- `notification_batches` undelivered; no monthly recap draft has ever appeared;
-- every feed weight is still the default. This file is the other half.
--
-- Confirmed before writing it: there is not one `cron.schedule` call anywhere
-- in this repo's history, real or commented-out. Three of the seven cadences
-- below are lifted verbatim from the dead comment their own migration left,
-- and are marked as such - those are decisions already made, not new ones.
--
-- WHAT `create extension` DOES ON THE LOCAL/CI STACK. Both extensions ship in
-- the Supabase Postgres image and pg_cron is already in
-- shared_preload_libraries with cron.database_name = 'postgres', which is the
-- database migrations run in - so `create extension` genuinely enables them
-- rather than erroring, and `supabase start` schedules the jobs for real. They
-- will fire against the throwaway CI stack. That is harmless and is deliberate:
-- every job below is idempotent, and the two Edge Function jobs no-op loudly
-- when their Vault secrets are still placeholders (see section 2).
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- =====================================================================
-- 1. Telemetry retention - the one NEW periodic job
-- =====================================================================
-- `feed_impressions` (202608280006) and `analytics_events` (202608280012) are
-- the only two append-only, per-interaction tables in the module with no purge
-- path of any kind. One impression row per post per feed session per member,
-- one analytics row per tracked client event: they grow without bound and
-- nothing has ever deleted from them. Everything else that accumulates either
-- has a natural ceiling (one recap per member per week) or an existing purge
-- (purge_due_accounts, purge_abandoned_profiles).
--
-- NINETY DAYS, one window for both, expressed once as the p_days default. Long
-- enough that every analytics surface built in Phase 3 still has its input -
-- analytics_dashboard() takes an explicit period, member_segments() looks back
-- 30 days, community_health_generate() scores one ISO week,
-- retention_cohorts() defaults to 6 months of COHORTS but reads
-- invite_redemptions and profiles for those, not analytics_events. The one
-- surface that would notice a shorter window is the WCAM share inside
-- analytics_dashboard() and community_health_generate(), and both are
-- comfortably inside 90 days.
--
-- RETENTION IS DESTRUCTIVE AND IRREVERSIBLE, so it is stated plainly: after
-- this job's first run, no surface can ever report on feed impressions or
-- analytics events older than 90 days, including a backfill of a historical
-- week. `community_health_scores` and `monthly_club_recaps` STORE their
-- answers, so already-computed history survives; a recompute of an old week
-- does not.
create index if not exists feed_impressions_shown_at_idx
  on public.feed_impressions(shown_at);
create index if not exists analytics_events_created_at_idx
  on public.analytics_events(created_at);

create or replace function public.retention_purge_telemetry(p_days integer default 90)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_days integer := least(greatest(coalesce(p_days, 90), 1), 3650);
  v_cutoff timestamptz := now() - make_interval(days => v_days);
  v_deleted integer := 0;
  v_n integer;
begin
  delete from public.feed_impressions where shown_at < v_cutoff;
  get diagnostics v_n = row_count;
  v_deleted := v_deleted + v_n;

  delete from public.analytics_events where created_at < v_cutoff;
  get diagnostics v_n = row_count;
  v_deleted := v_deleted + v_n;

  return v_deleted;
end $$;
revoke all on function public.retention_purge_telemetry(integer) from public, anon, authenticated;
comment on function public.retention_purge_telemetry(integer) is
  'COMM-P retention. Deletes public.feed_impressions rows with shown_at older than p_days and public.analytics_events rows with created_at older than p_days, and returns the TOTAL number of rows removed across both tables - the same "rows written" integer convention notif_batch_flush_due() and recompute_feed_weights() return. p_days defaults to 90 and is clamped to 1..3650; null is treated as 90. IRREVERSIBLE: there is no soft-delete and no archive. SECURITY DEFINER with the grant as the only gate and NO auth.uid() check, the documented exception every scheduled job in this schema carries (notif_batch_flush_due, recompute_feed_weights, seed_onboarding_progress): a cron job has no session to check. GRANTED TO NO ROLE - it runs as the job owner, and nothing a client can reach may call it. Scheduled daily as ''telemetry-retention-purge''. Deliberately covers only these two tables: they are the module''s only unbounded append-only telemetry, everything else either has a natural ceiling or an existing purge.';

-- ---------------------------------------------------------------------------
-- 1b. feed_impressions loses its direct INSERT path
-- ---------------------------------------------------------------------------
-- 202608280006 granted `insert` on feed_impressions to authenticated AND built
-- `feed_record_impressions(jsonb)` as the intended write path. Both have been
-- live ever since, and only one of them is used: cloud.js's single impression
-- call site is `client.rpc("feed_record_impressions", { p_rows: chunk })`
-- (cloud.js:2966) and there is no `.from("feed_impressions")` anywhere in the
-- client. Grepped, not assumed.
--
-- The direct grant is therefore pure attack surface, and it is not equivalent
-- to the RPC. The RPC caps a batch at 50 rows per call, clamps `position` into
-- smallint range, forces user_id to auth.uid(), and de-dupes on (user_id,
-- feed_session_id, post_id). A direct PostgREST insert satisfies only the RLS
-- policy - user_id = auth.uid() - and skips every one of those: a member could
-- write unbounded impression rows, for arbitrary posts, at arbitrary
-- positions, and so bias their own personalised feed weights (COMM-303 reads
-- feed_impressions) and inflate the impression denominators the analytics
-- dashboard divides by. It is also exactly the growth this file just added a
-- purge for.
--
-- So: the grant is revoked and the now-unreachable insert policy is dropped
-- with it, leaving one honest statement of intent rather than a policy that
-- looks live but has no grant behind it. `feed_record_impressions` is SECURITY
-- DEFINER owned by the table owner, so it is unaffected by both.
--
-- feed_impressions keeps RLS enabled and keeps `feed_impressions_self_select`,
-- so the table is still reachable by policy and still strictly own-row on read.
-- Nothing about UPDATE changes: there was never an update grant or policy, and
-- feed_record_interaction() remains the only thing that flips opened/engaged.
--
-- ANALYTICS_EVENTS IS DELIBERATELY LEFT ALONE, and this is the asymmetry a
-- later reader will otherwise try to "fix". There is NO analytics RPC. The one
-- writer, analyticsTrack() in src/analytics.js, does
-- `client.from("analytics_events").insert(row)` directly, by design, and
-- `analytics_events_insert_self` plus the props-size trigger are the whole
-- server-side contract for it. Revoking that grant would break every tracked
-- event in the product with nothing to fall back on. Only the purge above
-- applies to analytics_events.
revoke insert on public.feed_impressions from authenticated;
drop policy if exists feed_impressions_self_insert on public.feed_impressions;

-- =====================================================================
-- 2. Invoking an Edge Function from cron, without a secret in the schema
-- =====================================================================
-- Two of the seven jobs are Edge Functions (`recap_weekly`,
-- `purge_abandoned_profiles`), not SQL. cron.schedule's body is SQL, so
-- reaching them means an HTTP POST from inside Postgres - pg_net's
-- net.http_post - to
--   https://<project-ref>.supabase.co/functions/v1/<function-name>
-- with an `Authorization: Bearer <service-role-key>` header, which is the
-- caller shape both functions already verify (see the curl line at the top of
-- each index.ts).
--
-- THE SERVICE-ROLE KEY IS NOT IN THIS FILE AND MUST NEVER BE. A migration is
-- committed to git; a service-role key in one is a full-database credential in
-- every clone, every CI log and every fork, permanently. Same for the project
-- ref, which is a lesser secret but still identifies the live project from a
-- public repo. Both are read at RUN TIME out of Supabase Vault, whose
-- `vault.decrypted_secrets` view decrypts on read and is reachable only by
-- roles that can already read the whole database.
--
-- WHAT THIS MIGRATION ACTUALLY STORES: two PLACEHOLDERS, created only if a
-- secret of that name does not already exist, so re-running is safe and so a
-- project that has already had its real values set is never overwritten.
--
--   >>> WHOEVER RUNS THIS AGAINST THE LIVE HOSTED PROJECT MUST SET BOTH <<<
--
--     select vault.update_secret(
--       (select id from vault.secrets where name = 'edge_functions_base_url'),
--       'https://<project-ref>.supabase.co/functions/v1');
--     select vault.update_secret(
--       (select id from vault.secrets where name = 'edge_functions_service_role_key'),
--       '<the project''s service_role key>');
--
-- Until that happens - and it will never happen on a local `supabase start` or
-- in CI, which have no real project ref and no real key -
-- cron_invoke_edge_function() below refuses to make the request, raises a
-- NOTICE saying why, and returns null. The two jobs are scheduled and inert
-- rather than scheduled and firing POSTs at a hostname that does not exist.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'edge_functions_base_url') then
    perform vault.create_secret(
      'https://PROJECT-REF-NOT-SET.supabase.co/functions/v1',
      'edge_functions_base_url',
      'Base URL for this project''s Edge Functions, WITHOUT a trailing slash. Placeholder until set on the live project; while it contains PROJECT-REF-NOT-SET, public.cron_invoke_edge_function() refuses to fire.');
  end if;
  if not exists (select 1 from vault.secrets where name = 'edge_functions_service_role_key') then
    perform vault.create_secret(
      'SERVICE-ROLE-KEY-NOT-SET',
      'edge_functions_service_role_key',
      'The service_role key the scheduled Edge Function calls authenticate with. Placeholder until set on the live project; while it holds this literal, public.cron_invoke_edge_function() refuses to fire.');
  end if;
end $$;

create or replace function public.cron_invoke_edge_function(p_slug text)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_base text;
  v_key text;
begin
  -- The slug is concatenated into a URL, so it is validated rather than
  -- trusted, the same way notif_create() validates a notification type before
  -- it reaches a column. Only a-z, digits, underscore and dash; no slash, no
  -- dot, no scheme, so nothing can redirect this at another host or climb out
  -- of /functions/v1/.
  if p_slug is null or p_slug !~ '^[a-z][a-z0-9_-]{2,63}$' then
    raise exception 'unknown edge function %', p_slug;
  end if;

  select s.decrypted_secret into v_base
    from vault.decrypted_secrets s where s.name = 'edge_functions_base_url';
  select s.decrypted_secret into v_key
    from vault.decrypted_secrets s where s.name = 'edge_functions_service_role_key';

  if v_base is null or v_key is null
     or v_base like '%PROJECT-REF-NOT-SET%'
     or v_key = 'SERVICE-ROLE-KEY-NOT-SET' then
    raise notice 'cron_invoke_edge_function(%): skipped, the edge_functions_* Vault secrets are unset or still placeholders', p_slug;
    return null;
  end if;

  -- Fire-and-forget by design: net.http_post queues the request and returns an
  -- id immediately, so a slow or failing Edge Function cannot hold a cron
  -- worker or a transaction open. The response lands in net._http_response,
  -- which is where a run is verified after the fact.
  -- pg_net always creates its API in the `net` schema regardless of the
  -- schema the extension itself is installed into, so this qualification is
  -- stable across a hosted project (extensions) and a fresh local one.
  return net.http_post(
    url := rtrim(v_base, '/') || '/' || p_slug,
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    timeout_milliseconds := 30000
  );
end $$;
revoke all on function public.cron_invoke_edge_function(text) from public, anon, authenticated;
comment on function public.cron_invoke_edge_function(text) is
  'Scheduler bridge, 202609050005. POSTs an empty JSON body to <edge_functions_base_url>/<p_slug> with an Authorization: Bearer <service_role key> header via pg_net, and returns net.http_post''s request id. Both values are read at run time from Supabase Vault (vault.decrypted_secrets, names ''edge_functions_base_url'' and ''edge_functions_service_role_key''); NEITHER is ever written into a migration. Returns NULL and raises a NOTICE without making any request while either secret is missing or still its committed placeholder - which is the state of every local and CI stack, so the two Edge Function cron jobs are inert there. p_slug must match ^[a-z][a-z0-9_-]{2,63}$ or it raises ''unknown edge function %'', so it cannot contain a slash or a scheme and cannot redirect the call at another host. Asynchronous: pg_net queues the request, so this returns before the function has run and a failure surfaces in net._http_response, not here. SECURITY DEFINER to read vault.decrypted_secrets, with NO auth.uid() check - the documented scheduled-job exception - and GRANTED TO NO ROLE, so only the cron job owner can call it. Used by the ''recap-weekly'' and ''purge-abandoned-profiles'' jobs.';

-- =====================================================================
-- 3. The schedule
-- =====================================================================
-- cron.schedule(job_name, schedule, command) UPSERTS on job_name, so this
-- whole section is idempotent and re-running the migration re-states a cadence
-- rather than duplicating a job. Changing a cadence later is a one-line edit in
-- a new migration, not an unschedule/reschedule dance.
--
-- All times are UTC (pg_cron uses the server's timezone, which is UTC on
-- Supabase). Every job is on an odd minute rather than :00, the habit
-- 202608310006 established, so seven jobs do not stampede the same instant.
--
-- Verifying afterwards:  select jobname, schedule, active from cron.job;
--                        select * from cron.job_run_details order by start_time desc limit 20;

-- 15 minutes. VERBATIM from 202608280028's dead comment - the flusher's whole
-- design (notification_batches accumulating until a flush) assumes a short,
-- regular window, and this is the number that migration chose.
select cron.schedule('notif-batch-flush', '*/15 * * * *',
  $$select public.notif_batch_flush_due()$$);

-- Monthly, on the 1st at 04:41. VERBATIM from 202609010002's dead comment,
-- including the reasoning: it runs after the month it summarises has closed.
select cron.schedule('recap_monthly', '41 4 1 * *',
  $cron$ select public.recap_monthly_generate(); $cron$);

-- Weekly, Monday 04:17. VERBATIM from 202608310006's dead comment. That file
-- argued for one weekly rhythm on the same weekday as recap_weekly's job, which
-- is why 'recap-weekly' below is also a Monday.
select cron.schedule('feed-weights-recompute', '17 4 * * 1',
  $$select public.recompute_feed_weights()$$);

-- HOURLY, at :23. NO cadence was ever written down for this one, so this is a
-- new decision and it is argued rather than asserted: chal_notify_ending_soon()
-- exists to warn a member that a challenge closes soon, and it stamps
-- challenges.ending_soon_notified_at so a challenge is only ever announced
-- once. A daily run would make "ending soon" arrive up to 24 hours late for a
-- challenge that ends in the morning; hourly bounds that error at one hour, and
-- the idempotence stamp means the extra runs cost one indexed scan and write
-- nothing.
select cron.schedule('chal-notify-ending-soon', '23 * * * *',
  $$select public.chal_notify_ending_soon()$$);

-- DAILY at 06:17. Also a new decision. coach_detect_engagement_decline() looks
-- at multi-week attendance and engagement trends, so a signal that appears is
-- days old by construction and nothing is gained by checking it more often than
-- once a day. 06:17 UTC puts it before a European morning so a coach opening
-- their tools sees the current day's list.
select cron.schedule('coach-engagement-decline', '17 6 * * *',
  $$select public.coach_detect_engagement_decline()$$);

-- DAILY at 03:31, via the Edge Function bridge. "Purge" is a daily-hygiene
-- shape, and the function's own retention window (30 days, in its index.ts) is
-- what decides WHAT is deleted - the schedule only decides how promptly. Early
-- morning UTC keeps a deletion pass off peak. Inert until the Vault secrets are
-- set; see section 2.
select cron.schedule('purge-abandoned-profiles', '31 3 * * *',
  $$select public.cron_invoke_edge_function('purge_abandoned_profiles')$$);

-- WEEKLY, Monday 05:11, via the Edge Function bridge. recap_weekly computes the
-- most recently COMPLETED ISO week, so it has to run after a Monday boundary,
-- and Monday is the weekday 202608310006 already named as the module's weekly
-- rhythm. 05:11 puts it after 'feed-weights-recompute' at 04:17 so the two
-- weekly passes do not overlap. Inert until the Vault secrets are set.
select cron.schedule('recap-weekly', '11 5 * * 1',
  $$select public.cron_invoke_edge_function('recap_weekly')$$);

-- DAILY at 03:47. The new job from section 1. Daily rather than weekly so each
-- pass deletes roughly one day of rows instead of seven, which keeps any single
-- DELETE small; the 90-day window means the steady state is a small trailing
-- slice, not a table rewrite.
select cron.schedule('telemetry-retention-purge', '47 3 * * *',
  $$select public.retention_purge_telemetry()$$);

commit;
