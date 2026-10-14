'use client';
import { ReportView } from '../../../components/report-view';
export default function Page({ params }: { params: { period: string } }) {
  return <ReportView period={params.period} />;
}
