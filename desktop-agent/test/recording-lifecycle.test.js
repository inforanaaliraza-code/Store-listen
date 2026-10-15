const assert = require('node:assert/strict');
const test = require('node:test');
const { stopCaptureAndDrain } = require('../src/recording-lifecycle');

test('stops the microphone before waiting for queued transcription uploads', async () => {
  const events = [];
  let stopListener;
  let finishUpload;
  let finalized = false;
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

  const stopping = stopCaptureAndDrain(capture, () => events.push('UI acknowledged stop')).then(() => { finalized = true; });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, [
    'final recorder chunk',
    'microphone released',
    'audio context closed',
    'UI acknowledged stop',
  ]);
  assert.equal(capture.stream, null);
  assert.equal(finalized, false);

  finishUpload();
  await stopping;
  assert.equal(finalized, true);
});