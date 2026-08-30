begin;

-- COMM-107, the half that was never built.
--
-- 202608280004 added the POST_NEW_MEMBER enum label and made author_id
-- nullable specifically for it ("author_id goes nullable for the authorless
-- POST_SYSTEM and POST_NEW_MEMBER rows COMM-107 renders"). cloud.js has
-- shipped renderNewMemberPostCard since Phase 1. What never existed is the
-- server-side INSERT that actually produces such a row, which 202608290004's
-- comment and cloud.js's own findNewMemberPost() comment both say in as many
-- words. The result is a rendered post type that no member has ever seen and,
-- since COMM-224 landed, a coach "Welcome" button that can never find a post
-- to comment on.
--
-- This migration adds only the producer. The renderer, the metadata shape it
-- reads, and welcomeNewMember() are all already correct and are not touched.
--
-- =====================================================================
-- Where it fires
-- =====================================================================
-- AFTER INSERT on invite_redemptions - the same MEMBER_JOINED moment
-- seed_onboarding_progress (202608290011) already triggers off, for the same
-- reason stated there: a member exists as a member the instant their
-- redemption lands, and redeemed_at is the module's authoritative join
-- timestamp (202608290002 meters the tenure achievements off the very same
-- column).
--
-- Two AFTER INSERT ROW triggers now sit on this table. That is fine and
-- deliberate: Postgres fires every matching trigger, in name order. There is
-- no ordering dependency between them - neither reads what the other wrote,
-- and neither writes a row the other selects. For the record the names sort
-- invite_redemptions_new_member_post before invite_redemptions_seed_onboarding,
-- so this one runs first; nothing depends on that and it must not start to.
-- 0033_new_member_post_test.sql asserts both actually fire on one insert
-- rather than trusting the manual.
--
-- INSERT only, never UPDATE, for the same reason 202608290011 gives:
-- grant_coach_role() and grant_coach_role_by_handle() UPDATE
-- invite_redemptions and move redeemed_at, and a promotion is not a joining.
-- INSERT ... ON CONFLICT DO UPDATE (the one-arg redeem_invite_code path)
-- fires UPDATE triggers on conflict, not INSERT ones, so a re-redemption does
-- not produce a second welcome post either.
--
-- Fires for every redemption regardless of role, not just role = 'member'.
-- A coach redeeming a coach code is a new face in the club exactly like
-- anyone else; only the promote-an-existing-member path (an UPDATE) is
-- excluded, and it is excluded by the trigger event, not by a role test. If
-- product later wants member-only, that is a one-line WHEN clause here.
--
-- =====================================================================
-- The metadata shape is fixed by an already-shipped renderer
-- =====================================================================
-- renderNewMemberPostCard reads exactly {member_id, member_name, joined_on},
-- and test/community-post-cards.test.mjs pins that fixture. This insert
-- matches it; inventing a tidier shape here would silently break a card that
-- is already in members' hands.
--
-- member_name is the one field that may legitimately be absent. A redemption
-- happens BEFORE the profile exists - profiles_insert_self (202608270003)
-- requires an invite_redemptions row to already be there - so at the moment
-- this trigger fires there is usually no display_name and no handle to read.
-- The trigger looks anyway (a profile can exist first in fixtures, in a
-- backfill, and in any future flow that reorders the two), takes
-- display_name, falls back to handle, and otherwise OMITS the key entirely
-- rather than writing a placeholder. Omitting is the honest encoding: the
-- renderer's own fallback chain (m.member_name || postAuthorName(post) ||
-- "חבר/ה חדש/ה") is what a missing name is for, whereas a stored placeholder
-- would be indistinguishable from a member who really is called that.
--
-- Known gap, flagged rather than fixed here: because of that ordering, in
-- production member_name will nearly always be absent, so the card renders
-- the generic Hebrew fallback. The welcome flow itself is unaffected -
-- coachWelcomeMember() finds the post by metadata.member_id, which is always
-- present. Closing the naming gap means writing the name in at profile
-- creation, which is a trigger on profiles and therefore identity-privacy's
-- call, not this migration's.
--
-- The trigger never creates or waits for a profile row. It only creates a
-- post.

create or replace function public.post_new_member_on_join() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
begin
  -- May find nothing: the profile usually does not exist yet. That is a
  -- normal outcome, not an error, and must not stop the post.
  select coalesce(nullif(btrim(p.display_name), ''), p.handle)
    into v_name
    from public.profiles p
   where p.id = new.user_id and p.deleted_at is null;

  -- One welcome post per member, ever. Same guard shape as the
  -- POST_CHALLENGE milestone insert in 202608290004, and backed by the same
  -- kind of partial index below. Deliberately a guard rather than a unique
  -- index: a unique violation here would abort the enclosing redemption and
  -- block a real person from joining the club over a duplicate feed post,
  -- which is far worse than the duplicate.
  if exists (
    select 1 from public.workout_posts
    where post_type = 'POST_NEW_MEMBER'
      and (metadata ->> 'member_id') = new.user_id::text
  ) then
    return new;
  end if;

  insert into public.workout_posts
    (author_id, post_type, visibility, body, metadata, status, published_at, club_id,
     source_type, source_id, occurred_on)
  values (
    null, 'POST_NEW_MEMBER', 'club',
    coalesce(v_name, 'חבר/ה חדש/ה') || ' הצטרפ/ה למועדון',
    jsonb_build_object(
      'member_id', new.user_id,
      'joined_on', new.redeemed_at
    ) || case
           when v_name is null then '{}'::jsonb
           else jsonb_build_object('member_name', v_name)
         end,
    'active', new.redeemed_at, public.default_club_id(),
    'member', new.user_id, new.redeemed_at::date
  );

  return new;
end $$;

-- No auth.uid() check, same reasoning as seed_onboarding_progress and
-- notif_queue_batched: this acts on the row being inserted, not on the
-- caller, and the boundary is that no client can insert into
-- invite_redemptions at all - redeem_invite_code() is the only way in.
revoke all on function public.post_new_member_on_join() from public, anon, authenticated;

create trigger invite_redemptions_new_member_post after insert on public.invite_redemptions
  for each row execute function public.post_new_member_on_join();

-- Serves both the guard above and the client's own lookup:
-- findNewMemberPost() in cloud.js filters POST_NEW_MEMBER by
-- metadata.member_id. Mirrors workout_posts_challenge_metadata_idx.
create index if not exists workout_posts_new_member_metadata_idx
  on public.workout_posts ((metadata ->> 'member_id'))
  where post_type = 'POST_NEW_MEMBER';

-- No backfill. 202608290011 backfilled onboarding_progress because those
-- rows are private, one per member, and invisible until the member's own
-- client asks for them. A welcome post is the opposite: it is club-visible
-- feed content, so backfilling every existing member would dump one post per
-- member into the club feed at once, all of them announcing arrivals that
-- happened months ago. If the club wants historical welcomes, that is a
-- deliberate product action with a chosen publish schedule, not a side
-- effect of a migration. Members who joined before this trigger existed
-- therefore have no welcome post and cannot be welcomed through COMM-224.

commit;
