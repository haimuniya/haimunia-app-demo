begin;

-- COMM-130. The client-trust claim path for non-attendance milestones, plus
-- the non-attendance definition seed.
--
-- Why this function exists at all: the offline app already holds the exact
-- numbers (session count, summed PRs, week streak, first Rx, membership
-- tenure) on the device, and a privately logged lift never produces a
-- server event. ach_evaluate() is service role only, so without this there
-- is no path at all from a crossing the browser can see to a
-- member_achievements row.
--
-- What keeps it honest is the definition row, not the caller. A code is
-- accepted only when its definition is enabled, is not attendance
-- triggered, and carries config->>'client_claimable' = 'true'. Everything
-- community, challenge, or club shaped is left claimable = false in the
-- seed below, because those counts are gameable from a client and belong
-- on the ach_evaluate path where the server owns the number.
--
-- ACHIEVEMENT_UNLOCKED is deliberately NOT emitted from inside this
-- function. Both unlock paths write exactly one member_achievements row, so
-- the one place that sees every unlock is an AFTER INSERT trigger on that
-- table. It lands with notif_create(), which notifications still owns; see
-- "Needs from schema, notifications" in docs/community/contracts.md. Adding
-- a per-path emit here would give the consumer two shapes to handle.

do $$
begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'ach_claim_row'
  ) then
    create type public.ach_claim_row as (
      code text,
      member_achievement_id uuid,
      visibility text
    );
  end if;
end $$;

create or replace function public.ach_claim(p_codes text[]) returns setof public.ach_claim_row
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_codes text[];
begin
  v_uid := auth.uid();
  if v_uid is null then raise exception 'not authorized'; end if;
  -- Same gate every other community write carries. Reading achievements
  -- stays open; awarding one does not.
  if not public.is_community_member() then raise exception 'recovery method required'; end if;

  -- A null or empty array is a no-op, not an error: the client calls this
  -- on every sync and usually has nothing to claim.
  if p_codes is null or array_length(p_codes, 1) is null then return; end if;
  if array_length(p_codes, 1) > 50 then raise exception 'at most 50 codes per call'; end if;

  -- The write side is bounded by the definitions themselves (once per
  -- non-repeatable code), but a repeatable client-claimable definition
  -- would otherwise be an unbounded insert loop, so the call itself is
  -- limited the same way every other member write path is.
  if not public.check_rate_limit('ach_claim', 30, 10) then raise exception 'rate_limited'; end if;

  select array_agg(distinct t.code) into v_codes
  from unnest(p_codes) as t(code)
  where t.code is not null and t.code <> '';
  if v_codes is null then return; end if;

  return query
  with accepted as (
    select d.id, d.code, d.visibility, d.repeatable
    from public.achievement_definitions d
    where d.code = any(v_codes)
      and d.enabled
      and d.trigger_type <> 'ATTENDANCE_RECORDED'
      and coalesce(d.config ->> 'client_claimable', '') = 'true'
      -- A non-repeatable code already held is silently absent from the
      -- result rather than an error, so a replay after a reinstall
      -- celebrates nothing.
      and (
        d.repeatable
        or not exists (
          select 1 from public.member_achievements ma
          where ma.user_id = v_uid and ma.achievement_id = d.id
        )
      )
  ), ins as (
    insert into public.member_achievements (user_id, achievement_id, visibility)
    select v_uid, a.id, a.visibility from accepted a
    -- member_achievements_once_idx is what actually holds the once rule
    -- under two concurrent claims; the NOT EXISTS above only narrows the
    -- common case. A lost race is swallowed, never surfaced.
    on conflict do nothing
    returning id, achievement_id, visibility
  )
  select a.code, ins.id, ins.visibility
  from ins join accepted a on a.id = ins.achievement_id;
end $$;

revoke all on function public.ach_claim(text[]) from public, anon;
grant execute on function public.ach_claim(text[]) to authenticated;

-- COMM-131. Every non-attendance definition, from
-- docs/community/achievement-seed.md. ON CONFLICT DO UPDATE so a re-run
-- converges instead of failing, and so a copy edit is a one-line change to
-- the next migration rather than a manual dashboard fix.
--
-- The four attendance rows from 202608280007 are not repeated: they stay
-- seeded and enabled = false until an attendance source exists (COMM-P03).
insert into public.achievement_definitions
  (code, name, description, category, trigger_type, threshold, repeatable, visibility, icon, enabled, config)
values
  -- consistency: logged sessions, from logged entries not verified attendance
  ('first_workout',        'האימון הראשון',       'רשמת אימון ראשון ביומן',                 'consistency', 'WORKOUT_COMPLETED', 1,   false, 'club', '🔥', true, '{"client_claimable": true, "metric": "session_count"}'),
  ('sessions_10',          '10 אימונים',          '10 ימי אימון מתועדים',                    'consistency', 'WORKOUT_COMPLETED', 10,  false, 'club', '🔥', true, '{"client_claimable": true, "metric": "session_count"}'),
  ('sessions_25',          '25 אימונים',          '25 ימי אימון מתועדים',                    'consistency', 'WORKOUT_COMPLETED', 25,  false, 'club', '🔥', true, '{"client_claimable": true, "metric": "session_count"}'),
  ('sessions_50',          '50 אימונים',          '50 ימי אימון מתועדים',                    'consistency', 'WORKOUT_COMPLETED', 50,  false, 'club', '🥉', true, '{"client_claimable": true, "metric": "session_count"}'),
  ('sessions_100',         '100 אימונים',         '100 ימי אימון מתועדים',                   'consistency', 'WORKOUT_COMPLETED', 100, false, 'club', '🥈', true, '{"client_claimable": true, "metric": "session_count"}'),
  ('sessions_250',         '250 אימונים',         '250 ימי אימון מתועדים',                   'consistency', 'WORKOUT_COMPLETED', 250, false, 'club', '🥇', true, '{"client_claimable": true, "metric": "session_count"}'),

  -- consistency: week streak, tolerant of a 3x per week pattern
  ('consistency_weeks_4',  'חודש ברצף',           'רישום אימון בכל שבוע, ארבעה שבועות ברצף',  'consistency', 'WORKOUT_COMPLETED', 4,   false, 'club', '📅', true, '{"client_claimable": true, "metric": "week_streak"}'),
  ('consistency_weeks_12', 'רבעון ברצף',          'רישום אימון בכל שבוע, שנים עשר שבועות ברצף','consistency', 'WORKOUT_COMPLETED', 12,  false, 'club', '📅', true, '{"client_claimable": true, "metric": "week_streak"}'),
  ('consistency_weeks_26', 'חצי שנה ברצף',        'רישום אימון בכל שבוע, עשרים ושישה שבועות ברצף','consistency','WORKOUT_COMPLETED', 26, false, 'club', '📆', true, '{"client_claimable": true, "metric": "week_streak"}'),
  ('consistency_weeks_52', 'שנה ברצף',            'רישום אימון בכל שבוע, חמישים ושניים שבועות ברצף','consistency','WORKOUT_COMPLETED', 52, false, 'club', '🏆', true, '{"client_claimable": true, "metric": "week_streak"}'),

  -- performance: personal records and first Rx
  ('first_pr',             'השיא הראשון',         'שיא אישי ראשון',                          'performance', 'PR_CREATED',        1,   false, 'club', '⭐', true, '{"client_claimable": true, "metric": "pr_count"}'),
  ('pr_10',                '10 שיאים',            '10 שיאים אישיים',                         'performance', 'PR_CREATED',        10,  false, 'club', '⭐', true, '{"client_claimable": true, "metric": "pr_count"}'),
  ('pr_25',                '25 שיאים',            '25 שיאים אישיים',                         'performance', 'PR_CREATED',        25,  false, 'club', '🌟', true, '{"client_claimable": true, "metric": "pr_count"}'),
  ('pr_50',                '50 שיאים',            '50 שיאים אישיים',                         'performance', 'PR_CREATED',        50,  false, 'club', '🌟', true, '{"client_claimable": true, "metric": "pr_count"}'),
  ('pr_100',               '100 שיאים',           '100 שיאים אישיים',                        'performance', 'PR_CREATED',        100, false, 'club', '💫', true, '{"client_claimable": true, "metric": "pr_count"}'),
  ('first_rx',             'Rx ראשון',            'רישום ראשון של אימון כ-Rx',               'performance', 'WORKOUT_COMPLETED', 1,   false, 'club', '🏋️', true, '{"client_claimable": true, "metric": "rx_count"}'),

  -- progress: well rounded across the movement families
  ('well_rounded',         'אתלט שלם',            'שיא לפחות בכל אחת מחמש קבוצות התרגילים',   'progress',    'PR_CREATED',        5,   false, 'club', '🧩', true, '{"client_claimable": true, "metric": "pr_category_spread"}'),

  -- club identity: membership tenure
  ('anniversary_year_1',   'שנה במועדון',         'שנה מתאריך ההצטרפות',                     'club',        'MEMBER_JOINED',     365,  false, 'club', '🎉', true, '{"client_claimable": true, "metric": "tenure_days"}'),
  ('anniversary_year_2',   'שנתיים במועדון',      'שנתיים מתאריך ההצטרפות',                  'club',        'MEMBER_JOINED',     730,  false, 'club', '🎉', true, '{"client_claimable": true, "metric": "tenure_days"}'),
  ('anniversary_year_3',   'שלוש שנים במועדון',   'שלוש שנים מתאריך ההצטרפות',               'club',        'MEMBER_JOINED',     1095, false, 'club', '🎉', true, '{"client_claimable": true, "metric": "tenure_days"}'),
  ('anniversary_year_5',   'חמש שנים במועדון',    'חמש שנים מתאריך ההצטרפות',                'club',        'MEMBER_JOINED',     1825, false, 'club', '🎖️', true, '{"client_claimable": true, "metric": "tenure_days"}'),

  -- community: secondary, server-owned, never client-claimed
  ('first_cheer',          'עידוד ראשון',         'שלחת עידוד ראשון לחבר/ה',                 'community',   'REACTION_CREATED',  1,   false, 'club', '👏', true, '{"secondary": true}'),
  ('first_comment',        'תגובה ראשונה',        'כתבת תגובה ראשונה',                       'community',   'COMMENT_CREATED',   1,   false, 'club', '💬', true, '{"secondary": true}'),
  ('supportive_10',        '10 עידודים',          '10 עידודים ותגובות תומכות',               'community',   'REACTION_CREATED',  10,  false, 'club', '🤝', true, '{"secondary": true, "metric": "support_actions"}'),
  ('welcomed_member',      'קבלת פנים',           'עזרת לקבל חבר/ה חדש/ה במועדון',           'community',   'COMMENT_CREATED',   1,   false, 'club', '🙌', true, '{"secondary": true, "metric": "welcome_comment"}'),

  -- challenge: repeatable, server-owned
  ('challenge_finisher',   'סיום אתגר',           'השלמת אתגר מועדון',                       'challenge',   'CHALLENGE_COMPLETED', 1, true,  'club', '🏁', true, '{}'),
  ('challenge_winner',     'מנצח/ת אתגר',         'מקום ראשון באתגר מועדון',                 'challenge',   'CHALLENGE_COMPLETED', 1, true,  'club', '🥇', true, '{"metric": "rank_1"}')
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  trigger_type = excluded.trigger_type,
  threshold = excluded.threshold,
  repeatable = excluded.repeatable,
  visibility = excluded.visibility,
  icon = excluded.icon,
  enabled = excluded.enabled,
  config = excluded.config;

commit;
