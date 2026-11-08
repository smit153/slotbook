import { useCallback, useEffect, useState } from 'react';
import { api, type HostBooking } from '../lib/api.js';
import { formatDate, formatRange, groupByDay, localDate } from '../lib/time.js';
import { ErrorBanner, Notice } from '../components/ErrorBanner.js';
import { useHost } from './DashboardLayout.js';

/** Upcoming bookings by HOST-local day; every time printed with its zone. */
export function Bookings() {
  const { host } = useHost();
  const tz = host.timezone;
  const [showAll, setShowAll] = useState(false);
  const [rows, setRows] = useState<HostBooking[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ bookings: HostBooking[] }>(`/api/host/bookings${showAll ? '' : '?upcoming=1'}`)
      .then((r) => setRows(r.bookings)).catch(setError);
  }, [showAll]);
  useEffect(load, [load]);

  async function cancel(id: string) {
    setError(null);
    try {
      await api(`/api/host/bookings/${id}/cancel`, { method: 'POST', body: { reason } });
      setCancelling(null);
      setReason('');
      setDone('Booking cancelled. The guest will be notified.');
      load();
    } catch (e) {
      setError(e);
    }
  }

  const days = rows ? groupByDay(rows, (b) => localDate(b.start_at, tz)) : [];
  return (
    <section>
      <h1>{showAll ? 'All bookings' : 'Upcoming bookings'}</h1>
      <label className="inline">
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show past and cancelled
      </label>
      <p className="muted">Times in your time zone: {tz}</p>
      <ErrorBanner error={error} />
      {done && <Notice>{done}</Notice>}
      {rows && rows.length === 0 && <p>No bookings yet.</p>}
      {days.map((d) => (
        <div key={d.date} className="day-group">
          <h2>{formatDate(d.date)}</h2>
          <ul className="bookings">
            {d.items.map((b) => (
              <li key={b.id} className={b.status === 'cancelled' ? 'cancelled' : ''}>
                <span className="when">{formatRange(b.start_at, b.end_at, tz)}</span>
                <span>{b.event_name}</span>
                <span>{b.guest_name} &lt;{b.guest_email}&gt;{b.guest_tz && <small className="muted"> · guest in {b.guest_tz}</small>}</span>
                {b.status === 'cancelled'
                  ? <span className="muted">Cancelled by {b.cancelled_by}{b.cancel_reason ? `: ${b.cancel_reason}` : ''}</span>
                  : cancelling === b.id
                    ? (
                      <form className="inline" onSubmit={(e) => { e.preventDefault(); void cancel(b.id); }}>
                        <label htmlFor={`reason-${b.id}`}>Reason</label>
                        <input id={`reason-${b.id}`} required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
                        <button type="submit">Confirm cancel</button>
                        <button type="button" className="link" onClick={() => setCancelling(null)}>Keep</button>
                      </form>
                    )
                    : <button type="button" onClick={() => { setCancelling(b.id); setReason(''); setDone(null); }}>Cancel…</button>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
