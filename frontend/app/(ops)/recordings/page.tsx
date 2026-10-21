'use client';

import Link from '@/lib/router-link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiBlob, apiDelete, apiGet, apiPost, BULK_DELETE_TIMEOUT_MS, type Store } from '../../../lib/api';
import { useConfirmDialog } from '../../components/confirm-dialog';

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

const MANAGE_ROLES = new Set(['SUPER_ADMIN', 'ORG_ADMIN', 'STORE_MANAGER']);

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
  const confirmDialog = useConfirmDialog();
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [conversationStatus, setConversationStatus] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<RecordingsResponse | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [canManage, setCanManage] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    apiGet<{ role: string }>('/api/v1/auth/me')
      .then((user) => { if (active) setCanManage(MANAGE_ROLES.has(user.role)); })
      .catch(() => { if (active) setCanManage(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    apiGet<{ stores: { items: Store[] } }>('/api/v1/stores?page_size=100').then((result) => {
      if (!active) return;
      setStores(result.stores.items);
      setStoreId((current) => current || result.stores.items[0]?.id || '');
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
      if (!active) return;
      setData(result);
      setSelectedIds((current) => current.filter((id) => result.recordings.some((row) => row.id === id)));
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Unable to load recordings');
    });
    return () => { active = false; };
  }, [conversationStatus, fromDate, page, reloadToken, storeId, stores.length, toDate]);

  useEffect(() => {
    if (!stores.length) return;
    const refreshTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, 5000);
    return () => window.clearInterval(refreshTimer);
  }, [reload, stores.length]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return data?.recordings ?? [];
    return (data?.recordings ?? []).filter((row) =>
      [row.id, row.store_name, row.conversation_id, row.transcript_snippet, row.speaker_role]
        .filter(Boolean).join(' ').toLowerCase().includes(needle),
    );
  }, [data, search]);

  const allFilteredSelected = filtered.length > 0 && filtered.every((row) => selectedIds.includes(row.id));

  function updateFilter(setter: (value: string) => void, value: string) {
    setter(value);
    setPage(1);
    setSelectedIds([]);
  }

  function toggleOne(id: string, checked: boolean) {
    setSelectedIds((current) => (
      checked ? Array.from(new Set([...current, id])) : current.filter((item) => item !== id)
    ));
  }

  function togglePage(checked: boolean) {
    if (!checked) {
      const pageIds = new Set(filtered.map((row) => row.id));
      setSelectedIds((current) => current.filter((id) => !pageIds.has(id)));
      return;
    }
    setSelectedIds((current) => Array.from(new Set([...current, ...filtered.map((row) => row.id)])));
  }

  async function deleteOne(recording: Recording) {
    const confirmed = await confirmDialog({
      title: 'Delete this recording?',
      message: 'Audio, transcript, and linked AI analysis for this conversation will be permanently removed.',
      subject: recording.conversation_id || recording.id,
      confirmLabel: 'Delete recording',
      tone: 'danger',
    });
    if (!confirmed) return;
    setBusy(true);
    setError('');
    try {
      await apiDelete(`/api/v1/recordings/${encodeURIComponent(recording.id)}`);
      setSelectedIds((current) => current.filter((id) => id !== recording.id));
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to delete recording');
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelected() {
    if (!selectedIds.length) return;
    const confirmed = await confirmDialog({
      title: `Delete ${selectedIds.length} selected recording${selectedIds.length === 1 ? '' : 's'}?`,
      message: 'Selected conversations and their audio/transcripts will be permanently removed.',
      subject: `${selectedIds.length} selected`,
      confirmLabel: 'Delete selected',
      tone: 'danger',
    });
    if (!confirmed) return;
    setBusy(true);
    setError('');
    try {
      await apiPost('/api/v1/recordings/bulk-delete', {
        recording_ids: selectedIds,
        confirm: 'DELETE',
      }, BULK_DELETE_TIMEOUT_MS);
      setSelectedIds([]);
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to delete selected recordings');
    } finally {
      setBusy(false);
    }
  }

  async function wipeStoreRecordings() {
    const storeName = stores.find((store) => store.id === storeId)?.name || storeId || 'all stores';
    const confirmed = await confirmDialog({
      title: 'Wipe all recordings?',
      message: storeId
        ? `This permanently deletes every recording and conversation for ${storeName}.`
        : 'This permanently deletes every recording and conversation in your scope.',
      subject: 'DELETE ALL RECORDINGS',
      confirmLabel: 'Wipe all',
      tone: 'danger',
    });
    if (!confirmed) return;
    setBusy(true);
    setError('');
    try {
      await apiPost('/api/v1/recordings/bulk-delete', {
        wipe_all: true,
        store_id: storeId || null,
        confirm: 'DELETE ALL RECORDINGS',
      }, BULK_DELETE_TIMEOUT_MS);
      setSelectedIds([]);
      setPage(1);
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to wipe recordings');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="owner-page recordings-page">
      <div className="heading">
        <div>
          <span className="eyebrow">RECORDINGS LIBRARY</span>
          <h1 className="serif">Recordings Library</h1>
          <p>View, select, and permanently delete historical conversations.</p>
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

      {canManage ? <section className="recordings-bulk-bar" aria-label="Recording deletion">
        <label className="recordings-select-all">
          <input
            type="checkbox"
            checked={allFilteredSelected}
            onChange={(event) => togglePage(event.target.checked)}
            disabled={!filtered.length || busy}
          />
          <span>Select page</span>
        </label>
        <span className="recordings-selected-count">{selectedIds.length} selected</span>
        <button className="ghost owner-button" type="button" disabled={!selectedIds.length || busy} onClick={() => void deleteSelected()}>
          Delete selected
        </button>
        <button className="ghost owner-button recordings-wipe-button" type="button" disabled={busy || !(data?.total)} onClick={() => void wipeStoreRecordings()}>
          Wipe store recordings
        </button>
      </section> : null}

      {error ? <section className="error" role="alert"><p>{error}</p></section> : null}
      {!data && !error ? <div className="skeleton" /> : null}
      {data ? <section className="panel recordings-table-wrap">
        <header className="recordings-table-heading"><strong>Recent Recordings</strong><span>{data.total} total</span></header>
        {filtered.length ? <table className="table recordings-table">
          <thead><tr>
            {canManage ? <th className="recordings-check-col">Select</th> : null}
            <th>Recording ID</th><th>Date &amp; time</th><th>Status</th><th>Transcript snippet</th><th>Actions</th>
          </tr></thead>
          <tbody>{filtered.map((recording) => <tr key={recording.id} className={selectedIds.includes(recording.id) ? 'is-selected' : undefined}>
            {canManage ? <td className="recordings-check-col">
              <input
                type="checkbox"
                checked={selectedIds.includes(recording.id)}
                onChange={(event) => toggleOne(recording.id, event.target.checked)}
                disabled={busy}
                aria-label={`Select recording ${recording.id}`}
              />
            </td> : null}
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
              {canManage ? <button className="ghost owner-button recordings-delete-button" type="button" disabled={busy} onClick={() => void deleteOne(recording)}>Delete</button> : null}
            </div></td>
          </tr>)}</tbody>
        </table> : <div className="empty recordings-empty"><strong>No recordings found</strong><p>Adjust the filters or check whether audio retention has expired.</p></div>}
        {data.pages > 1 ? <div className="recordings-pagination">
          <span>Page {data.page} of {data.pages} · {data.total} clips</span>
          <div>
            <button className="ghost owner-button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1 || busy}>Previous</button>
            <button className="ghost owner-button" onClick={() => setPage((current) => Math.min(data.pages, current + 1))} disabled={page >= data.pages || busy}>Next</button>
          </div>
        </div> : null}
      </section> : null}
      <p className="recordings-caveat">Deleting a recording permanently removes its conversation audio, transcript, and linked analysis for your store scope. Speaker labels are operator-selected, not voice identification.</p>
    </div>
  );
}
