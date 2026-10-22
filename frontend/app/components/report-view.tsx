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
    store_name?: string;
    full_transcript?: string;
  }[];
  store_breakdown?: {
    store_id: string;
    store_name: string;
    location: string;
    metrics: Record<string, number | boolean | Record<string, number>>;
  }[];
  opportunities?: {
    id: string;
    store_name: string;
    conversation_id: string | null;
    customer_intent: string;
    product: string;
    status: string;
    recommendation: string;
    manager_note: string;
    confidence: number | null;
    created_at: string | null;
  }[];
  low_stock_items?: {
    store_id: string;
    store_name: string;
    sku: string;
    name: string;
    quantity: number;
    par_level: number;
  }[];
  transactions?: {
    id: string;
    store_name: string;
    occurred_at: string | null;
    timezone: string;
    amount: number;
    currency: string;
    provider: string;
    items: { name: string; sku: string; quantity: number; unit_price: number | null }[];
  }[];
};

type ReportPayload = {
  reportType: string;
  store_id?: string;
  scope?: string;
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

function formatCurrency(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function formatRevenueByCurrency(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'N/A';
  const entries = Object.entries(value as Record<string, number>);
  if (!entries.length) return 'N/A';
  return entries.map(([currency, amount]) => formatCurrency(Number(amount), currency)).join(' · ');
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
  const allStoresReport = data?.scope === 'all_stores' || data?.store_id === 'all';

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
              {period === 'daily' && stores.length > 1 ? <option value="all">All stores combined</option> : null}
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
              <span>DAILY SUMMARY</span>
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
            {sl.store_breakdown?.length ? (
              <section className="sl-report-section sl-store-breakdown">
                <h3><span className="sl-section-mark sl-section-mark-blue" />Store-by-store summary</h3>
                <div className="sl-table-scroll"><table className="sl-detail-table">
                  <thead><tr><th>Store</th><th>Conversations</th><th>POS sales</th><th>POS revenue</th><th>Opportunities</th><th>Low stock</th></tr></thead>
                  <tbody>{sl.store_breakdown.map((item) => <tr key={item.store_id}>
                    <th>{item.store_name}{item.location ? <small>{item.location}</small> : null}</th>
                    <td>{Number(item.metrics.conversations || 0)}</td>
                    <td>{item.metrics.sales_data_available ? Number(item.metrics.sales_count || 0) : 'N/A'}</td>
                    <td>{item.metrics.sales_data_available ? formatRevenueByCurrency(item.metrics.revenue_by_currency) : 'N/A'}</td>
                    <td>{Number(item.metrics.sales_opportunities || 0)}</td>
                    <td>{Number(item.metrics.low_stock || 0)}</td>
                  </tr>)}</tbody>
                </table></div>
              </section>
            ) : null}
            <footer className="sl-sheet-footer"><span>{window.location.origin}/reports</span><span>Summary</span></footer>
          </section>

          <section className="sl-report-sheet sl-interactions-sheet">
            <header className="sl-sheet-masthead">
              <span>{sl.generated_at ? new Date(sl.generated_at).toLocaleString() : formatBusinessDate(sl.report_date)}</span>
              <strong>{sl.brand}</strong>
              <span>DAILY DETAILS</span>
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
                      <strong>{item.time || 'Time unavailable'} · {item.store_name ? `${item.store_name} · ` : ''}{item.location || sl.store_name}</strong>
                      <small>{formatDuration(item.duration_seconds)} · {item.sentiment} · {item.opportunity_type || 'opportunity not classified'}</small>
                    </div>
                    <span className="sl-interaction-index">{item.number} of {sl.interactions.length}</span>
                  </header>
                  <blockquote>“{item.transcript_summary}”</blockquote>
                  {allStoresReport && item.full_transcript ? <pre className="sl-full-transcript">{item.full_transcript}</pre> : null}
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
            {allStoresReport ? (
              <section className="sl-report-section sl-transactions-section">
                <h2><span className="sl-section-mark" />Sales transactions</h2>
                <p>Verified live POS transactions captured across the included stores.</p>
                {sl.transactions?.length ? <div className="sl-table-scroll"><table className="sl-detail-table sl-transaction-table">
                  <thead><tr><th>Time</th><th>Store</th><th>Items</th><th>Amount</th><th>POS source</th></tr></thead>
                  <tbody>{sl.transactions.map((transaction) => <tr key={transaction.id}>
                    <td>{transaction.occurred_at ? new Intl.DateTimeFormat(undefined, { timeZone: transaction.timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(transaction.occurred_at)) : 'Time unavailable'}<small>{transaction.id}</small></td>
                    <td>{transaction.store_name}</td>
                    <td>{transaction.items.length ? transaction.items.map((item, index) => <span key={`${item.sku}-${index}`}>{item.quantity > 1 ? `${item.quantity} × ` : ''}{item.name}{item.sku ? ` (${item.sku})` : ''}{item.unit_price !== null ? ` · ${formatCurrency(item.unit_price, transaction.currency)}` : ''}{index < transaction.items.length - 1 ? ', ' : ''}</span>) : 'Item details unavailable'}</td>
                    <td>{formatCurrency(transaction.amount, transaction.currency)}</td>
                    <td>{transaction.provider}</td>
                  </tr>)}</tbody>
                </table></div> : <p>No verified live POS transactions were recorded.</p>}
              </section>
            ) : null}
            {allStoresReport ? (
              <section className="sl-report-section sl-transactions-section">
                <h2><span className="sl-section-mark sl-section-mark-purple" />Opportunity and activity log</h2>
                {sl.opportunities?.length ? <div className="sl-table-scroll"><table className="sl-detail-table">
                  <thead><tr><th>Store</th><th>Activity / intent</th><th>Product</th><th>Status</th><th>Follow-up</th><th>Conversation</th></tr></thead>
                  <tbody>{sl.opportunities.map((item) => <tr key={item.id}>
                    <td>{item.store_name}</td>
                    <td>{item.customer_intent || 'Opportunity recorded'}{item.manager_note ? <small>Review note: {item.manager_note}</small> : null}</td>
                    <td>{item.product || 'Not specified'}</td>
                    <td>{item.status}{item.confidence !== null ? <small>{Math.round(item.confidence * 100)}% confidence</small> : null}</td>
                    <td>{item.recommendation || 'No follow-up recorded'}</td>
                    <td>{item.conversation_id || 'Not linked'}</td>
                  </tr>)}</tbody>
                </table></div> : <p>No verified opportunities or activity records were available.</p>}
              </section>
            ) : null}
            {allStoresReport && sl.low_stock_items?.length ? (
              <section className="sl-report-section sl-transactions-section">
                <h2><span className="sl-section-mark" />Low-stock inventory snapshot</h2>
                <p>Inventory levels at report generation time.</p>
                <div className="sl-table-scroll"><table className="sl-detail-table">
                  <thead><tr><th>Store</th><th>SKU</th><th>Item</th><th>On hand</th><th>Par level</th></tr></thead>
                  <tbody>{sl.low_stock_items.map((item, index) => <tr key={`${item.store_id}-${item.sku}-${index}`}>
                    <td>{item.store_name}</td><td>{item.sku || '—'}</td><td>{item.name}</td><td>{item.quantity}</td><td>{item.par_level}</td>
                  </tr>)}</tbody>
                </table></div>
              </section>
            ) : null}
            <footer className="sl-sheet-footer"><span>{window.location.origin}/reports</span><span>Details</span></footer>
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
