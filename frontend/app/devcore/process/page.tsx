export default function Page() {
  const steps = ['Discover constraints', 'Map the operating week', 'Prototype the risky path', 'Instrument and ship', 'Harden for production'];
  return (
    <section className="section">
      <span className="eyebrow">PROCESS</span>
      <h1 className="serif" style={{ fontSize: 48 }}>Fewer workshops. More working software.</h1>
      <div className="cards" style={{ marginTop: 28 }}>
        {steps.map((step, index) => (
          <article className="dev-card" key={step}>
            <span className="eyebrow">0{index + 1}</span>
            <h2 className="serif">{step}</h2>
          </article>
        ))}
      </div>
    </section>
  );
}
