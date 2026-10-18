'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../../../lib/api';
import { useConfirmDialog } from '../../components/confirm-dialog';

type PendingDevice = {
  id: string;
  name: string;
  store_id: string;
  store_name: string;
  store_city?: string;
  store_region?: string;
  status: string;
  approval_status: string;
  audio_source: string;
  version: string;
  last_heartbeat: string | null;
};

export default function StoreApprovalsPage() {
  const confirmDialog = useConfirmDialog();
  const [devices, setDevices] = useState<PendingDevice[]>([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const result = await apiGet<{ devices: PendingDevice[] }>('/api/v1/devices/pending');
      setDevices(result.devices);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load pending store approvals');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function decide(device: PendingDevice, action: 'approve' | 'reject') {
    const confirmed = await confirmDialog({
      title: action === 'approve' ? 'Approve this store device?' : 'Reject this store device?',
      message: action === 'approve'
        ? 'The desktop agent will be allowed to start recording and stream to Live Monitor.'
        : 'The desktop agent will remain blocked from recording.',
      subject: `${device.store_name} · ${device.name}`,
      confirmLabel: action === 'approve' ? 'Approve store' : 'Reject request',
      tone: action === 'reject' ? 'danger' : 'default',
    });
    if (!confirmed) return;
    setBusyId(device.id);
    setError('');
    try {
      await apiPost(`/api/v1/devices/${encodeURIComponent(device.id)}/${action}`, {});
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Unable to ${action} device`);
    } finally {
      setBusyId('');
    }
  }

  return (
    <div className="owner-page">
      <div className="heading">
        <div>
          <span className="eyebrow">STORE APPROVALS</span>
          <h1 className="serif">Pending store requests</h1>
          <p>New desktop devices are ready to record after secure registration. Rejected devices remain blocked.</p>
        </div>
        <button className="ghost owner-button" type="button" onClick={() => void load()} disabled={loading}>Refresh</button>
      </div>
      {error ? <section className="error" role="alert"><p>{error}</p></section> : null}
      {loading && !devices.length ? <div className="skeleton" /> : null}
      <section className="panel">
        <header className="recordings-table-heading"><strong>Pending requests</strong><span>{devices.length} waiting</span></header>
        {devices.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Store</th>
                <th>Device</th>
                <th>Source</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((device) => (
                <tr key={device.id}>
                  <td>
                    <strong>{device.store_name}</strong>
                    <small>{[device.store_city, device.store_region].filter(Boolean).join(', ') || device.store_id}</small>
                  </td>
                  <td>
                    <strong>{device.name}</strong>
                    <small>{device.id}</small>
                  </td>
                  <td>{device.audio_source}</td>
                  <td><span className="recording-state ended">{device.approval_status}</span></td>
                  <td>
                    <div className="recording-actions">
                      <button className="primary owner-button" type="button" disabled={busyId === device.id} onClick={() => void decide(device, 'approve')}>
                        Approve
                      </button>
                      <button className="ghost owner-button recordings-delete-button" type="button" disabled={busyId === device.id} onClick={() => void decide(device, 'reject')}>
                        Reject
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : !loading ? (
          <div className="empty"><strong>No pending store requests</strong><p>New desktop devices can record as soon as setup is complete.</p></div>
        ) : null}
      </section>
    </div>
  );
}
