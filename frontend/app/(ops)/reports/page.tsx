'use client';

import Link from '@/lib/router-link';
import { useEffect, useState } from 'react';
import { apiGet, apiPost, type Store } from '../../../lib/api';

type ReportHistoryItem = { id: string; store_id: string | null; store_name: string; business_date: string | null; generated_at: string | null; summary: string; report_status: string };

export default function ReportsIndex() {
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState('');
  const [history, setHistory] = useState<ReportHistoryItem[]>([]);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');

  async function loadHistory(id = storeId) {
    if (!id) return;
    try {
      const result = await apiGet<{ reports: ReportHistoryItem[] }>(`/api/v1/reports/history?store_id=${encodeURIComponent(id)}`);
      setHistory(result.reports);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load report history'); }
  }

  useEffect(() => {
    apiGet<{ stores: { items: Store[] } }>('/api/v1/stores?page_size=100').then((result) => {
      setStores(result.stores.items);
      setStoreId(result.stores.items[0]?.id ?? '');
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Unable to load stores'));
  }, []);

  useEffect(() => {
    if (!storeId) return;
    let active = true;
    apiGet<{ reports: ReportHistoryItem[] }>(`/api/v1/reports/history?store_id=${encodeURIComponent(storeId)}`).then((result) => {
      if (active) setHistory(result.reports);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Unable to load report history');
    });
    return () => { active = false; };
  }, [storeId]);

  async function regenerate(report: ReportHistoryItem) {
    if (!report.store_id) return;
    setBusyId(report.id);
    setError('');
    try {
      await apiPost('/api/v1/reports/daily/generate', { store_id: report.store_id, business_date: report.business_date });
      await loadHistory();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to regenerate report'); }
    finally { setBusyId(''); }
  }

  return (
    <div className="owner-page">
      <div className="heading"><div><span className="eyebrow">SHOP OWNER</span><h1 className="serif">Reports</h1><p>Daily AI briefings from conversations and POS data.</p></div>
        <label className="owner-select-label">Report scope<select value={storeId} onChange={(event) => setStoreId(event.target.value)} aria-label="Choose report scope">{stores.length > 1 ? <option value="all">All stores combined</option> : null}{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
      </div>
      {error ? <div className="error" role="alert">{error}</div> : null}
      <section className="owner-report-types">
        <Link className="owner-report-type" href={`/reports/daily${storeId ? `?store_id=${encodeURIComponent(storeId)}` : ''}`}>
          <span className="eyebrow">DAILY</span>
          <h2>Daily report</h2>
          <p>Briefing, conversation signals, sales, and actions for {storeId === 'all' ? 'all accessible stores' : 'a selected store'}.</p>
          <span>Open report →</span>
        </Link>
      </section>
      <section className="owner-panel owner-history-panel">
        <div className="owner-panel-heading"><div><span className="eyebrow">SAVED BRIEFINGS</span><h2>Report history</h2><p>Generated daily reports for {storeId === 'all' ? 'all accessible stores combined' : stores.find((store) => store.id === storeId)?.name ?? 'this store'}.</p></div></div>
        {history.length ? <div className="owner-history-list">{history.map((report) => <article className="owner-history-row" key={report.id}>
          <div className="owner-history-date"><strong>{report.business_date ? new Date(`${report.business_date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : 'Daily report'}</strong><small>{report.generated_at ? `Generated ${new Date(report.generated_at).toLocaleString()}` : report.store_name}</small></div>
          <span className="owner-status is-online"><i />Ready</span>
          <p>{report.summary || 'Daily performance summary is ready to review.'}</p>
          <div className="owner-history-actions"><Link className="ghost owner-button" href={`/reports/daily?store_id=${encodeURIComponent(report.store_id ?? storeId)}${report.business_date ? `&business_date=${report.business_date}` : ''}`}>Open</Link><button className="ghost owner-button" onClick={() => void regenerate(report)} disabled={busyId === report.id}>{busyId === report.id ? 'Generating…' : 'Regenerate'}</button></div>
        </article>)}</div> : <div className="owner-empty-state"><strong>No saved reports yet</strong><p>Generate the first daily briefing to start a report history for this store.</p><Link href={`/reports/daily${storeId ? `?store_id=${encodeURIComponent(storeId)}` : ''}`}>Open daily report</Link></div>}
      </section>
    </div>
  );
}
