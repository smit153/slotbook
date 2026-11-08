# Slotbook: Design Doc

> Status: **v0.2. Review answers and security/consistency fixes folded in.** Awaiting go-ahead before coding.
> Source: take-home brief (Nov 4, 2026). 72h deadline. The core is about 4–5h of work, and extensions come on top.

**Changelog v0.1 → v0.2**
- Stack: Kysely as the query builder. Raw `sql` is kept for constraints and locking.
- **No bearer secret is ever persisted in plaintext.** Hold secrets and manage tokens are derived with HMAC, only hashes are stored, and replays re-derive them (§5.0).
- A hold secret is required to confirm a hold (§5.2).
- Token hygiene: `Referrer-Policy: no-referrer`, log redaction, the manage link puts the token in the URL fragment (§5.7).
- Hold path uses a `SAVEPOINT` so a 409 can be stored, plus an explicit policy for which outcomes are cached (§5.1).
- `seats_taken` is maintained by a DB trigger. The slots read path counts *live* seats and never trusts `seats_taken` (§4, §6).
- Seat-count invariant test (stored + live) after every integration test and in a randomized test (§9).
- A reused occupancy row at `seats_taken = 0` has its capacity, end and buffers refreshed on 0→1 (§5.1).
- A minimal active-hold cap per IP is part of the core (§5.1).
- Extensions narrowed. Deployment moved to after the core (§11, §12).

---

## 1. Goals and non-goals

**Goal.** A small Calendly whose booking engine you'd trust with money. **No double booking**, even with:
- concurrent requests (two guests and the last seat)
- network misbehaviour (retries, double-clicks, a lost response after commit)
- clock misbehaviour (a wrong client clock, app servers whose clocks drift, DST)
- user misbehaviour (tampered slot times, expired holds, guessed ids, replayed tokens)

**Priority order:** correctness and reliability first, then the complete core flows, then tests, docs and report, then the agreed extensions, then deployment.

**Non-goals for the core:** calendar sync, payments, real email, multi-host round-robin, polished UI.

---

## 2. Tech stack

| Concern | Choice | Why / alternatives |
|---|---|---|
| Language | TypeScript end to end | Required |
| API | **Fastify** (Node 20+) | Fast, with good TS support and hooks for headers and logging. Alt: Next.js API routes. Rejected because serverless and pooling semantics muddy the transaction and locking story. |
| Frontend | **React + Vite** SPA (react-router) | In prod Fastify serves the built SPA, so there is one service. |
| DB access | **Kysely** (typed query builder) + **raw `sql` template** for constraints, `FOR UPDATE`, advisory locks, range types and upserts | Typed queries without ORM magic, and full control of transactions. Alt: Prisma, rejected because it handles exclusion constraints, range types and fine-grained transaction control poorly. Alt: plain `pg`, which loses type safety. |
| Migrations | Kysely `Migrator` (file provider). Migrations are written mostly in raw `sql` (constraints, triggers, enums). | Constraints stay visible as SQL |
| Validation | **zod**, shared between API and UI | One schema source |
| Time zones | **Luxon** (IANA via Intl) | Mature DST handling. Alt: date-fns-tz. Alt: Temporal polyfill. |
| Passwords | `argon2` (fallback: `bcryptjs`) | Seeded email + password login |
| Logging | `pino` (Fastify built-in) with redaction | Also the base for the observability extension |
| Tests | **Vitest**: unit + integration against **real Postgres** (compose) | The brief requires a concurrency test on real PG |
| Run | `docker compose up` → postgres + app (migrate → seed → serve) | One command |
| Package mgr | pnpm, single package (`src/server`, `src/web`, `src/shared`) | No monorepo overhead |

---

## 3. Architecture

```
 Browser (Guest SPA / Host dashboard)
        │  JSON over HTTP (UTC ISO instants; tz only for display)
        ▼
 ┌──────────────────────── Fastify app ─────────────────────────┐
 │ hooks: request-id, security headers, redacted logging        │
 │ routes → zod validation → services (booking, availability)   │
 │                     │                                        │
 │   slot engine (pure fn) ◄── rules + live occupancy snapshot  │
 │                     │                                        │
 │   booking service: one PG transaction per command            │
 │     1. idempotency key claim                                 │
 │     2. per-IP hold cap (advisory xact lock)                  │
 │     3. lock host row (FOR UPDATE)                            │
 │     4. sweep expired holds for host                          │
 │     5. re-validate slot against rules (server-side)          │
 │     6. SAVEPOINT → claim seat (trigger + constraints)        │
 │     7. booking + outbox notification + stored response       │
 │                                                              │
 │ background workers (in-process, setInterval):                │
 │   - hold sweeper   (held → expired; metric)                  │
 │   - outbox dispatcher (notifications → local webhook)        │
 └──────────────────────────────┬───────────────────────────────┘
                                ▼
                         Postgres 15+ (source of truth)
```

Workers are an optimisation only. **Correctness never depends on them running**: every read path computes live seats (`confirmed` or `held AND expires_at > now()`), and every write path sweeps the host's expired holds under the host lock before claiming.

---

## 4. Data model

All instants are `timestamptz` (UTC). Local availability times are `time` + the host's IANA tz.

```sql
hosts(id uuid, slug UNIQUE, name, email UNIQUE, password_hash, timezone TEXT NOT NULL)
host_sessions(id, host_id, token_hash BYTEA UNIQUE, expires_at)       -- cookie value never stored raw

event_types(
  id, host_id FK, name, slug,
  duration_min      INT CHECK (duration_min BETWEEN 15 AND 120),
  capacity          INT CHECK (capacity >= 1),
  buffer_before_min INT CHECK (buffer_before_min BETWEEN 0 AND 30),
  buffer_after_min  INT CHECK (buffer_after_min  BETWEEN 0 AND 30),
  min_notice_min    INT CHECK (min_notice_min >= 0),
  horizon_days      INT CHECK (horizon_days BETWEEN 1 AND 365),
  active BOOL, UNIQUE(host_id, slug))

availability_rules(id, host_id, weekday SMALLINT CHECK 1..7, start_time TIME, end_time TIME,
  CHECK (end_time > start_time))                -- several windows/day; overlap validated in API

date_overrides(id, host_id, date DATE, start_time TIME NULL, end_time TIME NULL)
  -- NULL times = day off; rows with times = custom windows; any override for a date REPLACES weekly rules

-- One row per occupied "session" of the host. Postgres enforces no-overlap and capacity here.
occupancies(
  id, host_id, event_type_id,
  start_at, end_at,
  blocked tstzrange NOT NULL,                   -- [start - buffer_before, end + buffer_after)
  capacity INT NOT NULL, seats_taken INT NOT NULL DEFAULT 0,
  CHECK (seats_taken BETWEEN 0 AND capacity),
  UNIQUE (event_type_id, start_at),
  EXCLUDE USING gist (host_id WITH =, blocked WITH &&) WHERE (seats_taken > 0))

bookings(
  id uuid, host_id, event_type_id, occupancy_id FK,
  status booking_status ('held','confirmed','cancelled','expired'),
  start_at, end_at,
  expires_at timestamptz NULL,                  -- set while held
  client_ip inet,                               -- for the per-IP active-hold cap
  guest_name, guest_email, guest_tz,            -- NULL until confirmed
  manage_token_version INT NOT NULL DEFAULT 1,
  manage_token_hash BYTEA UNIQUE NULL,          -- sha256(derived token); plaintext never stored
  cancel_reason, cancelled_by ('host'|'guest'),
  created_at, confirmed_at, cancelled_at)

booking_events(id, booking_id, type, from_status, to_status, payload jsonb, at)   -- audit trail

idempotency_keys(scope, key, request_hash BYTEA, response_status INT NULL, response_body jsonb NULL,
  created_at, PRIMARY KEY (scope, key))          -- response_body never contains secrets

notifications(id, booking_id, type, payload jsonb, created_at,     -- transactional outbox = the sink
  attempts, next_attempt_at, delivered_at, last_error)              -- payload never contains tokens
```

### 4.1 `seats_taken` is maintained by a trigger, not by app code
`AFTER INSERT OR UPDATE OF status, occupancy_id ON bookings`:
- `active(row) := row.status IN ('held','confirmed')`. This is status-based. Time-based expiry is materialised by the sweep.
- If OLD was active on occupancy A, decrement A. If NEW is active on occupancy B, increment B. The decrement runs first, so a reschedule that moves a booking to an overlapping time works in one statement.
- The increment runs `UPDATE occupancies SET seats_taken = seats_taken + 1`, which fires the `CHECK` and the `EXCLUDE` (when the row enters `seats_taken > 0`). A violation raises 23514 or 23P01 and the service maps it to 409.

There is one code path for the counter, so app code can't drift from it. A `BEFORE UPDATE` trigger also rejects illegal status transitions (§5.6).

### 4.2 Why `occupancies`?
Capacity >1 means multiple bookings legitimately share one time, so an exclusion constraint on `bookings` would only work for 1:1. Grouping seats into an occupancy lets Postgres enforce:
1. **No overlap** between different sessions of the same host, across *all* event types and including buffers (the exclusion constraint).
2. **No overbooking** of a group session (the `CHECK`).

---

## 5. Booking engine: the critical path

### 5.0 Secrets: derived, never stored in plaintext
`APP_SECRET` (env, at least 32 bytes, required in prod) is the key used to derive all guest bearer secrets:

```
hold_secret  = b64url(HMAC-SHA256(APP_SECRET, "hold:v1:"   || booking_id))
manage_token = b64url(HMAC-SHA256(APP_SECRET, "manage:v1:" || booking_id || ":" || manage_token_version))
```

- **Hold secret:** nothing is stored. It is verified by re-deriving it and comparing in constant time.
- **Manage token:** only `sha256(manage_token)` is stored, for lookup. Bumping `manage_token_version` revokes the old link.
- Idempotent replays, the notification dispatcher (building the "email" link) and confirm retries **re-derive** secrets when needed. Neither `idempotency_keys.response_body` nor `notifications.payload` ever contains a secret.
- Threat model: a DB dump alone yields no usable secrets. The DB plus `APP_SECRET` does, which is the same trust level as the app server itself. This is documented in the report.
- Alternatives considered: (a) a random token with the plaintext stored in the idempotency response. Rejected because a DB leak exposes every link. (b) Rotating the token on every confirm retry. Rejected because concurrent double-clicks would invalidate a link the user already saw, and the notification dispatcher couldn't build the link.

### 5.1 Hold: `POST /api/holds` (`Idempotency-Key` header required)
Body `{host, slug, start_at}` → `201 {hold_id, hold_secret, expires_at, server_now}`.

```
0. Validate the body and the key format (8–128 chars). Failure → 400, before any txn, NOT cached.
BEGIN
1. INSERT idempotency_keys(scope='hold', key, request_hash) ON CONFLICT DO NOTHING RETURNING.
   - Conflict: a concurrent duplicate blocks on the PK until the first txn ends. Then
       hash differs        → 422 IDEMPOTENCY_KEY_REUSED (not stored)
       stored response     → replay it (re-derive hold_secret if it was a 201)
     ROLLBACK and return.
2. pg_advisory_xact_lock(hashtext('ip:' || client_ip))
   count the IP's live holds; ≥ HOLD_CAP_PER_IP (3) → ROLLBACK (key row gone) → 429 HOLD_LIMIT, NOT cached.
3. SELECT ... FROM hosts WHERE id = $host FOR UPDATE              -- serialises writes per host
4. Sweep: UPDATE bookings SET status='expired' WHERE host_id=$host AND status='held' AND expires_at <= now()
   (the trigger frees seats)
5. Re-validate start_at with the slot engine for that day (grid, window, min notice, horizon, not in the past).
   Not offered → outcome = 422 SLOT_NOT_OFFERED.
6. SAVEPOINT claim
     upsert occupancy (event_type_id, start_at) with refresh-on-zero:
       INSERT ... ON CONFLICT (event_type_id, start_at) DO UPDATE
         SET capacity = EXCLUDED.capacity, end_at = EXCLUDED.end_at, blocked = EXCLUDED.blocked
         WHERE occupancies.seats_taken = 0
       (no row returned → session is live with seats>0 → reuse its snapshot; SELECT id)
     INSERT booking(status='held', expires_at = now() + interval '5 min', client_ip)  -- trigger: seats+1
   on 23P01 / 23514 → ROLLBACK TO SAVEPOINT claim; outcome = 409 SLOT_UNAVAILABLE
7. UPDATE idempotency_keys SET response_status, response_body (no secret)
COMMIT
```

**Lock order** is always IP lock, then host row, then booking rows, so deadlocks can't happen.

**Idempotency caching policy:**

| Outcome | Cached? | Reason |
|---|---|---|
| 201 held | yes | The core guarantee: a retry gets the same hold |
| 409 SLOT_UNAVAILABLE, 422 SLOT_NOT_OFFERED | **yes** | A terminal business answer for *this intent*. Retrying the same key must not flip to success later and create a surprise hold. The UI uses a fresh key per slot click. |
| 400 validation, 422 key reused | no | Rejected before or instead of execution |
| 429 HOLD_LIMIT | no | Transient by nature; the client may retry the same key after a hold frees up |
| 5xx / crash | no | The txn rolls back including the key row, so a retry re-executes safely |

Keys expire after 24h (cleanup in the sweeper).

**Refresh-on-zero** solves stale snapshots. A zero-seat occupancy left behind after cancellations or expiries gets the *current* capacity, duration and buffers when it is reused. While seats>0 the session snapshot is kept, so joiners of a live group session share its parameters. Alternative considered: delete the row at 0. Rejected because bookings keep their `occupancy_id` FK for history.

### 5.2 Confirm: `POST /api/holds/{id}/confirm`
Body `{hold_secret, name, email, tz}`. Txn: verify the hold secret first. If it is invalid → **404** (indistinguishable from an unknown id). Then lock the host and the booking `FOR UPDATE`:
- `held` and `expires_at > now()` → `confirmed`, set `manage_token_hash`, `booking_events`, outbox `booking.confirmed` → `200 {booking, manage_token}` (derived).
- `held` and expired → mark `expired` (seat freed) → **410 HOLD_EXPIRED**.
- `confirmed`, with identical guest details and `now() < confirmed_at + 15 min` → **replay 200** with the re-derived token. No new notification. This covers retries and double-clicks without storing anything.
- `confirmed` otherwise → 409 ALREADY_CONFIRMED (no token). `expired` → 410. `cancelled` → 409.

Confirm needs no Idempotency-Key. It is naturally idempotent, and possession of the hold secret is the credential.

### 5.3 Reschedule: `POST /api/bookings/{token}/reschedule` `{start_at}`
Txn: look up by `sha256(token)`, lock the host, sweep, re-validate the new slot, upsert the new occupancy, then `UPDATE bookings SET occupancy_id, start_at, end_at`. The trigger releases the old seat first and then claims the new one. On constraint violation the **whole txn rolls back** → 409, and the original booking is untouched. If the booking is already at `start_at`, return 200 with no notification (natural idempotency). On success: `booking_events` + outbox `booking.rescheduled`. The token stays the same.

### 5.4 Cancel
Guest: `POST /api/bookings/{token}/cancel` `{reason?}`. Host: `POST /api/host/bookings/{id}/cancel` `{reason}` (required).
Lock → `confirmed → cancelled` (the trigger frees the seat) → outbox `booking.cancelled`. If already cancelled → 200, no duplicate notification.

### 5.5 Clock policy
- **Postgres `now()` is the only clock** for expiry, min notice, horizon and "upcoming". App server time is used only for logs.
- The client clock is never trusted. The UI countdown uses the offset `expires_at − server_now` from the response.

### 5.6 State machine
```
held ──confirm──► confirmed ──cancel──► cancelled
  └──timeout──► expired          (reschedule: confirmed → confirmed, new time)
```
Enforced by the service and by a `BEFORE UPDATE` trigger that rejects illegal transitions.

### 5.7 Token hygiene
- `Referrer-Policy: no-referrer` on every response (global hook). `Cache-Control: no-store` on token-bearing responses. `X-Robots-Tag: noindex` on manage pages.
- **Manage link = `/manage#<token>`.** The fragment is never sent to the server, so it can't appear in server or proxy access logs or in a Referer. The SPA reads it and calls the API.
- The API keeps the brief's `/api/bookings/{token}/…` path. The pino request serializer rewrites `/api/bookings/<token>` to `/api/bookings/:token`, and `redact` covers `cookie`, `authorization`, `idempotency-key`, `req.body.hold_secret` and any `manage_token`/`hold_secret` fields. A test asserts that a token never appears in captured log output.
- Residual risk: infra-level access logs (for example Render's) can still see the API path. This goes under Known gaps. A possible next step is to accept the token in an `Authorization` header instead.

---

## 6. Slot generation and time zones

Pure function `generateSlots(input) → Slot[]`, unit-tested in isolation:

```
input: hostTz, weeklyRules, overrides, eventType, liveOccupancies, now, rangeFrom, rangeTo
for each local date D in hostTz covering [rangeFrom, rangeTo]:
   windows = overrides[D] ?? weeklyRules[weekday(D)]
   for each window (local start..end):
       t = window start
       while t + duration <= window end:             # meeting must fit inside the window
            instant = DateTime.fromObject(D,t,{zone: hostTz})
            if instant's local time != t: skip         # DST gap: non-existent local time
            emit candidate (UTC)
            t += duration                              # step = event duration
filter: start >= now + min_notice AND start <= now + horizon
filter: candidate.blocked does not overlap any live occupancy of the host,
        except the same event type + same start with live seats < capacity → available (seatsLeft)
```

**Live occupancy read (no reliance on the sweeper or on `seats_taken`):**
```sql
SELECT o.*, count(b.id) FILTER (
         WHERE b.status = 'confirmed' OR (b.status = 'held' AND b.expires_at > now())) AS live_seats
FROM occupancies o LEFT JOIN bookings b ON b.occupancy_id = o.id
WHERE o.host_id = $1 AND o.blocked && tstzrange($from, $to)
GROUP BY o.id HAVING <live_seats> > 0
```
The read is advisory and takes no locks. The write path (§5.1) is authoritative.

- The grid is computed in local wall-clock time, so a 09:00–17:00 window yields 09:00, 09:30… local regardless of DST.
- **DST gap** (spring forward): non-existent local times are dropped, so there are no phantom slots.
- **DST overlap** (fall back): the earlier offset is used and the slot is emitted once.
- The API returns UTC ISO plus a `local` label in the requested `tz`. The UI groups by day **in the guest's chosen tz**.
- `tz` and the host timezone are validated against `Intl.supportedValuesOf('timeZone')`.

**Worked DST example (for the report):** Host in `America/New_York`, Mon–Fri 09:00–17:00, guest in `Asia/Kolkata`. US DST ends **Sun Nov 1 2026**.
- Fri Oct 30: 09:00 EDT (UTC−4) = 13:00Z = **18:30 IST**
- Mon Nov 2: 09:00 EST (UTC−5) = 14:00Z = **19:30 IST**

The host's grid is unchanged, while the guest sees the slot shift by an hour.

---

## 7. API (documented in README; errors are `{error:{code,message}}`)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/hosts/{host}/events/{slug}` | public event info |
| GET | `/api/hosts/{host}/events/{slug}/slots?from&to&tz` | max 31-day range; returns `seatsLeft` |
| POST | `/api/holds` | `Idempotency-Key` required → `{hold_id, hold_secret, expires_at, server_now}` |
| POST | `/api/holds/{id}/confirm` | `{hold_secret, name, email, tz}` → `{booking, manage_token}` |
| GET | `/api/bookings/{token}` | view |
| POST | `/api/bookings/{token}/reschedule` | `{start_at}` |
| POST | `/api/bookings/{token}/cancel` | `{reason?}` |
| POST | `/api/auth/login`, `/api/auth/logout`; GET `/api/me` | httpOnly SameSite=Lax session cookie |
| GET/PUT | `/api/host/settings` | timezone |
| CRUD | `/api/host/event-types` | |
| GET/PUT | `/api/host/availability` | weekly rules + overrides (replace-all, overlapping windows rejected) |
| GET | `/api/host/bookings?upcoming=1` | |
| POST | `/api/host/bookings/{id}/cancel` | `{reason}` required |
| GET | `/api/host/notifications` | view the sink (no tokens) |
| GET | `/health` | DB ping |

Codes: 400 validation · 401/403 auth · 404 · 409 `SLOT_UNAVAILABLE` / `ALREADY_CONFIRMED` / `INVALID_STATE` · 410 `HOLD_EXPIRED` · 422 `SLOT_NOT_OFFERED` / `IDEMPOTENCY_KEY_REUSED` · 429 `HOLD_LIMIT`.

---

## 8. Frontend pages

- `/login`: seeded host (`demo@slotbook.dev` / password from env, default `demo1234`)
- `/dashboard`: upcoming bookings (cancel with a reason), notifications log
- `/dashboard/event-types`: list, create, edit
- `/dashboard/availability`: tz picker, weekly windows per day, date overrides
- `/{host}/{slug}`: guest page. A tz switcher defaults to the browser tz, followed by days → slots → hold (5-min countdown) → form → confirmation with the manage link
- `/manage#<token>`: view, reschedule, cancel

The UI keeps one Idempotency-Key per slot click and reuses it on retries. The hold secret is kept only in memory.

---

## 9. Reliability matrix (each row → a named test)

| # | Failure case | Handling | Test |
|---|---|---|---|
| R1 | 50 parallel holds for the last seat (cap 1) | host lock + exclusion | exactly 1 succeeds, 49 get 409 |
| R2 | Group cap N, 3N parallel holds | `CHECK seats_taken <= capacity` | exactly N succeed |
| R3 | Parallel holds on different overlapping event types / buffers | exclusion on `blocked` | 1 succeeds |
| R4 | Lock bypassed (direct SQL inserts in parallel) | constraints + trigger alone | still no double booking |
| R5 | Double-click / retry with the same key, including concurrently | PK on key + stored response | one hold, identical responses, same secret |
| R6 | Same key, different body | request hash | 422 |
| R7 | Response lost after commit, retry | replay | same hold id |
| R8 | Retry of a key whose first attempt got 409 | SAVEPOINT + cached outcome | still 409, even after the slot frees up |
| R9 | Hold expires while the guest types | `now()` check on confirm | 410; seat reusable immediately without the sweeper |
| R10 | Expired but unswept hold | live-seat read path | slot shows as available |
| R11 | Confirm without or with a wrong hold secret | HMAC verify | 404 |
| R12 | Confirm sent twice | replay window | one booking, one notification, same token |
| R13 | Tampered `start_at` (off-grid, outside hours, within notice, past horizon, past) | server re-validation | 422 |
| R14 | Reschedule to a taken slot | txn rollback | original booking intact |
| R15 | Reschedule to an overlapping time of itself | trigger releases then claims | succeeds |
| R16 | Cancel twice / cancel an expired hold | idempotent / state machine | single notification / 409 |
| R17 | Stale zero-seat occupancy after the host edits capacity or buffers | refresh-on-zero | new booking uses new params |
| R18 | Secrets at rest | HMAC-derived, hashes only | scan of `idempotency_keys`, `notifications` and `bookings` finds no plaintext token or secret |
| R19 | Tokens in logs / referrer | redaction, headers, fragment link | captured logs contain no token; header present |
| R20 | One IP grabs all slots | active-hold cap per IP | 4th hold → 429 |
| R21 | Client clock skewed | DB clock only | test |
| R22 | DST gap and overlap days | slot engine | unit tests for NY + Europe/Berlin |
| R23 | Notification sink down | outbox + backoff retries | booking committed, delivered later |
| R24 | Crash mid-transaction | atomic txn (booking + outbox + key) | fault injection: no partial state |
| R25 | Host changes availability after bookings exist | bookings honoured | test |

**Invariant check (runs in `afterEach` of every integration test, and after a randomized test of 500 random ops: hold, confirm, cancel, reschedule, force-expire):**
- *Stored:* for every occupancy, `seats_taken = count(bookings WHERE status IN ('held','confirmed'))`.
- *Live:* after running the sweep, `seats_taken = count(confirmed OR (held AND expires_at > now()))`.
- No two occupancies with `seats_taken > 0` for the same host overlap.

Time travel in tests means setting `expires_at`/`created_at` into the past with SQL. The DB clock is never mocked.

`pnpm test` runs unit and integration tests against a dedicated `slotbook_test` DB from compose, freshly migrated, with tables truncated per test.

---

## 10. Assumptions (also go in the report)

1. **Slot step = event duration.** A 30-min event gives a :00/:30 grid from the window start.
2. **The meeting itself must fit inside the availability window. Buffers may fall outside it.** Buffers only matter against other occupancies.
3. Windows can't cross midnight. Hosts split them.
4. Overrides for a date replace that date's weekly rules entirely.
5. A booking for event type A blocks overlapping slots of event type B for the same host.
6. Group session: guests join the same start until capacity. Buffers apply per session.
7. Availability changes don't affect existing bookings. A live group session keeps its snapshot, and a zero-seat session picks up new params.
8. Hold = 5 min. Confirm replay window = 15 min after confirm. Per-IP active-hold cap = 3. All are config constants.
9. One host per account. The host slug is public.
10. "Next 30 days" is the guest UI default. The event horizon still caps it.
11. Client IP comes from `X-Forwarded-For` only behind a trusted proxy (Fastify `trustProxy` in prod).

---

## 11. Extensions (agreed scope)

1. **Core first**, including the per-IP active-hold cap.
2. Then: **Observability** (pino with request ids, `/health`, `/metrics`: bookings, hold expiries, notification lag), **E2E + CI** (Playwright guest flow, GitHub Actions with a PG service), **Load test** (k6 on hold → confirm, results in the report).
3. Only if the core is fully green: **Daily cap + per-guest limit**, checked under the host lock.
4. If time: full **rate limiting** (`@fastify/rate-limit`).

**Live deployment, after the core:** Render web service (Docker) + Supabase or Neon (to be decided). Use the **direct DB connection, not a transaction pooler**. Start command: migrate → idempotent seed → serve. `APP_SECRET` and the seed password come from Render env.

---

## 12. Delivery plan (small commits, never squashed)

1. `docs/design.md` (this doc)
2. Scaffold: pnpm, TS, Fastify, Vite, Kysely, docker-compose, migrator, seed (demo host + "30-min intro" cap 1 + "Group workshop" 60 min cap 5)
3. Schema migration: tables, enums, constraints, triggers
4. Slot engine (pure) + unit tests incl. DST
5. Secrets module (HMAC derive/verify) + tests
6. Booking service: hold (idempotency, savepoint, IP cap) → confirm → reschedule → cancel, outbox
7. Integration, concurrency and invariant tests (R1–R25)
8. API routes, auth, security headers, log redaction
9. Host dashboard UI
10. Guest booking + manage UI
11. Workers (sweeper, dispatcher) + local webhook receiver
12. README (run, API, 60-sec tour) + AI_LOG.md
13. Extensions: observability → E2E + CI → load test → (daily cap/per-guest) → (rate limiting)
14. Deployment (Render + Supabase/Neon)
15. Report PDF
