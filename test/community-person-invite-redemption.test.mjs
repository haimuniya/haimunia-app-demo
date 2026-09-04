// COMM-380 - client half of COMM-372's redeem_invite_code widening.
//
// The RPC's three-way return (role text on success, 'invalid',
// 'rate_limited') is unchanged, but a per-person invite can now grant
// "coach" as well as "member" (COMM-372's own privilege widening). Before
// this ticket, redeemCode() treated any non-"member" answer as failure -
// so a real, successful coach-invite redemption (the server had already
// claimed the single-use row and inserted invite_redemptions) showed the
// user a generic "invalid" error while their code was already burned.
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

test("a per-person invite that grants \"coach\" is treated as a successful redemption, not an error", async () => {
  const mock = createMockSupabase();
  const calls = [];
  mock.onRpc("redeem_invite_code", (args) => {
    calls.push(args);
    mock.db.invite_redemptions = mock.db.invite_redemptions || [];
    mock.db.invite_redemptions.push({ user_id: mock.getUser().id, invite_id: null, person_invite_id: "person-invite-1", role: "coach", redeemed_at: new Date().toISOString() });
    return { data: "coach", error: null };
  });

  const window = await bootCommunity(mock, { syncEnabled: false });
  await reachInviteForm(window);
  enterCode(window, "a".repeat(48));

  await waitFor(() => calls.length === 1, 3000);
  // Success moves the flow past the invite-code screen entirely (the next
  // render branches on state.redemption, which loadRedemption() just
  // populated) - this is what proves the client did not misread "coach"
  // as a failure the way it did before this fix.
  await waitFor(() => !window.document.getElementById("communityInviteCode"), 3000);
  assert.ok(!window.document.getElementById("communityInviteCode"), "the invite-code screen is gone, redemption succeeded");
  assert.ok(!window.document.querySelector("#communityInviteCode .field-error"), "no error was shown for a real per-person coach invite");
});

test("a genuinely invalid per-person code ('invalid') still shows the generic error and does not advance", async () => {
  const mock = createMockSupabase();
  mock.onRpc("redeem_invite_code", () => ({ data: "invalid", error: null }));

  const window = await bootCommunity(mock, { syncEnabled: false });
  await reachInviteForm(window);
  enterCode(window, "b".repeat(48));

  await waitFor(() => {
    const err = window.document.querySelector("#communityInviteCode .field-error");
    return err && /קוד ההזמנה שגוי, פג תוקף או נוצל/.test(err.textContent);
  }, 3000);
  assert.ok(window.document.getElementById("communityInviteCode"), "still on the invite gate after a genuinely invalid code");
});
