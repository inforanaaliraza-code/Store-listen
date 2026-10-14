'use client';
import { PosDemoButton, ResourceTable } from '../../components/resource-table';
export default function Page() {
  return (
    <>
      <PosDemoButton />
      <ResourceTable
        title="POS correlation"
        eyebrow="TRANSACTION MATCHING"
        description="Mock POS transactions and probabilistic conversation matches. Matches are never claimed certain without a reliable identifier."
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
    </>
  );
}
