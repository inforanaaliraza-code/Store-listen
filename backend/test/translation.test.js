import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSpanishTranscript, translateToEnglish } from '../src/translation.js';

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
    /GROQ_API_KEY or DEEPL_API_KEY/,
  );
});

test('falls back to Groq when DeepL is not configured', async () => {
  let request;
  const translated = await translateToEnglish('¿Hola, cómo estás?', {
    apiKey: '',
    apiUrl: 'https://api-free.deepl.com',
    groqApiKey: 'groq-test-key',
    groqModel: 'test-model',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ translation: 'Hello, how are you?' }) } }] }),
      };
    },
  });

  assert.equal(request.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer groq-test-key');
  assert.equal(JSON.parse(request.options.body).model, 'test-model');
  assert.equal(translated, 'Hello, how are you?');
});

test('falls back to Groq when configured DeepL fails', async () => {
  const urls = [];
  const translated = await translateToEnglish('Necesito ayuda.', {
    apiKey: 'deepl-test-key',
    apiUrl: 'https://api-free.deepl.com',
    groqApiKey: 'groq-test-key',
    groqModel: 'test-model',
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.includes('deepl')) return { ok: false, status: 503 };
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ translation: 'I need help.' }) } }] }),
      };
    },
  });

  assert.deepEqual(urls, [
    'https://api-free.deepl.com/v2/translate',
    'https://api.groq.com/openai/v1/chat/completions',
  ]);
  assert.equal(translated, 'I need help.');
});

test('detects Spanish when stream language metadata is missing without classifying English as Spanish', () => {
  assert.equal(isSpanishTranscript('¿Hola, cómo estás?'), true);
  assert.equal(isSpanishTranscript('Hola, necesito un cargador.'), true);
  assert.equal(isSpanishTranscript('I need help finding a charger.'), false);
  assert.equal(isSpanishTranscript('Hello, how are you?', 'multi'), false);
  assert.equal(isSpanishTranscript('Hola', 'es'), true);
});