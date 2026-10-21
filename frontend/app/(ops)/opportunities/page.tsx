'use client';
import { ResourceTable } from '../../components/resource-table';
export default function Page() {
  return (
    <ResourceTable
        title="Opportunities"
        eyebrow="SALES INTELLIGENCE"
        description="Potential, converted, missed, and review-required outcomes derived from recorded conversations. Confidence is shown for review."
        endpoint="/api/v1/opportunities"
        collection="opportunities"
        columns={[
          { key: 'id', label: 'ID' },
          { key: 'store_id', label: 'Store' },
          { key: 'customer_intent', label: 'Intent' },
          { key: 'product', label: 'Product' },
          { key: 'status', label: 'Status' },
          { key: 'confidence', label: 'Confidence' },
          { key: 'recommendation', label: 'Tip' },
        ]}
      />
  );
}
