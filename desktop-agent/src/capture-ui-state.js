(function initializeCaptureUiState(globalScope) {
  function approvalFailureMessage(error) {
    const message = String(error instanceof Error ? error.message : error || '').replace(/\s+/g, ' ').trim();
    if (/failed to fetch|networkerror|network request failed|timed? ?out|aborted/i.test(message)) {
      return 'Could not reach the Store Listen API. Check your internet connection and retry.';
    }
    if (/invalid or expired device session|device credentials/i.test(message)) {
      return 'This device could not authenticate. Re-activate it with your administrator.';
    }
    const status = message.match(/(?:API request failed\s*\(|HTTP\s+)(\d{3})/i)?.[1];
    if (status === '401' || status === '403') return 'The API rejected this device. Re-activate it or ask your administrator to check its access.';
    if (status === '404') return 'The installed app and API versions do not match. Update the API deployment, then retry.';
    if (status && Number(status) >= 500) return `The Store Listen API returned an error (${status}). Retry in a moment.`;
    return message
      ? `Approval check failed: ${message.slice(0, 160)}`
      : 'Could not verify device approval. Check the connection, then retry.';
  }

  function getDeliveryStatus({
    recording = false,
    busy = false,
    apiOnline = null,
    approvalStatus = 'unknown',
    approvalCheckFailed = false,
    transcriptionAvailable = null,
    ended = false,
  } = {}) {
    if (recording) return 'Live';
    if (busy) return 'Saving';
    if (ended) return 'Ended';
    if (apiOnline === false) return 'Offline';
    if (approvalCheckFailed || approvalStatus === 'unknown') return 'Check connection';
    if (approvalStatus === 'rejected') return 'Blocked';
    if (approvalStatus !== 'approved') return 'Waiting approval';
    if (transcriptionAvailable === false) return 'Unavailable';
    return 'Ready';
  }

  function getCaptureUiState({
    recording = false,
    busy = false,
    starting = false,
    approvalStatus = 'unknown',
    approvalCheckFailed = false,
    approvalCheckError = '',
    transcriptionAvailable = null,
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
        message: approvalCheckError || 'Could not verify device approval. Check the connection, then retry.',
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
    if (transcriptionAvailable === false) {
      return {
        indicator: 'OFFLINE',
        title: 'Transcription is not configured',
        message: 'The API is online, but live transcription is unavailable. An administrator must configure Deepgram.',
        buttonLabel: 'Transcription unavailable',
        buttonDisabled: true,
        buttonTitle: 'Live transcription requires a configured Deepgram API key.',
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

  const api = { approvalFailureMessage, getCaptureUiState, getDeliveryStatus };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalScope.StoreListenCaptureUiState = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
