begin;

-- Community Phase 2, challenges cluster, part 3 of 4: chal_record_progress,
-- the coach-entry write path COMM-206 needs.
--
-- challenge_progress_insert_self (202608280009) only ever lets a member
-- write their own row (`user_id = auth.uid()`). A `coach` challenge type is
-- scored by a challenge manager entering progress on someone else's behalf
-- (COMM-206: "most burpees in a week", no client-side auto-detection), so
-- that policy cannot be the write path - a SECURITY DEFINER function is,
-- same reasoning as add_post_comment vs a plain own-row insert policy.
--
-- Two columns land here that the table did not have a use for until now:
--   - note text: COMM-206's entry form lets the coach attach a short note
--     to each logged delta ("counted burpees off video"). The append-only
--     log had no free-text field at all.
--   - entered_by uuid: who actually wrote the row. For a self-insert,
--     user_id already answers that (challenge_progress_insert_self forces
--     user_id = auth.uid()), so entered_by stays null there. For a coach
--     entry, user_id is the participant the progress belongs to and
--     entered_by is the coach who typed it in - without this column that
--     distinction is lost the moment the row is written, and "who logged
--     this on my behalf" becomes unanswerable from the table alone.

alter table public.challenge_progress
  add column note text check (note is null or char_length(note) <= 500),
  add column entered_by uuid references public.profiles(id) on delete set null;

-- challenge_progress_insert_self (202608280009) checked user_id,
-- is_community_member(), and active-participant status, but said nothing
-- about the two columns just added - a self-insert could otherwise set
-- entered_by to any uuid it likes and the column would no longer reliably
-- mean "a coach logged this on my behalf" for anyone reading the log.
-- Narrow it: a self-insert must leave entered_by null. Only
-- chal_record_progress, which runs past this policy entirely as SECURITY
-- DEFINER, ever sets it.
drop policy challenge_progress_insert_self on public.challenge_progress;
create policy challenge_progress_insert_self on public.challenge_progress for insert to authenticated
  with check (
    user_id = auth.uid()
    and entered_by is null
    and public.is_community_member()
    and exists (
      select 1 from public.challenge_participants cp
      where cp.challenge_id = challenge_id and cp.user_id = auth.uid() and cp.status = 'active'
    )
  );

create or replace function public.chal_record_progress(
  p_challenge_id uuid,
  p_user_id uuid,
  p_delta numeric,
  p_note text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_note text;
  v_id uuid;
begin
  if v_uid is null then raise exception 'not authorized'; end if;
  if not public.has_perm('community.challenge.create') then raise exception 'not authorized'; end if;
  if p_challenge_id is null or p_user_id is null then raise exception 'challenge and target participant are required'; end if;
  if p_delta is null then raise exception 'delta is required'; end if;

  if not exists (
    select 1 from public.challenge_participants
    where challenge_id = p_challenge_id and user_id = p_user_id and status = 'active'
  ) then
    raise exception 'not an active participant';
  end if;

  v_note := nullif(left(btrim(coalesce(p_note, '')), 500), '');

  insert into public.challenge_progress
    (challenge_id, user_id, delta, source_type, note, entered_by)
  values (p_challenge_id, p_user_id, p_delta, 'coach_entry', v_note, v_uid)
  returning id into v_id;

  return v_id;
end $$;

-- Deliberately no check_rate_limit() call here, matching the other
-- permission-gated staff/coach functions in this history (pin_set,
-- mod_restrict_member, mod_review): the permission check is the boundary,
-- not a per-minute counter. challenge_progress_insert_self itself (the
-- member's own-row direct RLS path) has never been rate limited either -
-- COMM-006 shipped it plain - so this coach path is not adding a limit the
-- self path never had.
revoke all on function public.chal_record_progress(uuid, uuid, numeric, text) from public, anon;
grant execute on function public.chal_record_progress(uuid, uuid, numeric, text) to authenticated;

commit;
