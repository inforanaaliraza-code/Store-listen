'use client';

import { FormEvent, useEffect, useState } from 'react';
import { apiPostWithWake, setToken, wakeApi } from '../../lib/api';
import { BrandLogo } from '../components/brand-logo';

export default function LoginPage() {
  const [email, setEmail] = useState('admin@storelisten.demo');
  const [password, setPassword] = useState('StoreListen!2026');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [waking, setWaking] = useState(true);

  useEffect(() => {
    let alive = true;
    void wakeApi().finally(() => {
      if (alive) setWaking(false);
    });
    return () => { alive = false; };
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await apiPostWithWake<{ token: string }>('/api/v1/auth/login', { email, password }, 45_000, 5);
      setToken(result.token);
      window.location.href = '/dashboard';
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to sign in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-stage">
      <section className="login-visual scene">
        <div>
          <BrandLogo className="brand-logo-login" />
          <h2 className="serif" style={{ fontSize: 42, fontWeight: 500, maxWidth: 460 }}>
            Mission control for store conversations.
          </h2>
        </div>
        <div className="iso-store" aria-hidden="true">
          <div className="roof" />
          <div className="face"><i className="window" /></div>
          <div className="side" />
        </div>
        <p style={{ color: 'var(--muted)', maxWidth: 420 }}>
          Demo environment. Insights are AI-assisted estimates, not determinations. Mock speech, AI, and POS providers are labeled as demo.
        </p>
      </section>
      <section className="login-panel">
        <form className="auth-card" onSubmit={onSubmit}>
          <span className="eyebrow">OPERATOR ACCESS</span>
          <h1 className="serif">Sign in</h1>
          <p>Use the seeded operations account to inspect live intelligence, reports, and POS correlation.</p>
          <label className="field">Email<input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" /></label>
          <label className="field">Password<input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" /></label>
          {waking ? <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--muted)' }}>Waking cloud API…</p> : null}
          {error ? <div className="error">{error}</div> : null}
          <button className="primary" disabled={busy} type="submit">{busy ? 'Signing in…' : 'Enter operations'}</button>
          <p style={{ marginTop: 16, fontSize: 12, color: 'var(--muted)' }}>admin@storelisten.demo · StoreListen!2026</p>
        </form>
      </section>
    </main>
  );
}
