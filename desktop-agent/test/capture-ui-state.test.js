const assert = require('node:assert/strict');
const test = require('node:test');
const { getCaptureUiState } = require('../src/capture-ui-state');

test('capture cannot start while approval is unknown or still pending', () => {
  for (const approvalStatus of ['unknown', 'pending']) {
    const ui = getCaptureUiState({ approvalStatus });
    assert.equal(ui.buttonDisabled, true);
    assert.notEqual(ui.buttonLabel, 'Start recording');
  }
});

test('failed approval check gives a clear retry state even after prior approval', () => {
  const ui = getCaptureUiState({ approvalStatus: 'approved', approvalCheckFailed: true });
  assert.equal(ui.buttonDisabled, true);
  assert.match(ui.message, /Could not verify device approval/);
});

test('approved device gets an explicit start state and can manually pause/resume', () => {
  const ready = getCaptureUiState({ approvalStatus: 'approved' });
  const paused = getCaptureUiState({ approvalStatus: 'approved', manuallyStopped: true, ended: true });

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
