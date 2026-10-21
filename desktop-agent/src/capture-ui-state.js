(function initializeCaptureUiState(globalScope) {
  function getCaptureUiState({
    recording = false,
    busy = false,
    starting = false,
    approvalStatus = 'unknown',
    approvalCheckFailed = false,
    manuallyStopped = false,
    ended = false,
  } = {}) {
    if (recording) {
      return {
        indicator: 'LIVE',
        title: 'Recording live',
        message: 'Microphone is active. English and Spanish speech appears here in English.',
        buttonLabel: 'Stop recording',
        buttonDisabled: false,
        buttonTitle: 'Stop recording and save this capture.',
      };
    }
    if (busy) {
      return {
        indicator: 'SAVING',
        title: 'Stopping safely',
        message: 'Closing the microphone and saving this capture.',
        buttonLabel: 'Stopping…',
        buttonDisabled: true,
        buttonTitle: 'Capture is stopping.',
      };
    }
    if (starting) {
      const checkingApproval = starting === 'checking';
      return {
        indicator: 'CHECKING',
        title: checkingApproval ? 'Checking device access' : 'Starting microphone',
        message: checkingApproval ? 'Verifying administrator approval before capture starts.' : 'Connecting the microphone and secure live transcription.',
        buttonLabel: checkingApproval ? 'Checking access…' : 'Starting…',
        buttonDisabled: true,
        buttonTitle: checkingApproval ? 'Checking device approval.' : 'Starting live capture.',
      };
    }
    if (approvalCheckFailed || approvalStatus === 'unknown') {
      return {
        indicator: 'CHECK',
        title: 'Connection needs attention',
        message: 'Could not verify device approval. Check the connection, then retry.',
        buttonLabel: 'Check connection',
        buttonDisabled: true,
        buttonTitle: 'Capture stays off until approval can be verified.',
      };
    }
    if (approvalStatus === 'rejected') {
      return {
        indicator: 'BLOCKED',
        title: 'Device not approved',
        message: 'Contact your administrator or register this device again.',
        buttonLabel: 'Approval required',
        buttonDisabled: true,
        buttonTitle: 'An administrator must approve this device before recording.',
      };
    }
    if (approvalStatus !== 'approved') {
      return {
        indicator: 'WAITING',
        title: 'Waiting for admin approval',
        message: 'Recording is off. An administrator must approve this device first.',
        buttonLabel: 'Awaiting approval',
        buttonDisabled: true,
        buttonTitle: 'An administrator must approve this device before recording.',
      };
    }
    if (manuallyStopped) {
      return {
        indicator: ended ? 'ENDED' : 'READY',
        title: ended ? 'Capture saved' : 'Capture paused',
        message: 'Capture stays off until you choose Start recording.',
        buttonLabel: 'Start recording',
        buttonDisabled: false,
        buttonTitle: 'Start a new recording.',
      };
    }
    return {
      indicator: ended ? 'ENDED' : 'READY',
      title: ended ? 'Capture saved' : 'Ready to record',
      message: ended ? 'Your capture is saved. Start again when you are ready.' : 'Choose a microphone, then start capture when the store is ready.',
      buttonLabel: 'Start recording',
      buttonDisabled: false,
      buttonTitle: 'Start live recording.',
    };
  }

  const api = { getCaptureUiState };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalScope.StoreListenCaptureUiState = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
