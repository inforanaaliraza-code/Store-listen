'use client';

export default function Page() {
  return (
    <section className="section">
      <span className="eyebrow">CONTACT</span>
      <h1 className="serif" style={{ fontSize: 48 }}>Tell us the operating problem, not the stack.</h1>
      <form className="auth-card" style={{ marginTop: 24 }} onSubmit={(event) => event.preventDefault()}>
        <label className="field">Name<input name="name" /></label>
        <label className="field">Email<input type="email" name="email" /></label>
        <label className="field">What needs to work on Monday?<textarea name="body" rows={4} style={{ background: '#0c100f', border: '1px solid var(--line)', borderRadius: 10, padding: 10 }} /></label>
        <button className="primary" type="submit">Send (demo form — not wired to email)</button>
      </form>
    </section>
  );
}
