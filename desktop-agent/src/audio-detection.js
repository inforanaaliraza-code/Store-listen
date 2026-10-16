(function initializeVoiceDetection(globalScope) {
  const config = Object.freeze({
    minRms: 0.00035,
    rmsThreshold: 0.00035,
    peakThreshold: 0.01,
    snr: 1.25,
    minSpeechRatio: 0.22,
    minZcr: 0.012,
    maxZcr: 0.42,
    startFrames: 1,
    endFrames: 4,
    silenceHangoverMs: 280,
    maxSegmentMs: 1400,
    minClipMs: 200,
    previewIntervalMs: 4500,
    livePreviewEnabled: false,
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
      else if (hz >= 280 && hz <= 3800) speech += linear;
    }
    return speech / (speech + noise + 1e-9);
  }

  function isVoicedFrame(samples, frequencyDb, sampleRate, rmsFloor = config.minRms) {
    const { rms, peak } = calculateAudioEnergy(samples);
    const zcr = zeroCrossingRate(samples);
    const ratio = speechBandRatio(frequencyDb, sampleRate);
    const strongEnough = rms >= rmsFloor || peak >= config.peakThreshold;
    if (!strongEnough) return false;
    const rumble = ratio < 0.15 && zcr < 0.006 && peak < 0.05;
    return !rumble;
  }

  function shouldVoiceTrigger(samples, threshold = config.rmsThreshold, peakThreshold = config.peakThreshold) {
    const { rms, peak } = calculateAudioEnergy(samples);
    return rms >= threshold || peak >= peakThreshold;
  }

  function createVoiceGate() {
    let noiseRms = 0.0008;
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
        if (!speaking) noiseRms = (noiseRms * 0.9) + (energy.rms * 0.1);
        const rmsFloor = Math.max(config.minRms, noiseRms * config.snr);
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
        const allowedAt = lastPreviewAt + Math.max(250, intervalMs);
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
