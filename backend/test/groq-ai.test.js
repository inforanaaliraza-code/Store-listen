import assert from 'node:assert/strict';
import test from 'node:test';
import { generateGroqCoaching, generateGroqDailySummary } from '../src/groq-ai.js';

function jsonResponse(content, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(content) } }],
    }),
  };
}

test('Groq coaching uses bounded transcript context and validates structured output', async () => {
  let request;
  const result = await generateGroqCoaching({
    apiKey: '  test-key\r\n',
    model: 'test-model',
    transcript: [{ speaker: 'customer', text: 'Do you have this charger?' }],
    inventory: [{ name: 'USB-C charger', quantity: 2 }],
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({
        recommendation: 'Confirm the connector type before suggesting the charger.',
        confidence: 0.82,
        alerts: [{ title: 'Check compatibility', message: 'Ask which connector the customer needs.' }],
      });
    },
  });

  assert.equal(request.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.equal(JSON.parse(request.options.body).model, 'test-model');
  assert.equal(result.provider, 'groq');
  assert.equal(result.confidence, 0.82);
  assert.equal(result.alerts.length, 1);
});

test('Groq daily summary requires complete, valid report fields', async () => {
  const result = await generateGroqDailySummary({
    apiKey: 'test-key',
    model: 'test-model',
    businessDate: '2026-10-21',
    store: { name: 'Test store' },
    metrics: { conversations: 1, sales_data_available: false },
    evidence: [{ conversation_id: 'c1', transcript: 'I need a charger.' }],
    fetchImpl: async () => jsonResponse({
      headline: 'Charger request captured',
      executive_summary: 'One conversation included a charger request; no live POS data was available.',
      findings: ['A customer asked about a charger.'],
      actions_for_tomorrow: ['Confirm connector type before recommending a product.'],
      confidence: 0.8,
    }),
  });

  assert.equal(result.provider, 'groq');
  assert.equal(result.key_points[0], 'A customer asked about a charger.');
  assert.equal(result.actions_for_tomorrow.length, 1);
});

test('Groq fails clearly without a key, on network errors, and for malformed output', async () => {
  await assert.rejects(
    generateGroqCoaching({ apiKey: '', model: 'test', transcript: [{ text: 'Hi' }] }),
    /GROQ_API_KEY/,
  );
  await assert.rejects(
    generateGroqCoaching({
      apiKey: 'test-key',
      model: 'test',
      transcript: [{ text: 'Hi' }],
      fetchImpl: async () => { throw new Error('private network detail'); },
    }),
    /could not be reached/,
  );
  await assert.rejects(
    generateGroqCoaching({
      apiKey: 'test-key',
      model: 'test',
      transcript: [{ text: 'Hi' }],
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"recommendation":' } }] }),
      }),
    }),
    /invalid structured output/,
  );
});

test('Groq daily reports reject incomplete output rather than creating a fallback report', async () => {
  await assert.rejects(
    generateGroqDailySummary({
      apiKey: 'test-key',
      model: 'test',
      businessDate: '2026-10-21',
      store: { name: 'Test store' },
      metrics: {},
      evidence: [],
      fetchImpl: async () => jsonResponse({
        headline: 'Incomplete report',
        executive_summary: 'Insufficient evidence.',
        findings: [],
        actions_for_tomorrow: [],
        confidence: 0.3,
      }),
    }),
    /incomplete; no report was saved/,
  );
});
