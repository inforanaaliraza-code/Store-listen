const assert = require('node:assert/strict');
const test = require('node:test');
const { formatUserError } = require('../src/error-messages');

test('explains when the server gateway returns 502', () => {
  const message = formatUserError(new Error("Error invoking remote method 'api-request': Error: API request failed (502)."));

  assert.match(message, /backend service is running/i);
  assert.doesNotMatch(message, /remote method|502/);
});

test('maps network and session failures to clear recovery steps', () => {
  assert.match(formatUserError(new Error('fetch failed')), /private Tailscale connection is unavailable/i);
  assert.match(formatUserError(new Error('Invalid or expired session')), /Sign in and activate/i);
});