"use strict";

// Pure MIDI byte decoding. No DOM access, no dependency on the app's control
// list or any other mutable state - every input arrives as a parameter and
// every output is a plain value, so this is directly reusable and directly
// testable without a browser.
(function () {
  // Pitch Bend is a 14-bit value split across data1/data2. Everything the
  // renderer sees is normalized to the same familiar 0-127 control range.
  function normalizeMidiValue(status, number, value) {
    if ((status & 0xF0) === 0xE0) return Math.round(((value << 7) | number) * 127 / 16383);
    return value;
  }

  function decodeType(status) {
    switch (status & 0xF0) {
      case 0x80: return "Note Off";
      case 0x90: return "Note On";
      case 0xB0: return "Control Change";
      case 0xE0: return "Pitch Bend";
      default: return "Other (0x" + status.toString(16).toUpperCase() + ")";
    }
  }

  // The FLX4's jog wheel and browse encoder are relative (delta) encoders,
  // not absolute 0-127 knobs: per the official MIDI list, "Turn clockwise:
  // increases from 0x41, turn counterclockwise: decreases from 0x3F" around
  // a 0x40 center that is not itself sent during motion. Forcing this
  // through the absolute normalizer above would silently discard direction.
  function decodeRelative(rawValue) {
    if (rawValue === 0x40) return { direction: "none", delta: 0 };
    if (rawValue > 0x40) return { direction: "clockwise", delta: rawValue - 0x40 };
    return { direction: "counterclockwise", delta: 0x40 - rawValue };
  }

  window.FLX4MidiCodec = { normalizeMidiValue, decodeType, decodeRelative };
})();
