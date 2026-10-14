'use client';

import Link from '@/lib/router-link';
import { useParams } from '@/lib/router-hooks';
import { useEffect, useState } from 'react';
import { apiGet } from '../../../../lib/api';

type Perf = {
  name: string;
  storeId: string;
  conversationsHandled: number;
  opportunitiesDetected: number;
  opportunitiesConverted: number;
  potentialMissed: number;
  conversionRate: number;
  averageResponseTimeSeconds: number;
  caveat: string;
};

export default function EmployeePage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Perf | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    apiGet<Perf>(`/api/v1/employees/${id}/performance`).then(setData).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Error'));
  }, [id]);
  if (error) return <section className="error"><p>{error}</p></section>;
  if (!data) return <div className="skeleton" />;
  return (
    <div>
      <Link href="/employees" className="chip">← Employees</Link>
      <div className="heading"><div><span className="eyebrow">ASSOCIATE</span><h1 className="serif">{data.name}</h1><p>{data.caveat}</p></div></div>
      <section className="metrics">
        <article className="metric"><span>Conversations</span><strong className="serif">{data.conversationsHandled}</strong></article>
        <article className="metric"><span>Opportunities</span><strong className="serif">{data.opportunitiesDetected}</strong></article>
        <article className="metric"><span>Converted</span><strong className="serif">{data.opportunitiesConverted}</strong></article>
        <article className="metric"><span>Conversion</span><strong className="serif">{Math.round(data.conversionRate * 100)}%</strong><small>{data.averageResponseTimeSeconds}s response</small></article>
      </section>
    </div>
  );
}
