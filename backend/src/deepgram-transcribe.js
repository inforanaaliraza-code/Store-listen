import { DeepgramClient } from '@deepgram/sdk';

export async function transcribeWithDeepgram({
  audio,
  mimeType,
  apiKey,
  clientType = DeepgramClient,
}) {
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY is required for audio transcription.');
  if (!Buffer.isBuffer(audio) || audio.length === 0) throw new TypeError('Audio must be a non-empty Buffer.');

  const client = new clientType({ apiKey });
  const result = await client.listen.v1.media.transcribeFile(audio, {
    model: 'nova-3',
    language: 'multi',
    smart_format: true,
    detect_language: true,
    diarize_model: 'latest',
    tag: `store-listen:${String(mimeType || 'audio').replace(/[^a-zA-Z0-9/-]/g, '').slice(0, 60)}`,
  });
  const alternative = result?.results?.channels?.[0]?.alternatives?.[0];
  const transcript = String(alternative?.transcript || '').trim();
  if (!transcript) {
    return { transcript: '', language: 'und', confidence: 0, words: [] };
  }
  const languages = Array.isArray(alternative.languages) ? alternative.languages : [];
  const language = languages.some((value) => String(value).toLowerCase().startsWith('es'))
    ? 'es'
    : languages.length
      ? languages[0]
      : result.results.channels[0].detected_language || 'und';
  return {
    transcript,
    language: String(language).slice(0, 8),
    confidence: Number.isFinite(alternative.confidence) ? alternative.confidence : 0,
    words: Array.isArray(alternative.words) ? alternative.words : [],
    requestId: result.metadata?.request_id || null,
  };
}
