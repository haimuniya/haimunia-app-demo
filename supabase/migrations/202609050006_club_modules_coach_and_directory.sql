begin;

-- Redesign, Phase 2. Five more club_features rows, seeded enabled - no
-- schema change beyond the insert.
--
-- WHY NO CONSTRAINT, NO RLS, NO NEW admin_actions LABEL. club_features.
-- module_key (202609010012) was declared as a SHAPE check
-- (`~ '^[a-z][a-z0-9_]{2,31}$'`), not a closed enum - unlike
-- admin_actions.action_type or reports.target_type, there is nothing to
-- widen. admin_set_club_feature() already upserts any key matching that
-- shape and already writes the 'club_feature_toggle' admin_actions row
-- (already in the closed action_type list since 202609010012) for any
-- module_key. A brand-new toggle is therefore just a seeded row plus the
-- client wiring in cloud.js's CLUB_MODULE_TOGGLES / renderCoachTab - the
-- generic mechanism was already built to take more keys.
--
-- FOUR OF THE FIVE GATE A STAFF-FACING CONVENIENCE UI, NOT MEMBER DATA -
-- and that is a real, load-bearing difference from the original six.
-- 'announcements'/'events'/'challenges'/'achievements'/'feed'/'leaderboards'
-- each gate a REAL RLS predicate a plain member's own read hits
-- (posts_feed_select, announcements_read, ...). 'member_of_week',
-- 'welcome_flow', 'monthly_recap' and 'coach_tools' gate none - they
-- decide whether a SECTION OF THE COACH TAB renders at all, and the coach-
-- only RPCs behind those sections (coach_new_members, coach_inactive_members,
-- the member-of-week candidate/publish pair, monthly_club_recaps) already
-- carry their own is_staff()/has_perm() gate independent of this flag. That
-- gate does not change here. Turning 'coach_tools' off does not lock any
-- door that was open - it declutters a coach's own tab. This is the same
-- shape 'directory' takes below and is the honest reason neither needed
-- an RLS clause added: there is no read policy to extend.
--
-- 'directory' IS DELIBERATELY THE FIFTH, MATCHING WHAT 202609010012'S OWN
-- COMMENT ALREADY SAID ABOUT IT: "directory reads straight off profiles,
-- the single most foundational read policy in the schema, so it stays a
-- client-only hide" - a decision this migration keeps, not revisits. The
-- redesign mockup shows a Directory toggle beside the others, so the flag
-- is added for that UI parity, but it hides only the "חברים" (Directory)
-- pill and its own sub-tab content - profiles remain exactly as
-- independently readable as they always were through the feed, mentions,
-- follows and every other existing surface. A club that turns this off
-- loses the standalone "browse everyone" screen, nothing more.
insert into public.club_features (module_key, enabled) values
  ('directory', true),
  ('member_of_week', true),
  ('welcome_flow', true),
  ('monthly_recap', true),
  ('coach_tools', true)
on conflict (club_id, module_key) do nothing;

commit;
