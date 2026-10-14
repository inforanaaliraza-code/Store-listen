'use client';
import { OpportunityActions, ResourceTable } from '../../components/resource-table';
export default function Page() {
  return (
    <>
      <OpportunityActions />
      <ResourceTable
        title="Opportunities"
        eyebrow="SALES INTELLIGENCE"
        description="Potential, converted, missed, and review-required outcomes. Confidence is shown; managers can override."
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
    </>
  );
}
