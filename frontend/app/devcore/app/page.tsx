export default function Page() {
  return (
    <div>
      <div className="heading"><div><span className="eyebrow">STUDIO</span><h1 className="serif">Overview</h1><p>Internal delivery board for Store Listen and related work. Data persists through the API.</p></div></div>
      <section className="metrics">
        <article className="metric"><span>Active projects</span><strong className="serif">1</strong></article>
        <article className="metric"><span>Open questions</span><strong className="serif">20</strong><small>See docs/client-questions.md</small></article>
        <article className="metric"><span>Demo mode</span><strong className="serif">On</strong></article>
        <article className="metric"><span>POS vendor</span><strong className="serif">Unknown</strong></article>
      </section>
    </div>
  );
}
