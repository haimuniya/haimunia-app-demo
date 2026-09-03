// ---------- Untrusted value cleaners ----------
// cleanStr/cleanNum/cleanId/cleanISODate/cleanTs and uid moved to
// src/shared/safe-helpers.js in COMM-368 - they are the generic, low-level
// half of this file and the half the sibling Box Log client had a
// byte-identical fork of. They are bound as bare identifiers at the top of
// src/constants.js, which loads before this file, so every call site below
// (and in app.js) is unchanged.
//
// What stays here is the half that is NOT shareable: the per-record
// sanitizers, which are specific to this app's own schema (entries, WODs,
// bodyweight, measurements) and to this repo's LIMITS/MOVEMENT_CATEGORIES.
// ---------- Record sanitizers ----------
// Applied to every record that comes off disk or out of an imported file.
// Nothing else in the app is allowed to trust these shapes.
function sanitizeMovement(m) {
  if (!m || typeof m !== "object") return null;
  const id = cleanId(m.id), name = cleanStr(m.name, LIMITS.nameLen);
  if (!id || !name) return null;
  return { id, name, category: MOVEMENT_CATEGORIES.includes(m.category) ? m.category : "Other" };
}
function sanitizeWodMovementTag(t) {
  if (!t || typeof t !== "object") return null;
  const name = cleanStr(t.name, LIMITS.nameLen);
  if (!name) return null;
  return { name, category: WOD_MOVE_CATEGORIES.includes(t.category) ? t.category : "Gymnastics" };
}
function sanitizeCustomWod(w) {
  if (!w || typeof w !== "object") return null;
  const id = cleanId(w.id), name = cleanStr(w.name, LIMITS.nameLen);
  if (!id || !name) return null;
  const scoreType = WOD_SCORE_TYPES.includes(w.scoreType) ? w.scoreType : "time";
  const out = { id, name, category: "Custom", scoreType, desc: cleanStr(w.desc, LIMITS.notesLen) };
  // EMOM structure lives on the WOD itself (unlike every other format, whose
  // per-movement fields are only ever baked into free text) — the log form
  // needs to know the movement rotation to render one reps field per
  // movement each time this WOD is attempted. See renderWodLogSection.
  if (scoreType === "emom") {
    const movements = Array.isArray(w.emomMovements) ? w.emomMovements : [];
    out.emomMovements = movements.slice(0, LIMITS.emomMovements).map((n) => cleanStr(n, LIMITS.nameLen)).filter(Boolean);
    const targets = Array.isArray(w.emomTargetReps) ? w.emomTargetReps : [];
    out.emomTargetReps = out.emomMovements.map((_, i) => Math.round(cleanNum(targets[i], 0, LIMITS.reps, 0)));
    out.emomMinutes = Math.round(cleanNum(w.emomMinutes, 1, LIMITS.minutes, 10));
    if (out.emomMovements.length === 0) return null;
  }
  // Optional reference-only time cap (e.g. "For Time, 20 min cap") — shown
  // in the log form, never enforced or scored against.
  const cap = cleanNum(w.timeCapSeconds, 0, LIMITS.minutes * 60 + 59, 0);
  out.timeCapSeconds = cap || null;
  return out;
}
function sanitizeEntry(e) {
  if (!e || typeof e !== "object") return null;
  const id = cleanId(e.id), exerciseId = cleanId(e.exerciseId), date = cleanISODate(e.date);
  if (!id || !exerciseId || !date) return null;
  const sets = cleanNum(e.sets, 0, LIMITS.sets, null);
  if (sets === null) return null;
  // "duration" entries (holds/carries) skip reps/est1RM entirely — a hold has
  // no rep count, and est1RM extrapolation is meaningless for time-under-load.
  // Weight stays optional (0 for a bodyweight hold, >0 for a weighted carry).
  const type = e.type === "duration" ? "duration" : "reps";
  const groupId = cleanId(e.groupId) || null;
  // Optional free tag ("A"/"B"/"C"/"D") for real A/B/C session-block
  // programming — set once per ladder/superset group, see ladderBlockLabel.
  const blockLabel = cleanStr(e.blockLabel, 8) || null;
  if (type === "duration") {
    const durationSeconds = cleanNum(e.durationSeconds, 1, LIMITS.duration, null);
    if (durationSeconds === null) return null;
    const weight = cleanNum(e.weight, 0, LIMITS.weight, 0);
    return {
      id, exerciseId, date, type, weight, reps: 0, sets: Math.round(sets),
      durationSeconds: Math.round(durationSeconds),
      ts: cleanTs(e.ts), isPR: e.isPR === true, groupId, blockLabel, est1RM: 0,
    };
  }
  const weight = cleanNum(e.weight, 0, LIMITS.weight, null);
  const reps = cleanNum(e.reps, 0, LIMITS.reps, null);
  if (weight === null || reps === null) return null;
  return {
    id, exerciseId, date, type, weight, reps, sets: Math.round(sets),
    durationSeconds: 0,
    ts: cleanTs(e.ts), isPR: e.isPR === true,
    // Links several rows saved as one working-set ladder or superset (same
    // groupId, one or two exerciseIds, same day) so the calendar day view
    // can group them — see renderCalDetail. null for an ordinary single set.
    groupId, blockLabel,
    est1RM: cleanNum(e.est1RM, 0, LIMITS.weight * 2, estimate1RM(weight, reps)),
  };
}
function sanitizeWodEntry(e) {
  if (!e || typeof e !== "object") return null;
  const id = cleanId(e.id), wodId = cleanId(e.wodId), date = cleanISODate(e.date);
  if (!id || !wodId || !date) return null;
  const scoreType = WOD_SCORE_TYPES.includes(e.scoreType) ? e.scoreType : "time";
  // EMOM has no cross-attempt scoring (yet) — never let a hand-edited import
  // claim a PR flame for it.
  const out = { id, wodId, date, scoreType, ts: cleanTs(e.ts), rx: e.rx !== false, isPR: scoreType === "emom" ? false : e.isPR === true };
  if (scoreType === "time") out.timeSeconds = cleanNum(e.timeSeconds, 0, LIMITS.minutes * 60 + 59, 0);
  else if (scoreType === "amrap") {
    out.rounds = Math.round(cleanNum(e.rounds, 0, LIMITS.rounds, 0));
    out.reps = Math.round(cleanNum(e.reps, 0, LIMITS.reps, 0));
  } else if (scoreType === "emom") {
    // No fixed movement count to validate against here (the WOD record that
    // defines it may not even be loaded yet during import) — just clamp
    // whatever array of rep counts came in; renderWodLogSection resizes it
    // to match the WOD's own movement count whenever it's actually shown.
    const reps = Array.isArray(e.emomReps) ? e.emomReps : [];
    out.emomReps = reps.slice(0, LIMITS.emomMovements).map((r) => Math.round(cleanNum(r, 0, LIMITS.reps, 0)));
  } else out.weight = cleanNum(e.weight, 0, LIMITS.weight, 0);
  if (!out.rx) {
    const sw = cleanNum(e.scaledWeight, 0, LIMITS.weight, 0);
    if (sw) out.scaledWeight = sw;
    const notes = cleanStr(e.notes, LIMITS.notesLen);
    out.notes = notes || null;
  }
  // Applies regardless of Rx/Scaled — a partner WOD is a partner WOD either way.
  out.partnerTag = cleanStr(e.partnerTag, LIMITS.partnerTag) || null;
  return out;
}
function sanitizeBodyweight(e) {
  if (!e || typeof e !== "object") return null;
  const id = cleanId(e.id), date = cleanISODate(e.date);
  const weight = cleanNum(e.weight, 0, LIMITS.bodyweight, null);
  if (!id || !date || weight === null) return null;
  return { id, date, weight, ts: cleanTs(e.ts) };
}
function sanitizeMeasureType(t) {
  if (!t || typeof t !== "object") return null;
  const id = cleanId(t.id), name = cleanStr(t.name, LIMITS.nameLen);
  if (!id || !name) return null;
  return { id, name };
}
function sanitizeMeasurement(e) {
  if (!e || typeof e !== "object") return null;
  const id = cleanId(e.id), typeId = cleanId(e.typeId), date = cleanISODate(e.date);
  const value = cleanNum(e.value, 0, LIMITS.measurement, null);
  if (!id || !typeId || !date || value === null) return null;
  return { id, typeId, date, value, ts: cleanTs(e.ts) };
}
function sanitizeList(list, fn) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, LIMITS.importItems).map(fn).filter(Boolean);
}
