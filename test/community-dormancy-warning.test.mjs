// The unreachable-backup warning.
//
// WHY THIS SURFACE EXISTS. Cloud backup opens an ANONYMOUS Supabase account
// and mirrors the training log into private_records under it. An anonymous
// account has no email, no phone and no password: the only credential that
// can ever reach it again is the refresh token in this browser. Clear site
// data, change phones, or lose the device, and the cloud copy is still on
// the server and unreachable by anyone, permanently.
//
// 202609070001 stopped the purge job deleting those accounts - correctly,
// it was destroying members' only training logs - and in doing so made the
// unreachable copy permanent rather than temporary. Its header says the
// long-window delete it declined "needs client work (a warning surface and
// an export prompt) and its own policy language first". This is that
// warning surface, and these tests pin the two things it must never do:
// under-warn a member who is actually at risk, and over-warn by claiming a
// deletion that no longer happens.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(root, "src", "dormancy.js"), "utf8");
const cloudJs = fs.readFileSync(path.join(root, "cloud.js"), "utf8");
const appJs = fs.readFileSync(path.join(root, "app.js"), "utf8");

// src/dormancy.js is a classic script that publishes to `window`, same as
// src/outbox.js - evaluate it against a fake window the way boot.mjs does.
function load() {
  const win = {};
  return new Function("window", src + "\nreturn window.HaimuniaDormancy;")(win);
}

// A member genuinely at risk: anonymous account, real training data, aged
// past the warning threshold, never took a copy.
const AT_RISK = {
  configured: true, optedOut: false, signedIn: true,
  isAnonymous: true, hasRecovery: false,
  entryCount: 40, accountAgeDays: 60, daysSinceExport: null,
};

test("the at-risk member is warned", () => {
  const d = load();
  assert.equal(d.assess(AT_RISK).level, "urgent");
});

test("setting a login name and password silences it completely", () => {
  // This is the outcome the whole surface exists to produce. If it kept
  // warning afterwards it would be noise, and noise is what trains people
  // to ignore the warning that matters.
  const d = load();
  assert.equal(d.assess({ ...AT_RISK, isAnonymous: false }).level, "none");
  assert.equal(d.assess({ ...AT_RISK, hasRecovery: true }).level, "none");
});

test("an empty account is never warned about", () => {
  // The population the purge job was originally written for. Nothing is at
  // stake, and spending a member's attention here is what makes them skip
  // the real warning later.
  const d = load();
  assert.equal(d.assess({ ...AT_RISK, entryCount: 0 }).level, "none");
});

test("a member who is not backing up to the cloud is never warned", () => {
  const d = load();
  for (const off of [{ configured: false }, { optedOut: true }, { signedIn: false }]) {
    assert.equal(d.assess({ ...AT_RISK, ...off }).level, "none",
      `must stay silent for ${JSON.stringify(off)} - there is nothing in the cloud to be locked out of`);
  }
});

test("a brand-new account gets the soft framing, not the alarm", () => {
  const d = load();
  assert.equal(d.assess({ ...AT_RISK, accountAgeDays: 1 }).level, "soft");
  assert.equal(d.assess({ ...AT_RISK, accountAgeDays: 13 }).level, "soft");
  assert.equal(d.assess({ ...AT_RISK, accountAgeDays: 14 }).level, "urgent");
});

test("a recent downloaded copy quiets it; a stale one does not", () => {
  const d = load();
  assert.equal(d.assess({ ...AT_RISK, daysSinceExport: 0 }).level, "soft",
    "exported today - 0 is a real value and must not be read as falsy/never");
  assert.equal(d.assess({ ...AT_RISK, daysSinceExport: 30 }).level, "soft");
  assert.equal(d.assess({ ...AT_RISK, daysSinceExport: 31 }).level, "urgent",
    "a copy older than the window is stale: every workout since then is in one place again");
});

test("NEVER exported is treated as at-risk, not as recently exported", () => {
  // The bug this pins: `if (!daysSinceExport)` would swallow both null AND
  // 0, silencing the warning for exactly the members who never took a copy -
  // the common case and the whole point.
  const d = load();
  for (const v of [null, undefined]) {
    assert.equal(d.assess({ ...AT_RISK, daysSinceExport: v }).level, "urgent",
      `daysSinceExport=${v} means NEVER exported and must warn`);
  }
});

test("the warning never claims the data will be deleted", () => {
  // 202609070001 RETAINS these accounts. A deletion threat would be false,
  // and would repeat the exact defect the purge bug had - the app promising
  // something the database does not do. The honest risk is losing ACCESS.
  const panel = cloudJs.slice(cloudJs.indexOf("const unreachableWarning"));
  const warning = panel.slice(0, panel.indexOf("\n    const credentialsCta"));
  assert.ok(/אף אחד לא ימחק אותו/.test(warning),
    "the copy should say plainly that nothing is being deleted");
  assert.ok(!/(יימחק|נמחק|תימחק|ימחקו)\s/.test(warning.replace("אף אחד לא ימחק אותו", "")),
    "no other sentence may threaten deletion");
});

test("the warning offers a download, and the download reports failure honestly", () => {
  const d = load();
  assert.match(cloudJs, /data-community-action="backup-download-copy"/,
    "the urgent state must offer the one action that survives losing this browser");
  assert.match(cloudJs, /action === "backup-download-copy"/, "the action must be handled");
  // A browser without URL.createObjectURL produces no file; claiming success
  // there would leave a member believing they have a copy they do not have.
  // Live bug hunt (2026-09-11): now async (buildBackupPayload() reads
  // session notes off IndexedDB) - same "return ok" contract, just awaited.
  assert.match(appJs, /window\.haimuniaExportBackup = async function \(\) \{[\s\S]{0,300}return ok;/,
    "the bridge must report whether a file was actually produced");
  assert.match(cloudJs, /ok \? "ההורדה התחילה[^"]*" : "ההורדה נכשלה/,
    "the toast must distinguish a started download from a failed one");
  void d;
});

test("the panel degrades to the old copy if the module is missing", () => {
  // src/dormancy.js is precached by sw.js, but a stale cache or a blocked
  // request must not blank the backup panel - the credentials form is how a
  // member fixes this, and it has to survive the warning failing to load.
  assert.match(cloudJs, /if \(!window\.HaimuniaDormancy \|\| typeof window\.haimuniaTrainingDataSummary !== "function"\) return \{ level: "soft" \};/,
    "a missing module must fall back to the pre-existing soft framing, not to 'urgent' and not to a crash");
});

test("the counted records are the ones that actually reach the cloud", () => {
  // The question is 'what would be stranded on the server', so the count has
  // to be the groups queueSyncRecord() mirrors to private_records. Counting
  // device-only data would warn members with nothing in the cloud.
  const fn = appJs.slice(appJs.indexOf("window.haimuniaTrainingDataSummary"));
  const body = fn.slice(0, fn.indexOf("};") + 2);
  for (const group of ["entries", "wodEntries", "bodyweightEntries", "measureEntries",
                       "customMovements", "customWods", "measureTypes"]) {
    assert.ok(body.includes(group), `${group} is synced to private_records and must be counted`);
  }
});
