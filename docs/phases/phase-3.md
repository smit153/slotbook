# Phase 3: Slot engine (+ step 0: deactivate, never delete)

**Status:** done. All checks green. Waiting for review before Phase 4.

## Planned vs. actual

| Planned | Actual |
|---|---|
| **Step 0:** migration 0003 (`hosts.active`, DELETE blocked on hosts and event types) + catalog test | ✅ Done. The catalog test walks FK chains of **any length** with a recursive CTE, looking for paths that could cascade into bookings. **Added:** a meta-test that adds a cascade inside a rolled-back transaction and checks it is detected. Migration 0003 was also applied as an **upgrade** to the existing Compose DB (no volume wipe). |
| `local-time.ts`: time parsing, explicit offset choice, padded host days | ✅ Done. 23 unit tests. |
| `generateSlots` + `isSlotOffered` | ✅ Done, but the re-validation function is named **`findOfferedSlot`**. It returns the slot (including `seatsLeft` and the session's snapshot end) instead of a boolean, because Phase 4's hold path needs those values. |
| R12: NY host / Berlin guest Oct 23–Nov 2, cross-day, both 01:00 slots, spring gap | ✅ Done, plus a **Berlin-host** fall-back night and a 60-minute meeting that straddles the switch. |
| R7 at the loader level | ✅ Done. With the sweeper never run, an expired hold still marked `held` (`seats_taken` = 1) doesn't block its slot. |
| R8 groundwork | ✅ `findOfferedSlot` rejects: off-grid, outside the window, meeting running past the window end, in the past, inside min notice, past the horizon, weekend, day off, taken, and an invalid date. |
| R14 groundwork + Luxon lint bans | ✅ Engine output is identical with the JS clock skewed ±1 year or set onto the DST switch. The loader's `now` is the database clock even when the process clock is a year off. **Mutation check:** making the engine read `Date.now()` fails 4 tests *and* the lint rule. |
| No-SQL-tz guard | ✅ It scans `src/` for 10 constructs. These include calendar intervals (`interval '1 day'`), because day/month arithmetic on `timestamptz` depends on the session TimeZone. Meta-tests prove the patterns match. |
| Loader `slot-inputs.ts` | ✅ Done. **Changed:** it takes a `Transaction` only (see bug #3). |

## What worked
- The **NY/Berlin table** comes out exactly as in design §6.1. 09:00 NY = 15:00 Berlin on Oct 23, 14:00 on Oct 26 and Oct 30, and 15:00 on Nov 2. The host grid stays 09:00–16:30 NY on every weekday that week.
- **Cross-day:** the Berlin Tuesday (Oct 27) starts with 00:00, 00:30, 01:00 and 01:30, which are the host's Monday 19:00–20:30 NY. Then come the host's Tuesday hours, 14:00–22:00 Berlin. Asking for Monday and Tuesday separately gives exactly the same slots as asking for both at once: nothing duplicated, nothing lost.
- **Fall-back night (NY Nov 1):** a 00:00–03:00 window gives 8 slots: `00:00 EDT, 00:30 EDT, 01:00 EDT, 01:30 EDT, 01:00 EST, 01:30 EST, 02:00 EST, 02:30 EST`. The UTC instants are 04:00Z … 07:30Z, all distinct.
- **Spring-forward (NY Mar 8):** a 01:00–04:00 window gives `01:00 EST, 01:30 EST, 03:00 EDT, 03:30 EDT`. No phantom 02:xx slots.
- **Engine and loader separation:** the engine is pure, so it was tested with 85 fast unit tests. The loader is the only part that needs Postgres.

## What didn't, and the bugs found
1. **Design v0.3 was wrong about Luxon** (found before coding, while planning). It said an ambiguous fall-back time resolves to the *earlier* offset. Luxon 3.7 picks the **later** one. If the engine had relied on the default, a window starting at 01:00 on fall-back night would have silently lost an hour. **Fix:** `localToInstant(..., 'earlier' | 'later')` uses `getPossibleOffsets()`. A window's start takes the earlier offset and its end the later one. A test proves the 01:00-start window begins at 01:00 **EDT**.
2. **My plan claimed something untrue about the ±1-day padding.** I said "removing the padding makes [the cross-day] test fail". Working it through: windows never cross local midnight, so a slot starting in `[from, to)` always falls on a host day between `localDate(from)` and `localDate(to)`. Iterating exactly those days is enough. The padding is defence in depth, and no test can show it is required. I didn't write a test that pretends otherwise. Design §6 now says what actually prevents cut-off guest days: iterating host days and filtering by instant.
3. **A consistency risk in my first loader.** It accepted `Kysely | Transaction` and ran its four queries with `Promise.all`. On a pool, those would run on different connections with different snapshots and different `now()` values. **Fix:** the parameter type is `Transaction<DB>`, so the compiler enforces one snapshot.
4. **A fixture type error.** My `occupancy()` test helper intersected `Partial<LiveOccupancy>` with string dates, which gave the type `Date & string`. The tests ran fine, but `tsc` caught it. Rewrote the fixture.
5. **Found while writing the loader: SQL `interval '1 day'` is time-zone math.** The obvious way to pad the occupancy query, `from - interval '1 day'` on a `timestamptz`, depends on the session TimeZone across DST. **Fix:** the padding is computed in TypeScript as milliseconds. The SQL-tz scanner now flags calendar intervals; `interval '5 minutes'` is still allowed.

## Test results
```
pnpm test  → Test Files 19 passed (19) · Tests 196 passed (196)
  unit        114  engine: local-time 23 · basic 27 · dst 15 · occupancy 11 · clock 4
                   config 12 · password 11 · lint clock rule 5 · no-sql-tz 3 · trust-proxy 3
  integration  82  schema-integrity 18 · seats-trigger 15 · availability 14 · occupancy 9
                   slot-inputs 9 · deactivation 7 · smoke 5 · seed 4 · db-types 1
pnpm typecheck → clean · pnpm lint → clean · pnpm db:types --verify → up to date
```
| R | Coverage after Phase 3 |
|---|---|
| R7 | **Done (read path).** An expired-but-unswept hold doesn't block. Unexpired holds and confirmed bookings do. Group live seats are counted correctly. |
| R8 | **Groundwork.** `findOfferedSlot` rejects 10 kinds of tampered start. The API-level 422 comes in Phase 4. |
| R12 | **Done.** NY/Berlin week, cross-day, fall-back (both 01:00s, ambiguous window start and end, a 60-minute meeting straddling the switch), spring-forward gap, Berlin host's own fall-back night. |
| R14 | **Groundwork.** The engine and loader ignore the process clock; mutation-checked. The full skew-the-server test over hold/confirm/expiry comes in Phase 5. |
| R11 | Still enforced: `assertSeatInvariant` runs after every slot-inputs test too. |

## Commits
```
62c7e69 feat(db): deactivate hosts/event types, block their DELETE
1b64294 feat(engine): local-time helpers with explicit DST offset choice
6ef76a8 feat(engine): generateSlots and findOfferedSlot
92262c6 test(engine): DST and cross-day cases (R12)
99aa745 test(engine): sessions, buffers, group capacity, clock skew (R14 groundwork)
859f4de chore(lint): ban Luxon clock reads in engine/services; guard against SQL tz math
3e150d2 feat(db): slot input loader (DB now, live seats) with R7 tests
55104c1 docs: clarify that the +/-1 host-day padding is defence in depth; engine/loader names
(+ a22e20c design update and 1dd9450 AI_LOG before the go; + this summary)
```

## Changes from the design
- `isSlotOffered` → `findOfferedSlot`, which returns the slot.
- The loader takes a `Transaction` only.
- Window boundary resolution is explicit: start → earlier offset, end → later. This replaces v0.3's wrong claim about Luxon's default. It was already written into design §6 before coding.
- The padding is documented as defence in depth (design §6.1).
- Horizon = `now + horizon_days × 24 h`, inclusive. Min notice is inclusive (`start ≥ now + notice`).

## Post-review change (after your answers)
- **Ambiguous window ends now take the first occurrence too**, so both boundaries do. Test-first: the two new or changed fall-back tests failed against the old `'later'` end, then passed after a one-line engine change. Results now: a window ending at 01:30 gives `00:00, 00:30, 01:00 EDT`; a window `01:00–01:30` gives `01:00 EDT` only; `00:00–03:00` still gives both 01:00s. Documented in design §6 and assumption 3.
- Horizon = 30 × 24 h and `GMT±n` labels accepted, and documented as assumptions 3a and 3b.

## Open questions (answered)
1. **Fall-back window end:** a window ending at an ambiguous time (e.g. "until 01:30" on Nov 1) runs to the **second** 01:30 (EST). That is the maximal reading. Is that the behaviour you want, or should the end take the earlier offset?
2. **Labels for zones without letter abbreviations:** Luxon renders Berlin as `GMT+2` / `GMT+1` in `en-US`, not `CEST` / `CET`. NY gets `EDT` / `EST` as required for Phase 8. For duplicate fall-back slots in other zones, the UI would show `GMT±n`. Is that acceptable?
3. **Horizon in real time vs. calendar days:** "30 days" currently means 30 × 24 h from `now`. Across a DST change that's an hour off from "the same clock time 30 days later". Is that fine as a documented assumption?
