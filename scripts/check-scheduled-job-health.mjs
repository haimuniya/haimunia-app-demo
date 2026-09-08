#!/usr/bin/env node
// Go-live guide, item A.5. `public.scheduled_job_health()` (202609060016) has
// existed since the launch-readiness audit and is correct, but nothing was
// ever wired to actually page a human when it reports an unhealthy job -
// the exact "green job that silently does nothing" trap docs/ops/MONITORING.md
// itself warns about (`purge_due_accounts()` sat unscheduled for the life of
// the project because a job that never runs emits nothing on its own).
//
// This script is that wiring. It is deliberately a plain Node script, not
// inline shell in the workflow YAML, so it can be run and tested the same
// way locally (`node scripts/check-scheduled-job-health.mjs`) as it runs in
// CI - see .github/workflows/scheduled-job-alert.yml.
//
// Three required env vars, all secrets, none of them ever committed:
//   SUPABASE_URL                 - the project's REST URL, e.g. https://<ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY    - scheduled_job_health() is granted to
//                                  service_role only (202609060016:63-64);
//                                  there is no anon/authenticated path to it,
//                                  by design, since it can reveal operational
//                                  detail about the backend.
//   ALERT_WEBHOOK_URL            - any endpoint that accepts a JSON POST with
//                                  a "text" field (Slack and Discord incoming
//                                  webhooks both work as-is; anything else
//                                  needs its own small adapter, not this file).
//
// Exit codes: 0 = checked, all jobs healthy. 1 = checked, at least one job
// unhealthy (alert sent). 2 = could not complete the check at all (missing
// config, network/auth failure, unexpected response shape) - this is
// deliberately a DIFFERENT exit code from "unhealthy", and also sends an
// alert, because "the checker itself is broken" must never look like "all
// clear" to whoever is watching CI's green/red. Silently treating a failed
// check as success is exactly the failure mode this script exists to close.
//
// KNOWN BLIND SPOT (found 2026-09-08, not yet closed - see GO_LIVE_GUIDE.md
// §A.5 for the follow-up): this script cannot detect VAULT-1.
// `scheduled_job_health()` computes `healthy` from
// `cron.job_run_details.status = 'succeeded'` (202609060016/0018).
// `cron_invoke_edge_function()` (202609050005), which backs `recap-weekly`
// and `purge-abandoned-profiles`, responds to unset/placeholder Vault
// secrets with `raise notice` + `return null` - NOT an exception - so the
// cron job's SQL completes normally and is recorded as `succeeded` even
// when it fired nothing. For those two jobs specifically, "healthy" here
// means only "the SQL ran," not "an HTTP request left the database."
// Closing this needs a second, service_role-only check against
// `net._http_response` (not in the REST-exposed schema today - would need
// its own new migration, since applied migrations are immutable) asserting
// a row newer than each Vault-gated job's `last_run`. Documented here
// rather than silently trusted, per the exact lesson this whole check
// exists to enforce elsewhere.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL;

async function postAlert(text) {
  if (!WEBHOOK_URL) {
    console.error("ALERT_WEBHOOK_URL not set - cannot deliver this alert, printing instead:\n" + text);
    return;
  }
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error(`Webhook POST failed: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.error("Webhook POST threw:", err?.message || err);
  }
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    const msg = "scheduled-job-health check misconfigured: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY missing. The check itself did not run - this is not the same as \"all jobs healthy\".";
    console.error(msg);
    await postAlert(`⚠️ ${msg}`);
    process.exit(2);
  }

  let rows;
  try {
    const res = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/scheduled_job_health`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: "{}",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
    }
    rows = await res.json();
    if (!Array.isArray(rows)) throw new Error(`expected an array, got ${typeof rows}`);
  } catch (err) {
    const msg = `scheduled-job-health check could not reach the database: ${err?.message || err}. Treat as unverified, not healthy.`;
    console.error(msg);
    await postAlert(`⚠️ ${msg}`);
    process.exit(2);
  }

  // These two jobs can report healthy=true while doing nothing - see the
  // "KNOWN BLIND SPOT" comment at the top of this file. Named explicitly so
  // this caveat reaches whoever reads the workflow's log output, not just
  // whoever reads the source.
  const VAULT_GATED_JOBS = new Set(["recap-weekly", "purge-abandoned-profiles"]);
  const vaultGatedHealthy = rows.filter((r) => r && VAULT_GATED_JOBS.has(r.jobname) && r.healthy !== false);

  const unhealthy = rows.filter((r) => r && r.healthy === false);
  if (unhealthy.length === 0) {
    console.log(`scheduled-job-health: all ${rows.length} jobs healthy.`);
    if (vaultGatedHealthy.length > 0) {
      console.log(
        `Note: ${vaultGatedHealthy.map((r) => r.jobname).join(", ")} report healthy based on their cron SQL succeeding, ` +
        `which is also true if their Edge Function call was silently skipped due to unset Vault secrets (VAULT-1). ` +
        `This check cannot currently tell the two states apart - see GO_LIVE_GUIDE.md §A.4 for the manual net._http_response check.`
      );
    }
    process.exit(0);
  }

  const lines = unhealthy.map((r) =>
    `- *${r.jobname}*: status=${r.last_status ?? "unknown"}, last_run=${r.last_run ?? "never"}, seconds_since_last_run=${r.seconds_since_last_run ?? "n/a"}`
  );
  const msg = `🔴 ${unhealthy.length} scheduled job(s) unhealthy:\n${lines.join("\n")}\n\nQuery: select * from public.scheduled_job_health() where not healthy;`;
  console.error(msg);
  await postAlert(msg);
  process.exit(1);
}

main();
