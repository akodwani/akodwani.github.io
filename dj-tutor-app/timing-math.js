"use strict";

// Pure timing-lesson math. No DOM access, no globals besides its own export
// object - every input arrives as a parameter and every output is a plain
// value, so these are directly reusable by any future timing lesson and
// directly testable without a browser.
(function () {
  function boundaryBeats(target) {
    if (target === "bar") return 4;
    if (target === "phrase8" || target === "8bar") return 32;
    return 128; // "phrase" (32 bars) is the default
  }

  function nearestBoundary(baseBpm, offset, time, beats) {
    const len = beats * (60 / baseBpm);
    return offset + Math.round((time - offset) / len) * len;
  }

  // Pure classifier: how far the action landed from a grid boundary, and
  // whether that counts as "on" within the window.
  function evaluateTiming(actionTime, boundaryTime, windowMs) {
    const offsetMs = Math.round((actionTime - boundaryTime) * 1000);
    const success = Math.abs(offsetMs) <= windowMs;
    return { offsetMs, success, verdict: success ? "on" : (offsetMs < 0 ? "early" : "late") };
  }

  // Turns a result into learner-facing words. Within the window is always a
  // success; wording still distinguishes dead-on from a hair off, and a miss.
  function timingFeedback(result) {
    const mag = Math.abs(result.offsetMs);
    const ms = " (" + (result.offsetMs >= 0 ? "+" : "−") + mag + " ms)";
    if (result.missed) return { text: "You didn't move — wait for the line, then hit it. Try again.", cls: "miss" };
    if (result.success) {
      if (mag <= 90) return { text: "On the phrase!" + ms, cls: "ok" };
      return { text: "On the phrase — " + (result.offsetMs < 0 ? "a hair early" : "a hair late") + ms, cls: "ok" };
    }
    return { text: (result.offsetMs < 0 ? "A little early" : "Late") + " — try again" + ms, cls: "miss" };
  }

  // The boundary to aim at: the first one that leaves room for a lead-in.
  function chooseTargetBoundary(baseBpm, offset, duration, leadInSec, beats) {
    const len = beats * (60 / baseBpm);
    let last = offset;
    for (let b = offset; b <= duration - 0.3; b += len) { if (b >= leadInSec + 0.3) return b; last = b; }
    return last;
  }

  window.FLX4TimingMath = { boundaryBeats, nearestBoundary, evaluateTiming, timingFeedback, chooseTargetBoundary };
})();
