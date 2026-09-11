begin;

-- Security hunt, round 4 (2026-09-11), resource-exhaustion agent.
--
-- THE FINDING. wod_entry_normalize() (202609080002) reads p_entry.emomReps
-- via `jsonb_array_elements(...) with ordinality t(x, ord) where t.ord <=
-- 20` - Postgres must expand the WHOLE array before that filter discards
-- everything past element 20. Every sibling array-accepting entry point in
-- this schema guards the input length BEFORE iterating instead (post_create
-- checks jsonb_array_length(media) > 4 first; club_wod_publish checks
-- jsonb_array_length(p_emom_movements) > 20 first; feed_record_impressions
-- checks jsonb_array_length(p_rows) > 50 first) - this was the one place
-- that pattern was missing. Confirmed live against real local Postgres,
-- through the real authenticated-role club_wod_attach_result() RPC (not a
-- superuser shortcut): a 2-million-element emomReps array completed in
-- ~990ms and correctly stored only the first 20 values, i.e. the cap
-- itself was never wrong, only its cost. Bounded in practice by the
-- authenticated role's 8s statement_timeout and club_wod_attach_result's
-- own 20-calls/10-min rate limit, so not an outage risk - but a real,
-- fixable inconsistency with this schema's own established convention.
--
-- THE FIX. jsonb_array_length() is O(1) (jsonb stores its own element
-- count, no per-element deserialization) - reject outright, before any
-- expansion, when the array is wildly larger than anything a real emom
-- entry could ever need. Deliberately NOT set to 20 or even 100: the
-- existing where t.ord <= 20 truncation already handles every legitimate
-- near-miss (a slightly-too-long real entry) exactly as it always has,
-- silently and gracefully - only a payload with no plausible legitimate
-- reading (thousands of rounds in an EMOM) is now refused outright rather
-- than paid for.

create or replace function public.wod_entry_normalize(p_entry jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_type text;
  v_out jsonb;
  v_reps jsonb;
  v_n numeric;
begin
  if p_entry is null or jsonb_typeof(p_entry) <> 'object' then return null; end if;

  v_type := coalesce(p_entry ->> 'scoreType', '');
  if v_type not in ('time', 'amrap', 'load', 'emom') then return null; end if;

  v_out := jsonb_build_object(
    'scoreType', v_type,
    -- Carried so the caller can prove the entry is for the WOD it is being
    -- attached to. Not length-capped here: it is compared for equality
    -- against a club_wods.wod_id that already carries its own CHECK.
    'wodId', nullif(btrim(coalesce(p_entry ->> 'wodId', '')), ''),
    -- sanitizeWodEntry: `rx: e.rx !== false`. Anything that is not an
    -- explicit JSON false is Rx. Typed rather than cast, so a hand-edited
    -- import carrying rx:"maybe" cannot abort the attach.
    'rx', case when jsonb_typeof(p_entry -> 'rx') = 'boolean'
               then (p_entry ->> 'rx')::boolean else true end,
    'date', case when p_entry ->> 'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                 then p_entry ->> 'date' else null end
  );

  -- LIMITS from src/constants.js: minutes 999 (so timeSeconds caps at
  -- 999*60+59), rounds 9999, reps 1000, weight 1000, emomMovements 20.
  if v_type = 'time' then
    v_n := public.private_record_number(p_entry, 'timeSeconds');
    if v_n is not null then
      v_out := v_out || jsonb_build_object('timeSeconds', least(59999, greatest(0, round(v_n))));
    end if;
  elsif v_type = 'amrap' then
    v_n := public.private_record_number(p_entry, 'rounds');
    if v_n is not null then
      v_out := v_out || jsonb_build_object('rounds', least(9999, greatest(0, round(v_n))));
    end if;
    v_n := public.private_record_number(p_entry, 'reps');
    if v_n is not null then
      v_out := v_out || jsonb_build_object('reps', least(1000, greatest(0, round(v_n))));
    end if;
  elsif v_type = 'load' then
    v_n := public.private_record_number(p_entry, 'weight');
    if v_n is not null then
      v_out := v_out || jsonb_build_object('weight', least(1000, greatest(0, round(v_n, 2))));
    end if;
  else
    if jsonb_typeof(p_entry -> 'emomReps') = 'array' then
      -- Security hunt round 4 (202609110006): reject before expanding,
      -- rather than expanding the whole array only to discard everything
      -- past element 20.
      if jsonb_array_length(p_entry -> 'emomReps') > 1000 then
        raise exception 'too many emom rounds';
      end if;
      select coalesce(jsonb_agg(
               least(1000, greatest(0, round(coalesce(
                 public.private_record_number(jsonb_build_object('v', t.x), 'v'), 0))))
               order by t.ord), '[]'::jsonb)
        into v_reps
        from jsonb_array_elements(p_entry -> 'emomReps') with ordinality t(x, ord)
       where t.ord <= 20;
      v_out := v_out || jsonb_build_object('emomReps', coalesce(v_reps, '[]'::jsonb));
    end if;
  end if;

  -- scaledWeight is not per-score-type: formatWodEntry appends it whenever
  -- the entry is scaled, whatever the score type is.
  v_n := public.private_record_number(p_entry, 'scaledWeight');
  if v_n is not null and v_n > 0 then
    v_out := v_out || jsonb_build_object('scaledWeight', least(1000, greatest(0, round(v_n, 2))));
  end if;

  return v_out;
end $$;
revoke all on function public.wod_entry_normalize(jsonb) from public, anon, authenticated;

comment on function public.wod_entry_normalize(jsonb) is
  'Security hunt round 4 (202609110006): emomReps over 1000 elements is now refused outright (''too many emom rounds'') before any expansion, instead of being expanded in full only to keep the first 20 - closes a confirmed resource-exhaustion finding (a multi-million-element array cost ~1s of DB CPU through the real authenticated RPC path). Every legitimate near-miss (anything up to 1000 elements) still truncates to the first 20 exactly as before - only a payload with no plausible legitimate reading is now rejected. Otherwise byte-identical to 202609080002: one wod_entry payload - from private_records or from an attach call - clamped to sanitizeWodEntry()''s shape and LIMITS (timeSeconds 0..59999, rounds 0..9999, reps 0..1000, weight and scaledWeight 0..1000, at most 20 emomReps), returning null when scoreType is not one of time/amrap/load/emom. Applied to the SERVER copy as well as the client fallback: private_records.payload is client-written JSON with no schema, and having passed sanitizeWodEntry on some device at some app version is not the same as being trustworthy now. Carries wodId through so the caller can prove the entry belongs to the session it is being attached to. No client grant.';

commit;
