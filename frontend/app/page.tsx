'use client';

import { useEffect, useState } from 'react';
import { getToken } from '../lib/api';
import { BrandLogo } from './components/brand-logo';

const signals = [
  {
    number: '01',
    title: 'Hear the need',
    description: 'Recognize the question behind every product search, hesitation, and recommendation.',
    image: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=1100&q=85',
    tone: 'sage',
  },
  {
    number: '02',
    title: 'See what moved',
    description: 'Connect conversations with POS outcomes to understand which moments became sales.',
    image: 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?auto=format&fit=crop&w=1100&q=85',
    tone: 'peach',
  },
  {
    number: '03',
    title: 'Make the next move',
    description: 'Give managers a timely view of opportunities, team performance, and what needs attention.',
    image: 'https://images.unsplash.com/photo-1556761175-b413da4baf72?auto=format&fit=crop&w=1100&q=85',
    tone: 'blue',
  },
];

const outcomes = [
  { value: '01', label: 'Customer intent', detail: 'A shopper asks about fit and availability.' },
  { value: '02', label: 'Associate response', detail: 'A team member makes a useful recommendation.' },
  { value: '03', label: 'Sales outcome', detail: 'The conversation is matched to a POS result.' },
];

export default function Home() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  useEffect(() => {
    setIsLoggedIn(Boolean(getToken()));
  }, []);

  const primaryHref = isLoggedIn ? '/dashboard' : '/login';
  const primaryLabel = isLoggedIn ? 'Open dashboard' : 'Request a walkthrough';

  return (
    <main className="marketing landing-page">
      <header className="m-nav studio-nav">
        <a href="/" className="studio-logo-link" aria-label="Store Listen home">
          <BrandLogo className="studio-logo-image" />
        </a>

        <nav className="studio-links" aria-label="Main navigation">
          <a href="#platform">Platform</a>
          <a href="#how-it-works">How it works</a>
          <a href="#outcomes">Outcomes</a>
          <a href="#plans">Plans</a>
        </nav>

        <div className="studio-nav-actions">
          <a href="/login" className="studio-login">Log in</a>
          <a href={primaryHref} className="studio-nav-cta">
            {isLoggedIn ? 'Open dashboard' : 'Talk to our team'}
          </a>
        </div>
      </header>

      <section className="studio-hero">
        <span className="studio-kicker"><i /> LISTEN CLOSER. LEAD BETTER.</span>
        <h1>Every great sale<br />starts with a <span>conversation.</span></h1>
        <p>See the moments behind the numbers. Store Listen connects in-store conversations to customer intent, associate actions, and real sales outcomes.</p>
        <div className="studio-hero-actions">
          <a href={primaryHref} className="studio-button studio-button-dark">{primaryLabel}<span aria-hidden="true">↗</span></a>
          <a href="#platform" className="studio-text-link">Explore the platform <span aria-hidden="true">↓</span></a>
        </div>
        <div className="hero-store-image" role="img" aria-label="A welcoming, thoughtfully arranged retail store">
          <div className="hero-image-topline"><span>STORE LISTEN / FIELD NOTES 001</span><span>REAL-TIME STORE INTELLIGENCE</span></div>
          <div className="hero-signal-card">
            <div className="signal-card-heading"><span className="signal-live-dot" /> LIVE CONVERSATION <span>00:18</span></div>
            <p>“I’m looking for something that will last through the whole trip.”</p>
            <div className="signal-card-foot"><span>INTENT <b>Durability</b></span><span>OUTCOME <b>Purchase matched</b></span></div>
          </div>
          <span className="hero-image-caption">A clearer view of what happens on the floor.</span>
        </div>
        <div className="hero-index"><span>01 — IN-STORE INTELLIGENCE</span><span>MADE FOR THE MOMENTS THAT MATTER</span><a href="#platform" aria-label="Scroll to platform">↓</a></div>
      </section>

      <div className="studio-marquee" aria-label="Real conversations. Real signals. Real sales.">
        <div className="marquee-track" aria-hidden="true">
          {[0, 1].map((copy) => (
            <span key={copy}>REAL CONVERSATIONS <i>✳</i> REAL SIGNALS <i>✳</i> REAL SALES <i>✳</i> BETTER STORE DECISIONS <i>✳</i></span>
          ))}
        </div>
      </div>

      <section className="manifesto-section" id="platform">
        <div className="manifesto-copy">
          <span className="studio-kicker">THE STORE LISTEN PLATFORM</span>
          <h2>There’s more to a store than what’s on the receipt.</h2>
          <p>Every day, your team has the conversations that shape a customer’s decision. Store Listen helps you understand those moments, connect them to outcomes, and bring the bigger picture into focus.</p>
          <a href={primaryHref} className="studio-button studio-button-dark">See Store Listen in action <span aria-hidden="true">↗</span></a>
        </div>
        <div className="insight-board" aria-label="Store intelligence dashboard preview">
          <div className="board-topbar"><span className="board-brand"><i /> STORE LISTEN</span><span>MONDAY, OCTOBER 12</span><span className="board-location">ALL LOCATIONS⌄</span></div>
          <div className="board-heading"><div><span className="board-eyebrow">LIVE FLOOR PULSE</span><h3>Good afternoon, Alex.</h3></div><span className="board-live"><i /> LIVE</span></div>
          <div className="board-metrics"><div><span>CONVERSATIONS</span><b>128</b><small>Across 4 locations</small></div><div><span>SALES MATCHED</span><b>86</b><small>POS-confirmed outcomes</small></div><div><span>NEEDS A LOOK</span><b>12</b><small>Opportunities to review</small></div></div>
          <div className="board-feed-heading"><span>RECENT STORE SIGNALS</span><a href="/login">View activity ↗</a></div>
          <div className="board-feed-row"><span className="feed-avatar avatar-coral">JT</span><span><b>Product question</b><small>Home &amp; Living · Store 04 · 2 min ago</small></span><em>POS MATCHED</em></div>
          <div className="board-feed-row"><span className="feed-avatar avatar-blue">AM</span><span><b>Purchase intent detected</b><small>Outdoor · Store 02 · 6 min ago</small></span><em className="feed-review">REVIEW</em></div>
          <div className="board-feed-row"><span className="feed-avatar avatar-green">RK</span><span><b>Recommendation converted</b><small>Electronics · Store 01 · 9 min ago</small></span><em>POS MATCHED</em></div>
          <span className="board-note">Illustrative view · Customer details are not shown</span>
        </div>
      </section>

      <section className="how-section" id="how-it-works">
        <div className="how-heading">
          <span className="studio-kicker">ONE CONNECTED VIEW</span>
          <div className="how-heading-main">
            <h2>From a customer question<br />to a better next step.</h2>
            <p>Make the customer moment visible, without losing sight of the people and outcomes behind it.</p>
          </div>
        </div>
        <div className="journey-layout">
          <div className="journey-list">
            {outcomes.map((outcome) => (
              <article className="journey-step" key={outcome.value}>
                <span className="journey-number">{outcome.value}</span>
                <div><h3>{outcome.label}</h3><p>{outcome.detail}</p></div>
                <span className="journey-arrow" aria-hidden="true">↗</span>
              </article>
            ))}
          </div>
          <aside className="journey-result" aria-label="Example of a conversation matched to a sales outcome">
            <div className="journey-result-topline"><span>CONNECTED OUTCOME</span><span className="result-live"><i /> POS MATCH</span></div>
            <div className="outcome-visual" aria-hidden="true">
              <span className="outcome-ring outcome-ring-one" />
              <span className="outcome-ring outcome-ring-two" />
              <div className="outcome-core"><span>STORE</span><b>LISTEN</b></div>
              <span className="outcome-node outcome-node-one" />
              <span className="outcome-node outcome-node-two" />
            </div>
            <div className="journey-result-copy"><span>THE RESULT</span><h3>Purchase matched.</h3><p>Customer intent, associate response, and a POS outcome brought together.</p></div>
            <div className="outcome-flow"><span>INTENT</span><i>→</i><span>RESPONSE</span><i>→</i><span>POS</span></div>
          </aside>
        </div>
        <div className="journey-footnote"><span>01 — CAPTURE</span><span>02 — UNDERSTAND</span><span>03 — CONNECT</span><span>ALWAYS WITH STORE-LEVEL CONTEXT</span></div>
      </section>

      <section className="signals-section" id="outcomes">
        <div className="signals-heading"><div><span className="studio-kicker">A BETTER READ ON RETAIL</span><h2>See the whole story.<br /><span>Not just the sale.</span></h2></div><p>From the first question to the final transaction, bring the details together so your team can make the next moment count.</p></div>
        <div className="signal-cards">
          {signals.map((signal) => (
            <article className={`signal-tile ${signal.tone}`} key={signal.number}>
              <div className="signal-tile-image" style={{ backgroundImage: `url("${signal.image}")` }} role="img" aria-label={signal.title}><span>{signal.number} / FIELD SIGNAL</span><span className="tile-arrow" aria-hidden="true">↗</span></div>
              <div className="signal-tile-copy"><h3>{signal.title}</h3><p>{signal.description}</p></div>
            </article>
          ))}
        </div>
      </section>

      <section className="privacy-band"><span className="privacy-mark" aria-hidden="true">✳</span><p>Better store intelligence<br />should still feel <em>human.</em></p><span className="privacy-detail">Designed for operational context, manager review, and privacy-aware store workflows.</span><a href="/login" aria-label="Learn about Store Listen access">↗</a></section>

      <section className="plans-section" id="plans">
        <div className="plans-heading"><div><span className="studio-kicker">A FIT FOR YOUR FLOOR</span><h2>Built around<br />your locations.</h2></div><p>Start with the view your team needs today. Grow into a clearer picture across every store tomorrow.</p></div>
        <div className="plan-grid">
          <article className="plan-card"><span className="plan-index">01 / SINGLE LOCATION</span><h3>One store.<br />One clearer view.</h3><p>Bring conversation signals, opportunity review, and store-level outcomes into one place for your team.</p><div className="plan-includes"><span>Store conversation insights</span><span>POS outcome matching</span><span>Manager review tools</span></div><a href={primaryHref} className="studio-button studio-button-light">Talk about one location <span aria-hidden="true">↗</span></a></article>
          <article className="plan-card plan-card-dark"><span className="plan-index">02 / MULTI-LOCATION</span><h3>Every store.<br />A wider perspective.</h3><p>See patterns across locations, surface local opportunities, and support consistent decisions at scale.</p><div className="plan-includes"><span>Multi-store performance views</span><span>Location and team comparisons</span><span>Operations-ready reporting</span></div><a href={primaryHref} className="studio-button studio-button-accent">Plan for multiple locations <span aria-hidden="true">↗</span></a></article>
        </div>
        <p className="plans-note">Every retail operation is different. Connect with our team to find the right setup.</p>
      </section>

      <section className="closing-section">
        <div className="closing-copy"><span className="studio-kicker">MAKE EVERY MOMENT COUNT</span><h2>Help your team hear what matters.</h2><p>Give the people on your floor and the leaders behind them a more complete picture of the customer experience.</p><a href={primaryHref} className="studio-button studio-button-dark">{primaryLabel}<span aria-hidden="true">↗</span></a></div>
        <div className="closing-image" role="img" aria-label="Retail associate helping a customer in store"><span>BETTER CONVERSATIONS. BETTER STORE DECISIONS.</span></div>
      </section>

      <footer className="site-footer studio-footer">
        <div className="footer-inner">
          <div className="footer-main">
            <div className="footer-brand-group"><a href="/" className="studio-logo-link" aria-label="Store Listen home"><BrandLogo className="studio-logo-image studio-logo-footer-image" /></a><p>In-store intelligence, connected to real customer outcomes.</p></div>
            <nav className="footer-links" aria-label="Footer navigation"><a href="#platform">Platform</a><a href="#how-it-works">How it works</a><a href="#outcomes">Outcomes</a><a href="#plans">Plans</a></nav>
            <a href="/login" className="footer-cta"><span>Enter operations</span><span className="footer-arrow" aria-hidden="true">↗</span></a>
          </div>
          <div className="footer-bottom"><span>© {new Date().getFullYear()} Store Listen</span><span>Real Conversations. Real Sales.</span></div>
        </div>
      </footer>
    </main>
  );
}
