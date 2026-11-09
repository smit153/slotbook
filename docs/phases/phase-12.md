# Phase 12: Abuse protection + observability

**Status:** done. CI green on `b9b215c` (test job 2m12s, e2e job 1m32s).

## Planned vs. actual

| Planned (+ your answers) | Actual |
|---|---|
| Per-IP rate limits on every public endpoint, 429 + Retry-After | ✅ `@fastify/rate-limit`, one limit per route (`src/server/http/rate-limits.ts`), requests per minute: event info 60, slots 60, holds 20, release 30, confirm 20, manage view 30, reschedule 20, cancel 20, login 10 (now through the same helper). Keyed on `request.ip`, so the `TRUST_PROXY` hop rule applies. 429 `RATE_LIMITED` + `Retry-After`; the limiter runs before the handler. A `slotStream` limit is reserved for Phase 14. |
| **(yours)** limiter ON for k6 with `RATE_LIMIT_MULTIPLIER=1000` | ✅ New env var (default 1) multiplies every limit; set in `loadtest/compose.load.yml` with a comment saying why. |
| e2e and k6 must still pass | ✅ e2e at the **production defaults**: 7/7. The app log shows the whole run made 23 slots requests and 7 holds from one IP, with **0 × 429**. k6 (limiter on, ×1000): **0 × 429, 0 real errors, 0 double bookings**. |
| `/metrics`: bookings by status, hold expiries, notification lag | ✅ Prometheus text (written by hand, no dependency), computed **from the database at scrape time** in one read-only transaction: `slotbook_bookings{status}`, `slotbook_holds_active`, `slotbook_hold_expiries_total{via}`, `slotbook_holds_released_total`, `slotbook_notifications_pending`, `slotbook_notification_lag_seconds` (**(yours)** pending count + oldest age), plus `slotbook_rate_limited_total{route}` (per process). |
| **(yours)** access rule | ✅ `METRICS_TOKEN` set → bearer required (timing-safe compare; 401 otherwise); unset → open in development/test, **404 in production**. `no-store`; not rate limited. |
| README: both built | ✅ Abuse protection and Observability now **Built**, with their remaining limits. Config table (+2 vars; the drift test enforces it), API table (+`/metrics`, + the limits), known gaps updated; design §7 updated. |

## Tests
- `test/integration/api/rate-limits.test.ts` (13):
  - for **each of the 9 limited routes**: the limit passes, one more → 429 `RATE_LIMITED` with `Retry-After`, and another IP is unaffected
  - separate buckets per route
  - **a refused hold leaves no booking and no idempotency key**
  - behind a proxy the limit follows `X-Forwarded-For`
  - the multiplier scales the limits
  - Mutation-checked: removing the confirm route's limit fails its test.
- `test/integration/api/metrics.test.ts` (7):
  - all series present and zero on an empty DB
  - bookings by status (1 held / 1 confirmed / 1 cancelled / 1 expired, and 1 active hold)
  - expiries by cause (sweeper, confirm-after-expiry, a hold sweeping its host) and releases counted separately
  - notification lag (backdated 90 s → ≥ 90; 0 after delivery)
  - the 429 counter
  - token required → 401/401/200
  - production without a token → 404
  - The output is parsed strictly: every sample line must follow a `# TYPE` for its metric.

## What I found / what went wrong
1. **My first notification-lag query broke a project rule.** It used `EXTRACT(EPOCH FROM clock_timestamp() - min(created_at))`, and the unit scan that bans time-zone-sensitive SQL (`test/unit/no-sql-tz.test.ts`) flagged `EXTRACT`. On an interval it is actually zone-independent, but the rule is deliberately blunt. So the query now returns both instants from the database and subtracts them in TypeScript. No exception to the rule was added.
2. **I committed the rate limits before the README's configuration table had the two new env vars**, so the drift test was red from `de7f98b` until `02cf60e` (fixed before any push; CI only ever saw the fixed head). The test did its job; I committed too early.
3. **My load-test report overwrote the committed `loadtest/RESULTS.md`** when I generated a table for a named results folder. I restored the committed version with `git checkout -- loadtest/RESULTS.md` (it only discarded what I had just generated) and changed the script: a named folder now only prints.
4. **A false alarm about a regression:** in the first short k6 run, many-50 reached only 33.4 iterations/s (207 dropped), against 49.1 in Phase 11. It was the first run on a cold app; in Phase 11 it ran after a 25/s warm-up. Re-run warm (25/s, then 50/s): **50.0/s, 0 dropped**. So no regression; the final k6 check will always warm up first.

## Results
```
pnpm test → 51 files, 427 tests passed (new: rate-limits 13, metrics 7)
pnpm e2e  → 7/7 at production limits (0 × 429)
k6 (limiter ×1000, 20 s runs) → many-25 25.0/s, many-50 50.0/s (warm), busy-20/50 OK; 0 × 429, 0 real errors, 0 double bookings
CI → green on b9b215c
```

## Commits
```
de7f98b feat(abuse): per-IP rate limits on every public endpoint (429 RATE_LIMITED + Retry-After), RATE_LIMIT_MULTIPLIER
c7b2a78 loadtest: keep the rate limiter on with RATE_LIMIT_MULTIPLIER=1000
cfe747a feat(observability): GET /metrics (Prometheus text): bookings by status, hold expiries, notification lag, 429s; METRICS_TOKEN
02cf60e docs: rate limits and /metrics in README (abuse protection and observability built) and design §7
b9b215c loadtest: report for a named folder prints only (never overwrites RESULTS.md)
(+ this summary and AI_LOG)
```

## Changes from the design
- Design §7 has the limits table and `/metrics`. New env vars: `RATE_LIMIT_MULTIPLIER`, `METRICS_TOKEN`.
