# Slotbook: Design Doc

> Status: **v0.3, scope trimmed, awaiting review.** No code until approved.
> Source: take-home brief (Nov 4, 2026). 72h deadline. The core is about 4–5h of work, and extensions come on top.

**Changelog v0.2 → v0.3**
- Workers are multi-instance safe. The outbox dispatcher claims rows with `FOR UPDATE SKIP LOCKED` plus a lease and gives **at-least-once** delivery. The sweeper takes host locks with `SKIP LOCKED` (§3.1).
- The client-clock test is replaced by an **app-server clock skew** test. Service code may not read the JS clock (§5.5).
- A retried reschedule to the same slot is a **pure no-op**: no write, no event, no notification (§5.3).
- Slot engine: host days run from `rangeFrom − 1` to `rangeTo + 1`, with filtering by UTC instant. Slot end = start instant + duration in **real minutes** (§6).
- ISO weekday (1 = Mon … 7 = Sun) with a `CHECK`. Date overrides can't mix a day-off with custom hours, and the DB enforces this with a composite FK (§4).
- The DST example and test use a **NY host and a Berlin guest, Oct 23 – Nov 2, 2026** (5h gap instead of 6h) (§6.1).
- Scope: a new **cut list** (core / if time / known gaps) (§11). Dropped `manage_token_version` and the DB status-guard trigger, so there is one status guard, in the service. Reliability cases are **ranked** and tiered (§9).
- Crash mid-transaction is now defined simply, as a fault-injection point before `COMMIT`, so it stays in core (R13).
- New assumptions: min notice is checked at hold (and reschedule) time only. Existing bookings keep their UTC instants if the host changes time zone (§10).
- `pnpm test` starts its own Postgres (Testcontainers), so it is truly one command (§9.2).

---

## 1. Goals and non-goals

**Goal.** A small Calendly with a booking engine you'd trust with money. **No double booking**, even with:
- concurrent requests (two guests and the last seat)
- network misbehaviour (retries, double-clicks, a lost response after commit)
- clock misbehaviour (skewed app servers, DST)
- user misbehaviour (tampered slot times, expired holds, guessed ids, replayed tokens)

**Priority order:** correctness and reliability first, then the core flows, then tests, README and AI_LOG, then the agreed extensions, then deployment, then the report.

**Non-goals for the core:** calendar sync, payments, real email, multi-host round-robin, polished UI.

---

## 2. Tech stack

| Concern | Choice | Why / alternatives |
|---|---|---|
| Language | TypeScript end to end | Required |
| API | **Fastify** (Node 20+) | Good TS support, with hooks for headers and logging. Alt: Next.js API routes. Rejected because serverless and pooling semantics muddy the transaction and locking story. |
| Frontend | **React + Vite** SPA (react-router) | Fastify serves the built SPA in prod, so there is one service. |
| DB access | **Kysely** + raw **`sql`** for constraints, `FOR UPDATE`, `SKIP LOCKED`, advisory locks, ranges and upserts | Typed without ORM magic. Alt: Prisma, which handles exclusion constraints, ranges and transaction control poorly. Alt: plain `pg`, which is untyped. |
| Migrations | Kysely `Migrator` with a static migration list. Migration bodies are mostly raw `sql`. | Constraints stay visible |
| DB types | **kysely-codegen**, generated from the migrated schema (`pnpm db:types`; a test runs `--verify`) | Types can't drift from the SQL. Alt: hand-written, which drifts silently. |
| Validation | **zod**, shared between API and UI | One schema source |
| Time zones | **Luxon** | Mature DST handling |
| Passwords | **scrypt from `node:crypto`** (N=2^15, r=8, p=3, an OWASP-equivalent minimum) | Seeded email + password. Alt: argon2, which needs a native build (pnpm 12 build approval, Node 26, Alpine). |
| Logging | `pino` with redaction | Base for observability |
| Tests | **Vitest** + **@testcontainers/postgresql** | Real PG, one command |
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
 │   slot engine (pure fn, now = DB now()) ◄── rules + live occ. │
 │                     │                                        │
 │   booking service: one PG transaction per command            │
 │     1. idempotency key claim                                 │
 │     2. per-IP hold cap (advisory xact lock)                  │
 │     3. lock host row (FOR UPDATE)                            │
 │     4. sweep expired holds for host                          │
 │     5. re-validate slot against rules (server-side)          │
 │     6. SAVEPOINT → claim seat (trigger + constraints)        │
 │     7. booking + outbox row + stored response → COMMIT       │
 │                                                              │
 │ background workers (in-process, any number of instances):    │
 │   - hold sweeper      (per host, SKIP LOCKED)                │
 │   - outbox dispatcher (SKIP LOCKED + lease, at-least-once)   │
 └──────────────────────────────┬───────────────────────────────┘
                                ▼
                         Postgres 15+ (source of truth)
```

Workers are optimisations. **Correctness never depends on them running**: reads count live seats, and writes sweep the host's expired holds under the host lock.

### 3.1 Workers (safe with N app instances)

**Hold sweeper** (every 30s):
```sql
-- for each host that has expired holds:
SELECT id FROM hosts WHERE id = $h FOR UPDATE SKIP LOCKED   -- busy host? skip; its booking txn sweeps anyway
UPDATE bookings SET status='expired' WHERE host_id=$h AND status='held' AND expires_at <= now()
```
It follows the same lock order as booking transactions (host row first, then bookings) and never waits on a busy host, so it can't deadlock with them. It also deletes idempotency keys older than 24h.

**Outbox dispatcher** (every 2s; *if time*. In the core the `notifications` table itself is the sink, which the brief allows):
```sql
-- claim (short txn): lease rows so other instances skip them
UPDATE notifications
   SET attempts = attempts + 1, next_attempt_at = now() + interval '60 seconds'   -- lease
 WHERE id IN (SELECT id FROM notifications
               WHERE delivered_at IS NULL AND next_attempt_at <= now() AND attempts < 10
               ORDER BY id LIMIT 10
               FOR UPDATE SKIP LOCKED)
RETURNING *;
-- deliver outside any txn: POST to local webhook receiver, 5s timeout, header X-Notification-Id
-- success → UPDATE SET delivered_at = now()
-- failure → UPDATE SET next_attempt_at = now() + backoff(attempts), last_error = $err
```
- **At-least-once.** A crash after the POST but before `delivered_at` is written means the lease expires and the row is redelivered. Receivers dedupe on `X-Notification-Id`.
- No network I/O happens inside a transaction, so DB locks are never held across a network call.
- Ordering across one booking's events is not guaranteed. The payload carries `occurred_at` and the resulting status, so consumers can drop stale ones.

---

## 4. Data model

All instants are `timestamptz` (UTC). Local availability times are `time` + the host's IANA tz.

```sql
hosts(id uuid, slug UNIQUE, name, email UNIQUE, password_hash, timezone TEXT NOT NULL)
host_sessions(id, host_id, token_hash BYTEA UNIQUE, expires_at)

event_types(
  id, host_id FK, name, slug,
  duration_min      INT CHECK (duration_min BETWEEN 15 AND 120),
  capacity          INT CHECK (capacity >= 1),
  buffer_before_min INT CHECK (buffer_before_min BETWEEN 0 AND 30),
  buffer_after_min  INT CHECK (buffer_after_min  BETWEEN 0 AND 30),
  min_notice_min    INT CHECK (min_notice_min >= 0),
  horizon_days      INT CHECK (horizon_days BETWEEN 1 AND 365),
  active BOOL, UNIQUE(host_id, slug))

availability_rules(id, host_id,
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 1 AND 7),   -- ISO: 1 = Mon … 7 = Sun (= Luxon .weekday)
  start_time TIME, end_time TIME, CHECK (end_time > start_time))

-- One row per overridden date; kind decides whether it is a day off or custom hours.
date_overrides(host_id, date DATE, kind TEXT CHECK (kind IN ('off','custom')),
  PRIMARY KEY (host_id, date), UNIQUE (host_id, date, kind))

-- Windows can only attach to a 'custom' override: the composite FK pins kind = 'custom'.
date_override_windows(id, host_id, date,
  kind TEXT NOT NULL DEFAULT 'custom' CHECK (kind = 'custom'),
  start_time TIME, end_time TIME, CHECK (end_time > start_time),
  FOREIGN KEY (host_id, date, kind) REFERENCES date_overrides(host_id, date, kind) ON DELETE CASCADE)
  -- a 'custom' override with zero windows is rejected by the API (it would mean "off"; use kind='off')

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
  expires_at timestamptz NULL,
  client_ip inet,
  guest_name, guest_email, guest_tz,            -- NULL until confirmed
  manage_token_hash BYTEA UNIQUE NULL,          -- sha256(derived token)
  cancel_reason, cancelled_by ('host'|'guest'),
  created_at, confirmed_at, cancelled_at)

booking_events(id, booking_id, type, from_status, to_status, payload jsonb, at)

idempotency_keys(scope, key, request_hash BYTEA, response_status INT NULL, response_body jsonb NULL,
  created_at, PRIMARY KEY (scope, key))          -- never contains secrets

notifications(id, booking_id, type, payload jsonb, created_at,     -- outbox = the sink
  attempts INT DEFAULT 0, next_attempt_at DEFAULT now(), delivered_at, last_error)   -- never contains tokens
```

Overlapping windows within a weekday or date are **rejected by the DB**. A custom range type `timerange` (over `time`) is used in exclusion constraints on `availability_rules (host_id, weekday, timerange(start,end))` and `date_override_windows (host_id, date, timerange(start,end))`. Touching windows (09–12, 12–17) are allowed.

**Also enforced by the schema (Phase 2):**
- **Host consistency.** `bookings (event_type_id, host_id)` and `occupancies (event_type_id, host_id)` reference `event_types (id, host_id)`, and `bookings (occupancy_id, host_id)` references `occupancies (id, host_id)`. A row can't point at another host's data.
- **Data shape per status.** These CHECKs say which columns each status needs, not which transitions are allowed:
  - `held` needs `expires_at`
  - `confirmed` needs the guest name, email, `manage_token_hash` and `confirmed_at`
  - `cancelled` needs `cancelled_at` and `cancelled_by`
- **Bookings are append-only.** A `BEFORE DELETE` trigger raises `restrict_violation` (23001), so a delete can't bypass the seat counter. Use cancel or expire instead. `TRUNCATE` is not a row event, and the tests truncate bookings and occupancies together.
- **`occupancies.blocked` must cover the meeting** (`blocked @> tstzrange(start_at, end_at)`).
- **Calendar dates** (`date_overrides.date`) are returned by pg as `'YYYY-MM-DD'` strings, never as a JS `Date` at the server's local midnight.

### 4.1 `seats_taken` is maintained by a trigger
`AFTER INSERT OR UPDATE OF status, occupancy_id ON bookings`:
- `active(row) := row.status IN ('held','confirmed')`
- If OLD was active on occupancy A, decrement A. Then, if NEW is active on occupancy B, increment B. The decrement comes first, so a reschedule that moves to an overlapping time works.
- The increment fires the `CHECK` and the `EXCLUDE`. A violation raises 23514 or 23P01, and the service maps it to 409.

Besides the delete block, this is the only trigger. **The status guard lives in one place**, the service's `transition(from, to)` table, used by every write path. The sweeper's SQL only ever does `held → expired`, via `WHERE status='held'`.

### 4.2 Deactivate, never delete
Bookings can't be deleted (append-only), so nothing they depend on may disappear either:
- **Event types** are deactivated (`active = false`). The public page and slot API return 404, and no new holds are possible. Existing bookings keep working: manage links, cancel, and reschedule to *another active* event type's slot is out of scope.
- **Hosts** are deactivated (`hosts.active = false`, added in migration 0003). Their public pages return 404, login is refused, and existing bookings stay valid.
- **No foreign key cascades into `bookings`.** Every FK on `bookings`, `occupancies` and `event_types` is `NO ACTION`, so deleting a parent that bookings depend on fails. Checked in the catalog on 2026-11-09:

  | Parent → child | ON DELETE |
  |---|---|
  | hosts → host_sessions, availability_rules, date_overrides | CASCADE (config only, no booking data) |
  | date_overrides → date_override_windows | CASCADE |
  | hosts → event_types · event_types → occupancies, bookings · occupancies → bookings · bookings → booking_events, notifications | NO ACTION |

  A catalog test (Phase 3, step 0) asserts this, so a future migration can't add a cascade towards bookings unnoticed. `DELETE` on `hosts` and `event_types` is also blocked by triggers, the same way as for bookings, so deactivation is the only path.

### 4.3 Why `occupancies`?
Capacity >1 means bookings legitimately share one time, so an exclusion constraint on `bookings` only works for 1:1. Grouping seats lets Postgres enforce **no overlap** (across event types, buffers included) and **no overbooking**.

---

## 5. Booking engine: the critical path

### 5.0 Secrets: derived, never stored in plaintext
```
hold_secret  = b64url(HMAC-SHA256(APP_SECRET, "hold:v1:"   || booking_id))
manage_token = b64url(HMAC-SHA256(APP_SECRET, "manage:v1:" || booking_id))
```
- The hold secret is never stored. It is verified by re-deriving it and comparing in constant time.
- Only `sha256(manage_token)` is stored, for lookup.
- Replays, confirm retries and the dispatcher re-derive secrets. `idempotency_keys` and `notifications` never contain them.
- Threat model: a DB dump alone gives nothing usable. The DB plus `APP_SECRET` does, which is the same trust level as the app server.
- Token revocation and rotation are **known gaps**. `manage_token_version` was dropped because nothing used it.

### 5.1 Hold: `POST /api/holds` (`Idempotency-Key` required)
Body `{host, slug, start_at}` → `201 {hold_id, hold_secret, expires_at, server_now, start_at, end_at}`. The `start_at` and `end_at` are the session's, which may be a live group session's snapshot. Implemented in `src/server/services/holds.ts`.
```
0. Validate the body and the key format (8–128 chars) → 400, before any txn, not cached.
BEGIN
1. INSERT idempotency_keys(scope='hold', key, request_hash) ON CONFLICT DO NOTHING RETURNING.
   - Conflict (a concurrent duplicate blocks on the PK until the first txn ends):
       hash differs    → 422 IDEMPOTENCY_KEY_REUSED (not stored)
       stored response → replay (re-derive hold_secret if it was a 201)
     ROLLBACK and return.
2. pg_advisory_xact_lock(1, hashtext(client_ip))            -- IP lock
3. SELECT ... FROM hosts WHERE id = $host FOR UPDATE         -- host lock
   T := (SELECT clock_timestamp())                           -- read the clock ONCE, after all locks
4. live holds for the IP (expires_at > T) ≥ 3 → ROLLBACK → 429, not cached.
5. Sweep: held AND expires_at <= T → expired (the trigger frees seats).
6. Re-validate start_at against the host's RULES with the engine (now = T, existing sessions
   ignored, so a taken slot surfaces as 409 from the constraints, not as 422) → 422 SLOT_NOT_OFFERED.
7. SAVEPOINT claim
     upsert occupancy with refresh-on-zero:
       INSERT ... ON CONFLICT (event_type_id, start_at) DO UPDATE
         SET capacity = EXCLUDED.capacity, end_at = EXCLUDED.end_at, blocked = EXCLUDED.blocked
         WHERE occupancies.seats_taken = 0
       (no row returned → a live session: reuse its snapshot via SELECT id)
     INSERT booking(status='held', expires_at = T + interval '5 min', client_ip)  -- trigger: seats + 1
   23P01 / 23514 → ROLLBACK TO SAVEPOINT claim; outcome = 409 SLOT_UNAVAILABLE
8. UPDATE idempotency_keys SET response_status, response_body (no secret)
COMMIT
```
**Lock order.** Every path takes locks in this global order and may skip steps, but never goes backwards:

```
idempotency key row → IP advisory lock → host row (FOR UPDATE) → booking rows → occupancy rows (via trigger)
```

| Path | Key | IP | Host | Booking | Occupancy |
|---|---|---|---|---|---|
| Hold | ✓ | ✓ | ✓ | sweep + insert | trigger |
| Confirm | – | – | ✓ | `FOR UPDATE` | trigger (on expire) |
| Reschedule | – | – | ✓ | `FOR UPDATE` | trigger (old, then new) |
| Cancel (guest/host) | – | – | ✓ | `FOR UPDATE` | trigger |
| Sweeper | – | – | ✓ `SKIP LOCKED` | update | trigger |
| Host edits (event types, availability, overrides, timezone, deactivation) | – | – | ✓ | – | – |

**Host-side edits take the same host lock** (agreed after Phase 4). Every write a host makes to its event types, availability, overrides, timezone or `active` flag runs in a transaction that first takes `SELECT … FROM hosts WHERE id = $host FOR UPDATE`. A hold or reschedule, which re-reads the event type and rules under that lock, therefore never sees a half-applied edit, and an edit never interleaves with a claim.

Why it can't deadlock:
- **Every writer of a host's bookings and occupancies holds that host's row lock first**, so at most one writer per host is past step 3 at a time. Booking and occupancy locks are taken only by that one writer. The R4 test bypasses this on purpose, and there the constraints are the guard.
- A transaction locks **one host only**, so there is no host-to-host cycle.
- **Only the hold path takes the IP lock**, and it takes it *before* the host lock. Nothing that holds a host lock ever waits for an IP lock.
- A concurrent duplicate idempotency key waits on the key row *before* taking any other lock. The transaction it waits for never needs a lock the waiter holds.
- The sweeper never waits: `SKIP LOCKED` on the host row.

**Idempotency caching:** 201 / 409 / 422 `SLOT_NOT_OFFERED` are cached; they are terminal answers for this intent. 400 / 404 / 422 key-reused / 429 / 5xx are not cached. A 5xx rolls back the key row, so a retry re-executes. A replayed 201 re-derives `hold_secret` and carries the **current** `server_now`, so the countdown stays right; the stored body has neither. The request hash normalises `start_at` to UTC, so the same instant written with a different offset counts as the same request.

**Why the host lock is the primary guard (Phase 4 finding).** With the lock bypassed (R4), parallel claims on *different but overlapping* sessions each wait on the other's uncommitted row inside the exclusion check, and Postgres aborts one as a deadlock victim (40P01) after `deadlock_timeout`. There is still never a double booking, but it is slow (seconds) and the errors are noisy. Holding the host lock first serialises claims per host, so the exclusion check never races.

**Client IP:** IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is normalised to IPv4 before the cap and storage.

**Refresh-on-zero (one rule):** *when a claim reuses an occupancy that has 0 seats, its capacity, end and buffers are overwritten from the current event type. A session with ≥1 seat keeps its snapshot.*

### 5.2 Confirm: `POST /api/holds/{id}/confirm`
Body `{hold_secret, name, email, tz}`. A wrong secret gives **404**, the same as an unknown id. Then lock the host and the booking:
- `held`, not expired → `confirmed`, `manage_token_hash`, event, outbox `booking.confirmed` → `200 {booking, manage_token}`.
- `held`, expired → `expired` → **410 HOLD_EXPIRED**.
- `confirmed`, same guest details, `now() < confirmed_at + 15 min` → replay 200 with the re-derived token. No new notification.
- `confirmed` otherwise → 409 ALREADY_CONFIRMED. `expired` → 410. `cancelled` → 409.

Min notice is **not** re-checked at confirm (§10).

### 5.3 Reschedule: `POST /api/bookings/{token}/reschedule` `{start_at}`
Txn: look up by `sha256(token)` and lock the host.
- **If the booking is already `confirmed` at `start_at`, it is a pure no-op:** return 200 with the current booking. There is no UPDATE, no `booking_events` row and no notification. This is how a retried or double-clicked reschedule behaves.
- Otherwise: sweep, re-validate the new slot (including min notice), upsert the occupancy, then `UPDATE bookings SET occupancy_id, start_at, end_at`. The trigger releases the old seat and then claims the new one. A violation rolls back the whole txn → 409, and the original stays intact. On success: event + outbox `booking.rescheduled`. The token is unchanged.

### 5.4 Cancel
Guest: `POST /api/bookings/{token}/cancel` `{reason?}`. Host: `POST /api/host/bookings/{id}/cancel` `{reason}`.
`confirmed → cancelled` (the trigger frees the seat) → outbox `booking.cancelled`. If already cancelled → 200 with no write and no notification.

### 5.5 Clock policy
- **The database is the only clock** for expiry, min notice, horizon, "upcoming" and the slot engine's `now`.
- **Write paths read the clock once, after acquiring their locks.** They run `T := clock_timestamp()` as a separate statement right after the host lock (and the booking row lock, where taken), and use `T` for the sweep, `expires_at`, every expiry check, the IP-cap count and the engine's `now`. They never use `now()`, which is the transaction's *start* time.
  - Why: under contention a transaction can wait seconds for the host lock, and `now()` would then be stale. Example: an old hold expires at T₀+1 s, and a new hold's transaction starts at T₀ and waits 2 s for the lock. With `now()` = T₀ the sweep misses the expired hold, and the guest gets a wrong 409. In confirm, the same bug would accept a hold that expired during the wait.
  - Test: `holds-clock.test.ts` blocks the host lock until an existing hold has expired, and asserts the waiting hold gets 201.
  - This was caught in review of the Phase 4 plan; the plan had wrongly called the stale `now()` "consistent".
- The read path (`GET …/slots`) takes no locks, so `now()` of its read-only snapshot is fine there.
- **Service and engine code never read the JS clock.** An ESLint `no-restricted-syntax` rule bans `Date.now()` and argument-less `new Date()` under `src/server/{services,engine}`. The only exceptions are logging and metrics.
- The client never sends its clock. The UI countdown uses `expires_at − server_now` from the response.
- **No time-zone math in SQL.** No `AT TIME ZONE`, `timezone()`, `::date` on a timestamptz, `date_trunc` or `extract` on local time, and Postgres's tz database is never consulted for host or guest zones. SQL compares UTC instants only. All wall-clock and zone math happens in Luxon (one tz database, Node's ICU). A unit test scans `src/` for these constructs.
- Proof: R14 skews the **app server** clock and shows that nothing changes.

### 5.6 State machine
```
held ──confirm──► confirmed ──cancel──► cancelled
  └──timeout──► expired          (reschedule: confirmed → confirmed, new time)
```
Enforced once, by the service's `transition()` table (§4.1).

### 5.7 Token hygiene
- Global `Referrer-Policy: no-referrer`. `Cache-Control: no-store` on token-bearing responses.
- The manage link is **`/manage#<token>`**, with the token in the URL fragment, which is never sent to the server.
- The pino serializer rewrites `/api/bookings/<token>` to `/api/bookings/:token`. `redact` covers `cookie`, `authorization`, `idempotency-key`, `hold_secret` and `manage_token`.
- Known gap: infra access logs see the API path. The next step would be to accept the token in an `Authorization` header.

---

### 5.8 Contention, `lock_timeout` and pool sizing
- **Every write path starts with `SET LOCAL lock_timeout = 2.5 s`**, implemented as `set_config('lock_timeout', '2500ms', true)` so it is transaction-local and parameterisable. Any lock wait longer than that (idempotency-key row, IP advisory lock, host row, booking row) raises `55P03`. The transaction rolls back and the API answers **503 `HOST_BUSY`** with `Retry-After: 1`. Nothing is stored for the idempotency key, so a same-key retry later is safe.
- **Why:** each request waiting on a host lock holds a pooled connection for the whole wait. Without a bound, a burst of more than `DB_POOL_MAX` requests for one popular host would take every connection, and requests for *other* hosts would queue behind it. The timeout turns that into a fast, retryable 503 for the busy host only.
- **Pool sizing:** throughput per host is bounded by about 1 / (hold-transaction time), a few milliseconds. Connections a burst can tie up ≈ min(burst size, `DB_POOL_MAX`), each for at most `lock_timeout`. Defaults: `DB_POOL_MAX = 10`, `lock_timeout = 2.5 s`. Postgres `max_connections` must exceed `DB_POOL_MAX` × app instances, plus admin headroom.
- **Measured in the load test** (if-time list, §11): throughput and p95 for a single-host burst versus spread across hosts, the 503 rate, and whether a single-host burst raises p95 for other hosts. Results go in the report.
- **Known gap:** there is no per-host in-process queue in front of the pool, so a burst still briefly uses up to `DB_POOL_MAX` connections, bounded by `lock_timeout`.

## 6. Slot generation and time zones

Pure function `generateSlots(query) → Slot[]` in `src/server/engine/slots.ts`. The hold and reschedule paths re-validate with `findOfferedSlot(input, startAt)`, which runs the same code over `[startAt, startAt + 1 ms)`. Inputs come from `loadAvailabilityInput(trx, …)` (`src/server/db/slot-inputs.ts`), which reads `now()` and the live seats in the caller's transaction.

```
input: hostTz, weeklyRules, overrides, eventType, liveOccupancies, now (from DB),
       rangeFrom, rangeTo (UTC instants)

dFirst = localDate(rangeFrom, hostTz) − 1 day       # pad: a guest day can span two host days
dLast  = localDate(rangeTo,   hostTz) + 1 day
for each host-local date D in [dFirst, dLast]:
   windows = overrides[D] (off → none, custom → its windows) ?? weeklyRules[isoWeekday(D)]
   for each window:
      ws = toInstant(D, window.start, hostTz, 'earlier')   # gap → shifted forward
      we = toInstant(D, window.end,   hostTz, 'earlier')   # overlap → first occurrence (see below)
      for (s = ws; s + duration <= we; s += duration)    # REAL minutes (UTC arithmetic)
          e = s + duration                                # end = start instant + duration
          keep iff rangeFrom <= s < rangeTo              # filter by UTC instant, not by date
               and s >= now + min_notice and s <= now + horizon
               and [s − buf_before, e + buf_after) overlaps no live occupancy of the host,
                   except the same event type + same start with live seats < capacity (→ seatsLeft)
```

- On normal days, real-minute stepping produces exactly the wall-clock grid (09:00, 09:30…).
- **Ambiguous boundaries (fall back).** Luxon resolves an ambiguous local time to the **later** offset by default (verified with Luxon 3.7: NY 01:30 on Nov 1 2026 → EST). Design v0.3 wrongly said "earlier". The engine resolves explicitly with `DateTime#getPossibleOffsets()`, and **both window boundaries take the first occurrence** (decided after Phase 3 review). This is the shorter reading, so it never offers time the host didn't mean. On NY's Nov 1 2026:
  - A window **ending** at 01:30 ends at 01:30 EDT, so neither 01:30 EDT nor 01:00 EST is offered.
  - A window **starting** at 01:00 starts at 01:00 EDT. Luxon's default would silently drop that first hour.
  - A window spanning the whole repeated hour, like 00:00–03:00, still offers **both** 01:00 EDT and 01:00 EST. The grid steps in real minutes, and both instants really are inside the host's stated window.
- **Non-existent boundaries (spring forward):** shifted forward (Luxon default). A window 02:30–05:00 on Mar 8 2026 (NY) starts at 03:30 EDT.
- **Horizon** = `now + horizon_days × 24h` (real time). **Min notice** = `now + min_notice_min`. Both use the DB `now` passed in.
- On DST days the window is measured in real time. A 01:00–04:00 window on spring-forward night is 2 real hours, so there are no phantom slots. A 00:00–03:00 window on fall-back night is 4 real hours, and both 01:00 EDT and 01:00 EST are offered. Labels include the offset.
- **Live occupancy read** (no sweeper and no `seats_taken`):
  ```sql
  SELECT o.*, count(b.id) FILTER (WHERE b.status='confirmed'
                                  OR (b.status='held' AND b.expires_at > now())) AS live_seats
  FROM occupancies o LEFT JOIN bookings b ON b.occupancy_id = o.id
  WHERE o.host_id = $1 AND o.blocked && tstzrange($from, $to)
  GROUP BY o.id HAVING count(...) > 0
  ```
- The API returns UTC ISO plus a `local` label in the requested `tz`. The UI groups by day in the guest's tz. `tz` values are validated against `Intl.supportedValuesOf('timeZone')`.

### 6.1 Worked DST example (also the R12 test)
Host in **America/New_York**, Mon–Fri 09:00–17:00. Guest in **Europe/Berlin**.
Europe ends DST on **Sun Oct 25 2026**. The US ends DST on **Sun Nov 1 2026**. For one week the gap is 5h instead of 6h.

| Host day | NY 09:00 | UTC | Berlin shows | Gap |
|---|---|---|---|---|
| Fri Oct 23 | EDT (−4) | 13:00Z | **15:00** CEST (+2) | 6h |
| Mon Oct 26 | EDT (−4) | 13:00Z | **14:00** CET (+1) | **5h** |
| Mon Nov 2 | EST (−5) | 14:00Z | **15:00** CET (+1) | 6h |

The host's grid never moves. The guest's view shifts twice, in opposite directions. A "fixed offset" implementation gets the middle row wrong.

**Cross-day case (also in R12):** the host adds a custom window 18:00–21:00 NY on Mon Oct 26. The guest asks for Berlin day Tue Oct 27 (`[Oct 26 23:00Z, Oct 27 23:00Z)`). They must see 00:00–02:00 Berlin, which comes from the *host's Monday*. This is guaranteed by iterating **host** days from `localDate(from, hostTz)` to `localDate(to, hostTz)` and filtering by UTC instant. Windows never cross local midnight, so a slot starting in `[from, to)` always falls on one of those host days. The extra ±1 day of padding is defence in depth, not what makes the case work. Phase 3 found that removing it does not break this test (see `docs/phases/phase-3.md`). The bug the padding guards against is iterating *guest* days, or converting the range to dates in the wrong zone.

---

## 7. API (documented in README; errors are `{error:{code,message}}`)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/hosts/{host}/events/{slug}` | public event info |
| GET | `/api/hosts/{host}/events/{slug}/slots?from&to&tz` | max 31-day range; returns `seatsLeft` |
| POST | `/api/holds` | `Idempotency-Key` → `{hold_id, hold_secret, expires_at, server_now}` |
| POST | `/api/holds/{id}/confirm` | `{hold_secret, name, email, tz}` → `{booking, manage_token}` |
| GET | `/api/bookings/{token}` | view |
| POST | `/api/bookings/{token}/reschedule` | `{start_at}` |
| POST | `/api/bookings/{token}/cancel` | `{reason?}` |
| POST | `/api/auth/login`, `/api/auth/logout`; GET `/api/me` | httpOnly SameSite=Lax cookie |
| GET/PUT | `/api/host/settings` | timezone |
| CRUD | `/api/host/event-types` | |
| GET/PUT | `/api/host/availability` | weekly rules + overrides (replace-all) |
| GET | `/api/host/bookings?upcoming=1` | |
| POST | `/api/host/bookings/{id}/cancel` | `{reason}` required |
| GET | `/api/host/notifications` | the sink (no tokens) |
| GET | `/health` | DB ping |

Codes: 400 · 401/403 · 404 · 409 `SLOT_UNAVAILABLE` / `ALREADY_CONFIRMED` / `INVALID_STATE` · 410 `HOLD_EXPIRED` · 422 `SLOT_NOT_OFFERED` / `IDEMPOTENCY_KEY_REUSED` · 429 `HOLD_LIMIT` · 503 `HOST_BUSY` (lock_timeout; `Retry-After: 1`).

---

## 8. Frontend pages

- `/login`: seeded host (`demo@slotbook.dev`, password from env, default `demo1234`)
- `/dashboard`: upcoming bookings (cancel with a reason), notifications log
- `/dashboard/event-types`: list, create, edit
- `/dashboard/availability`: tz, weekly windows, date overrides (off / custom)
- `/{host}/{slug}`: tz switcher (defaults to the browser tz), followed by days → slots → hold (countdown) → form → confirmation + manage link
- `/manage#<token>`: view, reschedule, cancel

One Idempotency-Key per slot click, reused on retries. The hold secret is kept in memory only.

---

## 9. Reliability matrix: ranked

Ranked by "how bad if wrong × how likely". **Core** cases each get a named integration or unit test. The `v0.2` column maps to the previous numbering.

| Rank | Failure case | Handling | Test asserts | Tier | v0.2 |
|---|---|---|---|---|---|
| R1 | 50 parallel holds, last seat (cap 1) | host lock + exclusion | exactly 1 × 201, 49 × 409 | core | R1 |
| R2 | Group cap N, 3N parallel holds | `CHECK seats_taken <= capacity` | exactly N succeed | core | R2 |
| R3 | Parallel holds on overlapping event types / buffers | exclusion on `blocked` | 1 succeeds | core | R3 |
| R4 | Lock bypassed (parallel direct SQL claims) | constraints + trigger alone | no double booking | core | R4 |
| R5 | Retry / double-click / lost response, same key (also concurrent) | PK on key + stored response | one hold, identical bodies, same secret | core | R5+R7 |
| R6 | Hold expires while the guest types | `now()` check on confirm | 410; seat reusable at once, sweeper off | core | R9 |
| R7 | Expired but unswept hold | live-seat read | slot shown available, sweeper off | core | R10 |
| R8 | Tampered `start_at` (off-grid, outside window, within notice, past horizon, past) | server re-validation | 422 each | core | R13 |
| R9 | Confirm with a missing or wrong hold secret | HMAC verify | 404 | core | R11 |
| R10 | Reschedule to a taken slot | txn rollback | 409; original row and seat unchanged | core | R14 |
| R11 | Seat-count drift | trigger | **invariant check in `afterEach`** (stored + live + no overlap) | core | new |
| R12 | DST and cross-day range | instant-based engine | NY host / Berlin guest table from §6.1 + cross-day case | core | R22 |
| R13 | Crash before commit | atomic txn | fault point `beforeCommit` throws → no booking, seat, key or outbox row; same-key retry → 201 | core | R24 |
| R14 | App server clock skewed (±1 year) | DB clock only | with `vi.setSystemTime` skewed: slots, hold, expiry and confirm results equal the unskewed run | core | R21 (replaced) |
| R15 | Confirm sent twice | replay window | same booking + token, 1 notification | core | R12 |
| R16 | Reschedule retried to the same slot | pure no-op | 2nd call: 200, no event, still 1 notification | core | new |
| R17 | Cancel twice | idempotent | 1 notification | core | R16 |
| R18 | Same key, different body | request hash | 422 | core | R6 |
| R19 | Same-key retry after a cached 409, slot since freed | SAVEPOINT + cached outcome | still 409 | core | R8 |
| R20 | Secrets at rest | HMAC derive, hashes only | scan of `idempotency_keys`, `notifications`, `bookings` finds no plaintext | core | R18 |
| R21 | Tokens in logs / referrer | redaction + headers + fragment | captured logs contain no token; header set | core | R19 |
| R22 | One IP grabs every slot | per-IP active-hold cap | 4th → 429 | core | R20 |
| R23 | Zero-seat occupancy reused after an event-type edit | refresh-on-zero rule | hold → cancel → capacity 1→3 → 3 holds succeed | core | R17 |
| R24 | Reschedule to an overlapping time of itself | trigger: release then claim | 200 | if time | R15 |
| R25 | Random op sequences | invariant | 500 random hold/confirm/cancel/reschedule/force-expire ops, invariant holds | if time | new |
| R26 | Sink down / two dispatchers | outbox, SKIP LOCKED, lease | webhook 500 → retried later; 2 dispatchers → each row delivered once in the happy path | if time | R23 |
| R27 | Host edits availability or tz after bookings exist | bookings keep UTC instants | booking unchanged | if time | R25 |

"Force-expire" and "time travel" mean moving `expires_at` and `created_at` into the past with SQL. The DB clock is never mocked.

### 9.1 Invariant check (R11)
- *Stored:* for every occupancy, `seats_taken = count(bookings WHERE status IN ('held','confirmed'))`.
- *Live:* after a sweep, `seats_taken = count(confirmed OR (held AND expires_at > now()))`.
- *No overlap:* no two occupancies with `seats_taken > 0` for the same host overlap.

### 9.2 One-command tests
`pnpm test` runs Vitest. Its `globalSetup`:
1. If `TEST_DATABASE_URL` is set (CI service container or a local PG), use it.
2. Otherwise start `postgres:16-alpine` via **@testcontainers/postgresql** on a random port. This needs only Docker and doesn't clash with the dev DB.
3. Run the migrations and export the URL. Teardown stops the container.

Integration tests truncate tables per test. The concurrency tests use a pool of at least 60 connections.

---

## 10. Assumptions (also go in the report)

1. **Slot step = event duration.**
2. **The meeting must fit inside the availability window. Buffers may fall outside it** and only matter against other occupancies.
3. **Slot end = start instant + duration in real minutes.** On DST nights, windows are measured in real time (§6). An ambiguous window boundary (fall-back night) means its **first occurrence**.
3a. **Horizon = `now + horizon_days × 24 h`** of real time, inclusive. Across a DST change this differs by an hour from "the same clock time N days later". That is accepted. Min notice is inclusive too (`start ≥ now + notice`).
3b. **Zone labels** come from Luxon/ICU in `en-US`. US zones get letter abbreviations (`EDT`/`EST`), and most others render as `GMT±n` (Berlin: `GMT+2`/`GMT+1`). That is accepted for labelling duplicate fall-back slots.
4. Windows can't cross midnight, but a window may end at `24:00` ("until midnight"). A date override is either a day off or custom hours, never both, and it replaces that date's weekly rules.
5. A booking for event type A blocks overlapping slots of event type B for the same host.
6. Group sessions: guests join the same start until capacity. Buffers apply per session.
7. **Min notice is checked at hold time only** (and at reschedule, which is a new claim). A hold made just inside the notice limit can still be confirmed within its 5 minutes.
8. **If the host changes time zone, existing bookings keep their UTC instants.** Only future slot generation uses the new tz. The same applies to availability edits.
9. Hold = 5 min. Confirm replay window = 15 min. Per-IP active-hold cap = 3. All are config constants.
10. One host per account. The host slug is public. "Next 30 days" is the guest UI default, capped by the horizon.
11. **Client IP and `TRUST_PROXY`.** `client_ip` is Fastify's `request.ip`, controlled by the `TRUST_PROXY` env var:
    - `false` (default, local and compose): `X-Forwarded-For` is ignored, and the IP is the socket peer.
    - `1` on Render (exactly one proxy hop): the proxy is trusted, and the client is the address it appended to `X-Forwarded-For`. Any addresses a client prepends itself are ignored.
    - `true` (trust every hop) is **rejected by config validation**. It would let any client spoof `X-Forwarded-For` and bypass the per-IP hold cap.

    Tested in `test/unit/trust-proxy.test.ts`, including a spoofed-header case.

---

## 11. Scope cut list

**Core (the ~4–5h budget; must be green before anything else):**
- Schema: tables, constraints, seats trigger. Migrator, seed, compose.
- Slot engine + DST tests.
- Hold (idempotency + SAVEPOINT + per-IP cap), confirm (hold secret), reschedule, cancel.
- Derived secrets, the outbox *table* as the sink.
- Inline per-host sweep in write txns, plus the tiny sweeper interval.
- Auth (seeded login), security headers, log redaction.
- Minimal host dashboard, guest page, manage page.
- Tests R1–R23, invariant in `afterEach`, `pnpm test` one command.
- README (run, API, 60-sec tour) + AI_LOG.md.

**If time (in this order):**
1. Outbox dispatcher → local webhook receiver (SKIP LOCKED, at-least-once) + R26
2. R24, R25, R27
3. Observability: request ids, `/metrics` (bookings, hold expiries, notification lag)
4. E2E (Playwright guest flow) + GitHub Actions CI
5. Load test (k6, hold → confirm)
6. Deployment: Render + Supabase/Neon, direct connection (not a transaction pooler), seeded demo host
7. Daily cap + per-guest limit, only if the core is fully green
8. Full rate limiting (`@fastify/rate-limit`)

**Known gaps (documented, not built):**
- Manage-token revocation and rotation, and `APP_SECRET` key rotation.
- The token is visible in infra access logs via the API path (fix: an `Authorization` header).
- Windows crossing midnight. Per-event custom slot intervals.
- No ordering guarantee for notifications. Consumers must dedupe and order by `occurred_at`.
- Real email and calendar sync (out of scope per the brief).
- **No purge job.** Bookings are append-only, so expired holds stay as rows forever. A deliberate admin archive/purge job (run outside the app role, with the delete trigger disabled for that session) is a next step.

---

## 12. Delivery plan (small commits, never squashed)

1. `docs/design.md`
2. Scaffold: pnpm, TS, Fastify, Vite, Kysely, compose, migrator, seed (demo host + "30-min intro" cap 1 + "Group workshop" 60 min cap 5), Vitest + Testcontainers global setup
3. Schema migration: tables, constraints, seats trigger
4. Slot engine + unit tests (R12)
5. Secrets module + tests
6. Booking service: hold → confirm → reschedule → cancel, outbox rows, `transition()`
7. Integration, concurrency and invariant tests (R1–R23)
8. API routes, auth, headers, log redaction, ESLint clock rule
9. Host dashboard UI
10. Guest booking + manage UI
11. Sweeper interval
12. README + AI_LOG.md
13. If-time list (§11), in order
14. Report PDF
