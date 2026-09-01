begin;

-- Standalone follow-up fix, found during the Phase 3 handoff cleanup, not
-- tied to a Phase 3 ticket. `invite_redemptions` has carried exactly one
-- SELECT policy since Phase 0 (202608270003), `invite_redemptions_self_
-- select`, `user_id = auth.uid()` - own row only, never widened by any
-- migration since.
--
-- THE REAL BUG THIS CLOSES. cloud.js's loadMemberRoles() (COMM-124/160,
-- "the coach badge on every surface a member is shown") runs
--   client.from("invite_redemptions").select("user_id,role").in("user_id", need)
-- as the calling member's own session - a plain RLS-enforced client read,
-- not a definer function. Against the real policy above, that query has
-- only ever been able to return the CALLER's own row; every other id in
-- `need` comes back silently absent, because RLS filters the row out
-- rather than raising. loadMemberRoles() is called from eight sites (feed
-- posts, comment threads, people search, the member directory, event
-- attendees, achievement unlock toasts) - so the coach badge feature has
-- been unable to identify anyone but the viewer themselves since it was
-- built. This was invisible to this repo's own test suite because
-- mockSupabase.mjs's plain `.from()` reads carry no RLS simulation at all
-- - several Phase 3 tickets' own agents already noted this exact blind
-- spot for other tables (COMM-311/312/313's own reports), and this is a
-- real instance of it rather than a hypothetical one, found by reading the
-- shipped RLS policy against the shipped client call rather than trusting
-- either in isolation.
--
-- THE FIX is not "widen invite_redemptions' own RLS". `role` is meant to
-- be club-public (that is the entire premise of a badge every member sees
-- on every post), but `redeemed_at` and `code` are not obviously meant to
-- be - a raw join timestamp and which invite code someone redeemed are not
-- data any surface in this schema currently exposes to a member about
-- another member, and widening the table's own SELECT policy to `using
-- (true)` would hand both out for free as a side effect of fixing the
-- badge. Postgres column grants are table-wide, not per-row, so they
-- cannot express "everyone sees role for every row, only the owner sees
-- redeemed_at" through the base table's own RLS and grant alone.
--
-- So this is the same shape this schema already uses for every other
-- "narrow, public-facing read past a stricter table policy" case
-- (community_search, feed_leaderboard, coach_celebrate_feed): one
-- SECURITY DEFINER function, returning only the two columns the badge
-- feature actually needs, for the exact ids the caller asks about - never
-- the whole table, never redeemed_at or code.
create or replace function public.member_roles(p_ids uuid[])
returns table (user_id uuid, role text)
language sql stable security definer set search_path = '' as $$
  select ir.user_id, ir.role
  from public.invite_redemptions ir
  where ir.user_id = any(coalesce(p_ids, array[]::uuid[]));
$$;

revoke all on function public.member_roles(uuid[]) from public, anon;
grant execute on function public.member_roles(uuid[]) to authenticated;

comment on function public.member_roles(uuid[]) is
  'Standalone fix, post-Phase-3. The only public read path onto invite_redemptions for a member other than yourself: {user_id, role} for exactly the requested ids, nothing else - not redeemed_at, not code, not the whole table. Backs cloud.js loadMemberRoles(), the coach badge shown on every comment/post/profile/search result. SECURITY DEFINER because invite_redemptions_self_select (202608270003) is own-row only and this table has never been given a broader SELECT policy - widening the table itself would also expose redeemed_at and code, which no surface in this schema currently shows one member about another. No auth.uid() check beyond the authenticated grant: role is club-public by design (that is what the badge feature means), so there is no narrower session-based rule to enforce here beyond "a real signed-in session". Requires no permission and no staff rank.';

commit;
