'use client';

import Link from '@/lib/router-link';
import { usePathname, useRouter } from '@/lib/router-hooks';
import { ReactNode, useEffect, useState } from 'react';
import { apiGet, clearToken, getToken, type Store } from '../../lib/api';
import { BrandLogo } from './brand-logo';
import { ConfirmDialogProvider } from './confirm-dialog';

const nav = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/approvals', label: 'Store approvals' },
  { href: '/live', label: 'Live monitor' },
  { href: '/recordings', label: 'Recordings' },
  { href: '/conversations', label: 'Conversations' },
  { href: '/opportunities', label: 'Opportunities' },
  { href: '/sales-intelligence', label: 'Sales intelligence' },
  { href: '/employees', label: 'Employees' },
  { href: '/stores', label: 'Stores' },
  { href: '/reports', label: 'Reports' },
  { href: '/inventory', label: 'Stock' },
  { href: '/rules', label: 'Rules' },
  { href: '/pos', label: 'POS' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/alerts', label: 'Alerts' },
  { href: '/settings', label: 'Settings' },
];

export function OpsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [serviceState, setServiceState] = useState<'checking' | 'live' | 'demo' | 'unavailable'>('checking');
  const [serviceMessage, setServiceMessage] = useState('Checking production services…');
  const [workspaceLabel, setWorkspaceLabel] = useState('Loading workspace…');
  const [connectionAttempt, setConnectionAttempt] = useState(0);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    setReady(true);
  }, [router]);

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const readiness = await apiGet<{
          status: string;
          mode: string;
          database: string;
          capabilities?: { transcription?: string };
        }>('/ready', { signal: controller.signal });
        if (readiness.status !== 'ready' || readiness.database !== 'connected' || !readiness.capabilities) {
          throw new Error('The API is not ready or needs a production update.');
        }
        if (readiness.mode !== 'live') {
          setServiceState('demo');
          setServiceMessage('Live operations are disabled because this API is in demo mode. Configure the production service before continuing.');
          return;
        }
        if (readiness.capabilities.transcription !== 'available') {
          setServiceState('unavailable');
          setServiceMessage('Live transcription is not configured on the API. An administrator must configure the speech provider before store monitoring can be used.');
          return;
        }
        const [user, storeResult] = await Promise.all([
          apiGet<{ email: string; full_name: string }>('/api/v1/auth/me', { signal: controller.signal }),
          apiGet<{ stores: { items: Store[]; total: number } }>('/api/v1/stores?page_size=1', { signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        setWorkspaceLabel(`${user.full_name || user.email} · ${storeResult.stores.total} ${storeResult.stores.total === 1 ? 'store' : 'stores'}`);
        setServiceState('live');
        setServiceMessage('Connected to the live production API.');
      } catch (error) {
        if (controller.signal.aborted) return;
        setServiceState('unavailable');
        setServiceMessage(error instanceof Error ? error.message : 'Unable to verify production services.');
      }
    })();
    return () => controller.abort();
  }, [ready, connectionAttempt]);

  if (!ready) return <div className="main"><div className="skeleton" /></div>;

  if (serviceState !== 'live') {
    return (
      <div className="shell">
        <aside className="sidebar">
          <Link href="/dashboard" className="brand"><BrandLogo className="brand-logo-sidebar" /></Link>
          <div style={{ marginTop: 'auto', padding: 10 }}>
            <button className="ghost" style={{ width: '100%' }} onClick={() => { clearToken(); router.push('/login'); }}>Sign out</button>
          </div>
        </aside>
        <div className="workspace">
          <header className="topbar"><span className={`status${serviceState === 'checking' ? '' : ' off'}`}><i />{serviceState === 'checking' ? 'Checking production connection' : 'Live service unavailable'}</span></header>
          <main className="main">
            <section className="panel" role="status" aria-live="polite">
              <span className="eyebrow">PRODUCTION CONNECTION</span>
              <h1 className="serif">{serviceState === 'checking' ? 'Connecting to Store Listen' : 'Live workspace unavailable'}</h1>
              <p>{serviceMessage}</p>
              <p>Demo or outdated API responses are blocked here so sample records cannot be mistaken for live store activity.</p>
              {serviceState !== 'checking' ? <button className="ghost" onClick={() => { setServiceState('checking'); setServiceMessage('Retrying production connection…'); setConnectionAttempt((attempt) => attempt + 1); }}>Retry connection</button> : null}
            </section>
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/dashboard" className="brand">
          <BrandLogo className="brand-logo-sidebar" />
        </Link>
        <nav className="nav" aria-label="Operations">
          {nav.map((item) => {
            const active = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href} className={active ? 'active' : undefined}>
                {item.label}
                {item.href === '/live' ? <span className="live-dot" /> : null}
              </Link>
            );
          })}
        </nav>
        <div style={{ marginTop: 'auto', padding: 10 }}>
          <div className="chip">LIVE · API CONNECTED</div>
          <button className="ghost" style={{ marginTop: 12, width: '100%' }} onClick={() => { clearToken(); router.push('/login'); }}>Sign out</button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span className="status" title={serviceMessage}><i />{workspaceLabel}</span>
        </header>
        <nav className="mobile-ops-nav" aria-label="Mobile operations navigation">
          {nav.map((item) => {
            const active = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href));
            return <Link key={item.href} href={item.href} className={active ? 'active' : undefined}>{item.label}</Link>;
          })}
        </nav>
        <main className="main"><ConfirmDialogProvider>{children}</ConfirmDialogProvider></main>
      </div>
    </div>
  );
}
