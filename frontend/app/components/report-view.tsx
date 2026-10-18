'use client';

import Link from '@/lib/router-link';
import { useEffect, useState } from 'react';
import { apiGet, apiPost, type Store } from '../../lib/api';

type StoreListenerReport = {
  brand: string;
  report_date?: string;
  headline: string;
  store_name: string;
  store_location?: string;
  generated_at?: string;
  kpis: Record<string, { label: string; value: string; detail: string }>;
  executive_summary: string;
  key_points: string[];
  sentiment: { positive: number; neutral: number; negative: number; mixed: number; sample_size: number };
  actions_for_tomorrow: string[];
  interactions: {
    number: number;
    time: string;
    location: string;
    duration_seconds: number;
    sentiment: string;
    confidence?: number | null;
    transcript_summary: string;
    coaching_tip: string;
    customer_needs?: string[];
    products_discussed?: string[];
    opportunity_type?: string;
    conversation_id?: string;
  }[];
};

type ReportPayload = {
  reportType: string;
  reportStatus?: 'generated' | 'not_generated' | string;
  generatedAt?: string;
  business_date?: string;
  timezone?: string;
  dataMode?: string;
  pos_provider?: string;
  store_name?: string;
  store_listener?: StoreListenerReport;
  metrics?: Record<string, number | boolean | Record<string, number>>;
  daily_analysis?: {
    provider_summary?: { summary: string; findings: string[]; confidence: number; provider: string; status: string };
    sales_summary?: string;
    interaction_summary?: string;
  };
};

const sentimentRows = [
  { key: 'positive', label: 'Positive' },
  { key: 'neutral', label: 'Neutral' },
  { key: 'negative', label: 'Negative' },
  { key: 'mixed', label: 'Mixed' },
] as const;

function SentimentBreakdown({ sentiment }: { sentiment: StoreListenerReport['sentiment'] }) {
  if (!sentiment.sample_size) {
    return <p className="sl-no-sentiment">Not enough analyzed conversations for a reliable sentiment breakdown.</p>;
  }
  return (
    <div className="sl-sentiment">
      <div className="sl-sentiment-total"><strong>{sentiment.sample_size}</strong><span>analyzed</span></div>
      <ul className="sl-sentiment-rows">
        {sentimentRows.map(({ key, label }) => (
          <li key={key}>
            <span className={`sl-sentiment-label sl-sentiment-${key}`}>{label}</span>
            <span className="sl-sentiment-track"><i style={{ width: `${sentiment[key]}%` }} /></span>
            <strong>{sentiment[key]}%</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatBusinessDate(value?: string) {
  if (!value) return 'Business date unavailable';
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  }).format(date);
}

function formatDuration(seconds: number) {
  if (!seconds) return 'Duration unavailable';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

export function ReportView({ period }: { period: string }) {
  const [data, setData] = useState<ReportPayload | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState('');
  const [businessDate, setBusinessDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const kpiOrder = ['revenue', 'conversations', 'avg_ticket', 'missed', 'low_stock', 'redacted'];

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    apiGet<{ stores: { items: Store[] } }>('/api/v1/stores').then((result) => {
      setStores(result.stores.items);
      setStoreId((current) => current || search.get('store_id') || result.stores.items[0]?.id || '');
      setBusinessDate((current) => current || search.get('business_date') || '');
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Unable to load stores'));
  }, []);

  useEffect(() => {
    if (!storeId) return;
    let active = true;
    setData(null);
    setError('');
    const query = new URLSearchParams({ store_id: storeId });
    if (businessDate) query.set('business_date', businessDate);
    apiGet<ReportPayload>(`/api/v1/reports/${period}?${query}`).then((result) => {
      if (active) setData(result);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Unable to load report');
    });
    return () => { active = false; };
  }, [period, storeId, businessDate]);

  async function generateDailyReport() {
    if (!storeId) return;
    setBusy(true);
    setError('');
    try {
      const report = await apiPost<ReportPayload>('/api/v1/reports/daily/generate', {
        store_id: storeId,
        ...(businessDate ? { business_date: businessDate } : {}),
      });
      setData(report);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to generate daily report');
    } finally {
      setBusy(false);
    }
  }

  const sl = data?.store_listener;

  if (!data && !error) return <div className="skeleton" />;

  return (
    <div className="sl-report-page-root">
      <div className="sl-report-controls print-hide">
        <Link href="/reports" className="chip">← Reports</Link>
        <div>
          <span className="eyebrow">{period.toUpperCase()} REPORT</span>
          <h1 className="serif">Daily report</h1>
        </div>
        <div className="sl-report-filters">
          <label className="field" style={{ margin: 0 }}>Store
            <select className="search" value={storeId} onChange={(event) => setStoreId(event.target.value)}>
              {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
            </select>
          </label>
          {period === 'daily' ? (
            <label className="field" style={{ margin: 0 }}>Business date
              <input className="search" type="date" value={businessDate} onChange={(event) => setBusinessDate(event.target.value)} />
            </label>
          ) : null}
          {period === 'daily' ? (
            <button className="primary" onClick={() => void generateDailyReport()} disabled={busy || !storeId}>
              {busy ? 'Generating…' : data?.reportStatus === 'generated' ? 'Regenerate live report' : 'Generate live report'}
            </button>
          ) : null}
          <button className="ghost owner-button" onClick={() => window.print()} disabled={!sl}>Download / print PDF</button>
        </div>
      </div>
      {error ? <section className="error" role="alert"><p>{error}</p></section> : null}

      {sl ? (
        <article className="sl-report-document">
          <section className="sl-report-sheet sl-summary-sheet">
            <header className="sl-sheet-masthead">
              <span>{sl.generated_at ? new Date(sl.generated_at).toLocaleString() : formatBusinessDate(sl.report_date)}</span>
              <strong>{sl.brand}</strong>
              <span>01 / 02</span>
            </header>
            <div className="sl-report-intro">
              <p className="sl-brand">{sl.brand}</p>
              <h2>{sl.headline}</h2>
              <div className="sl-meta-strip">
                <strong>{sl.store_location || sl.store_name}</strong>
                <span>{formatBusinessDate(sl.report_date)}</span>
                <span>{sl.generated_at ? `Generated ${new Date(sl.generated_at).toLocaleString()}` : formatBusinessDate(sl.report_date)}</span>
              </div>
            </div>

            <section className="sl-kpi-grid" aria-label="Daily report metrics">
              {kpiOrder.map((key) => {
                const card = sl.kpis[key];
                if (!card) return null;
                return (
                  <article key={key} className={`sl-kpi sl-kpi-${key}`}>
                    <span>{card.label}</span>
                    <strong>{card.value}</strong>
                    <small>{card.detail}</small>
                  </article>
                );
              })}
            </section>

            <div className="sl-summary-grid">
              <div className="sl-summary-copy">
                <section className="sl-report-section">
                  <h3>Daily summary</h3>
                  <p>{sl.executive_summary}</p>
                </section>
                <section className="sl-report-section sl-key-points">
                  <h3><span className="sl-section-mark" />Key points</h3>
                  {sl.key_points.length ? (
                    <ul>{sl.key_points.map((point, index) => <li key={`${index}-${point}`}>{point}</li>)}</ul>
                  ) : <p>No key points were generated for this day.</p>}
                </section>
              </div>
              <div className="sl-summary-insights">
                <section className="sl-report-section">
                  <h3><span className="sl-section-mark sl-section-mark-purple" />Customer sentiment</h3>
                  <SentimentBreakdown sentiment={sl.sentiment} />
                </section>
                <section className="sl-report-section sl-tomorrow-actions">
                  <h3><span className="sl-section-mark" />Actions for tomorrow</h3>
                  {sl.actions_for_tomorrow.length ? (
                    <ol className="sl-actions">
                      {sl.actions_for_tomorrow.map((action, index) => (
                        <li key={`${index}-${action}`}><span>{index + 1}</span><p>{action}</p></li>
                      ))}
                    </ol>
                  ) : <p>No follow-up actions were generated.</p>}
                </section>
              </div>
            </div>
            <footer className="sl-sheet-footer"><span>{window.location.origin}/reports</span><span>1 / 2</span></footer>
          </section>

          <section className="sl-report-sheet sl-interactions-sheet">
            <header className="sl-sheet-masthead">
              <span>{sl.generated_at ? new Date(sl.generated_at).toLocaleString() : formatBusinessDate(sl.report_date)}</span>
              <strong>{sl.brand}</strong>
              <span>02 / 02</span>
            </header>
            <div className="sl-interactions-heading">
              <h2><span className="sl-section-mark sl-section-mark-blue" />Conversations &amp; transcripts</h2>
              <span>{sl.interactions.length} interactions</span>
            </div>
            <div className="sl-interactions">
              {sl.interactions.map((item) => (
                <article key={`${item.number}-${item.conversation_id || item.time}`} className="sl-interaction">
                  <header>
                    <span className="sl-interaction-number">{item.number}</span>
                    <div className="sl-interaction-title">
                      <strong>{item.time || 'Time unavailable'} · {item.location || sl.store_name}</strong>
                      <small>{formatDuration(item.duration_seconds)} · {item.sentiment} · {item.opportunity_type || 'opportunity not classified'}</small>
                    </div>
                    <span className="sl-interaction-index">{item.number} of {sl.interactions.length}</span>
                  </header>
                  <blockquote>“{item.transcript_summary}”</blockquote>
                  {(item.customer_needs?.length || item.products_discussed?.length) ? (
                    <div className="sl-interaction-tags">
                      {item.customer_needs?.map((need) => <span key={`need-${need}`}>Need: {need}</span>)}
                      {item.products_discussed?.map((product) => <span key={`product-${product}`}>{product}</span>)}
                    </div>
                  ) : null}
                  <p className="sl-coaching"><strong>Coaching:</strong> {item.coaching_tip}</p>
                  <footer>
                    <span>{item.confidence == null ? 'AI analysis unavailable' : `Analysis confidence ${Math.round(item.confidence * 100)}%`}</span>
                    {item.conversation_id ? <Link href={`/conversations/${encodeURIComponent(item.conversation_id)}`}>Open conversation</Link> : null}
                  </footer>
                </article>
              ))}
              {!sl.interactions.length ? <p className="sl-no-interactions">No conversations were recorded for this business day.</p> : null}
            </div>
            <footer className="sl-sheet-footer"><span>{window.location.origin}/reports</span><span>2 / 2</span></footer>
          </section>
        </article>
      ) : data ? (
        <section className="sl-live-report-status">
          <span className="eyebrow">LIVE REPORT SOURCES</span>
          <h2>Live report not generated yet</h2>
          <p>Only live-origin conversations and non-demo POS transactions are included. Generate the report after real AI analysis is configured.</p>
          <dl>
            <div><dt>Live conversations</dt><dd>{Number(data.metrics?.conversations ?? 0)}</dd></div>
            <div><dt>Transcript segments</dt><dd>{Number(data.metrics?.transcript_segments ?? 0)}</dd></div>
            <div><dt>POS source</dt><dd>{data.metrics?.sales_data_available === true ? `${data.pos_provider || 'Live provider'} · connected records` : 'Unavailable · revenue will show N/A'}</dd></div>
            <div><dt>AI analysis</dt><dd>{data.daily_analysis?.provider_summary?.provider || 'Not generated'}</dd></div>
          </dl>
        </section>
      ) : null}
    </div>
  );
}
