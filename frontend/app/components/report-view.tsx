'use client';

import Link from '@/lib/router-link';
import { useEffect, useState } from 'react';
import { apiGet, apiPost, type Store } from '../../lib/api';

type ReportPayload = {
  reportType: string;
  reportStatus?: string;
  generatedAt?: string;
  business_date?: string;
  timezone?: string;
  pos_provider?: string;
  caveat?: string;
  metrics?: Record<string, unknown>;
  daily_analysis?: {
    top_intents?: { intent: string; count: number }[];
    potential_product_mentions?: { product: string; count: number; unattributed_clips: number }[];
    ai_analysis_runs?: number;
    interaction_summary?: string;
    staff_interaction_signals?: {
      labeled_staff_clips: number;
      clips_with_question_marks: number;
      brief_acknowledgement_clips: number;
      coverage: string;
      caveat: string;
    };
    sales_summary?: string;
    potential_unconverted_opportunities?: number;
    caveat?: string;
    provider_summary?: { summary: string; findings: string[]; confidence: number; provider: string; status: string };
  };
};

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

  if (!data && !error) return <div className="skeleton" />;
  const metrics = data?.metrics ?? {};
  const analysis = data?.daily_analysis;
  const revenue = metrics.revenue_by_currency as Record<string, number> | undefined;
  const revenueLabel = revenue && Object.keys(revenue).length
    ? Object.entries(revenue).map(([currency, amount]) => {
      try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount); }
      catch { return `${currency} ${amount.toFixed(2)}`; }
    }).join(' / ')
    : '—';
  const value = (key: string) => typeof metrics[key] === 'number' ? metrics[key] as number : 0;
  return (
    <div>
      <Link href="/reports" className="chip">← Reports</Link>
      <div className="heading">
        <div><span className="eyebrow">{period.toUpperCase()} REPORT</span><h1 className="serif">{period} performance</h1><p>{data?.timezone ? `Business day: ${data.business_date} · ${data.timezone}` : 'Store-local reporting period'}</p></div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
          <label className="field" style={{ margin: 0 }}>Store<select className="search" value={storeId} onChange={(event) => setStoreId(event.target.value)}>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
          {period === 'daily' ? <label className="field" style={{ margin: 0 }}>Business date<input className="search" type="date" value={businessDate} onChange={(event) => setBusinessDate(event.target.value)} /></label> : null}
          {period === 'daily' ? <button className="primary" style={{ width: 'auto' }} onClick={() => void generateDailyReport()} disabled={busy || !storeId}>{busy ? 'Generating…' : data?.reportStatus === 'generated' ? 'Regenerate report' : 'Generate daily report'}</button> : null}
          <button className="ghost owner-button print-hide" onClick={() => window.print()}>Download PDF</button>
        </div>
      </div>
      {error ? <section className="error" role="alert"><p>{error}</p></section> : null}
      {data ? <>
        <section className="metrics">
          <article className="metric"><span>Conversations</span><strong className="serif">{value('conversations')}</strong></article>
          <article className="metric"><span>POS sales</span><strong className="serif">{value('sales_count')}</strong></article>
          <article className="metric"><span>Revenue · {data.pos_provider ?? 'POS data'}</span><strong className="serif">{revenueLabel}</strong></article>
          <article className="metric"><span>Potential opportunities</span><strong className="serif">{value('sales_opportunities')}</strong></article>
          <article className="metric"><span>Converted</span><strong className="serif">{value('converted_opportunities')}</strong></article>
          <article className="metric"><span>Potential missed</span><strong className="serif">{value('potential_missed_opportunities')}</strong></article>
          <article className="metric"><span>Audio clips · minutes</span><strong className="serif">{value('audio_recordings')} · {(value('recorded_seconds') / 60).toFixed(1)}</strong></article>
          <article className="metric"><span>Transcript clips</span><strong className="serif">{value('transcript_segments')}</strong></article>
        </section>
        <section className="grid-2" style={{ marginTop: 16 }}>
          <article className="panel">
            <span className="eyebrow">END-OF-DAY ANALYSIS</span>
            <h2 className="serif">Sales and service summary</h2>
            {analysis?.provider_summary ? <>
              <p>{analysis.provider_summary.summary}</p>
              <small>{analysis.provider_summary.provider} · {analysis.provider_summary.status} · {Math.round(analysis.provider_summary.confidence * 100)}% confidence</small>
              {analysis.provider_summary.findings.map((finding, index) => <div className="row" key={`${index}-${finding}`}>{finding}</div>)}
            </> : <p className="banner">Live metrics preview. Generate the daily report to save its AI-assisted summary.</p>}
            <p>{analysis?.sales_summary ?? 'Generate the daily report to save the end-of-day analysis.'}</p>
            <p>{analysis?.interaction_summary ?? ''}</p>
            {analysis?.staff_interaction_signals ? <>
              <div className="row"><span>Operator-labeled staff clips</span><strong>{analysis.staff_interaction_signals.labeled_staff_clips}</strong></div>
              <div className="row"><span>Clips with a question mark</span><strong>{analysis.staff_interaction_signals.clips_with_question_marks}</strong></div>
              <div className="row"><span>Brief acknowledgements</span><strong>{analysis.staff_interaction_signals.brief_acknowledgement_clips}</strong></div>
              <p className="banner">{analysis.staff_interaction_signals.coverage === 'insufficient_staff_attribution' ? 'Not enough staff-attributed speech to summarize interactions.' : analysis.staff_interaction_signals.caveat}</p>
            </> : null}
            <p className="banner">{analysis?.caveat ?? data.caveat}</p>
          </article>
          <article className="panel">
            <span className="eyebrow">CUSTOMER INTEREST</span>
            <h2 className="serif">Top detected intents</h2>
            {analysis?.top_intents?.length ? analysis.top_intents.map((item) => <div className="row" key={item.intent}><span>{item.intent}</span><strong>{item.count}</strong></div>) : <div className="empty"><p>No attributed customer intents in this period.</p></div>}
            <h3 style={{ marginTop: 20 }}>Transcript text signals</h3>
            {analysis?.potential_product_mentions?.length ? analysis.potential_product_mentions.map((item) => <div className="row" key={item.product}><span>{item.product} · {item.unattributed_clips} unattributed</span><strong>{item.count} clips</strong></div>) : <p style={{ color: 'var(--muted)' }}>No product phrases detected.</p>}
            <small>Text matches do not confirm who spoke or whether the person intended to purchase.</small>
            <small>{analysis?.ai_analysis_runs ?? 0} clip-level AI analyses · daily summary provider: {analysis?.provider_summary?.provider ?? 'not generated yet'}</small>
          </article>
        </section>
        <p className="banner" style={{ marginTop: 16 }}>Revenue is summed from the configured POS feed ({data.pos_provider ?? 'provider not reported'}). Mock/demo POS data is not a real store revenue figure. A missing POS sale is not proof of why a customer did not purchase.</p>
      </> : null}
    </div>
  );
}
