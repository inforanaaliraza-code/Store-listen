(function initializeRecordingLifecycle(globalScope) {
  async function stopCaptureAndDrain(capture, onInputReleased, options = {}) {
    const maxUploadWaitMs = Number.isFinite(options.maxUploadWaitMs)
      ? Math.max(0, options.maxUploadWaitMs)
      : 0;

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

    // Release the microphone first, then give final clips a bounded chance to persist before ending the server session.
    if (maxUploadWaitMs <= 0 || !capture.uploadQueue) return;
    await Promise.race([
      capture.uploadQueue.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, maxUploadWaitMs)),
    ]);
  }

  const lifecycle = { stopCaptureAndDrain };
  if (typeof module !== 'undefined' && module.exports) module.exports = lifecycle;
  globalScope.StoreListenRecordingLifecycle = lifecycle;
}(typeof globalThis !== 'undefined' ? globalThis : this));
