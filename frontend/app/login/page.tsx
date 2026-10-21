'use client';

import { FormEvent, useEffect, useState } from 'react';
import { apiGet, apiPostWithWake, setToken, wakeApi } from '../../lib/api';
import { BrandLogo } from '../components/brand-logo';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [waking, setWaking] = useState(true);
  const [serviceReady, setServiceReady] = useState(false);
  const [serviceMessage, setServiceMessage] = useState('Checking live production services…');
  const [connectionAttempt, setConnectionAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setWaking(true);
    setServiceReady(false);
    void (async () => {
      try {
        const reachable = await wakeApi();
        if (!reachable) throw new Error('The Store Listen API is unavailable. Check the deployment and try again.');
        const readiness = await apiGet<{
          status: string;
          mode: string;
          database: string;
          capabilities?: { transcription?: string };
        }>('/ready');
        if (readiness.status !== 'ready' || readiness.database !== 'connected') {
          throw new Error('The API database is not ready. Try again after the administrator checks the service.');
        }
        if (readiness.mode !== 'live') {
          throw new Error('Live sign-in is disabled because this API is running in demo mode. The administrator must deploy DEMO_MODE=false.');
        }
        if (readiness.capabilities?.transcription !== 'available') {
          throw new Error('Live transcription is not configured on the API. The administrator must configure Deepgram before sign-in.');
        }
        if (alive) {
          setServiceReady(true);
          setServiceMessage('Live production services are ready.');
        }
      } catch (cause) {
        if (alive) {
          setServiceReady(false);
          setServiceMessage(cause instanceof Error ? cause.message : 'Unable to verify live production services.');
        }
      } finally {
        if (alive) setWaking(false);
      }
    })();
    return () => { alive = false; };
  }, [connectionAttempt]);

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
          Secure access to live store conversations, verified transcripts, and operational reporting.
        </p>
      </section>
      <section className="login-panel">
        <form className="auth-card" onSubmit={onSubmit}>
          <span className="eyebrow">OPERATOR ACCESS</span>
          <h1 className="serif">Sign in</h1>
          <p>Sign in with the account provided by your Store Listen administrator.</p>
          <label className="field">Email<input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" required /></label>
          <label className="field">Password<input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" required /></label>
          {waking ? <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--muted)' }}>Checking live production connection…</p> : <p role={serviceReady ? 'status' : 'alert'} style={{ margin: '0 0 10px', fontSize: 12, color: serviceReady ? 'var(--brand)' : 'var(--muted)' }}>{serviceMessage}</p>}
          {error ? <div className="error">{error}</div> : null}
          <button className="primary" disabled={busy || waking || !serviceReady} type="submit">{busy ? 'Signing in…' : 'Enter operations'}</button>
          {!waking && !serviceReady ? <button className="ghost" style={{ marginTop: 10, width: '100%' }} type="button" onClick={() => setConnectionAttempt((attempt) => attempt + 1)}>Retry connection</button> : null}
        </form>
      </section>
    </main>
  );
}
