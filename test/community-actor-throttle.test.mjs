// COMM-017 - actor-level invite throttle outside the anonymous user id.
//
// The client half: redeemCode() must pass a stable actor_key that
// survives an anonymous session being discarded and recreated, and the
// server's rate_limited answer must reach the existing field-error UI
// with a generic Hebrew message that never hints at a remaining count.
// The server half (the throttle actually holding across both keys) lives
// in migration 202608280013 and its own tests.
import { test } from "node:test";
import assert from "node:assert";
import { bootCommunity, waitFor } from "./helpers/boot.mjs";
import { createMockSupabase } from "./helpers/mockSupabase.mjs";

async function reachInviteForm(window) {
  window.document.getElementById("tabCommunityBtn").click();
  await waitFor(() => !!window.document.getElementById("communityLogin"), 3000);
  window.document.querySelector('[data-community-action="start-signup"]').click();
  await waitFor(() => !!window.document.getElementById("communityInviteCode"), 3000);
}

function enterCode(window, code) {
  window.document.querySelector('#communityInviteCode input[name="code"]').value = code;
  window.document.getElementById("communityInviteCode").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

test("redeemCode passes a non-empty actor_key, persisted in localStorage and capped at 128 chars", async () => {
  const mock = createMockSupabase();
  const calls = [];
  mock.onRpc("redeem_invite_code", (args) => { calls.push(args); return { data: "member", error: null }; });

  const window = await bootCommunity(mock, { syncEnabled: false });
  await reachInviteForm(window);
  enterCode(window, "a".repeat(40));

  await waitFor(() => calls.length === 1, 3000);
  assert.equal(typeof calls[0].p_code, "string");
  assert.equal(typeof calls[0].p_actor_key, "string");
  assert.ok(calls[0].p_actor_key.length > 0 && calls[0].p_actor_key.length <= 128, "actor key is present and within the 128-char cap");
  const stored = window.localStorage.getItem("haimunia-demo:communityActorKey");
  assert.equal(stored, calls[0].p_actor_key, "the key came from a persistent localStorage identifier");
});

test("the actor_key is identical before and after an anonymous session is replaced", async () => {
  const mock = createMockSupabase();
  const calls = [];
  // Invalid so no redemption is written and the invite form stays put.
  mock.onRpc("redeem_invite_code", (args) => { calls.push(args); return { data: "invalid", error: null }; });

  const window = await bootCommunity(mock, { syncEnabled: false });
  await reachInviteForm(window);
  const firstUser = mock.getUser().id;
  enterCode(window, "b".repeat(40));
  await waitFor(() => calls.length === 1, 3000);

  // Discard the anonymous session and bootstrap a brand new one - the uid
  // key changes, the device key must not.
  await mock.client.auth.signInAnonymously();
  await waitFor(() => mock.getUser().id !== firstUser, 3000);
  await waitFor(() => !!window.document.getElementById("communityInviteCode"), 3000);
  enterCode(window, "c".repeat(40));
  await waitFor(() => calls.length === 2, 3000);

  assert.notEqual(firstUser, mock.getUser().id, "the anonymous uid really was replaced");
  assert.equal(calls[0].p_actor_key, calls[1].p_actor_key, "the actor key held across the session replacement");
});

test("a rate_limited answer shows the generic Hebrew error on the code field and writes no redemption", async () => {
  const mock = createMockSupabase();
  mock.onRpc("redeem_invite_code", () => ({ data: "rate_limited", error: null }));

  const window = await bootCommunity(mock, { syncEnabled: false });
  await reachInviteForm(window);
  enterCode(window, "d".repeat(40));

  await waitFor(() => {
    const err = window.document.querySelector("#communityInviteCode .field-error");
    return err && /יותר מדי ניסיונות/.test(err.textContent);
  }, 3000);
  const err = window.document.querySelector("#communityInviteCode .field-error").textContent;
  assert.match(err, /יותר מדי ניסיונות\. יש לנסות שוב מאוחר יותר/);
  assert.doesNotMatch(err, /\d/, "no remaining-count or attempts-left number is leaked");
  assert.equal((mock.db.invite_redemptions || []).length, 0, "a throttled attempt creates no redemption");
  assert.ok(window.document.getElementById("communityInviteCode"), "still on the invite gate");
});

test("the rate_limited message is the same string whether or not the actor has been seen before", async () => {
  const mock = createMockSupabase();
  let n = 0;
  // First call: brand-new actor. Second call: 'known' actor. Same answer.
  mock.onRpc("redeem_invite_code", () => { n++; return { data: "rate_limited", error: null }; });

  const window = await bootCommunity(mock, { syncEnabled: false });
  await reachInviteForm(window);
  enterCode(window, "e".repeat(40));
  await waitFor(() => !!window.document.querySelector("#communityInviteCode .field-error"), 3000);
  const first = window.document.querySelector("#communityInviteCode .field-error").textContent;

  enterCode(window, "f".repeat(40));
  await waitFor(() => n === 2, 3000);
  const second = window.document.querySelector("#communityInviteCode .field-error").textContent;
  assert.equal(first, second, "identical generic message on both attempts");
});

test("the actor key survives a sign-out (localStorage is not cleared)", async () => {
  const mock = createMockSupabase();
  const calls = [];
  mock.onRpc("redeem_invite_code", (args) => { calls.push(args); return { data: "invalid", error: null }; });

  const window = await bootCommunity(mock, { syncEnabled: false });
  await reachInviteForm(window);
  enterCode(window, "g".repeat(40));
  await waitFor(() => calls.length === 1, 3000);
  const keyBefore = window.localStorage.getItem("haimunia-demo:communityActorKey");

  await mock.client.auth.signOut();
  await waitFor(() => !!window.document.getElementById("communityLogin"), 3000);

  assert.equal(window.localStorage.getItem("haimunia-demo:communityActorKey"), keyBefore, "sign-out leaves the actor key in place");
});
