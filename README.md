# Slotbook

A small booking system in the spirit of Calendly. Hosts publish when they are free. Guests hold a slot for 5 minutes, then confirm it, and can later reschedule or cancel through a private link. **Nobody is ever double-booked**, even with concurrent requests, network retries, a wrong server clock or tampered requests.

TypeScript end to end: Fastify + Kysely on Postgres 16, React + Vite for the UI.

**Starter template:** none. The project was built from scratch, starting with the design document (`docs/design.md`, the first commit). The full history is unsquashed.

More detail:
- `docs/design.md`: the design (data model, locking, time zones, API, test plan R1–R27)
- `docs/phases/`: what was planned, built and found wrong in each phase
- `AI_LOG.md`: the transcript of building this with an AI assistant

---

## Quick start (one command)

Requires Docker.

```sh
docker compose up --build
```

This starts Postgres, runs the migrations, seeds a demo host with two event types, and serves the app and API on **http://localhost:3000**.

| What | Where |
|---|---|
| Host login | http://localhost:3000/login, user **`demo@slotbook.dev`**, password **`demo1234`** (change it with `SEED_HOST_PASSWORD`) |
| Public booking page, 1:1 | http://localhost:3000/demo/intro-30 (30 min, 10 min buffer after) |
| Public booking page, group | http://localhost:3000/demo/workshop (60 min, 5 seats, 15 min buffers) |
| Health | http://localhost:3000/health |

The demo host is in `America/New_York` and is available Mon–Fri 09:00–17:00, with Wednesday split 09:00–12:00 / 13:00–17:00. Bookings need 4 hours' notice and can be up to 30 days ahead. Restarting is safe: migrations and the seed are idempotent.

Ports: set `APP_PORT` or `DB_PORT` if 3000 or 5432 is taken, e.g. `DB_PORT=5433 docker compose up`.

## Local development

Requires Node ≥ 22 (developed on 26; the image uses 24), pnpm (developed with 12) and Docker.

```sh
pnpm install
cp .env.example .env
docker compose up -d db         # only the database
pnpm migrate && pnpm seed
pnpm dev                        # API on :3000 (tsx watch) + Vite on :5173 (proxies /api)
```

Open http://localhost:5173.

| Script | Does |
|---|---|
| `pnpm test` | every test (unit, integration, web); starts its own Postgres |
| `pnpm test:concurrency` | only the concurrency, lock and clock tests (see below) |
| `pnpm e2e` | Playwright tests in a real browser (Chromium) against the Docker production build (see below) |
| `pnpm typecheck` / `pnpm lint` | TypeScript (server, web, web tests, e2e) / ESLint, including a rule that bans reading the process clock in booking code |
| `pnpm build` / `pnpm start` | production build (server + SPA) / run it |
| `pnpm db:types` | regenerate `src/server/db/types.ts` from the migrations (kysely-codegen); `--verify` fails if it is stale |

## Tests

```sh
pnpm test
```

One command, and Docker is the only requirement. It starts a throwaway `postgres:16-alpine` with Testcontainers, migrates it and runs everything against it. Set `TEST_DATABASE_URL` to use an existing database instead, e.g. a CI service container.

On the development machine (Intel Core 5 210H, 12 threads, 11 GiB RAM, Docker on WSL2), the full run (401 tests) takes **about 2 min 10 s** end to end. Three runs took 126 s, 144 s and 126 s. Roughly:

| Part | Time |
|---|---|
| unit | 4 s |
| integration | 96 s |
| web | 31 s |
| starting and migrating each Postgres container | about 6 s |

`pnpm test:concurrency` takes about 43 s.

| Project | Where | What |
|---|---|---|
| unit | `test/unit/**` | slot engine (DST, cross-day, clock independence), secrets, transitions, config, the lint clock rule, a scan that no SQL does time-zone math, README/env drift |
| integration | `test/integration/**` | real Postgres: constraints and the seat trigger, holds, confirm, cancel, reschedule, release, sweeper, idempotency, the IP cap, lock timeouts, deadlock retry, clock skew, the HTTP API (`api/`) |
| web | `test/web/**` | the React pages in jsdom, with `fetch` routed into the **real** Fastify app and the real test Postgres (`app.inject`), not mocks |

After every integration and web test, an invariant check (`test/helpers/invariants.ts`) recomputes every session's seat count from the bookings, compares it with the stored count, and checks that no two live sessions of a host overlap.

### Only the concurrency tests

```sh
pnpm test:concurrency
```

This runs the 12 files where requests race or real time matters:
- `holds-concurrency`: 50 parallel holds for the last seat give exactly one 201; group capacity; overlapping event types; the constraints alone with the lock bypassed; an 80-request burst with the default lock timeout
- `holds-idempotency`: concurrent duplicate keys
- `holds-ip-cap`: the per-IP hold cap
- `holds-clock`: an old hold expires while a new hold waits on the host lock
- `holds-lock-timeout`: a hold stuck behind the host lock gets 503 fast
- `write-tx`: deadlock and serialization retry
- `confirm`, `cancel`, `reschedule`: concurrent confirms, cancels and reschedules, and a hold that **expires while confirm waits on the lock**
- `sweeper`
- `cross-cutting`: a server clock skewed ±1 year, lock timeouts on every write path
- `api/guest-http`: the same over HTTP

The design's reliability cases (R1–R27) and the test that proves each are listed in `docs/design.md` §9.

### End-to-end tests in a real browser

```sh
pnpm exec playwright install chromium   # once
pnpm e2e
```

`scripts/e2e.sh` builds and starts the production Docker image as a **separate compose project** (`slotbook-e2e`, app on :3100, database on :5433), so a running dev stack is not touched. It uses a fresh random `APP_SECRET`, waits for `/health` and runs Playwright (Chromium). It always finishes with `docker compose down -v` on that project only. `E2E_KEEP=1 pnpm e2e` leaves the stack running for debugging. About 1.5 min, most of it the image build.

Each test sets up what it needs (through the UI or the API) and runs on its own:

| Test (`e2e/`) | Proves |
|---|---|
| full guest flow | Berlin browser: pick a time → held with a countdown → confirm → manage link → reschedule → cancel; the server agrees at each step |
| race | two browsers click the same time: one holds it, the other is told it was just taken and its list refreshes; the first can still book |
| time zones | New York and Kolkata browsers show the same instant with their own labels; the switcher relabels |
| wrong browser clock | with the browser's clock 10 min fast, the countdown still starts near 5:00 and confirm works (the countdown uses the server's `expires_at − server_now`) |
| leaving the page | navigating away releases the hold (`pagehide` + `keepalive`), and the time is offered again right away |
| host | seeded login; a booking (made via the API) shows in the host's zone with the zone printed |
| keyboard only | book, open the manage link and cancel using only Tab, Enter and typing; every focused control shows a focus ring |

The race, clock and leaving-the-page tests were mutation-checked: with the countdown built on the browser clock, or without the `pagehide` release, they fail.

### CI

`.github/workflows/ci.yml` runs on every push and pull request, in two parallel jobs:
- **test:** a gitleaks secret scan of the full history (reviewed false positives are in `.gitleaksignore`), typecheck, lint, build, `pnpm test`
- **e2e:** `pnpm e2e`. If it fails, the Playwright report, traces and app logs are uploaded as an artifact.

---

## How double booking is prevented

1. **One host lock per write.** Every write (hold, confirm, reschedule, cancel, release, host edits) takes `SELECT … FOR UPDATE` on the host row, always in the same order: idempotency key → IP advisory lock → host → bookings. Writes for one host are serialised; different hosts run in parallel.
2. **The clock is read after the locks.** "Now" is `clock_timestamp()` read once after the locks are held, never the app server's clock or the transaction start. A hold that expires while another request waits for the lock is seen as expired.
3. **The database refuses a double booking even if the code is wrong.** Seats live in `occupancies`, maintained only by a trigger on `bookings`:
   - `CHECK (seats_taken BETWEEN 0 AND capacity)`
   - an exclusion constraint so that no two occupied sessions of one host (including buffers) overlap

   A test bypasses the lock with raw parallel inserts and still gets no double booking.
4. **Idempotency.** `POST /api/holds` requires an `Idempotency-Key`. The key row is claimed first, inside the same transaction, so a retry or a double click returns the stored response instead of a second hold.
5. **Expiry needs no background job.** Capacity counts only holds that have not expired, measured by the database clock. The sweeper only tidies up.
6. **Fail fast.** Write transactions use `lock_timeout` 2.5 s, which returns 503 `HOST_BUSY` instead of piling up. A deadlock or serialization failure is retried once, then becomes 503 `TRY_AGAIN`, never a 500.

Secrets: the hold secret and the manage token are HMACs derived from `APP_SECRET`. Only a sha256 of the manage token is stored. The manage link puts the token in the URL fragment (`/manage#…`), so it never reaches server logs or a `Referer` header, and API paths that carry it are redacted in our logs.

---

## API

JSON in and out. Errors are always `{"error": {"code", "message"}}`. Every response has `X-Request-Id`. Routes marked 🔒 also send `Cache-Control: no-store` and `X-Robots-Tag: noindex`.

**Public / guest**

| Method | Path | Body → response |
|---|---|---|
| GET | `/api/hosts/{host}/events/{slug}` | event type + host name and zone |
| GET | `/api/hosts/{host}/events/{slug}/slots?from&to&tz` | ISO `from`/`to` (≤ 31 days), IANA `tz` → `{slots:[{start_at, end_at, seats_left, local:{date, time, label, ambiguous}}]}`. `ambiguous` marks a wall time that occurs twice (DST fall-back), shown as `01:00 EDT` / `01:00 EST` |
| POST 🔒 | `/api/holds` | header `Idempotency-Key`; `{host, slug, start_at}` → 201 `{hold_id, hold_secret, expires_at, server_now, start_at, end_at}`. A replay adds `Idempotent-Replayed: true` |
| POST 🔒 | `/api/holds/{id}/confirm` | `{hold_secret, name, email, tz}` → `{booking, manage_token, manage_url}` |
| POST 🔒 | `/api/holds/{id}/release` | `{hold_secret}` → `{hold_id, status:"expired"}` |
| GET 🔒 | `/api/bookings/{token}` | `{booking}` |
| POST 🔒 | `/api/bookings/{token}/reschedule` | `{start_at}` → `{booking}` (same event type) |
| POST 🔒 | `/api/bookings/{token}/cancel` | `{reason?}` → `{booking}` |

**Host** (cookie session; writes must come from an allowed `Origin`)

| Method | Path | |
|---|---|---|
| POST 🔒 | `/api/auth/login` | `{email, password}`; 10 attempts / min / IP |
| POST | `/api/auth/logout` | |
| GET | `/api/me` | `{host}` or 401 |
| GET / PUT | `/api/host/settings` | `{name?, timezone?}` |
| GET / POST | `/api/host/event-types` | |
| PATCH | `/api/host/event-types/{id}` | any field, including `active:false`. There is no DELETE: hosts and event types are deactivated, never deleted |
| GET / PUT | `/api/host/availability` | `{weekly:[{weekday, start, end}], overrides:[{date, kind:"off"|"custom", windows}]}`, replaced atomically |
| GET 🔒 | `/api/host/bookings?upcoming=1` | |
| POST 🔒 | `/api/host/bookings/{id}/cancel` | `{reason}` (required for hosts) |
| GET 🔒 | `/api/host/notifications` | the notifications sink |
| GET | `/health` | database ping |

**Status codes:**
- 400 bad input or a missing key
- 401
- 403 wrong Origin
- 404, also for a wrong hold secret or token
- 409 `SLOT_UNAVAILABLE` / `ALREADY_CONFIRMED` / `INVALID_STATE` / `BOOKING_STARTED`
- 410 `HOLD_EXPIRED`
- 415
- 422 `SLOT_NOT_OFFERED` / `IDEMPOTENCY_KEY_REUSED` / validation of availability
- 429 `HOLD_LIMIT` / `RATE_LIMITED`, with `Retry-After`
- 503 `HOST_BUSY` / `TRY_AGAIN`, with `Retry-After: 1`
- 500 only for genuine bugs, with a `request_id` and never a stack

The full list is in `docs/design.md` §7.

Notifications: confirm, reschedule and cancel each write a row to the `notifications` table in the same transaction (the brief allows a table as the sink). Hosts see these rows in the dashboard.

---

## 60-second tour

1. `docker compose up --build`, then open **http://localhost:3000/demo/intro-30**. Slots are shown in your browser's time zone; use the switcher to view another.
2. Pick a day and a time. The slot is **held for 5:00**, with a countdown based on the server's time, not your browser's clock. Picking another time holds the new slot first and only then releases the old one.
3. Enter a name and email, then **Confirm**. You get a private **manage link** (`/manage#…`).
4. Open the manage link: **reschedule** with the same picker, or **cancel** with an optional reason.
5. Try a race: hold the same time in two browser windows. The second one says the time was just taken.
6. Go to **http://localhost:3000/login** and log in as `demo@slotbook.dev` / `demo1234`. The dashboard shows:
   - **Bookings**: upcoming, in the host's zone with the zone printed; cancel needs a reason
   - **Event types**: create, edit, deactivate
   - **Availability**: weekly windows plus date overrides, in one form saved in one request
   - **Settings**: home time zone
   - **Notifications**: the sink

---

## Configuration

The app reads its environment at startup (`src/server/config.ts`) and refuses to start if a value is invalid. A unit test (`test/unit/readme-env.test.ts`) fails if a variable is missing from this table.

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `DATABASE_URL` | none | **yes** | Postgres connection string. On a hosted Postgres use the direct connection, not a transaction pooler, because the booking path relies on session-level transactions and row locks |
| `APP_SECRET` | none | **yes** (≥ 32 chars) | Key that hold secrets and manage tokens are derived from. Changing it invalidates every open hold and every manage link |
| `APP_ORIGIN` | `http://localhost:$PORT` | **yes in production** | The browser origin of the app. Cookie-authenticated writes from any other `Origin` get 403 |
| `EXTRA_ALLOWED_ORIGINS` | none | no | More allowed origins, comma-separated. In development the Vite origins (`localhost:5173`, `127.0.0.1:5173`) are added automatically |
| `NODE_ENV` | `development` | no | `production` turns on `Secure` cookies and requires `APP_ORIGIN` |
| `HOST` | `0.0.0.0` | no | Listen address |
| `PORT` | `3000` | no | Listen port |
| `LOG_LEVEL` | `info` | no | pino level (`silent` … `trace`) |
| `DB_POOL_MAX` | `10` | no | Connection pool size. A request waiting for a host lock holds a connection for up to 2.5 s |
| `TRUST_PROXY` | `false` | no | `false` = the client IP is the socket peer. `1` (or n) = trust that many proxy hops in `X-Forwarded-For`. `true` is rejected, because it would let clients spoof their IP and dodge the per-IP hold cap |
| `SESSION_TTL_HOURS` | `168` | no | Host session lifetime (no sliding renewal) |
| `WEB_DIST_DIR` | `dist/web` next to the server build | no | Where the built SPA is served from |
| `SEED_HOST_PASSWORD` | `demo1234` | no | Password the seed gives `demo@slotbook.dev` (seed only) |
| `APP_PORT` / `DB_PORT` | `3000` / `5432` | no | Host ports published by `docker-compose.yml` |
| `TEST_DATABASE_URL` | none | no | Tests use this database instead of starting a container |
| `TYPES_DATABASE_URL` | none | no | `pnpm db:types` uses this database instead of starting a container |

Fixed constants (`src/server/services/holds.ts`, `confirm.ts`):
- hold = 5 min
- confirm replay window = 15 min
- at most 3 active holds per IP
- idempotency keys are kept 24 h
- the sweeper runs every 30 s

---

## Assumptions

Where the brief left room, these choices were made. Details are in `docs/design.md` §6 and §10.

1. **Slot step = event duration**, counted from each window's start.
2. **The meeting must fit inside the availability window; buffers may fall outside it.** Buffers only matter against other bookings. A booking on one event type blocks overlapping slots of the host's other event types.
3. **A slot's end = start + duration in real minutes**, so DST nights are measured in real time. A window boundary that occurs twice on a fall-back night means its **first** occurrence. A boundary inside a spring-forward gap moves forward.
4. **Horizon = now + N × 24 h**, and min notice is `start ≥ now + notice`; both are inclusive. Across a DST change the horizon differs by an hour from "the same clock time N days later".
5. **Zone labels** come from ICU in `en-US`: US zones get `EDT`/`EST`, and many others show as `GMT±n`.
6. Windows can't cross midnight but may end at `24:00`. A date override is either a day off or custom hours, and it replaces that date's weekly rules.
7. Group sessions: guests join the same start time until capacity is reached. Buffers apply per session.
8. **Min notice is checked when holding** (and when rescheduling), not again at confirm.
9. **Started bookings are frozen:** once a booking has started, neither guest nor host can cancel or reschedule it.
10. **Reschedule stays within the same event type.**
11. **If the host changes time zone or availability, existing bookings keep their UTC times.** Only future slots change.
12. **Confirm can be retried within 15 minutes** with the same name (trimmed) and email (case-insensitive); it returns the same booking and token.
13. One host per account, seeded. The guest page shows the next 30 days, capped by the event type's horizon.
14. **Client IP:** the socket peer unless `TRUST_PROXY` says how many proxy hops to trust.
15. Hosts and event types are **deactivated, never deleted**, and bookings are append-only, so history is never lost and nothing cascades into bookings.

---

## Optional extensions

Named as in the brief. This section is updated as later work adds to them.

| Extension | Status |
|---|---|
| **Abuse protection** | **Partial.** Built: a per-IP cap of 3 active holds (429 `HOLD_LIMIT`), so one client can't hold every slot; login rate-limited to 10/min per IP (`@fastify/rate-limit`). Missing: rate limits on the other public endpoints (slots, holds, confirm, manage). Rotating IP addresses gets around the cap. The rate-limit store is in memory, so it is per instance. |
| **Observability** | **Partial.** Built: structured JSON logs (pino) with a request ID on every line and in the `X-Request-Id` header, secrets redacted; `/health` with a database ping. Missing: metrics (bookings, hold expiries, notification lag). |
| **End-to-end tests and CI** | **Built.** Playwright (Chromium) guest-flow tests against the Docker production build, and a GitHub Actions workflow that runs every test on every push (see Tests → CI). |
| Load test | Not yet (planned: k6 against the compose build). |
| **Accessibility** | **Partial.** The keyboard-only guest flow is tested in a real browser: book, open the manage link and cancel with Tab, Enter and typing only, with a visible focus ring on every control. The pages use semantic lists, labelled controls, `aria-pressed`, `role="alert"`/`"status"`, and the tests find elements by role and name. Missing: no screen-reader walk-through and no automated contrast/ARIA audit. |
| Live deployment | Not built (see Known gaps). |
| Waitlist, Reminders, Calendar invite, Host webhooks, Round-robin team events, External busy times, Daily cap and per-guest limit, Embeddable widget | Not built. |

---

## Known gaps

This is the single list. The design doc links here.

**Not built**
- **No live deployment.** The app runs locally with `docker compose up`. Deploying would need a host such as Render plus Supabase or Neon, using the direct Postgres connection (not a transaction pooler), `TRUST_PROXY=1`, `APP_ORIGIN` set to the public URL, a strong `APP_SECRET`, and the seed run once.
- **Notifications are only written, not delivered.** The `notifications` table is the sink. The columns for delivery (`attempts`, `next_attempt_at`, `delivered_at`) exist, but there is no dispatcher posting to a webhook (designed in `docs/design.md` §3: `SKIP LOCKED` + lease, at-least-once). Order isn't guaranteed either: consumers should dedupe on the id and order by `created_at`.
- **No metrics** (see Observability).
- **Rate limits only on login** (see Abuse protection); the IP cap can be bypassed with many IPs.
- **No real email or calendar sync** (out of scope per the brief).
- **No no-show tracking.** Started bookings are frozen, so a host can't mark a no-show.
- **No windows that cross midnight**, and no per-event slot interval (the step is always the duration).
- **No host sign-up, password reset or multiple hosts per account.** There is one seeded login.
- **Randomized operation test (R25) not written.** The invariant check runs after every test instead.

**Security trade-offs**
- **Manage tokens can't be revoked or rotated individually**, and there is no `APP_SECRET` rotation. Changing the secret invalidates all links at once.
- **The manage token is in API paths** (`/api/bookings/{token}`). Our logs redact it, but proxy or CDN access logs would see it. The fix is to send it in a header.
- **CSRF defence is SameSite=Lax cookies plus an Origin check**, with no CSRF token.
- **`docker compose up` falls back to a public `APP_SECRET`** (the one in `docker-compose.yml` and `.env.example`), so the one-command run works without setup. With it, anyone can derive hold secrets and manage tokens. The app still starts (it's a local demo), but logs a loud `!!! INSECURE` warning at startup. For anything real, set `APP_SECRET`, e.g. `APP_SECRET=$(openssl rand -base64 48) docker compose up`.

**Operations**
- **No purge job.** Bookings are append-only (DELETE is blocked), so expired holds stay as rows. Idempotency keys are purged after 24 h. A deliberate admin archive job would be next.
- **Connection pool under a burst.** Requests waiting for one host's lock each hold a pooled connection for up to 2.5 s (then 503). A burst on one host can therefore slow other hosts. To be measured in the load test.
- **End-to-end tests are Chromium only** (no Firefox or WebKit), and they cover the guest flow plus one host check, not every dashboard page.
- **Accessibility: screen readers not verified.** The keyboard flow is tested; a screen-reader walk-through and an automated audit are not done.

---

## Project layout

```
src/server/   Fastify app: config, db (Kysely, migrations, seed, codegen types), engine (pure slot
              generation), services (holds, confirm, cancel, reschedule, release, auth, host admin),
              routes, http (security headers, errors), workers (sweeper)
src/shared/   zod schemas + time-zone helpers used by both sides
src/web/      React SPA: host dashboard, guest booking page, manage page
test/         unit · integration (real Postgres) · web (jsdom + real API) · helpers
e2e/          Playwright specs (real browser, Docker production build); scripts/e2e.sh runs them
.github/      CI workflow
docs/         design.md, phases/
```
