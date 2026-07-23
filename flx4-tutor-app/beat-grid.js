"use strict";

// Beat grid foundation. Three small tools, no UI of its own:
//  - detect(buffer): find BPM + first-beat offset locally from an onset
//    envelope and autocorrelation. No track data or executable code crosses
//    the network; unclear material rejects so the caller can use tap tempo.
//  - forEachGridLine(...): walk every beat/bar/phrase line of a track.
//  - TapTempo: turn user taps into a BPM.
//
// All times are TRACK time (seconds inside the audio file). The tempo fader
// changes playbackRate, which changes how fast the playhead moves through the
// file - not where the beats sit in it. Effective BPM = baseBpm * playbackRate.
(function () {
  const MIN_BPM = 60;
  const MAX_BPM = 200;
  const ENVELOPE_RATE = 200;
  const MAX_ANALYSIS_SECONDS = 90;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function onsetEnvelope(audioBuffer) {
    const frameSize = Math.max(1, Math.round(audioBuffer.sampleRate / ENVELOPE_RATE));
    const frameCount = Math.min(Math.floor(audioBuffer.length / frameSize), ENVELOPE_RATE * MAX_ANALYSIS_SECONDS);
    if (frameCount < ENVELOPE_RATE * 4) throw new Error("Track is too short for reliable beat detection.");

    const channels = [];
    for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
      channels.push(audioBuffer.getChannelData(channel));
    }
    const energy = new Float32Array(frameCount);
    for (let frame = 0; frame < frameCount; frame++) {
      const start = frame * frameSize;
      const end = Math.min(audioBuffer.length, start + frameSize);
      let sum = 0;
      for (const samples of channels) {
        for (let index = start; index < end; index++) sum += samples[index] * samples[index];
      }
      energy[frame] = Math.sqrt(sum / Math.max(1, (end - start) * channels.length));
    }

    const onset = new Float32Array(frameCount);
    let average = energy[0] || 0;
    let maximum = 0;
    for (let index = 1; index < frameCount; index++) {
      average = average * 0.92 + energy[index] * 0.08;
      const rise = Math.max(0, energy[index] - average * 1.08);
      onset[index] = rise;
      maximum = Math.max(maximum, rise);
    }
    if (maximum < 1e-5) throw new Error("No clear beat found in this track.");
    for (let index = 0; index < onset.length; index++) onset[index] /= maximum;
    return onset;
  }

  function correlation(envelope, lag) {
    let product = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let index = lag; index < envelope.length; index++) {
      const left = envelope[index];
      const right = envelope[index - lag];
      product += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }
    return product / Math.sqrt(Math.max(1e-12, leftEnergy * rightEnergy));
  }

  function tolerantCorrelation(envelope, lag, cache) {
    let best = 0;
    for (let candidate = Math.max(1, lag - 1); candidate <= lag + 1; candidate++) {
      if (!cache.has(candidate)) cache.set(candidate, correlation(envelope, candidate));
      best = Math.max(best, cache.get(candidate));
    }
    return best;
  }

  function beatOffset(envelope, lag) {
    const phases = new Float64Array(lag);
    for (let index = 0; index < envelope.length; index++) {
      const strength = envelope[index];
      if (strength > 0.08) phases[index % lag] += strength * strength;
    }
    let bestPhase = 0;
    for (let phase = 1; phase < phases.length; phase++) {
      if (phases[phase] > phases[bestPhase]) bestPhase = phase;
    }
    return bestPhase / ENVELOPE_RATE;
  }

  // Resolves to { baseBpm, offset }. The 120 BPM prior only breaks harmonic
  // ties (e.g. 60 vs 120); correlation remains the dominant score.
  async function detect(audioBuffer) {
    if (!audioBuffer || !audioBuffer.length || !audioBuffer.sampleRate) throw new Error("No audio data was available for beat detection.");
    const envelope = onsetEnvelope(audioBuffer);
    const minLag = Math.floor(ENVELOPE_RATE * 60 / MAX_BPM);
    const maxLag = Math.ceil(ENVELOPE_RATE * 60 / MIN_BPM);
    const scores = new Float64Array(maxLag + 1);
    const correlationCache = new Map();
    let strongestScore = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      // A comb score rewards a candidate whose 2x and 3x intervals also line
      // up. The +/- one-frame tolerance handles tempos whose beat period is a
      // fractional number of 200 Hz envelope frames (notably 180 BPM).
      scores[lag] = tolerantCorrelation(envelope, lag, correlationCache)
        + tolerantCorrelation(envelope, lag * 2, correlationCache) * 0.5
        + tolerantCorrelation(envelope, lag * 3, correlationCache) * 0.25;
      strongestScore = Math.max(strongestScore, scores[lag]);
    }
    if (strongestScore < 0.08) throw new Error("No clear beat found in this track.");

    // A periodic pulse also correlates at 2x/3x its interval. Prefer the
    // shortest strong LOCAL peak (the actual pulse rate) instead of imposing
    // a 120 BPM prior, which incorrectly folded valid 165-195 BPM tracks down.
    let bestLag = 0;
    const strongPeak = strongestScore * 0.5;
    if (scores[minLag] >= strongPeak && scores[minLag] >= scores[minLag + 1]) bestLag = minLag;
    for (let lag = minLag + 1; !bestLag && lag < maxLag; lag++) {
      if (scores[lag] >= strongPeak && scores[lag] >= scores[lag - 1] && scores[lag] >= scores[lag + 1]) {
        bestLag = lag;
        break;
      }
    }
    if (!bestLag) {
      for (let lag = minLag; lag <= maxLag; lag++) {
        if (scores[lag] === strongestScore) { bestLag = lag; break; }
      }
    }

    const left = scores[Math.max(minLag, bestLag - 1)];
    const center = scores[bestLag];
    const right = scores[Math.min(maxLag, bestLag + 1)];
    const curve = left - 2 * center + right;
    const refinement = Math.abs(curve) > 1e-9 ? clamp(0.5 * (left - right) / curve, -0.5, 0.5) : 0;
    const refinedLag = bestLag + refinement;
    const bpm = ENVELOPE_RATE * 60 / refinedLag;
    return { baseBpm: Math.round(bpm * 10) / 10, offset: beatOffset(envelope, bestLag) };
  }

  // Calls visit(timeSeconds, kind) for every grid line between 0 and duration.
  // kind: "beat" | "bar" | "phrase8" | "phrase16" | "phrase32" (bars of 4 beats;
  // a 32-bar boundary is reported only as phrase32, not also as 16/8).
  // Beat k sits at offset + k * secondsPerBeat. k may be negative: the
  // detector's offset is the first confident beat, not always the first sound.
  function forEachGridLine(baseBpm, offset, duration, visit) {
    if (!(baseBpm > 0) || !(duration > 0)) return;
    const secondsPerBeat = 60 / baseBpm;
    const first = Math.ceil((0 - offset) / secondsPerBeat - 1e-6);
    const last = Math.floor((duration - offset) / secondsPerBeat + 1e-6);
    for (let k = first; k <= last; k++) {
      const phase = ((k % 128) + 128) % 128; // 32 bars = 128 beats
      let kind = "beat";
      if (phase === 0) kind = "phrase32";
      else if (phase % 64 === 0) kind = "phrase16";
      else if (phase % 32 === 0) kind = "phrase8";
      else if (phase % 4 === 0) kind = "bar";
      visit(offset + k * secondsPerBeat, kind);
    }
  }

  // Collects tap times and yields a BPM once there are at least 4 taps.
  // A pause over 2 seconds starts a fresh series. Tempi outside the plausible
  // range fold into it by doubling/halving (the same groove, counted anew).
  class TapTempo {
    constructor() { this.taps = []; }
    tap(nowMs) {
      const now = typeof nowMs === "number" ? nowMs : performance.now();
      if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) this.taps = [];
      this.taps.push(now);
      if (this.taps.length > 12) this.taps.shift();
      if (this.taps.length < 4) return { count: this.taps.length, bpm: null };
      let total = 0;
      for (let i = 1; i < this.taps.length; i++) total += this.taps[i] - this.taps[i - 1];
      let bpm = 60000 / (total / (this.taps.length - 1));
      while (bpm < MIN_BPM) bpm *= 2;
      while (bpm > MAX_BPM) bpm /= 2;
      return { count: this.taps.length, bpm: Math.round(bpm * 10) / 10 };
    }
    reset() { this.taps = []; }
  }

  window.FLX4BeatGrid = { detect, forEachGridLine, TapTempo, MIN_BPM, MAX_BPM };
})();
