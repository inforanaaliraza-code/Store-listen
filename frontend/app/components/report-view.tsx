'use client';

import Link from '@/lib/router-link';
import { useEffect, useMemo, useState } from 'react';
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
  sentiment: { positive: number; neutral: number; negative: number };
  actions_for_tomorrow: string[];
  interactions: {
    number: number;
    time: string;
    location: string;
    duration_seconds: number;
    sentiment: string;
    score: number;
    transcript_summary: string;
    coaching_tip: string;
  }[];
};

type ReportPayload = {
  reportType: string;
  reportStatus?: string;
  generatedAt?: string;
  business_date?: string;
  timezone?: string;
  store_name?: string;
  store_listener?: StoreListenerReport;
  metrics?: Record<string, unknown>;
  daily_analysis?: {
    provider_summary?: { summary: string; findings: string[]; confidence: number; provider: string; status: string };
    sales_summary?: string;
    interaction_summary?: string;
  };
};

function SentimentDonut({ sentiment }: { sentiment: StoreListenerReport['sentiment'] }) {
  const positive = sentiment.positive || 0;
  const neutral = sentiment.neutral || 0;
  const negative = Math.max(0, 100 - positive - neutral);
  const gradient = `conic-gradient(#2f9d6a 0% ${positive}%, #c9a227 ${positive}% ${positive + neutral}%, #c45c4a ${positive + neutral}% 100%)`;
  return (
    <div className="sl-sentiment">
      <div className="sl-sentiment-donut" style={{ background: gradient }} aria-hidden="true">
        <span>Sentiment</span>
      </div>
      <ul>
        <li><i className="pos" /> Positive {positive}%</li>
        <li><i className="neu" /> Neutral {neutral}%</li>
        <li><i className="neg" /> Negative {negative}%</li>
      </ul>
    </div>
  );
}

export function ReportView({ period }: { period: string }) {
  const [data, setData] = useState<ReportPayload | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState('');
  const [businessDate, setBusinessDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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
  const kpiOrder = useMemo(() => ['revenue', 'missed', 'conversations', 'avg_ticket', 'low_stock', 'redacted'], []);

  if (!data && !error) return <div className="skeleton" />;

  return (
    <div className="sl-report-page">
      <Link href="/reports" className="chip print-hide">← Reports</Link>
      <div className="heading print-hide">
        <div>
          <span className="eyebrow">{period.toUpperCase()} REPORT</span>
          <h1 className="serif">STORE LISTENER daily report</h1>
          <p>Select a date, run AI analysis across the full day, then download the PDF.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
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
            <button className="primary" style={{ width: 'auto' }} onClick={() => void generateDailyReport()} disabled={busy || !storeId}>
              {busy ? 'Running AI…' : data?.reportStatus === 'generated' ? 'Re-run AI analysis' : 'Run AI analysis'}
            </button>
          ) : null}
          <button className="ghost owner-button" onClick={() => window.print()}>Download PDF</button>
        </div>
      </div>
      {error ? <section className="error" role="alert"><p>{error}</p></section> : null}

      {sl ? (
        <article className="sl-report">
          <header className="sl-report-header">
            <div>
              <p className="sl-brand">{sl.brand}</p>
              <h2>Daily Report · {sl.report_date}</h2>
            </div>
            <div className="sl-report-meta">
              <strong>{sl.store_name}</strong>
              <span>{sl.store_location || 'Store location'}</span>
              <span>Generated {sl.generated_at ? new Date(sl.generated_at).toLocaleString() : '—'}</span>
            </div>
          </header>
          <p className="sl-headline">{sl.headline}</p>

          <section className="sl-kpi-grid" aria-label="Summary KPI cards">
            {kpiOrder.map((key) => {
              const card = sl.kpis[key];
              if (!card) return null;
              return (
                <article key={key} className="sl-kpi">
                  <span>{card.label}</span>
                  <strong>{card.value}</strong>
                  <small>{card.detail}</small>
                </article>
              );
            })}
          </section>

          <section className="sl-section">
            <h3>Daily executive summary</h3>
            <p>{sl.executive_summary}</p>
            <h4>Key points</h4>
            <ul>{(sl.key_points || []).map((point) => <li key={point}>{point}</li>)}</ul>
          </section>

          <section className="sl-section sl-split">
            <div>
              <h3>Customer sentiment</h3>
              <SentimentDonut sentiment={sl.sentiment} />
            </div>
            <div>
              <h3>Actions for tomorrow</h3>
              <ol className="sl-actions">
                {(sl.actions_for_tomorrow || []).map((action, index) => (
                  <li key={`${index}-${action}`}><span>{index + 1}</span><p>{action}</p></li>
                ))}
              </ol>
            </div>
          </section>

          <section className="sl-section">
            <h3>Conversations &amp; transcripts</h3>
            <div className="sl-interactions">
              {(sl.interactions || []).map((item) => (
                <article key={`${item.number}-${item.conversation_id || item.time}`} className="sl-interaction">
                  <header>
                    <strong>Interaction {item.number}</strong>
                    <span>{item.time} · {item.location}</span>
                    <span>{item.duration_seconds ? `${item.duration_seconds}s` : '—'} · {item.sentiment} · Score {item.score}</span>
                  </header>
                  <blockquote>“{item.transcript_summary}”</blockquote>
                  <p className="sl-coaching"><strong>Coaching:</strong> {item.coaching_tip}</p>
                </article>
              ))}
              {!sl.interactions?.length ? <p className="muted">No interaction cards were generated for this business day.</p> : null}
            </div>
          </section>
        </article>
      ) : data ? (
        <section className="panel">
          <p>This report was generated before the STORE LISTENER format. Click <strong>Run AI analysis</strong> to rebuild it.</p>
          <p className="muted">{data.daily_analysis?.provider_summary?.summary || data.daily_analysis?.sales_summary || 'No summary available.'}</p>
        </section>
      ) : null}
    </div>
  );
}
