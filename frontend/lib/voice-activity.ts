export const voiceActivityConfig = {
  minRms: 0.01,
  peakThreshold: 0.05,
  snr: 2.1,
  minSpeechRatio: 0.32,
  minZcr: 0.012,
  maxZcr: 0.4,
  startFrames: 4,
  endFrames: 9,
  silenceHangoverMs: 580,
  maxSegmentMs: 4800,
  minClipMs: 900,
  previewIntervalMs: 4500,
  livePreviewEnabled: false,
} as const;

export function calculateAudioEnergy(samples: Float32Array) {
  let sumSquares = 0;
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const magnitude = Math.abs(samples[index]);
    sumSquares += samples[index] * samples[index];
    if (magnitude > peak) peak = magnitude;
  }
  const rms = samples.length ? Math.sqrt(sumSquares / samples.length) : 0;
  return { rms, peak };
}

export function zeroCrossingRate(samples: Float32Array) {
  if (samples.length < 2) return 0;
  let crossings = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if ((samples[index] >= 0) !== (samples[index - 1] >= 0)) crossings += 1;
  }
  return crossings / (samples.length - 1);
}

export function speechBandRatio(frequencyDb: Float32Array, sampleRate: number) {
  if (!frequencyDb.length || !sampleRate) return 0.55;
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

export function createVoiceGate() {
  let noiseRms = 0.004;
  let speaking = false;
  let voiced = 0;
  let silent = 0;
  let silenceStartedAt: number | null = null;

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
    observe(samples: Float32Array, frequencyDb: Float32Array, sampleRate: number, timestampMs = Date.now()) {
      const energy = calculateAudioEnergy(samples);
      const zcr = zeroCrossingRate(samples);
      const ratio = speechBandRatio(frequencyDb, sampleRate);
      if (!speaking) noiseRms = (noiseRms * 0.92) + (energy.rms * 0.08);
      const rmsFloor = Math.max(voiceActivityConfig.minRms, noiseRms * voiceActivityConfig.snr);
      const strongEnough = energy.rms >= rmsFloor || energy.peak >= voiceActivityConfig.peakThreshold;
      const rumble = ratio < 0.15 && zcr < 0.006 && energy.peak < 0.05;
      const voicedNow = strongEnough && ratio >= voiceActivityConfig.minSpeechRatio && !rumble;
      if (voicedNow) {
        voiced += 1;
        silent = 0;
        silenceStartedAt = null;
        if (!speaking && voiced >= voiceActivityConfig.startFrames) {
          speaking = true;
          return 'start' as const;
        }
        return speaking ? 'speech' as const : 'rising' as const;
      }
      voiced = 0;
      if (speaking) {
        if (silenceStartedAt === null) silenceStartedAt = timestampMs;
        silent += 1;
        if (silent >= voiceActivityConfig.endFrames && timestampMs - silenceStartedAt >= voiceActivityConfig.silenceHangoverMs) {
          speaking = false;
          silenceStartedAt = null;
          return 'end' as const;
        }
        return 'hangover' as const;
      }
      return 'idle' as const;
    },
  };
}
