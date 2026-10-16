const test = require('node:test');
const assert = require('node:assert/strict');

const {
  config,
  calculateAudioEnergy,
  shouldVoiceTrigger,
  createVoiceGate,
  createPreviewThrottle,
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
  assert.ok(config.startFrames <= 2, 'speech start should require at most two frames');
  assert.ok(config.endFrames <= 5, 'a few silent frames should be enough once the timed hangover expires');
  assert.ok(config.silenceHangoverMs <= 320, 'silence hangover should stay under ~320ms for fast finals');
  assert.equal(config.livePreviewEnabled, false, 'live Whisper previews must stay off so finals own the CPU');
  assert.ok(config.maxSegmentMs <= 1600, 'final speech clips should be finalized quickly');

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
  for (let frame = 0; frame < 12; frame += 1) {
    const result = gate.observe(hush, hushSpectrum, 48000, frame * (1000 / 60));
    if (result.state === 'end') ended = true;
  }
  assert.equal(ended, false, 'short pauses should not end a spoken phrase');
  for (let frame = 12; frame < 45; frame += 1) {
    if (gate.observe(hush, hushSpectrum, 48000, frame * (1000 / 60)).state === 'end') ended = true;
  }
  assert.equal(ended, true);
});

test('quiet store-counter speech still opens the voice gate', () => {
  const gate = createVoiceGate();
  const quiet = tone(512, 0.02, 13);
  const mixed = spectrum(-28, -60);
  let started = false;
  for (let frame = 0; frame < 8; frame += 1) {
    if (gate.observe(quiet, mixed, 48000).state === 'start') started = true;
  }
  assert.equal(started, true);
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

test('preview throttling sends a live transcript probe no more than once per configured interval', () => {
  const throttle = createPreviewThrottle(900);
  assert.equal(throttle.shouldSend(0), true, 'the first preview should be allowed immediately');
  assert.equal(throttle.shouldSend(100), false, 'preview probes must be throttled before the next interval');
  assert.equal(throttle.shouldSend(900), true, 'the next preview is allowed once the interval has elapsed');
});

test('speech-band energy outranks low-frequency room rumble', () => {
  const speechHeavy = speechBandRatio(spectrum(-12, -80), 48000);
  const rumbleHeavy = speechBandRatio(spectrum(-80, -12), 48000);
  assert.ok(speechHeavy > rumbleHeavy);
  assert.ok(speechHeavy > 0.5, 'speech-band energy should dominate a voiced spectrum');
});
