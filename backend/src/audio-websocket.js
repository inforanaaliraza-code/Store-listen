import { randomUUID } from 'node:crypto';
import { openDeepgramStream } from './deepgram-stream.js';
import { translateToEnglish } from './translation.js';

const TRANSLATION_PENDING = 'English translation pending';
const MAX_QUEUED_AUDIO_BYTES = 1024 * 1024;

function safeSend(socket, payload) {
  if (socket.readyState === 1) socket.send(JSON.stringify(payload));
}

function isSpanish(languages) {
  return !languages.length || languages.some((language) => String(language).toLowerCase().startsWith('es'));
}

export async function attachDeviceAudioSocket(socket, {
  device,
  conversation,
  sampleRate,
  sessionOffsetSeconds = 0,
  captureSequence = 0,
  deepgramApiKey,
  deeplApiKey,
  deeplApiUrl,
  ConversationModel,
  TranscriptSegmentModel,
  publish,
  deepgramFactory = openDeepgramStream,
  translate = translateToEnglish,
}) {
  let stream;
  let queuedAudio = [];
  let queuedBytes = 0;
  let previewSequence = 0;
  let lastCaptureSequence = captureSequence;
  let finalizedParts = [];
  let processing = Promise.resolve();
  let stopRequested = false;
  let closed = false;

  const queueFinalizedParts = () => {
    const parts = finalizedParts;
    finalizedParts = [];
    if (!parts.length) return;

    const utterance = parts.map((part) => part.transcript).join(' ').replace(/\s+/g, ' ').trim();
    if (!utterance) return;
    const allLanguages = [...new Set(parts.flatMap((part) => part.languages))];
    const needsTranslation = isSpanish(allLanguages);
    const confidenceValues = parts.map((part) => part.confidence).filter(Number.isFinite);
    const confidence = confidenceValues.length
      ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
      : null;
    const startTime = parts.find((part) => Number.isFinite(part.start))?.start ?? 0;
    const lastPart = parts.at(-1);
    const endTime = Number.isFinite(lastPart.start) && Number.isFinite(lastPart.duration)
      ? lastPart.start + lastPart.duration
      : startTime;
    const sequence = ++lastCaptureSequence;

    processing = processing.then(async () => {
      let english = utterance;
      if (needsTranslation) {
        try {
          english = await translate(utterance, {
            apiKey: deeplApiKey,
            apiUrl: deeplApiUrl,
            signal: AbortSignal.timeout(6000),
          });
        } catch (error) {
          english = TRANSLATION_PENDING;
          console.warn('Live transcript translation unavailable:', error?.message || 'provider error');
        }
      }

      const segmentId = `seg-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const now = new Date();
      await TranscriptSegmentModel.create({
        id: segmentId,
        conversation_id: conversation.id,
        speaker_id: 'speaker-unknown',
        language: needsTranslation ? 'es' : 'en',
        original_text: utterance,
        translated_text: english === TRANSLATION_PENDING ? null : english,
        start_time: Math.max(0, sessionOffsetSeconds + startTime),
        end_time: Math.max(sessionOffsetSeconds + startTime, sessionOffsetSeconds + endTime),
        confidence: confidence ?? 0,
        is_final: true,
        created_at: now,
      });
      await ConversationModel.updateOne(
        { id: conversation.id },
        { $set: { primary_language: needsTranslation ? 'es' : 'en' } },
      );
      const event = {
        event: 'transcript.final',
        conversationId: conversation.id,
        storeId: device.store_id,
        segmentId,
        captureSequence: sequence,
        sessionOffsetSeconds: Math.max(0, sessionOffsetSeconds + startTime),
        speakerId: 'speaker-unknown',
        speakerLabel: 'Speaker',
        speakerRole: 'unknown',
        language: needsTranslation ? 'es' : 'en',
        originalText: utterance,
        translatedText: english === TRANSLATION_PENDING ? '' : english,
        englishText: english,
        confidence: confidence ?? 0,
        isFinal: true,
        source: 'deepgram',
        transcriptionMs: null,
        timestamp: now.toISOString(),
      };
      safeSend(socket, event);
      publish(`store:${device.store_id}`, event);
    }).catch((error) => {
      console.error('Could not persist live transcript:', error);
      safeSend(socket, { event: 'audio.error', detail: 'Transcript could not be saved.' });
    });
  };

  const handleTranscript = (result) => {
    const languages = result.languages.map((language) => String(language).toLowerCase());
    const spanish = isSpanish(languages);
    const preview = {
      event: 'transcript.partial',
      conversationId: conversation.id,
      storeId: device.store_id,
      captureSequence: lastCaptureSequence + 1,
      previewSequence: ++previewSequence,
      sessionOffsetSeconds: Math.max(0, sessionOffsetSeconds + (Number.isFinite(result.start) ? result.start : 0)),
      speakerLabel: 'Live transcript',
      language: spanish ? 'es' : 'en',
      originalText: result.transcript,
      translatedText: '',
      englishText: spanish ? TRANSLATION_PENDING : result.transcript,
      confidence: result.confidence,
      isFinal: false,
      source: 'deepgram_preview',
      timestamp: new Date().toISOString(),
    };
    safeSend(socket, preview);
    publish(`store:${device.store_id}`, preview);

    if (result.isFinal && result.transcript) finalizedParts.push({ ...result, languages });
    if (!result.speechFinal) return;
    if (!finalizedParts.length && result.transcript) finalizedParts.push({ ...result, languages });
    queueFinalizedParts();
  };

  const streamReady = deepgramFactory({
    apiKey: deepgramApiKey,
    sampleRate,
    onTranscript: handleTranscript,
    onError: (error) => {
      console.error('Deepgram live stream error:', error?.message || 'provider error');
      safeSend(socket, { event: 'audio.error', detail: 'Live transcription provider is unavailable.' });
    },
  }).then((opened) => {
    stream = opened;
    for (const audio of queuedAudio) stream.sendAudio(audio);
    queuedAudio = [];
    queuedBytes = 0;
    safeSend(socket, { event: 'audio.ready', conversationId: conversation.id });
    return stream;
  });

  socket.on('message', (data, isBinary) => {
    if (!isBinary) {
      let control;
      try { control = JSON.parse(String(data)); } catch { return; }
      if (control.type === 'ping') return safeSend(socket, { event: 'pong' });
      if (control.type === 'audio.stop') {
        stopRequested = true;
        void streamReady.then(async (active) => {
          await active.finish();
          queueFinalizedParts();
          await processing;
          safeSend(socket, { event: 'audio.stopped', conversationId: conversation.id });
          socket.close(1000, 'Audio stream finished');
        }).catch((error) => {
          console.error('Could not finish live transcription stream:', error?.message || 'provider error');
          safeSend(socket, { event: 'audio.error', detail: 'Final transcript could not be confirmed. Check the saved transcript before closing.' });
          socket.close(1011, 'Could not finish audio stream');
        });
      }
      return;
    }
    if (stopRequested || closed) return;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (stream) {
      try { stream.sendAudio(bytes); } catch { socket.close(1011, 'Deepgram stream is unavailable'); }
      return;
    }
    queuedBytes += bytes.length;
    if (queuedBytes > MAX_QUEUED_AUDIO_BYTES) {
      socket.close(1009, 'Audio setup buffer exceeded');
      return;
    }
    queuedAudio.push(bytes);
  });

  socket.on('close', () => {
    closed = true;
    if (stream) stream.close();
    queuedAudio = [];
  });
  socket.on('error', () => {
    closed = true;
    if (stream) stream.close();
  });

  try { await streamReady; }
  catch (error) {
    safeSend(socket, { event: 'audio.error', detail: error.message || 'Could not open live transcription.' });
    socket.close(1011, 'Could not open Deepgram transcription');
    throw error;
  }
  return { close: () => stream?.close() };
}