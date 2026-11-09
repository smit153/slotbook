import { useEffect, useRef, useState } from 'react';
import { api, type Slot, type SlotsResponse } from '../lib/api.js';
import { formatDate, groupByDay, nextDaysRange, slotButtonLabel, zoneAbbr } from '../lib/time.js';
import { ErrorBanner } from './ErrorBanner.js';
import { TimeZoneSelect } from './TimeZoneSelect.js';

/**
 * Days → times for the next 30 days in the guest's chosen zone. Used by the booking page and
 * by the manage page's reschedule. Duplicate fall-back times show their zone (01:00 EDT / EST).
 */
export function SlotPicker({ host, slug, tz, onTzChange, onPick, busy, refreshKey, selectedStart, onLoaded, withWaitlist }: {
  host: string;
  slug: string;
  tz: string;
  onTzChange: (tz: string) => void;
  onPick: (slot: Slot) => void;
  busy?: boolean;
  refreshKey?: number;
  selectedStart?: string;
  onLoaded?: (r: SlotsResponse) => void;
  /** Also list full times, with a "join waitlist" action (booking page only; design §13.5). */
  withWaitlist?: boolean;
}) {
  const [data, setData] = useState<SlotsResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [day, setDay] = useState<string | null>(null);
  // Held in a ref so an inline callback from the parent does not re-trigger the fetch.
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  useEffect(() => {
    let live = true;
    const { from, to } = nextDaysRange(tz, 30);
    setError(null);
    api<SlotsResponse>(`/api/hosts/${encodeURIComponent(host)}/events/${encodeURIComponent(slug)}/slots?from=${from}&to=${to}&tz=${encodeURIComponent(tz)}${withWaitlist ? '&include_full=1' : ''}`)
      .then((r) => { if (live) { setData(r); onLoadedRef.current?.(r); } })
      .catch((e: unknown) => { if (live) setError(e); });
    return () => { live = false; };
  }, [host, slug, tz, refreshKey, withWaitlist]);

  const days = data ? groupByDay(data.slots, (s) => s.local.date) : [];
  const current = days.find((d) => d.date === day) ?? days[0];
  const group = (data?.event_type.capacity ?? 1) > 1;

  return (
    <section className="slot-picker" aria-label="Pick a time">
      <div className="row">
        <label htmlFor="tz">Your time zone</label>
        <TimeZoneSelect id="tz" value={tz} onChange={onTzChange} />
      </div>
      <ErrorBanner error={error} />
      {data && days.length === 0 && <p>No free times in the next 30 days.</p>}
      {days.length > 0 && (
        <>
          <p className="muted">Times are shown in {tz.replaceAll('_', ' ')} ({zoneAbbr(days[0]!.items[0]!.start_at, tz)}).</p>
          <ul className="days" aria-label="Days">
            {days.map((d) => (
              <li key={d.date}>
                <button type="button" aria-pressed={current?.date === d.date}
                  className={current?.date === d.date ? 'day selected' : 'day'} onClick={() => setDay(d.date)}>
                  {formatDate(d.date)}
                </button>
              </li>
            ))}
          </ul>
          {current && (
            <ul className="times" aria-label={`Times on ${formatDate(current.date)}`}>
              {current.items.map((s) => s.waitlist ? (
                <li key={s.start_at}>
                  <button type="button" className="time full" disabled={busy || !s.waitlist.open} onClick={() => onPick(s)}
                    aria-label={`${s.local.label}, full: ${s.waitlist.open ? 'join the waitlist' : 'waitlist full'}`}>
                    {slotButtonLabel(s, tz)} <small>· {s.waitlist.open ? 'Full, join waitlist' : 'Waitlist full'}</small>
                  </button>
                </li>
              ) : (
                <li key={s.start_at}>
                  <button type="button" disabled={busy} aria-pressed={selectedStart === s.start_at}
                    className={selectedStart === s.start_at ? 'time selected' : 'time'} onClick={() => onPick(s)}
                    aria-label={`${s.local.label}${group ? `, ${s.seats_left} seats left` : ''}`}>
                    {slotButtonLabel(s, tz)}{group && <small> · {s.seats_left} left</small>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
