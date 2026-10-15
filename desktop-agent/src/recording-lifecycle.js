(function initializeRecordingLifecycle(globalScope) {
  async function stopCaptureAndDrain(capture, onInputReleased) {
    const recorder = capture.recorder;
    if (recorder && recorder.state !== 'inactive') {
      await new Promise((resolve) => {
        recorder.addEventListener('stop', resolve, { once: true });
        recorder.stop();
      });
    }

    capture.stream?.getTracks().forEach((track) => track.stop());
    capture.stream = null;
    if (capture.audioContext?.state !== 'closed') await capture.audioContext?.close();
    onInputReleased?.();
    await capture.uploadQueue;
  }

  const lifecycle = { stopCaptureAndDrain };
  if (typeof module !== 'undefined' && module.exports) module.exports = lifecycle;
  globalScope.StoreListenRecordingLifecycle = lifecycle;
}(typeof globalThis !== 'undefined' ? globalThis : this));