'use client';
import { ResourceTable } from '../../components/resource-table';
export default function Page() {
  return (
    <ResourceTable
      title="Alerts"
      eyebrow="OPERATIONS INBOX"
      description="Store offline, audio degradation, POS disconnect, and potential missed-opportunity notices."
      endpoint="/api/v1/alerts"
      collection="alerts"
      columns={[
        { key: 'severity', label: 'Severity' },
        { key: 'title', label: 'Title' },
        { key: 'description', label: 'Detail' },
        { key: 'store_id', label: 'Store' },
        { key: 'created_at', label: 'When' },
      ]}
    />
  );
}
