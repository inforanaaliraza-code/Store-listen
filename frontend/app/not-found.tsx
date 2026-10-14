import Link from '@/lib/router-link';

export default function NotFound() {
  return (
    <section className="error" style={{ margin: 48 }}>
      <span className="eyebrow">404</span>
      <h1 className="serif">That view is not in this product</h1>
      <p>Check the operations nav or return to login.</p>
      <Link className="ghost" href="/login">Sign in</Link>
    </section>
  );
}
