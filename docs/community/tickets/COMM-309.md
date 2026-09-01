# COMM-309 Monthly club recap Edge Function with admin preview

Phase: 3
Agent: recaps
Status: review — both halves shipped (202609010002 schema, cloud.js client)
Attendance-blocked: no

IMPLEMENTATION NOTE, decided in 202609010002 and recorded because this
ticket's outline left it open: generation shipped as a service-role-only
POSTGRES FUNCTION, `public.recap_monthly_generate(p_month_start date
default null) returns uuid`, NOT as a `supabase/functions/recap_monthly`
Edge Function. The client never calls or triggers generation. It calls
`recap_monthly_publish(p_id)` and reads `monthly_club_recaps` under RLS.
Full reasoning in the migration header and in contracts.md, "## Needs from
schema, monthly club recap (COMM-309, Phase 3)".

ONE THING THE CLIENT HALF MUST GET RIGHT: the preview boundary is WIDER
than the publish boundary. A coach can read a draft (`is_staff()`), but
publishing requires `community.analytics.view` or `is_admin()`, which a
coach does not hold. Gate the "פרסם" control on the permission, not on
staffness, or a coach is shown a button the database refuses.

Contracts.md already carries a stub for this ticket's Edge Function
(`recap_monthly_club`, "Schedule: monthly. Admin preview before publish.
Output: aggregate club figures. No member names in public sections.") — this
ticket is that stub, built out, and its own client surface.

## User outcome

Once a month, the club as a whole sees an honest aggregate summary of how the
community trained and engaged — after a staff member has had a chance to
glance at it first, since this is a club-wide, permanent post rather than a
private per-member recap.

## Acceptance criteria

- [ ] `recap_monthly_club` Edge Function runs monthly and is idempotent per
  calendar month: a rerun for a month already generated updates the draft
  row in place, never duplicates, and never re-publishes an already
  published one.
- [ ] Content is club-wide aggregate only: total sessions logged
  (`attendance_log` count, club-wide — this is the first place aggregate
  attendance figures are club-visible, distinct from any per-member
  breakdown, matching `weekly_recaps.club_challenge_progress`'s existing
  "aggregate figures only, never per-member" rule), total posts, total new
  members, total challenges completed, total events held. No member name,
  handle, or individually-attributable figure anywhere in the generated
  content.
- [ ] The generated row starts unpublished (a draft). It is not visible to
  any member, and no `notif_create` call fires, until a staff member
  explicitly publishes it.
- [ ] A staff `community.analytics.view` or admin-permission holder can
  preview the draft (read the unpublished row) and publish it through one
  action. Publishing stamps `published_at`, and only then fans out a
  `monthly_club_recap` notification to the club and makes the row readable
  by plain members.
- [ ] A published recap cannot be un-published or edited by this ticket's
  scope — a mistaken figure is corrected by staff manually adjusting the
  next real data source, not by rewriting a historical recap, matching the
  "content is what it was published as" posture the rest of this schema
  already takes toward posted content.
- [ ] Records success and failure counts with no personal content in its
  logs, same discipline `recap_weekly` already established.

## Frontend states

- Empty (member view, before any month is published): the surface simply
  does not show a monthly recap entry.
- Loading: skeleton card, same shape as the weekly recap surface (COMM-221).
- Error (staff preview): "לא ניתן היה לטעון את התקציר לתצוגה מקדימה."
- Populated (staff preview): the draft figures plus a "פרסם" control.
- Populated (member, post-publish): the published aggregate figures, no
  per-member data anywhere.

## Client calls and contracts

- Not directly client-invoked for generation — runs as a scheduled Edge
  Function, same shape as `recap_weekly`.
- New: direct RLS read on `monthly_club_recaps` — a staff/analytics-holder
  can read any row (draft or published); a plain member can read only a
  `published_at is not null` row.
- New: `recap_monthly_publish(p_id uuid) returns void` — security definer,
  requires `community.analytics.view` or real `is_admin`, stamps
  `published_at`, fans out the notification. Writes one `admin_actions` row
  (`target_type = 'monthly_club_recap'`), matching every other staff action
  that crosses RLS in this schema.

## Validation rules and limits

- One row per calendar month, enforced by a unique constraint, matching
  `weekly_recaps`'s `(user_id, week_start)` idempotency shape but keyed on
  month alone (club-wide, not per-user).
- `notif_create`'s existing dedupe window and preference/block checks apply
  to the publish fan-out exactly as they do for `weekly_recap`.

## Migration outline

- `monthly_club_recaps(id uuid pk, club_id uuid not null default
  default_club_id(), month_start date not null unique check
  (extract(day from month_start) = 1), sessions_logged integer not null
  default 0, posts_created integer not null default 0, new_members integer
  not null default 0, challenges_completed integer not null default 0,
  events_held integer not null default 0, generated_at timestamptz not null
  default now(), published_at timestamptz)`.
- RLS: staff/`community.analytics.view` select any row; plain member select
  only `published_at is not null`; no client insert, update, or delete
  grant — only the Edge Function (service role) inserts, only
  `recap_monthly_publish` updates `published_at`.
- `recap_monthly_publish(p_id uuid)` as above.

## Dependencies

- COMM-005, COMM-026, COMM-220, COMM-300 (for the attendance figure; every
  other figure is already available without it).
