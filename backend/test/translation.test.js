import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translateToEnglish } from '../src/translation.js';

test('translates a final multilingual utterance using the server-side DeepL key', async () => {
  let request;
  const translation = await translateToEnglish('Hola, necesito un cargador.', {
    apiKey: 'test-key-not-a-real-secret',
    apiUrl: 'https://api-free.deepl.com',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ translations: [{ text: 'Hello, I need a charger.' }] }) };
    },
  });

  assert.equal(request.url, 'https://api-free.deepl.com/v2/translate');
  assert.equal(request.options.headers.Authorization, 'DeepL-Auth-Key test-key-not-a-real-secret');
  assert.deepEqual(JSON.parse(request.options.body), { text: ['Hola, necesito un cargador.'], target_lang: 'EN' });
  assert.equal(translation, 'Hello, I need a charger.');
});

test('does not send transcript text when the server-side DeepL key is absent', async () => {
  await assert.rejects(
    translateToEnglish('Hola', { apiKey: '', apiUrl: 'https://api-free.deepl.com' }),
    /DEEPL_API_KEY/,
  );
});