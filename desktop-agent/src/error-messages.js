(function initializeErrorMessages(globalScope) {
  function formatUserError(error) {
    const raw = error instanceof Error ? error.message : String(error ?? '');
    const message = raw
      .replace(/^Error invoking remote method '[^']+':\s*/i, '')
      .replace(/^Error:\s*/i, '')
      .trim();
    const status = message.match(/API request failed\s*\((\d{3})\)/i)?.[1];

    if (status === '401' || status === '403' || /invalid or expired session|authentication required/i.test(message)) {
      return 'Your device session needs attention. Sign in and activate this PC again.';
    }
    if (status === '413') return 'This audio clip is too large to process. Stop capture and start a new session.';
    if (status === '415') return 'This audio format is not supported. Update Store Listen and try again.';
    if (status === '429') return 'The service is busy. Wait a moment, then try again.';
    if (status === '502') return 'The Store Listen server is returning an error. Check that its backend service is running and Tailscale is connected, then try again.';
    if (/speech transcription failed|whisper model/i.test(message)) return 'The speech service could not process this audio. Check the backend Whisper service and try again.';
    if (status === '500' || status === '503') return 'The local speech service is temporarily unavailable. Keep this PC awake and connected to Tailscale, then try again.';
    if (/fetch failed|econnrefused|enotfound|network request failed|unable to reach/i.test(message)) {
      return 'The private Tailscale connection is unavailable. Check that Tailscale is connected and this PC is online.';
    }
    if (/timed? ?out|timeout/i.test(message)) return 'The request took too long. Keep Tailscale connected and try again.';
    if (/only english, spanish, hindi, urdu, and arabic/i.test(message)) {
      return 'This speech language is not supported by the current transcription service.';
    }
    if (/no speech was detected/i.test(message)) {
      return 'No speech was recognized in that clip. Check the selected microphone and speak near it.';
    }
    if (/^(api request failed|error invoking remote method|internal server error|traceback)/i.test(message)) {
      return 'Store Listen could not complete that action. Check the private connection and try again.';
    }
    return message || 'Store Listen could not complete that action. Check the private connection and try again.';
  }

  const api = { formatUserError };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalScope.StoreListenErrorMessages = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));