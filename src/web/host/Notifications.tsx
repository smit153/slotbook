import { useEffect, useState } from 'react';
import { api, type NotificationRow } from '../lib/api.js';
import { formatDateTime } from '../lib/time.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import { useHost } from './DashboardLayout.js';

/** The notifications sink (outbox): what would have been emailed. Tokens are never in here. */
export function Notifications() {
  const { host } = useHost();
  const [rows, setRows] = useState<NotificationRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { api<{ notifications: NotificationRow[] }>('/api/host/notifications').then((r) => setRows(r.notifications)).catch(setError); }, []);
  return (
    <section>
      <h1>Notifications</h1>
      <ErrorBanner error={error} />
      {rows && rows.length === 0 && <p>Nothing yet.</p>}
      <ul className="notifications">
        {rows?.map((n) => {
          const p = n.payload as { start_at?: string; guest_name?: string; cancelled_by?: string; reason?: string | null; previous_start_at?: string };
          return (
            <li key={n.id}>
              <code>{n.type}</code> · {p.guest_name ?? 'guest'} · {p.start_at && formatDateTime(p.start_at, host.timezone)}
              {p.previous_start_at && <span className="muted"> (was {formatDateTime(p.previous_start_at, host.timezone)})</span>}
              {p.cancelled_by && <span className="muted"> · cancelled by {p.cancelled_by}{p.reason ? `: ${p.reason}` : ''}</span>}
              <span className="muted"> · logged {formatDateTime(n.created_at, host.timezone)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
