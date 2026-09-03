begin;

-- COMM-373. The five onboarding cards' title and body move out of
-- hardcoded strings in cloud.js and into a table staff can edit from the
-- app, with no deploy.
--
-- WHAT THIS DOES NOT DO, both by explicit instruction:
--   * It does not change WHICH step is due when.
--     currentOnboardingStep()'s fixed precedence is untouched - cloud.js
--     documents that order as a deliberate anti-reorder decision from
--     COMM-222/COMM-316, and no copy edit can affect it. Backlog Phase 4
--     open question 5.
--   * It is not a template engine. first_week's active-challenge sentence
--     and first_month's sessions/PRs/achievements summary are computed at
--     render time from client state and stay in cloud.js, appended AFTER
--     this table's body.
--
-- THE SEEDED BODIES FOR first_week AND first_month ARE EMPTY STRINGS, and
-- that is the correct byte-for-byte seed rather than an omission. Read
-- cloud.js's five renderers: welcome, first_class and third_class each
-- pass a fixed literal body, so that literal is seeded here verbatim.
-- first_week and first_month pass a body that is *entirely* computed (an
-- active-challenge sentence or its no-challenge alternative; a
-- loading/error/summary triple) - there is no fixed lead sentence in
-- either one today. Seeding '' preserves the current render exactly (lead,
-- then the computed sentence) and gives staff somewhere to add a standing
-- lead later, which is precisely what "appended after this table's body"
-- buys. Hence the CHECK is an upper bound only; an empty body is legal on
-- purpose.

create table public.onboarding_step_content (
  -- The closed set, in precedence order. Not an FK to anything: these five
  -- names are a client-side constant in cloud.js and three of them are
  -- also onboarding_progress column stems (202608290011), so the CHECK is
  -- the only place a sixth could be refused.
  step text primary key check (step in
    ('welcome', 'first_week', 'first_month', 'first_class', 'third_class')),
  title text not null check (char_length(title) <= 120),
  body  text not null check (char_length(body) <= 2000),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

-- Seed: the current live copy, verbatim from cloud.js's
-- renderOnboardingWelcomeStep / FirstWeek / FirstMonth / FirstClass /
-- ThirdClass. First deploy changes nothing a member sees.
insert into public.onboarding_step_content (step, title, body) values
  ('welcome',
   'ברוכים הבאים לקהילה!',
   'כאן רואים מה קורה במועדון, ואפשר לשתף אימונים ושיאים ולהגיב לחברים אחרים. לחיצה על "כתיבת פוסט" למעלה פותחת את השיתוף הראשון שלכם.'),
  ('first_week',
   'השבוע הראשון שלכם מאחוריכם',
   ''),
  ('first_month',
   'החודש הראשון שלכם במועדון',
   ''),
  ('first_class',
   'הגעתם לאימון הראשון!',
   'האימון הראשון שלכם כבר נרשם במערכת. ממשיכים באותו הקצב?'),
  ('third_class',
   'אימון שלישי — אתם כבר בקצב!',
   'שלושה אימונים כבר מאחוריכם. ככה בונים הרגל אימונים.');

comment on table public.onboarding_step_content is
  'COMM-373. Editable title/body for the five onboarding cards. Exactly five rows, always: no insert and no delete grant for any client role, so a reader expecting five never finds four. Any authenticated member may read all five (same audience the cards already have, no privacy dimension); only community.content.manage_onboarding or is_admin() may update. step, updated_by and updated_at are pinned server-side by a trigger. first_week and first_month carry an empty body on purpose - their visible body is computed in cloud.js and appended after this one.';

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.onboarding_step_content enable row level security;
revoke all on public.onboarding_step_content from public, anon, authenticated;
grant select, update on public.onboarding_step_content to authenticated;

-- Club copy, shown to every member. No viewer-relative dimension at all,
-- which is why this is `using (true)` and not routed through
-- can_view_profile_field or club_feature_enabled.
create policy onboarding_step_content_read on public.onboarding_step_content
  for select to authenticated using (true);

-- The write boundary. Both halves gated, not just USING: without the WITH
-- CHECK a permitted row could be updated into a shape by someone who
-- cannot - here the predicate does not reference the row at all, so the two
-- are the same test, but stating both is the house rule and keeps the
-- policy correct if the predicate ever becomes row-dependent.
create policy onboarding_step_content_write on public.onboarding_step_content
  for update to authenticated
  using (public.has_perm('community.content.manage_onboarding') or public.is_admin())
  with check (public.has_perm('community.content.manage_onboarding') or public.is_admin());

-- No insert and no delete: not merely no policy, no GRANT either. The step
-- set is exactly five and changing it is a migration, not an app action.

-- ---------------------------------------------------------------------
-- Trigger 1: pin the columns the client must not author
-- ---------------------------------------------------------------------
-- Same "the trigger pins the column, the policy stays permissive" shape
-- protect_is_admin() established in 202608270003. Three columns are pinned,
-- one more than COMM-373's outline named:
--
--   updated_by  -> auth.uid(), so authorship cannot be forged;
--   updated_at  -> now(),      so a stale or future stamp cannot be sent;
--   step        -> old.step,   which the outline did not mention and which
--                  matters: `step` is the primary key and the client holds
--                  UPDATE on the whole row, so without this a staff member
--                  could rename 'welcome' to 'first_class' and leave the
--                  table with four distinct steps and a duplicate-key
--                  error, breaking COMM-373's own "five rows always exist"
--                  criterion through the one grant that IS given.
--
-- Not `security definer`: it writes only to the row already being
-- updated and needs no elevation. auth.uid() is read, not checked - a
-- session-less update (a migration, service_role, the SQL editor)
-- legitimately has none and leaves updated_by null, which is honest.
create or replace function public.onboarding_step_content_pin() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.step := old.step;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $$;
revoke all on function public.onboarding_step_content_pin() from public, anon, authenticated;

create trigger onboarding_step_content_pin_updated_by
  before update on public.onboarding_step_content
  for each row execute function public.onboarding_step_content_pin();

-- ---------------------------------------------------------------------
-- Trigger 2: the audit row
-- ---------------------------------------------------------------------
-- The module's standing rule that a staff write to shared content is
-- audited. `security definer` because log_admin_action is granted to no
-- client role at all (202608280002) - crossing that boundary is the one
-- reason this needs elevation.
--
-- Two guards the outline did not name, both real:
--   * auth.uid() null -> skip. log_admin_action RAISES 'not authorized'
--     on a null uid, so without this guard a service_role or SQL-editor
--     copy fix would fail outright rather than simply going unattributed.
--   * nothing actually changed -> skip. The pin trigger above rewrites
--     updated_at on every update, so an idempotent save from the editor
--     screen would otherwise mint an audit row recording no change.
create or replace function public.onboarding_step_content_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return null; end if;
  if old.title = new.title and old.body = new.body then return null; end if;

  perform public.log_admin_action(
    'onboarding_content_updated', 'onboarding_step', null,
    jsonb_build_object('step', old.step, 'title', old.title, 'body', old.body),
    jsonb_build_object('step', new.step, 'title', new.title, 'body', new.body));
  return null;
end $$;
revoke all on function public.onboarding_step_content_audit() from public, anon, authenticated;

create trigger onboarding_step_content_audit
  after update on public.onboarding_step_content
  for each row execute function public.onboarding_step_content_audit();

-- ---------------------------------------------------------------------
-- Permission
-- ---------------------------------------------------------------------
-- The same list community.announcement.publish already holds: onboarding
-- copy is club-wide messaging in the same spirit as an announcement.
insert into public.permissions (code, description) values
  ('community.content.manage_onboarding', 'Edit the onboarding step cards'' title and body');
insert into public.role_permissions (role_code, permission_code) values
  ('coach',      'community.content.manage_onboarding'),
  ('head_coach', 'community.content.manage_onboarding'),
  ('staff',      'community.content.manage_onboarding'),
  ('admin',      'community.content.manage_onboarding'),
  ('owner',      'community.content.manage_onboarding');

-- ---------------------------------------------------------------------
-- admin_actions labels
-- ---------------------------------------------------------------------
alter table public.admin_actions drop constraint if exists admin_actions_action_type_check;
alter table public.admin_actions add constraint admin_actions_action_type_check check (action_type in (
  'content_delete', 'content_hide', 'member_restrict', 'member_unrestrict',
  'role_change', 'challenge_edit', 'achievement_edit', 'privacy_config',
  'content_pin', 'content_unpin', 'report_review',
  'member_of_week_publish',
  'monthly_recap_publish',
  'club_feature_toggle',
  'invite_created', 'invite_revoked',
  'shared_code_created', 'shared_code_status_changed',
  -- COMM-373.
  'onboarding_content_updated'
));

alter table public.admin_actions drop constraint if exists admin_actions_target_type_check;
alter table public.admin_actions add constraint admin_actions_target_type_check check (target_type in (
  'post', 'comment', 'member', 'role', 'challenge', 'achievement',
  'event', 'announcement', 'report', 'club',
  'monthly_club_recap',
  'challenge_participant', 'challenge_team',
  'invite', 'invite_code',
  -- COMM-373.
  'onboarding_step'
));

commit;
