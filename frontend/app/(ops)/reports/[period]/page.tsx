'use client';
import { Navigate } from 'react-router-dom';
import { ReportView } from '../../../components/report-view';
export default function Page({ params }: { params: { period: string } }) {
  if (params.period !== 'daily') return <Navigate to="/reports/daily" replace />;
  return <ReportView period={params.period} />;
}
