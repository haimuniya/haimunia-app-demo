// The repository must not describe itself as a demo.
//
// WHY THIS EXISTS. On 2026-09-06 another agent session began a persona-based
// UX audit - browser automation, five personas, live clicking - against
// jajmlyrjlkhclgphbfbb, and asked for an invite code and an is_admin grant to
// do it. It believed that project was a demo. It believed that because the
// repository name ends in "-demo-publish" and README.md's first line said
// "(demo)".
//
// It was production: real profiles, real posts, real training logs, the
// project the installed PWA talks to. Nothing was written - the session had
// no browser connected and no credentials - so this was a near miss and not
// an incident. It was not caught by any control. It was caught by one
// session happening to know something the documentation contradicted.
//
// Two things are pinned here, because both were load-bearing in that near
// miss and neither is self-evident to someone reading a file for the first
// time:
//
//   1. The README says "live" before it says anything else. The word "demo"
//      on line 1 is what invited the test traffic.
//   2. cloud-config.js warns that it is BOTH production AND tracked.
//      Repointing it at localhost and committing that would aim every
//      installed PWA at a machine that is not running - a worse outage than
//      the mixup it would be a workaround for.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const config = fs.readFileSync(path.join(root, "cloud-config.js"), "utf8");

test("the README does not call this a demo in its title", () => {
  const title = readme.split("\n")[0];
  assert.doesNotMatch(title, /demo/i,
    `README title must not say "demo" - it points at production. Got: ${title}`);
});

test("the README warns, up front, that this ships to real members", () => {
  // "Up front" is the whole point: a warning below the fold is a warning
  // nobody read before pointing a browser at the live club.
  const head = readme.slice(0, 800);
  assert.match(head, /live app to real members/i,
    "the production warning must be in the first screenful, not buried");
  assert.match(head, /supabase (start|db reset)/i,
    "telling someone not to use production is only half a control - the head of the README must also say where to go instead");
});

test("cloud-config.js warns that it is production AND that it is tracked", () => {
  const head = config.slice(0, 700);
  assert.match(head, /PRODUCTION/,
    "the warning must sit where someone about to edit the URL will see it");
  assert.match(head, /committed|tracked/i,
    "the tracked-file hazard is the one that turns a local workaround into a live outage");
  assert.match(head, /runtime/i,
    "state the safe alternative (runtime override), or the warning just leaves people stuck");
});

test("the config still points at the production project, not a leftover local URL", () => {
  // The failure mode this whole file is about, caught directly: if someone
  // repoints the tracked config at localhost and commits it, the deployed
  // PWA breaks for everyone.
  const url = config.match(/supabaseUrl:\s*"([^"]+)"/);
  assert.ok(url, "cloud-config.js must define supabaseUrl");
  assert.doesNotMatch(url[1], /localhost|127\.0\.0\.1|0\.0\.0\.0/,
    `cloud-config.js is committed and served to real members - it must never ship a local URL. Got: ${url[1]}`);
  assert.match(url[1], /^https:\/\//,
    "the shipped config must be https");
});
