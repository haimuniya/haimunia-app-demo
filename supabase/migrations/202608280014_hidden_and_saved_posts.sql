begin;

-- COMM-108. The two personal, per-member lists the post action menu writes:
-- "Hide post" and "Save". Both were deliberately left out of Phase 0 and
-- land here as the first of the small Phase 1 schema migrations.
--
-- Neither table is visible to anybody but its owner. There is no count, no
-- aggregate, and no "N members saved this" surface anywhere in the spec, so
-- a strictly own-row policy on all four verbs is the whole security model.
-- That matters for hidden_posts in particular: knowing who muted you is
-- exactly the signal a hide feature must never leak back to the author.
--
-- Same shape twice rather than one table with a `kind` column. A single
-- table would need a partial index per kind anyway, and the two lists have
-- different lifetimes: a hide is permanent for that member, a save is a
-- toggle the member flips back and forth.

create table public.hidden_posts (
  user_id uuid not null references public.profiles(id) on delete cascade,
  post_id uuid not null references public.workout_posts(id) on delete cascade,
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);
-- feed_page (COMM-110) filters on (user_id, post_id) as an anti-join, which
-- the primary key already serves. The reverse index exists so a later
-- "how many members hid this" moderation signal does not need a seq scan.
create index hidden_posts_post_idx on public.hidden_posts(post_id);

create table public.saved_posts (
  user_id uuid not null references public.profiles(id) on delete cascade,
  post_id uuid not null references public.workout_posts(id) on delete cascade,
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);
-- The saved list is rendered newest first for one member at a time.
create index saved_posts_user_idx on public.saved_posts(user_id, created_at desc);

alter table public.hidden_posts enable row level security;
alter table public.saved_posts enable row level security;

revoke all on public.hidden_posts, public.saved_posts from public, anon;
grant select, insert, delete on public.hidden_posts to authenticated;
grant select, insert, delete on public.saved_posts to authenticated;

-- No UPDATE grant and no update policy on either table. Both rows are pure
-- (user_id, post_id) facts: the only meaningful edit is deleting the row,
-- which is what "unhide" and "unsave" already are.

create policy hidden_posts_self_select on public.hidden_posts for select to authenticated
  using (user_id = auth.uid());
create policy hidden_posts_self_delete on public.hidden_posts for delete to authenticated
  using (user_id = auth.uid());

create policy saved_posts_self_select on public.saved_posts for select to authenticated
  using (user_id = auth.uid());
create policy saved_posts_self_delete on public.saved_posts for delete to authenticated
  using (user_id = auth.uid());

-- Insert carries is_community_member() on both, per the standing rule that
-- a member write path keeps the recovery_verified_at requirement.
--
-- Worth flagging for identity-privacy rather than hiding in a policy: this
-- makes "hide this post" unavailable to an account that has not set a
-- recovery method yet, even though a hidden_posts row is invisible to
-- everyone but its owner and exposes nothing. If muting content turns out
-- to be something an unverified member must be able to do, dropping
-- is_community_member() from hidden_posts_self_insert alone is a one-line
-- later migration and changes no other boundary. The gate is kept here on
-- purpose so the decision is made deliberately and not by omission.
--
-- post_visible_to_viewer() is also required: a member cannot seed a hide or
-- a save row for a post they were never allowed to see, which would
-- otherwise be a cheap existence oracle for only_me and friends posts.
create policy hidden_posts_self_insert on public.hidden_posts for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.is_community_member()
    and public.post_visible_to_viewer(post_id)
  );

create policy saved_posts_self_insert on public.saved_posts for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.is_community_member()
    and public.post_visible_to_viewer(post_id)
  );

commit;
