import { useEffect, useState } from 'react';

type Health = { status: string; db: string } | { error: string };

/** Phase 1 placeholder: proves the SPA is served and can reach the API. */
export function App() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetch('/health')
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch((e: unknown) => setHealth({ error: String(e) }));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>Slotbook</h1>
      <p>Scaffold is running. Booking pages arrive in later phases.</p>
      <p>
        API health: <code>{health ? JSON.stringify(health) : 'checking…'}</code>
      </p>
    </main>
  );
}
