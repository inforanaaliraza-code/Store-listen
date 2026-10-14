export default function Page() {
  return (
    <section className="section">
      <span className="eyebrow">ABOUT</span>
      <h1 className="serif" style={{ fontSize: 48 }}>A practice for operational software.</h1>
      <p style={{ color: 'var(--muted)', maxWidth: 680, fontSize: 18, lineHeight: 1.6 }}>
        Devcore exists to ship systems that survive contact with a real store, warehouse, or support queue. We do not publish fake testimonials. If you need references, we will introduce you to people who actually used the work.
      </p>
    </section>
  );
}
