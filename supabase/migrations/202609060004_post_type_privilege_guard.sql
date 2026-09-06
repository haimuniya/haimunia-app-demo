begin;

-- Launch-readiness audit, finding 4: any member can promote their own post
-- to POST_COACH.
--
-- THE HOLE, verified live in BOTH directions by a plain member with no role
-- and no permissions:
--
--   update public.workout_posts set post_type = 'POST_COACH' where id = <own post>;   -- accepted
--   insert into public.workout_posts (author_id, post_type) values (me, 'POST_COACH'); -- accepted
--
-- posts_insert_self and posts_update_self (202608260001, last re-declared by
-- 202608280015 and never widened since) gate the AUTHOR of a row and say
-- nothing at all about its post_type. default_post_type() (202608280004)
-- only fills the column when it arrives NULL, so an explicit privileged
-- value sails past it untouched. Nothing else looks.
--
-- WHAT THE LABEL BUYS, which is why this is a privilege boundary and not a
-- cosmetic one:
--   * the "מאמן/ת" coach badge on the card (cloud.js renderCoachPostCard)
--   * +10 of feed_page's 110 available ranking points
--     (202608310006, v_coach_post) - a permanent boost on every future
--     ranking pass, not a one-off
--   * membership of the `coach` feed scope, which is otherwise
--     post_type in ('POST_COACH', 'POST_ANNOUNCEMENT') and nothing else
-- A member could therefore award themselves staff attribution and a
-- ranking subsidy with one PostgREST call.
--
-- WHY A TRIGGER AND NOT A POLICY. A WITH CHECK could express the INSERT
-- half, but an UPDATE policy's WITH CHECK sees only the new row - it cannot
-- distinguish "this row already was POST_COACH and is being edited for
-- something else" from "this row is being promoted right now", so a policy
-- would either refuse legitimate later edits of a real coach post or permit
-- the promotion. The same reasoning challenge_participants_guard_team()
-- (202609010005) spells out for team_id. It has to be a trigger.
--
-- THE PREDICATE IS COPIED, NOT INVENTED. It is byte-for-byte the
-- `author_is_staff` branch feed_page already computes for the exact same
-- purpose - deciding whether a post's author is staff - at
-- 202608310006 line ~931. Two different answers to "is this author staff"
-- is how a boost gets awarded for a badge that is not shown, or the reverse.
--
-- THE author_id IS NULL EXEMPTION IS LOAD-BEARING. Every legitimate producer
-- of the four privileged labels writes an AUTHORLESS row: POST_NEW_MEMBER
-- from post_new_member_on_join (202608290014), POST_ANNOUNCEMENT from
-- member_of_week_publish (202609010001), and the same shape is what
-- challenge_progress_apply and attendance_milestones_on_log use for their
-- own authorless types. There is no server producer of these labels with an
-- author, and without this exemption every one of them would break.
--
-- NOT SCOPED TO auth.role() = 'authenticated', unlike the guards in
-- 202609010005. Those pin a value to one function and are therefore about
-- the SESSION; this asserts a fact about the ROW's own author, which is
-- equally true for the service role, a dashboard edit and a future backfill.
-- A staff-attributed post by a non-staff author is wrong no matter who
-- wrote it.
--
-- The two legitimate client writes of POST_COACH keep working unchanged:
-- congratulateCelebrateItem() and coachEngageReachOut() (cloud.js) both do
-- post_create followed by an own-row update to POST_COACH, and both run only
-- on staff-gated surfaces, so their author always passes.

create or replace function public.workout_posts_guard_privileged_type() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- An UPDATE that names post_type in its SET list fires this trigger even
  -- when the value does not move. Editing the caption of a real coach post
  -- must not be refused.
  if tg_op = 'UPDATE' and new.post_type is not distinct from old.post_type then
    return new;
  end if;

  if new.post_type not in ('POST_COACH', 'POST_ANNOUNCEMENT', 'POST_SYSTEM', 'POST_NEW_MEMBER') then
    return new;
  end if;

  -- Server-authored rows. Every real producer of these four labels is here.
  if new.author_id is null then
    return new;
  end if;

  if exists (
        select 1 from public.invite_redemptions ir
        where ir.user_id = new.author_id and public.role_rank(ir.role) >= 20
      )
     or exists (
        select 1 from public.profiles pf
        where pf.id = new.author_id and pf.is_admin and pf.deleted_at is null
      )
  then
    return new;
  end if;

  raise exception 'post type is staff only';
end $$;
revoke all on function public.workout_posts_guard_privileged_type() from public, anon, authenticated;

-- Named to sort AFTER workout_posts_default_post_type, so on INSERT the
-- column is already filled when this runs. The order is not load-bearing -
-- default_post_type never produces a privileged label, so this trigger
-- seeing a NULL would simply pass - but relying on that accident would be a
-- trap for whoever edits either one next.
drop trigger if exists workout_posts_guard_privileged_type on public.workout_posts;
create trigger workout_posts_guard_privileged_type
  before insert or update of post_type on public.workout_posts
  for each row execute function public.workout_posts_guard_privileged_type();

comment on function public.workout_posts_guard_privileged_type() is
  'Launch-readiness audit. BEFORE INSERT OR UPDATE OF post_type on workout_posts. Raises ''post type is staff only'' (P0001) when a row would carry POST_COACH, POST_ANNOUNCEMENT, POST_SYSTEM or POST_NEW_MEMBER and its author_id is a member who is neither redeemed at role_rank >= 20 nor profiles.is_admin - the identical predicate feed_page computes as author_is_staff, so the badge, the +10 coach ranking weight and the coach feed scope cannot be self-awarded. author_id is null is exempt: every legitimate producer of these four labels writes an authorless row. An UPDATE that leaves post_type unchanged returns early, so editing a real coach post is untouched. Applies on every write path including the service role: the rule is a fact about the row''s author, not about the session.';

commit;
