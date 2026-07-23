"use strict";

// A deliberately small two-deck Web Audio mixer. It uses user-selected local
// files only: nothing is uploaded, streamed, or stored by the application.
// The rest of the app talks to this engine through flx4controlchange events.
(function () {
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  const MAX_TRACK_SECONDS = 10 * 60;
  const METADATA_TIMEOUT_MS = 8000;

  class FLX4AudioEngine {
    constructor({ onStatus } = {}) {
      this.onStatus = onStatus || (() => {});
      this.context = null;
      this.masterGain = null;
      this.compressor = null;
      this.crossfader = 64;
      this.decks = { A: null, B: null };
      this.ready = false;
    }

    ensureContext() {
      if (this.context) return this.context;
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("This browser does not support Web Audio.");

      this.context = new AudioContextClass();
      this.masterGain = this.context.createGain();
      this.masterGain.gain.value = 0.86;
      this.compressor = this.context.createDynamicsCompressor();
      this.compressor.threshold.value = -9;
      this.compressor.knee.value = 16;
      this.compressor.ratio.value = 5;
      this.compressor.attack.value = 0.004;
      this.compressor.release.value = 0.16;
      this.masterGain.connect(this.compressor).connect(this.context.destination);
      this.decks.A = this.createDeck("A");
      this.decks.B = this.createDeck("B");
      this.setChannelGain("A", 64);
      this.setChannelGain("B", 64);
      this.setCrossfader(64);
      this.ready = true;
      this.onStatus("Audio armed. Load a song, then press PLAY.", "ready");
      return this.context;
    }

    createDeck(id) {
      const audio = new Audio();
      audio.preload = "metadata";
      audio.crossOrigin = "anonymous";
      audio.preservesPitch = false;
      audio.mozPreservesPitch = false;
      audio.webkitPreservesPitch = false;

      const source = this.context.createMediaElementSource(audio);
      const high = this.context.createBiquadFilter();
      high.type = "highshelf";
      high.frequency.value = 4000;
      const mid = this.context.createBiquadFilter();
      mid.type = "peaking";
      mid.frequency.value = 1050;
      mid.Q.value = 0.8;
      const low = this.context.createBiquadFilter();
      low.type = "lowshelf";
      low.frequency.value = 230;
      // Color FX (the CFX knob). One filter per deck, sitting after the EQ and
      // before the channel fader — the same place the hardware puts it. Centred
      // it is transparent; see setColorFx for the sweep.
      const colorFx = this.context.createBiquadFilter();
      colorFx.type = "lowpass";
      colorFx.frequency.value = 22050;
      colorFx.Q.value = 0.9;
      const channelGain = this.context.createGain();
      const crossGain = this.context.createGain();
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.76;

      source.connect(high).connect(mid).connect(low).connect(colorFx).connect(channelGain).connect(crossGain).connect(analyser).connect(this.masterGain);
      const deck = {
        id, audio, high, mid, low, colorFx, channelGain, crossGain, analyser,
        fileUrl: null, duration: 0, cuePoint: 0, cueHeld: false, tempo: 64, loaded: false,
        transportGeneration: 0, transportIntent: "paused",
        // Every requested load gets a generation. A slower, older decode can
        // finish later, but it is never allowed to replace the newest track.
        loadGeneration: 0,
        // Analysis data. buffer is the decoded track; baseBpm/beatOffset are
        // filled in by the beat detector (or tap tempo) after a load.
        buffer: null, baseBpm: null, beatOffset: 0
      };
      audio.addEventListener("ended", () => {
        deck.transportGeneration++;
        deck.transportIntent = "paused";
        this.dispatch("ended", { deckId: id });
      });
      return deck;
    }

    async loadFile(deckId, file) {
      const context = this.ensureContext();
      const deck = this.decks[deckId];
      if (!deck) throw new Error("Unknown deck: " + deckId);
      if (!file || !file.type.startsWith("audio/")) throw new Error("Choose an audio file such as MP3, WAV, or M4A.");
      if (!Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_FILE_BYTES) {
        throw new Error("Choose an audio file smaller than 50 MB.");
      }

      const generation = ++deck.loadGeneration;
      const candidateUrl = URL.createObjectURL(file);
      const metadataProbe = new Audio();
      metadataProbe.preload = "metadata";
      metadataProbe.src = candidateUrl;
      let committed = false;

      try {
        // Read cheap media metadata before allocating a full decoded PCM
        // buffer. This rejects unusually long or stalled files before the
        // browser can commit hundreds of megabytes to beat analysis.
        const metadata = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("This audio file took too long to inspect.")), METADATA_TIMEOUT_MS);
          metadataProbe.addEventListener("loadedmetadata", () => {
            clearTimeout(timeout);
            resolve({ duration: metadataProbe.duration });
          }, { once: true });
          metadataProbe.addEventListener("error", () => {
            clearTimeout(timeout);
            reject(new Error("This audio file could not be decoded by the browser."));
          }, { once: true });
          metadataProbe.load();
        });

        if (!Number.isFinite(metadata.duration) || metadata.duration <= 0 || metadata.duration > MAX_TRACK_SECONDS) {
          throw new Error("Choose a track that is 10 minutes or shorter.");
        }
        if (generation !== deck.loadGeneration) {
          throw new DOMException("A newer track was selected for this deck.", "AbortError");
        }
        const arrayBuffer = await file.arrayBuffer();
        const buffer = await context.decodeAudioData(arrayBuffer);

        if (generation !== deck.loadGeneration) {
          throw new DOMException("A newer track was selected for this deck.", "AbortError");
        }

        const previousUrl = deck.fileUrl;
        deck.audio.pause();
        deck.transportGeneration++;
        deck.transportIntent = "paused";
        deck.fileUrl = candidateUrl;
        deck.audio.src = candidateUrl;
        deck.audio.load();
        deck.cuePoint = 0;
        deck.cueHeld = false;
        deck.loaded = true;
        deck.duration = metadata.duration;
        // Keep the decoded buffer so it can be analyzed later (beat detection).
        // Playback still goes through the <audio> element above, not this buffer.
        deck.buffer = buffer;
        deck.baseBpm = null;
        deck.beatOffset = 0;
        committed = true;
        if (previousUrl) URL.revokeObjectURL(previousUrl);

        const result = { deckId, fileName: file.name, duration: deck.duration, peaks: this.createPeaks(buffer, 180) };
        this.dispatch("loaded", result);
        this.onStatus("Loaded " + file.name + " on Deck " + deckId + ".", "ready");
        return result;
      } finally {
        metadataProbe.removeAttribute("src");
        metadataProbe.load();
        if (!committed) URL.revokeObjectURL(candidateUrl);
      }
    }

    cancelLoad(deckId) {
      const deck = this.decks[deckId];
      if (deck) deck.loadGeneration++;
    }

    createPeaks(buffer, count) {
      const data = buffer.getChannelData(0);
      const block = Math.max(1, Math.floor(data.length / count));
      const stride = Math.max(1, Math.floor(data.length / (count * 2500)));
      const peaks = [];
      for (let index = 0; index < count; index++) {
        let peak = 0;
        const start = index * block;
        const end = Math.min(data.length, start + block);
        for (let sample = start; sample < end; sample += stride) peak = Math.max(peak, Math.abs(data[sample]));
        peaks.push(peak);
      }
      return peaks;
    }

    async play(deckId, intent = "normal") {
      const deck = this.decks[deckId];
      if (!deck?.loaded) {
        this.onStatus("Load a song on Deck " + deckId + " before pressing PLAY.", "error");
        return false;
      }
      const operation = ++deck.transportGeneration;
      deck.transportIntent = intent;
      if (intent === "normal") deck.cueHeld = false;
      try {
        await this.context.resume();
        if (operation !== deck.transportGeneration) return false;
        await deck.audio.play();
        if (operation !== deck.transportGeneration) {
          if (deck.transportIntent === "paused") deck.audio.pause();
          return false;
        }
        if (intent === "normal") this.onStatus("Deck " + deckId + " playing.", "playing");
        return true;
      } catch (error) {
        if (operation !== deck.transportGeneration) return false;
        deck.transportIntent = "paused";
        this.onStatus("Browser blocked playback. Press PLAY again to allow audio.", "error");
        this.dispatch("playerror", { deckId, message: error?.message || "Playback was blocked." });
        return false;
      }
    }

    pause(deckId) {
      const deck = this.decks[deckId];
      if (!deck) return;
      deck.transportGeneration++;
      deck.transportIntent = "paused";
      deck.audio.pause();
      this.onStatus("Deck " + deckId + " paused.", "ready");
    }

    async pressCue(deckId) {
      const deck = this.decks[deckId];
      if (!deck?.loaded) return false;
      if (!deck.audio.paused || deck.transportIntent === "normal") {
        deck.transportGeneration++;
        deck.transportIntent = "paused";
        deck.audio.pause();
        deck.audio.currentTime = deck.cuePoint;
        deck.cueHeld = false;
        this.dispatch("cuereturn", { deckId });
        this.onStatus("Deck " + deckId + " returned to cue.", "ready");
        return true;
      }

      deck.cuePoint = deck.audio.currentTime;
      deck.cueHeld = true;
      const playPromise = this.play(deckId, "cue");
      const cueOperation = deck.transportGeneration;
      const playing = await playPromise;
      if (cueOperation !== deck.transportGeneration) return false;
      if (!playing) {
        deck.cueHeld = false;
        return false;
      }
      // A short simulator press can release while play() is still resolving.
      // Honour that release instead of leaving a late preview running.
      if (!deck.cueHeld || deck.transportIntent !== "cue") return false;
      this.onStatus("Deck " + deckId + " cue preview. Release CUE to return.", "playing");
      return playing;
    }

    releaseCue(deckId) {
      const deck = this.decks[deckId];
      if (!deck?.loaded || deck.transportIntent !== "cue") return;
      deck.transportGeneration++;
      deck.transportIntent = "paused";
      deck.audio.pause();
      deck.audio.currentTime = deck.cuePoint;
      deck.cueHeld = false;
      this.onStatus("Deck " + deckId + " returned to cue.", "ready");
    }

    setTempo(deckId, midiValue) {
      const deck = this.decks[deckId];
      if (!deck) return;
      deck.tempo = clamp(midiValue, 0, 127);
      // +/- 8% around centre. This is intentionally vinyl tempo for v1.
      deck.audio.playbackRate = 1 + ((deck.tempo - 64) / 63) * 0.08;
    }

    // The FLX4's EQ range is printed on the deck itself: -26 dB to +6 dB, with
    // the detented centre at 0. It is deliberately asymmetric -- a mixer EQ
    // exists to take frequencies AWAY, and a symmetric +/-12 dB would make a
    // bass swap (lesson 12) impossible to hear correctly: the outgoing low end
    // has to effectively disappear, not merely dip, or both tracks' bass fight
    // and the learner hears mud where the whole point is a clean exchange.
    setEq(deckId, band, midiValue) {
      const deck = this.decks[deckId];
      if (!deck) return;
      const value = clamp(midiValue, 0, 127);
      const decibels = value >= 64
        ? ((value - 64) / 63) * 6
        : ((value - 64) / 64) * 26;
      deck[band].gain.setTargetAtTime(decibels, this.context.currentTime, 0.012);
    }

    // The CFX knob, printed LOW <-> HI on the deck with a detented centre.
    // Turn left and a low-pass closes down over the track; turn right and a
    // high-pass opens up under it. Centre is transparent, which is why the
    // physical knob has a detent there.
    //
    // Both directions share one biquad. The type only ever flips while the
    // knob is inside the centre dead zone, where both curves are already out
    // of the audible band, so the switch is never heard. Frequency moves
    // exponentially because pitch is perceived that way -- a linear sweep
    // spends most of its travel doing nothing audible up top.
    setColorFx(deckId, midiValue) {
      const deck = this.decks[deckId];
      if (!deck) return;
      const value = clamp(midiValue, 0, 127);
      const ceiling = Math.min(20000, this.context.sampleRate / 2 - 1000);
      const time = this.context.currentTime;
      deck.colorFx.Q.setTargetAtTime(0.9, time, 0.01);

      // A detent is mechanical, not electrical: real knobs do not land on
      // exactly 64, so treat a small band around centre as fully open.
      if (Math.abs(value - 64) <= 4) {
        deck.colorFx.type = "lowpass";
        deck.colorFx.frequency.setTargetAtTime(ceiling, time, 0.012);
        return;
      }

      if (value < 64) {
        const depth = (60 - value) / 60; // 0 at the dead zone edge, 1 hard left
        deck.colorFx.type = "lowpass";
        deck.colorFx.frequency.setTargetAtTime(ceiling * Math.pow(120 / ceiling, depth), time, 0.012);
        return;
      }

      const depth = (value - 68) / 59; // 0 at the dead zone edge, 1 hard right
      deck.colorFx.type = "highpass";
      deck.colorFx.frequency.setTargetAtTime(20 * Math.pow(9000 / 20, depth), time, 0.012);
    }

    setChannelGain(deckId, midiValue) {
      const deck = this.decks[deckId];
      if (!deck) return;
      // A curved response gives useful detail near the bottom of the fader.
      const gain = Math.pow(clamp(midiValue, 0, 127) / 127, 1.7);
      deck.channelGain.gain.setTargetAtTime(gain, this.context.currentTime, 0.008);
    }

    setCrossfader(midiValue) {
      this.crossfader = clamp(midiValue, 0, 127);
      if (!this.context) return;
      const position = this.crossfader / 127;
      // Equal-power curve avoids a volume dip in the centre.
      this.decks.A.crossGain.gain.setTargetAtTime(Math.cos(position * Math.PI / 2), this.context.currentTime, 0.008);
      this.decks.B.crossGain.gain.setTargetAtTime(Math.sin(position * Math.PI / 2), this.context.currentTime, 0.008);
    }

    setMasterGain(value) {
      this.ensureContext();
      this.masterGain.gain.setTargetAtTime(clamp(value, 0, 1), this.context.currentTime, 0.015);
    }

    // Beat info comes from the UI layer (detector or tap tempo). It is kept on
    // the deck so anything with engine access can read it next to the buffer.
    setBeatInfo(deckId, baseBpm, offset) {
      const deck = this.decks[deckId];
      if (!deck) return;
      deck.baseBpm = baseBpm || null;
      deck.beatOffset = offset || 0;
    }

    // The BPM the listener hears is baseBpm * playbackRate.
    getPlaybackRate(deckId) {
      return this.decks[deckId]?.audio.playbackRate || 1;
    }

    // Jump the playhead to a track-time position (seconds). Used by timing
    // lessons to re-arm an attempt at a fixed lead-in before a phrase line.
    seek(deckId, seconds) {
      const deck = this.decks[deckId];
      if (!deck?.loaded) return;
      const max = deck.duration || deck.audio.duration || seconds;
      deck.audio.currentTime = clamp(seconds, 0, max);
    }

    applyControl(controlId, state) {
      if (!this.ready) return;
      const value = state.value;
      if (controlId === "deck1-play") state.active ? this.play("A") : this.pause("A");
      if (controlId === "deck2-play") state.active ? this.play("B") : this.pause("B");
      if (controlId === "deck1-cue") state.active ? this.pressCue("A") : this.releaseCue("A");
      if (controlId === "deck2-cue") state.active ? this.pressCue("B") : this.releaseCue("B");
      if (controlId === "tempo-left") this.setTempo("A", value);
      if (controlId === "tempo-right") this.setTempo("B", value);
      if (controlId === "eq1-high") this.setEq("A", "high", value);
      if (controlId === "eq1-mid") this.setEq("A", "mid", value);
      if (controlId === "eq1-low") this.setEq("A", "low", value);
      if (controlId === "eq2-high") this.setEq("B", "high", value);
      if (controlId === "eq2-mid") this.setEq("B", "mid", value);
      if (controlId === "eq2-low") this.setEq("B", "low", value);
      if (controlId === "channel1-fader") this.setChannelGain("A", value);
      if (controlId === "channel2-fader") this.setChannelGain("B", value);
      if (controlId === "crossfader") this.setCrossfader(value);
    }

    getLevel(deckId) {
      const deck = this.decks[deckId];
      if (!deck?.loaded) return 0;
      const samples = new Uint8Array(deck.analyser.fftSize);
      deck.analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        const normal = (sample - 128) / 128;
        sum += normal * normal;
      }
      return clamp(Math.sqrt(sum / samples.length) * 3.4, 0, 1);
    }

    getProgress(deckId) {
      const deck = this.decks[deckId];
      if (!deck?.loaded || !deck.duration) return 0;
      return clamp(deck.audio.currentTime / deck.duration, 0, 1);
    }

    getTime(deckId) {
      const deck = this.decks[deckId];
      return { current: deck?.audio.currentTime || 0, duration: deck?.duration || 0 };
    }

    getDeckState(deckId) {
      const deck = this.decks[deckId];
      if (!deck) return null;
      return {
        loaded: deck.loaded,
        paused: deck.audio.paused,
        currentTime: deck.audio.currentTime,
        cuePoint: deck.cuePoint,
        cueHeld: deck.cueHeld,
        transportIntent: deck.transportIntent,
        playbackRate: deck.audio.playbackRate
      };
    }

    dispatch(type, detail) {
      window.dispatchEvent(new CustomEvent("flx4audio", { detail: { type, ...detail } }));
    }
  }

  window.FLX4AudioEngine = FLX4AudioEngine;
  window.FLX4AudioEngine.MAX_FILE_BYTES = MAX_FILE_BYTES;
  window.FLX4AudioEngine.MAX_TRACK_SECONDS = MAX_TRACK_SECONDS;
})();
