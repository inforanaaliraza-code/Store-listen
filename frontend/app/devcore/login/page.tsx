'use client';

import { FormEvent, useState } from 'react';
import { apiPost, setToken } from '../../../lib/api';

export default function DevcoreLogin() {
  const [email, setEmail] = useState('hello@devcore.studio');
  const [password, setPassword] = useState('Devcore!2026');
  const [error, setError] = useState('');

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    try {
      const result = await apiPost<{ token: string }>('/api/v1/auth/login', { email, password });
      setToken(result.token);
      window.location.href = '/devcore/app';
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to sign in');
    }
  }

  return (
    <section className="login-panel" style={{ minHeight: '70vh' }}>
      <form className="auth-card" onSubmit={onSubmit}>
        <span className="eyebrow">DEVCORE</span>
        <h1 className="serif">Studio login</h1>
        <label className="field">Email<input value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="field">Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error ? <div className="error">{error}</div> : null}
        <button className="primary" type="submit">Enter studio</button>
      </form>
    </section>
  );
}
