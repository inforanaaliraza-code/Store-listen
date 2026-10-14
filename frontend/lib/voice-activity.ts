export const voiceActivityConfig = {
  minRms: 0.0007,
  peakThreshold: 0.016,
  snr: 1.8,
  minSpeechRatio: 0.34,
  minZcr: 0.012,
  maxZcr: 0.42,
  startFrames: 2,
  endFrames: 5,
  maxSegmentMs: 5000,
  minClipMs: 240,
  previewIntervalMs: 900,
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
  let noiseRms = 0.0024;
  let speaking = false;
  let voiced = 0;
  let silent = 0;

  return {
    get speaking() {
      return speaking;
    },
    reset() {
      speaking = false;
      voiced = 0;
      silent = 0;
    },
    observe(samples: Float32Array, frequencyDb: Float32Array, sampleRate: number) {
      const energy = calculateAudioEnergy(samples);
      const zcr = zeroCrossingRate(samples);
      const ratio = speechBandRatio(frequencyDb, sampleRate);
      if (!speaking) noiseRms = (noiseRms * 0.9) + (energy.rms * 0.1);
      const rmsFloor = Math.max(voiceActivityConfig.minRms, noiseRms * voiceActivityConfig.snr);
      const strongEnough = energy.rms >= rmsFloor || energy.peak >= voiceActivityConfig.peakThreshold;
      const speechLike = ratio >= voiceActivityConfig.minSpeechRatio
        || (zcr >= voiceActivityConfig.minZcr && zcr <= voiceActivityConfig.maxZcr);
      const voicedNow = strongEnough && speechLike;
      if (voicedNow) {
        voiced += 1;
        silent = 0;
        if (!speaking && voiced >= voiceActivityConfig.startFrames) {
          speaking = true;
          return 'start' as const;
        }
        return speaking ? 'speech' : 'rising';
      }
      voiced = 0;
      if (speaking) {
        silent += 1;
        if (silent >= voiceActivityConfig.endFrames) {
          speaking = false;
          return 'end' as const;
        }
        return 'hangover' as const;
      }
      return 'idle' as const;
    },
  };
}
