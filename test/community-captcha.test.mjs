// Launch-readiness audit, SEC-004: CAPTCHA on account creation.
//
// Anonymous sign-in is enabled and costs an attacker nothing, so unlimited
// free `authenticated` identities are the raw material for feed scraping,
// telemetry/storage flooding and invite-code guessing at scale. These tests
// pin the repository-side half of the fix: the integration, its failure
// behaviour, and the fact that it is OFF and inert until a site key exists.
//
// The dashboard half (provider + secret key under Authentication -> Bot and
// Abuse Protection) is external and is tracked in
// docs/audit/PRODUCTION_ACCEPTANCE_CHECKLIST.md, not here.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cloudJs = fs.readFileSync(path.join(root, "cloud.js"), "utf8");
const configJs = fs.readFileSync(path.join(root, "cloud-config.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("all three auth entry points are gated by the challenge", () => {
  // Anonymous bootstrap - the one SEC-004 is really about, because it is
  // what an attacker loops to mint identities.
  assert.match(cloudJs, /withCaptcha\(\(captchaToken\) =>\s*\n?\s*client\.auth\.signInAnonymously\(/);
  // Login, so a stolen username list cannot be credential-stuffed for free.
  assert.match(cloudJs, /withCaptcha\(\(captchaToken\) =>\s*\n?\s*client\.auth\.signInWithPassword\(/);
  // updateUser is the actual account-creation step in this app's flow.
  assert.match(cloudJs, /withCaptcha\(\(captchaToken\) =>\s*\n?\s*client\.auth\.updateUser\(/);
  // No bare auth call is left un-wrapped.
  const bare = cloudJs.match(/(?<!withCaptcha\(\(captchaToken\) =>\s*\n?\s*)client\.auth\.signInAnonymously\(\)/g) || [];
  assert.equal(bare.length, 0, "no ungated signInAnonymously() call remains");
});

test("it is off by default and completely inert with no site key configured", () => {
  // The shipped config must not enable it for a project that has not set
  // the matching secret in the dashboard - that would break every signup.
  assert.match(configJs, /captchaSiteKey:\s*""/,
    "captchaSiteKey ships empty; enabling it is a deliberate deploy-time act");
  assert.match(cloudJs, /function captchaEnabled\(\)\s*\{\s*return !!captchaConfig\(\)\.siteKey;\s*\}/);
  // withCaptcha short-circuits to the original call when disabled, so the
  // pre-feature behaviour is preserved exactly.
  assert.match(cloudJs, /async function withCaptcha\(fn\) \{\s*\n\s*if \(!captchaEnabled\(\)\) return fn\(undefined\);/);
  assert.match(cloudJs, /function getCaptchaToken\(\) \{\s*\n\s*if \(!captchaEnabled\(\)\) return Promise\.resolve\(null\);/);
});

test("a failed, errored, expired or timed-out challenge REFUSES the request instead of failing open", () => {
  // The critical property: withCaptcha must not fall through to an
  // un-captcha'd call when the token cannot be obtained. A CAPTCHA that
  // silently passes on script failure is not a control at all.
  const fn = cloudJs.slice(cloudJs.indexOf("async function withCaptcha(fn)"));
  const body = fn.slice(0, fn.indexOf("\n  }") + 4);
  assert.match(body, /catch \(e\) \{[\s\S]*?return \{ error: \{ message: "captcha_failed" \} \};/,
    "a token failure returns an error rather than proceeding without a token");
  // The precise property: the catch block itself must not call fn(), which
  // is the only way a token failure could still reach the auth endpoint.
  const catchBlock = body.slice(body.indexOf("catch (e) {"), body.indexOf("return fn(token)"));
  assert.doesNotMatch(catchBlock, /fn\(/,
    "the catch block must not invoke the wrapped auth call - that would be failing open");
  // And the only unconditional fn() calls are the disabled short-circuit
  // and the success path, both of which are intended.
  assert.equal((body.match(/fn\(/g) || []).length, 2,
    "exactly two call sites: the captcha-disabled short-circuit and the with-token success path");

  // Each provider failure mode rejects, so they all reach that catch.
  assert.match(cloudJs, /"error-callback":/);
  assert.match(cloudJs, /"expired-callback":/);
  assert.match(cloudJs, /captcha timed out/);
  assert.match(cloudJs, /s\.onerror = \(\) => \{ captchaScriptPromise = null; reject\(new Error\("captcha script failed to load"\)\); \}/);
});

test("a failed challenge is retryable rather than locking the member out for the session", () => {
  // ensureAnonymousSession() sets a one-shot guard; on a captcha failure it
  // has to release it, or the member is stuck until they reload.
  const fn = cloudJs.slice(cloudJs.indexOf("async function ensureAnonymousSession()"));
  const body = fn.slice(0, fn.indexOf("\n  }") + 4);
  assert.match(body, /anonSignInAttempted = false;/,
    "the one-shot guard is released so the member can try the challenge again");
});

test("a captcha failure at login is not reported as a wrong password", () => {
  assert.match(cloudJs, /if \(error\.message === "captcha_failed"\) return setFieldErrors\("communityLogin", \{ password: "אימות האבטחה נכשל, נסו שוב" \}\);/,
    "telling a member their password is wrong when the challenge failed sends them to reset a password that was fine");
});

test("the token is single-use per call and never logged", () => {
  // getCaptchaToken resolves a fresh token per invocation (a new host
  // element and a new render each time), and nothing writes it anywhere.
  assert.match(cloudJs, /const host = document\.createElement\("div"\);/);
  assert.doesNotMatch(cloudJs, /console\.[a-z]+\([^)]*captchaToken/,
    "the token must never reach a log");
  assert.doesNotMatch(cloudJs, /console\.[a-z]+\([^)]*token\b[^)]*\)/,
    "and neither must any variable literally named token");
});

test("only the two supported providers can be loaded, and the URLs are pinned", () => {
  assert.match(cloudJs, /turnstile: "https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js"/);
  assert.match(cloudJs, /hcaptcha: "https:\/\/js\.hcaptcha\.com\/1\/api\.js"/);
  // An unknown provider must not silently resolve to "no captcha".
  assert.match(cloudJs, /if \(!url\) return Promise\.reject\(new Error\("unknown captcha provider"\)\);/);
});

test("the CSP allows exactly those provider hosts and does not widen connect-src to anything else", () => {
  const csp = indexHtml.slice(indexHtml.indexOf("Content-Security-Policy"), indexHtml.indexOf('referrer"'));
  assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com https:\/\/js\.hcaptcha\.com/);
  assert.match(csp, /frame-src https:\/\/challenges\.cloudflare\.com/);
  // SEC-015 leans on connect-src to stop an injected script exfiltrating a
  // stolen token. The captcha hosts are needed for verification traffic but
  // nothing else may be added alongside them.
  const connect = csp.match(/connect-src ([^;]+);/);
  assert.ok(connect, "connect-src is still declared");
  const hosts = connect[1].trim().split(/\s+/);
  assert.deepEqual(hosts.sort(), [
    "'self'",
    "https://api.hcaptcha.com",
    "https://challenges.cloudflare.com",
    "https://jajmlyrjlkhclgphbfbb.supabase.co",
    "wss://jajmlyrjlkhclgphbfbb.supabase.co",
  ].sort(), "connect-src holds only self, the Supabase project, and the two captcha verification hosts");
  // The strict directives that were never weakened.
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /form-action 'none'/);
});
