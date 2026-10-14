'use client';

import Link from '@/lib/router-link';
import { useParams } from '@/lib/router-hooks';
import { useEffect, useState } from 'react';
import { apiGet, type Store } from '../../../../lib/api';

export default function StoreDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [store, setStore] = useState<(Store & { conversations?: unknown[] }) | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    apiGet<Store>(`/api/v1/stores/${id}`).then(setStore).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Error'));
  }, [id]);
  if (error) return <section className="error"><p>{error}</p></section>;
  if (!store) return <div className="skeleton" />;
  const device = store.device;
  return (
    <div>
      <Link href="/stores" className="chip">← Stores</Link>
      <div className="heading">
        <div>
          <span className="eyebrow">{store.city}, {store.region}</span>
          <h1 className="serif">{store.name}</h1>
          <p>{store.employees} associates · {store.open_conversations} live conversations</p>
        </div>
        <span className={`pill ${store.online ? 'ok' : 'warn'}`}>{store.online ? 'Online' : 'Offline'}</span>
      </div>
      <article className="panel">
        <h2 className="serif">Device health</h2>
        {device ? (
          <>
            <div className="row"><span>Device</span><strong>{device.id}</strong></div>
            <div className="row"><span>Status</span><strong>{device.status}</strong></div>
            <div className="row"><span>Audio</span><strong>{device.audio_status}</strong></div>
            <div className="row"><span>Microphone</span><strong>{device.microphone_status}</strong></div>
            <div className="row"><span>Stream</span><strong>{device.stream_status}</strong></div>
            <div className="row"><span>Latency</span><strong>{device.processing_latency_ms} ms</strong></div>
            <div className="row"><span>Version</span><strong>{device.version}</strong></div>
          </>
        ) : <p>No device registered.</p>}
      </article>
    </div>
  );
}
