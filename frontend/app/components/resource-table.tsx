'use client';

import Link from '@/lib/router-link';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { apiDelete, apiGet, apiPatch, apiPost } from '../../lib/api';
import { useConfirmDialog } from './confirm-dialog';

type FormField = {
  key: string;
  label: string;
  type?: 'text' | 'select';
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  options?: { value: string; label: string }[];
};

type Props = {
  title: string;
  eyebrow: string;
  description: string;
  endpoint: string;
  collection?: string;
  columns: { key: string; label: string }[];
  hrefFor?: (row: Record<string, unknown>) => string;
  manage?: {
    singular: string;
    roles: string[];
    fields: FormField[];
    deleteLabel?: string;
    deleteConfirmation?: string;
  };
};

function cell(value: unknown) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number' && value > 0 && value < 1) return `${Math.round(value * 100)}%`;
  return String(value);
}

export function ResourceTable({ title, eyebrow, description, endpoint, collection, columns, hrefFor, manage }: Props) {
  const confirmDialog = useConfirmDialog();
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [actionError, setActionError] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState('');
  const rolesKey = manage?.roles.join('|') ?? '';

  const load = useCallback(async () => {
    setError('');
    try {
      const result = await apiGet<Record<string, unknown>>(endpoint);
      setPayload(result);
      const raw = collection ? result[collection] : result;
      const list = Array.isArray(raw) ? raw : Array.isArray((raw as { items?: unknown[] })?.items) ? ((raw as { items: Record<string, unknown>[] }).items) : [];
      setRows(list as Record<string, unknown>[]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load');
    }
  }, [collection, endpoint]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!rolesKey) {
      setCanManage(false);
      return;
    }
    let mounted = true;
    apiGet<{ role: string }>('/api/v1/auth/me')
      .then((user) => { if (mounted) setCanManage(rolesKey.split('|').includes(user.role)); })
      .catch(() => { if (mounted) setCanManage(false); });
    return () => { mounted = false; };
  }, [rolesKey]);

  const filtered = useMemo(() => {
    const needle = search.toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => JSON.stringify(row).toLowerCase().includes(needle));
  }, [rows, search]);

  function openCreate() {
    if (!manage) return;
    setEditing(null);
    setFormValues(Object.fromEntries(manage.fields.map((field) => [field.key, field.defaultValue ?? ''])));
    setFormError('');
    setActionError('');
    setEditorOpen(true);
  }

  function openEdit(row: Record<string, unknown>) {
    if (!manage) return;
    setEditing(row);
    setFormValues(Object.fromEntries(manage.fields.map((field) => [field.key, String(row[field.key] ?? '')])));
    setFormError('');
    setActionError('');
    setEditorOpen(true);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!manage) return;
    setSaving(true);
    setFormError('');
    try {
      const body = Object.fromEntries(manage.fields.map((field) => [field.key, formValues[field.key] ?? '']));
      if (editing) await apiPatch(`${endpoint}/${String(editing.id)}`, body);
      else await apiPost(endpoint, body);
      setEditorOpen(false);
      setEditing(null);
      setActionError('');
      await load();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : 'Unable to save this record');
    } finally {
      setSaving(false);
    }
  }

  async function remove(row: Record<string, unknown>) {
    if (!manage || typeof row.id !== 'string') return;
    const action = manage.deleteLabel ?? 'Delete';
    const name = String(row.name ?? row.id);
    const isDelete = action.toLowerCase() === 'delete';
    const confirmed = await confirmDialog({
      title: `${action} ${manage.singular}?`,
      message: manage.deleteConfirmation ?? (isDelete
        ? `This permanently deletes this ${manage.singular.toLowerCase()}. This action cannot be undone.`
        : `This archives the ${manage.singular.toLowerCase()}; its history will be kept.`),
      subject: name,
      confirmLabel: action,
      tone: isDelete ? 'danger' : 'default',
    });
    if (!confirmed) return;
    setDeletingId(row.id);
    setActionError('');
    try {
      await apiDelete(`${endpoint}/${row.id}`);
      await load();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : `Unable to ${action.toLowerCase()} this record`);
    } finally {
      setDeletingId('');
    }
  }

  if (error) return <section className="error"><h1>{title}</h1><p>{error}</p><button className="ghost" onClick={() => void load()}>Retry</button></section>;

  return (
    <div>
      <div className="heading">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h1 className="serif">{title}</h1>
          <p>{description}</p>
        </div>
        <div className="resource-heading-actions">
          <button className="ghost" onClick={() => void load()}>Refresh</button>
          {manage && canManage ? <button className="primary" style={{ width: 'auto' }} onClick={openCreate}>Add {manage.singular}</button> : null}
        </div>
      </div>
      {editorOpen && manage ? (
        <form className="panel resource-editor" onSubmit={save}>
          <div className="heading"><div><span className="eyebrow">{editing ? 'UPDATE RECORD' : 'NEW RECORD'}</span><h2 className="serif">{editing ? `Edit ${manage.singular}` : `Add ${manage.singular}`}</h2></div></div>
          <div className="resource-form-grid">
            {manage.fields.map((field) => (
              <label className="field" key={field.key}>
                {field.label}
                {field.type === 'select' ? (
                  <select required={field.required !== false} value={formValues[field.key] ?? ''} onChange={(event) => setFormValues((current) => ({ ...current, [field.key]: event.target.value }))}>
                    <option value="">Select {field.label.toLowerCase()}</option>
                    {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                ) : (
                  <input required={field.required !== false} maxLength={field.key === 'timezone' ? 64 : undefined} placeholder={field.placeholder} value={formValues[field.key] ?? ''} onChange={(event) => setFormValues((current) => ({ ...current, [field.key]: event.target.value }))} />
                )}
              </label>
            ))}
          </div>
          {formError ? <p className="resource-error" role="alert">{formError}</p> : null}
          <div className="resource-editor-actions">
            <button type="submit" className="primary" style={{ width: 'auto' }} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save changes' : `Create ${manage.singular}`}</button>
            <button type="button" className="ghost" disabled={saving} onClick={() => setEditorOpen(false)}>Cancel</button>
          </div>
        </form>
      ) : null}
      <div className="toolbar">
        <input className="search" placeholder="Filter" value={search} onChange={(event) => setSearch(event.target.value)} />
        <span className="chip">{filtered.length} records · API data</span>
      </div>
      {actionError ? <div className="banner resource-error" role="alert">{actionError}</div> : null}
      <article className="panel">
        {filtered.length === 0 ? <div className="empty"><strong>No matching records</strong><p>Try another filter or replay the live demo.</p></div> : (
            <table className="table">
            <thead><tr>{columns.map((col) => <th key={col.key}>{col.label}</th>)}{manage && canManage ? <th>Actions</th> : null}</tr></thead>
            <tbody>
              {filtered.map((row, index) => (
                <tr key={String(row.id ?? index)}>
                  {columns.map((col) => {
                    const value = col.key === 'active' && typeof row.active === 'boolean'
                      ? row.active ? 'Active' : 'Archived'
                      : cell(row[col.key]);
                    const href = hrefFor?.(row);
                    return <td key={col.key}>{col.key === columns[0].key && href ? <Link href={href}>{value}</Link> : value}</td>;
                  })}
                  {manage && canManage ? <td><div className="resource-row-actions"><button className="ghost" onClick={() => openEdit(row)}>Edit</button><button className="ghost" disabled={deletingId === row.id} onClick={() => void remove(row)}>{deletingId === row.id ? 'Working…' : manage.deleteLabel ?? 'Delete'}</button></div></td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </article>
      {payload && !collection ? <pre className="panel" style={{ marginTop: 12, overflow: 'auto', fontSize: 12 }}>{JSON.stringify(payload, null, 2)}</pre> : null}
    </div>
  );
}

export function OpportunityActions() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function mark(id: string, status: 'REVIEW_REQUIRED' | 'MISSED' | 'CONVERTED') {
    setBusy(true);
    setError('');
    try {
      await apiPatch(`/api/v1/opportunities/${id}`, { status, manager_note: 'Manager override from dashboard' });
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update opportunity');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="banner" style={{ marginBottom: 12 }}>
      Managers can override AI classifications. Never treat MISSED as an automatic personnel finding.
      {error ? <p role="alert" style={{ marginBottom: 0 }}>{error}</p> : null}
      <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
        <button className="ghost" disabled={busy} onClick={() => void mark('opp-2002', 'REVIEW_REQUIRED')}>{busy ? 'Saving…' : 'Send cable case to review'}</button>
      </div>
    </div>
  );
}

export function PosDemoButton() {
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function simulateSale() {
    setBusy(true);
    setError('');
    try {
      const result = await apiPost<{ transaction: { id: string }; match: { conversation_id: string } | null }>('/api/v1/pos/demo');
      setNote(`Simulated ${result.transaction.id}${result.match ? ` · matched ${result.match.conversation_id}` : ''}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to simulate a sale');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="toolbar">
      <button className="ghost" disabled={busy} onClick={() => void simulateSale()}>{busy ? 'Sending…' : 'Simulate USB-C sale'}</button>
      <span className="chip" aria-live="polite">{error || note || 'MockPOSProvider only'}</span>
    </div>
  );
}
