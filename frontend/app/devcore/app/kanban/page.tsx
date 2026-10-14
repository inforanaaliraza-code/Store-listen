'use client';

import { DragEvent, FormEvent, useCallback, useEffect, useState } from 'react';
import { apiGet, apiPatch, apiPost } from '../../../../lib/api';

type Task = {
  id: string;
  title: string;
  status: string;
  priority: string;
  assignee: string;
  due_date: string | null;
  labels: string;
};

const columns = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'todo', label: 'Todo' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
];

export default function KanbanPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const payload = await apiGet<{ tasks: Task[] }>('/api/v1/devcore/tasks');
      setTasks(payload.tasks);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load tasks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function onDrop(status: string, event: DragEvent) {
    const id = event.dataTransfer.getData('text/plain');
    if (!id || busy) return;
    setBusy(true);
    setError('');
    try {
      await apiPatch(`/api/v1/devcore/tasks/${id}`, { status });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to move task');
    } finally {
      setBusy(false);
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError('');
    try {
      await apiPost('/api/v1/devcore/tasks', { title, status: 'todo', priority: 'medium' });
      setTitle('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create task');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="heading">
        <div>
          <span className="eyebrow">DELIVERY</span>
          <h1 className="serif">Kanban</h1>
          <p>Drag cards between columns. Changes persist in the database.</p>
        </div>
        <form onSubmit={create} className="kanban-create">
          <input className="search" placeholder="New task" value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
          <button className="ghost" type="submit" disabled={busy || !title.trim()}>{busy ? 'Saving…' : 'Add'}</button>
        </form>
      </div>
      {error ? <div className="error" role="alert"><p>{error}</p><button className="ghost" onClick={() => void load()}>Retry load</button></div> : null}
      {loading ? <div className="skeleton" /> : null}
      <div className="kanban">
        {columns.map((column) => (
          <section
            key={column.id}
            className="panel kanban-col"
            onDragOver={(event) => { if (!busy) event.preventDefault(); }}
            onDrop={(event) => void onDrop(column.id, event)}
          >
            <h2 className="serif">{column.label}</h2>
            {tasks.filter((task) => task.status === column.id).map((task) => (
              <article
                className="task"
                key={task.id}
                draggable
                onDragStart={(event) => event.dataTransfer.setData('text/plain', task.id)}
              >
                <strong>{task.title}</strong>
                <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 6 }}>{task.priority} · {task.assignee || 'Unassigned'}</div>
                {task.labels ? <div className="chip" style={{ marginTop: 8 }}>{task.labels}</div> : null}
              </article>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
