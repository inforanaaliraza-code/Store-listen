'use client';
import { useEffect, useState } from 'react';
import { ResourceTable } from '../../components/resource-table';
import { apiGet, type Store } from '../../../lib/api';

export default function Page() {
  const [stores, setStores] = useState<Store[]>([]);

  useEffect(() => {
    apiGet<{ stores: { items: Store[] } }>('/api/v1/stores')
      .then((result) => setStores(result.stores.items))
      .catch(() => setStores([]));
  }, []);

  return (
    <ResourceTable
      title="Employees"
      eyebrow="AI-ASSISTED METRICS"
      description="Associate activity. These scores are AI-assisted and must not be treated as objective HR truth."
      endpoint="/api/v1/employees"
      collection="employees"
      manage={{
        singular: 'employee',
        roles: ['SUPER_ADMIN', 'ORG_ADMIN', 'STORE_MANAGER'],
        deleteLabel: 'Archive',
        deleteConfirmation: 'Conversation and sales history will be kept.',
        fields: [
          { key: 'name', label: 'Full name', placeholder: 'Jordan Chen' },
          { key: 'store_id', label: 'Store', type: 'select', options: stores.map((store) => ({ value: store.id, label: `${store.name} · ${store.city}` })) },
          { key: 'role', label: 'Role', placeholder: 'Sales associate', defaultValue: 'Sales associate' },
        ],
      }}
      hrefFor={(row) => `/employees/${row.id}`}
      columns={[
        { key: 'name', label: 'Name' },
        { key: 'store_id', label: 'Store' },
        { key: 'role', label: 'Role' },
        { key: 'id', label: 'ID' },
        { key: 'active', label: 'Status' },
      ]}
    />
  );
}
