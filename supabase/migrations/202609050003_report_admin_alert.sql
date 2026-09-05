begin;

-- Proactive moderator alert: a new report notifies the club's moderators
-- immediately, instead of sitting in mod_queue until somebody thinks to look.
--
-- Shape, and it is deliberately the boring one: an AFTER INSERT trigger on
-- public.reports that calls the EXISTING public.notif_create() once per
-- recipient - the same calling convention notif_on_comment(),
-- notif_on_mention() and notif_on_achievement() (202608280027) already use, and
-- the same one notif_announcement_fanout() uses for a whole-club loop. No email
-- path, no webhook, no new delivery infrastructure: the alert lands in the
-- moderator's in-app notification stream and is picked up by notif_list() /
-- notif_unread_count() and by web push (COMM-229) with no client change.
--
-- =====================================================================
-- notifications.type NEEDS NO WIDENING - checked, not assumed
-- =====================================================================
-- Unlike admin_actions.action_type and reports.target_type, notifications.type
-- is NOT a closed list. 202608280008 declares it
--   type text not null check (type ~ '^[a-z][a-z0-9_.]{2,63}$')
-- and notif_create() re-checks that same regex before inserting. 'new_report'
-- satisfies it, so there is nothing to widen and no CHECK is touched here.
-- notif_pref_key() (202608280026) maps any type with no coarser settings-screen
-- bucket to ITSELF, so the preference key is also 'new_report' and a moderator
-- who does not want these can write one notification_preferences row with
-- channel = 'off'. That is a real behaviour and it is intended: the queue is
-- still there for anyone who mutes the ping.
--
-- =====================================================================
-- EVERYTHING notif_create() ALREADY DOES, AND IS NOT BYPASSED HERE
-- =====================================================================
-- The loop below hands each recipient to notif_create() and ignores the
-- returned id, which means all four of its suppression rules stay in force:
--   1. RECIPIENT IS NEVER THE ACTOR. A moderator who files a report does not
--      get pinged about their own report. 'new_report' is not one of the
--      self-directed types, so this is exactly right.
--   2. BLOCK EDGE. A moderator who has blocked the reporter (or is blocked by
--      them) is not notified. Named rather than hidden: that moderator can
--      still see the report in mod_queue, which is definer and ignores blocks,
--      so nothing is lost - only the push is.
--   3. PREFERENCE. An explicit 'off' row on 'new_report' suppresses; a missing
--      row means delivered. 'new_report' is not operational, so an 'off' row is
--      honoured.
--   4. DE-DUPE, and this one is load-bearing. notif_create() collapses an
--      identical (user, type, source_id) inside notif_dedupe_window() (1 hour).
--      source_id here is the REPORTED TARGET, not the report row, precisely so
--      that a pile-on - five members reporting the same post inside a minute -
--      produces ONE alert per moderator rather than five. mod_queue already
--      folds those five reports into one row for the same reason; the
--      notification now matches the queue it points at.
--
-- One consequence of (4) worth stating: a target reported again more than an
-- hour later alerts again, and a target reported again within the hour does
-- not, even if the first report was already dismissed. That is the window
-- notif_dedupe_window() defines in one place, and changing it changes this too.
--
-- The ON CONFLICT in report() (202609050002) is the other half of the
-- noise control. A member re-reporting the same target UPDATEs their existing
-- row, and `on conflict do update` fires UPDATE triggers, not INSERT ones - so
-- this trigger never fires for a refreshed duplicate.

-- ---------------------------------------------------------------------------
-- 1. Who counts as a moderator, computed for a member OTHER than the caller
-- ---------------------------------------------------------------------------
-- has_perm() is caller-relative: it reads auth.uid() and answers about the
-- session. A trigger fanning out to other people cannot use it, the same
-- problem notif_on_achievement() hit with are_friends() and solved by
-- computing the mutual-follow join directly. This is that solution for the
-- moderation gate.
--
-- The recipient set is EXACTLY the set mod_queue() and mod_review() admit -
-- has_perm('community.comment.moderate') OR a real profiles.is_admin row -
-- expressed per-row instead of per-session. Anyone who can act on the queue is
-- told there is something in it; nobody else is. Seeded today that is coach,
-- head_coach, staff, admin and owner (202608280001), plus the legacy
-- profiles.is_admin flag, and it tracks role_permissions automatically if that
-- seeding ever changes - which is the whole reason it is a join and not a
-- hardcoded role list.
--
-- The owner arm mirrors has_perm()'s owner shortcut: owner holds every
-- permission whether or not a role_permissions row says so.
create or replace function public.mod_alert_recipients(p_club_id uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select p.id
  from public.profiles p
  where p.deleted_at is null
    and p.club_id = p_club_id
    and (
      p.is_admin
      or exists (
        select 1
        from public.invite_redemptions ir
        where ir.user_id = p.id
          and (
            ir.role = 'owner'
            or exists (
              select 1 from public.role_permissions rp
              where rp.role_code = ir.role
                and rp.permission_code = 'community.comment.moderate'
            )
          )
      )
    )
  order by p.id;
$$;
revoke all on function public.mod_alert_recipients(uuid) from public, anon, authenticated;
comment on function public.mod_alert_recipients(uuid) is
  'COMM-153 internal. Every member of p_club_id who may act on the moderation queue: a non-deleted profile that is either profiles.is_admin or holds ''community.comment.moderate'' through its invite_redemptions role (owner short-circuits, mirroring has_perm). This is the per-ROW form of the per-SESSION gate mod_queue() and mod_review() use, needed because has_perm() answers about auth.uid() and a fan-out asks about someone else. SECURITY DEFINER to read profiles, invite_redemptions and role_permissions past their own RLS; no auth.uid() check because it never acts on the caller''s behalf and never returns anything a caller could not derive - the boundary is that it is GRANTED TO NO ROLE and callable only from another definer function. Ordered by profiles.id so a fan-out is deterministic. Returns no rows for a null or unknown club.';

-- ---------------------------------------------------------------------------
-- 2. The trigger
-- ---------------------------------------------------------------------------
-- Club scoping: the reporter's own profiles.club_id, falling back to
-- default_club_id() if the reporter row cannot be read (it always can - the
-- reports.reporter_id FK guarantees the row exists - but the fallback keeps a
-- future hard-delete from silently sending the alert nowhere). The module is
-- single-club today, so today this always resolves to the one club; it is
-- written per-reporter rather than as default_club_id() so the day a second
-- club exists, one club's reports do not page another club's staff.
create or replace function public.notif_on_report() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_club uuid;
  v_post_id uuid;
  v_label text;
  v_link text;
  v_mod uuid;
begin
  select p.club_id into v_club from public.profiles p where p.id = new.reporter_id;
  if v_club is null then v_club := public.default_club_id(); end if;

  -- deep_link is an in-app route, never an external URL, and must satisfy
  -- notifications_deep_link_check. Each branch points at the reported thing
  -- itself so a moderator lands on it, not on a generic queue screen;
  -- source_type/source_id are the client's documented fallback when a deep
  -- link cannot be parsed, and they carry the same target.
  if new.target_type = 'post' then
    v_label := 'post';
    v_link := '/community/feed?post=' || new.target_id::text;
  elsif new.target_type = 'comment' then
    v_label := 'comment';
    select c.post_id into v_post_id from public.post_comments c where c.id = new.target_id;
    v_link := case
      when v_post_id is null then '/community/feed'
      else '/community/feed?post=' || v_post_id::text || '&comment=' || new.target_id::text
    end;
  else
    v_label := 'profile';
    v_link := '/community/account?user=' || new.target_id::text;
  end if;

  for v_mod in select * from public.mod_alert_recipients(v_club) loop
    perform public.notif_create(
      v_mod, 'new_report', 'community',
      'New report to review',
      'A ' || v_label || ' was reported (' || new.reason || ')',
      new.target_type, new.target_id, v_link
    );
  end loop;

  return null;
end $$;
revoke all on function public.notif_on_report() from public, anon, authenticated;
comment on function public.notif_on_report() is
  'COMM-153. AFTER INSERT ON public.reports, FOR EACH ROW. Notifies every mod_alert_recipients() member of the REPORTER''s club with an immediate ''new_report'' notification (category ''community'') through notif_create(), which applies the self-notify, block-edge, preference and de-dupe filters unchanged. source_type/source_id and the deep link point at the REPORTED TARGET, not at the report row, so notif_create''s 1-hour de-dupe collapses a pile-on on one target into a single alert per moderator - matching the way mod_queue folds those same reports into one row. Deep links: /community/feed?post=<id> for a post, /community/feed?post=<post>&comment=<id> for a comment, /community/account?user=<id> for a profile. Returns NULL (AFTER trigger). Does not fire for the ON CONFLICT DO UPDATE path in report(), because that fires UPDATE triggers, not INSERT ones - so refreshing a duplicate report is silent. Writes nothing but notifications: no audit row, no status change.';

create trigger reports_notify_moderators after insert on public.reports
  for each row execute function public.notif_on_report();

commit;
