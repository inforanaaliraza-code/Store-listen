import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transcribeWithDeepgram } from '../src/deepgram-transcribe.js';

test('batch transcription uses current Nova multilingual SDK and returns transcript metadata', async () => {
  let input;
  class FakeClient {
    constructor(options) { input = { apiKey: options.apiKey }; }
    listen = {
      v1: {
        media: {
          transcribeFile: async (audio, request) => {
            input.audio = audio;
            input.request = request;
            return {
              metadata: { request_id: 'dg-request-1' },
              results: {
                channels: [{
                  detected_language: 'en',
                  alternatives: [{
                    transcript: 'Hola, I need a charger.',
                    languages: ['en', 'es'],
                    confidence: 0.92,
                    words: [{ word: 'Hola', start: 0, end: 0.4, language: 'es' }],
                  }],
                }],
              },
            };
          },
        },
      },
    };
  }

  const audio = Buffer.from([1, 2, 3]);
  const result = await transcribeWithDeepgram({
    audio,
    mimeType: 'audio/webm',
    apiKey: 'server-test-key',
    clientType: FakeClient,
  });
  assert.equal(input.apiKey, 'server-test-key');
  assert.equal(input.audio, audio);
  assert.equal(input.request.model, 'nova-3');
  assert.equal(input.request.language, 'multi');
  assert.equal(result.transcript, 'Hola, I need a charger.');
  assert.equal(result.language, 'es');
  assert.equal(result.requestId, 'dg-request-1');
});

test('batch transcription fails clearly if the server key is missing', async () => {
  await assert.rejects(
    transcribeWithDeepgram({ audio: Buffer.from([1]), mimeType: 'audio/webm', apiKey: '' }),
    /DEEPGRAM_API_KEY/,
  );
});
