export default function Page() {
  const services = [
    ['Shopify', 'Theme systems, custom apps, and operational reporting around live catalogs.'],
    ['Web development', 'React and design systems for companies that outgrew a template.'],
    ['Software development', 'Python/TypeScript platforms with auth, audit logs, and real data models.'],
    ['Automations', 'Queue-backed jobs, POS adapters, and human-in-the-loop workflows.'],
    ['Other services', 'Discovery, technical diligence, and staged delivery. Named on request after a brief.'],
  ];
  return (
    <section className="section">
      <span className="eyebrow">SERVICES</span>
      <h1 className="serif" style={{ fontSize: 48 }}>A studio, not a menu of packages.</h1>
      <div className="cards" style={{ marginTop: 28, gridTemplateColumns: '1fr' }}>
        {services.map(([title, copy]) => (
          <article className="dev-card" key={title}>
            <h2 className="serif">{title}</h2>
            <p style={{ color: 'var(--muted)' }}>{copy}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
