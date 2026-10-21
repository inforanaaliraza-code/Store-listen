import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { attachDeviceAudioSocket } from '../src/audio-websocket.js';

class FakeClientSocket extends EventEmitter {
  readyState = 1;
  sent = [];
  closeCode = null;

  send(payload) { this.sent.push(JSON.parse(payload)); }
  close(code, reason) {
    this.closeCode = { code, reason };
    this.readyState = 3;
    this.emit('close');
  }
}

test('device audio socket streams PCM, translates Spanish finals, persists, and stops cleanly', async () => {
  const client = new FakeClientSocket();
  const stored = [];
  const published = [];
  const updates = [];
  let deepgramOptions;
  let translatedText;

  await attachDeviceAudioSocket(client, {
    device: { id: 'device-1', store_id: 'store-1' },
    conversation: { id: 'conv-1', store_id: 'store-1' },
    sampleRate: 48000,
    deepgramApiKey: 'test-deepgram-key',
    deeplApiKey: 'test-deepl-key',
    deeplApiUrl: 'https://api-free.deepl.com',
    TranscriptSegmentModel: { create: async (row) => stored.push(row) },
    ConversationModel: { updateOne: async (...args) => updates.push(args) },
    publish: (room, event) => published.push({ room, event }),
    deepgramFactory: async (options) => {
      deepgramOptions = options;
      return {
        sentAudio: [],
        sendAudio(audio) { this.sentAudio.push(Buffer.from(audio)); },
        close() { this.closed = true; },
        finish: async function finish() { this.finished = true; },
      };
    },
    translate: async (text, options) => {
      translatedText = { text, options };
      return 'Hello, I need a charger.';
    },
  });

  assert.equal(client.sent[0].event, 'audio.ready');
  const audio = Buffer.from([1, 2, 3, 4]);
  client.emit('message', audio, true);
  assert.deepEqual(deepgramOptions.sampleRate, 48000);

  await deepgramOptions.onTranscript({
    transcript: 'Hola, necesito un cargador.',
    isFinal: true,
    speechFinal: true,
    languages: ['es'],
    confidence: 0.96,
    start: 2,
    duration: 1.5,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(translatedText.text, 'Hola, necesito un cargador.');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].language, 'es');
  assert.equal(stored[0].translated_text, 'Hello, I need a charger.');
  assert.equal(published.at(-1).room, 'store:store-1');
  assert.equal(published.at(-1).event.englishText, 'Hello, I need a charger.');
  assert.equal(published.at(-1).event.sessionOffsetSeconds, 2);
  assert.equal(client.sent.at(-1).event, 'transcript.final');

  client.emit('message', JSON.stringify({ type: 'audio.stop' }), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.sent.at(-1).event, 'audio.stopped');
  assert.equal(client.closeCode.code, 1000);
});

test('audio stop flushes final speech that did not receive a speech-final boundary', async () => {
  const client = new FakeClientSocket();
  const stored = [];
  let deepgramOptions;

  await attachDeviceAudioSocket(client, {
    device: { id: 'device-1', store_id: 'store-1' },
    conversation: { id: 'conv-1', store_id: 'store-1' },
    sampleRate: 48000,
    deepgramApiKey: 'test-deepgram-key',
    deeplApiKey: '',
    deeplApiUrl: 'https://api-free.deepl.com',
    TranscriptSegmentModel: { create: async (row) => stored.push(row) },
    ConversationModel: { updateOne: async () => {} },
    publish: () => {},
    deepgramFactory: async (options) => {
      deepgramOptions = options;
      return {
        sendAudio() {},
        close() {},
        finish: async function finish() { this.finished = true; },
      };
    },
  });

  await deepgramOptions.onTranscript({
    transcript: 'I need help finding a charger.',
    isFinal: true,
    speechFinal: false,
    languages: ['en'],
    confidence: 0.97,
    start: 8.5,
    duration: 1.2,
  });
  client.emit('message', JSON.stringify({ type: 'audio.stop' }), false);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(stored.length, 1);
  assert.equal(stored[0].original_text, 'I need help finding a charger.');
  assert.equal(client.sent.find((event) => event.event === 'transcript.final').sessionOffsetSeconds, 8.5);
  assert.equal(client.sent.at(-1).event, 'audio.stopped');
});