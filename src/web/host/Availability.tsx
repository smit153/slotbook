import { useEffect, useState, type FormEvent } from 'react';
import { api, type Availability as AvailabilityData } from '../lib/api.js';
import { checkAvailability, type RowError } from '../lib/availability-check.js';
import { ErrorBanner, Notice } from '../components/ErrorBanner.js';
import { useHost } from './DashboardLayout.js';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * ONE form for weekly hours and date overrides, saved with ONE PUT (replace-all, atomic on the
 * server). Rows are checked client-side and highlighted; the server's verdict is shown too.
 */
export function Availability() {
  const { host } = useHost();
  const [form, setForm] = useState<AvailabilityData | null>(null);
  const [rowErrors, setRowErrors] = useState<RowError[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { api<AvailabilityData>('/api/host/availability').then(setForm).catch(setError); }, []);
  if (!form) return <section><ErrorBanner error={error} /><p>Loading…</p></section>;

  const errFor = (path: string) => rowErrors.find((e) => e.path === path)?.message;
  const update = (next: AvailabilityData) => { setForm(next); setSaved(false); };

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    setError(null);
    const errs = checkAvailability(form!);
    setRowErrors(errs);
    if (errs.length > 0) return;
    try {
      setForm(await api<AvailabilityData>('/api/host/availability', { method: 'PUT', body: form }));
      setSaved(true);
    } catch (err) {
      setError(err); // the server kept the previous availability; the form keeps the edits
    }
  }

  return (
    <form className="availability" onSubmit={save} noValidate>
      <h1>Availability</h1>
      <p className="muted">All times are in your time zone: {host.timezone}. Changes never move existing bookings.</p>

      <h2>Weekly hours</h2>
      {DAYS.map((name, i) => {
        const weekday = i + 1;
        const rows = form.weekly.map((w, idx) => ({ w, idx })).filter((r) => r.w.weekday === weekday);
        return (
          <fieldset key={weekday}>
            <legend>{name}</legend>
            {rows.length === 0 && <span className="muted">Unavailable</span>}
            {rows.map(({ w, idx }) => (
              <div key={idx} className={errFor(`weekly.${idx}`) ? 'window invalid' : 'window'}>
                <label>From <input aria-label={`${name} start`} value={w.start} onChange={(e) => update({ ...form, weekly: form.weekly.map((x, j) => (j === idx ? { ...x, start: e.target.value } : x)) })} /></label>
                <label>to <input aria-label={`${name} end`} value={w.end} onChange={(e) => update({ ...form, weekly: form.weekly.map((x, j) => (j === idx ? { ...x, end: e.target.value } : x)) })} /></label>
                <button type="button" className="link" onClick={() => update({ ...form, weekly: form.weekly.filter((_, j) => j !== idx) })}>Remove</button>
                {errFor(`weekly.${idx}`) && <span className="field-error" role="alert">{errFor(`weekly.${idx}`)}</span>}
              </div>
            ))}
            <button type="button" className="link" onClick={() => update({ ...form, weekly: [...form.weekly, { weekday, start: '09:00', end: '17:00' }] })}>+ Add hours</button>
          </fieldset>
        );
      })}

      <h2>Date overrides</h2>
      {form.overrides.map((o, i) => (
        <fieldset key={i} className={errFor(`overrides.${i}`) ? 'invalid' : ''}>
          <legend>Override {i + 1}</legend>
          <label>Date <input type="date" aria-label={`Override ${i + 1} date`} value={o.date} onChange={(e) => update({ ...form, overrides: form.overrides.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)) })} /></label>
          <label>
            <select aria-label={`Override ${i + 1} kind`} value={o.kind} onChange={(e) => update({ ...form, overrides: form.overrides.map((x, j) => (j === i ? { ...x, kind: e.target.value as 'off' | 'custom', windows: e.target.value === 'off' ? [] : x.windows } : x)) })}>
              <option value="off">Day off</option>
              <option value="custom">Custom hours</option>
            </select>
          </label>
          {o.windows.map((w, k) => (
            <div key={k} className={errFor(`overrides.${i}.windows.${k}`) ? 'window invalid' : 'window'}>
              <label>From <input aria-label={`Override ${i + 1} window ${k + 1} start`} value={w.start} onChange={(e) => update({ ...form, overrides: form.overrides.map((x, j) => (j === i ? { ...x, windows: x.windows.map((y, m) => (m === k ? { ...y, start: e.target.value } : y)) } : x)) })} /></label>
              <label>to <input aria-label={`Override ${i + 1} window ${k + 1} end`} value={w.end} onChange={(e) => update({ ...form, overrides: form.overrides.map((x, j) => (j === i ? { ...x, windows: x.windows.map((y, m) => (m === k ? { ...y, end: e.target.value } : y)) } : x)) })} /></label>
              {errFor(`overrides.${i}.windows.${k}`) && <span className="field-error" role="alert">{errFor(`overrides.${i}.windows.${k}`)}</span>}
            </div>
          ))}
          {o.kind === 'custom' && <button type="button" className="link" onClick={() => update({ ...form, overrides: form.overrides.map((x, j) => (j === i ? { ...x, windows: [...x.windows, { start: '09:00', end: '12:00' }] } : x)) })}>+ Add hours</button>}
          <button type="button" className="link" onClick={() => update({ ...form, overrides: form.overrides.filter((_, j) => j !== i) })}>Remove override</button>
          {errFor(`overrides.${i}`) && <span className="field-error" role="alert">{errFor(`overrides.${i}`)}</span>}
        </fieldset>
      ))}
      <button type="button" className="link" onClick={() => update({ ...form, overrides: [...form.overrides, { date: '', kind: 'off', windows: [] }] })}>+ Add a date override</button>

      {rowErrors.length > 0 && <p className="banner error" role="alert">Please fix the highlighted rows ({rowErrors.length}).</p>}
      <ErrorBanner error={error} />
      {saved && <Notice>Availability saved.</Notice>}
      <div className="actions"><button type="submit">Save availability</button></div>
    </form>
  );
}
