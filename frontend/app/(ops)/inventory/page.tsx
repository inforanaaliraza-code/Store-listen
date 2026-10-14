'use client';

import { FormEvent, useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPatch, apiPost, type Store } from '../../../lib/api';
import { useConfirmDialog } from '../../components/confirm-dialog';

type StockItem = { id: string; store_id: string; sku: string; name: string; cost: number; price: number; quantity: number; par_level: number };
type InventoryData = { items: StockItem[]; summary: { items: number; units_on_hand: number; inventory_value: number; low_stock: number } };
const emptyForm = { sku: '', name: '', cost: '0', price: '0', quantity: '0', par_level: '0' };

export default function InventoryPage() {
  const confirmDialog = useConfirmDialog();
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState('');
  const [data, setData] = useState<InventoryData | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    apiGet<{ stores: { items: Store[] } }>('/api/v1/stores?page_size=100').then((result) => {
      setStores(result.stores.items);
      setStoreId((current) => current || result.stores.items[0]?.id || '');
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Unable to load stores'));
  }, []);

  async function loadInventory(id = storeId) {
    if (!id) return;
    setError('');
    try { setData(await apiGet<InventoryData>(`/api/v1/inventory?store_id=${encodeURIComponent(id)}`)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load stock'); }
  }

  useEffect(() => {
    if (!storeId) return;
    let active = true;
    setError('');
    apiGet<InventoryData>(`/api/v1/inventory?store_id=${encodeURIComponent(storeId)}`).then((result) => {
      if (active) setData(result);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Unable to load stock');
    });
    return () => { active = false; };
  }, [storeId]);

  async function addItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!storeId) return;
    setBusy(true);
    setError('');
    try {
      await apiPost('/api/v1/inventory', {
        store_id: storeId,
        sku: form.sku,
        name: form.name,
        cost: Number(form.cost),
        price: Number(form.price),
        quantity: Number(form.quantity),
        par_level: Number(form.par_level),
      });
      setForm(emptyForm);
      await loadInventory();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to add item'); }
    finally { setBusy(false); }
  }

  async function updateItem(item: StockItem, field: 'quantity' | 'par_level', value: string) {
    const next = Number(value);
    if (!Number.isInteger(next) || next < 0 || next === item[field]) return;
    try {
      await apiPatch(`/api/v1/inventory/${item.id}`, { [field]: next });
      await loadInventory();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to update stock'); }
  }

  async function removeItem(item: StockItem) {
    const confirmed = await confirmDialog({
      title: 'Remove this stock item?',
      message: 'It will be removed from this store catalog and reorder tracking.',
      subject: item.name,
      confirmLabel: 'Remove item',
      tone: 'danger',
    });
    if (!confirmed) return;
    try { await apiDelete(`/api/v1/inventory/${item.id}`); await loadInventory(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to remove item'); }
  }

  function exportReorderList() {
    if (!data) return;
    const lowItems = data.items.filter((item) => item.quantity <= item.par_level);
    const csv = ['SKU,Name,On hand,Reorder at,Units to order', ...lowItems.map((item) => `${item.sku},"${item.name.replaceAll('"', '""')}",${item.quantity},${item.par_level},${Math.max(0, item.par_level - item.quantity + 1)}`)].join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    link.download = 'store-reorder-list.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <div className="owner-page">
      <div className="heading">
        <div><span className="eyebrow">SHOP OWNER</span><h1 className="serif">Stock</h1><p>Track your catalog, on-hand quantities, and reorder levels.</p></div>
        <label className="owner-select-label">Store<select value={storeId} onChange={(event) => setStoreId(event.target.value)} aria-label="Choose store">{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
      </div>
      {error ? <div className="error" role="alert">{error}</div> : null}
      <section className="owner-kpis owner-stock-kpis">
        <article className="owner-kpi green"><span>Items</span><strong>{data?.summary.items ?? 0}</strong></article>
        <article className="owner-kpi blue"><span>Units on hand</span><strong>{data?.summary.units_on_hand ?? 0}</strong></article>
        <article className="owner-kpi gold"><span>Inventory value</span><strong>{new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(data?.summary.inventory_value ?? 0)}</strong><small>At cost</small></article>
        <article className="owner-kpi red"><span>Low / out of stock</span><strong>{data?.summary.low_stock ?? 0}</strong><small>At or below reorder level</small></article>
      </section>
      <section className="owner-panel owner-form-panel">
        <div className="owner-panel-heading"><div><span className="eyebrow">CATALOG</span><h2>Add an item</h2></div></div>
        <form className="owner-stock-form" onSubmit={(event) => void addItem(event)}>
          <label>SKU<input required maxLength={64} value={form.sku} onChange={(event) => setForm({ ...form, sku: event.target.value })} placeholder="CBL-HDMI-6" /></label>
          <label className="wide-field">Name<input required maxLength={160} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="HDMI Cable 6ft" /></label>
          <label>Cost ($)<input type="number" min="0" step="0.01" value={form.cost} onChange={(event) => setForm({ ...form, cost: event.target.value })} /></label>
          <label>Price ($)<input type="number" min="0" step="0.01" value={form.price} onChange={(event) => setForm({ ...form, price: event.target.value })} /></label>
          <label>Qty<input type="number" min="0" step="1" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} /></label>
          <label>Reorder at<input type="number" min="0" step="1" value={form.par_level} onChange={(event) => setForm({ ...form, par_level: event.target.value })} /></label>
          <button className="primary owner-button" disabled={busy || !storeId}>{busy ? 'Adding…' : 'Add item'}</button>
        </form>
      </section>
      <section className="owner-panel owner-catalog-panel">
        <div className="owner-panel-heading"><div><span className="eyebrow">INVENTORY</span><h2>Catalog ({data?.items.length ?? 0})</h2></div><button className="ghost owner-button" onClick={exportReorderList} disabled={!data?.summary.low_stock}>Export reorder CSV</button></div>
        {data?.items.length ? <div className="owner-table-wrap"><table className="table owner-table owner-stock-table">
          <thead><tr><th>SKU</th><th>Item</th><th>Cost</th><th>Price</th><th>On hand</th><th>Reorder at</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>{data.items.map((item) => <tr key={item.id}>
            <td>{item.sku}</td><td><strong>{item.name}</strong></td>
            <td>{item.cost.toFixed(2)}</td><td>{item.price.toFixed(2)}</td>
            <td><input aria-label={`${item.name} quantity`} type="number" min="0" defaultValue={item.quantity} onBlur={(event) => void updateItem(item, 'quantity', event.target.value)} /></td>
            <td><input aria-label={`${item.name} reorder level`} type="number" min="0" defaultValue={item.par_level} onBlur={(event) => void updateItem(item, 'par_level', event.target.value)} /></td>
            <td><span className={`owner-status ${item.quantity <= item.par_level ? 'is-low' : 'is-online'}`}><i />{item.quantity <= item.par_level ? 'Reorder' : 'In stock'}</span></td>
            <td><button className="owner-text-action danger" onClick={() => void removeItem(item)}>Remove</button></td>
          </tr>)}</tbody>
        </table></div> : <div className="owner-empty-state"><strong>No items in this catalog yet</strong><p>Add your products to keep stock and reorder signals up to date.</p></div>}
      </section>
    </div>
  );
}