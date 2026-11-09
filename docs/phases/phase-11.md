# Phase 11: k6 load test

**Status:** done. CI is green on every commit of this phase (latest `c9ead3f`: test 1m32s, e2e 1m20s).

## Planned vs. actual

| Planned (+ your requirements) | Actual |
|---|---|
| k6 via the `grafana/k6` Docker image against the compose production build | ✅ `pnpm loadtest` (`scripts/loadtest.sh`), `grafana/k6:2.3.0` (latest major, released 21 Sep 2026). It runs as a separate compose project `slotbook-load` (app :3200, db :5434). **Postgres on tmpfs**, so nothing is left on disk and no volume ever needs deleting. k6 runs on the compose network against `http://app:3000`. |
| **(yours)** load-test config so the per-IP cap doesn't turn everything into 429; document which option | ✅ **`TRUST_PROXY=1` + a fake `X-Forwarded-For` per virtual user** (`loadtest/compose.load.yml`). Why not raise the cap: with one shared IP every hold would also queue on the *same* per-IP advisory lock (`pg_advisory_xact_lock(1, hashtext(ip))`), so the test would measure the abuse limit instead of booking. Documented in the override file and the README. Result: 429s stayed at 0–16 per run. |
| **(yours)** seed for two scenarios: one busy host vs. many hosts | ✅ `scripts/loadtest-seed.ts`: `load-busy` + 200 hosts. Each has a 15-min 1:1 event type open 24/7 with a 365-day horizon (~35,000 slots per host); zones rotate over NY / Berlin / Kolkata / UTC. Scenarios: **many** (constant arrival rate, random host and day), **busy** (N users racing for one host's next 10 free slots), **mixed** (both at once; the many-hosts requests are tagged `flow=background`). |
| **(yours)** throughput, p95, error rate with 409/503 separate from real errors | ✅ Counted separately: 2xx, 409, 503, 410, 429 and **real errors** (anything else, including every 5xx and status 0). Threshold `real_errors == 0`. Per-endpoint median/p95 for slots, hold and confirm, per flow. |
| **(yours)** machine specs | ✅ Intel Core 5 210H (12 threads), 11 GiB RAM, Docker 29.9.3 on WSL2 (kernel 6.18.54.1), Node 24.22.2 in the image, Postgres 16.15 (`max_connections` 100). App, DB and k6 all on this one machine. |
| Pool sizing (agreed in Phase 4) | ✅ The heaviest "many" run and "mixed" again with `DB_POOL_MAX=30` (default 10). |
| (added) correctness under load | ✅ After **every** run, `scripts/loadtest-verify.ts` (read-only) checks seat-count drift, over-capacity, overlapping live sessions, **two confirmed bookings of one host overlapping**, and booking/session time mismatches. **All zero after every run** (~17,000 bookings confirmed in the final full run). |

## Results (final full run, `loadtest/RESULTS.md`)

| Run (45 s) | Iterations/s achieved | Requests/s | p95 hold | p95 slots | 409 | 503 | Real errors |
|---|---|---|---|---|---|---|---|
| many-25 | 25.0 | 75.0 | 69 ms | 42 ms | 0 | 0 | 0 |
| many-50 | 49.1 | 147.4 | 707 ms | 380 ms | 0 | 0 | 0 |
| many-75 | 44.1 | 132.2 | 4.86 s | 2.61 s | 1 | 0 | 0 |
| many-100 | 48.4 | 145.2 | 4.56 s | 2.45 s | 1 | 0 | 0 |
| many-200 | 49.1 | 140.3 | 9.39 s | 5.01 s | 0 | 405 | 0 |
| many-400 | 117.9 | 215.6 | 10.11 s | 9.48 s | 1 | 5,534 | 0 |
| busy-20 | 42.0 | 97.1 | 489 ms | 160 ms | 1,037 | 0 | 0 |
| busy-50 | 48.9 | 93.4 | 1.27 s | 635 ms | 1,331 | 0 | 0 |
| mixed (busy 50 users + background 25/s) | 58.2 | 130.7 | busy 2.18 s · background 1.94 s | busy 930 ms · background 1.03 s | 757 | 0 | 0 |
| pool30-many-400 | 81.4 | 170.6 | 10.45 s | 17.80 s | 1 | 3,008 | **26** (status 0, see below) |
| pool30-mixed | 40.1 | 87.4 | busy 5.97 s · background 3.63 s | busy 1.90 s · background 2.92 s | 142 | 35 | 0 |

**Where the ceiling is (CPU samples via `docker stats` every ~6 s during the run):**

| Run | app container CPU (median / max) | Postgres container CPU (median / max) |
|---|---|---|
| many-25 | 59% / 83% | 41% / 74% |
| many-50 … many-400 | **101–103% / 103–114%** | 88–114% / 126–163% |
| busy-50 | 78% / 99% | 78% / 104% |
| mixed | **100% / 108%** | 103% / 184% |
| pool30-mixed | **105% / 113%** | 116% / 126% |

100% = one core. The app is a single Node process, so ~100% means the event loop is saturated; Postgres stays far below the machine's 12 threads.

**Why one hot host slows the others (background p95 hold 69 ms at 25/s alone → 1.94 s in "mixed"):**
- The background requests are for *other* hosts, so they take other host rows' locks and never wait on the busy host's lock (design §5.1: one row lock per host).
- busy-50 alone uses ~78% of one core and the background 25/s alone ~50–80%. Together they need more than the one core a Node process can use, and the app pins at ~100% for the whole "mixed" run. Every request then queues on the event loop, whichever host it is for.
- A bigger pool (30) made "mixed" slower, not faster (background p95 hold 3.63 s), which fits a CPU limit rather than a pool limit: more concurrent work for the same core.
- **Not separated [CHECK]:** busy-flow holds waiting on their host lock each keep a pooled connection while they wait, which can also delay background requests at pool 10. And which code uses the CPU (slot generation with Luxon, JSON, request logging) was **not profiled**.
- Next step, therefore: **more app instances** (the design is safe with several: locks and the sweeper live in Postgres), then profile the hot path. Neither was measured here.

## What I found / what went wrong

1. **A real bug: overload gave HTTP 500.** The first full run had **769 real errors** at 200/s and 8,947 at 400/s. I re-ran 200/s for 30 s with the app logs kept: **all 178 errors were pg-pool's `Error('timeout exceeded when trying to connect')`**. A request waited more than `connectionTimeoutMillis` (5 s) for a pooled connection, and that plain error (no Postgres code) fell through to the 500 handler. That breaks the design's "never a raw 500 under contention".
   - **Fix (test first):** `test/integration/api/overload.test.ts` gives the app a pool of 1 with a 150 ms timeout and holds the only connection. It **failed first** (`[500, undefined, 'INTERNAL']`). `isPoolTimeout()` + the error handler now return **503 `SERVER_BUSY` with `Retry-After: 1`**. A second test checks that another error with a similar message is still a 500.
   - After the fix, many-200 and many-400 had **0 real errors**; the overload shows up as 503s.
2. **My first k6 script ran the busy host out of slots.** Busy users only looked 2 days ahead (192 slots), which busy-20 booked in seconds. busy-50 then did nothing but GET empty lists (0 bookings, 146 iterations/s), and the busy half of "mixed" did the same. Caught in the smoke run; busy users now move on one day at a time.
3. **My per-flow latencies were all 0.** I had tagged scenarios with `group`, which is a reserved k6 system tag and gets overwritten. Renamed to `flow`. Caught in the smoke run.
4. **Unexplained:** pool30-many-400 in the final run had **26 requests with no HTTP response** (status 0 in k6, all GET slots). Re-running only the pool-30 scenarios (with k6's error code now logged) gave **0**. The completed requests in that run maxed at 31 s (k6's own timeout is 60 s). The run lasted 61 s for a 45 s duration, so requests cut off at k6's graceful stop is the likely explanation, but **it is not confirmed**. Documented as such in the README.
5. **Stale results:** the first smoke run's files would have mixed into the report. The runner now writes one timestamped folder per run, and the report reads the newest (or a named one); nothing is deleted.
6. **Seen, not changed:** under overload the background sweeper also fails to get a connection and logs one `hold sweep failed` at error level. It simply retries on its next 30 s tick. Arguably that should be a warning.

## Test results
```
pnpm test → 49 files, 407 tests passed (new: overload ×2)
pnpm loadtest (final full run) → 11 runs, 0 real errors with the default pool; 26 status-0 in one pool-30 run (not reproduced)
database check after every run → 0 drift, 0 over-capacity, 0 overlaps, 0 double bookings, 0 time mismatches
CI → green on ed0c932, 5a98cfe, c9ead3f
```

## Commits
```
d58f94d loadtest: compose override (tmpfs DB, TRUST_PROXY=1, pool size), seed of 1 busy + N hosts, read-only invariant check
a5c68c2 loadtest: k6 booking path (slots → hold → confirm) for many hosts, one busy host, and both mixed
ef82f68 loadtest: pnpm loadtest runs every scenario via grafana/k6 2.3.0 in Docker; pnpm loadtest:report builds the table
febff6a fix(http): pool-acquire timeout under overload is 503 SERVER_BUSY with Retry-After, not 500 (found by the k6 load test)
36ef920 docs: SERVER_BUSY in the API status codes
5a98cfe loadtest: keep the app logs per run; PHASES selects a subset of scenarios
c9ead3f loadtest: results (RESULTS.md), README section with measured numbers, findings and gaps; log k6 error codes
(+ this summary)
```

## Changes from the design
- New error code **503 `SERVER_BUSY`** (design §7, README). Also a UI message for it; the API client already retries any 503 once.
- Design §5.8 (pool sizing) is now measured: on this machine the single Node process saturates before the pool or Postgres does.

## Open questions
1. Log the sweeper's pool-timeout failure as `warn` rather than `error`?
2. Measure 2–4 app instances behind a proxy (e.g. compose `deploy.replicas` + a small nginx) as the next load-test step?
