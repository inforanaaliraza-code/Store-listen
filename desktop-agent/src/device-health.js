(function initializeDeviceHealth(globalScope) {
  function createPayload(metrics, recording, speaking, supportsSpeaking) {
    const payload = {
      cpu_pct: metrics.cpu_pct,
      memory_pct: metrics.memory_pct,
      audio_status: recording ? 'streaming' : 'idle',
      microphone_status: recording ? 'ok' : 'disconnected',
      stream_status: recording ? 'live' : 'idle',
      processing_latency_ms: 0,
    };
    if (supportsSpeaking) payload.speaking = Boolean(speaking);
    return payload;
  }

  const api = { createPayload };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalScope.StoreListenDeviceHealth = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));