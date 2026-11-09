import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { api, ApiError, newIdempotencyKey, type Confirmed, type Hold, type Slot, type SlotsResponse, type WaitlistJoined } from '../lib/api.js';
import { deadlineFrom } from '../lib/countdown.js';
import { browserZone, formatDateTime } from '../lib/time.js';
import { ErrorBanner, Notice } from '../components/ErrorBanner.js';
import { Countdown } from '../components/Countdown.js';
import { SlotPicker } from '../components/SlotPicker.js';

type ActiveHold = Hold & { deadline: number };

async function release(h: Hold, keepalive = false): Promise<void> {
  // Best effort: holds expire on their own; release only frees the seat (and the IP cap) sooner.
  await api(`/api/holds/${h.hold_id}/release`, { method: 'POST', body: { hold_secret: h.hold_secret }, keepalive }).catch(() => undefined);
}

/** /:host/:slug — pick a time (held 5 min), enter name + email, get a private manage link. */
export function BookingPage() {
  const { host = '', slug = '' } = useParams();
  const [tz, setTz] = useState(browserZone); // always start from the browser's zone (agreed)
  const [info, setInfo] = useState<SlotsResponse | null>(null);
  const [hold, setHold] = useState<ActiveHold | null>(null);
  const holdRef = useRef<Hold | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [done, setDone] = useState<Confirmed | null>(null);
  // Waitlist (design §13): a full time picked → join form; one Idempotency-Key per attempt.
  const [waitSlot, setWaitSlot] = useState<Slot | null>(null);
  const waitKey = useRef<string>('');
  const [joined, setJoined] = useState<WaitlistJoined | null>(null);

  // Leaving the page with a hold: give it back (keepalive survives the unload).
  useEffect(() => {
    const onHide = () => { if (holdRef.current) void release(holdRef.current, true); };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  /**
   * Hold the NEW slot first, and only then release the old one. If the new hold fails
   * (e.g. 409, someone was faster), the guest still has the slot they had.
   */
  async function pick(slot: Slot) {
    if (slot.waitlist) {
      setError(null); setNotice(null);
      if (holdRef.current) { setNotice('You already hold a time. Confirm it (or let it go) before joining a waitlist.'); return; }
      setWaitSlot(slot);
      waitKey.current = newIdempotencyKey();
      return;
    }
    setWaitSlot(null);
    setBusy(true);
    setError(null);
    setNotice(null);
    const previous = holdRef.current;
    try {
      const h = await api<Hold>('/api/holds', {
        method: 'POST', body: { host, slug, start_at: slot.start_at }, idempotencyKey: newIdempotencyKey(),
      });
      holdRef.current = h;
      setHold({ ...h, deadline: deadlineFrom(h.expires_at, h.server_now, performance.now()) });
      if (previous) void release(previous);
    } catch (e) {
      setError(e);
      if (previous) setNotice(`You still have ${formatDateTime(previous.start_at, tz)} held.`);
      if (e instanceof ApiError && (e.code === 'SLOT_UNAVAILABLE' || e.code === 'SLOT_NOT_OFFERED')) setRefreshKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  }

  const onExpire = useCallback(() => {
    holdRef.current = null;
    setHold(null);
    setNotice('Your hold expired. Please pick a time again.');
    setRefreshKey((k) => k + 1);
  }, []);

  async function confirm(e: FormEvent) {
    e.preventDefault();
    if (!hold) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<Confirmed>(`/api/holds/${hold.hold_id}/confirm`, {
        method: 'POST', body: { hold_secret: hold.hold_secret, name, email, tz },
      });
      holdRef.current = null;
      setDone(r);
    } catch (err) {
      setError(err);
      if (err instanceof ApiError && err.status === 410) {
        holdRef.current = null;
        setHold(null);
        setRefreshKey((k) => k + 1);
      }
    } finally {
      setBusy(false);
    }
  }

  async function joinWaitlist(e: FormEvent) {
    e.preventDefault();
    if (!waitSlot) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<WaitlistJoined>('/api/waitlist', {
        method: 'POST', idempotencyKey: waitKey.current,
        body: { host, slug, start_at: waitSlot.start_at, name, email, tz },
      });
      setJoined(r);
    } catch (err) {
      setError(err);
      if (err instanceof ApiError && err.code === 'SLOT_AVAILABLE') { setWaitSlot(null); setRefreshKey((k) => k + 1); }
    } finally {
      setBusy(false);
    }
  }

  if (joined && waitSlot) {
    return (
      <main className="narrow">
        <h1>You're on the waitlist</h1>
        <p>{formatDateTime(waitSlot.start_at, tz)} · position {joined.position}</p>
        <p>If a seat frees up, it is held for you for 15 minutes. Keep this private link to see and confirm your offer:</p>
        <p><a href={joined.waitlist_url} className="waitlist-link">{`${location.origin}${joined.waitlist_url}`}</a></p>
      </main>
    );
  }

  if (done) {
    const link = `${location.origin}${done.manage_url}`;
    return (
      <main className="narrow">
        <h1>You're booked</h1>
        <p><strong>{done.booking.event_type.name}</strong> with {done.booking.host.name}</p>
        <p>{formatDateTime(done.booking.start_at, tz)}</p>
        <p>Keep this private link to view, reschedule or cancel:</p>
        <p><a href={done.manage_url} className="manage-link">{link}</a></p>
        <button type="button" onClick={() => void navigator.clipboard?.writeText(link)}>Copy link</button>
      </main>
    );
  }

  return (
    <main>
      <h1>{info?.event_type.name ?? 'Book a time'}</h1>
      {info && <p className="muted">{info.event_type.duration_min} minutes with {info.host.name}</p>}
      <ErrorBanner error={error} />
      {notice && <Notice>{notice}</Notice>}
      <div className="booking">
        <SlotPicker host={host} slug={slug} tz={tz} onTzChange={setTz} onPick={pick} busy={busy}
          refreshKey={refreshKey} selectedStart={hold?.start_at} onLoaded={setInfo} withWaitlist />
        {waitSlot && !hold && (
          <form className="hold" onSubmit={joinWaitlist} aria-label="Join the waitlist">
            <p><strong>{formatDateTime(waitSlot.start_at, tz)}</strong> is full. Join the waitlist: if a seat frees up, it is held for you.</p>
            <label htmlFor="wait-name">Name</label>
            <input id="wait-name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
            <label htmlFor="wait-email">Email</label>
            <input id="wait-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            <button type="submit" disabled={busy}>Join waitlist</button>
          </form>
        )}
        {hold && (
          <form className="hold" onSubmit={confirm} aria-label="Your details">
            <p>
              <strong>{formatDateTime(hold.start_at, tz)}</strong>{' '}
              <Countdown deadline={hold.deadline} onExpire={onExpire} />
            </p>
            <label htmlFor="guest-name">Name</label>
            <input id="guest-name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
            <label htmlFor="guest-email">Email</label>
            <input id="guest-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            <button type="submit" disabled={busy}>Confirm booking</button>
          </form>
        )}
      </div>
    </main>
  );
}
