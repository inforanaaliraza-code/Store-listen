const assert = require('node:assert/strict');
const test = require('node:test');
const { approvalFailureMessage, getCaptureUiState, getDeliveryStatus } = require('../src/capture-ui-state');

test('capture cannot start while approval is unknown or still pending', () => {
  for (const approvalStatus of ['unknown', 'pending']) {
    const ui = getCaptureUiState({ approvalStatus });
    assert.equal(ui.buttonDisabled, true);
    assert.notEqual(ui.buttonLabel, 'Start recording');
  }
});

test('failed approval check gives a clear retry state even after prior approval', () => {
  const ui = getCaptureUiState({
    approvalStatus: 'approved',
    approvalCheckFailed: true,
    approvalCheckError: approvalFailureMessage(new Error('API request failed (503).')),
  });
  assert.equal(ui.buttonDisabled, true);
  assert.match(ui.message, /API returned an error \(503\)/);
});

test('approval failures explain authentication, server, and network errors safely', () => {
  assert.match(approvalFailureMessage(new Error('Invalid or expired device session')), /Re-activate it/);
  assert.match(approvalFailureMessage(new Error('API request failed (404).')), /versions do not match/);
  assert.match(approvalFailureMessage(new Error('Failed to fetch')), /internet connection/);
});

test('approved device stays blocked when live transcription is not configured', () => {
  const ui = getCaptureUiState({ approvalStatus: 'approved', transcriptionAvailable: false, deploymentMode: 'live' });
  assert.equal(ui.buttonDisabled, true);
  assert.match(ui.message, /Deepgram/);
});

test('demo and old APIs cannot start capture', () => {
  const demo = getCaptureUiState({
    approvalStatus: 'approved',
    transcriptionAvailable: true,
    deploymentMode: 'demo',
  });
  const oldApi = getCaptureUiState({ approvalStatus: 'approved', transcriptionAvailable: null });
  assert.equal(demo.buttonDisabled, true);
  assert.match(demo.message, /demo mode/i);
  assert.equal(oldApi.buttonDisabled, true);
});

test('approved device gets an explicit start state and can manually pause/resume', () => {
  const ready = getCaptureUiState({ approvalStatus: 'approved', transcriptionAvailable: true, deploymentMode: 'live' });
  const paused = getCaptureUiState({
    approvalStatus: 'approved',
    transcriptionAvailable: true,
    deploymentMode: 'live',
    manuallyStopped: true,
    ended: true,
  });

  assert.equal(ready.buttonDisabled, false);
  assert.equal(ready.buttonLabel, 'Start recording');
  assert.equal(paused.title, 'Capture saved');
  assert.equal(paused.buttonDisabled, false);
});

test('start and stop progress states disable duplicate actions', () => {
  assert.equal(getCaptureUiState({ approvalStatus: 'approved', starting: 'checking' }).buttonDisabled, true);
  assert.equal(getCaptureUiState({ approvalStatus: 'approved', busy: true }).buttonDisabled, true);
  assert.equal(getCaptureUiState({ recording: true }).buttonLabel, 'Stop recording');
});

test('delivery status never claims ready when approval or transcription is blocked', () => {
  assert.equal(getDeliveryStatus({ approvalStatus: 'unknown', approvalCheckFailed: true }), 'Check connection');
  assert.equal(getDeliveryStatus({ approvalStatus: 'pending' }), 'Waiting approval');
  assert.equal(getDeliveryStatus({ approvalStatus: 'approved', transcriptionAvailable: false, deploymentMode: 'live' }), 'Unavailable');
  assert.equal(getDeliveryStatus({ approvalStatus: 'approved', deploymentMode: 'demo' }), 'Live service required');
  assert.equal(getDeliveryStatus({ approvalStatus: 'approved', recording: true }), 'Live');
  assert.equal(getDeliveryStatus({ approvalStatus: 'approved', ended: true }), 'Ended');
});
