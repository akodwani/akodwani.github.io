"use strict";

// Pure calibration/profile logic. No DOM access - every input arrives as a
// parameter and every output is a plain value (or, for saveProfileStore, a
// simple success boolean), so this is directly reusable and directly
// testable without a browser. Rendering, the calibration drawer/wizard UI
// state, and the calibration capture (MIDI-driven arm/confirm) flow remain
// in index.html; only the persistence and data-transformation logic that
// index.html's thin wrapper functions delegate to lives here.
(function () {
  function clone(data) { return JSON.parse(JSON.stringify(data)); }

  // Validates and normalizes a saved/imported mappings object against the
  // shipped control list, rejecting anything that doesn't resolve to a real
  // control or a well-formed MIDI address, and rejecting duplicate addresses
  // within the same profile.
  function sanitizeProfileMappings(rawMappings, defaultControls) {
    if (!rawMappings || typeof rawMappings !== "object" || Array.isArray(rawMappings)) throw new Error("Profile mappings must be an object.");
    const sanitized = {};
    const addresses = new Map();
    Object.entries(rawMappings).forEach(([controlId, mapping]) => {
      const control = defaultControls.find((item) => item.id === controlId);
      const match = mapping?.match;
      const bytes = mapping?.bytes;
      if (!control || !match || ![0x90, 0xB0, 0xE0].includes(match.type)
        || !Number.isInteger(match.channel) || match.channel < 0 || match.channel > 15
        || (match.type === 0xE0 ? match.number !== null : (!Number.isInteger(match.number) || match.number < 0 || match.number > 127))
        || !Array.isArray(bytes) || bytes.length !== 3
        || bytes[0] !== (match.type | match.channel)
        || (match.type !== 0xE0 && bytes[1] !== match.number)
        || !Number.isInteger(bytes[1]) || bytes[1] < 0 || bytes[1] > 127
        || !Number.isInteger(bytes[2]) || bytes[2] < 0 || bytes[2] > 127) {
        throw new Error("Profile contains an invalid mapping for " + controlId + ".");
      }
      const address = [match.type, match.channel, match.number ?? "pitch"].join(":");
      if (addresses.has(address)) {
        throw new Error("Profile assigns the same MIDI address to " + addresses.get(address) + " and " + controlId + ".");
      }
      addresses.set(address, controlId);
      sanitized[controlId] = { match: clone(match), bytes: clone(bytes) };
    });
    return sanitized;
  }

  // Validates and normalizes a saved/imported physical-verification set: the
  // record of which controls the owner has personally confirmed against a
  // real DJ deck during the "Verify entire controller" sweep. Same shape
  // discipline as sanitizeProfileMappings, so a corrupted or hand-edited
  // profile file can never claim physical verification through the JSON
  // import path -- only the sweep's own confirmation step writes this.
  function sanitizeVerifiedEntries(rawVerified, defaultControls) {
    if (rawVerified === undefined) return {};
    if (!rawVerified || typeof rawVerified !== "object" || Array.isArray(rawVerified)) throw new Error("Profile verification data must be an object.");
    const sanitized = {};
    Object.entries(rawVerified).forEach(([controlId, entry]) => {
      const control = defaultControls.find((item) => item.id === controlId);
      if (!control || !entry || typeof entry.timestamp !== "string" || !Array.isArray(entry.bytes) || entry.bytes.length !== 3
        || entry.bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
        throw new Error("Profile contains invalid verification data for " + controlId + ".");
      }
      sanitized[controlId] = { timestamp: entry.timestamp, bytes: clone(entry.bytes) };
    });
    return sanitized;
  }

  // Finds an already-calibrated control that already owns the candidate MIDI
  // address, so the calibration wizard can refuse to assign the same address
  // to two controls. Shipped placeholders are not authoritative, so they
  // never block a new calibration.
  function mappingConflicts(candidate, controlId, controls) {
    return controls.find((control) => {
      if (control.id === controlId) return false;
      if (!control.calibrated) return false; // shipped placeholders are not authoritative
      if (control.match.type !== candidate.type || control.match.channel !== candidate.channel) return false;
      return control.match.number === null || candidate.number === null || control.match.number === candidate.number;
    });
  }

  function controlInstruction(control) {
    if (control.kind === "button") return "Press " + control.label + " once on your physical DJ deck.";
    if (control.kind === "knob") return "Turn " + control.label + " on your physical DJ deck.";
    if (control.kind === "horizontal-fader") return "Move the " + control.label + " left or right on your physical DJ deck.";
    return "Move " + control.label + " through part of its range on your physical DJ deck.";
  }

  // Persists the whole profile store under the given storage key. Returns
  // false (instead of throwing) when storage is disabled or full, so the
  // caller can decide how to surface that - e.g. index.html's saveProfiles()
  // wrapper turns a false result into the existing calibration-drawer
  // message. The storage key is passed in rather than duplicated here so
  // index.html's PROFILE_STORAGE_KEY constant stays the single source of
  // truth.
  function saveProfileStore(profileStore, storageKey) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(profileStore));
      return true;
    } catch {
      return false;
    }
  }

  // Applies one profile's saved mappings on top of the shipped defaults,
  // mutating each control object in `controls` in place (not returning a
  // new array) because index.html and the rest of the app hold long-lived
  // references to those exact control objects.
  function applyProfileToControls(profile, controls, defaultControls) {
    controls.forEach((control) => {
      const base = defaultControls.find((item) => item.id === control.id);
      const saved = profile.mappings[control.id];
      Object.keys(control).forEach((key) => delete control[key]);
      Object.assign(control, clone(base));
      control.calibrated = Boolean(saved);
      if (saved) {
        control.match = clone(saved.match);
        control.bytes = clone(saved.bytes);
        control.placeholder = false;
      }
      // Physical-verification evidence only counts while it matches the
      // control's CURRENT address. Recalibrating to a different address (or
      // switching profiles) invalidates any earlier confirmation instead of
      // silently carrying it forward onto a different, unconfirmed address.
      const verification = profile.verified?.[control.id];
      control.physicallyVerified = Boolean(verification) && verification.bytes.join(",") === control.bytes.join(",");
    });
  }

  // Builds the exportable JSON payload and a filesystem-safe filename for a
  // profile. Returns plain data rather than triggering the download itself,
  // so the actual Blob/anchor/URL.createObjectURL browser-download dance
  // (and its revoke cleanup) stays in index.html alongside the rest of its
  // DOM code, keeping this module free of DOM access.
  function buildProfileExport(profile) {
    const payload = { version: 1, exportedAt: new Date().toISOString(), profile };
    return {
      filename: profile.name.replace(/[^a-z0-9_-]+/gi, "-") + "-flx4-profile.json",
      json: JSON.stringify(payload, null, 2)
    };
  }

  // Validates and parses an imported profile file, deduplicating its name
  // against `existingProfiles` (profileStore.profiles). Resolves with the
  // ready-to-store { name, entry } pair on success; rejects with the same
  // error messages the pre-extraction code produced on failure (oversized
  // file, malformed JSON, wrong shape, invalid mappings). Does not mutate
  // `existingProfiles` or anything else - the caller (index.html) commits
  // the result to profileStore itself, so there is one place that owns
  // that mutation.
  function parseImportedProfile(file, existingProfiles, defaultControls) {
    if (!Number.isFinite(file.size) || file.size <= 0 || file.size > 1024 * 1024) {
      return Promise.reject(new Error("Choose a controller profile smaller than 1 MB."));
    }
    return file.text().then((text) => {
      const payload = JSON.parse(text);
      const profile = payload.profile || payload;
      if (!profile?.name || !profile?.mappings || typeof profile.mappings !== "object") throw new Error("That file is not an DJ Tutor profile.");
      const mappings = sanitizeProfileMappings(profile.mappings, defaultControls);
      const verified = sanitizeVerifiedEntries(profile.verified, defaultControls);
      let name = profile.name;
      let copy = 2;
      while (existingProfiles[name]) { name = profile.name + " " + copy++; }
      return { name, entry: { name, mappings, verified, updatedAt: profile.updatedAt || new Date().toISOString() } };
    });
  }

  window.FLX4Calibration = {
    sanitizeProfileMappings, sanitizeVerifiedEntries, mappingConflicts, controlInstruction,
    saveProfileStore, applyProfileToControls, buildProfileExport, parseImportedProfile
  };
})();
