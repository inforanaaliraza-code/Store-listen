import { DeepgramClient } from '@deepgram/sdk';

export async function openDeepgramStream({
  apiKey,
  sampleRate,
  onTranscript = () => {},
  onError = () => {},
  DeepgramClientType = DeepgramClient,
}) {
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY is required for live transcription.');

  const client = new DeepgramClientType({ apiKey });
  const connection = await client.listen.v1.connect({
    model: 'nova-3',
    language: 'multi',
    interim_results: 'true',
    endpointing: 100,
    smart_format: 'true',
    encoding: 'linear16',
    sample_rate: sampleRate,
    reconnectAttempts: 0,
  });
  let resolveClosed;
  let closed = false;
  const closedSignal = new Promise((resolve) => { resolveClosed = resolve; });

  connection.on('message', (message) => {
    if (message?.type !== 'Results') return;
    const alternative = message.channel?.alternatives?.[0];
    const transcript = String(alternative?.transcript || '').trim();
    if (!transcript) return;
    const result = {
      transcript,
      isFinal: Boolean(message.is_final),
      speechFinal: Boolean(message.speech_final),
      languages: Array.isArray(alternative?.languages) ? alternative.languages : [],
      words: Array.isArray(alternative?.words) ? alternative.words : [],
      confidence: Number.isFinite(alternative?.confidence) ? alternative.confidence : null,
      start: Number.isFinite(message.start) ? message.start : null,
      duration: Number.isFinite(message.duration) ? message.duration : null,
    };
    try {
      const callbackResult = onTranscript(result);
      if (callbackResult && typeof callbackResult.then === 'function') callbackResult.catch(onError);
    } catch (error) { onError(error); }
  });
  connection.on('error', onError);
  connection.on('close', () => {
    closed = true;
    resolveClosed();
  });
  connection.connect();
  await connection.waitForOpen();

  return {
    sendAudio(audio) {
      if (closed) throw new Error('Deepgram stream is already closed.');
      if (!Buffer.isBuffer(audio) && !ArrayBuffer.isView(audio)) throw new TypeError('Audio frames must be binary.');
      if (audio.byteLength) connection.sendMedia(audio);
    },
    close() {
      if (closed) return;
      closed = true;
      if (connection.readyState === 1) connection.sendCloseStream({ type: 'CloseStream' });
      connection.close();
    },
    async finish(timeoutMs = 4000) {
      if (closed) return;
      if (connection.readyState === 1) connection.sendCloseStream({ type: 'CloseStream' });
      await Promise.race([
        closedSignal,
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
      if (!closed) {
        closed = true;
        connection.close();
      }
    },
  };
}