import Link from '@/lib/router-link';

export default function DevcoreHome() {
  return (
    <div>
      <section className="hero scene">
        <div>
          <span className="eyebrow">SOFTWARE STUDIO</span>
          <h1 className="serif">Built for operators who are tired of decorative software.</h1>
          <p style={{ color: 'var(--muted)', maxWidth: 520, lineHeight: 1.6 }}>
            Devcore designs and ships commerce sites, custom software, and automations for teams that need systems they can run on Monday morning — not slideware.
          </p>
          <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
            <Link className="primary" href="/devcore/contact" style={{ width: 'auto', padding: '0 18px' }}>Start a conversation</Link>
            <Link className="ghost" href="/devcore/work">Selected work</Link>
          </div>
        </div>
        <div className="iso-store" aria-hidden="true">
          <div className="roof" />
          <div className="face"><i className="window" /></div>
          <div className="side" />
        </div>
      </section>
      <section className="section">
        <span className="eyebrow">CAPABILITIES</span>
        <h2 className="serif" style={{ fontSize: 40 }}>What we actually build</h2>
        <div className="cards" style={{ marginTop: 24 }}>
          {[
            ['Shopify', 'Storefronts, checkout operations, and merchandising systems that respect the catalog.'],
            ['Web development', 'Fast, accessible marketing and product sites with production-grade TypeScript.'],
            ['Software development', 'Internal tools, APIs, and operational platforms — including conversation intelligence.'],
            ['Automations', 'Integrations that remove re-keying between POS, CRM, and warehouse tools.'],
            ['Product design', 'Interfaces for people who work in stores, not just people who demo decks.'],
            ['Advisory', 'Architecture reviews before you lock a vendor. Placeholders, not fake awards.'],
          ].map(([title, copy]) => (
            <article className="dev-card" key={title}>
              <h3 className="serif">{title}</h3>
              <p style={{ color: 'var(--muted)' }}>{copy}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
