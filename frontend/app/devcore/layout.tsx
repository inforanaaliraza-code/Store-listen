'use client';

import Link from '@/lib/router-link';
import { usePathname } from '@/lib/router-hooks';

const links = [
  ['/devcore', 'Home'],
  ['/devcore/concepts', 'Concepts'],
  ['/devcore/services', 'Services'],
  ['/devcore/work', 'Work'],
  ['/devcore/process', 'Process'],
  ['/devcore/about', 'About'],
  ['/devcore/contact', 'Contact'],
];

export default function DevcoreLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname.startsWith('/devcore/app')) {
    return children;
  }
  return (
    <div className="marketing">
      <nav className="m-nav">
        <Link href="/devcore"><strong>DEVCORE</strong></Link>
        <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
          {links.map(([href, label]) => <Link key={href} href={href}>{label}</Link>)}
          <Link className="chip" href="/devcore/login">Login</Link>
        </div>
      </nav>
      {children}
      <footer className="footer">
        <span>Devcore — software, commerce, and automation studio.</span>
        <span>Store Listen is a product engagement, not a published case study with named awards.</span>
      </footer>
    </div>
  );
}
