begin;

-- COMM-001 part 1 of 2: the post_type enum, the new posts columns, and
-- the widening of the columns that were workout-specific.
--
-- The ticket calls the table `posts`. The repo's table is
-- `public.workout_posts` and it is NOT renamed here. cloud.js writes it by
-- name in four places and the reports query embeds it as a PostgREST
-- related resource (`workout_posts(title,result_text,...)`), which resolves
-- through a real foreign key and would not survive a rename plus a
-- compatibility view. `workout_posts` IS the posts table for every Phase 1
-- ticket - the name is the only thing that differs from the spec.
--
-- Part 2 (202608280005) exists because of one Postgres rule: ALTER TYPE
-- ... ADD VALUE may run inside a transaction, but the new label cannot be
-- USED until that transaction commits. The three new post_visibility
-- labels are added at the bottom of this file and first referenced in the
-- next one.

create type public.post_type as enum (
  'POST_TEXT',
  'POST_PHOTO',
  'POST_WORKOUT',
  'POST_PR',
  'POST_ACHIEVEMENT',
  'POST_ATTENDANCE_MILESTONE',
  'POST_CHALLENGE',
  'POST_EVENT',
  'POST_ANNOUNCEMENT',
  'POST_NEW_MEMBER',
  'POST_COACH',
  'POST_SYSTEM'
);

create type public.post_status as enum ('active', 'hidden', 'removed');

alter table public.workout_posts
  add column club_id uuid not null default public.default_club_id() references public.clubs(id),
  add column post_type public.post_type,
  add column status public.post_status not null default 'active',
  add column source_id uuid,
  add column body text check (body is null or char_length(body) <= 1000),
  add column metadata jsonb not null default '{}'::jsonb,
  add column is_pinned boolean not null default false,
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now();

-- Every workout-shaped column becomes optional so a POST_TEXT or
-- POST_SYSTEM row is representable. The existing length CHECKs stay: a
-- CHECK passes on null, so they only constrain rows that actually carry
-- the field. author_id goes nullable for the authorless POST_SYSTEM and
-- POST_NEW_MEMBER rows COMM-107 renders - posts_insert_self still requires
-- author_id = auth.uid(), so only a trusted server function can ever
-- create one.
alter table public.workout_posts alter column author_id drop not null;
alter table public.workout_posts alter column source_type drop not null;
alter table public.workout_posts alter column source_record_id drop not null;
alter table public.workout_posts alter column title drop not null;
alter table public.workout_posts alter column result_text drop not null;
alter table public.workout_posts alter column occurred_on drop not null;

alter table public.workout_posts drop constraint workout_posts_source_type_check;
alter table public.workout_posts add constraint workout_posts_source_type_check check (
  source_type is null or source_type in (
    'strength_entry', 'wod_entry', 'achievement',
    'challenge', 'event', 'announcement', 'member', 'system'
  )
);

-- created_at would otherwise read "the moment this migration ran" for
-- every row that already existed. published_at is the closest true value.
update public.workout_posts
set post_type = case
      when source_type = 'achievement' then 'POST_ACHIEVEMENT'::public.post_type
      else 'POST_WORKOUT'::public.post_type
    end,
    created_at = published_at,
    updated_at = published_at;

-- post_type is NOT NULL with no column default on purpose. cloud.js still
-- upserts workout and achievement shares without naming it, so a default
-- would have to be a single wrong-for-one-of-them constant. This trigger
-- derives it from what the row already says instead, which keeps the
-- current client writing correct rows and leaves an explicit post_type
-- from the Phase 1 composer untouched. It runs BEFORE INSERT, so the NOT
-- NULL constraint is checked after it has filled the column in.
create or replace function public.default_post_type() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.post_type is null then
    new.post_type := case
      when new.source_type = 'achievement' then 'POST_ACHIEVEMENT'
      when new.source_type in ('strength_entry', 'wod_entry') then 'POST_WORKOUT'
      when new.photo_path is not null then 'POST_PHOTO'
      else 'POST_TEXT'
    end::public.post_type;
  end if;
  return new;
end $$;
create trigger workout_posts_default_post_type before insert on public.workout_posts
  for each row execute function public.default_post_type();

alter table public.workout_posts alter column post_type set not null;

create trigger workout_posts_touch before update on public.workout_posts
  for each row execute function public.touch_updated_at();

create index workout_posts_type_idx on public.workout_posts(post_type, published_at desc)
  where deleted_at is null;
create index workout_posts_status_idx on public.workout_posts(status, published_at desc)
  where deleted_at is null;
create index workout_posts_source_idx on public.workout_posts(source_type, source_id);
create index workout_posts_pinned_idx on public.workout_posts(published_at desc)
  where is_pinned and deleted_at is null;

-- The last statements in this transaction. 'public' and 'followers' are
-- kept, not replaced: cloud.js sends both literals today and the app must
-- keep working across this migration. From here on 'public' is read as an
-- alias of 'club', and 'followers' as the legacy one-way-follower scope.
-- New writes use the three labels below. Nothing may reference them until
-- this transaction commits, which is what 202608280005 is for.
alter type public.post_visibility add value if not exists 'club';
alter type public.post_visibility add value if not exists 'friends';
alter type public.post_visibility add value if not exists 'only_me';

commit;
