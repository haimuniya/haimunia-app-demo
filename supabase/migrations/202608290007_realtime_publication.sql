begin;

-- Community Phase 2, realtime cluster (COMM-209, COMM-227). HaimuniaRealtime
-- (COMM-014) has subscribed to these tables since Phase 1, but every one of
-- those subscriptions has been a documented no-op because none of the
-- underlying tables were ever added to the supabase_realtime publication -
-- postgres_changes has nothing to stream without publication membership,
-- regardless of what RLS would otherwise allow through. This migration is
-- the one-line-per-table flip that turns each of those existing
-- subscriptions live. No RLS or policy change: postgres_changes payloads
-- are still filtered per-subscriber by the table's existing row level
-- security, the same as any other read.
--
-- challenge_progress, challenge_participants: COMM-209, the challenge
-- detail live progress bar and leaderboard.
-- post_comments, reactions: COMM-227, live comment threads and reaction
-- counts on an open feed card.
-- notifications: COMM-227, the own-row notification badge subscription
-- COMM-140 shipped and documented as "no-op until COMM-227" - this closes
-- that gap.
--
-- ALTER PUBLICATION ... ADD TABLE is transactional DDL, unlike
-- CREATE INDEX CONCURRENTLY or ALTER TYPE ... ADD VALUE, so it runs fine
-- inside this migration's usual begin/commit block. Confirmed with
-- `supabase db reset` applying clean and `select * from
-- pg_publication_tables where pubname = 'supabase_realtime'` showing all
-- five rows afterward.
alter publication supabase_realtime add table public.challenge_progress;
alter publication supabase_realtime add table public.challenge_participants;
alter publication supabase_realtime add table public.post_comments;
alter publication supabase_realtime add table public.reactions;
alter publication supabase_realtime add table public.notifications;

commit;
