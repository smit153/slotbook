import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { api, ApiError, type Booking, type Slot } from '../lib/api.js';
import { browserZone, formatDateTime } from '../lib/time.js';
import { ErrorBanner, Notice } from '../components/ErrorBanner.js';
import { SlotPicker } from '../components/SlotPicker.js';

/** Keep the private manage page out of search engines (the API also sends X-Robots-Tag). */
function useNoIndex() {
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
}

/** /manage#<token> — the token lives in the fragment, which browsers never send to a server. */
export function ManagePage() {
  useNoIndex();
  const token = useLocation().hash.replace(/^#/, '');
  const [tz, setTz] = useState(browserZone);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'reschedule' | 'cancel'>('view');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!token) { setError(new ApiError(404, 'NOT_FOUND', 'This link is incomplete.')); return; }
    api<{ booking: Booking }>(`/api/bookings/${encodeURIComponent(token)}`)
      .then((r) => setBooking(r.booking))
      .catch((e: unknown) => setError(e instanceof ApiError && e.status === 404 ? new ApiError(404, 'NOT_FOUND', 'This booking link is not valid.') : e));
  }, [token]);

  async function reschedule(slot: Slot) {
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api<{ booking: Booking }>(`/api/bookings/${encodeURIComponent(token)}/reschedule`, { method: 'POST', body: { start_at: slot.start_at } });
      setBooking(r.booking);
      setMode('view');
      setNotice(`Moved to ${formatDateTime(r.booking.start_at, tz)}.`);
    } catch (e) {
      setError(e);
      setRefreshKey((k) => k + 1);
    } finally { setBusy(false); }
  }

  async function cancel() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api<{ booking: Booking }>(`/api/bookings/${encodeURIComponent(token)}/cancel`, { method: 'POST', body: reason ? { reason } : {} });
      setBooking(r.booking);
      setMode('view');
      setNotice('Your booking is cancelled.');
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  if (!booking) return <main className="narrow"><h1>Your booking</h1><ErrorBanner error={error} />{!error && <p>Loading…</p>}</main>;

  // UI hint only; the server enforces BOOKING_STARTED with its own clock.
  const started = Date.parse(booking.start_at) <= Date.now();
  const changeable = booking.status === 'confirmed' && !started;

  return (
    <main className="narrow">
      <h1>{booking.event_type.name}</h1>
      <p>with {booking.host.name}</p>
      <p className="when-big">{formatDateTime(booking.start_at, tz)}</p>
      <p>Status: <strong>{booking.status}</strong>
        {booking.status === 'cancelled' && booking.cancelled_by && <> (by the {booking.cancelled_by}{booking.cancel_reason ? `: ${booking.cancel_reason}` : ''})</>}
      </p>
      <ErrorBanner error={error} />
      {notice && <Notice>{notice}</Notice>}
      {booking.status === 'confirmed' && started && <p className="muted">This booking has started and can no longer be changed.</p>}

      {changeable && mode === 'view' && (
        <div className="actions">
          <button type="button" onClick={() => setMode('reschedule')}>Reschedule</button>
          <button type="button" onClick={() => setMode('cancel')}>Cancel booking</button>
        </div>
      )}
      {changeable && mode === 'reschedule' && (
        <>
          <h2>Pick a new time</h2>
          <SlotPicker host={booking.host.slug} slug={booking.event_type.slug} tz={tz} onTzChange={setTz} onPick={reschedule} busy={busy} refreshKey={refreshKey} />
          <button type="button" className="link" onClick={() => setMode('view')}>Keep current time</button>
        </>
      )}
      {changeable && mode === 'cancel' && (
        <form onSubmit={(e) => { e.preventDefault(); void cancel(); }}>
          <label htmlFor="cancel-reason">Reason (optional)</label>
          <input id="cancel-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="actions">
            <button type="submit" disabled={busy}>Yes, cancel my booking</button>
            <button type="button" className="link" onClick={() => setMode('view')}>Keep it</button>
          </div>
        </form>
      )}
    </main>
  );
}
