const assert = require('node:assert/strict');
const test = require('node:test');
const { stopCaptureAndDrain } = require('../src/recording-lifecycle');

test('stops the microphone immediately without waiting for queued transcription uploads', async () => {
  const events = [];
  let stopListener;
  let finishUpload;
  const uploadQueue = new Promise((resolve) => { finishUpload = resolve; });
  const capture = {
    recorder: {
      state: 'recording',
      onstop: () => events.push('final recorder chunk'),
      addEventListener: (_name, listener) => { stopListener = listener; },
      stop() {
        this.state = 'inactive';
        this.onstop();
        stopListener();
      },
    },
    stream: { getTracks: () => [{ stop: () => events.push('microphone released') }] },
    audioContext: { state: 'running', close: async () => { events.push('audio context closed'); } },
    uploadQueue,
  };

  await stopCaptureAndDrain(capture, () => events.push('UI acknowledged stop'), { maxUploadWaitMs: 0 });

  assert.deepEqual(events, [
    'final recorder chunk',
    'microphone released',
    'audio context closed',
    'UI acknowledged stop',
  ]);
  assert.equal(capture.stream, null);
  // Upload may still be pending — stop must not depend on it.
  finishUpload();
});

test('optional short upload wait races the queue against a deadline', async () => {
  const capture = {
    recorder: { state: 'inactive' },
    stream: { getTracks: () => [] },
    audioContext: { state: 'closed' },
    uploadQueue: new Promise(() => {}),
  };
  const started = Date.now();
  await stopCaptureAndDrain(capture, null, { maxUploadWaitMs: 40 });
  assert.ok(Date.now() - started < 250, 'upload wait must not hang Stop');
});

test('releases the microphone before waiting for final recording uploads', async () => {
  const events = [];
  let finishUpload;
  const capture = {
    recorder: { state: 'inactive' },
    stream: { getTracks: () => [{ stop: () => events.push('microphone released') }] },
    audioContext: { state: 'closed' },
    uploadQueue: new Promise((resolve) => { finishUpload = resolve; }),
  };

  const stopping = stopCaptureAndDrain(capture, null, { maxUploadWaitMs: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['microphone released']);
  finishUpload();
  await stopping;
  assert.equal(capture.stream, null);
});
