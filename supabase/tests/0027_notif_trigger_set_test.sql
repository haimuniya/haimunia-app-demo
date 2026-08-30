-- COMM-020 run C: real enforcement for 202608280027 (the notification
-- trigger set).
-- Boundaries: every trigger function, and notif_announcement_fanout, is
-- unreachable by a direct client RPC. A first comment on a post writes one
-- immediate comment_on_post for the post author; a second comment by the
-- same commenter writes no immediate row and instead increments
-- comment_also in the post author's community batch; a reply to the post
-- author's own top-level comment writes one comment_reply for that author
-- instead of a second comment_on_post row; a member commenting on their own
-- post writes nothing. A mention fires only from an accepted
-- comment_mentions row, never from bare @name text with no such row; one
-- notification per accepted mention; coach_mention when the comment author
-- holds coach or head_coach. A reaction is never immediate, always
-- notif_queue_batched on the post author's community batch, never on your
-- own post, and an off reactions preference drops the enqueue entirely
-- (the key is simply absent from pending, not present at zero). An
-- announcement insert fans out one immediate row to every member whose
-- announcements preference is not off, skipping the author; flipping
-- important false -> true fans out only to the members who were skipped
-- the first time. A member_achievements insert writes one immediate
-- achievement_unlocked for the unlocker; each mutual-follow friend with
-- show_achievements/visible_to_club on and friend_achievements not off
-- gets a friend_achievement batch entry; hiding the unlocker's own
-- show_achievements or setting the unlock's visibility to only_me
-- suppresses the whole friend fan-out, not just the immediate row. A block
-- edge suppresses both the immediate insert and the batch enqueue, on the
-- comment and the reaction path alike - built as direct post_comments rows
-- for the comment case, since a real block edge also makes the post
-- invisible to add_post_comment's own post_visible_to_viewer() check, and
-- this file means to exercise the trigger, not that unrelated gate.
--
-- Every state check below runs as tests.clear_auth() (the bootstrap
-- superuser, which bypasses notifications' and notification_batches' own
-- select-your-own-row RLS) rather than as the acting member, so a check for
-- what landed in SOMEONE ELSE's stream is not itself hidden by the RLS
-- boundary 0008/0018 already cover.
-- CI is the first real run of this file.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- every trigger function is unreachable by a direct client RPC - the
-- migration's own "revoke execute from every client role" note
-- =====================================================================
select tests.set_auth(tests.uid('m1'));
select throws_ok(
  $$ select public.notif_on_comment() $$, '42501', null,
  'notif_on_comment cannot be called directly by a member');
select throws_ok(
  $$ select public.notif_on_mention() $$, '42501', null,
  'notif_on_mention cannot be called directly by a member');
select throws_ok(
  $$ select public.notif_on_reaction() $$, '42501', null,
  'notif_on_reaction cannot be called directly by a member');
select throws_ok(
  $$ select public.notif_on_announcement() $$, '42501', null,
  'notif_on_announcement cannot be called directly by a member');
select throws_ok(
  $$ select public.notif_on_achievement() $$, '42501', null,
  'notif_on_achievement cannot be called directly by a member');
select throws_ok(
  $$ select public.notif_announcement_fanout(gen_random_uuid(), false) $$, '42501', null,
  'notif_announcement_fanout cannot be called directly by a member either');

-- =====================================================================
-- fixtures: posts for the comment paths, a mention target post, reaction
-- posts, block edges, and the follow graph the achievement fan-out needs.
-- Built as the bootstrap superuser.
-- =====================================================================
select tests.clear_auth();

insert into public.workout_posts (id, author_id, visibility, body) values
  ('c0270000-0000-4000-8000-000000000001', tests.uid('m1'), 'club', 'P1 - comment_on_post / comment_also'),
  ('c0270000-0000-4000-8000-000000000002', tests.uid('m2'), 'club', 'P4 - comment block edge'),
  ('c0270000-0000-4000-8000-000000000003', tests.uid('owner'), 'club', 'P5 - reaction'),
  ('c0270000-0000-4000-8000-000000000004', tests.uid('owner'), 'club', 'P5b - self reaction'),
  ('c0270000-0000-4000-8000-000000000005', tests.uid('m2'), 'club', 'P4b - reaction block edge'),
  ('c0270000-0000-4000-8000-000000000006', tests.uid('owner'), 'club', 'P6 - mentions'),
  ('c0270000-0000-4000-8000-000000000007', tests.uid('norec'), 'club', 'P8 - self reaction, kept free of any other activity');

-- the post author's own top-level comment on P1, so a later reply to it
-- exercises the "instead of the post-author path" branch: the reply's
-- parent author and the post author are the same person.
insert into public.post_comments (id, post_id, author_id, body) values
  ('c0270000-0000-4000-8000-000000000011', 'c0270000-0000-4000-8000-000000000001', tests.uid('m1'), 'm1''s own top comment');

insert into public.blocks (blocker_id, blocked_id) values (tests.uid('m2'), tests.uid('m3'));

insert into public.follows (follower_id, followed_id) values
  (tests.uid('m1'), tests.uid('m2')), (tests.uid('m2'), tests.uid('m1')), -- mutual: m1 <-> m2
  (tests.uid('m1'), tests.uid('m3')), (tests.uid('m3'), tests.uid('m1')), -- mutual: m1 <-> m3
  (tests.uid('m1'), tests.uid('norec')); -- one-directional only, not a friend

insert into public.notification_preferences (user_id, type, channel)
values (tests.uid('m2'), 'friend_achievements', 'off');

-- =====================================================================
-- notif_on_comment: first comment immediate, second comment batched,
-- self-comment on your own post writes nothing
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ select public.add_post_comment('c0270000-0000-4000-8000-000000000001', 'first comment from m2') $$,
  'm2 comments on m1''s post for the first time');

select tests.clear_auth();
select isnt_empty(
  $$ select 1 from public.notifications
     where user_id = tests.uid('m1') and type = 'comment_on_post'
       and source_id = (select id from public.post_comments
                         where post_id = 'c0270000-0000-4000-8000-000000000001' and body = 'first comment from m2') $$,
  'the first comment writes one immediate comment_on_post for the post author');

select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ select public.add_post_comment('c0270000-0000-4000-8000-000000000001', 'second comment from m2') $$,
  'm2 comments on the same post again');

select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.notifications
     where user_id = tests.uid('m1') and type = 'comment_on_post' $$,
  $$ values (1) $$,
  'the second comment by the same commenter writes no additional immediate comment_on_post row');
select results_eq(
  $$ select (pending #>> array['comment_also', 'count'])::int from public.notification_batches
     where user_id = tests.uid('m1') and category = 'community' $$,
  $$ values (1) $$,
  'the second comment instead incremented comment_also in the post author''s community batch');

select lives_ok(
  $$ insert into public.post_comments (post_id, author_id, body)
     values ('c0270000-0000-4000-8000-000000000001', tests.uid('m1'), 'm1 comments on their own post') $$,
  'the post author comments on their own post');
select is_empty(
  $$ select 1 from public.notifications
     where user_id = tests.uid('m1')
       and source_id = (select id from public.post_comments
                         where post_id = 'c0270000-0000-4000-8000-000000000001'
                           and body = 'm1 comments on their own post') $$,
  'commenting on your own post writes no notification of any kind');

-- --- a reply to the post author's own top-level comment: comment_reply
-- for that author, instead of the post-author path -----------------
select tests.set_auth(tests.uid('m3'));
select lives_ok(
  $$ select public.add_post_comment('c0270000-0000-4000-8000-000000000001', 'm3 replies to m1',
       'c0270000-0000-4000-8000-000000000011') $$,
  'm3 (a first-time commenter on this post) replies to m1''s own top-level comment');

select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.notifications
     where user_id = tests.uid('m1') and type = 'comment_reply'
       and source_id = (select id from public.post_comments
                         where post_id = 'c0270000-0000-4000-8000-000000000001' and body = 'm3 replies to m1') $$,
  $$ values (1) $$,
  'the reply writes exactly one comment_reply for the parent author');
select results_eq(
  $$ select count(*)::int from public.notifications
     where user_id = tests.uid('m1') and type = 'comment_on_post' $$,
  $$ values (1) $$,
  'and still no second comment_on_post row, because the parent author is the post author - the reply path replaces it');

-- =====================================================================
-- block edge suppresses BOTH the immediate first-comment row and the
-- batched second-comment enqueue (m2 blocked m3 above). Built as direct
-- post_comments rows, same reasoning as the header note: a real block edge
-- also makes the post invisible to add_post_comment's own visibility gate,
-- which is not what this section means to exercise.
--
-- The batched (second-comment) path in notif_on_comment resolves its actor
-- from NEW.author_id directly, so a superuser fixture insert exercises its
-- block check correctly on its own. The immediate (first-comment) path
-- routes through notif_create, whose own block check reads auth.uid() -
-- the session's actual caller - not NEW.author_id, so the jwt sub claim
-- has to actually say m3 for that branch's block check to see anything to
-- suppress. Same "definer-equivalent path" as 0026: the claim is set
-- directly, role stays postgres, so the insert itself still bypasses
-- post_comments' own grants and post_visible_to_viewer().
select pg_catalog.set_config('request.jwt.claim.sub', tests.uid('m3')::text, true);
insert into public.post_comments (post_id, author_id, body) values
  ('c0270000-0000-4000-8000-000000000002', tests.uid('m3'), 'blocked first comment');
select is_empty(
  $$ select 1 from public.notifications where user_id = tests.uid('m2') and type = 'comment_on_post' $$,
  'the block edge suppressed the first-comment immediate row entirely');

insert into public.post_comments (post_id, author_id, body) values
  ('c0270000-0000-4000-8000-000000000002', tests.uid('m3'), 'blocked second comment');
select is_empty(
  $$ select 1 from public.notification_batches where user_id = tests.uid('m2') and category = 'community' $$,
  'the block edge suppressed the second-comment batch enqueue too - no batch row was ever created for m2');
select tests.clear_auth();

-- =====================================================================
-- notif_on_mention: fires only from comment_mentions, never from bare text
-- =====================================================================
select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ select public.add_post_comment('c0270000-0000-4000-8000-000000000006', 'hey @m1, no mention array here') $$,
  'a comment with an @name in the body but no p_mentions array is created');

select tests.clear_auth();
select is_empty(
  $$ select 1 from public.notifications
     where user_id = tests.uid('m1') and type in ('mention', 'coach_mention')
       and source_id = (select id from public.post_comments
                         where post_id = 'c0270000-0000-4000-8000-000000000006'
                           and body = 'hey @m1, no mention array here') $$,
  'bare @name text with no accepted comment_mentions row produces no mention notification');

-- m3 is deliberately not used as a target here: m2 blocked m3 above, and
-- add_post_comment already drops a mention across a block edge before a
-- comment_mentions row is ever written (COMM-020 run B, 0021), so m1 and
-- the unrelated owner are the two targets instead.
select tests.set_auth(tests.uid('m2'));
select lives_ok(
  $$ select public.add_post_comment('c0270000-0000-4000-8000-000000000006', 'accepted mentions',
       null, array[tests.uid('m1'), tests.uid('owner')]) $$,
  'm2 comments mentioning m1 and owner through the 4-argument form');

select tests.clear_auth();
select results_eq(
  $$ select count(*)::int from public.notifications
     where type = 'mention'
       and user_id in (tests.uid('m1'), tests.uid('owner'))
       and source_id = (select id from public.post_comments
                         where post_id = 'c0270000-0000-4000-8000-000000000006' and body = 'accepted mentions') $$,
  $$ values (2) $$,
  'one mention notification per accepted mention target - two targets, two rows');

select tests.set_auth(tests.uid('coach'));
select lives_ok(
  $$ select public.add_post_comment('c0270000-0000-4000-8000-000000000006', 'a coach mentions m2',
       null, array[tests.uid('m2')]) $$,
  'a coach-role member mentions m2');

select tests.clear_auth();
select results_eq(
  $$ select type from public.notifications
     where user_id = tests.uid('m2')
       and source_id = (select id from public.post_comments
                         where post_id = 'c0270000-0000-4000-8000-000000000006' and body = 'a coach mentions m2') $$,
  $$ values ('coach_mention'::text) $$,
  'a mention from a coach-role author is coach_mention, not mention');

-- =====================================================================
-- notif_on_reaction: never immediate, always the post author's community
-- batch, never on your own post
-- =====================================================================
-- P8/norec is used nowhere else in this file, so its community batch row
-- staying entirely absent is a clean signal - owner (used for the other
-- reaction tests below) already picked up an unrelated comment_also entry
-- from the mention section above, on the same (user, category) key a
-- self-reaction on owner's own post would also write into.
select lives_ok(
  $$ insert into public.reactions (post_id, user_id) values
       ('c0270000-0000-4000-8000-000000000007', tests.uid('norec')) $$,
  'the post author reacts to their own post');
select is_empty(
  $$ select 1 from public.notification_batches where user_id = tests.uid('norec') and category = 'community' $$,
  'reacting to your own post enqueues nothing at all');

select lives_ok(
  $$ insert into public.reactions (post_id, user_id) values
       ('c0270000-0000-4000-8000-000000000003', tests.uid('m1')) $$,
  'm1 reacts to owner''s post');
select is_empty(
  $$ select 1 from public.notifications where user_id = tests.uid('owner') and type = 'reaction' $$,
  'a reaction never writes an immediate notification row');
select results_eq(
  $$ select (pending #>> array['reaction', 'count'])::int from public.notification_batches
     where user_id = tests.uid('owner') and category = 'community' $$,
  $$ values (1) $$,
  'instead the reaction is queued into the post author''s community batch');

-- --- block edge suppresses the reaction enqueue too (m2 blocked m3) ----
select lives_ok(
  $$ insert into public.reactions (post_id, user_id) values
       ('c0270000-0000-4000-8000-000000000005', tests.uid('m3')) $$,
  'm3 reacts to m2''s post despite the block edge - the reaction row itself still lands');
select is_empty(
  $$ select 1 from public.notification_batches where user_id = tests.uid('m2') and category = 'community' $$,
  'the block edge suppressed the reaction enqueue - m2 still has no community batch row at all, from the comment test above or this one');

-- --- an off reactions preference drops the enqueue: the key is simply
-- absent, not present at zero ---------------------------------------
insert into public.notification_preferences (user_id, type, channel)
values (tests.uid('m1'), 'reactions', 'off');
select lives_ok(
  $$ insert into public.reactions (post_id, user_id) values
       ('c0270000-0000-4000-8000-000000000001', tests.uid('m3')) $$,
  'm3 reacts to m1''s post after m1 switched reactions off');
select is(
  (select pending ? 'reaction' from public.notification_batches
     where user_id = tests.uid('m1') and category = 'community'),
  false,
  'the reaction key is absent from m1''s batch entirely - the earlier comment_also entry from m2 is untouched');
select results_eq(
  $$ select (pending #>> array['comment_also', 'count'])::int from public.notification_batches
     where user_id = tests.uid('m1') and category = 'community' $$,
  $$ values (1) $$,
  'and that untouched comment_also entry still reads 1, from the comment_on_post/comment_also test above');

-- =====================================================================
-- notif_on_announcement: fan out on INSERT, escalate on UPDATE
-- =====================================================================
insert into public.notification_preferences (user_id, type, channel)
values (tests.uid('m3'), 'announcements', 'off')
on conflict (user_id, type) do update set channel = 'off';

insert into public.announcements (id, author_id, title, body, important) values
  ('c0270000-0000-4000-8000-000000000021', tests.uid('admin'), 'First announcement', 'body', false);

select isnt_empty(
  $$ select 1 from public.notifications
     where type = 'announcement' and user_id = tests.uid('m1')
       and source_id = 'c0270000-0000-4000-8000-000000000021' $$,
  'a member without an off preference gets the announcement immediately');
select is_empty(
  $$ select 1 from public.notifications where type = 'announcement' and user_id = tests.uid('admin') $$,
  'the announcement author is skipped, even though nothing suppresses them by preference');
select is_empty(
  $$ select 1 from public.notifications
     where type = 'announcement' and user_id = tests.uid('m3')
       and source_id = 'c0270000-0000-4000-8000-000000000021' $$,
  'the member with announcements off is skipped on the normal fan-out');
select results_eq(
  $$ select count(*)::int from public.notifications
     where type = 'announcement' and source_id = 'c0270000-0000-4000-8000-000000000021' $$,
  $$ values (5) $$,
  'exactly the five non-off, non-author members got the first fan-out (m1, m2, coach, owner, norec)');

update public.announcements set important = true
  where id = 'c0270000-0000-4000-8000-000000000021';

select isnt_empty(
  $$ select 1 from public.notifications
     where type = 'announcement' and user_id = tests.uid('m3')
       and source_id = 'c0270000-0000-4000-8000-000000000021' $$,
  'escalating to important reaches the member who was skipped the first time');
select results_eq(
  $$ select count(*)::int from public.notifications
     where type = 'announcement' and source_id = 'c0270000-0000-4000-8000-000000000021' $$,
  $$ values (6) $$,
  'exactly one row was added by the escalation - nobody from the first pass got a second row');

-- =====================================================================
-- notif_on_achievement: self-directed immediate, mutual-friend batched
-- fan-out, only_me and a hidden unlocker suppress the whole fan-out
-- =====================================================================
insert into public.member_achievements (id, user_id, achievement_id, visibility) values (
  'c0270000-0000-4000-8000-000000000031', tests.uid('m1'),
  (select id from public.achievement_definitions where code = 'attendance_first_class'),
  'club'
);

select isnt_empty(
  $$ select 1 from public.notifications
     where user_id = tests.uid('m1') and type = 'achievement_unlocked'
       and source_id = 'c0270000-0000-4000-8000-000000000031' $$,
  'the unlocker gets one immediate achievement_unlocked notification, recipient == actor allowed for this type');
select results_eq(
  $$ select (pending #>> array['friend_achievement', 'count'])::int from public.notification_batches
     where user_id = tests.uid('m3') and category = 'training' $$,
  $$ values (1) $$,
  'the mutual-follow friend m3 gets one friend_achievement batch entry');
select is_empty(
  $$ select 1 from public.notification_batches where user_id = tests.uid('m2') and category = 'training' $$,
  'm2 is a mutual friend too but has friend_achievements switched off, so no batch row for m2 was ever created');
select is_empty(
  $$ select 1 from public.notification_batches where user_id = tests.uid('norec') and category = 'training' $$,
  'norec follows m1 but m1 does not follow back - not a mutual friend, gets nothing at all');

-- --- hiding the unlocker's own show_achievements suppresses the WHOLE
-- friend fan-out, even though the immediate self-notification still fires
update public.profiles set show_achievements = false where id = tests.uid('m1');
insert into public.member_achievements (id, user_id, achievement_id, visibility) values (
  'c0270000-0000-4000-8000-000000000032', tests.uid('m1'),
  (select id from public.achievement_definitions where code = 'attendance_25_classes'),
  'club'
);
select isnt_empty(
  $$ select 1 from public.notifications
     where user_id = tests.uid('m1') and type = 'achievement_unlocked'
       and source_id = 'c0270000-0000-4000-8000-000000000032' $$,
  'the self-directed immediate notification still fires even with show_achievements off');
select results_eq(
  $$ select (pending #>> array['friend_achievement', 'count'])::int from public.notification_batches
     where user_id = tests.uid('m3') and category = 'training' $$,
  $$ values (1) $$,
  'm3''s friend_achievement count is unchanged - show_achievements off suppressed this entire fan-out, not just m2''s slot');
update public.profiles set show_achievements = true where id = tests.uid('m1');

-- --- only_me visibility on the achievement suppresses the fan-out too --
insert into public.member_achievements (id, user_id, achievement_id, visibility) values (
  'c0270000-0000-4000-8000-000000000033', tests.uid('m1'),
  (select id from public.achievement_definitions where code = 'attendance_100_classes'),
  'only_me'
);
select isnt_empty(
  $$ select 1 from public.notifications
     where user_id = tests.uid('m1') and type = 'achievement_unlocked'
       and source_id = 'c0270000-0000-4000-8000-000000000033' $$,
  'the self-directed immediate notification still fires for an only_me unlock');
select results_eq(
  $$ select (pending #>> array['friend_achievement', 'count'])::int from public.notification_batches
     where user_id = tests.uid('m3') and category = 'training' $$,
  $$ values (1) $$,
  'm3''s friend_achievement count is still unchanged - only_me visibility suppressed the fan-out for this unlock');

select * from finish();
rollback;
