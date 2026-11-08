import { useMemo } from 'react';
import { timeZoneChoices } from '../../shared/timezones.js';

/** Zone picker. The current value is always offered, even if it is an alias (Asia/Calcutta). */
export function TimeZoneSelect({ id, value, onChange, choices }: {
  id: string; value: string; onChange: (tz: string) => void; choices?: string[];
}) {
  const options = useMemo(() => {
    const list = choices ?? timeZoneChoices();
    return list.includes(value) ? list : [value, ...list];
  }, [choices, value]);
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((z) => <option key={z} value={z}>{z.replaceAll('_', ' ')}</option>)}
    </select>
  );
}
