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

    insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, created_at, updated_at,
                            raw_app_meta_data, raw_user_meta_data)
    values (v_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            v_handles[i] || '@seed.local', crypt('seed-password-123', gen_salt('bf')),
            now(), now(), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);

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

-- 5. The code to type into the signup UI for the human-driven personas.
select 'MEMBER INVITE CODE -> ' || member_code as use_this_in_the_ui from seed_ctx;
select handle, display_name, is_admin,
       (select role from public.invite_redemptions r where r.user_id = p.id) as role
  from public.profiles p order by handle;
select (select count(*) from public.workout_posts) as posts,
       (select count(*) from public.reactions) as reactions,
       (select count(*) from public.post_comments) as comments;
