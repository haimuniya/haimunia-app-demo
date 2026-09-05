begin;

-- Redesign, Phase 3. Admin-editable copy for the new first-run intro
-- carousel (three screens shown once, before profile completion, to a
-- brand-new member who just redeemed an invite and set credentials).
--
-- A NEW, SIBLING TABLE - NOT A WIDENING OF onboarding_step_content
-- (202609030004). That table's own comment is explicit and was written on
-- purpose: "Exactly five rows, always... changing it is a migration, not
-- an app action." Its five steps (welcome/first_week/first_month/
-- first_class/third_class) are a RECURRING lifecycle system - one
-- dismissible feed card shown at different points over a member's first
-- month, gated by attendance and elapsed time (currentOnboardingStep(),
-- cloud.js). The intro carousel is a different thing entirely: three
-- screens shown back-to-back, once, before a profile even exists. Folding
-- three more keys into the five-row table would break "exactly five,
-- always" for every existing reader of that guarantee, for no shared
-- benefit - the two systems share no code path today and have no reason to
-- start.
--
-- Same shape throughout on purpose: identical RLS, the identical two
-- triggers, the identical write permission
-- (community.content.manage_onboarding, already seeded by 202609030004 -
-- reused, not re-granted) and the identical admin_actions label
-- (onboarding_content_updated / onboarding_step, already in the closed
-- list since 202609030004) - a staff member editing either system's copy
-- shows up in the audit log the same way. Reusing the pattern this
-- precisely is deliberate: anyone who has read 202609030004 already knows
-- how to read this one.
create table public.intro_carousel_content (
  -- Three fixed screens, in display order. Not an FK to anything, same as
  -- onboarding_step_content.step - these three names are a client-side
  -- constant in cloud.js (INTRO_CAROUSEL_STEPS), and the CHECK is the only
  -- place a fourth could be refused.
  step text primary key check (step in ('welcome_intro', 'club_rules', 'getting_started')),
  title text not null check (char_length(title) <= 120),
  body  text not null check (char_length(body) <= 2000),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

-- Seed: starting copy, the mockup's own three screens translated into the
-- club-agnostic voice every other seeded string in this schema uses.
insert into public.intro_carousel_content (step, title, body) values
  ('welcome_intro',
   'ברוכים הבאים',
   'אנחנו שמחים שהצטרפתם אלינו. בואו נכיר את המועדון בכמה מסכים קצרים.'),
  ('club_rules',
   'כללי המועדון',
   'שעות הפעילות, קוד הלבוש, כללי הציוד האישי ומדיניות הביטולים - כל המידע הזה זמין תמיד בלשונית הקהילה.'),
  ('getting_started',
   'איך מתחילים',
   'קבעו אימון היכרות עם מאמן/ת, וקבלו התאמה אישית לתוכנית האימונים שלכם.');

comment on table public.intro_carousel_content is
  'Redesign Phase 3. Editable title/body for the three first-run intro-carousel screens shown once to a brand-new member, before profile completion - a sibling of onboarding_step_content (202609030004), not an extension of it: that table is a closed five-row RECURRING lifecycle system: this is a closed three-row ONE-TIME first-run system, and the two share no code path. Exactly three rows, always: no insert and no delete grant for any client role. Any authenticated member may read all three (no privacy dimension); only community.content.manage_onboarding or is_admin() may update - the same permission and the same onboarding_content_updated/onboarding_step admin_actions label onboarding_step_content''s own edits use, reused rather than duplicated since both are "staff edited onboarding copy" from an audit reader''s point of view. step, updated_by and updated_at are pinned server-side by a trigger, identical in shape to onboarding_step_content_pin().';

-- ---------------------------------------------------------------------
-- RLS - byte-identical shape to onboarding_step_content's own, renamed.
-- ---------------------------------------------------------------------
alter table public.intro_carousel_content enable row level security;
revoke all on public.intro_carousel_content from public, anon, authenticated;
grant select, update on public.intro_carousel_content to authenticated;

create policy intro_carousel_content_read on public.intro_carousel_content
  for select to authenticated using (true);

create policy intro_carousel_content_write on public.intro_carousel_content
  for update to authenticated
  using (public.has_perm('community.content.manage_onboarding') or public.is_admin())
  with check (public.has_perm('community.content.manage_onboarding') or public.is_admin());

-- No insert and no delete: the step set is exactly three and changing it
-- is a migration, not an app action - identical reasoning to
-- onboarding_step_content.

-- ---------------------------------------------------------------------
-- Trigger 1: pin the columns the client must not author
-- ---------------------------------------------------------------------
create or replace function public.intro_carousel_content_pin() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.step := old.step;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $$;
revoke all on function public.intro_carousel_content_pin() from public, anon, authenticated;

create trigger intro_carousel_content_pin_updated_by
  before update on public.intro_carousel_content
  for each row execute function public.intro_carousel_content_pin();

-- ---------------------------------------------------------------------
-- Trigger 2: the audit row - same label as onboarding_step_content's own
-- edits, deliberately not a new one (see the table comment above).
-- ---------------------------------------------------------------------
create or replace function public.intro_carousel_content_audit() returns trigger
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
revoke all on function public.intro_carousel_content_audit() from public, anon, authenticated;

create trigger intro_carousel_content_audit
  after update on public.intro_carousel_content
  for each row execute function public.intro_carousel_content_audit();

commit;
