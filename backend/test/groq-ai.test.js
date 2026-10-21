import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateGroqCoaching,
  generateGroqConversationReport,
  generateGroqDailySummary,
} from '../src/groq-ai.js';

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

test('Groq conversation report analyzes Spanish evidence and validates report fields', async () => {
  let requestBody;
  const report = await generateGroqConversationReport({
    apiKey: 'test-key',
    model: 'test-model',
    transcript: [
      { role: 'customer', language: 'es', time_seconds: 4, text: '¿Tiene un cargador para mi teléfono?' },
      { role: 'employee', language: 'en', time_seconds: 8, text: 'I can check which connector you need.' },
    ],
    recordedOutcomes: [{ status: 'REVIEW_REQUIRED', customer_intent: 'Possible purchase' }],
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return jsonResponse({
        summary: 'A customer asks about a phone charger; no purchase outcome is stated.',
        customer_needs: ['Phone charger'],
        customer_sentiment: 'unknown',
        products_discussed: ['Phone charger'],
        opportunity_type: 'potential',
        opportunity_summary: 'The need is expressed, but the outcome is not in the transcript.',
        recommendation: 'Confirm the customer’s connector and check verified stock.',
        evidence: 'At 4 seconds the customer asks for a charger; at 8 seconds the employee offers to check.',
        confidence: 0.86,
      });
    },
  });

  assert.equal(requestBody.model, 'test-model');
  assert.equal(requestBody.response_format.type, 'json_object');
  assert.match(requestBody.messages[1].content, /¿Tiene un cargador para mi teléfono/);
  assert.equal(report.customer_sentiment, 'unknown');
  assert.equal(report.opportunity_type, 'potential');
  assert.equal(report.provider, 'groq');
  assert.equal(report.confidence, 0.86);
});

test('Groq conversation report rejects incomplete output rather than saving rule-based fallback', async () => {
  await assert.rejects(
    generateGroqConversationReport({
      apiKey: 'test-key',
      model: 'test-model',
      transcript: [{ role: 'customer', language: 'en', time_seconds: 0, text: 'Hello.' }],
      fetchImpl: async () => jsonResponse({
        summary: 'A customer said hello.',
        customer_needs: [],
        customer_sentiment: 'unknown',
        products_discussed: [],
        opportunity_type: 'none',
        opportunity_summary: 'No purchase request is apparent.',
        recommendation: '',
        evidence: 'At 0 seconds, the speaker says hello.',
        confidence: 0.4,
      }),
    }),
    /incomplete conversation report; no report was saved/,
  );
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

test('Groq provider errors expose a bounded reason without exposing request credentials', async () => {
  await assert.rejects(
    generateGroqCoaching({
      apiKey: 'secret-test-key',
      model: 'retired-model',
      transcript: [{ speaker: 'customer', text: 'Hola.' }],
      fetchImpl: async (_url, options) => {
        assert.equal(options.headers.Authorization, 'Bearer secret-test-key');
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { message: 'The selected model has been retired.' } }),
        };
      },
    }),
    /status 400: The selected model has been retired/,
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
