import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api.js';
import { ErrorBanner, Notice } from '../components/ErrorBanner.js';
import { TimeZoneSelect } from '../components/TimeZoneSelect.js';
import { useHost } from './DashboardLayout.js';

interface SettingsResponse { slug: string; name: string; email: string; timezone: string; timezones: string[] }

export function Settings() {
  const { host, setHost } = useHost();
  const [s, setS] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { api<SettingsResponse>('/api/host/settings').then(setS).catch(setError); }, []);
  if (!s) return <section><ErrorBanner error={error} /><p>Loading…</p></section>;

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      const r = await api<SettingsResponse>('/api/host/settings', { method: 'PUT', body: { name: s!.name, timezone: s!.timezone } });
      setHost({ ...host, name: r.name, timezone: r.timezone });
      setSaved(true);
    } catch (err) { setError(err); }
  }

  return (
    <form onSubmit={save} className="narrow">
      <h1>Settings</h1>
      <label htmlFor="name">Name</label>
      <input id="name" required value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} />
      <label htmlFor="home-tz">Home time zone</label>
      <TimeZoneSelect id="home-tz" value={s.timezone} choices={s.timezones} onChange={(timezone) => setS({ ...s, timezone })} />
      <p className="muted">Your availability is interpreted in this zone. Existing bookings keep their exact times.</p>
      <ErrorBanner error={error} />
      {saved && <Notice>Saved.</Notice>}
      <button type="submit">Save</button>
    </form>
  );
}
