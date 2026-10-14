'use client';

import Link from '@/lib/router-link';
import { useEffect, useMemo, useState } from 'react';
import { apiBlob, apiGet, type Store } from '../../../lib/api';

type Recording = {
  id: string;
  captured_at: string;
  duration_seconds: number;
  byte_size: number;
  speaker_role: string;
  store_id: string;
  store_name: string;
  conversation_id: string | null;
  conversation_status: string;
  transcript_snippet: string;
  analysis_status: 'analyzed' | 'unavailable' | 'pending';
  audio_available: boolean;
  playback_path: string;
  conversation_path: string | null;
};

type RecordingsResponse = {
  recordings: Recording[];
  page: number;
  page_size: number;
  total: number;
  pages: number;
};

function AudioPreview({ recording }: { recording: Recording }) {
  const [audioUrl, setAudioUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);

  async function loadAudio() {
    setLoading(true);
    setError('');
    try {
      const blob = await apiBlob(recording.playback_path);
      setAudioUrl(URL.createObjectURL(blob));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Audio could not be loaded');
    } finally {
      setLoading(false);
    }
  }

  if (!recording.audio_available) return <span className="recording-muted">Expired</span>;
  if (audioUrl) return <audio className="recording-audio" controls preload="none" src={audioUrl} aria-label={`Recording ${recording.id}`} />;
  return <span className="recording-play-cell">
    <button className="ghost owner-button" title={`Load audio for ${recording.id}`} onClick={() => void loadAudio()} disabled={loading}>
      {loading ? 'Loading…' : 'Play'}
    </button>
    {error ? <span className="recording-error" role="alert">{error}</span> : null}
  </span>;
}

export default function RecordingsPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [conversationStatus, setConversationStatus] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<RecordingsResponse | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    apiGet<{ stores: { items: Store[] } }>('/api/v1/stores?page_size=100').then((result) => {
      if (!active) return;
      setStores(result.stores.items);
      setStoreId(result.stores.items[0]?.id ?? '');
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Unable to load stores');
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!stores.length) return;
    let active = true;
    setError('');
    const query = new URLSearchParams({ page: String(page), page_size: '20' });
    if (storeId) query.set('store_id', storeId);
    if (fromDate) query.set('from_date', fromDate);
    if (toDate) query.set('to_date', toDate);
    if (conversationStatus) query.set('conversation_status', conversationStatus);
    apiGet<RecordingsResponse>(`/api/v1/recordings?${query}`).then((result) => {
      if (active) setData(result);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Unable to load recordings');
    });
    return () => { active = false; };
  }, [conversationStatus, fromDate, page, storeId, stores.length, toDate]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return data?.recordings ?? [];
    return (data?.recordings ?? []).filter((row) =>
      [row.id, row.store_name, row.conversation_id, row.transcript_snippet, row.speaker_role]
        .filter(Boolean).join(' ').toLowerCase().includes(needle),
    );
  }, [data, search]);

  function updateFilter(setter: (value: string) => void, value: string) {
    setter(value);
    setPage(1);
  }

  return (
    <div className="owner-page recordings-page">
      <div className="heading">
        <div>
          <span className="eyebrow">RECORDINGS LIBRARY</span>
          <h1 className="serif">Recordings Library</h1>
          <p>View and analyze historical conversations.</p>
        </div>
        <span className="recordings-total">{data?.total ?? 0} clips</span>
      </div>

      <section className="recordings-toolbar" aria-label="Recording filters">
        <label className="field">Store
          <select value={storeId} onChange={(event) => updateFilter(setStoreId, event.target.value)}>
            {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
          </select>
        </label>
        <label className="field">From
          <input type="date" value={fromDate} onChange={(event) => updateFilter(setFromDate, event.target.value)} />
        </label>
        <label className="field">To
          <input type="date" value={toDate} onChange={(event) => updateFilter(setToDate, event.target.value)} />
        </label>
        <label className="field">Conversation
          <select value={conversationStatus} onChange={(event) => updateFilter(setConversationStatus, event.target.value)}>
            <option value="">All states</option>
            <option value="LIVE">Live</option>
            <option value="ENDED">Ended</option>
          </select>
        </label>
        <label className="recordings-search-label">Search
          <input className="search" type="search" placeholder="ID, store, transcript…" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
      </section>

      {error ? <section className="error" role="alert"><p>{error}</p></section> : null}
      {!data && !error ? <div className="skeleton" /> : null}
      {data ? <section className="panel recordings-table-wrap">
        <header className="recordings-table-heading"><strong>Recent Recordings</strong><span>{data.total} total</span></header>
        {filtered.length ? <table className="table recordings-table">
          <thead><tr><th>Recording ID</th><th>Date &amp; time</th><th>Status</th><th>Transcript snippet</th><th>Actions</th></tr></thead>
          <tbody>{filtered.map((recording) => <tr key={recording.id}>
            <td>
              {recording.conversation_path
                ? <Link className="recording-id" href={recording.conversation_path}>{recording.id.slice(0, 14)}</Link>
                : <span className="recording-id">{recording.id.slice(0, 14)}</span>}
              <small>{recording.store_name} · {Math.round(recording.duration_seconds)} sec</small>
            </td>
            <td>{new Date(recording.captured_at).toLocaleString()}</td>
            <td><span className={`recording-state ${recording.conversation_status.toLowerCase()}`}>{recording.conversation_status}</span></td>
            <td className="recording-snippet">{recording.transcript_snippet || 'No transcript yet'}</td>
            <td><div className="recording-actions">
              {recording.conversation_path
                ? <Link className="recording-analysis-link" href={recording.conversation_path}>AI Analysis</Link>
                : <span className={`recording-analysis ${recording.analysis_status}`}><i />{recording.analysis_status}</span>}
              <AudioPreview recording={recording} />
            </div></td>
          </tr>)}</tbody>
        </table> : <div className="empty recordings-empty"><strong>No recordings found</strong><p>Adjust the filters or check whether audio retention has expired.</p></div>}
        {data.pages > 1 ? <div className="recordings-pagination">
          <span>Page {data.page} of {data.pages} · {data.total} clips</span>
          <div>
            <button className="ghost owner-button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1}>Previous</button>
            <button className="ghost owner-button" onClick={() => setPage((current) => Math.min(data.pages, current + 1))} disabled={page >= data.pages}>Next</button>
          </div>
        </div> : null}
      </section> : null}
      <p className="recordings-caveat">Audio access is limited to your store scope and the configured retention window. Speaker labels are operator-selected, not voice identification.</p>
    </div>
  );
}