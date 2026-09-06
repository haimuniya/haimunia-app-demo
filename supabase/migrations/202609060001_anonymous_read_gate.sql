begin;

-- Launch-readiness audit, finding 1: the anonymous read gate.
--
-- THE HOLE. Anonymous sign-in is enabled on the real project and the
-- publishable key ships in the browser bundle, so ANY visitor can mint a
-- real `authenticated` JWT with a real auth.uid() in one unauthenticated
-- POST to /auth/v1/signup, with no invite code, no invite redemption, no
-- profile row and no recovery method. Three read policies were written
-- `to authenticated ... using (<no membership predicate>)`, which for this
-- schema has always meant "anyone who can obtain a token":
--
--   profiles_read_authenticated  (202608280003, last touched there)
--   posts_feed_select            (202609010012's re-declaration is live)
--   announcements_read           (202609010012's re-declaration is live)
--
-- Two independent audit passes confirmed it live against a fresh stack: an
-- anonymous session read the same 13 relations, row for row, that a fully
-- redeemed member did - every display name, handle, bio and avatar in the
-- club, every club/public post with its author, and every announcement.
-- That is a confidentiality breach open to the public internet, not a
-- privilege-escalation edge case, and it is the single most urgent item the
-- audit found.
--
-- THE PREDICATE. public.is_community_member() (202608280003) already exists
-- and already means exactly the right thing for this - "a live profile with
-- a verified recovery method AND a redeemed invite". Every WRITE in the
-- module is already keyed to it. Inventing a second, read-only "has
-- redeemed" predicate would create two answers to one question and
-- guarantee they drift, so this reuses the one that exists.
--
-- WHY THIS DOES NOT LOCK OUT A LEGITIMATE MID-ONBOARDING MEMBER.
-- 202608280003's own comment reserved read paths on purpose ("an account
-- still setting up its recovery method can look around, it just cannot
-- contribute"). That intent predates the client that actually shipped:
-- renderCommunityApp() returns the COMM-016 recovery-gate card AND NOTHING
-- ELSE while recovery_verified_at is null (cloud.js ~10467), and
-- ensureCommunityDataLoaded() refuses to run any loader at all until the
-- same column is stamped (cloud.js ~813). There is no surface in the
-- shipped app for an unverified account to "look around" with. The reserved
-- read window is not a feature anyone can reach; it is only the hole above.
--
-- THE SELF BRANCH IS LOAD-BEARING, on profiles and on workout_posts. The
-- onboarding order is: redeem -> insert profile (profiles_insert_self forces
-- recovery_verified_at null) -> read the row back -> mark_recovery_verified().
-- Gating the WHOLE profiles predicate would break step three: the client
-- could never read back the profile it just created, so it would render the
-- "complete your profile" form forever and the member could never reach the
-- verification button. So the gate is applied to the OTHER-MEMBER branches
-- only; `id = auth.uid()` (and `author_id = auth.uid()`) stay exactly as
-- they were. An anonymous session has no profile row and no posts, so it
-- gains nothing from either.
--
-- WHAT IS DELIBERATELY NOT GATED, and this is the security agent's own
-- explicit recommendation, not an oversight: intro_carousel_content
-- (202609050007), onboarding_step_content (202609030004) and the
-- club_features flags (202609010012). All three are read BEFORE redemption
-- by design - they are the pre-redemption onboarding screens themselves -
-- and 0066's own assertion says so in as many words ("this is exactly who
-- the carousel is FOR, so it cannot be gated behind the very thing it
-- precedes"). None of the three carries a single member-identifying field.

-- =====================================================================
-- 1. is_community_member() becomes SECURITY DEFINER
-- =====================================================================
-- Required, not cosmetic. The function reads public.profiles, and as a
-- SECURITY INVOKER function it reads it UNDER RLS. The moment
-- profiles_read_authenticated calls it, Postgres has to evaluate
-- profiles' own policy to evaluate profiles' own policy, and refuses with
-- "infinite recursion detected in policy for relation profiles". The same
-- loop reaches it indirectly from posts_feed_select and announcements_read,
-- which read profiles through the function and would re-enter the profiles
-- policy from there.
--
-- Definer is the shape this schema already uses for exactly this problem:
-- can_view_profile_field() (202608280003, same migration) is definer for
-- the same reason - it has to read a row the caller's own RLS may hide.
-- role_rank(), has_perm() and my_role_code() are all definer as well.
--
-- The semantics do not change by a single row. The old invoker form read
-- exactly one profiles row, `p.id = auth.uid()`, which
-- profiles_read_authenticated has always returned to its owner
-- unconditionally, and one invite_redemptions row for the same uid, which
-- that table's own policy has always returned to its owner. Definer rights
-- reach the same two rows without asking. The auth.uid() null check is now
-- explicit and first, per the module's standing rule for definer functions,
-- rather than implied by a predicate that could not match.
create or replace function public.is_community_member() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then return false; end if;
  return exists (
    select 1 from public.profiles p
    where p.id = v_uid and p.deleted_at is null and p.recovery_verified_at is not null
  ) and exists (
    select 1 from public.invite_redemptions ir where ir.user_id = v_uid
  );
end $$;
revoke all on function public.is_community_member() from public, anon;
grant execute on function public.is_community_member() to authenticated;

comment on function public.is_community_member() is
  'The community access predicate: true when the caller has a live profile (deleted_at null) with a verified recovery method AND a redeemed invite. Every community WRITE policy is keyed to it, and since the launch-readiness audit every member-data READ policy is too (profiles_read_authenticated, posts_feed_select, announcements_read) - which is what stops an anonymous sign-in session, which holds a real authenticated JWT and nothing else, from reading the club. SECURITY DEFINER since that change: as an invoker function it read public.profiles under RLS, so a profiles policy calling it recursed into itself. Same reason can_view_profile_field() next to it is definer. auth.uid() is checked first and null returns false; the function only ever answers about the caller.';

-- =====================================================================
-- 2. profiles_read_authenticated
-- =====================================================================
-- Every clause is the live 202608280003 predicate, unchanged, except that
-- the two OTHER-member branches (visible_to_club, is_admin()) now sit
-- behind is_community_member(). Reading your own row is untouched, for the
-- onboarding reason above.
drop policy if exists profiles_read_authenticated on public.profiles;
create policy profiles_read_authenticated on public.profiles for select to authenticated using (
  deleted_at is null
  and not exists (
    select 1 from public.blocks b
    where (b.blocker_id = auth.uid() and b.blocked_id = id)
       or (b.blocker_id = id and b.blocked_id = auth.uid())
  )
  and (
    id = auth.uid()
    or (public.is_community_member() and (visible_to_club or public.is_admin()))
  )
);

-- =====================================================================
-- 3. posts_feed_select
-- =====================================================================
-- Every clause is the live 202609010012 predicate, unchanged, with
-- is_community_member() folded into the non-author branch. The author
-- branch is left ungated for symmetry with profiles, and costs nothing: an
-- account that cannot pass is_community_member() cannot pass
-- posts_insert_self either (it has carried the same predicate since
-- 202608280015), so it can never have a post of its own to read.
drop policy if exists posts_feed_select on public.workout_posts;
create policy posts_feed_select on public.workout_posts for select to authenticated using (
  deleted_at is null
  and not exists (
    select 1 from public.blocks b
    where (b.blocker_id = auth.uid() and b.blocked_id = author_id)
       or (b.blocker_id = author_id and b.blocked_id = auth.uid())
  )
  and (
    author_id = auth.uid()
    or (
      public.is_community_member()
      and status = 'active'
      and (
        visibility in ('public', 'club')
        or (visibility = 'followers' and exists (
              select 1 from public.follows f
              where f.follower_id = auth.uid() and f.followed_id = author_id))
        or (visibility = 'friends' and public.are_friends(author_id))
      )
    )
  )
  and public.club_feature_enabled('feed')
);

-- =====================================================================
-- 4. announcements_read
-- =====================================================================
-- Every clause is the live 202609010012 predicate, unchanged, plus the
-- gate. No self branch here: an announcement has no "own row" for a
-- pre-redemption account - announcements_insert_admin has required
-- is_staff() since 202608270006, and every staff account is redeemed and
-- verified by construction.
drop policy if exists announcements_read on public.announcements;
create policy announcements_read on public.announcements for select to authenticated
  using (
    deleted_at is null
    and (expires_at is null or expires_at > now() or public.is_staff())
    and public.club_feature_enabled('announcements')
    and public.is_community_member()
  );

commit;
