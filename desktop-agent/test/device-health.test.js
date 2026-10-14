const test = require('node:test');
const assert = require('node:assert/strict');
const { createPayload } = require('../src/device-health');

test('health payload omits speaking for older strict backends', () => {
  const payload = createPayload({ cpu_pct: 12, memory_pct: 44 }, true, true, false);

  assert.deepEqual(payload, {
    cpu_pct: 12,
    memory_pct: 44,
    audio_status: 'streaming',
    microphone_status: 'ok',
    stream_status: 'live',
    processing_latency_ms: 0,
  });
});

test('health payload includes speaking when supported by the backend', () => {
  const payload = createPayload({ cpu_pct: 12, memory_pct: 44 }, true, true, true);

  assert.equal(payload.speaking, true);
});