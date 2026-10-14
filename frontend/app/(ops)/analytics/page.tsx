'use client';
import { ResourceTable } from '../../components/resource-table';
export default function Page() {
  return (
    <ResourceTable
      title="Analytics"
      eyebrow="NETWORK PERFORMANCE"
      description="Store-level conversation, conversion, and language distribution sourced from the API."
      endpoint="/api/v1/analytics"
      collection="store_performance"
      columns={[
        { key: 'store_id', label: 'Store' },
        { key: 'conversations', label: 'Conversations' },
        { key: 'conversion_rate', label: 'Conversion' },
      ]}
    />
  );
}
