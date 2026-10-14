import Link from '@/lib/router-link';
import { notFound } from '@/lib/router-hooks';
import styles from '../concepts.module.css';

const concepts = {
  '01': {
    name: 'Fieldnotes', eyebrow: 'A SMALL STUDIO FOR BIG MOVES',
    headline: 'Good work starts with better questions.',
    copy: 'We make thoughtful commerce experiences and practical software for teams ready to move forward.',
    action: 'Tell us what you are building', services: ['Shopify, made useful', 'Websites with a point of view', 'Software for the workday', 'Automations that give time back'],
    note: 'An independent digital studio',
  },
  '02': {
    name: 'Northstar', eyebrow: 'DESIGN / ENGINEERING / DELIVERY',
    headline: 'Make the next version work harder.',
    copy: 'Devcore turns tangled operations into clear digital systems. From commerce foundations to software built around your team.',
    action: 'Plan a project', services: ['Commerce platforms', 'Web engineering', 'Operational software', 'Connected workflows'],
    note: 'Systems that move business forward',
  },
  '03': {
    name: 'Commonform', eyebrow: 'DIGITAL TOOLS FOR REAL WORK',
    headline: 'Useful by design. Ready for Monday.',
    copy: 'We build the websites, software, and automations that help good teams serve customers without adding busywork.',
    action: 'Start with a conversation', services: ['Shopify storefronts', 'Accessible web products', 'Custom team tools', 'Everyday automations'],
    note: 'A practical digital workshop',
  },
  '04': {
    name: 'Goodworks', eyebrow: 'LESS TALK. BETTER SOFTWARE.',
    headline: 'Your next good idea, built.',
    copy: 'A hands-on partner for ambitious teams. We design, build, and connect the digital parts that make your business easier to run.',
    action: 'Bring us a challenge', services: ['Sell online with Shopify', 'Build a faster website', 'Make software fit the job', 'Automate the repeatable'],
    note: 'Independent builders, on your side',
  },
  '05': {
    name: 'Form & Function', eyebrow: 'COMMERCE SYSTEMS / CUSTOM SOFTWARE',
    headline: 'Complex work, made coherent.',
    copy: 'Devcore engineers durable commerce and software systems that bring customer experience and daily operations together.',
    action: 'Discuss your system', services: ['Commerce architecture', 'Web applications', 'Software platforms', 'Integration and automation'],
    note: 'Engineering with intent',
  },
} as const;

export default function ConceptPage({ params }: { params: { version: string } }) {
  const concept = concepts[params.version as keyof typeof concepts];
  if (!concept) notFound();
  const theme = styles[`site${params.version}`] || '';

  return (
    <main className={`${styles.site} ${theme}`}>
      <nav className={styles.siteNav}>
        <Link href="/devcore/concepts" className={styles.wordmark}>{concept.name}<span>.</span></Link>
        <div><a href="#services">Services</a><a href="#approach">Approach</a><Link href="/devcore/contact">Contact ↗</Link></div>
      </nav>
      <section className={styles.siteHero}>
        <div className={styles.siteCopy}>
          <span className={styles.siteEyebrow}>{concept.eyebrow}</span>
          <h1>{concept.headline}</h1>
          <p>{concept.copy}</p>
          <Link className={styles.siteAction} href="/devcore/contact">{concept.action}<span aria-hidden="true">↗</span></Link>
        </div>
        <div className={styles.artboard} aria-label={`${concept.name} visual identity`}>
          <div className={styles.artLabel}><span>DEVCORE</span><span>STUDIO / 2026</span></div>
          <div className={styles.artShape}><i /><i /><i /></div>
          <div className={styles.artCaption}><strong>{concept.note}</strong><span>SHOPIFY · WEB · SOFTWARE · AUTOMATION</span></div>
        </div>
      </section>
      <section className={styles.siteServices} id="services">
        <div><span className={styles.siteEyebrow}>WHAT WE DO</span><h2>Good tools make room for better work.</h2></div>
        <div className={styles.serviceList}>
          {concept.services.map((service, index) => <div key={service}><span>0{index + 1}</span><strong>{service}</strong><span aria-hidden="true">↗</span></div>)}
        </div>
      </section>
      <section className={styles.siteApproach} id="approach">
        <span className={styles.siteEyebrow}>THE APPROACH</span>
        <p>Understand the real problem. Build the right thing. Leave your team with something they can run.</p>
        <Link href="/devcore/concepts">Back to all five concepts <span aria-hidden="true">↗</span></Link>
      </section>
    </main>
  );
}