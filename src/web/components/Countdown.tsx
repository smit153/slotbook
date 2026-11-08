import { useEffect, useState } from 'react';
import { formatMmSs, remainingMs } from '../lib/countdown.js';

/** Counts down to a performance.now()-based deadline (never the wall clock). */
export function Countdown({ deadline, onExpire }: { deadline: number; onExpire: () => void }) {
  const [left, setLeft] = useState(() => remainingMs(deadline, performance.now()));
  useEffect(() => {
    const tick = () => {
      const ms = remainingMs(deadline, performance.now());
      setLeft(ms);
      if (ms === 0) onExpire();
    };
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [deadline, onExpire]);
  return <span className="countdown" aria-live="polite">Held for {formatMmSs(left)}</span>;
}
