'use client';

import Link from '@/lib/router-link';
import { usePathname, useRouter } from '@/lib/router-hooks';
import { ReactNode, useEffect, useState } from 'react';
import { clearToken, getToken } from '../../lib/api';
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

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    setReady(true);
  }, [router]);

  if (!ready) return <div className="main"><div className="skeleton" /></div>;

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
          <div className="chip">DEMO · MOCK PROVIDERS</div>
          <button className="ghost" style={{ marginTop: 12, width: '100%' }} onClick={() => { clearToken(); router.push('/login'); }}>Sign out</button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span className="status"><i /> Northstar Retail · 3 stores</span>
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
