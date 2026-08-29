begin;

-- COMM-153, the schema half. A posting restriction is the moderation
-- outcome that sits between "remove this one post" and "remove the member",
-- and the ticket is explicit that it is enforced by policy, not by hiding a
-- button.
--
-- Two design points worth stating up front.
--
-- 1. The table has no INSERT, UPDATE, or DELETE grant for authenticated and
--    no policy for any of the three. Every write goes through
--    mod_restrict_member() or mod_lift_restriction() below, which are
--    SECURITY DEFINER, check community.member.restrict, and call
--    log_admin_action() before returning. That is the only way to make
--    "every restriction writes an admin_actions row" a property of the
--    schema rather than a property of whichever client happened to make the
--    call. A direct PostgREST write simply has nowhere to land.
--
-- 2. The restriction is applied to post creation and comment creation only.
--    It is deliberately NOT folded into is_community_member(): that
--    predicate also gates challenge joins, event RSVPs, reactions, and
--    post_media, and a restriction is a speech sanction, not an expulsion
--    from the club. COMM-153 says "cannot create posts or comments", so
--    that is exactly what it does.

create table public.posting_restrictions (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null default public.default_club_id() references public.clubs(id),
  user_id uuid not null references public.profiles(id) on delete cascade,
  restriction_type text not null check (restriction_type in ('temporary', 'permanent')),
  -- A temporary restriction always carries an end time and a permanent one
  -- never does, so "is this permanent" can never disagree with "does this
  -- have an expiry". The pair is constrained together rather than trusted.
  expires_at timestamptz,
  reason text not null default '' check (char_length(reason) <= 500),
  -- Same reasoning as admin_actions.admin_id: not a foreign key. A
  -- restriction record has to outlive the moderator account that produced
  -- it, and purge_due_accounts() must not fail on a moderator who ever
  -- acted.
  moderator_id uuid not null,
  source_report_id uuid references public.reports(id) on delete set null,
  created_at timestamptz not null default now(),
  lifted_at timestamptz,
  lifted_by uuid,
  lift_reason text not null default '' check (char_length(lift_reason) <= 500),
  constraint posting_restrictions_expiry_matches_type check (
    (restriction_type = 'temporary' and expires_at is not null)
    or (restriction_type = 'permanent' and expires_at is null)
  ),
  constraint posting_restrictions_expiry_after_start check (
    expires_at is null or expires_at > created_at
  )
);

-- The hot lookup is "does this member have a live restriction right now",
-- run once per post insert and once per comment. Partial on lifted_at only:
-- a now() comparison is not immutable and cannot go in the index predicate,
-- so expiry is filtered at read time against a much smaller candidate set.
create index posting_restrictions_active_idx on public.posting_restrictions(user_id)
  where lifted_at is null;
create index posting_restrictions_recent_idx on public.posting_restrictions(created_at desc);

alter table public.posting_restrictions enable row level security;

revoke all on public.posting_restrictions from public, anon;
grant select on public.posting_restrictions to authenticated;

-- A member always sees their own restrictions, because "you cannot post
-- until 3 March, reason X" is information they are owed. Everyone else
-- needs a moderation permission.
create policy posting_restrictions_read on public.posting_restrictions for select to authenticated using (
  user_id = auth.uid()
  or public.has_perm('community.member.restrict')
  or public.has_perm('community.comment.moderate')
);

-- The predicate the write policies below are keyed to.
--
-- SECURITY DEFINER for one reason: a moderator UI asks about another member
-- and the answer must not depend on that member's own select policy. The
-- caller is checked first, and a caller asking about somebody else is
-- refused unless they hold a moderation permission - otherwise this would
-- become a cheap "is member X in trouble" oracle for the whole club. Called
-- with no argument, or with the caller's own id, it always answers about
-- the caller, which is the shape every policy here uses.
create or replace function public.is_posting_restricted(p_user uuid default null) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_target uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then return false; end if;
  v_target := coalesce(p_user, v_uid);
  if v_target <> v_uid
     and not public.has_perm('community.member.restrict')
     and not public.has_perm('community.comment.moderate') then
    raise exception 'not authorized';
  end if;
  return exists (
    select 1 from public.posting_restrictions r
    where r.user_id = v_target
      and r.lifted_at is null
      and (r.expires_at is null or r.expires_at > now())
  );
end $$;
revoke all on function public.is_posting_restricted(uuid) from public, anon;
grant execute on function public.is_posting_restricted(uuid) to authenticated;

-- The write path. Both functions take the permission check, the write, and
-- the audit row in one transaction, so a failed log fails the action.
create or replace function public.mod_restrict_member(
  p_user uuid,
  p_type text,
  p_expires_at timestamptz default null,
  p_reason text default '',
  p_report_id uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_id uuid;
  v_expires timestamptz;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.has_perm('community.member.restrict') then raise exception 'not authorized'; end if;
  if p_user is null then raise exception 'target member required'; end if;
  if p_user = v_uid then raise exception 'cannot restrict yourself'; end if;
  if p_type not in ('temporary', 'permanent') then
    raise exception 'unknown restriction type %', p_type;
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_user and p.deleted_at is null) then
    raise exception 'member not found';
  end if;

  -- A permanent restriction ignores any expiry the caller passed rather
  -- than rejecting it, so a UI that always sends the date picker value
  -- cannot accidentally create a row the CHECK refuses.
  v_expires := case when p_type = 'temporary' then p_expires_at else null end;
  if p_type = 'temporary' and (v_expires is null or v_expires <= now()) then
    raise exception 'a temporary restriction needs an end time in the future';
  end if;

  insert into public.posting_restrictions
    (user_id, restriction_type, expires_at, reason, moderator_id, source_report_id)
  values
    (p_user, p_type, v_expires, left(coalesce(p_reason, ''), 500), v_uid, p_report_id)
  returning id into v_id;

  perform public.log_admin_action(
    'member_restrict', 'member', p_user,
    null,
    jsonb_build_object(
      'restriction_id', v_id,
      'restriction_type', p_type,
      'expires_at', v_expires,
      'reason', left(coalesce(p_reason, ''), 500),
      'source_report_id', p_report_id
    )
  );
  return v_id;
end $$;
revoke all on function public.mod_restrict_member(uuid, text, timestamptz, text, uuid) from public, anon;
grant execute on function public.mod_restrict_member(uuid, text, timestamptz, text, uuid) to authenticated;

create or replace function public.mod_lift_restriction(p_restriction_id uuid, p_reason text default '')
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_row public.posting_restrictions;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.has_perm('community.member.restrict') then raise exception 'not authorized'; end if;

  select * into v_row from public.posting_restrictions where id = p_restriction_id;
  if not found then raise exception 'restriction not found'; end if;
  if v_row.lifted_at is not null then return; end if;

  update public.posting_restrictions
    set lifted_at = now(), lifted_by = v_uid, lift_reason = left(coalesce(p_reason, ''), 500)
  where id = p_restriction_id;

  perform public.log_admin_action(
    'member_unrestrict', 'member', v_row.user_id,
    jsonb_build_object(
      'restriction_id', v_row.id,
      'restriction_type', v_row.restriction_type,
      'expires_at', v_row.expires_at
    ),
    jsonb_build_object(
      'restriction_id', v_row.id,
      'lifted_at', now(),
      'lift_reason', left(coalesce(p_reason, ''), 500)
    )
  );
end $$;
revoke all on function public.mod_lift_restriction(uuid, text) from public, anon;
grant execute on function public.mod_lift_restriction(uuid, text) to authenticated;

-- Enforcement point 1: post creation. Rebuilt rather than edited, per the
-- forward-only rule. Everything else about the policy is byte-identical to
-- 202608280005.
drop policy posts_insert_self on public.workout_posts;
create policy posts_insert_self on public.workout_posts for insert to authenticated with check (
  author_id = auth.uid()
  and public.is_community_member()
  and public.has_perm('community.post.create')
  and not public.is_posting_restricted(auth.uid())
);

-- Enforcement point 2 (comment creation) lives in add_post_comment() and
-- lands in 202608280016, which is where that function is rewritten for
-- threading anyway.

commit;
