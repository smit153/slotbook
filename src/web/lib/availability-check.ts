import type { Availability, WindowRow } from './api.js';

/**
 * Client-side checks for the availability form, so the offending row can be highlighted
 * before saving. The server (constraints + exclusion) stays the final authority.
 */
export interface RowError {
  /** "weekly.3", "overrides.1", "overrides.1.windows.0" */
  path: string;
  message: string;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const END = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

function windowErrors(w: WindowRow, path: string): RowError[] {
  if (!TIME.test(w.start)) return [{ path, message: 'Start must be HH:MM' }];
  if (!END.test(w.end)) return [{ path, message: 'End must be HH:MM (24:00 allowed)' }];
  if (w.end <= w.start) return [{ path, message: 'End must be after start' }];
  return [];
}

function overlapErrors(rows: Array<{ w: WindowRow; path: string }>): RowError[] {
  const sorted = [...rows].filter((r) => windowErrors(r.w, r.path).length === 0).sort((a, b) => a.w.start.localeCompare(b.w.start));
  const out: RowError[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.w.start < sorted[i - 1]!.w.end) out.push({ path: sorted[i]!.path, message: `Overlaps ${sorted[i - 1]!.w.start}–${sorted[i - 1]!.w.end}` });
  }
  return out;
}

export function checkAvailability(a: Availability): RowError[] {
  const errors: RowError[] = [];
  a.weekly.forEach((w, i) => errors.push(...windowErrors(w, `weekly.${i}`)));
  for (let day = 1; day <= 7; day++) {
    errors.push(...overlapErrors(a.weekly.map((w, i) => ({ w, path: `weekly.${i}`, day: w.weekday })).filter((r) => r.day === day)));
  }
  const seen = new Set<string>();
  a.overrides.forEach((o, i) => {
    const path = `overrides.${i}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date)) errors.push({ path, message: 'Pick a date' });
    else if (seen.has(o.date)) errors.push({ path, message: 'This date already has an override' });
    seen.add(o.date);
    if (o.kind === 'off' && o.windows.length > 0) errors.push({ path, message: 'A day off cannot also have hours' });
    if (o.kind === 'custom' && o.windows.length === 0) errors.push({ path, message: 'Add at least one window, or mark the day off' });
    o.windows.forEach((w, j) => errors.push(...windowErrors(w, `${path}.windows.${j}`)));
    errors.push(...overlapErrors(o.windows.map((w, j) => ({ w, path: `${path}.windows.${j}` }))));
  });
  return errors;
}
