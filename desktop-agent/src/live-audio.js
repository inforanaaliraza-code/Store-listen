(function initializeLiveAudio(globalScope) {
  function floatToPcm16(samples) {
    const pcm = new Int16Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, Number(samples[index]) || 0));
      pcm[index] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    }
    return pcm;
  }

  function createAudioSocket({
    apiBase,
    deviceId,
    deviceSecret,
    conversationId,
    sampleRate,
    sessionOffsetSeconds,
    captureSequence,
    WebSocketClass = WebSocket,
  }) {
    if (!deviceId || !deviceSecret || !conversationId) throw new Error('Device and conversation credentials are required.');
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) throw new Error('Unsupported microphone sample rate.');
    const url = new URL(apiBase);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `/ws/audio/${encodeURIComponent(deviceId)}/${encodeURIComponent(conversationId)}`;
    const params = new URLSearchParams({ sample_rate: String(sampleRate) });
    if (Number.isFinite(sessionOffsetSeconds) && sessionOffsetSeconds > 0) {
      params.set('session_offset_seconds', String(sessionOffsetSeconds));
    }
    if (Number.isInteger(captureSequence) && captureSequence > 0) {
      params.set('capture_sequence', String(captureSequence));
    }
    url.search = params.toString();

    return new Promise((resolve, reject) => {
      const socket = new WebSocketClass(url.toString(), ['storelisten.v1', deviceSecret]);
      socket.binaryType = 'arraybuffer';
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('Timed out connecting to live transcription.'));
      }, 10_000);
      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve(socket);
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Could not connect to the live transcription service.'));
      }, { once: true });
      socket.addEventListener('close', (event) => {
        clearTimeout(timeout);
        if (socket.readyState !== WebSocketClass.OPEN) {
          reject(new Error(event.reason || 'Live transcription connection was closed.'));
        }
      }, { once: true });
    });
  }

  const api = { floatToPcm16, createAudioSocket };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalScope.StoreListenLiveAudio = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));