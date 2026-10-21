'use client';
import { ResourceTable } from '../../components/resource-table';
export default function Page() {
  return (
    <ResourceTable
        title="POS correlation"
        eyebrow="TRANSACTION MATCHING"
        description="Imported point-of-sale transactions linked to conversations when reliable identifiers are available. Empty results mean no POS transactions have been connected."
        endpoint="/api/v1/pos/transactions"
        collection="transactions"
        columns={[
          { key: 'id', label: 'Txn' },
          { key: 'store_id', label: 'Store' },
          { key: 'product', label: 'Product' },
          { key: 'amount', label: 'Amount' },
          { key: 'provider', label: 'Provider' },
          { key: 'created_at', label: 'When' },
        ]}
      />
  );
}
