'use client';

import Link from '@/lib/router-link';
import { usePathname, useRouter } from '@/lib/router-hooks';
import { useEffect, useState } from 'react';
import { getToken } from '../../../lib/api';

export default function StudioLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const items = [
    ['/devcore/app', 'Overview'],
    ['/devcore/app/projects', 'Projects'],
    ['/devcore/app/kanban', 'Kanban'],
    ['/devcore/app/tasks', 'Tasks'],
    ['/devcore/app/activity', 'Activity'],
    ['/devcore/app/settings', 'Settings'],
  ];

  useEffect(() => {
    if (!getToken()) {
      router.replace('/devcore/login');
      return;
    }
    setReady(true);
  }, [router]);

  if (!ready) return <div className="main"><div className="skeleton" /></div>;

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/devcore" className="brand"><span className="mark" /><span><strong>Devcore</strong><small>STUDIO OPS</small></span></Link>
        <nav className="nav">
          {items.map(([href, label]) => (
            <Link key={href} href={href} className={pathname === href ? 'active' : undefined}>{label}</Link>
          ))}
        </nav>
      </aside>
      <div className="workspace"><main className="main">{children}</main></div>
    </div>
  );
}
