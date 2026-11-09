import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { api, ApiError, type Confirmed, type WaitlistState } from '../lib/api.js';
import { deadlineFrom } from '../lib/countdown.js';
import { browserZone, formatDateTime } from '../lib/time.js';
import { ErrorBanner, Notice } from '../components/ErrorBanner.js';
import { Countdown } from '../components/Countdown.js';

/** How often the page re-checks while waiting or offered (well inside the 60/min status limit). */
export const WAITLIST_POLL_MS = 15_000;

/**
 * /waitlist#<entry_id>.<token> (design §13.4). The token lives in the fragment (never sent to a
 * server as a URL) and goes to the API in the Waitlist-Token header.
 */
export function WaitlistPage() {
  const [id = '', token = ''] = useLocation().hash.replace(/^#/, '').split('.');
  const [state, setState] = useState<WaitlistState | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [booked, setBooked] = useState<(Confirmed & { manage_url: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const tz = browserZone();
  const headers = { 'waitlist-token': token };

  // Keep the private page out of search engines (the API also sends X-Robots-Tag).
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  const load = useCallback(async () => {
    if (!id || !token) { setError(new ApiError(404, 'NOT_FOUND', 'This waitlist link is incomplete.')); return; }
    try {
      const s = await api<WaitlistState>(`/api/waitlist/${encodeURIComponent(id)}`, { headers: { 'waitlist-token': token } });
      setState(s);
      setDeadline(s.offer ? deadlineFrom(s.offer.expires_at, s.offer.server_now, performance.now()) : null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? new ApiError(404, 'NOT_FOUND', 'This waitlist link is not valid.') : e);
    }
  }, [id, token]);

  useEffect(() => { void load(); }, [load]);
  const live = state?.status === 'waiting' || state?.status === 'offered';
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void load(), WAITLIST_POLL_MS);
    return () => clearInterval(t);
  }, [live, load]);

  async function claim() {
    setBusy(true); setError(null);
    try {
      setBooked(await api<Confirmed & { manage_url: string }>(`/api/waitlist/${encodeURIComponent(id)}/claim`, { method: 'POST', headers }));
    } catch (e) { setError(e); await load(); } finally { setBusy(false); }
  }

  async function leave() {
    setBusy(true); setError(null);
    try {
      await api(`/api/waitlist/${encodeURIComponent(id)}/leave`, { method: 'POST', headers });
      setNotice('You left the waitlist.');
      await load();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  if (booked) {
    return (
      <main className="narrow">
        <h1>You're booked</h1>
        <p>{formatDateTime(booked.booking.start_at, tz)}</p>
        <p>Keep this private link to view, reschedule or cancel:</p>
        <p><a href={booked.manage_url} className="manage-link">{`${location.origin}${booked.manage_url}`}</a></p>
      </main>
    );
  }
  if (!state) return <main className="narrow"><h1>Your waitlist spot</h1><ErrorBanner error={error} />{!error && <p>Loading…</p>}</main>;

  const when = formatDateTime(state.slot.start_at, tz);
  return (
    <main className="narrow">
      <h1>{state.slot.event_type.name}</h1>
      <p>with {state.slot.host.name} · <strong>{when}</strong></p>
      <ErrorBanner error={error} />
      {notice && <Notice>{notice}</Notice>}
      {state.status === 'waiting' && (
        <>
          <p>You're <strong>#{state.position}</strong> on the waitlist. If a seat frees up, it is held for you; this page updates by itself.</p>
          <button type="button" className="link" disabled={busy} onClick={() => void leave()}>Leave the waitlist</button>
        </>
      )}
      {state.status === 'offered' && deadline !== null && (
        <section className="hold" aria-label="Your offer">
          <p><strong>A seat is yours.</strong> <Countdown deadline={deadline} onExpire={() => void load()} /></p>
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => void claim()}>Confirm booking</button>
            <button type="button" className="link" disabled={busy} onClick={() => void leave()}>No thanks</button>
          </div>
        </section>
      )}
      {state.status === 'booked' && <p>You're booked. Use the manage link you got when you confirmed.</p>}
      {state.status === 'lapsed' && <p>This offer expired and went to the next person on the waitlist.</p>}
      {state.status === 'left' && !notice && <p>You left the waitlist.</p>}
      {state.status === 'closed' && <p>This time can no longer be booked, so the waitlist is closed.</p>}
    </main>
  );
}
