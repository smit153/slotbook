import { describe, expect, it } from 'vitest';
import { generateSlots } from '../../../src/server/engine/slots.js';
import { NY, dayIn, eventType, local, occupancy, query } from './fixtures.js';

const MON = '2026-11-02'; // EST: 09:00 NY = 14:00Z
const slotsWith = (o: Parameters<typeof query>[0]) => local(generateSlots(query(o)), NY);

describe('occupancies hide or share slots', () => {
  it("another event type's session blocks its own time", () => {
    const occ = occupancy({ startAt: '2026-11-02T14:00:00Z', endAt: '2026-11-02T14:30:00Z' });
    expect(slotsWith({ ...dayIn(MON, NY), occupancies: [occ] }).slice(0, 2)).toEqual(['09:30', '10:00']);
  });

  it("…and its buffer: other session 09:00–09:30 with a 15-min buffer after hides 09:30", () => {
    const occ = occupancy({
      startAt: '2026-11-02T14:00:00Z', endAt: '2026-11-02T14:30:00Z',
      blockedFrom: '2026-11-02T14:00:00Z', blockedTo: '2026-11-02T14:45:00Z',
    });
    expect(slotsWith({ ...dayIn(MON, NY), occupancies: [occ] }).slice(0, 2)).toEqual(['10:00', '10:30']);
  });

  it("our own buffer counts too: a 15-min buffer before means 09:30 can't follow a 09:00–09:30 session", () => {
    const occ = occupancy({ startAt: '2026-11-02T14:00:00Z', endAt: '2026-11-02T14:30:00Z' });
    const slots = slotsWith({ ...dayIn(MON, NY), occupancies: [occ], eventType: eventType({ bufferBeforeMin: 15 }) });
    expect(slots.slice(0, 1)).toEqual(['10:00']);
  });

  it('touching ranges do not conflict (half-open): a session ending 09:30 leaves 09:30 free', () => {
    const occ = occupancy({ startAt: '2026-11-02T14:00:00Z', endAt: '2026-11-02T14:30:00Z' });
    expect(slotsWith({ ...dayIn(MON, NY), occupancies: [occ] })).toContain('09:30');
  });

  it('1:1 event: an overlapping session of the SAME event type at another start blocks', () => {
    const occ = occupancy({ eventTypeId: 'ev-main', startAt: '2026-11-02T14:15:00Z', endAt: '2026-11-02T14:45:00Z' });
    expect(slotsWith({ ...dayIn(MON, NY), occupancies: [occ] }).slice(0, 1)).toEqual(['10:00']);
  });

  it('a session with no live seats (only expired/cancelled bookings) blocks nothing', () => {
    const occ = occupancy({ startAt: '2026-11-02T14:00:00Z', endAt: '2026-11-02T14:30:00Z', liveSeats: 0 });
    expect(slotsWith({ ...dayIn(MON, NY), occupancies: [occ] })[0]).toBe('09:00');
  });
});

describe('group sessions (capacity > 1)', () => {
  const group = eventType({ capacity: 5, durationMin: 60 });

  it('a free group slot shows the full capacity', () => {
    const [first] = generateSlots(query({ ...dayIn(MON, NY), eventType: group }));
    expect(first!.seatsLeft).toBe(5);
  });

  it('joining a live session shows the seats left', () => {
    const occ = occupancy({ eventTypeId: 'ev-main', startAt: '2026-11-02T14:00:00Z', endAt: '2026-11-02T15:00:00Z', liveSeats: 3, capacity: 5 });
    const [first] = generateSlots(query({ ...dayIn(MON, NY), eventType: group, occupancies: [occ] }));
    expect(first).toMatchObject({ seatsLeft: 2 });
    expect(first!.startAt.toISOString()).toBe('2026-11-02T14:00:00.000Z');
  });

  it('a full session disappears', () => {
    const occ = occupancy({ eventTypeId: 'ev-main', startAt: '2026-11-02T14:00:00Z', endAt: '2026-11-02T15:00:00Z', liveSeats: 5, capacity: 5 });
    expect(local(generateSlots(query({ ...dayIn(MON, NY), eventType: group, occupancies: [occ] })), NY)[0]).toBe('10:00');
  });

  it("joiners get the live session's snapshot (capacity + end), not the edited event type", () => {
    // Session created when the event was 90 min, cap 3; host since changed it to 60 min, cap 5.
    const occ = occupancy({ eventTypeId: 'ev-main', startAt: '2026-11-02T14:00:00Z', endAt: '2026-11-02T15:30:00Z', liveSeats: 1, capacity: 3 });
    const [first] = generateSlots(query({ ...dayIn(MON, NY), eventType: group, occupancies: [occ] }));
    expect(first).toMatchObject({ seatsLeft: 2 });
    expect(first!.endAt.toISOString()).toBe('2026-11-02T15:30:00.000Z');
  });

  it("the session's neighbours are still blocked by it (it is a normal session for other starts)", () => {
    const occ = occupancy({ eventTypeId: 'ev-main', startAt: '2026-11-02T14:00:00Z', endAt: '2026-11-02T15:00:00Z', liveSeats: 1, capacity: 5 });
    const slots = generateSlots(query({ ...dayIn(MON, NY), eventType: eventType({ capacity: 5, durationMin: 30 }), occupancies: [occ] }));
    // 09:00 joins the session; 09:30 would overlap it as a different session → hidden.
    expect(local(slots, NY).slice(0, 2)).toEqual(['09:00', '10:00']);
  });
});
