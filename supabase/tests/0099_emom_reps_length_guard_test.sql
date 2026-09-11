-- Security hunt round 4 (202609110006): wod_entry_normalize() used to
-- expand an emomReps array in full before truncating it to the first 20
-- values - confirmed live, through the real club_wod_attach_result() RPC,
-- that a multi-million-element array cost real measurable DB CPU before
-- being discarded down to 20. This file proves a wildly oversized array is
-- now refused outright before any expansion, while every legitimate
-- shape (including a real client sending slightly more than 20, which the
-- truncation has always handled gracefully) is completely unaffected.

\set rls_helpers_included true
create extension if not exists pgtap with schema extensions;

begin;
set local search_path to public, extensions, tests;
\ir rls_helpers.sql
select * from no_plan();

-- =====================================================================
-- THE FIX: a wildly oversized array is refused outright.
-- =====================================================================
select throws_ok(
  $$ select public.wod_entry_normalize(
       jsonb_build_object('scoreType', 'emom', 'rx', true,
         'emomReps', (select jsonb_agg(g) from generate_series(1, 1001) g))) $$,
  'P0001', 'too many emom rounds',
  '1001 elements - just over the new ceiling - is refused before any expansion happens');

-- =====================================================================
-- Every legitimate shape is completely unaffected by the fix.
-- =====================================================================
select results_eq(
  $$ select (public.wod_entry_normalize(
       jsonb_build_object('scoreType', 'emom', 'rx', true,
         'emomReps', jsonb_build_array(10,12,9,11,8)))
     ->> 'emomReps')::jsonb $$,
  $$ values ('[10,12,9,11,8]'::jsonb) $$,
  'a normal, small emom entry normalises exactly as before');

select results_eq(
  $$ select jsonb_array_length(public.wod_entry_normalize(
       jsonb_build_object('scoreType', 'emom', 'rx', true,
         'emomReps', (select jsonb_agg(g) from generate_series(1, 1000) g)))
     -> 'emomReps') $$,
  $$ values (20) $$,
  'exactly 1000 elements (at the new ceiling, not over it) still normalises - and still truncates to the first 20, same as always');

select results_eq(
  $$ select jsonb_array_length(public.wod_entry_normalize(
       jsonb_build_object('scoreType', 'emom', 'rx', true,
         'emomReps', (select jsonb_agg(g) from generate_series(1, 45) g)))
     -> 'emomReps') $$,
  $$ values (20) $$,
  'a real near-miss (45 rounds, over the client''s own 20-item UI cap but nowhere near the new ceiling) still truncates gracefully, exactly as it always has - the fix did not turn a silent truncation into a hard error for realistic input');

select is(
  public.wod_entry_normalize(jsonb_build_object('scoreType', 'time', 'rx', true, 'timeSeconds', 600)) ->> 'scoreType',
  'time',
  'non-emom score types are entirely untouched by this fix');

select * from finish();
rollback;
