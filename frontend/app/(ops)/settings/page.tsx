'use client';

import Link from '@/lib/router-link';
import { usePathname } from '@/lib/router-hooks';
import { useCallback, useEffect, useState } from 'react';
import { apiGet, type Store } from '../../../lib/api';

const tabs = [
  { href: '/settings', label: 'Overview', key: 'overview' },
  { href: '/settings/stores', label: 'Stores', key: 'stores' },
  { href: '/settings/devices', label: 'Devices', key: 'devices' },
  { href: '/settings/integrations', label: 'Integrations', key: 'integrations' },
  { href: '/settings/users', label: 'Users', key: 'users' },
  { href: '/settings/ai', label: 'AI', key: 'ai' },
  { href: '/settings/security', label: 'Security', key: 'security' },
];

type SettingsData = {
  demo_mode: boolean;
  providers: Record<string, string>;
  retention: { audio_days: number; transcript_days: number; raw_audio_stored_by_default: boolean };
  stores: Store[];
  devices: {
    id: string; store_id: string; status: string; audio_source: string; version: string;
    cpu_pct: number; memory_pct: number; audio_status: string; microphone_status: string;
    stream_status: string;
  }[];
  integrations: { kind: string; provider: string; status: string; notes: string | null }[];
  users: { id: string; email: string; full_name: string; role: string; store_id: string | null }[];
  roles: string[];
  ai: { provider: string; speech_provider: string; supports_original_transcript: boolean; supports_english_translation: boolean; provider_note: string };
  security: Record<string, string | boolean>;
};

function Status({ value }: { value: string }) {
  const healthy = ['connected', 'online', 'active', 'enabled', 'complete'].includes(value.toLowerCase());
  return <span className={`settings-status ${healthy ? 'healthy' : 'neutral'}`}><i />{value.replaceAll('_', ' ')}</span>;
}

export default function SettingsPage() {
  const pathname = usePathname();
  const [data, setData] = useState<SettingsData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      setData(await apiGet<SettingsData>('/api/v1/settings', { signal }));
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : 'Unable to load settings');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const activeTab = tabs.find((tab) => tab.key !== 'overview' && pathname.startsWith(tab.href)) ?? tabs[0];
  const active = activeTab.key;

  return (
    <div className="settings-page">
      <div className="heading">
        <div>
          <span className="eyebrow">CONFIGURATION</span>
          <h1 className="serif">{activeTab.label === 'Overview' ? 'Settings' : activeTab.label}</h1>
          <p>{active === 'overview' ? 'Review your store setup, connected systems, and account safeguards.' : `Review ${activeTab.label.toLowerCase()} configuration for this workspace.`}</p>
        </div>
        <button className="ghost owner-button" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh status'}</button>
      </div>
      <div className="settings-notice"><strong>{data?.demo_mode ? 'Demo configuration' : 'Workspace configuration'}</strong><span>These settings are read-only here. Changes to providers, access, or retention require an approved production setup.</span></div>
      <nav className="settings-tabs" aria-label="Settings sections">
        {tabs.map((tab) => (
          <Link aria-current={active === tab.key ? 'page' : undefined} className={`settings-tab${active === tab.key ? ' active' : ''}`} key={tab.href} href={tab.href}>{tab.label}</Link>
        ))}
      </nav>
      {error ? <section className="error" role="alert"><p>{error}</p><button className="ghost owner-button" onClick={() => void load()}>Retry</button></section> : null}
      {loading && !data ? <div className="skeleton" role="status" aria-label="Loading settings" /> : null}
      {data && active === 'overview' ? <>
        <section className="settings-summary-grid">
          <article className="settings-summary"><span>Stores</span><strong>{data.stores.length}</strong><small>Available in your account</small></article>
          <article className="settings-summary"><span>Recorders</span><strong>{data.devices.filter((device) => device.status === 'connected').length}<small> / {data.devices.length}</small></strong><small>Currently connected</small></article>
          <article className="settings-summary"><span>Integrations</span><strong>{data.integrations.filter((item) => item.status.toLowerCase() === 'connected').length}</strong><small>Connected providers</small></article>
          <article className="settings-summary"><span>Data retention</span><strong>{data.retention.audio_days}<small> days</small></strong><small>Audio clips · transcripts {data.retention.transcript_days} days</small></article>
        </section>
        <section className="settings-overview-grid">
          <article className="settings-panel">
            <div className="settings-panel-head"><div><span className="eyebrow">WORKSPACE</span><h2>Setup at a glance</h2></div></div>
            <div className="settings-setup-list">
              <Link href="/settings/stores"><span className="settings-step">01</span><span><strong>Stores</strong><small>{data.stores.length} stores · confirm locations and devices</small></span><b>→</b></Link>
              <Link href="/settings/devices"><span className="settings-step">02</span><span><strong>Recording computers</strong><small>{data.devices.length ? `${data.devices.filter((device) => device.status === 'connected').length} of ${data.devices.length} connected` : 'No recorders registered yet'}</small></span><b>→</b></Link>
              <Link href="/settings/integrations"><span className="settings-step">03</span><span><strong>Integrations</strong><small>Check POS and provider connections</small></span><b>→</b></Link>
              <Link href="/settings/users"><span className="settings-step">04</span><span><strong>Team access</strong><small>{data.users.length} visible accounts · role-based access</small></span><b>→</b></Link>
            </div>
          </article>
          <article className="settings-panel">
            <div className="settings-panel-head"><div><span className="eyebrow">ACTIVE PROVIDERS</span><h2>Speech and intelligence</h2></div><Link href="/settings/ai">Details</Link></div>
            <div className="settings-provider-list">
              <div><span>Speech recognition</span><strong>{data.providers.speech}</strong><Status value="active" /></div>
              <div><span>AI analysis</span><strong>{data.providers.ai}</strong><Status value={data.providers.ai === 'mock' ? 'demo' : 'configured'} /></div>
              <div><span>POS connection</span><strong>{data.providers.pos}</strong><Status value={data.providers.pos === 'mock' ? 'demo' : 'configured'} /></div>
              <div><span>Audio storage</span><strong>{data.providers.storage}</strong><Status value="active" /></div>
            </div>
          </article>
        </section>
      </> : null}

      {data && active === 'stores' ? <section className="settings-panel">
        <div className="settings-panel-head"><div><span className="eyebrow">STORE DIRECTORY</span><h2>Your locations</h2><p>Each location has its own conversations, team, and recorder status.</p></div><Link className="ghost owner-button" href="/stores">Manage stores</Link></div>
        <div className="settings-record-list">{data.stores.map((store) => <article className="settings-record" key={store.id}>
          <div className="settings-record-main"><strong>{store.name}</strong><small>{store.city}, {store.region} · {store.timezone}</small></div>
          <Status value={store.online ? 'online' : 'offline'} />
          <span className="settings-inline-meta">{store.employees} team · {store.open_conversations} live</span>
          <Link href={`/stores/${store.id}`}>Open store →</Link>
        </article>)}</div>
      </section> : null}

      {data && active === 'devices' ? <section className="settings-panel">
        <div className="settings-panel-head"><div><span className="eyebrow">RECORDER HEALTH</span><h2>Recording computers</h2><p>Connection, microphone, audio stream, and system load.</p></div><Link className="ghost owner-button" href="/live">Open live monitor</Link></div>
        {data.devices.length ? <div className="settings-record-list">{data.devices.map((device) => <article className="settings-device" key={device.id}>
          <div className="settings-record-main"><strong>{data.stores.find((store) => store.id === device.store_id)?.name ?? device.store_id}</strong><small>{device.id} · {device.audio_source} · v{device.version}</small></div>
          <Status value={device.status} />
          <div className="settings-device-health"><span>Microphone <Status value={device.microphone_status} /></span><span>Audio <Status value={device.audio_status} /></span><span>Stream <Status value={device.stream_status} /></span></div>
          <div className="settings-meter"><span>CPU</span><meter min="0" max="100" value={device.cpu_pct} /><strong>{Math.round(device.cpu_pct)}%</strong><span>Memory</span><meter min="0" max="100" value={device.memory_pct} /><strong>{Math.round(device.memory_pct)}%</strong></div>
        </article>)}</div> : <div className="settings-empty"><strong>No recorders registered</strong><p>Register a store computer to start receiving live audio and health status.</p><Link href="/stores">Choose a store</Link></div>}
      </section> : null}

      {data && active === 'integrations' ? <section className="settings-panel">
        <div className="settings-panel-head"><div><span className="eyebrow">CONNECTED SYSTEMS</span><h2>Integrations</h2><p>Provider selection and connection records currently available in this environment.</p></div></div>
        <div className="settings-integration-grid">{Object.entries(data.providers).map(([kind, provider]) => <article className="settings-integration" key={kind}><span>{kind}</span><strong>{provider}</strong><Status value={provider === 'mock' ? 'demo mode' : 'configured'} /><small>{provider === 'mock' ? 'Demo adapter; live vendor credentials are not connected.' : 'Provider is selected in this environment.'}</small></article>)}</div>
        {data.integrations.length ? <div className="settings-record-list">{data.integrations.map((item, index) => <article className="settings-record" key={`${item.kind}-${index}`}><div className="settings-record-main"><strong>{item.kind}</strong><small>{item.provider} · {item.notes || 'No connection notes'}</small></div><Status value={item.status} /></article>)}</div> : <div className="settings-empty compact"><strong>No vendor connection records</strong><p>Live POS and AI credentials are not configured from this demo screen.</p></div>}
      </section> : null}

      {data && active === 'users' ? <section className="settings-panel">
        <div className="settings-panel-head"><div><span className="eyebrow">ACCESS DIRECTORY</span><h2>Users and roles</h2><p>Visible accounts and the access roles supported by this workspace.</p></div></div>
        <div className="settings-record-list">{data.users.map((user) => <article className="settings-record" key={user.id}><div className="settings-avatar">{user.full_name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase()}</div><div className="settings-record-main"><strong>{user.full_name}</strong><small>{user.email}</small></div><span className="settings-role">{user.role.replaceAll('_', ' ')}</span><span className="settings-inline-meta">{data.stores.find((store) => store.id === user.store_id)?.name ?? (user.store_id ? user.store_id : 'Organization-wide')}</span></article>)}</div>
        <div className="settings-role-note"><strong>Available roles</strong><span>{data.roles.map((role) => role.replaceAll('_', ' ')).join(' · ')}</span></div>
      </section> : null}

      {data && active === 'ai' ? <section className="settings-overview-grid">
        <article className="settings-panel"><div className="settings-panel-head"><div><span className="eyebrow">VOICE PIPELINE</span><h2>Speech recognition</h2></div><Status value="active" /></div><dl className="settings-detail-list"><div><dt>Provider</dt><dd>{data.ai.speech_provider}</dd></div><div><dt>Allowed languages</dt><dd>English, Spanish, Hindi, and Urdu</dd></div><div><dt>Original transcript</dt><dd>{data.ai.supports_original_transcript ? 'Available' : 'Unavailable'}</dd></div><div><dt>English translation</dt><dd>{data.ai.supports_english_translation ? 'Available for Spanish speech' : 'Unavailable'}</dd></div></dl></article>
        <article className="settings-panel"><div className="settings-panel-head"><div><span className="eyebrow">CONVERSATION INTELLIGENCE</span><h2>AI provider</h2></div><Status value={data.ai.provider === 'mock' ? 'demo' : 'configured'} /></div><dl className="settings-detail-list"><div><dt>Selected provider</dt><dd>{data.ai.provider}</dd></div></dl><p className="settings-note">{data.ai.provider_note}</p><p className="settings-caveat">AI recommendations are review prompts, not verified facts or employee performance scores.</p></article>
      </section> : null}

      {data && active === 'security' ? <section className="settings-overview-grid">
        <article className="settings-panel"><div className="settings-panel-head"><div><span className="eyebrow">DATA LIFECYCLE</span><h2>Retention and privacy</h2></div></div><dl className="settings-detail-list"><div><dt>Audio clip retention</dt><dd>{data.retention.audio_days} days</dd></div><div><dt>Transcript retention</dt><dd>{data.retention.transcript_days} days</dd></div><div><dt>Raw audio stored by default</dt><dd>{data.retention.raw_audio_stored_by_default ? 'Yes' : 'No'}</dd></div></dl><p className="settings-note">Retention values are environment configuration. This screen does not change or delete stored records.</p></article>
        <article className="settings-panel"><div className="settings-panel-head"><div><span className="eyebrow">ACCOUNT SAFEGUARDS</span><h2>Authentication and access</h2></div></div><dl className="settings-detail-list">{Object.entries(data.security).map(([key, value]) => <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{typeof value === 'boolean' ? (value ? 'Enabled' : 'Disabled') : value}</dd></div>)}</dl></article>
      </section> : null}
    </div>
  );
}
