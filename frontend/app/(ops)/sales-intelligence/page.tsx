'use client';
import { ResourceTable } from '../../components/resource-table';
export default function Page() {
  return (
    <ResourceTable
      title="Sales intelligence"
      eyebrow="CONTEXTUAL TIPS"
      description="Short recommendations generated when a customer intent is detected. Spammy tips are avoided by design."
      endpoint="/api/v1/sales-intelligence"
      collection="recommendations"
      columns={[
        { key: 'title', label: 'Title' },
        { key: 'message', label: 'Recommendation' },
        { key: 'confidence', label: 'Confidence' },
        { key: 'conversation_id', label: 'Conversation' },
        { key: 'label', label: 'Label' },
      ]}
    />
  );
}
