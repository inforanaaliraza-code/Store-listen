import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { openDeepgramStream } from '../src/deepgram-stream.js';

test('opens multilingual Nova-3 stream and forwards final/interim results', async () => {
  const calls = { connect: [], audio: [], closeStream: [], close: 0 };
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.connect = () => { calls.connected = true; };
  socket.waitForOpen = async () => socket;
  socket.sendMedia = (audio) => calls.audio.push(Buffer.from(audio));
  socket.sendCloseStream = (message) => calls.closeStream.push(message);
  socket.close = () => { calls.close += 1; };

  class FakeDeepgramClient {
    constructor(options) { calls.clientOptions = options; }
    listen = { v1: { connect: async (options) => { calls.connect.push(options); return socket; } } };
  }

  const results = [];
  const stream = await openDeepgramStream({
    apiKey: 'test-key-not-a-real-secret',
    sampleRate: 48000,
    DeepgramClientType: FakeDeepgramClient,
    onTranscript: (result) => results.push(result),
  });
  stream.sendAudio(Buffer.from([1, 2, 3]));
  socket.emit('message', {
    type: 'Results',
    is_final: true,
    speech_final: true,
    start: 0.5,
    duration: 1.25,
    channel: { alternatives: [{ transcript: 'Hola, I need a charger.', confidence: 0.94 }] },
  });
  stream.close();
  stream.close();

  assert.deepEqual(calls.clientOptions, { apiKey: 'test-key-not-a-real-secret' });
  assert.equal(calls.connect[0].model, 'nova-3');
  assert.equal(calls.connect[0].language, 'multi');
  assert.equal(calls.connect[0].endpointing, 100);
  assert.equal(calls.connect[0].interim_results, 'true');
  assert.equal(calls.connect[0].encoding, 'linear16');
  assert.equal(calls.connect[0].sample_rate, 48000);
  assert.deepEqual(calls.audio, [Buffer.from([1, 2, 3])]);
  assert.equal(results[0].transcript, 'Hola, I need a charger.');
  assert.equal(results[0].isFinal, true);
  assert.equal(calls.closeStream.length, 1);
  assert.equal(calls.close, 1);
});

test('fails closed when the server-side Deepgram key is absent', async () => {
  await assert.rejects(openDeepgramStream({ apiKey: '' }), /DEEPGRAM_API_KEY/);
});