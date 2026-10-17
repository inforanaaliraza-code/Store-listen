(function initializeVoiceDetection(globalScope) {
  const config = Object.freeze({
    // Real speech only. Room noise must not open the gate or become a fake line.
    minRms: 0.006,
    rmsThreshold: 0.009,
    peakThreshold: 0.028,
    snr: 2.2,
    minSpeechRatio: 0.2,
    minZcr: 0.008,
    maxZcr: 0.55,
    startFrames: 2,
    endFrames: 6,
    silenceHangoverMs: 380,
    // One whole phrase per final upload; words stream live while the person is still talking.
    maxSegmentMs: 7000,
    minClipMs: 500,
    // Real speech must last this long inside a clip, otherwise it was a door slam or a cough.
    minVoicedMs: 280,
    previewIntervalMs: 500,
    livePreviewEnabled: true,
  });

  function calculateAudioEnergy(samples) {
    if (!samples || !samples.length) {
      return { rms: 0, peak: 0, energy: 0 };
    }

    let sumSquares = 0;
    let peak = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      const magnitude = Math.abs(sample);
      sumSquares += sample * sample;
      if (magnitude > peak) peak = magnitude;
    }

    const rms = Math.sqrt(sumSquares / samples.length);
    return { rms, peak, energy: rms * rms };
  }

  function zeroCrossingRate(samples) {
    if (!samples || samples.length < 2) return 0;
    let crossings = 0;
    for (let index = 1; index < samples.length; index += 1) {
      if ((samples[index] >= 0) !== (samples[index - 1] >= 0)) crossings += 1;
    }
    return crossings / (samples.length - 1);
  }

  function speechBandRatio(frequencyDb, sampleRate) {
    if (!frequencyDb || !frequencyDb.length || !sampleRate) return 0.55;
    const binHz = sampleRate / (frequencyDb.length * 2);
    let speech = 0;
    let noise = 0;
    for (let index = 1; index < frequencyDb.length; index += 1) {
      const hz = index * binHz;
      const linear = 10 ** (Math.max(-120, frequencyDb[index]) / 20);
      if (hz <= 220) noise += linear;
      else if (hz >= 250 && hz <= 4200) speech += linear;
    }
    return speech / (speech + noise + 1e-9);
  }

  function isVoicedFrame(samples, frequencyDb, sampleRate, rmsFloor = config.minRms) {
    const { rms, peak } = calculateAudioEnergy(samples);
    const zcr = zeroCrossingRate(samples);
    const ratio = speechBandRatio(frequencyDb, sampleRate);
    const strongEnough = rms >= rmsFloor || peak >= config.peakThreshold;
    if (!strongEnough) return false;
    if (ratio < config.minSpeechRatio) return false;
    const rumble = ratio < 0.12 && zcr < 0.005 && peak < 0.04;
    return !rumble;
  }

  function shouldVoiceTrigger(samples, threshold = config.rmsThreshold, peakThreshold = config.peakThreshold) {
    const { rms, peak } = calculateAudioEnergy(samples);
    return rms >= threshold || peak >= peakThreshold;
  }

  function createVoiceGate() {
    let noiseRms = 0.0025;
    let speaking = false;
    let voiced = 0;
    let silent = 0;
    let silenceStartedAt = null;

    return {
      get speaking() {
        return speaking;
      },
      reset() {
        speaking = false;
        voiced = 0;
        silent = 0;
        silenceStartedAt = null;
      },
      observe(samples, frequencyDb, sampleRate, timestampMs = Date.now()) {
        const energy = calculateAudioEnergy(samples);
        const zcr = zeroCrossingRate(samples);
        const ratio = speechBandRatio(frequencyDb, sampleRate);
        if (!speaking) noiseRms = (noiseRms * 0.94) + (energy.rms * 0.06);
        const rmsFloor = Math.max(config.minRms, noiseRms * config.snr);
        // Loud noise alone is not speech: the frame must also have a speech-shaped spectrum.
        const voicedNow = isVoicedFrame(samples, frequencyDb, sampleRate, rmsFloor);
        if (voicedNow) {
          voiced += 1;
          silent = 0;
          silenceStartedAt = null;
          if (!speaking && voiced >= config.startFrames) {
            speaking = true;
            return { state: 'start', ...energy, zcr, ratio };
          }
          return { state: speaking ? 'speech' : 'rising', ...energy, zcr, ratio };
        }
        voiced = 0;
        if (speaking) {
          if (silenceStartedAt === null) silenceStartedAt = timestampMs;
          silent += 1;
          if (silent >= config.endFrames && timestampMs - silenceStartedAt >= config.silenceHangoverMs) {
            speaking = false;
            silenceStartedAt = null;
            return { state: 'end', ...energy, zcr, ratio };
          }
          return { state: 'hangover', ...energy, zcr, ratio };
        }
        return { state: 'idle', ...energy, zcr, ratio };
      },
    };
  }

  function createPreviewThrottle(intervalMs = config.previewIntervalMs) {
    let lastPreviewAt = 0;
    let hasSent = false;
    return {
      reset() {
        lastPreviewAt = 0;
        hasSent = false;
      },
      shouldSend(nowMs = Date.now()) {
        if (!hasSent) {
          lastPreviewAt = nowMs;
          hasSent = true;
          return true;
        }
        const allowedAt = lastPreviewAt + Math.max(120, intervalMs);
        if (nowMs < allowedAt) return false;
        lastPreviewAt = nowMs;
        return true;
      },
    };
  }

  const api = {
    config,
    calculateAudioEnergy,
    shouldVoiceTrigger,
    createVoiceGate,
    createPreviewThrottle,
    speechBandRatio,
    zeroCrossingRate,
    isVoicedFrame,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  globalScope.StoreListenAudioDetection = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
