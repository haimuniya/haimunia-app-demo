// Reported directly, with a screenshot of a Hebrew keyboard: handles were
// English-letters-only (a-z0-9_) - real friction for a Hebrew-speaking
// membership. Widened both the client regex and the database CHECK
// constraint to also accept Hebrew letters (א-ת), and removed the forced
// dir="ltr" on the field, which would have rendered Hebrew backwards
// while typing even once the regex allowed it.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

const sql = fs.readFileSync(new URL("../supabase/migrations/202608270008_hebrew_handles.sql", import.meta.url), "utf8");
const cloudJs = fs.readFileSync(new URL("../cloud.js", import.meta.url), "utf8");

test("the database handle constraint accepts Hebrew letters, same length bound as before", () => {
  assert.match(sql, /alter table public\.profiles drop constraint profiles_handle_check/i);
  assert.match(sql, /check \(handle ~ '\^\[a-zא-ת0-9_\]\{3,24\}\$'\)/);
});

test("the client-side handle validation matches the database constraint exactly", () => {
  assert.match(cloudJs, /\/\^\[a-zא-ת0-9_\]\{3,24\}\$\/\.test\(handle\)/);
});

test("neither handle input forces dir=\"ltr\" anymore - Hebrew must render naturally while typing", () => {
  assert.doesNotMatch(cloudJs, /name="handle" dir="ltr"/);
  const handleInputs = (cloudJs.match(/name="handle" dir="auto"/g) || []).length;
  assert.equal(handleInputs, 2, "both handle inputs (the profile gate and the account tab) must use dir=\"auto\"");
});
