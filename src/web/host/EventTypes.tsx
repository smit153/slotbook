import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type EventType } from '../lib/api.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { useHost } from './DashboardLayout.js';

type Draft = Omit<EventType, 'id' | 'active'>;
const EMPTY: Draft = { name: '', slug: '', duration_min: 30, capacity: 1, buffer_before_min: 0, buffer_after_min: 0, min_notice_min: 240, horizon_days: 30 };

const FIELDS: Array<{ key: keyof Draft; label: string; min?: number; max?: number; type?: 'text' }> = [
  { key: 'name', label: 'Name', type: 'text' },
  { key: 'slug', label: 'Slug (URL)', type: 'text' },
  { key: 'duration_min', label: 'Duration (min)', min: 15, max: 120 },
  { key: 'capacity', label: 'Capacity (1 = one-on-one)', min: 1, max: 1000 },
  { key: 'buffer_before_min', label: 'Buffer before (min)', min: 0, max: 30 },
  { key: 'buffer_after_min', label: 'Buffer after (min)', min: 0, max: 30 },
  { key: 'min_notice_min', label: 'Minimum notice (min)', min: 0 },
  { key: 'horizon_days', label: 'Booking horizon (days)', min: 1, max: 365 },
];

function EventTypeForm({ initial, submitLabel, onSubmit, onCancel }: {
  initial: Draft; submitLabel: string; onSubmit: (d: Draft) => Promise<void>; onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try { await onSubmit(draft); } catch (err) { setError(err); }
  }
  return (
    <form className="grid-form" onSubmit={submit}>
      {FIELDS.map((f) => {
        const id = `${submitLabel}-${f.key}`.replace(/\s+/g, '-');
        return (
          <div key={f.key}>
            <label htmlFor={id}>{f.label}</label>
            {f.type === 'text'
              ? <input id={id} required value={draft[f.key] as string} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
              : <input id={id} type="number" required min={f.min} max={f.max} value={draft[f.key] as number}
                  onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })} />}
          </div>
        );
      })}
      <ErrorBanner error={error} />
      <div className="actions">
        <button type="submit">{submitLabel}</button>
        {onCancel && <button type="button" className="link" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

export function EventTypes() {
  const { host } = useHost();
  const [rows, setRows] = useState<EventType[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    api<{ event_types: EventType[] }>('/api/host/event-types').then((r) => setRows(r.event_types)).catch(setError);
  }, []);
  useEffect(load, [load]);

  async function setActive(et: EventType, active: boolean) {
    setError(null);
    try { await api(`/api/host/event-types/${et.id}`, { method: 'PATCH', body: { active } }); load(); } catch (e) { setError(e); }
  }

  return (
    <section>
      <h1>Event types</h1>
      <ErrorBanner error={error} />
      <ul className="event-types">
        {rows.map((et) => (
          <li key={et.id} className={et.active ? '' : 'inactive'}>
            {editing === et.id
              ? (
                <EventTypeForm initial={et} submitLabel={`Save ${et.slug}`} onCancel={() => setEditing(null)}
                  onSubmit={async (d) => { await api(`/api/host/event-types/${et.id}`, { method: 'PATCH', body: d }); setEditing(null); load(); }} />
              )
              : (
                <>
                  <strong>{et.name}</strong> · {et.duration_min} min · {et.capacity === 1 ? 'one-on-one' : `group of ${et.capacity}`}
                  {!et.active && <span className="badge">inactive</span>}
                  <div className="muted">
                    Public link: <a href={`/${host.slug}/${et.slug}`}>{`${location.origin}/${host.slug}/${et.slug}`}</a>
                  </div>
                  <div className="actions">
                    <button type="button" onClick={() => setEditing(et.id)}>Edit</button>
                    {et.active
                      ? <button type="button" onClick={() => setActive(et, false)}>Deactivate</button>
                      : <button type="button" onClick={() => setActive(et, true)}>Activate</button>}
                  </div>
                </>
              )}
          </li>
        ))}
      </ul>
      {creating
        ? <EventTypeForm initial={EMPTY} submitLabel="Create" onCancel={() => setCreating(false)}
            onSubmit={async (d) => { await api('/api/host/event-types', { method: 'POST', body: d }); setCreating(false); load(); }} />
        : <button type="button" onClick={() => setCreating(true)}>New event type</button>}
      <p className="muted">Event types are never deleted — deactivate one to hide it; existing bookings keep working.</p>
    </section>
  );
}
