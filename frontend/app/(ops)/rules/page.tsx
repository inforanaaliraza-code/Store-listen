'use client';

import { FormEvent, useEffect, useState } from 'react';
import { apiDelete, apiGet, apiPatch, apiPost, type Store } from '../../../lib/api';
import { useConfirmDialog } from '../../components/confirm-dialog';

type StoreRule = { id: string; store_id: string; name: string; dollar_value: number; trigger_condition: string; expected_action: string; active: boolean };
type RuleForm = { name: string; dollar_value: string; trigger_condition: string; expected_action: string };
const emptyForm: RuleForm = { name: '', dollar_value: '0', trigger_condition: '', expected_action: '' };

export default function RulesPage() {
  const confirmDialog = useConfirmDialog();
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState('');
  const [rules, setRules] = useState<StoreRule[]>([]);
  const [form, setForm] = useState<RuleForm>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    apiGet<{ stores: { items: Store[] } }>('/api/v1/stores?page_size=100').then((result) => {
      setStores(result.stores.items);
      setStoreId((current) => current || result.stores.items[0]?.id || '');
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Unable to load stores'));
  }, []);

  async function loadRules(id = storeId) {
    if (!id) return;
    setError('');
    try {
      const result = await apiGet<{ rules: StoreRule[] }>(`/api/v1/rules?store_id=${encodeURIComponent(id)}`);
      setRules(result.rules);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load rules'); }
  }

  useEffect(() => {
    if (!storeId) return;
    let active = true;
    setError('');
    apiGet<{ rules: StoreRule[] }>(`/api/v1/rules?store_id=${encodeURIComponent(storeId)}`).then((result) => {
      if (active) setRules(result.rules);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Unable to load rules');
    });
    return () => { active = false; };
  }, [storeId]);

  async function addRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!storeId) return;
    setBusy(true);
    setError('');
    try {
      await apiPost('/api/v1/rules', { store_id: storeId, ...form, dollar_value: Number(form.dollar_value) });
      setForm(emptyForm);
      await loadRules();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to add rule'); }
    finally { setBusy(false); }
  }

  async function toggleRule(rule: StoreRule) {
    try { await apiPatch(`/api/v1/rules/${rule.id}`, { active: !rule.active }); await loadRules(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to update rule'); }
  }

  async function removeRule(rule: StoreRule) {
    const confirmed = await confirmDialog({
      title: 'Delete this rule?',
      message: 'This rule will be removed from the store playbook and can no longer trigger coaching.',
      subject: rule.name,
      confirmLabel: 'Delete rule',
      tone: 'danger',
    });
    if (!confirmed) return;
    try { await apiDelete(`/api/v1/rules/${rule.id}`); await loadRules(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to delete rule'); }
  }

  return (
    <div className="owner-page">
      <div className="heading">
        <div><span className="eyebrow">SHOP OWNER</span><h1 className="serif">Rules</h1><p>Define the customer moments your team should act on.</p></div>
        <label className="owner-select-label">Store<select value={storeId} onChange={(event) => setStoreId(event.target.value)} aria-label="Choose store">{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
      </div>
      {error ? <div className="error" role="alert">{error}</div> : null}
      <section className="owner-panel owner-form-panel">
        <div className="owner-panel-heading"><div><span className="eyebrow">RULE BUILDER</span><h2>Add a new rule</h2></div></div>
        <form className="owner-rules-form" onSubmit={(event) => void addRule(event)}>
          <label>Rule name<input required maxLength={160} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Wire buyer → charger offer" /></label>
          <label>Dollar value<input type="number" min="0" max="1000000" step="0.01" value={form.dollar_value} onChange={(event) => setForm({ ...form, dollar_value: event.target.value })} /></label>
          <label className="full-field">Trigger condition<textarea required maxLength={2000} value={form.trigger_condition} onChange={(event) => setForm({ ...form, trigger_condition: event.target.value })} placeholder="When the customer asks about a charging cable…" /></label>
          <label className="full-field">Expected action<textarea required maxLength={2000} value={form.expected_action} onChange={(event) => setForm({ ...form, expected_action: event.target.value })} placeholder="Employee offers a compatible wall charger…" /></label>
          <button className="primary owner-button" disabled={busy || !storeId}>{busy ? 'Adding…' : 'Add rule'}</button>
        </form>
      </section>
      <section className="owner-panel owner-rules-list">
        <div className="owner-panel-heading"><div><span className="eyebrow">STORE PLAYBOOK</span><h2>Active rules ({rules.filter((rule) => rule.active).length}/{rules.length})</h2></div></div>
        {rules.length ? <div className="owner-rule-stack">{rules.map((rule) => <article className={`owner-rule ${rule.active ? '' : 'is-disabled'}`} key={rule.id}>
          <div className="owner-rule-main">
            <div className="owner-rule-title"><h3>{rule.name}</h3><span className="owner-value-tag">${rule.dollar_value.toFixed(0)}/miss</span><span className={`owner-status ${rule.active ? 'is-online' : 'is-offline'}`}><i />{rule.active ? 'Active' : 'Disabled'}</span></div>
            <p><strong>Trigger:</strong> {rule.trigger_condition}</p>
            <p><strong>Action:</strong> {rule.expected_action}</p>
          </div>
          <div className="owner-rule-actions"><button className="ghost owner-button" onClick={() => void toggleRule(rule)}>{rule.active ? 'Disable' : 'Enable'}</button><button className="ghost owner-button danger-button" onClick={() => void removeRule(rule)}>Delete</button></div>
        </article>)}</div> : <div className="owner-empty-state"><strong>No rules added for this store</strong><p>Create a playbook rule to make expectations clear for the team.</p></div>}
      </section>
    </div>
  );
}