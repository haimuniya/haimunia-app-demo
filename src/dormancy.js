// The backup a member cannot get back.
//
// THE GAP THIS CLOSES. Cloud backup opens an ANONYMOUS Supabase account and
// mirrors the training log into private_records under that uid. An anonymous
// account has no email, no phone, and no password - the only thing that can
// ever reach it again is the refresh token in this browser's storage. Clear
// site data, switch phones, or lose the device, and the cloud copy still
// exists on the server and is unreachable by anyone, forever.
//
// The settings panel already offers the fix - a login name and password -
// but frames it as a convenience: "access to the same data from another
// device requires a login name and password". That is a true sentence about
// a feature. It is not a true sentence about the RISK, and a member reading
// it has no way to learn that the alternative is losing everything.
//
// 202609070001 made this worse in a way worth stating plainly. Before it,
// these accounts were deleted after 30 dormant days - destructively, but the
// member at least ended up with nothing on a server they could not reach.
// Now they are RETAINED indefinitely, which is the right call, and it means
// the unreachable copy is permanent. That migration's own header says the
// long-window delete it declined "needs client work (a warning surface and
// an export prompt) and its own policy language first". This file is the
// decision half of that warning surface.
//
// WHAT THIS DELIBERATELY DOES NOT SAY. It never tells a member their data is
// scheduled for deletion, because after 202609070001 that is FALSE. The
// honest risk is losing access, not losing the row, and overstating it to
// drive an action would be the same defect the purge bug had: a promise the
// database does not keep. The copy this drives is "you cannot get back in",
// which is true today and stays true whatever the retention window becomes.
window.HaimuniaDormancy = (function () {
  "use strict";

  // Long enough that a member trying the app for an evening is not lectured,
  // short enough to land well before a device is lost or replaced. The cost
  // of being early is a paragraph of text; the cost of being late is a
  // training history.
  var WARN_AFTER_DAYS = 14;

  // A downloaded copy is a real answer to this risk, so a member who took one
  // recently is not nagged. It expires because the copy goes stale: every
  // workout logged after it is once again in only one place.
  var STALE_EXPORT_DAYS = 30;

  // Levels, in escalating order:
  //   "none"   - not applicable, or nothing at stake. Render nothing.
  //   "soft"   - the existing convenience framing is right. New account, or
  //              a fresh downloaded copy exists.
  //   "urgent" - real data, aged account, no recent copy, no way back in.
  //              Say so plainly and offer the download.
  function assess(input) {
    var i = input || {};
    var no = function (reason) { return { level: "none", reason: reason }; };

    // Nothing is in the cloud, so there is nothing to be locked out of.
    if (!i.configured) return no("cloud not configured");
    if (i.optedOut) return no("backup off");
    if (!i.signedIn) return no("no session");

    // The whole risk is "anonymous and therefore unreachable". Either of
    // these means the member can get back in from any device, which is the
    // outcome this surface exists to produce - so it must go quiet the
    // moment it succeeds, or it becomes noise that trains people to ignore
    // it.
    if (!i.isAnonymous) return no("account has credentials");
    if (i.hasRecovery) return no("recovery method verified");

    // An empty account is the case the purge job was originally written for,
    // and it is genuinely fine to lose. Warning here would spend the
    // member's attention on nothing.
    var entryCount = Number(i.entryCount) || 0;
    if (entryCount < 1) return no("no training data at risk");

    var ageDays = Number(i.accountAgeDays);
    if (!isFinite(ageDays)) ageDays = 0;
    if (ageDays < WARN_AFTER_DAYS) {
      return { level: "soft", reason: "account younger than " + WARN_AFTER_DAYS + " days", entryCount: entryCount };
    }

    // null/undefined means never exported - which is the common case and the
    // one that matters, so it must NOT be treated as "recently exported".
    // Written as an explicit null check rather than a falsy test because 0 is
    // a legitimate value here (exported today) and must count as recent.
    var since = i.daysSinceExport;
    if (since !== null && since !== undefined && isFinite(Number(since)) && Number(since) <= STALE_EXPORT_DAYS) {
      return { level: "soft", reason: "copy downloaded " + Number(since) + " days ago", entryCount: entryCount };
    }

    return {
      level: "urgent",
      reason: "anonymous account, " + entryCount + " records, no copy",
      entryCount: entryCount,
      daysSinceExport: (since === null || since === undefined) ? null : Number(since)
    };
  }

  return {
    assess: assess,
    WARN_AFTER_DAYS: WARN_AFTER_DAYS,
    STALE_EXPORT_DAYS: STALE_EXPORT_DAYS
  };
})();
