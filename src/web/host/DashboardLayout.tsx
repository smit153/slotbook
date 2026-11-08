import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate, useOutletContext } from 'react-router';
import { api, ApiError, type HostMe } from '../lib/api.js';
import { ErrorBanner } from '../components/ErrorBanner.js';

export interface HostContext {
  host: HostMe;
  setHost: (h: HostMe) => void;
}
export const useHost = () => useOutletContext<HostContext>();

/** Guards /dashboard/*: no session → /login. Every page below shows times in host.timezone. */
export function DashboardLayout() {
  const navigate = useNavigate();
  const [host, setHost] = useState<HostMe | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api<{ host: HostMe }>('/api/me')
      .then((r) => setHost(r.host))
      .catch((e: unknown) => (e instanceof ApiError && e.status === 401 ? navigate('/login', { replace: true }) : setError(e)));
  }, [navigate]);

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    navigate('/login');
  }

  if (error) return <main><ErrorBanner error={error} /></main>;
  if (!host) return <main><p>Loading…</p></main>;
  return (
    <div className="dashboard">
      <header>
        <strong>Slotbook</strong>
        <nav aria-label="Dashboard">
          <NavLink to="/dashboard" end>Bookings</NavLink>
          <NavLink to="/dashboard/event-types">Event types</NavLink>
          <NavLink to="/dashboard/availability">Availability</NavLink>
          <NavLink to="/dashboard/settings">Settings</NavLink>
          <NavLink to="/dashboard/notifications">Notifications</NavLink>
        </nav>
        <span className="muted">{host.name} · {host.timezone}</span>
        <button type="button" className="link" onClick={logout}>Log out</button>
      </header>
      <main>
        <Outlet context={{ host, setHost } satisfies HostContext} />
      </main>
    </div>
  );
}
