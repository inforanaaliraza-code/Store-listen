'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from '@/lib/router-link';
import { apiGet, apiGetWithRetry, getToken, WS_URL, openStoreSocket, wakeApi, type Store } from '../../../lib/api';

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
  status?: string;
  label?: string;
  captureSequence?: number;
};

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

type StreamCard = {
  storeId: string;
  conversationId: string;
  status: 'LIVE' | 'ENDED' | 'WAITING';
  startedAt: number;
  lines: Line[];
  partial: string;
  deviceConnected: boolean;
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

function looksLikeSpanishText(text: string) {
  if (/[¿¡ñáéíóúü]/i.test(text || '')) return true;
  const lowered = (text || '').toLowerCase();
  const hits = ['hola', 'gracias', 'señor', 'senor', 'tenemos', 'producto', 'necesito', 'cuanto', 'cuánto', 'por favor', 'dolares', 'dólares', 'buenos', 'buenas', 'adios', 'adiós'];
  return hits.some((token) => lowered.includes(token));
}

function lineEnglish(line: Line) {
  const spanish = line.language === 'es' || looksLikeSpanishText(line.original);
  if (!spanish) return line.original;
  if (line.translated && line.translated !== line.original && !looksLikeSpanishText(line.translated)) {
    return line.translated;
  }
  return '';
}

function paragraphSpoken(lines: Line[]) {
  return lines.map((line) => line.original).join(' ').trim();
}

function paragraphEnglish(lines: Line[]) {
  const hasSpanish = lines.some((line) => line.language === 'es' || looksLikeSpanishText(line.original));
  if (!hasSpanish) return '';
  return lines.map((line) => {
    const spanish = line.language === 'es' || looksLikeSpanishText(line.original);
    if (!spanish) return line.original;
    return lineEnglish(line);
  }).filter(Boolean).join(' ').trim();
}

function storeLocation(store?: Store | null) {
  return [store?.city, store?.region].filter(Boolean).join(', ') || 'Store location';
}

export default function LivePage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [error, setError] = useState('');
  const [connectedCount, setConnectedCount] = useState(0);
  const [pendingByStore, setPendingByStore] = useState<Record<string, StreamCard>>({});
  const [acceptedIds, setAcceptedIds] = useState<string[]>([]);
  const [activeByStore, setActiveByStore] = useState<Record<string, StreamCard>>({});
  const socketsRef = useRef<Map<string, WebSocket>>(new Map());
  const segmentIdsRef = useRef<Map<string, Set<string>>>(new Map());
  const acceptedIdsRef = useRef<string[]>([]);
  const pendingByStoreRef = useRef<Record<string, StreamCard>>({});
  const aliveRef = useRef(true);
  const retryRef = useRef<Map<string, number>>(new Map());

  useEffect(() => { acceptedIdsRef.current = acceptedIds; }, [acceptedIds]);
  useEffect(() => { pendingByStoreRef.current = pendingByStore; }, [pendingByStore]);

  const storeMap = useMemo(() => Object.fromEntries(stores.map((store) => [store.id, store])), [stores]);

  const upsertPending = useCallback((card: StreamCard) => {
    setPendingByStore((current) => ({ ...current, [card.storeId]: card }));
  }, []);

  const patchActive = useCallback((storeId: string, patch: Partial<StreamCard> | ((card: StreamCard) => StreamCard)) => {
    setActiveByStore((current) => {
      const existing = current[storeId];
      if (!existing) return current;
      const next = typeof patch === 'function' ? patch(existing) : { ...existing, ...patch };
      return { ...current, [storeId]: next };
    });
  }, []);

  const loadTranscript = useCallback(async (storeId: string, conversationId: string, startedAtIso: string) => {
    const transcript = await apiGet<{ segments: { id: string; speaker_label: string; language: string; original_text: string; translated_text: string | null; confidence: number; start_time: number }[] }>(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/transcript?page_size=500`,
    );
    const recovered = transcript.segments
      .map((segment) => ({
        id: segment.id,
        conversationId,
        speaker: segment.speaker_label === 'Speaker not identified' || segment.speaker_label === 'Unattributed speaker'
          ? 'Speaker'
          : (segment.speaker_label || 'Speaker'),
        language: segment.language,
        original: segment.original_text,
        translated: segment.translated_text || segment.original_text,
        confidence: segment.confidence,
        final: true,
        at: Date.parse(startedAtIso) + segment.start_time * 1000,
      }))
      .filter((line) => !isJunkTranscript(line.original))
      .sort((left, right) => left.at - right.at);
    const unique = recovered.filter((line, index) => recovered.findIndex((item) => item.id === line.id) === index);
    segmentIdsRef.current.set(storeId, new Set(unique.map((line) => line.id)));
    return unique;
  }, []);

  const discoverLiveStream = useCallback(async (storeId: string) => {
    const params = new URLSearchParams({ store_id: storeId, status: 'LIVE', page_size: '1' });
    const response = await apiGet<{ conversations: { items: { id: string; started_at: string; status: string }[] } }>(`/api/v1/conversations?${params}`);
    const conversation = response.conversations.items[0];
    if (!conversation) return null;
    const lines = await loadTranscript(storeId, conversation.id, conversation.started_at);
    return {
      storeId,
      conversationId: conversation.id,
      status: 'LIVE' as const,
      startedAt: Date.parse(conversation.started_at) || Date.now(),
      lines,
      partial: '',
      deviceConnected: Boolean(storeMap[storeId]?.device_connected),
    };
  }, [loadTranscript, storeMap]);

  const acceptStream = useCallback(async (storeId: string) => {
    let card: StreamCard | null = pendingByStoreRef.current[storeId] || null;
    if (!card?.conversationId) {
      try {
        card = await discoverLiveStream(storeId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Unable to accept this store stream');
        return;
      }
    }
    if (!card) return;
    setAcceptedIds((ids) => (ids.includes(storeId) ? ids : [...ids, storeId]));
    setActiveByStore((current) => ({ ...current, [storeId]: card as StreamCard }));
    setPendingByStore((current) => {
      const next = { ...current };
      delete next[storeId];
      return next;
    });
  }, [discoverLiveStream]);

  const dismissPending = useCallback((storeId: string) => {
    setPendingByStore((current) => {
      const next = { ...current };
      delete next[storeId];
      return next;
    });
  }, []);

  const removeAccepted = useCallback((storeId: string) => {
    setAcceptedIds((ids) => ids.filter((id) => id !== storeId));
    setActiveByStore((current) => {
      const next = { ...current };
      delete next[storeId];
      return next;
    });
  }, []);

  const handleStoreEvent = useCallback((storeId: string, event: LiveEvent) => {
    const accepted = acceptedIdsRef.current.includes(storeId);
    const pending = pendingByStoreRef.current[storeId];

    if (event.event === 'device.health.updated') {
      const connected = event.status === 'connected';
      setStores((items) => items.map((item) => item.id === storeId ? { ...item, device_connected: connected } : item));
      if (accepted) patchActive(storeId, { deviceConnected: connected });
      else {
        setPendingByStore((current) => {
          const existing = current[storeId];
          if (!existing) return current;
          return { ...current, [storeId]: { ...existing, deviceConnected: connected } };
        });
      }
    }

    if (event.event === 'conversation.started' && event.conversationId) {
      const card: StreamCard = {
        storeId,
        conversationId: event.conversationId,
        status: 'LIVE',
        startedAt: Date.parse(event.timestamp || '') || Date.now(),
        lines: [],
        partial: '',
        deviceConnected: Boolean(storeMap[storeId]?.device_connected),
      };
      segmentIdsRef.current.set(storeId, new Set());
      if (accepted) {
        setActiveByStore((current) => ({ ...current, [storeId]: card }));
      } else {
        upsertPending(card);
      }
      return;
    }

    if (event.event === 'conversation.ended') {
      if (accepted) {
        patchActive(storeId, { status: 'ENDED', partial: '' });
      } else {
        setPendingByStore((current) => {
          const existing = current[storeId];
          if (!existing) return current;
          return { ...current, [storeId]: { ...existing, status: 'ENDED', partial: '' } };
        });
      }
      return;
    }

    if (!accepted) {
      if (event.event === 'transcript.final' && event.originalText && !isJunkTranscript(event.originalText)) {
        upsertPending({
          storeId,
          conversationId: event.conversationId || pending?.conversationId || '',
          status: 'LIVE',
          startedAt: pending?.startedAt || Date.parse(event.timestamp || '') || Date.now(),
          lines: pending?.lines || [],
          partial: '',
          deviceConnected: Boolean(storeMap[storeId]?.device_connected),
        });
      }
      return;
    }

    if (event.event === 'voice.detected') {
      patchActive(storeId, { partial: event.label || 'Voice detected' });
    }
    if (event.event === 'transcript.partial' && event.originalText) {
      patchActive(storeId, { partial: event.originalText });
    }
    if (event.event === 'transcript.final') {
      if (isJunkTranscript(event.originalText || '')) return;
      const segmentId = event.segmentId || `${event.timestamp}-${Math.random()}`;
      const known = segmentIdsRef.current.get(storeId) || new Set<string>();
      if (known.has(segmentId)) return;
      known.add(segmentId);
      segmentIdsRef.current.set(storeId, known);
      const line: Line = {
        id: segmentId,
        conversationId: event.conversationId || '',
        speaker: event.speakerLabel || event.speakerId || 'Speaker',
        language: event.language || 'en',
        original: event.originalText || '',
        translated: event.translatedText || event.originalText || '',
        confidence: event.confidence || 0,
        final: true,
        at: Date.parse(event.timestamp || '') || Date.now(),
      };
      patchActive(storeId, (card) => ({
        ...card,
        status: 'LIVE',
        conversationId: event.conversationId || card.conversationId,
        partial: '',
        lines: [...card.lines, line],
      }));
    }
  }, [patchActive, storeMap, upsertPending]);

  const connectStore = useCallback((storeId: string) => {
    if (!WS_URL) {
      setError('This web release is missing its secure cloud connection URL. Contact your Store Listen administrator.');
      return;
    }
    const token = getToken();
    if (!token) {
      setError('Sign in again to listen to live store audio.');
      return;
    }
    const existing = socketsRef.current.get(storeId);
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return;
    }
    let socket: WebSocket;
    try {
      socket = openStoreSocket(storeId, token);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to open the live store connection.');
      return;
    }
    socketsRef.current.set(storeId, socket);
    const pingTimer = window.setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send('ping');
    }, 15_000);
    socket.onopen = () => {
      if (!aliveRef.current) {
        socket.close();
        return;
      }
      setConnectedCount((count) => count + 1);
      setError('');
      retryRef.current.set(storeId, 1000);
      void discoverLiveStream(storeId).then((card) => {
        if (!card) return;
        if (acceptedIdsRef.current.includes(storeId)) {
          setActiveByStore((current) => ({ ...current, [storeId]: card }));
        } else {
          upsertPending(card);
        }
      }).catch(() => undefined);
    };
    socket.onclose = () => {
      window.clearInterval(pingTimer);
      if (socketsRef.current.get(storeId) === socket) socketsRef.current.delete(storeId);
      setConnectedCount((count) => Math.max(0, count - 1));
      if (!aliveRef.current) return;
      const delay = retryRef.current.get(storeId) || 1000;
      retryRef.current.set(storeId, Math.min(delay * 2, 8000));
      window.setTimeout(() => {
        if (aliveRef.current) connectStore(storeId);
      }, delay);
    };
    socket.onerror = () => {
      if (socket.readyState !== WebSocket.OPEN) setError('Live connection interrupted. Reconnecting…');
    };
    socket.onmessage = (message) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object' || !('event' in parsed) || typeof (parsed as LiveEvent).event !== 'string') {
        return;
      }
      handleStoreEvent(storeId, parsed as LiveEvent);
    };
  }, [discoverLiveStream, handleStoreEvent, upsertPending]);

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void (async () => {
      const awake = await wakeApi(controller.signal);
      if (controller.signal.aborted) return;
      if (!awake) {
        setError('Waking the Store Listen API (free tier cold start). This can take up to a minute…');
      }
      try {
        const payload = await apiGetWithRetry<{ stores: { items: Store[] } }>(
          '/api/v1/stores',
          { signal: controller.signal },
          5,
        );
        if (controller.signal.aborted) return;
        setStores(payload.stores.items);
        setError('');
      } catch (cause: unknown) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : 'Unable to load stores');
        }
      }
    })();
    // Keep free-tier API warm while Live Monitor stays open.
    const keepAlive = window.setInterval(() => {
      void wakeApi(controller.signal);
    }, 240_000);
    return () => {
      controller.abort();
      window.clearInterval(keepAlive);
    };
  }, []);

  const storeRosterKey = stores.map((store) => store.id).join('|');

  useEffect(() => {
    aliveRef.current = true;
    stores.forEach((store) => connectStore(store.id));
    return () => {
      aliveRef.current = false;
      socketsRef.current.forEach((socket) => socket.close());
      socketsRef.current.clear();
    };
    // Reconnect only when the store roster changes, not when callbacks refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeRosterKey]);

  const pendingList = Object.values(pendingByStore).filter((card) => !acceptedIds.includes(card.storeId));
  const activeList = acceptedIds.map((id) => activeByStore[id]).filter(Boolean);

  return (
    <div className="live-monitor-page">
      <header className="monitor-heading">
        <div>
          <span className="eyebrow">STORE SALES MONITORING</span>
          <h1>Live Monitor</h1>
          <p className="monitor-listening">
            <i />
            {connectedCount > 0
              ? `Listening to ${connectedCount} store transmission${connectedCount === 1 ? '' : 's'}`
              : 'Connecting to store transmissions...'}
          </p>
        </div>
        <div className="monitor-toolbar">
          <span className={`monitor-connection ${connectedCount > 0 ? 'connected' : ''}`}>
            <i />{connectedCount > 0 ? 'Global listener online' : 'Reconnecting'}
          </span>
        </div>
      </header>
      {error ? <div className="error" role="alert">{error}</div> : null}

      <section className="monitor-pending" aria-label="Pending store streams">
        <div className="monitor-section-heading">
          <span className="eyebrow">PENDING STREAMS</span>
          <h2>Accept onto the monitor</h2>
          <p>New live streams appear with the store name and location until you accept them.</p>
        </div>
        {pendingList.length ? (
          <div className="monitor-pending-grid">
            {pendingList.map((card) => {
              const store = storeMap[card.storeId];
              return (
                <article className="monitor-pending-card" key={card.storeId}>
                  <div>
                    <strong>{store?.name || card.storeId}</strong>
                    <span>{storeLocation(store)}</span>
                    <span className={`monitor-live-badge ${card.status === 'LIVE' ? 'is-live' : card.status === 'ENDED' ? 'is-ended' : ''}`}>
                      <i />{card.status}
                    </span>
                  </div>
                  <div className="monitor-pending-actions">
                    <button className="primary owner-button" type="button" onClick={() => void acceptStream(card.storeId)}>Accept stream</button>
                    <button className="ghost owner-button" type="button" onClick={() => dismissPending(card.storeId)}>Dismiss</button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="monitor-pending-empty">No pending streams. Live store recordings will appear here for acceptance.</div>
        )}
      </section>

      <section className="monitor-active-grid" aria-label="Accepted live monitors">
        {activeList.length ? activeList.map((card) => {
          const store = storeMap[card.storeId];
          return (
            <article className="monitor-conversation" key={card.storeId}>
              <header className="monitor-store-heading">
                <span className="monitor-store-mark" aria-hidden="true">{(store?.name || 'S').slice(0, 1).toUpperCase()}</span>
                <div className="monitor-store-name">
                  <h2>{store?.name || 'Store'}</h2>
                  <span>{storeLocation(store)}</span>
                </div>
                <span className={`monitor-live-badge ${card.status === 'LIVE' ? 'is-live' : card.status === 'ENDED' ? 'is-ended' : ''}`}>
                  <i />{card.status}
                </span>
                <button className="ghost owner-button monitor-remove" type="button" onClick={() => removeAccepted(card.storeId)}>Remove</button>
              </header>
              <div className="monitor-transcript" role="log" aria-live="polite" aria-relevant="additions text">
                {card.lines.length ? (
                  <div className="monitor-conversation-paragraphs">
                    {groupLinesIntoParagraphs(card.lines).map((paragraph, index) => {
                      const spoken = paragraphSpoken(paragraph.lines);
                      const english = paragraphEnglish(paragraph.lines);
                      const hasSpanish = paragraph.lines.some((line) => line.language === 'es' || looksLikeSpanishText(line.original));
                      return (
                        <article key={`${paragraph.startedAt}-${index}`} className="monitor-paragraph">
                          <header className="monitor-paragraph-meta">
                            <span>Paragraph {String(index + 1).padStart(2, '0')}</span>
                            <time>{formatParagraphTime(paragraph.startedAt)}</time>
                          </header>
                          <p className="monitor-paragraph-body">{spoken || 'No speech detected.'}</p>
                          {hasSpanish ? (
                            <p className="monitor-paragraph-en"><span className="monitor-en-tag">EN</span> {english || 'Translating…'}</p>
                          ) : null}
                        </article>
                      );
                    })}
                    {card.partial ? <p className="monitor-partial">{card.partial}</p> : null}
                  </div>
                ) : (
                  <div className="monitor-empty">
                    <strong>{card.status === 'ENDED' ? 'Session ended' : 'Waiting for speech'}</strong>
                    <span>
                      {card.status === 'ENDED'
                        ? 'The transcript is saved in conversation history.'
                        : 'English transcription appears here in real time. Spanish audio is shown as English text.'}
                    </span>
                  </div>
                )}
              </div>
              <footer className="monitor-card-footer">
                <span><i className={card.deviceConnected ? 'is-online' : ''} />{card.deviceConnected ? 'Recorder connected' : 'Recorder not connected'}</span>
                <span>English transcript</span>
                <Link href="/conversations">Conversation history</Link>
              </footer>
            </article>
          );
        }) : (
          <div className="monitor-empty monitor-empty-board">
            <strong>No streams on the monitor</strong>
            <span>Accept a pending store stream above to watch its live English conversation.</span>
          </div>
        )}
      </section>
    </div>
  );
}
