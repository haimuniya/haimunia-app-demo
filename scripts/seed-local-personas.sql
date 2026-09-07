-- Persona + feed seed for LOCAL Supabase only.
--
--   supabase start && supabase db reset
--   docker exec -i supabase_db_haimunia-app-demo psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < scripts/seed-local-personas.sql
--
-- Creates 6 members, promotes one to coach and one to admin, generates ~24
-- posts with reactions and comments, and prints a reusable invite code you
-- can type into the real signup UI to add more personas by hand.
--
-- THE TRAP THIS EXISTS TO SAVE YOU FROM: every write RPC is gated on
-- is_community_member(), which requires BOTH a redeemed invite AND
-- profiles.recovery_verified_at. Miss the second and post_create() fails with
-- 'recovery method required' - a message that does not mention the column,
-- and reads like the feature is broken rather than like your fixture is
-- incomplete.
--
-- Verified end-to-end against a local stack (109 migrations) inside a
-- transaction that was rolled back: 6 profiles, coach + admin set, 30 posts
-- (24 seeded + 6 POST_NEW_MEMBER the app generates on join), 40 reactions,
-- 8 comments.
-- Routed through the real RPCs (create_member_invite / redeem_invite_code /
-- post_create / toggle_reaction / add_post_comment) so the rows land the way
-- the app would make them, RLS and triggers included.
--
-- NEVER run this against a remote project.

do $$
begin
  if current_setting('server_version_num')::int > 0
     and current_database() <> 'postgres' then
    raise exception 'refusing to run outside the local supabase postgres db';
  end if;
end $$;

create temp table if not exists seed_ctx(member_code text);
delete from seed_ctx;

-- 1. A reusable member invite code. max_uses 50 so several personas can each
--    redeem the SAME code through the real signup UI.
insert into seed_ctx
select public.create_member_invite(now() + interval '30 days', 50);

-- 2. Synthetic members for feed volume, created the way signup does:
--    auth user -> profile -> redeem the invite as that user.
do $$
declare
  v_code text;
  v_id uuid;
  v_handles text[] := array['dana_k','omer_l','yael_b','noa_s','itai_r','maya_t'];
  v_names  text[] := array['דנה כהן','עומר לוי','יעל בר','נועה שגב','איתי רון','מאיה טל'];
  i int;
begin
  select member_code into v_code from seed_ctx;

  for i in 1..array_length(v_handles,1) loop
    v_id := gen_random_uuid();

    -- GoTrue reads confirmation_token and its siblings as NOT NULL strings and
    -- fails sign-in with "converting NULL to string is unsupported" if they are
    -- left unset, so every seeded account was unauthenticatable. Empty strings,
    -- not NULL. See the note at the top of this file.
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, created_at, updated_at,
                            raw_app_meta_data, raw_user_meta_data,
                            confirmation_token, recovery_token,
                            email_change_token_new, email_change_token_current,
                            email_change, phone_change, phone_change_token,
                            reauthentication_token)
    values (v_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            v_handles[i] || '@seed.local', crypt('seed-password-123', gen_salt('bf')),
            now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
            '', '', '', '', '', '', '', '');

    -- recovery_verified_at is REQUIRED: is_community_member() gates every
    -- write on it, and post_create() reports that failure as
    -- 'recovery method required'. Signup sets it when the member verifies a
    -- recovery method; seeded users have to set it themselves or every
    -- write RPC refuses them.
    insert into public.profiles (id, handle, display_name, bio, recovery_verified_at)
    values (v_id, v_handles[i], v_names[i], 'נבדק/ת UX', now());

    -- act as this user for the redemption
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_id::text, 'role', 'authenticated')::text, true);
    perform public.redeem_invite_code(v_code);
  end loop;
  perform set_config('request.jwt.claims', '', true);
end $$;

-- 3. Feed volume: posts, then reactions and comments from OTHER members, so
--    ranking and diversity rules have something real to sort.
do $$
declare
  v_author uuid;
  v_other uuid;
  v_post uuid;
  v_bodies text[] := array[
    'סיימתי Fran ב-4:12, שיא אישי','חזרתי אחרי פציעה, קל אבל טוב',
    'סקוואט 5x5 @100 ק"ג','ריצה 5 ק"מ בבוקר','WOD קבוצתי היה אכזרי היום',
    'דדליפט חדש: 140','מתח 12 חזרות רצוף','ראשון שלי בקהילה, שמחה להיות פה'];
  i int; j int;
begin
  for i in 1..24 loop
    select id into v_author from public.profiles order by random() limit 1;
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_author::text, 'role', 'authenticated')::text, true);

    v_post := public.post_create(
      v_bodies[1 + (i % array_length(v_bodies,1))],
      'club'::public.post_visibility, '[]'::jsonb, '{}'::jsonb);

    -- a few reactions and a comment from other members
    for j in 1..(1 + (i % 4)) loop
      select id into v_other from public.profiles where id <> v_author order by random() limit 1;
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_other::text, 'role', 'authenticated')::text, true);
      perform public.toggle_reaction(v_post);
    end loop;

    if i % 3 = 0 then
      select id into v_other from public.profiles where id <> v_author order by random() limit 1;
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_other::text, 'role', 'authenticated')::text, true);
      perform public.add_post_comment(v_post, 'כל הכבוד! 💪', null, null);
    end if;
  end loop;
  perform set_config('request.jwt.claims', '', true);
end $$;

-- 4. Roles. Coach is a PROMOTION, never an invite code - redeem_invite_code()
--    only ever matches role='member', so a coach code is unredeemable by
--    design. Admin is a direct column update, service-role only.
select public.grant_coach_role_by_handle('dana_k');
update public.profiles set is_admin = true where handle = 'yael_b';

-- 4b. The two quiet members, created AFTER the post loop above so the
--     random author picker cannot give them a posting history.
--
-- These two are the whole point of the coach-signal fixture, and they are
-- the cases the pre-202609060020 dashboard got wrong in the most damaging
-- way. Neither is a "spare persona": each one is a branch.
--
--   rina_member  joined two days ago, has never opened the app, has logged
--                nothing. The day-0 outreach target. The old
--                coach_new_members() INNER JOINed activity_pings, so this
--                member - the single most important person in a retention
--                feature, someone who signed up and vanished - could not
--                appear in the new-member list at all.
--
--   gil_quiet    joined two months ago and we have never recorded one thing
--                about them. The 'no_data' branch. The old
--                coach_inactive_members() put this member in the same list
--                as a genuine lapse and the client rendered them "מעולם לא"
--                ("never") - an assertion about a person manufactured out
--                of an absence of data.
--
-- They deliberately get no posts, no reactions and no comments: a member we
-- know nothing about is only a faithful fixture if we genuinely know
-- nothing about them.
do $$
declare
  v_code text;
  v_id uuid;
  v_handles text[] := array['rina_member','gil_quiet'];
  v_names  text[] := array['רינה','גיל'];
  i int;
begin
  select member_code into v_code from seed_ctx;

  for i in 1..array_length(v_handles,1) loop
    v_id := gen_random_uuid();
    -- GoTrue reads confirmation_token and its siblings as NOT NULL strings and
    -- fails sign-in with "converting NULL to string is unsupported" if they are
    -- left unset, so every seeded account was unauthenticatable. Empty strings,
    -- not NULL. See the note at the top of this file.
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, created_at, updated_at,
                            raw_app_meta_data, raw_user_meta_data,
                            confirmation_token, recovery_token,
                            email_change_token_new, email_change_token_current,
                            email_change, phone_change, phone_change_token,
                            reauthentication_token)
    values (v_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            v_handles[i] || '@seed.local', crypt('seed-password-123', gen_salt('bf')),
            now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
            '', '', '', '', '', '', '', '');
    insert into public.profiles (id, handle, display_name, bio, recovery_verified_at)
    values (v_id, v_handles[i], v_names[i], '', now());
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_id::text, 'role', 'authenticated')::text, true);
    perform public.redeem_invite_code(v_code);
  end loop;
  perform set_config('request.jwt.claims', '', true);
end $$;

-- 5. Tenure, training history and app-open history.
--
-- WHY THIS SECTION EXISTS. Everything above creates members who joined
-- SECONDS ago and have never logged a workout or opened the app. Every
-- coach-facing signal in the product is a function of those three things,
-- so without this section the whole coach dashboard is structurally
-- unreachable on a seeded club: nobody can be lapsed (nobody has a
-- yesterday), nobody has an anniversary (nobody has a last year), nobody
-- can decline (coach_detect_engagement_decline needs an eight-week
-- baseline), and Celebrate has nothing to celebrate. Reviewing the coach
-- tools against the old seed produced a dashboard that was empty where it
-- was not wrong, and it read as broken software rather than as an empty
-- fixture.
--
-- The personas below are chosen to make each coach surface show its REAL
-- behaviour, including the honest-empty and honest-unknown cases:
--
--   dana_k  coach, joined 400d - steady 3/wk throughout. Anniversary.
--   yael_b  admin, joined 520d - steady 2/wk. Anniversary.
--   noa_s   joined 210d - steady 4/wk, healthy, no flag.
--   itai_r  joined 150d - 4/wk baseline, down to 1/wk. 'significant' decline.
--   omer_l  joined 300d - 3/wk, then STOPPED two weeks ago and last opened
--           the app 16 days ago. Genuinely lapsed, and the only member who
--           should appear in the inactive list.
--   maya_t  joined 4d - two sessions logged, opens the app. Genuinely new.
--   rina_member joined 2d - nothing at all, has never opened the app. The
--           day-0 outreach target that the pre-202609060020 coach_new_members()
--           could not see, because its INNER JOIN on activity_pings dropped
--           exactly the members who never opened the app.
--   gil_quiet joined 60d - nothing at all, ever. The 'no_data' branch, the
--           one the old code reported to a coach as "מעולם לא".
--
-- A handle that is not present is skipped, so this block stays correct if
-- the persona list above ever changes.
--
-- Training days are written as private_records, NOT as attendance_log rows
-- directly. attendance_log takes no client write by design (202608310001:
-- "WHO CAN WRITE IT - Nobody"), and its one trigger derives a day from a
-- synced strength_entry. Going through private_records is what makes this
-- fixture exercise the real production path, triggers and achievements
-- included, rather than a shape only the seed can produce.
do $$
declare
  v_id uuid;
  v_handle text;
  v_join_days int;
  v_day date;
  v_i int;
  v_k int;
  -- handle, days since joining, sessions/week during the 8-week baseline,
  -- sessions/week during the recent 2 weeks, days since last app open
  -- (null = has literally never opened the app).
  v_spec text[][] := array[
    ['dana_k','400','3','3','0'],
    -- 367 days, not a round 500: coach_celebrate_feed() only surfaces an
    -- anniversary whose CROSSING fell inside its window, so a member who
    -- joined 500 days ago has nothing to celebrate this week and the
    -- fixture would silently exercise none of that branch. At 367 the
    -- one-year mark landed two days ago.
    ['yael_b','367','2','2','1'],
    ['noa_s','210','4','4','0'],
    ['itai_r','150','4','1','2'],
    ['omer_l','300','3','0','16'],
    ['maya_t','4','0','3','0'],
    ['rina_member','2','0','0',null],
    -- Joined two months ago and we have never recorded one single thing
    -- about them - no training, no app open. This is the 'no_data' state,
    -- and it needs a subject in the fixture or the most important half of
    -- 202609060020 is untestable by eye: before that migration this member
    -- was reported to the coach as "מעולם לא" ("never"), an assertion about
    -- a person made from an absence of data. They must now render as
    -- unknown, in a separate and non-alarming group, never as lapsed.
    -- Created in 4b above, deliberately with no posts of any kind.
    ['gil_quiet','60','0','0',null]
  ];
  v_base_per_week int;
  v_recent_per_week int;
  v_last_open text;
begin
  for v_i in 1..array_length(v_spec,1) loop
    v_handle          := v_spec[v_i][1];
    v_join_days       := v_spec[v_i][2]::int;
    v_base_per_week   := v_spec[v_i][3]::int;
    v_recent_per_week := v_spec[v_i][4]::int;
    v_last_open       := v_spec[v_i][5];

    select id into v_id from public.profiles where handle = v_handle;
    continue when v_id is null;

    -- Tenure. Both columns move together: coach_new_members() and
    -- coach_inactive_members() read coalesce(redeemed_at, created_at), and a
    -- fixture where the two disagree would be testing the coalesce rather
    -- than the feature.
    update public.profiles
       set created_at = now() - make_interval(days => v_join_days)
     where id = v_id;
    update public.invite_redemptions
       set redeemed_at = now() - make_interval(days => v_join_days)
     where user_id = v_id;

    -- Training history, newest 120 days. The split at 14 days is the same
    -- boundary coach_detect_engagement_decline() uses between its recent
    -- window and its baseline window, so a persona described as "4/wk down
    -- to 1/wk" actually lands in the bucket this comment claims.
    --
    -- 120 days, not 70, and the margin is not arbitrary: that function's
    -- baseline window starts at current_date - 69, and it refuses to flag
    -- anyone whose FIRST EVER training day falls after that ("there is no
    -- such thing as a decline with no prior baseline to decline from").
    -- A 70-day history puts the first session right on that boundary, where
    -- whether the fixture produces any flags at all depends on which
    -- weekday the seed happens to be run. 120 clears it by seven weeks.
    for v_day in
      select d::date from generate_series(
        current_date - least(v_join_days, 120), current_date, interval '1 day') d
    loop
      declare
        v_per_week int := case when current_date - v_day < 14
                               then v_recent_per_week else v_base_per_week end;
      begin
        -- Spread N sessions across 7 days deterministically, so re-running
        -- the seed produces the same club and a screenshot stays true.
        continue when v_per_week = 0;
        continue when (extract(doy from v_day)::int % 7) >= v_per_week;

        insert into public.private_records (user_id, record_type, record_id, payload, created_at, updated_at)
        values (
          v_id, 'strength_entry', 'seed-' || v_handle || '-' || v_day,
          jsonb_build_object(
            'id', 'seed-' || v_handle || '-' || v_day,
            'date', v_day::text,
            'exerciseId', 'back-squat',
            'type', 'strength',
            'weight', 60 + (extract(doy from v_day)::int % 40),
            'reps', 5, 'sets', 5),
          v_day::timestamptz, v_day::timestamptz)
        on conflict (user_id, record_type, record_id) do nothing;
      end;
    end loop;

    -- App-open history. activity_pings has exactly one writer in production
    -- (pingActivity() in cloud.js, today only, from a live browser), so a
    -- seeded club has none and every activity_pings-backed coach surface
    -- reads an empty table. maya_t and the human-driven UI personas earn
    -- theirs for real; these are the synthetic members'.
    if v_last_open is not null then
      for v_k in v_last_open::int..least(v_join_days, 60) loop
        continue when (v_k % 2) = 1 and v_k > 7;
        insert into public.activity_pings (user_id, activity_date)
        values (v_id, current_date - v_k)
        on conflict (user_id, activity_date) do nothing;
      end loop;
    end if;
  end loop;
end $$;

-- 6. A few PRs, so Celebrate has its non-attendance sources populated.
--
-- show_prs is OFF by default (202608280003) and coach_celebrate_feed() runs
-- every PR through can_view_profile_field(author,'show_prs'), so a PR post
-- by a member who has not opted in is correctly invisible to the coach.
-- Opting these two in is what makes the fixture exercise the visible path;
-- the other members' PRs staying hidden is the privacy rule working.
--
-- Movement names are English on purpose - that is the vernacular in an
-- Israeli box, and the app does not translate them.
do $$
declare
  v_author uuid;
  v_post uuid;
  v_prs text[][] := array[
    ['noa_s','Back Squat','120 kg','שיא חדש בסקוואט, 120'],
    ['dana_k','Deadlift','150 kg','דדליפט 150, אחרי חודשיים של עבודה'],
    ['itai_r','Fran','3:48','Fran ב-3:48, ראשון מתחת ל-4']
  ];
  i int;
begin
  update public.profiles set show_prs = true
   where handle in ('noa_s','dana_k','itai_r');

  for i in 1..array_length(v_prs,1) loop
    select id into v_author from public.profiles where handle = v_prs[i][1];
    continue when v_author is null;
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_author::text, 'role', 'authenticated')::text, true);
    v_post := public.post_create(
      v_prs[i][4], 'club'::public.post_visibility, '[]'::jsonb, '{}'::jsonb);
    -- post_create always lands POST_TEXT (202608280023); the type is set in
    -- a second own-row update, the same workaround cloud.js already uses for
    -- POST_COACH. POST_PR is not in the privileged set, so no staff rank is
    -- involved and a plain member's PR lands the same way.
    update public.workout_posts
       set post_type = 'POST_PR',
           metadata = jsonb_build_object('movement', v_prs[i][2], 'new_result', v_prs[i][3]),
           created_at = now() - make_interval(days => i)
     where id = v_post;
  end loop;
  perform set_config('request.jwt.claims', '', true);
end $$;

-- 6b. One finished challenge with two members who completed it, so
--     Celebrate's third and last source has a subject too.
--
-- status must not be 'draft' and the member must not be 'withdrawn' -
-- coach_celebrate_feed() filters on both - and completed_at has to land
-- inside its window, so it is dated two days ago rather than at join time.
-- in_leaderboards gates this branch (a member who opted out of the
-- leaderboard did not opt in to being announced), and it defaults true.
do $$
declare
  v_challenge uuid;
  v_owner uuid;
begin
  select id into v_owner from public.profiles where handle = 'dana_k';

  insert into public.challenges (title, description, challenge_type, metric_type,
                                 target_value, start_at, end_at, status, created_by)
  values ('אתגר 100 ק"מ ריצה', 'לצבור 100 ק"מ ריצה במהלך החודש',
          'individual_target', 'distance', 100,
          now() - interval '35 days', now() - interval '2 days', 'completed', v_owner)
  returning id into v_challenge;

  insert into public.challenge_participants (challenge_id, user_id, joined_at, status, progress_value, completed_at)
  select v_challenge, p.id, now() - interval '34 days', 'active', 104,
         now() - interval '2 days'
    from public.profiles p where p.handle in ('noa_s','maya_t')
  on conflict do nothing;
end $$;

-- 7. Run the engagement-decline job once, so Engage has real flags rather
--    than planted ones. In production this is pg_cron, daily at 06:17
--    (202609050005); it is service-role only and takes no arguments, so
--    calling it here is exactly what the scheduler does.
select public.coach_detect_engagement_decline() as engagement_flags_written;

-- 8. The code to type into the signup UI for the human-driven personas.
select 'MEMBER INVITE CODE -> ' || member_code as use_this_in_the_ui from seed_ctx;
select handle, display_name, is_admin,
       (select role from public.invite_redemptions r where r.user_id = p.id) as role
  from public.profiles p order by handle;
select (select count(*) from public.workout_posts) as posts,
       (select count(*) from public.reactions) as reactions,
       (select count(*) from public.post_comments) as comments;

-- What the coach dashboard should now show. Print it, so a reviewer can see
-- at a glance whether the fixture landed rather than having to open the UI
-- and guess whether an empty section is a bug or a true empty state.
select p.handle,
       (current_date - coalesce(ir.redeemed_at::date, p.created_at::date)) as days_a_member,
       (select count(*) from public.attendance_log a where a.user_id = p.id) as training_days,
       (select max(a.occurred_on) from public.attendance_log a where a.user_id = p.id) as last_trained,
       (select max(ap.activity_date) from public.activity_pings ap where ap.user_id = p.id) as last_app_open,
       (select f.level from public.coach_engagement_flags f
         where f.user_id = p.id and f.status = 'open' limit 1) as decline_flag
  from public.profiles p
  left join public.invite_redemptions ir on ir.user_id = p.id
 where p.deleted_at is null
 order by days_a_member desc;
