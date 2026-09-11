begin;

-- Security hunt, round 6 (2026-09-12), client-side-security-theater agent.
--
-- THE FINDING. ach_claim() (202608290002) independently verifies only the
-- tenure_days metric server-side; its own comment already documents, as a
-- known and accepted gap, that every other client_claimable metric
-- (session_count, pr_count, week_streak, pr_category_spread, rx_count) "has
-- no server-side source yet" and is trusted purely on the client's say-so.
-- Confirmed live against real local Postgres: a brand-new member with zero
-- training history -
--   select * from public.ach_claim(array['sessions_250','pr_100',
--     'well_rounded','consistency_weeks_52']);
-- - was granted four genuine top-tier member_achievements rows for nothing.
-- That alone was an accepted, documented tradeoff (a local training log has
-- no independent server record unless synced, and the celebration itself is
-- always local first). What was NOT accepted, and is the actual
-- vulnerability: round 4's own forgery guard (202609110004) gates
-- POST_ACHIEVEMENT on "does a real member_achievements row exist for the
-- caller", exactly the row ach_claim() will manufacture for free - so the
-- forged badge does not stay a private, cosmetic inflation. ach_share()
-- turns it into a real, club-visible feed post with the achievement
-- ranking boost, rendered on the member's public profile as genuinely
-- earned, with zero requirement that anything about it was ever actually
-- verified.
--
-- THE FIX, SCOPED TO WHAT IS ACTUALLY VERIFIABLE. Reconstructing five
-- metrics' worth of training history from private_records was considered
-- and rejected: private_records is itself client-supplied JSON with no
-- structural validation trigger (a member can upsert an arbitrary payload
-- for their own user_id), so "verify against private_records" would not
-- close anything, only move the same forgery one step sideways while
-- making this migration far larger and slower to review. What genuinely IS
-- independently checkable, today, is exactly the set already carved out:
-- tenure (invite_redemptions.redeemed_at) and attendance (attendance_log,
-- via attendance_milestones_on_log()). Everything else stays
-- client-claimable - the local celebration and the badge count are
-- unaffected - but is now marked unverified, and unverified achievements
-- can no longer be shared to the feed. This closes the actual damaging
-- consequence (fabricated public social proof) without pretending to
-- solve the harder, still-open problem this table's own history already
-- flags (an offline training log has no independent server record unless
-- synced).
--
-- A single BEFORE INSERT trigger on member_achievements computes `verified`
-- from the definition row itself, rather than trusting whichever function
-- performed the insert to set it correctly - the same reasoning as every
-- transaction-local pin elsewhere in this schema: the boundary is checked
-- once, centrally, not re-implemented at every call site (ach_claim,
-- attendance_milestones_on_log, and any future insertion path all get this
-- for free, with no further migration required for a genuinely new
-- server-verifiable metric that reuses trigger_type = 'ATTENDANCE_RECORDED'
-- or config->>'metric' = 'tenure_days').

alter table public.member_achievements
  add column if not exists verified boolean not null default false;

create or replace function public.member_achievements_compute_verified() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_def public.achievement_definitions;
begin
  select * into v_def from public.achievement_definitions d where d.id = new.achievement_id;
  -- Authoritative, not advisory: overrides whatever the inserting function
  -- tried to set, so a future bug in ach_claim (or any new caller) cannot
  -- accidentally mark an unverifiable claim as verified.
  new.verified := (
    found
    and (
      v_def.trigger_type = 'ATTENDANCE_RECORDED'
      or coalesce(v_def.config ->> 'metric', '') = 'tenure_days'
    )
  );
  return new;
end $$;
revoke all on function public.member_achievements_compute_verified() from public, anon, authenticated;

drop trigger if exists member_achievements_verified_trg on public.member_achievements;
create trigger member_achievements_verified_trg
  before insert on public.member_achievements
  for each row execute function public.member_achievements_compute_verified();

comment on column public.member_achievements.verified is
  'Security hunt round 6 (202609120001). true only for a claim independently checkable server-side (attendance_log-backed, or invite_redemptions-backed tenure) - computed by member_achievements_verified_trg from the definition row, never client- or caller-supplied. Every other client_claimable metric (session_count, pr_count, week_streak, pr_category_spread, rx_count) still has no independent server record and is stamped false: the local celebration and badge count are unaffected, but ach_share() now refuses to turn an unverified claim into a public feed post.';

-- ach_share(): one new refusal, same shape as the visibility/ownership
-- checks immediately above it. Byte-identical to 202609110004 otherwise.
create or replace function public.ach_share(
  member_achievement_id uuid,
  caption text default '',
  media jsonb default '[]'::jsonb,
  p_idempotency_key uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_body text;
  v_media_count integer := 0;
  v_post_id uuid;
  v_item jsonb;
  v_idx integer := 0;
  v_replay boolean;
  v_prior jsonb;
  v_ma public.member_achievements;
  v_def public.achievement_definitions;
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;

  select i.is_replay, i.prior_result into v_replay, v_prior
  from public.idem_begin('ach_share', p_idempotency_key) i;
  if v_replay then return nullif(v_prior #>> '{}', '')::uuid; end if;

  if not public.is_community_member() then raise exception 'recovery method required'; end if;
  if not public.has_perm('community.post.create') then raise exception 'not authorized'; end if;
  if public.is_posting_restricted(v_uid) then raise exception 'posting_restricted'; end if;

  if member_achievement_id is null then raise exception 'achievement is required'; end if;

  select * into v_ma from public.member_achievements ma where ma.id = member_achievement_id;
  if not found then raise exception 'achievement not found'; end if;
  -- The ownership boundary. Not 'achievement not found': the row does exist
  -- and refusing it as missing would be a lie to the one member whose
  -- achievement it is not.
  if v_ma.user_id is distinct from v_uid then raise exception 'not authorized'; end if;
  if v_ma.visibility = 'only_me' then raise exception 'a private achievement cannot be shared'; end if;
  -- Security hunt round 6 (202609120001). member_achievements.verified is
  -- computed server-side, unconditionally, by member_achievements_verified_trg
  -- - a member holding a genuine row for an unverifiable (client-claimed)
  -- metric still gets the local celebration and the badge count, just not a
  -- public social-proof post manufactured from a claim nothing here
  -- actually checked.
  if not v_ma.verified then raise exception 'achievement not verified'; end if;

  select * into v_def from public.achievement_definitions d where d.id = v_ma.achievement_id;
  if not found then raise exception 'achievement not found'; end if;

  -- Natural idempotency, same reasoning as pr_share's.
  select p.id into v_post_id
  from public.workout_posts p
  where p.author_id = v_uid
    and p.source_type = 'achievement'
    and p.source_record_id = member_achievement_id::text
  limit 1;
  if v_post_id is not null then
    update public.member_achievements
       set shared_at = now()
     where id = member_achievement_id and shared_at is null;
    perform public.idem_complete('ach_share', p_idempotency_key, to_jsonb(v_post_id));
    return v_post_id;
  end if;

  if not public.check_rate_limit('post_create', 20, 10) then raise exception 'rate_limited'; end if;

  v_body := regexp_replace(
    coalesce(caption, ''),
    '[' || chr(1) || '-' || chr(8) || chr(11) || '-' || chr(31) || ']',
    '', 'g');
  v_body := left(btrim(v_body), 1000);

  if media is not null and jsonb_typeof(media) = 'array' then
    v_media_count := jsonb_array_length(media);
  end if;
  if v_media_count > 4 then raise exception 'at most 4 photos per post'; end if;

  perform set_config('app.allow_unrated_post_insert', 'on', true);
  perform set_config('app.allow_pr_achievement_write', 'on', true);
  insert into public.workout_posts (
    author_id, post_type, visibility, body, title, result_text,
    source_type, source_record_id, source_id, occurred_on, metadata, status, published_at)
  values (
    v_uid, 'POST_ACHIEVEMENT', v_ma.visibility::public.post_visibility,
    nullif(v_body, ''), left(v_def.name, 120), nullif(left(v_def.description, 240), ''),
    'achievement', member_achievement_id::text, member_achievement_id,
    v_ma.unlocked_at::date,
    jsonb_strip_nulls(jsonb_build_object(
      'achievement_id', v_ma.id,
      'code', v_def.code,
      'title', v_def.name,
      'badge_icon', v_def.icon,
      'explanation', nullif(v_def.description, ''),
      'earned_on', v_ma.unlocked_at::date)),
    'active', now())
  returning id into v_post_id;
  perform set_config('app.allow_pr_achievement_write', 'off', true);
  perform set_config('app.allow_unrated_post_insert', 'off', true);

  if v_media_count > 0 then
    for v_item in select value from jsonb_array_elements(media)
    loop
      if coalesce(v_item ->> 'storage_path', '') = '' then
        raise exception 'each media item needs a storage_path';
      end if;
      insert into public.post_media (post_id, storage_path, alt_text, decorative, "position", width, height)
      values (
        v_post_id,
        v_item ->> 'storage_path',
        nullif(v_item ->> 'alt_text', ''),
        coalesce((v_item ->> 'decorative')::boolean, false),
        coalesce((v_item ->> 'position')::smallint, v_idx::smallint),
        nullif(v_item ->> 'width', '')::integer,
        nullif(v_item ->> 'height', '')::integer
      );
      v_idx := v_idx + 1;
    end loop;
  end if;

  update public.member_achievements
     set shared_at = now()
   where id = member_achievement_id and shared_at is null;

  perform public.idem_complete('ach_share', p_idempotency_key, to_jsonb(v_post_id));
  return v_post_id;
end $$;
revoke all on function public.ach_share(uuid, text, jsonb, uuid) from public, anon;
grant execute on function public.ach_share(uuid, text, jsonb, uuid) to authenticated;

comment on function public.ach_share(uuid, text, jsonb, uuid) is
  'Security hunt round 6 (202609120001): refuses to share an achievement whose member_achievements.verified is false (computed server-side by member_achievements_verified_trg, never caller-supplied) - closes ach_claim''s documented client-claimable-metric trust gap at the one point it produced a real, damaging consequence (a forged achievement becoming a public feed post). Otherwise byte-identical to 202609110004 - see that migration''s own comment for the full pre-existing gate list.';

commit;
