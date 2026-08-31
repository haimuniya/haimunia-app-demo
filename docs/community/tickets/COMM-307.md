# COMM-307 Post-class trained-with-you card

Phase: 3
Agent: feed
Status: todo
Attendance-blocked: was — unblocked by COMM-300

Closes the parked COMM-P05, and is the second half of the forward reference
in `docs/community/contracts.md`'s `people_suggestions` entry: "COMM-302 and
COMM-307 add a verified-attendance recurring-classmate signal to the same
function name and the same returned shape." COMM-302 adds the signal to the
suggestions strip; this ticket is the feed-top-area surface that reads the
same underlying overlap for a different purpose — "who else trained around
the same time as you today", not "who to follow".

## User outcome

Right after logging a session, a member sees who else from the club trained
on the same day — a small, low-friction nudge toward people they are
already training alongside in real life, without a new check-in flow or a
class roster to browse.

## Acceptance criteria

- [ ] A new card in the feed top area (COMM-115's existing slot pattern,
  same place the upcoming-event card lives) appears when the member has an
  `attendance_log` row for today and at least one other club member also
  does, listing up to a small number of those members (a name, avatar, and
  handle each) with a link to their profile.
- [ ] The card is omitted entirely — no heading, no empty state — when the
  member has not logged a session today, or when nobody else has: this
  matches COMM-232's own "on no signal, show nothing" precedent rather than
  inventing a new empty-state pattern for a card this ticket's user outcome
  says is about a real moment, not a permanent fixture.
- [ ] Only members passing `can_view_profile_field(candidate,
  'show_attendance')` for both sides of the pair, and with no block edge in
  either direction, ever appear — the caller's own `show_attendance` gates
  whether they can see the card's content at all (off means the card never
  renders for them, even though their own attendance is still logged and
  still counts elsewhere), and each listed candidate independently passes
  the same toggle.
- [ ] A follow action from the card reuses the existing `follow()`
  insert-or-delete path (COMM-230), no new follow mechanism.
- [ ] No "Message" affordance on the card, per the phase's standing
  no-messaging resolution.
- [ ] `event_viewed`-style analytics: a `classmates_card_viewed` event (or
  reuse of an existing pattern the platform agent judges closer) is added
  and documented in `docs/community/metrics.md` in the same change,
  matching the standing "a feature agent that adds a surface adds a row"
  rule. Not counted for WCAM — viewing a card is not participation, same
  reasoning `leaderboard_viewed` already uses.

## Frontend states

- Empty / omitted: no session logged today, or no overlapping classmate —
  card does not render at all.
- Loading: the feed top area's existing skeleton pattern (COMM-115).
- Error: the card is silently omitted on a failed fetch, same as
  `people_suggestions`'s own "no heading, no empty state, no retry" choice.
- Populated: up to a small fixed number of classmate rows, each with a
  Follow control where `allow_follows` and no existing edge permit one.

## Client calls and contracts

- New: `attendance_classmates_today() returns setof jsonb`, one object per
  candidate: `{user_id, display_name, handle, avatar_url}`. `security
  definer`, same boundary-crossing reason `people_suggestions` already
  documents (a member cannot otherwise see who else has an `attendance_log`
  row). No count, no streak, no historical overlap here — that is
  `people_suggestions`'s `shared_classmate_days` job (COMM-302), this
  function answers "today" only.
- Reuses `follow()` (existing, COMM-230).

## Validation rules and limits

- "Today" is the caller's own `occurred_on = current_date` row; no window,
  no lookback — that is the entire distinction from COMM-302's signal.
- Capped at a small fixed number of rows (matching `people_suggestions`'s
  own limit shape, clamp 1..20, default a smaller number appropriate to a
  card rather than a full strip — feed agent's call within that range).

## Migration outline

- `create or replace function public.attendance_classmates_today() returns
  setof jsonb` — `security definer`, `auth.uid()` checked first, joins
  `attendance_log` to itself on `occurred_on = current_date`, excludes the
  caller, excludes block edges and `show_attendance`-off candidates on
  either side.
- No new table. Depends on `attendance_log` (COMM-300).

## Dependencies

- COMM-115, COMM-230, COMM-300, COMM-302 (shares the privacy gating logic
  and should not diverge from it).
