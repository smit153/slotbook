import { Link } from 'react-router';

export function NotFound() {
  return (
    <main className="narrow">
      <h1>Page not found</h1>
      <p><Link to="/">Back to Slotbook</Link></p>
    </main>
  );
}

export function Home() {
  return (
    <main className="narrow">
      <h1>Slotbook</h1>
      <p>Hosts publish when they are free; guests book a slot; nobody is ever double-booked.</p>
      <ul>
        <li><Link to="/demo/intro-30">Book the demo 30-min intro</Link></li>
        <li><Link to="/demo/workshop">Join the demo group workshop</Link></li>
        <li><Link to="/login">Host login</Link></li>
      </ul>
    </main>
  );
}
