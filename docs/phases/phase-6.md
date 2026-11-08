# Phase 6: API routes + auth

**Status:** done. All checks green (3 consecutive full runs + a real compose boot). Waiting for review before Phase 7.

Also covers the post-Phase-5 decisions: the time-zone rule is Intl + Luxon (`79159cc`), and every expiry gets an audit row (`6d6c2a0`).

## Planned vs. actual

| Planned (+ your Phase 6 changes) | Actual |
|---|---|
| Request ids, security headers, redacted logs, JSON errors | ✅ `src/server/http/`. Only method, redacted URL and IP are logged per request; headers and bodies never are. |
| Public, hold, booking routes | ✅ Thin routes over the services. `manage_url` uses the `#` fragment. |
| **(your change) 40P01/40001 → one retry, then 503 + Retry-After, never 500** | ✅ The retry lives in `writeTx` (Phase 5). The HTTP layer adds `Retry-After: 1` to every 503. **Plus a safety net:** a 40P01/40001/55P03 that reaches the error handler from any other code path is still a 503 + Retry-After. Tested both ways. |
| Auth: login/logout/me, DB sessions, host guard | ✅ Same 401 for unknown email, inactive host and wrong password; scrypt always runs. Only sha256 of the session token is stored, and expiry uses the DB clock. 7-day sessions, no sliding renewal (agreed). |
| **(your change) Configurable Origin check** | ✅ `APP_ORIGIN` (required in production), **the Vite origins `localhost:5173` / `127.0.0.1:5173` only when `NODE_ENV=development`**, and `EXTRA_ALLOWED_ORIGINS`. **Tested in both configs:** :5173 is refused under test/production config and allowed under development. |
| **(your change) `@fastify/rate-limit` on login only** | ✅ 10/min per IP. The 11th attempt gets 429 `RATE_LIMITED` + `Retry-After`. Other IPs and other routes are unaffected. Registered with `global: false` so it can be reused for abuse protection. |
| Host CRUD under the host lock | ✅ Settings, event types (no DELETE), availability (atomic replace-all). **Tested:** 4 kinds of host edit block behind a held host lock and get 503. |
| Slots with server-computed labels (agreed) | ✅ `local: {date, time, label, ambiguous}`. |

## What worked
- **R21 is mutation-checked.** After a full HTTP journey plus login/logout, the logs contain no hold secret, manage token, session cookie, Idempotency-Key or password. When URL redaction is disabled, the test fails with `manage_token leaked into logs`.
- **The concurrency guarantees hold through HTTP:** 20 parallel `POST /api/holds` give 1 × 201 and 19 × 409.
- **Replays are visible:** `Idempotent-Replayed: true` on the second request, with an identical body.
- **TRUST_PROXY behaves as designed:** with `TRUST_PROXY=1`, three real clients behind one proxy each get their own IP. With `false`, a spoofed `X-Forwarded-For` is ignored and the cap still hits.
- **Availability replacement is atomic.** Every one of 7 bad payloads leaves the previous availability unchanged: overlap, end before start, day off with hours, custom with no hours, duplicate date, overlapping override windows, bad weekday.
- **The production image works end to end** (`docker compose up --build`): the demo host logs in through the Origin check, slots are listed in `Asia/Kolkata` (labels like `Tue 10 Nov, 19:30 GMT+5:30`), and a real hold gets 201 with `no-store`, `Referrer-Policy` and a request id.

## What didn't, and the bugs found
1. **A flaky R1 under load.** A real latent bug in my tests since `lock_timeout` (`cc3a0e1`). In one full run, R1 (50 parallel holds) got **10 × 503 `HOST_BUSY`**: on a loaded machine the tail of the queue waited longer than 2.5 s. That is the timeout working as designed. My tests were checking contention correctness and the fail-fast timeout at the same time. The "3 green runs" in Phases 4 and 5 were true, but on a lighter suite. **Fix (`2692104`):**
   - contention tests (R1–R3, the storms, IP-cap and concurrent idempotency) use a 30 s lock timeout, so they test correctness only
   - a **new burst test** keeps the default 2.5 s: 80 parallel holds give exactly one 201, the rest 409 or 503, never a 500 or a double booking
   - 3 consecutive full runs green afterwards
2. **A vacuous test that I caught in my own review.** The "fall-back slots are labelled EDT/EST" HTTP test used Nov 1 2026, which is already in the past, so the engine returned nothing and the test *returned early* while passing. **Fix:** a pure `localLabel()` unit test on the Nov 1 2026 instants, plus an HTTP test that computes the **next** US fall-back night from the DB clock and asserts 8 slots, both 01:00s ambiguous, EDT/EST.
3. **My "production requires APP_ORIGIN" assertion tested the wrong thing.** It passed `APP_ORIGIN: ''`, which fails URL validation instead of the "required" rule. Rewritten to omit the variable.
4. **`request.host` collision.** I declared `request.host` for the session host, but Fastify already uses that name for the Host header. `tsc` caught it; renamed to `request.sessionHost`.
5. **Compose would have crashed at startup.** Production config now requires `APP_ORIGIN`, and compose runs `NODE_ENV=production`. Caught before committing; compose and `.env.example` now set it.
6. **My Phase 5 summary said "39 test files"; it was 35.** I hadn't checked the number. Corrected in `phase-5.md`.
7. **Deviations from my own plan:**
   - The replay header is **`Idempotent-Replayed`** (Stripe's convention), not `Idempotency-Replayed` as the plan said.
   - The HTTP layer landed as one larger commit (`46fc9dc`), because `app.ts` wires every route module. The services were split out first (`f68ec3e`) and the tests come in three separate commits.

## Test results
```
pnpm test → Test Files 42 passed (42) · Tests 364 passed (364) · 3 consecutive green runs
  unit        138  (+ slot-labels 3)
  integration 226  api: host-http 14 · guest-http 12 · auth-http 11 · http-basics 10 · logging 1
                   + expiry-audit 3 · burst test 1 · (earlier 174)
typecheck, lint, db:types --verify → clean · docker compose up --build → OK
```
| R | Status after Phase 6 |
|---|---|
| R21 | ✅ **Done.** A real log scan after a full journey, mutation-checked. Headers asserted. |
| R1, R5, R22 | ✅ Also over HTTP: inject with per-request IPs, the replay header, `Retry-After`, the TRUST_PROXY cases. |
| R6, R9, R10, R16, R17 | ✅ Status and body pass-through checked over HTTP. The logic was already covered in Phase 5. |
| Your 503 rule | ✅ A single deadlock retried → 201; twice → 503 + `Retry-After: 1`; the safety net covers code paths outside `writeTx`. |

## Commits
```
6d6c2a0 feat(audit): one booking_events row per expired hold, whoever expires it        (post-Phase-5)
79159cc docs: host/guest tz = Intl + Luxon ...; fix phase 5 file count (35, not 39)       (post-Phase-5)
2692104 fix(test): separate contention correctness from lock_timeout; add a default-timeout burst test
f68ec3e feat(services): slots view with local labels, auth sessions, host admin under the host lock
46fc9dc feat(http): routes, cookie auth, origin check, login rate limit, security headers, redacted logs
ebe6b24 test(api): R21 log scan over a full HTTP journey; guest routes over HTTP
698e09a test(api): login/session/logout, login rate limit, configurable Origin check
6c18c0c test(api): host settings, event types, atomic availability, host lock, isolation
cb9788d docs: API as built (routes, headers, codes), logging + CSRF/Origin details, ...
(+ this summary and AI_LOG)
```

## Changes from the design (all in `docs/design.md`)
- Design §7 has been rewritten as built: every route, header and error code.
- Design §5.7 adds what is logged, and the Origin allow-list with the Vite dev rule.
- Design §5.8 adds the testing note on lock_timeout vs. contention, and the login rate limit's in-memory store (per instance).
- New known gaps:
  - the rate-limit store is per instance (strict limits across instances need a shared store)
  - CSRF relies on SameSite plus the Origin check, with no token

## Open questions for Phase 7 (host dashboard)
1. **UI stack:** plain React + react-router with a small hand-written CSS file (no UI library), matching "plain and clear is fine". OK?
2. **Availability editor:** one form that edits the weekly windows and the date overrides, saved with a single `PUT` (replace-all). Errors like `OVERLAPPING_WINDOWS` are shown inline, and the server keeps the previous availability on error. OK?
3. Should the dashboard show **times in the host's time zone** (the settings value), with the zone printed on every time?
