'use client';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="error" role="alert">
      <span className="eyebrow">UNEXPECTED ERROR</span>
      <h1 className="serif">This view could not be loaded</h1>
      <p>Your data is unchanged. Retry the request, or return to the dashboard.</p>
      {error.digest ? <small>Reference: {error.digest}</small> : null}
      <button className="ghost" onClick={reset}>Retry</button>
    </section>
  );
}
