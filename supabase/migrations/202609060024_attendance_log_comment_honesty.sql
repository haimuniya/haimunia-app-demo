begin;

-- COMMENT-ONLY MIGRATION. No table, no function, no policy, no grant, no
-- data is touched by this file. It corrects four schema comments that make
-- a claim this product cannot support.
--
-- THE CLAIM. public.attendance_log's own table comment (202609060013) opens
-- with "Verified class attendance". Three live function comments repeat the
-- phrase "verified attendance" - community_profile(), feed_leaderboard() and
-- member_segments().
--
-- WHY IT IS FALSE. attendance_log has exactly one writer, and it is not a
-- turnstile, a coach, or a booking system. It is the
-- private_records_attendance_log trigger (202608310001), which fires on the
-- member's OWN private_records rows for record_type in ('strength_entry',
-- 'wod_entry') - the two types attendance_session_record_types() names - and
-- writes one row per (user_id, occurred_on). Every value in the table is
-- therefore self-reported training that the member typed into their own
-- offline log. Nothing verifies it, because there is nothing in this product
-- that could: class scheduling and check-in belong to Arbox, which this app
-- reads from and does not manage, and 202609060020 says so outright.
--
-- WHY A COMMENT IS WORTH A MIGRATION. This exact misnomer has already caused
-- two real defects, both found by audit rather than by reading the code:
-- a privacy policy that told members their class attendance was recorded
-- when no such record exists, and a coach dashboard that reported a box
-- owner's most loyal members as never having trained. A reader who believes
-- "verified" builds the wrong mental model of what the number means, and
-- then ships a feature that acts on it. The comment IS the interface for
-- anyone opening this schema in psql or the dashboard, and it was wrong.
--
-- WHAT IS NOT CHANGED, deliberately:
--   * The COLUMN semantics, the trigger, the policies and every caller stay
--     exactly as they are. The data was never wrong; only the label on it.
--   * The `--` prose inside already-shipped migration files still says
--     "verified attendance" in several places (202608310004,
--     202608290015, 202608280020, 202609010012). Those files are immutable
--     and are the historical record of what was believed when they were
--     written. They are not edited here; this migration is the correction
--     that supersedes them, and the four comments below are what a reader
--     actually sees in the live database.
--   * consistency_week_streaks() is already clean - a later migration
--     re-declared it as "counted over public.attendance_log occurred_on
--     days" with no "verified" anywhere - so it is not restated here.
--
-- Each comment below is the live text, byte for byte, with ONLY the false
-- claim replaced. Nothing else in any of them is rewritten, because a
-- comment migration that also quietly re-words a privacy rule is how a real
-- change gets smuggled past review as a typo fix.

comment on table public.attendance_log is
  'Self-reported training days, one row per member per day - NOT verified class attendance, which this product has no source for at all (class scheduling and check-in are Arbox''s; see 202609060024). WRITES are trigger-only, from private_records_attendance_log (202608310001), which fires on the member''s own private_records rows of record_type strength_entry or wod_entry - so every row here is a workout the member logged themselves. READ ACCESS: a member reads their own rows (attendance_log_self_select); raw cross-member reads require community.analytics.view (admin/owner) as of 202609060013 - NOT plain coach rank, which is what PRIVACY.md has always promised members. Coach-facing attendance features (engagement decline, recaps, classmates, streaks, health score) read this table through SECURITY DEFINER functions instead, which is what lets them stay aggregate-only.';

comment on function public.community_profile(uuid) is
  'COMM-180 profile community section in one call, every field filtered by can_view_profile_field against the caller; an absent key means hidden. COMM-306 moved current_streak onto logged training days (attendance_log, COMM-300 - self-reported, not verified class attendance), counted as consecutive ISO weeks exactly as consistency_week_streaks() counts them set-wide, and gated it on show_attendance in addition to show_workout_results so an attendance-derived number never travels past attendance''s own toggle. training_frequency and recent_workouts still read workout_posts under show_workout_results alone - they answer what a member chose to share, which is a different question.';

comment on function public.feed_leaderboard(text, uuid, text, integer) is
  'COMM-210/211/212 leaderboard, consistency moved onto logged training days by COMM-306 (attendance_log - self-reported, not verified class attendance), gated by club_feature_enabled(''leaderboards'') by the Club Modules migration (202609010012). p_mode consistency (club-wide ISO-week streak of attendance_log training days, p_challenge_id ignored) or progress (challenge_participants.progress_value, p_challenge_id required or it raises). p_scope club or friends (are_friends mutual follows, caller always included). Every ranked member passes can_view_profile_field for in_leaderboards and visible_to_club, and in consistency mode for show_attendance as well. rank is a position with ties broken by tenure then display name. The caller''s own row is always returned, appended last with its real rank when outside p_limit (clamped 1..100).';

-- member_segments' only occurrence is inside its explanation of why
-- `declining` outranks `highly_active`. The distinction it is drawing there
-- - a training signal versus an app-engagement signal - is the right one and
-- is kept; only the word that overstates the training signal is corrected.
comment on function public.member_segments(date) is
  'COMM-311 member engagement segmentation. Returns setof jsonb, ONE ROW PER CLUB MEMBER, {user_id, display_name, handle, segment}. AUTH: security definer; auth.uid() checked first, then `has_perm(''community.analytics.view'') or is_admin()` - NOT is_staff(), so a coach is refused, exactly as analytics_dashboard() refuses one. There is no member-facing version, which is how COMM-311''s "never expose a declining label to the member it describes" is enforced end to end: a plain member holds neither the permission nor is_admin() and cannot call this at all. Raises ''not authorized'' and ''as-of date is in the future'' (both P0001); a null p_as_of means current_date. SEGMENTS, in strict precedence order: new (redeemed within 30 days of p_as_of) > declining (an open coach_engagement_flags row raised on or before p_as_of) > highly_active (WCAM-qualifying in EACH of the last 4 complete ISO weeks) > steady (in at least 4 of the last 8) > occasional (in 1 to 3 of the last 8) > dormant (in none). `occasional` is a SIXTH bucket this implementation added because COMM-311''s five are not exhaustive and its first criterion requires that they be; delete one CASE line to fold it back into dormant. `declining` deliberately outranks highly_active and steady: the flag is a decline in LOGGED TRAINING (attendance_log - self-reported, not verified class attendance) and WCAM is app engagement, so a member who stopped training but still opens notifications must not be hidden behind highly_active. WINDOW: the last 8 COMPLETE Monday-based ISO weeks before p_as_of''s own week - the week in progress is never counted, so a member is never judged on a week that has not happened. WCAM comes from analytics_wcam_events() (202609010006), the single server-side copy of the qualifying list; this function contains no second copy. Membership is COMM-310''s denominator: an invite_redemptions row redeemed before the end of p_as_of on a profile not soft-deleted before it. PRIVACY: a member with visible_to_club = false is still returned with their segment, so the counts are the whole club, but user_id, display_name and handle are ALL null so the drill-down cannot name them. The raw column is read, not can_view_profile_field(), which would short-circuit true for this function''s admin callers and would additionally drop blocked members and silently shrink a club-wide count. coach_engagement_flags'' `user_id <> auth.uid()` rule is re-applied by hand, so the caller never reads their own declining label; their row is still present, under whatever their activity says. Thresholds (30 days, 4 weeks, 8 weeks, 4-of-8) are named constants, not client parameters. Read-only, no side effects.';

commit;
