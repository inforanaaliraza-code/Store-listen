'use client';
import { ResourceTable } from '../../components/resource-table';
export default function Page() {
  return (
    <ResourceTable
      title="Stores"
      eyebrow="LOCATION HEALTH"
      description="Online status, edge-device connection, and live conversation count per store."
      endpoint="/api/v1/stores"
      collection="stores"
      manage={{
        singular: 'store',
        roles: ['SUPER_ADMIN', 'ORG_ADMIN'],
        fields: [
          { key: 'name', label: 'Store name', placeholder: 'Downtown Dallas' },
          { key: 'code', label: 'Store code', placeholder: 'DAL-004' },
          { key: 'city', label: 'City', placeholder: 'Dallas' },
          { key: 'region', label: 'State / region', placeholder: 'TX' },
          { key: 'timezone', label: 'Time zone', defaultValue: 'America/Chicago' },
        ],
      }}
      hrefFor={(row) => `/stores/${row.id}`}
      columns={[
        { key: 'name', label: 'Store' },
        { key: 'city', label: 'City' },
        { key: 'region', label: 'Region' },
        { key: 'online', label: 'Online' },
        { key: 'device_connected', label: 'Device' },
        { key: 'open_conversations', label: 'Live' },
        { key: 'employees', label: 'Associates' },
      ]}
    />
  );
}
