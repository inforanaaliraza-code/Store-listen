'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from '@/lib/router-link';
import { AUDIO_TRANSCRIPTION_TIMEOUT_MS, apiGet, apiPost, apiUpload, getToken, WS_URL, openStoreSocket, type Store } from '../../../lib/api';
import { createVoiceGate, voiceActivityConfig } from '../../../lib/voice-activity';

type LiveEvent = {
  event: string;
  timestamp?: string;
  conversationId?: string;
  storeId?: string;
  speakerId?: string;
  speakerLabel?: string;
  segmentId?: string;
  language?: string;
  originalText?: string;
  translatedText?: string;
  confidence?: number;
  isFinal?: boolean;
  intent?: string;
  product?: string;
  message?: string;
  status?: string;
  label?: string;
  amount?: number;
  captureSequence?: number;
  previewSequence?: number;
};

const liveEventLabels: Record<string, string> = {
  'transcript.partial': 'Live transcript',
  'transcript.final': 'Transcript captured',
  'speaker.detected': 'Speaker identified',
  'language.detected': 'Language detected',
  'translation.updated': 'Translation ready',
  'conversation.started': 'Conversation started',
  'conversation.ended': 'Conversation ended',
  'intent.detected': 'Customer intent',
  'opportunity.detected': 'Sales opportunity',
  'sales_tip.generated': 'Sales recommendation',
  'missed_opportunity.detected': 'Missed opportunity',
  'pos.transaction.received': 'POS transaction',
  'pos.transaction.matched': 'Sale matched',
  'store.connected': 'Store connected',
  'store.disconnected': 'Store disconnected',
  'device.health.updated': 'Device status',
  'voice.detected': 'Voice detected',
  'alert.created': 'Store alert',
};

function getLiveEventSummary(event: LiveEvent) {
  const transcript = event.originalText || event.translatedText;
  switch (event.event) {
    case 'transcript.partial':
    case 'transcript.final':
      return [event.speakerLabel || 'Speaker', transcript || 'Transcript segment received'].join(' · ');
    case 'speaker.detected':
      return event.speakerLabel || event.speakerId || 'Speaker identified';
    case 'language.detected':
      return event.language ? `Language: ${event.language.toUpperCase()}` : 'Language identified';
    case 'translation.updated':
      return event.translatedText || event.originalText || 'Translation updated';
    case 'intent.detected':
      return [event.intent, event.product].filter(Boolean).join(' · ') || 'Customer intent identified';
    case 'opportunity.detected':
    case 'missed_opportunity.detected':
      return [event.product, event.label || event.status].filter(Boolean).join(' · ') || 'Opportunity flagged for review';
    case 'sales_tip.generated':
      return event.message || 'A sales recommendation is ready';
    case 'pos.transaction.received':
      return [event.product, event.amount == null ? null : `$${event.amount.toFixed(2)}`].filter(Boolean).join(' · ') || 'Transaction received';
    case 'pos.transaction.matched':
      return event.label || event.product || 'Transaction matched to conversation';
    case 'voice.detected':
      return event.label || 'Voice detected on the store recorder';
    case 'device.health.updated':
      return event.label || event.status || 'Device health updated';
    case 'alert.created':
      return event.message || event.label || 'A store alert was created';
    default:
      return event.label || event.message || event.status || 'Event processed';
  }
}

function microphoneCaptureError(cause: unknown) {
  if (!(cause instanceof Error)) return 'Microphone capture failed. Check the selected input and try again.';
  if (cause.name === 'OverconstrainedError' || cause.name === 'ConstraintNotSatisfiedError') {
    return 'The selected microphone is unavailable with these settings. Choose another microphone or use the default input.';
  }
  if (cause.name === 'NotAllowedError' || cause.name === 'PermissionDeniedError' || cause.name === 'SecurityError') {
    return 'Microphone permission was denied. Allow microphone access for localhost in your browser settings, then try again.';
  }
  if (cause.name === 'NotFoundError' || cause.name === 'DevicesNotFoundError') {
    return 'No microphone was found. Connect or enable a microphone, then try again.';
  }
  if (cause.name === 'NotReadableError' || cause.name === 'TrackStartError') {
    return 'The microphone could not be opened. Close other apps using it and try again.';
  }
  return `${cause.message}. Check the microphone input and browser permissions.`;
}

type Line = {
  id: string;
  conversationId: string;
  speaker: string;
  language: string;
  original: string;
  translated: string;
  confidence: number;
  final: boolean;
  at: number;
};

const PARAGRAPH_GAP_MS = 60_000;
const JUNK_EXACT = new Set([
  'tchau', 'chao', 'obrigado', 'obrigada', 'adeus', 'valeu', 'ciao',
  'e ai', 'ai', 'ei', 'oie', 'opa',
  'thank you', 'thanks', 'bye', 'goodbye', 'okay', 'ok', 'hmm', 'uh', 'um', 'yeah',
]);
const ALLOWED_SHORT = new Set(['hola', 'gracias', 'adios', 'si', 'no', 'hello', 'hi', 'yes', 'please', 'sorry', 'help']);

function normalizeJunkPhrase(text: string) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isJunkTranscript(text: string) {
  const phrase = normalizeJunkPhrase(text || '');
  if (!phrase) return true;
  if (JUNK_EXACT.has(phrase)) return true;
  const words = phrase.split(' ').filter(Boolean);
  if (words.length === 1 && words[0].length <= 6 && !ALLOWED_SHORT.has(words[0])) return true;
  if (words.length <= 2 && words.every((word) => word.length <= 3) && !words.some((word) => ALLOWED_SHORT.has(word))) {
    return true;
  }
  return false;
}

function groupLinesIntoParagraphs(lines: Line[]) {
  const sorted = lines.slice().sort((left, right) => left.at - right.at);
  const paragraphs: { startedAt: number; lines: Line[] }[] = [];
  let current: { startedAt: number; endedAt: number; lines: Line[] } | null = null;
  for (const line of sorted) {
    if (!current || line.at - current.endedAt > PARAGRAPH_GAP_MS) {
      current = { startedAt: line.at, endedAt: line.at, lines: [line] };
      paragraphs.push(current);
    } else {
      current.lines.push(line);
      current.endedAt = line.at;
    }
  }
  return paragraphs;
}

function formatParagraphTime(value: number) {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(value));
}

type TranscriptionResponse = {
  conversation_id: string;
  segment: null | {
    segmentId: string;
    speakerId: string;
    speakerLabel: string;
    speakerRole: SpeakerRole;
    employeeId: string | null;
    language: string;
    originalText: string;
    translatedText: string;
    confidence: number;
    timestamp: string;
  };
  speech_provider: string;
  transcription_ms?: number;
  analysis: null | { intent: string; product: string; opportunity: boolean; recommendation: string; confidence: number; provider: string };
  analysis_status: string;
  detected_language?: string;
};

type Employee = { id: string; name: string; store_id: string; role: string };
type SpeakerRole = 'customer' | 'employee' | 'unknown';

export default function LivePage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState('store-001');
  const [connected, setConnected] = useState(false);
  const [conversationStatus, setConversationStatus] = useState<'LIVE' | 'ENDED' | 'WAITING'>('WAITING');
  const [lines, setLines] = useState<Line[]>([]);
  const [partial, setPartial] = useState('');
  const [insight, setInsight] = useState<Record<string, string>>({});
  const [log, setLog] = useState<LiveEvent[]>([]);
  const [seconds, setSeconds] = useState(0);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [microphoneId, setMicrophoneId] = useState('');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [speakerRole, setSpeakerRole] = useState<SpeakerRole>('unknown');
  const [employeeId, setEmployeeId] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [dailyReportReady, setDailyReportReady] = useState(false);
  const [captureStatus, setCaptureStatus] = useState('Microphone not started');
  const [captureError, setCaptureError] = useState('');
  const [analysisNotice, setAnalysisNotice] = useState('');
  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(1000);
  const aliveRef = useRef(true);
  const replacingRef = useRef(false);
  const captureActiveRef = useRef(false);
  const closeDayAfterCaptureRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const captureTimerRef = useRef<number | null>(null);
  const uploadQueueRef = useRef<Promise<void>>(Promise.resolve());
  const inflightUploadsRef = useRef(new Set<Promise<void>>());
  const activeUploadsRef = useRef(0);
  const chunkSequenceRef = useRef(0);
  const chunkStartedAtRef = useRef(0);
  const sessionElapsedSecondsRef = useRef(0);
  const conversationIdRef = useRef('');
  const segmentIdsRef = useRef(new Set<string>());
  const liveConversationIdRef = useRef('');
  const liveConversationStartedAtRef = useRef(0);
  const endedConversationIdRef = useRef('');
  const transcriptClearTimerRef = useRef<number | null>(null);
  const recordNextChunkRef = useRef<() => void>(() => undefined);
  const audioContextRef = useRef<AudioContext | null>(null);
  const voiceFrameRef = useRef(0);
  const speakingRef = useRef(false);
  const speakerRoleRef = useRef<SpeakerRole>('unknown');
  const employeeIdRef = useRef('');
  const pendingSpeakerRef = useRef<{ role: SpeakerRole; employeeId: string } | null>(null);
  const previewInFlightRef = useRef(false);
  const previewSequenceRef = useRef(0);
  const finalCaptureSequenceRef = useRef(0);

  const store = useMemo(() => stores.find((item) => item.id === storeId), [stores, storeId]);

  useEffect(() => {
    const controller = new AbortController();
    apiGet<{ stores: { items: Store[] } }>('/api/v1/stores', { signal: controller.signal }).then((payload) => {
      const availableStores = payload.stores.items;
      setStores(availableStores);
      setStoreId((current) => availableStores.some((item) => item.id === current) ? current : availableStores[0]?.id ?? '');
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) {
        setCaptureError(cause instanceof Error ? cause.message : 'Unable to load stores and employees');
      }
    });
    return () => controller.abort();
  }, []);

  const storeEmployees = employees.filter((employee) => employee.store_id === storeId);

  const resyncLiveTranscript = useCallback(async () => {
    const params = new URLSearchParams({ store_id: storeId, status: 'LIVE', page_size: '1' });
    const response = await apiGet<{ conversations: { items: { id: string; started_at: string; status: string }[] } }>(`/api/v1/conversations?${params}`);
    if (!response.conversations.items.length) {
      liveConversationIdRef.current = '';
      liveConversationStartedAtRef.current = 0;
      setConversationStatus('WAITING');
      setLines([]);
      setPartial('');
      return;
    }
    const conversation = response.conversations.items[0];
    const conversationStartedAt = Date.parse(conversation.started_at) || 0;
    if (liveConversationIdRef.current && liveConversationIdRef.current !== conversation.id
      && conversationStartedAt < liveConversationStartedAtRef.current) return;
    liveConversationIdRef.current = conversation.id;
    liveConversationStartedAtRef.current = conversationStartedAt;
    if (conversation.status !== 'LIVE') {
      const ended = conversation.status === 'ENDED';
      endedConversationIdRef.current = ended ? conversation.id : '';
      setConversationStatus(ended ? 'ENDED' : 'WAITING');
      setLines([]);
      setPartial('');
      segmentIdsRef.current.clear();
      return;
    }
    setConversationStatus('LIVE');
    const transcript = await apiGet<{ segments: { id: string; speaker_label: string; language: string; original_text: string; translated_text: string | null; confidence: number; start_time: number }[] }>(
      `/api/v1/conversations/${encodeURIComponent(conversation.id)}/transcript?page_size=500`,
    );
    const recovered = transcript.segments
      .map((segment) => ({
        id: segment.id,
        conversationId: conversation.id,
        speaker: segment.speaker_label === 'Speaker not identified' || segment.speaker_label === 'Unattributed speaker'
          ? 'Speaker'
          : (segment.speaker_label || 'Speaker'),
        language: segment.language,
        original: segment.original_text,
        translated: segment.translated_text || segment.original_text,
        confidence: segment.confidence,
        final: true,
        at: Date.parse(conversation.started_at) + segment.start_time * 1000,
      }))
      .filter((line) => !isJunkTranscript(line.original))
      .sort((left, right) => left.at - right.at);
    if (!recovered.length) return;
    const unique = recovered.filter((line, index) => recovered.findIndex((item) => item.id === line.id) === index);
    segmentIdsRef.current = new Set(unique.map((line) => line.id));
    setLines(unique);
    setPartial('');
  }, [storeId]);

  useEffect(() => {
    const available = employees.find((employee) => employee.store_id === storeId);
    const selected = employees.find((employee) => employee.id === employeeId && employee.store_id === storeId);
    if (!selected) {
      const nextId = available?.id ?? '';
      setEmployeeId(nextId);
      employeeIdRef.current = nextId;
    }
  }, [employeeId, employees, storeId]);

  useEffect(() => {
    if (!capturing) return;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [capturing]);

  const connect = useCallback(() => {
    replacingRef.current = true;
    socketRef.current?.close();
    replacingRef.current = false;
    if (!WS_URL) {
      setCaptureError('This web release is missing its secure cloud connection URL. Contact your Store Listen administrator.');
      return;
    }
    const token = getToken();
    if (!token) {
      setCaptureError('Sign in again to listen to live store audio.');
      return;
    }
    let socket: WebSocket;
    try {
      socket = openStoreSocket(storeId, token);
    } catch (cause) {
      setCaptureError(cause instanceof Error ? cause.message : 'Unable to open the live store connection.');
      return;
    }
    socketRef.current = socket;
    const pingTimer = window.setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send('ping');
    }, 15_000);
    socket.onopen = () => {
      if (!aliveRef.current || socketRef.current !== socket) {
        socket.close();
        return;
      }
      setConnected(true);
      setCaptureError('');
      retryRef.current = 1000;
      void resyncLiveTranscript().catch(() => {
        setCaptureError('Live connection restored, but recent transcript history could not be synchronized.');
      });
    };
    socket.onclose = () => {
      window.clearInterval(pingTimer);
      setConnected(false);
      if (!aliveRef.current || replacingRef.current || socketRef.current !== socket) return;
      window.setTimeout(() => {
        if (aliveRef.current && socketRef.current === socket) connect();
      }, retryRef.current);
      retryRef.current = Math.min(retryRef.current * 2, 8000);
    };
    socket.onerror = () => {
      if (socket.readyState !== WebSocket.OPEN) setCaptureError('Live connection interrupted. Reconnecting…');
    };
    socket.onmessage = (message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object' || !('event' in parsed) || typeof parsed.event !== 'string') {
        return;
      }
      const event = parsed as LiveEvent;
      if (event.event !== 'conversation.started'
        && event.conversationId
        && event.conversationId === endedConversationIdRef.current) return;
      if (event.event === 'conversation.started' && event.conversationId) {
        const startedAt = Date.parse(event.timestamp || '') || Date.now();
        if (liveConversationIdRef.current && event.conversationId !== liveConversationIdRef.current
          && startedAt < liveConversationStartedAtRef.current) return;
        if (event.conversationId !== liveConversationIdRef.current) {
          if (transcriptClearTimerRef.current !== null) window.clearTimeout(transcriptClearTimerRef.current);
          transcriptClearTimerRef.current = null;
          endedConversationIdRef.current = '';
          liveConversationIdRef.current = event.conversationId;
          liveConversationStartedAtRef.current = startedAt;
          segmentIdsRef.current.clear();
          finalCaptureSequenceRef.current = 0;
          setLines([]);
          setPartial('');
          setConversationStatus('LIVE');
        }
      } else if (event.conversationId
        && ['transcript.partial', 'transcript.final'].includes(event.event)) {
        if (!liveConversationIdRef.current) {
          liveConversationIdRef.current = event.conversationId;
        } else if (event.conversationId !== liveConversationIdRef.current) {
          return;
        }
      }
      if (event.event === 'device.health.updated') {
        const eventStoreId = event.storeId || storeId;
        setStores((items) => items.map((item) => item.id === eventStoreId
          ? { ...item, device_connected: event.status === 'connected' }
          : item));
      }
      setLog((items) => [event, ...items].slice(0, 12));
      if (event.event === 'conversation.ended') {
        const endedId = event.conversationId || liveConversationIdRef.current;
        if (endedId && endedId === liveConversationIdRef.current) {
          endedConversationIdRef.current = endedId;
          setConversationStatus('ENDED');
          setPartial('');
          if (transcriptClearTimerRef.current !== null) window.clearTimeout(transcriptClearTimerRef.current);
          transcriptClearTimerRef.current = window.setTimeout(() => {
            if (liveConversationIdRef.current === endedId) {
              setLines([]);
              setPartial('');
              segmentIdsRef.current.clear();
            }
            transcriptClearTimerRef.current = null;
          }, 5000);
        }
      }
      if (event.event === 'voice.detected') {
        setPartial(event.label || 'Voice detected');
      }
      if (event.event === 'transcript.partial' && event.originalText
        && (event.captureSequence ?? 0) > finalCaptureSequenceRef.current) {
        setPartial(event.originalText);
      }
      if (event.event === 'transcript.final') {
        finalCaptureSequenceRef.current = Math.max(finalCaptureSequenceRef.current, event.captureSequence ?? 0);
        setPartial('');
        if (event.segmentId && segmentIdsRef.current.has(event.segmentId)) return;
        if (isJunkTranscript(event.originalText || '')) return;
        if (event.segmentId) segmentIdsRef.current.add(event.segmentId);
        setLines((items) => [
          ...items,
          {
            id: event.segmentId || `${event.timestamp}-${items.length}`,
            conversationId: event.conversationId || liveConversationIdRef.current,
            speaker: event.speakerLabel || event.speakerId || 'Speaker',
            language: event.language || 'en',
            original: event.originalText || '',
            translated: event.translatedText || event.originalText || '',
            confidence: event.confidence || 0,
            final: true,
            at: Date.parse(event.timestamp || '') || Date.now(),
          },
        ]);
      }
      if (event.intent) setInsight((current) => ({ ...current, intent: event.intent || '', product: event.product || current.product }));
      if (event.message) setInsight((current) => ({ ...current, tip: event.message || '' }));
      if (event.status) setInsight((current) => ({ ...current, status: event.label || event.status || '' }));
      if (event.event === 'pos.transaction.received') setInsight((current) => ({ ...current, pos: `${event.product ?? 'Item'} · $${event.amount}` }));
      if (event.event === 'pos.transaction.matched') setInsight((current) => ({ ...current, match: event.label || 'Opportunity Converted' }));
    };
  }, [resyncLiveTranscript, storeId]);

  const uploadAudioChunk = useCallback(async (blob: Blob, sequence: number, durationSeconds: number, sessionOffsetSeconds: number, role: SpeakerRole, selectedEmployeeId: string) => {
    if (!blob.size) return;
    const form = new FormData();
    form.append('audio', blob, `microphone-${sequence}.webm`);
    form.append('store_id', storeId);
    form.append('speaker_role', role);
    form.append('capture_sequence', String(sequence));
    form.append('duration_seconds', String(durationSeconds));
    form.append('session_offset_seconds', String(sessionOffsetSeconds));
    if (role === 'employee') form.append('employee_id', selectedEmployeeId);
    if (conversationIdRef.current) form.append('conversation_id', conversationIdRef.current);
    setCaptureStatus('Listening…');
    const result = await apiUpload<TranscriptionResponse>('/api/v1/audio/transcribe', form, AUDIO_TRANSCRIPTION_TIMEOUT_MS);
    finalCaptureSequenceRef.current = Math.max(finalCaptureSequenceRef.current, sequence);
    setPartial('');
    conversationIdRef.current = result.conversation_id;
    const segment = result.segment;
    if (!segment) {
      setAnalysisNotice(result.analysis_status === 'no_speech'
        ? 'No speech detected in this clip; listening continues.'
        : `Ignored unsupported language${result.detected_language ? ` (${result.detected_language})` : ''}; only English and Spanish are transcribed.`);
      setCaptureStatus(`Recording · ${result.speech_provider || 'speech'} ready`);
      return;
    }
    if (isJunkTranscript(segment.originalText || '')) {
      setCaptureStatus(`Recording · ${result.speech_provider || 'speech'} ready`);
      return;
    }
    segmentIdsRef.current.add(segment.segmentId);
    setLines((items) => [...items, {
      id: segment.segmentId,
      conversationId: result.conversation_id,
      speaker: segment.speakerLabel,
      language: segment.language,
      original: segment.originalText,
      translated: segment.translatedText,
      confidence: segment.confidence,
      final: true,
      at: Date.parse(segment.timestamp || '') || Date.now(),
    }]);
    const sttLabel = result.transcription_ms != null
      ? ` · STT ${(result.transcription_ms / 1000).toFixed(1)}s`
      : '';
    setCaptureStatus(`Recording · ${result.speech_provider} ready${sttLabel}`);
    if (result.analysis) {
      setInsight((current) => ({ ...current, intent: result.analysis?.intent ?? '', product: result.analysis?.product ?? '', tip: result.analysis?.recommendation ?? '', status: result.analysis?.opportunity ? 'Potential opportunity' : 'No opportunity detected' }));
      setAnalysisNotice(`AI analysis from ${result.analysis.provider} · ${Math.round(result.analysis.confidence * 100)}% confidence`);
    } else {
      setAnalysisNotice(result.analysis_status === 'speaker_unattributed'
        ? 'Transcript saved. Speaker is unattributed, so this clip was not scored as customer or staff speech.'
        : result.analysis_status === 'pending'
          ? 'Transcript ready. Sales analysis is finishing in the background.'
          : 'Transcript ready. AI sales analysis is off until a real AI provider and API key are configured.');
    }
  }, [storeId]);

  const uploadAudioPreview = useCallback(async (blob: Blob, captureSequence: number, previewSequence: number) => {
    if (!blob.size || !conversationIdRef.current) return;
    const form = new FormData();
    form.append('audio', blob, `live-preview-${captureSequence}.webm`);
    form.append('store_id', storeId);
    form.append('conversation_id', conversationIdRef.current);
    form.append('capture_sequence', String(captureSequence));
    form.append('preview_sequence', String(previewSequence));
    const result = await apiUpload<{ segment: { originalText?: string } | null }>('/api/v1/audio/transcribe/preview', form, AUDIO_TRANSCRIPTION_TIMEOUT_MS);
    if (result.segment?.originalText && captureSequence === chunkSequenceRef.current + 1 && captureActiveRef.current) {
      setPartial(result.segment.originalText);
    }
  }, [storeId]);

  function finishLiveSession() {
    const finishedConversationId = conversationIdRef.current;
    const generateDailyReport = closeDayAfterCaptureRef.current;
    closeDayAfterCaptureRef.current = false;
    void uploadQueueRef.current.then(async () => {
      if (finishedConversationId) await apiPost(`/api/v1/audio/sessions/${finishedConversationId}/finish`);
      conversationIdRef.current = '';
      if (generateDailyReport) {
        const report = await apiPost<{ business_date: string }>('/api/v1/reports/daily/generate', { store_id: storeId });
        setDailyReportReady(true);
        setAnalysisNotice(`Daily report saved for ${report.business_date}. POS data may be demo/mock.`);
        setCaptureStatus('Day closed; all captured clips were processed and the daily report was saved.');
      } else {
        setCaptureStatus('Microphone stopped; all captured clips were processed.');
      }
    }).catch((cause: unknown) => {
      setCaptureError(cause instanceof Error ? cause.message : 'Unable to finish the microphone session.');
      setCaptureStatus('Session finalization failed');
    }).finally(() => setFinalizing(false));
  }

  recordNextChunkRef.current = () => {
    const stream = streamRef.current;
    if (!captureActiveRef.current || !stream || recorderRef.current) return;
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) {
      setCaptureError('This browser cannot record WebM/Opus audio. Try current Chrome or Edge.');
      captureActiveRef.current = false;
      setCapturing(false);
      return;
    }
    const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 });
    const chunks: Blob[] = [];
    const roleForClip = speakerRoleRef.current;
    const employeeForClip = employeeIdRef.current;
    chunkStartedAtRef.current = Date.now();
    recorderRef.current = recorder;
    let lastPreviewAt = 0;
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      chunks.push(event.data);
      const now = Date.now();
      const elapsed = now - chunkStartedAtRef.current;
      if (elapsed < voiceActivityConfig.previewIntervalMs || now - lastPreviewAt < voiceActivityConfig.previewIntervalMs || previewInFlightRef.current) return;
      lastPreviewAt = now;
      previewInFlightRef.current = true;
      const previewSequence = ++previewSequenceRef.current;
      const previewBlob = new Blob(chunks, { type: mimeType });
      void uploadAudioPreview(previewBlob, chunkSequenceRef.current + 1, previewSequence)
        .catch(() => undefined)
        .finally(() => { previewInFlightRef.current = false; });
    };
    recorder.onerror = () => setCaptureError('Browser audio recording failed. Check the selected microphone and permission.');
    recorder.onstop = () => {
      if (captureTimerRef.current !== null) window.clearTimeout(captureTimerRef.current);
      recorderRef.current = null;
      const blob = new Blob(chunks, { type: mimeType });
      const durationMs = Date.now() - chunkStartedAtRef.current;
      const durationSeconds = Math.max(durationMs / 1000, 0.1);
      const sessionOffsetSeconds = sessionElapsedSecondsRef.current;
      sessionElapsedSecondsRef.current += durationSeconds;
      if (blob.size && durationMs >= voiceActivityConfig.minClipMs) {
        const sequence = ++chunkSequenceRef.current;
        const job = (async () => {
          while (activeUploadsRef.current >= 4) {
            if (!inflightUploadsRef.current.size) break;
            await Promise.race([...inflightUploadsRef.current]);
          }
          activeUploadsRef.current += 1;
          try {
            await uploadAudioChunk(blob, sequence, durationSeconds, sessionOffsetSeconds, roleForClip, employeeForClip);
          } finally {
            activeUploadsRef.current = Math.max(0, activeUploadsRef.current - 1);
          }
        })().catch((cause: unknown) => {
          setCaptureError(cause instanceof Error ? cause.message : 'Audio upload/transcription failed.');
          setCaptureStatus('Transcription error');
        });
        inflightUploadsRef.current.add(job);
        uploadQueueRef.current = Promise.allSettled([...inflightUploadsRef.current]).then(() => undefined);
        void job.finally(() => {
          inflightUploadsRef.current.delete(job);
          uploadQueueRef.current = Promise.allSettled([...inflightUploadsRef.current]).then(() => undefined);
        });
      }
      if (pendingSpeakerRef.current) {
        speakerRoleRef.current = pendingSpeakerRef.current.role;
        employeeIdRef.current = pendingSpeakerRef.current.employeeId;
        setSpeakerRole(pendingSpeakerRef.current.role);
        setEmployeeId(pendingSpeakerRef.current.employeeId);
        pendingSpeakerRef.current = null;
      }
      if (captureActiveRef.current && speakingRef.current) recordNextChunkRef.current();
      else if (!captureActiveRef.current) finishLiveSession();
    };
    recorder.start(voiceActivityConfig.previewIntervalMs);
    setCaptureStatus('Voice detected · sending a short clip');
    captureTimerRef.current = window.setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop();
    }, voiceActivityConfig.maxSegmentMs);
  };

  function requestSpeakerChange(role: SpeakerRole, selectedEmployeeId: string) {
    const nextEmployee = role === 'employee' ? selectedEmployeeId || storeEmployees[0]?.id || '' : '';
    if (role === 'employee' && !nextEmployee) {
      setCaptureError('No staff member is assigned to this store. Select another store or review Employees.');
      return;
    }
    setCaptureError('');
    if (capturing && recorderRef.current?.state === 'recording') {
      pendingSpeakerRef.current = { role, employeeId: nextEmployee };
      setCaptureStatus('Finishing current clip; next clip will use the selected speaker…');
      recorderRef.current.stop();
      return;
    }
    speakerRoleRef.current = role;
    employeeIdRef.current = nextEmployee;
    setSpeakerRole(role);
    setEmployeeId(nextEmployee);
  }

  async function startCapture() {
    if (finalizing) return;
    setCaptureError('');
    setAnalysisNotice('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setCaptureError('This browser does not support microphone capture. Use current Chrome or Edge on localhost.');
      return;
    }
    try {
      const audio: MediaTrackConstraints = {};
      if (microphoneId) audio.deviceId = { ideal: microphoneId };
      const stream = await navigator.mediaDevices.getUserMedia({ audio });
      streamRef.current = stream;
      const audioContext = new AudioContext();
      await audioContext.resume();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0;
      const source = audioContext.createMediaStreamSource(stream);
      const silent = audioContext.createGain();
      silent.gain.value = 0;
      source.connect(analyser);
      analyser.connect(silent);
      silent.connect(audioContext.destination);
      audioContextRef.current = audioContext;
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((device) => device.kind === 'audioinput');
      setMicrophones(inputs);
      if (!microphoneId && inputs[0]) setMicrophoneId(inputs[0].deviceId);
      const session = await apiPost<{ conversation_id: string }>('/api/v1/audio/sessions', { store_id: storeId });
      conversationIdRef.current = session.conversation_id;
      segmentIdsRef.current.clear();
      chunkSequenceRef.current = 0;
      previewSequenceRef.current = 0;
      finalCaptureSequenceRef.current = 0;
      previewInFlightRef.current = false;
      sessionElapsedSecondsRef.current = 0;
      closeDayAfterCaptureRef.current = false;
      speakingRef.current = false;
      setDailyReportReady(false);
      uploadQueueRef.current = Promise.resolve();
      setLines([]);
      setSeconds(0);
      captureActiveRef.current = true;
      setCapturing(true);
      setCaptureStatus('Listening · speech is captured the moment it starts.');
      const samples = new Float32Array(analyser.fftSize);
      const spectrum = new Float32Array(analyser.frequencyBinCount);
      const gate = createVoiceGate();
      const tick = () => {
        if (!captureActiveRef.current) return;
        analyser.getFloatTimeDomainData(samples);
        analyser.getFloatFrequencyData(spectrum);
        const state = gate.observe(samples, spectrum, audioContext.sampleRate);
        if (state === 'start') {
          speakingRef.current = true;
          setPartial('Voice detected');
          setCaptureStatus('Voice detected · capturing this phrase');
          recordNextChunkRef.current();
        } else if (state === 'end') {
          speakingRef.current = false;
          const recorder = recorderRef.current;
          const elapsed = Date.now() - chunkStartedAtRef.current;
          if (recorder?.state === 'recording') {
            if (elapsed >= voiceActivityConfig.minClipMs) recorder.stop();
            else captureTimerRef.current = window.setTimeout(() => {
              if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
            }, voiceActivityConfig.minClipMs - elapsed);
          }
        }
        voiceFrameRef.current = window.requestAnimationFrame(tick);
      };
      voiceFrameRef.current = window.requestAnimationFrame(tick);
    } catch (cause) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      conversationIdRef.current = '';
      setCaptureError(microphoneCaptureError(cause));
      setCaptureStatus('Microphone unavailable');
    }
  }

  function stopCapture(generateDailyReport = false) {
    captureActiveRef.current = false;
    speakingRef.current = false;
    setCapturing(false);
    setFinalizing(true);
    closeDayAfterCaptureRef.current = generateDailyReport;
    if (voiceFrameRef.current) window.cancelAnimationFrame(voiceFrameRef.current);
    if (captureTimerRef.current !== null) window.clearTimeout(captureTimerRef.current);
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    else finishLiveSession();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    setCaptureStatus('Stopping microphone… final clip will be transcribed.');
  }

  useEffect(() => () => {
    captureActiveRef.current = false;
    if (voiceFrameRef.current) window.cancelAnimationFrame(voiceFrameRef.current);
    if (captureTimerRef.current !== null) window.clearTimeout(captureTimerRef.current);
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    void audioContextRef.current?.close();
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    connect();
    return () => {
      aliveRef.current = false;
      if (transcriptClearTimerRef.current !== null) window.clearTimeout(transcriptClearTimerRef.current);
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket?.readyState === WebSocket.OPEN) socket.close();
    };
  }, [connect]);

  return (
    <div className="live-monitor-page">
      <header className="monitor-heading">
        <div>
          <span className="eyebrow">STORE SALES MONITORING</span>
          <h1>Live Monitor</h1>
          <p className="monitor-listening"><i />{connected ? 'Listening to store transmissions' : 'Connecting to store transmissions...'}</p>
        </div>
        <div className="monitor-toolbar">
          <label>Store
            <select value={storeId} onChange={(event) => setStoreId(event.target.value)}>
              {stores.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <span className={`monitor-connection ${connected ? 'connected' : ''}`}><i />{connected ? 'Connected' : 'Reconnecting'}</span>
        </div>
      </header>
      {captureError ? <div className="error" role="alert">{captureError}</div> : null}
      <article className="monitor-conversation">
        <header className="monitor-store-heading">
          <span className="monitor-store-mark" aria-hidden="true">S</span>
          <div className="monitor-store-name"><h2>{store?.name || 'Store'}</h2><span>{[store?.city, store?.region].filter(Boolean).join(', ') || 'Store location'}</span></div>
          <span className={`monitor-live-badge ${conversationStatus === 'LIVE' ? 'is-live' : conversationStatus === 'ENDED' ? 'is-ended' : ''}`}><i />{conversationStatus}</span>
        </header>
        <div className="monitor-transcript" role="log" aria-live="polite" aria-relevant="additions text">
          {lines.length ? (
            <div className="monitor-conversation-paragraphs">
              {groupLinesIntoParagraphs(lines).map((paragraph, index) => (
                <article key={`${paragraph.startedAt}-${index}`} className="monitor-paragraph">
                  <header className="monitor-paragraph-meta">
                    <span>Paragraph {String(index + 1).padStart(2, '0')}</span>
                    <time>{formatParagraphTime(paragraph.startedAt)}</time>
                  </header>
                  <p className="monitor-paragraph-body">
                    {paragraph.lines.map((line, lineIndex) => {
                      const showGloss = line.language === 'es' && line.translated && line.translated !== line.original;
                      return (
                        <span key={line.id}>
                          {lineIndex > 0 ? ' ' : ''}
                          {showGloss ? (
                            <span className="monitor-es-phrase">
                              {line.original}
                              <span className="monitor-en-gloss"> ({line.translated})</span>
                            </span>
                          ) : line.original}
                        </span>
                      );
                    })}
                  </p>
                </article>
              ))}
            </div>
          ) : <div className="monitor-empty"><strong>{conversationStatus === 'ENDED' ? 'Session ended' : connected ? 'Waiting for a live conversation' : 'Store feed is reconnecting'}</strong><span>{conversationStatus === 'ENDED' ? 'The transcript is saved in conversation history.' : connected ? 'Clear English and Spanish speech flows into paragraphs. After one minute of silence, a new paragraph starts. Spanish phrases show an English gloss inline.' : 'The monitor will resume automatically when the store connection returns.'}</span></div>}
        </div>
        <footer className="monitor-card-footer">
          <span><i className={connected ? 'is-online' : ''} />{connected ? 'Live store feed' : 'Feed unavailable'}</span>
          <span>{store?.device_connected ? 'Recorder connected' : 'Recorder not connected'}</span>
          <Link href="/conversations">Conversation history</Link>
        </footer>
      </article>
    </div>
  );
}
