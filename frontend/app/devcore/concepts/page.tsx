import Link from '@/lib/router-link';
import styles from './concepts.module.css';

const concepts = [
  { id: '01', name: 'Fieldnotes', discipline: 'Editorial studio', palette: 'fieldnotes', description: 'A warm, human studio for commerce teams that value craft and clear thinking.' },
  { id: '02', name: 'Northstar', discipline: 'Operations partner', palette: 'northstar', description: 'A confident, dark canvas focused on systems, delivery, and measurable progress.' },
  { id: '03', name: 'Commonform', discipline: 'Digital workshop', palette: 'commonform', description: 'A bright, product-led practice with a modular, practical point of view.' },
  { id: '04', name: 'Goodworks', discipline: 'Independent developers', palette: 'goodworks', description: 'Direct, energetic, and built around getting useful work into customers’ hands.' },
  { id: '05', name: 'Form & Function', discipline: 'Commerce engineering', palette: 'form', description: 'A precise, considered direction for complex commerce and software projects.' },
];

export default function ConceptsIndex() {
  return (
    <main className={styles.index}>
      <header className={styles.indexHeader}>
        <span className="eyebrow">DEVCORE / WEBSITE STUDIES</span>
        <h1 className="serif">Five directions.<br />One capable studio.</h1>
        <p>Explore five distinct approaches to the Devcore website. Each concept presents the same services through a different visual identity.</p>
      </header>
      <section className={styles.grid} aria-label="Website concepts">
        {concepts.map((concept) => (
          <Link className={`${styles.tile} ${styles[concept.palette]}`} href={`/devcore/concepts/${concept.id}`} key={concept.id}>
            <div className={styles.preview}>
              <span>{concept.name}</span>
              <div className={styles.previewMark} aria-hidden="true"><i /><i /><i /></div>
              <small>{concept.discipline}</small>
            </div>
            <div className={styles.tileInfo}>
              <span className="eyebrow">CONCEPT {concept.id}</span>
              <h2>{concept.name}</h2>
              <p>{concept.description}</p>
              <span className={styles.explore}>Explore concept <span aria-hidden="true">↗</span></span>
            </div>
          </Link>
        ))}
      </section>
    </main>
  );
}