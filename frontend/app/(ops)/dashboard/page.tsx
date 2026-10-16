'use client';

import Link from '@/lib/router-link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, getToken, openStoreSocket, type DashboardSummary, WS_URL } from '../../../lib/api';

type Recommendation = { id: string; title: string; message: string; confidence: number; store_id: string };
type LiveLine = { id: string; storeId: string; speaker: string; text: string; translation?: string; at: string };

function revenueLabel(values: Record<string, number> | undefined) {
  const entries = Object.entries(values ?? {});
  if (!entries.length) return '$0';
  return entries.map(([currency, amount]) => {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount); }
    catch { return `${currency} ${amount.toFixed(0)}`; }
  }).join(' · ');
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [deviceFilter, setDeviceFilter] = useState('all');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [liveLines, setLiveLines] = useState<LiveLine[]>([]);
  const [liveStatus, setLiveStatus] = useState('Waiting for the store recorder');
  const backgroundRefreshInFlight = useRef(false);

  const load = useCallback(async (background = false) => {
    if (background && backgroundRefreshInFlight.current) return;
    if (background) backgroundRefreshInFlight.current = true;
    else setLoading(true);
    setError('');
    try {
      const [summary, intelligence] = await Promise.all([
        apiGet<DashboardSummary>('/api/v1/dashboard/summary'),
        apiGet<{ recommendations: Recommendation[] }>('/api/v1/sales-intelligence'),
      ]);
      setData(summary);
      setRecommendations(intelligence.recommendations);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load dashboard');
    } finally {
      if (background) backgroundRefreshInFlight.current = false;
      else setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void load(true);
    };
    const interval = window.setInterval(refreshWhenVisible, 15_000);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [load]);

  const storeIds = (data?.stores ?? []).map((store) => store.id).join('|');
  useEffect(() => {
    const token = getToken();
    if (!storeIds || !WS_URL || !token) return;

    let disposed = false;
    let refreshTimer = 0;
    const sockets = new Set<WebSocket>();
    const reconnectTimers = new Set<number>();
    const finalCaptureSequences = new Map<string, number>();
    const previewSequences = new Map<string, number>();
    const visibleStoreIds = storeIds.split('|');
    const scheduleRefresh = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void load(true), 250);
    };

    function connect(storeId: string, retryDelay = 1000) {
      if (disposed) return;
      let socket: WebSocket;
      try {
        socket = openStoreSocket(storeId, token);
      } catch {
        return;
      }
      sockets.add(socket);
      const pingTimer = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send('ping');
      }, 15_000);
      socket.onopen = () => { retryDelay = 1000; };
      socket.onmessage = (message) => {
        if (typeof message.data === 'string' && (message.data === 'pong' || message.data === 'ping')) return;
        scheduleRefresh();
        try {
          const event = JSON.parse(message.data) as {
            event?: string;
            storeId?: string;
            segmentId?: string;
            speakerLabel?: string;
            originalText?: string;
            translatedText?: string;
            conversationId?: string;
            captureSequence?: number;
            previewSequence?: number;
            timestamp?: string;
            label?: string;
          };
          if (event.event === 'voice.detected') {
            setLiveStatus(event.label || 'Voice detected');
          }
          const conversationId = event.conversationId || event.storeId || storeId;
          if (event.event === 'transcript.partial' && event.originalText) {
            const captureSequence = event.captureSequence ?? 0;
            const previewSequence = event.previewSequence ?? 0;
            const newestFinal = finalCaptureSequences.get(conversationId) ?? 0;
            const newestPreview = previewSequences.get(conversationId) ?? 0;
            if (captureSequence > newestFinal && previewSequence >= newestPreview) {
              previewSequences.set(conversationId, previewSequence);
              setLiveStatus(event.originalText);
            }
          }
          if (event.event === 'transcript.final' && event.originalText) {
            finalCaptureSequences.set(conversationId, Math.max(finalCaptureSequences.get(conversationId) ?? 0, event.captureSequence ?? 0));
            previewSequences.delete(conversationId);
            const line: LiveLine = {
              id: event.segmentId || `${event.timestamp}-${Math.random()}`,
              storeId: event.storeId || storeId,
              speaker: event.speakerLabel || 'Speaker',
              text: event.originalText,
              translation: event.translatedText && event.translatedText !== event.originalText ? event.translatedText : undefined,
              at: event.timestamp || new Date().toISOString(),
            };
            setLiveLines((items) => [line, ...items.filter((item) => item.id !== line.id)].slice(0, 12));
            setLiveStatus('Live transcript from the store recorder');
          }
        } catch {
          /* ignore malformed live events; summary refresh still runs */
        }
      };
      socket.onclose = () => {
        window.clearInterval(pingTimer);
        sockets.delete(socket);
        if (disposed) return;
        const delay = Math.min(retryDelay, 30_000);
        const timer = window.setTimeout(() => {
          reconnectTimers.delete(timer);
          connect(storeId, Math.min(delay * 2, 30_000));
        }, Math.round(delay * (0.75 + Math.random() * 0.5)));
        reconnectTimers.add(timer);
      };
      socket.onerror = () => socket.close();
    }

    visibleStoreIds.forEach((storeId) => connect(storeId));
    return () => {
      disposed = true;
      window.clearTimeout(refreshTimer);
      reconnectTimers.forEach((timer) => window.clearTimeout(timer));
      sockets.forEach((socket) => socket.close());
    };
  }, [load, storeIds]);

  if (error && !data) return <section className="error" role="alert"><h1>Dashboard unavailable</h1><p>{error}</p><button className="primary" onClick={() => void load()} disabled={loading}>{loading ? 'Retrying…' : 'Retry'}</button></section>;
  if (!data) return <div className="skeleton" role="status" aria-label="Loading dashboard" />;

  const m = data.metrics;
  const stores = deviceFilter === 'all' ? data.stores : data.stores.filter((store) => store.id === deviceFilter);
  const supportedLanguageCounts = Object.entries(m.language_distribution).filter(([language]) => ['en', 'es', 'hi', 'ur'].includes(language));
  const cards = [
    { label: 'Potential missed', value: m.potential_missed_opportunities, note: 'Opportunities marked missed', color: 'red' },
    { label: 'Conversion rate', value: `${Math.round(m.conversion_rate * 100)}%`, note: `${m.converted_opportunities} of ${m.sales_opportunities} opportunities`, color: 'teal' },
    { label: 'Detected revenue', value: revenueLabel(m.revenue_by_currency_7d), note: 'POS · last 7 days', color: 'gold' },
    { label: 'Conversations', value: m.conversations_today, note: `${m.live_conversations} live now`, color: 'green' },
    { label: 'Listening time', value: `${Math.floor((m.listening_seconds_7d ?? 0) / 3600)}h ${Math.floor(((m.listening_seconds_7d ?? 0) % 3600) / 60)}m`, note: 'Across recorders · last 7 days', color: 'blue' },
    { label: 'Recorders online', value: `${m.recorders_online ?? 0}/${m.recorders_total ?? data.stores.length}`, note: `${data.stores.length} stores in view`, color: 'green' },
  ];
  const latestRecommendation = recommendations[0];

  return (
    <div className="owner-dashboard">
      <div className="heading">
        <div>
          <span className="eyebrow">SHOP OWNER</span>
          <h1 className="serif">Dashboard</h1>
          <p>Live conversations, sales signals, and recorder health across your stores.</p>
        </div>
        <div className="owner-actions">
          <span className="owner-period">Last 7 days</span>
          <button className="primary owner-button" onClick={() => window.print()}>Export PDF</button>
          <button className="ghost owner-button" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
        </div>
      </div>
      {error ? <div className="error" role="alert"><p>{error}</p><button className="ghost" onClick={() => void load()} disabled={loading}>Retry refresh</button></div> : null}
      <section className="owner-kpis" aria-label="Store performance summary">
        {cards.map((card) => (
          <article className={`owner-kpi ${card.color}`} key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <small>{card.note}</small>
          </article>
        ))}
      </section>
      <section className="owner-panel owner-live-feed" aria-label="Live transcript from store recorder">
        <div className="owner-panel-heading">
          <div>
            <span className="eyebrow">SAME FEED AS THE RECORDER</span>
            <h2>Live conversation</h2>
            <p>{liveStatus}</p>
          </div>
          <Link href="/live">Open live monitor</Link>
        </div>
        <div className="owner-live-lines">
          {liveLines.map((line) => (
            <article className="owner-live-line" key={line.id}>
              <span>{data.stores.find((store) => store.id === line.storeId)?.name || line.storeId} · {line.speaker}</span>
              <p>{line.text}</p>
              {line.translation ? <small>{line.translation}</small> : null}
            </article>
          ))}
          {!liveLines.length ? (
            <div className="owner-empty-state">
              <strong>No live lines yet</strong>
              <p>When the Windows recorder detects speech, the same transcript appears here in real time.</p>
            </div>
          ) : null}
        </div>
      </section>
      <section className="owner-work-grid">
        <article className="owner-panel owner-recorders">
          <div className="owner-panel-heading">
            <div><span className="eyebrow">LIVE MONITOR</span><h2>Recording computers</h2><p>Recorder status and current store activity</p></div>
            <label className="owner-select-label">Store
              <select value={deviceFilter} onChange={(event) => setDeviceFilter(event.target.value)} aria-label="Filter recorders by store">
                <option value="all">All stores</option>
                {data.stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
              </select>
            </label>
          </div>
          <div className="owner-recorder-list">
            {stores.map((store) => (
              <article className="owner-recorder" key={store.id}>
                <div className="owner-recorder-title">
                  <div><strong>{store.name}</strong><small>{store.city}, {store.region}</small></div>
                  <span className={`owner-status ${store.device_connected ? 'is-online' : 'is-offline'}`}><i />{store.device_connected ? 'Recording' : 'Offline'}</span>
                </div>
                <p className="owner-latest">{store.device?.microphone_status === 'low_level' ? 'Microphone input is low. Check placement and audio level.' : store.device_connected ? `${store.open_conversations} live conversation${store.open_conversations === 1 ? '' : 's'} · ${store.device?.processing_latency_ms ?? 0} ms processing` : 'This computer is switched off or has no connection.'}</p>
                <div className="owner-recorder-footer">
                  <span>{store.device?.name ?? 'No recorder registered'}</span>
                  <Link href={store.device_connected ? '/live' : '/settings'}>{store.device_connected ? 'Open live monitor' : 'Connect recorder'}</Link>
                </div>
              </article>
            ))}
            {!stores.length ? <div className="empty">No stores match this filter.</div> : null}
          </div>
        </article>
        <article className="owner-panel owner-coaching">
          <div className="owner-panel-heading"><div><span className="eyebrow">SALES INTELLIGENCE</span><h2>Coaching the rep right now</h2><p>Latest AI-assisted recommendation</p></div><Link href="/sales-intelligence">View all</Link></div>
          {latestRecommendation ? <div className="owner-coach-callout">
            <span className="owner-status is-online"><i />AI recommendation</span>
            <h3>{latestRecommendation.title}</h3>
            <p>{latestRecommendation.message}</p>
            <small>{Math.round(latestRecommendation.confidence * 100)}% model confidence · {data.stores.find((store) => store.id === latestRecommendation.store_id)?.name ?? latestRecommendation.store_id}</small>
          </div> : <div className="owner-empty-state"><strong>Waiting for the next customer signal</strong><p>Recommendations appear here when a live conversation produces a product or service opportunity.</p><Link href="/live">Open live monitor</Link></div>}
          <div className="owner-language-row"><span>Supported languages heard</span><strong>{supportedLanguageCounts.filter(([, count]) => count > 0).map(([language, count]) => `${({ en: 'English', es: 'Spanish', hi: 'Hindi', ur: 'Urdu' } as Record<string, string>)[language]} ${count}`).join(' · ') || 'No supported-language conversations yet'}</strong></div>
        </article>
      </section>
      <section className="owner-work-grid owner-lower-grid">
        <article className="owner-panel">
          <div className="owner-panel-heading"><div><span className="eyebrow">RECENT ACTIVITY</span><h2>Latest conversations</h2></div><Link href="/conversations">All conversations</Link></div>
          <div className="owner-table-wrap"><table className="table owner-table">
            <thead><tr><th>Store</th><th>Customer intent</th><th>Language</th><th>Outcome</th></tr></thead>
            <tbody>{data.recent_conversations.map((row) => <tr key={row.id}>
              <td><Link href={`/conversations/${row.id}`}>{row.store_name ?? row.store_id}</Link></td>
              <td>{row.customer_intent || 'Conversation captured'}</td>
              <td>{row.language.toUpperCase()}</td>
              <td><span className={`pill ${row.opportunity_status === 'CONVERTED' ? 'ok' : row.opportunity_status === 'MISSED' ? 'bad' : 'warn'}`}>{row.opportunity_status}</span></td>
            </tr>)}</tbody>
          </table></div>
          {!data.recent_conversations.length ? <div className="owner-empty-state">No conversations have been captured yet.</div> : null}
        </article>
        <article className="owner-panel">
          <div className="owner-panel-heading"><div><span className="eyebrow">ATTENTION</span><h2>Store alerts</h2></div><Link href="/alerts">View alerts</Link></div>
          {data.alerts.slice(0, 4).map((alert) => <div className="owner-alert-row" key={alert.id}>
            <span className={`owner-alert-dot ${alert.severity.toLowerCase()}`} />
            <div><strong>{alert.title}</strong><p>{alert.description}</p></div>
          </div>)}
          {!data.alerts.length ? <div className="owner-empty-state">All clear. New recorder and sales alerts will appear here.</div> : null}
        </article>
      </section>
      <p className="owner-data-note">Revenue reflects POS transactions only. AI-generated signals are review prompts, not verified employee performance measures.</p>
    </div>
  );
}
