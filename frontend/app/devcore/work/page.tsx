export default function Page() {
  return (
    <section className="section">
      <span className="eyebrow">WORK</span>
      <h1 className="serif" style={{ fontSize: 48 }}>Selected engagements</h1>
      <p style={{ color: 'var(--muted)', maxWidth: 640 }}>Client logos and awards are not invented here. The items below are labeled placeholders or internal product work.</p>
      <div className="cards" style={{ marginTop: 28 }}>
        <article className="dev-card">
          <span className="chip">PRODUCT · INTERNAL</span>
          <h2 className="serif">Store Listen</h2>
          <p style={{ color: 'var(--muted)' }}>Conversation intelligence for US retail: capture, transcription, intent, and POS correlation. Currently in demo/foundation stage.</p>
        </article>
        <article className="dev-card">
          <span className="chip">PLACEHOLDER</span>
          <h2 className="serif">Commerce rebuild</h2>
          <p style={{ color: 'var(--muted)' }}>Placeholder case study. Replace with a real engagement after client permission.</p>
        </article>
        <article className="dev-card">
          <span className="chip">PLACEHOLDER</span>
          <h2 className="serif">Operations automation</h2>
          <p style={{ color: 'var(--muted)' }}>Placeholder case study. No fabricated metrics.</p>
        </article>
      </div>
    </section>
  );
}
