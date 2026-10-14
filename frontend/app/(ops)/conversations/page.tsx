'use client';
import { ResourceTable } from '../../components/resource-table';
export default function Page() {
  return (
    <ResourceTable
      title="Conversations"
      eyebrow="CUSTOMER INTERACTIONS"
      description="English, Spanish, Hindi, and Urdu conversations with original text preserved separately from translation."
      endpoint="/api/v1/conversations"
      collection="conversations"
      hrefFor={(row) => `/conversations/${row.id}`}
      columns={[
        { key: 'id', label: 'ID' },
        { key: 'store_name', label: 'Store' },
        { key: 'salesperson', label: 'Associate' },
        { key: 'language', label: 'Lang' },
        { key: 'customer_intent', label: 'Intent' },
        { key: 'opportunity_status', label: 'Outcome' },
        { key: 'status', label: 'Status' },
      ]}
    />
  );
}
