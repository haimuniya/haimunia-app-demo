# COMM-315 Member of the week rotation across recognition categories

Phase: 3
Agent: coach-tools
Status: review — schema half shipped as 202609010001; client half open
Attendance-blocked: no

No forward reference for this ticket exists anywhere in
`docs/community/contracts.md` or `docs/community/backlog.md` today. The
scope below is a conservative, best-effort reading of the title against
data already available from Phase 1/2 (consistency streaks, PRs, challenge
completions) plus COMM-306's verified-attendance streak once it lands.
**Confirmed with the user 2026-08-31: build against the proposed rotation
below as-is.**

## User outcome

Each week, one member is recognized publicly for a specific, rotating
reason — not always "most PRs", not always the same kind of member winning
— so recognition stays varied and reaches different kinds of contribution
over time.

## Acceptance criteria

- [ ] A fixed, named rotation of recognition categories (proposed:
  consistency streak, most PRs this week, challenge completion, coach's
  pick), cycling one category per week in a stated order, not randomly —
  a stated order is auditable and repeatable, a random one is not.
- [ ] For every category except "coach's pick", the candidate is computed
  automatically from existing data (`feed_leaderboard`'s consistency mode,
  `workout_posts` PR count in the week, `challenge_participants` completions
  in the week) and presented to staff as a suggestion, not auto-published —
  matching COMM-309's "generated draft, staff publishes" pattern rather
  than auto-posting to the club unattended.
- [ ] "Coach's pick" is a free staff selection among any club member for
  that week, with a short reason staff types (capped, same 500-char shape
  `member_contact_log.note` and `challenge_progress.note` already use).
- [ ] Every candidate still passes the subject's own relevant privacy
  toggle before being suggested (`in_leaderboards` for the streak/challenge
  categories, `show_prs` for the PR category) — this ticket never surfaces
  a member's private data as a suggestion, matching
  `coach_celebrate_feed`'s existing "surfaces what a coach could already
  see" rule.
- [ ] Publishing creates one authorless `POST_ANNOUNCEMENT`-shaped
  celebratory post (or reuses `coach_congratulate_sent`'s existing
  comment-on-the-member's-card pattern, COMM-225 — feature agent's call
  between the two, stated explicitly in the implementation, not left
  ambiguous) naming the member, the category, and the reason.
- [ ] A member cannot be picked in two consecutive weeks, so recognition
  spreads rather than repeating the same top performer.

## Frontend states

- Empty: no candidate found for the week's category (for example nobody
  logged a PR that week) shows "אין מועמדים השבוע לקטגוריה זו" and staff
  can fall back to coach's pick.
- Loading: skeleton candidate card.
- Error: "לא ניתן היה לטעון את המועמדים."
- Populated: the suggested candidate(s) for the week's category, a publish
  control, and the coach's-pick free-selection form.

## Client calls and contracts

- New: `member_of_week_candidates(p_week_start date default null) returns
  setof jsonb` — security definer, staff (`is_staff()`) required, returns
  the current rotation category and its candidate(s) for the week.
- New: `member_of_week_publish(p_week_start date, p_user_id uuid, p_reason
  text) returns uuid` — security definer, staff required, refuses a
  `p_user_id` picked in the immediately prior week, writes the celebratory
  post and one `admin_actions` row.

## Validation rules and limits

- `p_reason` trimmed, capped at 500 chars.
- One publish per club per week — a second call for a week already
  published updates nothing and raises, matching `weekly_recaps`'s
  once-per-period discipline.

## Migration outline

- `member_of_week(id uuid pk, club_id uuid not null default
  default_club_id(), week_start date not null unique, category text not
  null, user_id uuid not null references profiles(id), reason text not
  null default '' check (char_length(reason) <= 500), post_id uuid
  references workout_posts(id), published_by uuid references profiles(id),
  published_at timestamptz not null default now())`.
- RLS: club-wide select for `authenticated` (it is a public celebration
  once published); no client write grant — only
  `member_of_week_publish` writes.
- `member_of_week_candidates(p_week_start)` and
  `member_of_week_publish(p_week_start, p_user_id, p_reason)` as above.

## Dependencies

- COMM-210, COMM-223, COMM-225, COMM-306 (for the consistency category to
  read verified attendance once it exists; the PR and challenge categories
  do not need it).

## Open question

The exact category set, the rotation order, and whether "coach's pick" is
even a real spec category are not grounded in text available to this
session. Flagged rather than guessed at specifics beyond the shape above.

## Resolution, schema half (202609010001)

Answered by the build; full reasoning is in the migration's own comments and
in contracts.md, "Needs from schema, member of the week (COMM-315, Phase 3)".

- **Rotation index**: whole weeks since the epoch Monday `2026-01-05`,
  modulo 4, in `member_of_week_category(date)` — the single copy of the
  rule. Deliberately not "ISO week number mod 4": an ISO year has 52 or 53
  weeks, so that form repeats a category two weeks running at every 53-week
  year (2026 is one).
- **Post pattern**: an authorless, club-visibility `POST_ANNOUNCEMENT`, the
  first producer that post type has ever had. Not COMM-225's
  comment-on-the-member's-card pattern, which needs a source post that three
  of the four categories do not have; and authorless rather than
  coach-authored because member of the week is club voice, with
  `member_of_week.published_by` carrying the accountability.
- **Coach's-pick fallback**: the category is derived at publish rather than
  passed, so the three-parameter signature stands. Publishing somebody the
  week's computed shortlist did not contain *is* a coach's pick and the row
  records it as one.
- **Two refusals beyond the two named above**: an empty reason on a coach's
  pick, and a member whose `visible_to_club` is false (read from the raw
  column, not `can_view_profile_field()`, because publishing is
  broadcasting).
- **Known limitation**: the consistency category reads `feed_leaderboard`,
  which reports the streak as of now and takes no as-of date, so publishing
  a months-old week under that category credits a present-day streak.
