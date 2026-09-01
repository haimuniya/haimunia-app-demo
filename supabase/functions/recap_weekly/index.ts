// COMM-220. The weekly member recap Edge Function.
//
// First Edge Function in this repo - see supabase/config.toml's
// [edge_runtime] section, turned on for exactly this. Local test/invoke
// path: `supabase functions serve recap_weekly` (or `supabase start`,
// which now boots the same runtime), then
// `curl -X POST http://127.0.0.1:54321/functions/v1/recap_weekly -H
// "Authorization: Bearer <service_role key>"`.
//
// Scope, per the ticket:
// - Runs as service_role (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are
//   injected by the Edge Runtime automatically; nothing is hardcoded).
// - For every active member, computes the most recently COMPLETED ISO
//   week (Monday-Sunday, UTC) and upserts one weekly_recaps row, keyed on
//   (user_id, week_start) - the same unique constraint the table's own
//   comment documents as what makes this idempotent per user per week.
// - Notifies (once) only for a row that did not exist before this run.
// - Builds the classmates line (COMM-316, closing COMM-P06) by calling
//   public.recap_weekly_classmates() once per member per week - see
//   computeClassmates() below. Every privacy gate (self-exclusion, block
//   edges, visible_to_club, show_attendance on both the subject and each
//   candidate) lives inside that function, not here; this file only
//   stores whatever jsonb array it returns.
// - Never wires a scheduler (pg_cron or otherwise) - explicitly out of
//   this ticket's scope, the same "storage exists, scheduler does not"
//   shape the Phase 1 notification batch flusher left. Invoking this
//   function on a schedule is a separate, later decision.
//
// "Active member", a judgment call the ticket asks this file to document:
// WCAM (docs/community/metrics.md, ACTIVE_MEMBER_EVENTS in
// src/analytics.js) answers "who did something THIS WEEK" - a client-side
// analytics rollup, not a membership gate. Using it here would be circular
// AND would contradict the ticket's explicit "a member with zero activity
// still gets a row, never skipped" rule: the members WCAM would exclude
// are exactly the ones a quiet-week recap exists for. So "active member"
// here means "a real, current member of the club": a non-deleted profile
// with at least one invite_redemptions row (the module's own join gate,
// the same one seed_onboarding_progress fires from). This deliberately
// does NOT also require recovery_verified_at - that gate protects WRITE
// paths (is_community_member(), per contracts.md's Phase 0 notes), and
// generating a read-only recap the member did not ask for is not a write
// they make.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// The Monday (UTC) of the ISO week containing `d`. ISO weekday: Mon=1 .. Sun=7.
function isoWeekMonday(d: Date): Date {
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const isoDay = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() - (isoDay - 1));
  return utc;
}

// The most recently COMPLETED ISO week as of `now`: last week's Monday
// through last week's Sunday. Never the current, still-running week - a
// recap for a week that has not finished yet would keep changing shape
// under the member depending on when they happened to open it.
function targetWeek(now: Date): { weekStart: string; weekEnd: string } {
  const thisWeekMonday = isoWeekMonday(now);
  const lastWeekMonday = new Date(thisWeekMonday.getTime() - WEEK_MS);
  const lastWeekSunday = new Date(thisWeekMonday.getTime() - DAY_MS);
  return { weekStart: toDateStr(lastWeekMonday), weekEnd: toDateStr(lastWeekSunday) };
}

type PrRow = { movement: string; result: string; achieved_on: string };
type AchievementRow = { title: string; badge_icon: string | null; code: string | null; unlocked_at: string };
type ChallengeProgressRow = { id: string; title: string; progress: number; target: number | null };
type ClubChallengeProgress = { title?: string; participants?: number; total?: number; target?: number | null };
type UpcomingEvent = { id: string; title: string; start_at: string } | null;

// workout_posts.occurred_on is nullable (202608280004); the club's own
// community_profile()/profile_view aggregation (202608280022) already
// settled on "coalesce(occurred_on, created_at::date)" as the row's real
// training day, so this mirrors that exactly rather than inventing a
// second rule.
function rowDay(row: { occurred_on: string | null; created_at: string }): string | null {
  return row.occurred_on || (row.created_at ? row.created_at.slice(0, 10) : null);
}

async function computeSessionsAndPrs(supabase: SupabaseClient, userId: string, weekStart: string, weekEnd: string) {
  const { data, error } = await supabase
    .from("workout_posts")
    .select("post_type,occurred_on,created_at,title,body,result_text,metadata")
    .eq("author_id", userId)
    .eq("status", "active")
    .is("deleted_at", null)
    .in("post_type", ["POST_WORKOUT", "POST_PR"]);
  if (error) throw error;
  const rows = (data || []).filter((r) => {
    const day = rowDay(r);
    return !!day && day >= weekStart && day <= weekEnd;
  });
  const prs: PrRow[] = rows
    .filter((r) => r.post_type === "POST_PR")
    .map((r) => {
      const metadata = (r.metadata || {}) as Record<string, unknown>;
      return {
        movement: String(metadata.movement || r.title || ""),
        result: String(metadata.new_result || r.result_text || ""),
        achieved_on: rowDay(r) as string,
      };
    })
    .sort((a, b) => (a.achieved_on < b.achieved_on ? 1 : -1));
  return { sessions: rows.length, prs };
}

async function computeAchievements(supabase: SupabaseClient, userId: string, weekStart: string, weekEnd: string) {
  const startIso = `${weekStart}T00:00:00.000Z`;
  // Exclusive upper bound (the day after weekEnd) side-steps any ambiguity
  // about whether ":23:59:59.999Z" is "close enough" to midnight.
  const endIso = `${toDateStr(new Date(new Date(`${weekEnd}T00:00:00.000Z`).getTime() + DAY_MS))}T00:00:00.000Z`;
  const { data, error } = await supabase
    .from("member_achievements")
    .select("unlocked_at,achievement_definitions(name,icon,code)")
    .eq("user_id", userId)
    .gte("unlocked_at", startIso)
    .lt("unlocked_at", endIso);
  if (error) throw error;
  const rows: AchievementRow[] = (data || []).map((r: any) => ({
    title: r.achievement_definitions?.name || "",
    badge_icon: r.achievement_definitions?.icon || null,
    code: r.achievement_definitions?.code || null,
    unlocked_at: r.unlocked_at,
  }));
  return rows.sort((a, b) => (a.unlocked_at < b.unlocked_at ? 1 : -1));
}

// community_streaks (202608270001) already carries the exact "current
// streak" figure the Boards tab shows for this member; re-deriving it from
// activity_pings here would be a second implementation of the same island
// math to drift out of sync with. The view's own block-list filter reads
// auth.uid(), which is null for a service-role caller with no user JWT -
// harmless here since the query is already scoped to one user_id and a
// member cannot have blocked themselves.
async function computeStreak(supabase: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await supabase
    .from("community_streaks")
    .select("current_streak")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data ? Number(data.current_streak) || 0 : 0;
}

// The member's OWN standing only - never another participant's row. Every
// challenge they are still an active participant in, while the challenge
// itself is live, mirroring chal_progress()'s own "not withdrawn" /
// "active" reading.
async function computeChallengeProgress(supabase: SupabaseClient, userId: string): Promise<ChallengeProgressRow[]> {
  const { data, error } = await supabase
    .from("challenge_participants")
    .select("progress_value,challenges(id,title,target_value,status)")
    .eq("user_id", userId)
    .eq("status", "active");
  if (error) throw error;
  return (data || [])
    .filter((r: any) => r.challenges && r.challenges.status === "active")
    .map((r: any) => ({
      id: r.challenges.id,
      title: r.challenges.title,
      progress: Number(r.progress_value) || 0,
      target: r.challenges.target_value,
    }));
}

// Aggregate-only, computed once per run and shared by every member's row -
// this is the hard privacy rule COMM-220 calls out: never another
// member's individual figure, only a club total. The featured challenge is
// the soonest-ending active one, club-wide; "total" is the type-appropriate
// club-wide sum (challenge_progress.delta for cooperative/team, otherwise
// the sum of every active participant's own progress_value - still an
// aggregate, never a per-member breakdown).
async function computeClubChallengeProgress(supabase: SupabaseClient): Promise<ClubChallengeProgress> {
  const { data: challenges, error } = await supabase
    .from("challenges")
    .select("id,title,challenge_type,target_value,end_at")
    .eq("status", "active")
    .order("end_at", { ascending: true })
    .limit(1);
  if (error) throw error;
  const challenge = (challenges || [])[0];
  if (!challenge) return {};

  const { count: participants, error: participantsErr } = await supabase
    .from("challenge_participants")
    .select("user_id", { count: "exact", head: true })
    .eq("challenge_id", challenge.id)
    .neq("status", "withdrawn");
  if (participantsErr) throw participantsErr;

  let total = 0;
  if (challenge.challenge_type === "cooperative" || challenge.challenge_type === "team") {
    const { data: progressRows, error: progressErr } = await supabase
      .from("challenge_progress")
      .select("delta")
      .eq("challenge_id", challenge.id);
    if (progressErr) throw progressErr;
    total = (progressRows || []).reduce((sum: number, r: any) => sum + (Number(r.delta) || 0), 0);
  } else {
    const { data: participantRows, error: participantRowsErr } = await supabase
      .from("challenge_participants")
      .select("progress_value")
      .eq("challenge_id", challenge.id)
      .neq("status", "withdrawn");
    if (participantRowsErr) throw participantRowsErr;
    total = (participantRows || []).reduce((sum: number, r: any) => sum + (Number(r.progress_value) || 0), 0);
  }

  return { title: challenge.title, participants: participants || 0, total, target: challenge.target_value };
}

// The soonest published, non-cancelled upcoming event - the same predicate
// isUpcomingEvent() already uses client-side (cloud.js) for the feed's own
// upcoming-event card, so a member never sees two different answers to
// "what's next" depending on which surface they're looking at.
async function computeUpcomingEvent(supabase: SupabaseClient, now: Date): Promise<UpcomingEvent> {
  const { data, error } = await supabase
    .from("events")
    .select("id,title,start_at")
    .eq("status", "published")
    .gt("start_at", now.toISOString())
    .order("start_at", { ascending: true })
    .limit(1);
  if (error) throw error;
  const event = (data || [])[0];
  return event ? { id: event.id, title: event.title, start_at: event.start_at } : null;
}

// COMM-316, closing COMM-P06. The one field weekly_recaps' own column
// comment named as "not cleared to expose" until this ticket. All of the
// privacy reasoning - self-exclusion, block edges either direction,
// visible_to_club, show_attendance on the candidate AND on the subject -
// is written once, inside public.recap_weekly_classmates()
// (202609010003), which runs as security definer with p_user passed
// explicitly (can_view_profile_field() cannot be used from a service-role
// caller with no auth.uid(); see that migration's header). This function
// does not re-implement or re-check any of it: it calls the RPC and
// returns whatever jsonb array comes back, which the function's own
// contract guarantees is always an array, never null - an empty array is
// the honest "no overlap" or "opted out" case and not a distinct branch
// here.
async function computeClassmates(supabase: SupabaseClient, userId: string, weekStart: string) {
  const { data, error } = await supabase.rpc("recap_weekly_classmates", { p_user: userId, p_week_start: weekStart });
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function loadActiveMemberIds(supabase: SupabaseClient): Promise<string[]> {
  const [{ data: profiles, error: profilesErr }, { data: redemptions, error: redemptionsErr }] = await Promise.all([
    supabase.from("profiles").select("id").is("deleted_at", null),
    supabase.from("invite_redemptions").select("user_id"),
  ]);
  if (profilesErr) throw profilesErr;
  if (redemptionsErr) throw redemptionsErr;
  const redeemed = new Set((redemptions || []).map((r: any) => r.user_id));
  return (profiles || []).map((p: any) => p.id).filter((id: string) => redeemed.has(id));
}

async function buildRecapFields(
  supabase: SupabaseClient,
  userId: string,
  weekStart: string,
  weekEnd: string,
  clubChallengeProgress: ClubChallengeProgress,
  upcomingEvent: UpcomingEvent,
) {
  const [{ sessions, prs }, achievements, streak, challengeProgress, classmates] = await Promise.all([
    computeSessionsAndPrs(supabase, userId, weekStart, weekEnd),
    computeAchievements(supabase, userId, weekStart, weekEnd),
    computeStreak(supabase, userId),
    computeChallengeProgress(supabase, userId),
    computeClassmates(supabase, userId, weekStart),
  ]);
  return {
    sessions_completed: sessions,
    streak,
    prs,
    achievements,
    challenge_progress: challengeProgress,
    club_challenge_progress: clubChallengeProgress,
    upcoming_event: upcomingEvent,
    classmates,
    generated_at: new Date().toISOString(),
  };
}

async function generateRecaps(supabase: SupabaseClient, now: Date) {
  const { weekStart, weekEnd } = targetWeek(now);
  const memberIds = await loadActiveMemberIds(supabase);

  // Club-aggregate figures are identical for every member this run -
  // computed once, not once per member.
  const [clubChallengeProgress, upcomingEvent] = await Promise.all([
    computeClubChallengeProgress(supabase),
    computeUpcomingEvent(supabase, now),
  ]);

  let success = 0;
  let failure = 0;

  for (const userId of memberIds) {
    try {
      const fields = await buildRecapFields(supabase, userId, weekStart, weekEnd, clubChallengeProgress, upcomingEvent);

      // Existence check BEFORE the upsert is what tells a rerun apart from
      // a first run: the acceptance criteria is "notify once, only for a
      // row that did not already exist" - checking after the upsert can no
      // longer tell the two apart, since the row exists either way by then.
      const { data: existing, error: existingErr } = await supabase
        .from("weekly_recaps")
        .select("id")
        .eq("user_id", userId)
        .eq("week_start", weekStart)
        .maybeSingle();
      if (existingErr) throw existingErr;
      const isNewRow = !existing;

      // club_id is deliberately omitted - default_club_id() fires (granted
      // to service_role by 202608290011), same reasoning as every other
      // table in this schema.
      const { data: upserted, error: upsertErr } = await supabase
        .from("weekly_recaps")
        .upsert({ user_id: userId, week_start: weekStart, ...fields }, { onConflict: "user_id,week_start" })
        .select("id")
        .single();
      if (upsertErr) throw upsertErr;

      if (isNewRow && upserted) {
        const { error: notifErr } = await supabase.rpc("notif_create", {
          p_user: userId,
          p_type: "weekly_recap",
          p_category: "club",
          p_title: "הסיכום השבועי שלך",
          p_body: `${fields.sessions_completed} אימונים השבוע, רצף של ${fields.streak}.`,
          p_source_type: "weekly_recap",
          p_source_id: upserted.id,
          p_deep_link: `/community/recap?week=${weekStart}`,
        });
        // notif_create's own de-dupe (one hour, keyed on user/type/source)
        // is a second line, not the mechanism - the isNewRow check above
        // is what actually stops a rerun from calling it again for a row
        // it only just updated in place. A failed notify does not fail the
        // whole member: the recap row itself already landed successfully.
        if (notifErr) throw notifErr;
      }
      success++;
    } catch (_err) {
      // No personal content in logs (COMM-220): no user id, no computed
      // figures, just that generation failed for one member this run.
      console.error("recap_weekly: generation failed for one member");
      failure++;
    }
  }

  return { weekStart, weekEnd, success, failure, total: memberIds.length };
}

Deno.serve(async (req: Request) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("recap_weekly: missing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY");
    return new Response(JSON.stringify({ error: "missing service credentials" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // The platform's own verify_jwt only proves the caller presented SOME
  // valid JWT - the anon key already shipped client-side in cloud-config.js
  // satisfies it just as well as the service role key does. That is not
  // this function's intent (see the file header: "Runs as service_role"),
  // and it matters concretely here: an unauthenticated caller could
  // otherwise force club-wide recap generation on demand, repeatedly,
  // against the real database. So the check is explicit rather than
  // resting on the platform default: only a caller presenting the actual
  // service role key (a scheduler invoking this with it, or a manual
  // admin run) gets past this line.
  if (req.headers.get("Authorization") !== `Bearer ${serviceRoleKey}`) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  try {
    const result = await generateRecaps(supabase, new Date());
    console.log(`recap_weekly: week ${result.weekStart} done`, { success: result.success, failure: result.failure, total: result.total });
    return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
  } catch (_err) {
    console.error("recap_weekly: run failed");
    return new Response(JSON.stringify({ error: "recap_weekly run failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
