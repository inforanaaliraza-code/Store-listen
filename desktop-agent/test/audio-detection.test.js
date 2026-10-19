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

test('voice gate opens quickly and streams short live clips', () => {
  assert.ok(config.startFrames <= 2, 'open the gate within two voiced frames');
  assert.ok(config.endFrames <= 6, 'end the phrase after a short pause');
  assert.ok(config.silenceHangoverMs <= 450, 'do not hold a finished phrase');
  assert.equal(config.livePreviewEnabled, true, 'words stream live while the person is still speaking');
  assert.ok(config.previewIntervalMs <= 1100, 'live preview requests are throttled to protect transcription latency');
  assert.ok(config.maxSegmentMs <= 5000 && config.maxSegmentMs >= 3000, 'final audio chunks are capped at five seconds');
  assert.ok(config.minClipMs >= 400 && config.minClipMs <= 700, 'skip noise blips, keep real words');
  assert.ok(config.minVoicedMs >= 200 && config.minVoicedMs <= 400, 'a clip needs real voiced time before it is uploaded');
  assert.ok(config.minRms <= 0.008, 'soft store speech must still open the gate');

  const gate = createVoiceGate();
  const speech = tone(512, 0.1);
  const speechSpectrum = spectrum(-18, -70);
  const hush = new Float32Array(512);
  const hushSpectrum = spectrum(-90, -55);

  let started = false;
  for (let frame = 0; frame < 10; frame += 1) {
    if (gate.observe(speech, speechSpectrum, 48000).state === 'start') started = true;
  }
  assert.equal(started, true);

  let ended = false;
  for (let frame = 0; frame < 8; frame += 1) {
    const result = gate.observe(hush, hushSpectrum, 48000, frame * (1000 / 60));
    if (result.state === 'end') ended = true;
  }
  assert.equal(ended, false, 'very short pauses should not end a spoken phrase');
  for (let frame = 8; frame < 40; frame += 1) {
    if (gate.observe(hush, hushSpectrum, 48000, frame * (1000 / 60)).state === 'end') ended = true;
  }
  assert.equal(ended, true, 'a brief silence hangover should finalize the live clip');
});

test('quiet but real store-counter speech still opens the voice gate', () => {
  const gate = createVoiceGate();
  const quiet = tone(512, 0.045, 13);
  const mixed = spectrum(-22, -60);
  let started = false;
  for (let frame = 0; frame < 14; frame += 1) {
    if (gate.observe(quiet, mixed, 48000).state === 'start') started = true;
  }
  assert.equal(started, true);
});

test('loud room noise without a speech-shaped spectrum never opens the gate', () => {
  const gate = createVoiceGate();
  const noise = tone(512, 0.12, 400);
  // Real HVAC rumble: all energy under 220 Hz (FFT bins 1-2 at 48 kHz), silence everywhere else.
  const rumble = new Float32Array(256).fill(-100);
  rumble[1] = -8;
  rumble[2] = -8;
  let started = false;
  for (let frame = 0; frame < 60; frame += 1) {
    if (gate.observe(noise, rumble, 48000, frame * 16).state === 'start') started = true;
  }
  assert.equal(started, false);
});

test('a two frame click is not a spoken phrase', () => {
  const gate = createVoiceGate();
  const speech = tone(512, 0.1);
  const speechSpectrum = spectrum(-18, -70);
  const hush = new Float32Array(512);
  const hushSpectrum = spectrum(-90, -55);
  const states = [];
  states.push(gate.observe(speech, speechSpectrum, 48000, 0).state);
  states.push(gate.observe(hush, hushSpectrum, 48000, 16).state);
  for (let frame = 2; frame < 20; frame += 1) states.push(gate.observe(hush, hushSpectrum, 48000, frame * 16).state);
  assert.equal(states.includes('start'), false);
  assert.equal(states.at(-1), 'idle');
});

test('moderate human speech should trigger the energy gate', () => {
  const samples = tone(1024, 0.06, 11);
  for (let index = 0; index < samples.length; index += 1) {
    if (index % 17 === 0) samples[index] += 0.02;
  }

  const energy = calculateAudioEnergy(samples);
  assert.ok(energy.rms > 0.01, 'moderate voice should exceed the store RMS floor');
  assert.ok(energy.peak > 0.05, 'peak amplitude should reflect a detectable speaking voice');
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
