const test = require('node:test');
const assert = require('node:assert/strict');

const {
  config,
  calculateAudioEnergy,
  shouldVoiceTrigger,
  createVoiceGate,
  speechBandRatio,
} = require('../src/audio-detection');

function tone(length, amplitude, step = 11) {
  const samples = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    samples[index] = Math.sin(index / step) * amplitude;
  }
  return samples;
}

function spectrum(speechDb, noiseDb) {
  const values = new Float32Array(256);
  values.fill(noiseDb);
  for (let index = 20; index < 80; index += 1) values[index] = speechDb;
  return values;
}

test('voice gate starts within a few frames and ends after a brief hangover', () => {
  assert.ok(config.startFrames <= 3, 'speech start should require only a couple of frames');
  assert.ok(config.endFrames <= 6, 'speech end hangover should stay under ~100ms at 60fps');
  assert.ok(config.previewIntervalMs <= 1000, 'live previews should be sent about once per second');
  assert.ok(config.maxSegmentMs <= 5000, 'final speech clips should stay short');

  const gate = createVoiceGate();
  const speech = tone(512, 0.08);
  const speechSpectrum = spectrum(-18, -70);
  const hush = new Float32Array(512);
  const hushSpectrum = spectrum(-90, -55);

  let started = false;
  for (let frame = 0; frame < 6; frame += 1) {
    if (gate.observe(speech, speechSpectrum, 48000).state === 'start') started = true;
  }
  assert.equal(started, true);

  let ended = false;
  for (let frame = 0; frame < 8; frame += 1) {
    if (gate.observe(hush, hushSpectrum, 48000).state === 'end') ended = true;
  }
  assert.equal(ended, true);
});

test('moderate human speech should trigger before the signal becomes strong enough to sound clipped', () => {
  const samples = tone(1024, 0.04, 11);
  for (let index = 0; index < samples.length; index += 1) {
    if (index % 17 === 0) samples[index] += 0.015;
  }

  const energy = calculateAudioEnergy(samples);
  assert.ok(energy.rms > 0.001, 'moderate voice should exceed a minimal RMS floor');
  assert.ok(energy.peak > 0.03, 'peak amplitude should reflect a detectable speaking voice');
  assert.equal(shouldVoiceTrigger(samples), true);
});

test('speech-band energy outranks low-frequency room rumble', () => {
  const speechHeavy = speechBandRatio(spectrum(-12, -80), 48000);
  const rumbleHeavy = speechBandRatio(spectrum(-80, -12), 48000);
  assert.ok(speechHeavy > rumbleHeavy);
  assert.ok(speechHeavy >= config.minSpeechRatio);
});
