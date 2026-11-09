# Phase 14: Live slot updates (SSE)

**Status:** done. CI green on `bf4f25c` (test job 2m01s, e2e job 1m19s). Design §14 describes it as built.

## Planned vs. actual

| Your requirement | Actual |
|---|---|
| Postgres LISTEN/NOTIFY fired **inside the booking transactions**; rolled-back changes never notify | ✅ Triggers (migration `0005_slot_notify`) call `pg_notify('slots_changed', host_id)` on every change that can alter a host's slots: bookings (insert, status/occupancy updates), waitlist entries, availability, overrides, event types. Postgres delivers a notification only on COMMIT and once per transaction, and a trigger can't be forgotten by a write path. **Tested:** a rolled-back change sends nothing; the next committed change does. |
| One shared listener connection | ✅ `SlotEventHub` (`src/server/realtime/slot-events.ts`): one `pg.Client` doing `LISTEN`, opened lazily on the first subscriber, fanned out per host with 200 ms coalescing, reconnects with backoff. **After a reconnect it resyncs every stream**, since notifications sent while it was down are lost. **Tested** by killing its backend with `pg_terminate_backend`. |
| A stream endpoint per event type sending only "slots changed" | ✅ `GET /api/hosts/{host}/events/{slug}/stream`: `retry: 3000`, `event: ready`, `event: slots`, `event: ping`; data always `{}`. **Tested:** every `data:` line is exactly `data: {}`, and another host's change doesn't wake the stream. |
| Heartbeats; reconnect on drop; fallback to polling | ✅ Server heartbeat every 25 s. Page (`src/web/lib/slot-events.ts`): 60 s of silence → reconnect; 3 errors in a row, or a refused stream (`readyState` 2, e.g. 429) → poll every 30 s; no `EventSource` → poll. Unit-tested with fake timers and a fake EventSource. |
| **(yours)** SSE-triggered refetches count toward the 60/min slots limit; debounce keeps a page well inside it | ✅ Throttle **≤ 1 refetch per 5 s** (a burst gets one immediate and one trailing refetch). **Tested:** a host changing every 100 ms for a full minute → **≤ 13 refetches/min** (11–13). Plus the page's own loads; polling adds 2/min. In the Playwright test, browser B made at most 2 slots requests after A's hold. |
| **(yours)** the stream has its own per-IP connection limit | ✅ **3 concurrent streams per IP** → 429 `STREAM_LIMIT` + `Retry-After: 30`; closing one frees a place (tested). Opening streams also has its own rate limit (30/min, `slotStream`). |
| The hold transaction stays the only authority | ✅ The stream is a hint: the page refetches; clicking a stale time still gets 409 (the existing race test, now with a deliberately stale page). |
| Tests: a hold in one client triggers a refetch in another; a rolled-back hold sends nothing | ✅ Server: two clients over a real listening server (`app.inject` can't stream), 7 tests. Browser: Playwright `e2e/live.spec.ts`: A holds, and B's time turns into "full, join the waitlist" **without a reload**, well inside 10 s (long before B's 30 s polling fallback could). |

## What I found / what went wrong
1. **A flake I introduced and caught before it showed up:** live updates broke an assumption of the existing e2e race test. Browser B can now receive A's hold and re-render before B clicks, so B's click on the exact "free" label would time out. It passed in my run only because B clicked first. That test is about the server refusing a stale click, so B's stream is now blocked on purpose (`route.abort`), and live updates have their own test.
2. **Hijacked responses skip Fastify's `onSend` hooks,** so the security headers (`X-Request-Id`, `nosniff`, `Referrer-Policy`) are set by hand on the stream. Open streams would also keep `app.close()` waiting, so a `preClose` hook ends them.
3. **`LISTEN` needs a session connection.** It doesn't work through a transaction-mode pooler. That's added to the `DATABASE_URL` note and the known gaps (the deployment advice already said "direct connection").
4. **Freshness limit, documented:** a hold that expires *by time* writes nothing, so it's only announced when something sweeps it (sweeper ≤ 30 s, or the next write on the host).
5. Mutation-checked: broadcasting every notification to every host fails the "another host" test; disabling the reconnect fails the reconnect test.

## Results
```
pnpm test → 56 files, 468 tests passed (new: slot-stream 7, web slot-events 6)
pnpm e2e  → 9/9 (new: live); then 3 more runs → 9/9 each
slot-stream tests × 5 → 7/7 each (no timing flakes)
CI → green on bf4f25c

Closing k6 check (limiter on ×1000, 20 s per run, warmed up at 25/s):
  many-25  25.0/s  p95 hold 36 ms   · many-50 49.8/s p95 hold 47 ms (0 dropped)
  busy-20  19.0 bookings/s, 536 × 409 · busy-50 9.7 bookings/s, 699 × 409, p95 hold 886 ms
  mixed    background p95 hold 1.06 s
  0 real errors, 0 × 429, 0 × 503; database check after every run: 0 double bookings, 0 drift
  vs. Phase 11 (45 s runs on a bigger database, so not identical conditions): same or better on
  every row, so the waitlist handoff probe and the notify triggers cost nothing visible.
```

## Commits
```
0593de6 feat(live): notify slots_changed from triggers inside the writing transaction (rolled-back changes never notify)
4cad532 feat(live): one shared LISTEN connection and an SSE stream per event type (only 'slots changed'; heartbeats; per-IP stream cap; reconnect + resync)
a3a8f45 feat(web): live slot refetch (≤ 1 per 5 s), reconnect on silence, fall back to polling
ea95e70 test(e2e): a hold in one browser updates the other without a reload; the race test keeps a deliberately stale page
bf4f25c docs: live slot updates (design §14, README API and gaps)
(+ this summary and AI_LOG)
```
