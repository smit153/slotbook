# Phase 5: Confirm, cancel, reschedule, release, outbox, sweeper

**Status:** done. All checks green (3 consecutive full runs). Waiting for review before Phase 6.

Also covers the follow-up after Phase 4: `SET LOCAL lock_timeout` → 503 (`cc3a0e1`), and design §5.8 on pool sizing.

## Planned vs. actual

| Planned (+ your Phase 5 changes) | Actual |
|---|---|
| Transition table + manage tokens | ✅ `transitions.ts` is the single status guard. Every service asks it before changing a status. |
| **(your change) 40P01/40001 → one retry, then 503, never a raw 500** | ✅ `writeTx()` wraps every write path: lock timeout → 503 `HOST_BUSY`; deadlock or serialization failure → re-run once → 503 `TRY_AGAIN`; anything else propagates. Tested with fault hooks, including a failure thrown just before COMMIT. |
| **(your change) Hold release** | ✅ `releaseHold()`: held → expired with the hold secret, idempotent. **Your test passes:** hold 3, release 1, a 4th hold from the same IP gets 201. |
| Confirm | ✅ Per design §5.2. Replay matches trimmed name + case-insensitive email within 15 minutes. |
| Cancel (guest + host) | ✅ **(your change)** The `booking.cancelled` payload includes `cancelled_by` and `reason`. |
| **(your change) Started bookings frozen for guest AND host** | ✅ 409 `BOOKING_STARTED` on cancel and reschedule. No-show tracking added to known gaps. |
| Reschedule (same event type) | ✅ Retrying to the same slot is a pure no-op. Moves happen inside `SAVEPOINT move`, so a taken target leaves the original untouched. |
| Outbox | ✅ Notification rows are written in the same transaction as the state change: confirmed, rescheduled (with the previous times), cancelled (with who and why). No token ever goes in a payload. |
| Sweeper | ✅ Per host with `SKIP LOCKED`, plus a 24 h key purge. Started with the server and stopped on shutdown. |
| R14 full, R20 full, R27, lock_timeout on every path | ✅ `cross-cutting.test.ts`. |
| R25 (randomized) | Left on the "if time" list, as you decided. |

## What worked
- **Your stale-clock prediction for confirm was right**, and the fix holds. A hold that expires while confirm waits for the host lock now gets **410**. **Mutation check:** with `T := now()`, confirm *accepts* the expired hold (`expected 200 to be 410`).
- **Exactly-once notifications under concurrency:**
  - 5 concurrent confirms → 5 × 200, one token, **1** `booking.confirmed`
  - 3 guest + 2 host cancels racing → 5 × 200, **1** `booking.cancelled`
  - a retried reschedule → **1** `booking.rescheduled`
- **R14 across a whole journey.** The sequence hold → confirm → reschedule → cancel → late confirm gives `[201, 200, 200, 200, 410]` with a 5-minute TTL, and exactly the same result with the process clock skewed **+1 year or −1 year**.
- **R20 after a full lifecycle:** neither the hold secret nor the manage token appears in `bookings`, `idempotency_keys`, `notifications`, `booking_events` or `occupancies`.
- **Sweeper:** a busy host is skipped in under 1 s without waiting, then swept on the next run. Two sweepers running at once expire each of 12 holds exactly once.
- **Every new write path returns 503 `HOST_BUSY`** behind a held host lock and changes nothing: confirm, release, reschedule, guest cancel, host cancel.

## What didn't, and the bugs found
1. **`Intl.supportedValuesOf('timeZone')` doesn't contain `Asia/Kolkata` (the brief's own example) or `UTC`** on this Node 26/ICU build. It does contain the old alias `Asia/Calcutta`. Strict membership, which you asked for in Phase 6, would reject the brief's example host time zone. **For guests (Phase 5)** I validate with `Intl.DateTimeFormat`, which accepts aliases, because browsers report names like `Asia/Calcutta`. **For hosts (Phase 6)** this needs your decision; see open question 1.
2. **The email schema rejected `"  Ada@Example.TEST "`.** `z.email()` validated before my trim ran. **Fix:** `z.string().trim().toLowerCase().pipe(z.email())`. Caught by the confirm happy-path test.
3. **The lock-timeout test hung** before the implementation existed, as expected: its first case blocks forever without a timeout. I stopped the run; no containers were left behind. Noted because a red test that hangs is worse than one that fails, but it was the honest first run.
4. A misnamed variable in the sweeper test (`events` actually held sessions). Fixed before committing.

## Design decisions made while building (now in `docs/design.md`)
- **Release writes no notification.** The host never saw the hold, so nothing changed from their point of view. It does write a `released` audit event.
- **A retried reschedule to the booking's current slot returns 200 even after it has started.** The no-op check runs before the started check, because a pure retry should never fail.
- **Sweeper expiries write no audit event per hold**, to keep the bulk update cheap. Expiries via confirm (410) and via release are audited. See open question 2.
- **The confirm replay ignores `tz`**, matching only name and email, as agreed.

## Test results
```
pnpm test → Test Files 39 passed (39) · Tests 309 passed (309) · ~53 s · 3 consecutive green runs
  unit        135  (+ transitions 6, manage tokens 3)
  integration 174  confirm 12 · cancel 9 · reschedule 9 · holds-release 6 · cross-cutting 6
                   sweeper 5 · write-tx 5 · holds-lock-timeout 3 · (earlier 119)
typecheck, lint, db:types --verify → clean
```
| R | Status after Phase 5 |
|---|---|
| R6 | ✅ Expired before confirm → 410, seat reusable without the sweeper. Expired *while waiting for the lock* → 410 (mutation-checked). Released → 410. |
| R9 | ✅ Missing, wrong, or another hold's secret, or an unknown id → 404, and the hold is untouched. |
| R10 | ✅ Taken target → 409; the original's time, status and seat are unchanged; no notification. |
| R14 | ✅ **Full journey** with the process clock ±1 year. |
| R15 | ✅ Sequential (case and whitespace variants) and 5 concurrent; different details → 409; past the window → 409. |
| R16 | ✅ No-op; one event, one notification. |
| R17 | ✅ Sequential and 5 concurrent mixed guest/host. |
| R20 | ✅ **Full**, across all tables after a lifecycle. |
| R24 | ✅ 09:00 → 09:30 with a 15-minute buffer (overlaps only its own old session). |
| R26 | – Dispatcher is "if time". The outbox rows are verified. |
| R27 | ✅ |
| New | ✅ Release (6 tests), writeTx retry (5), lock_timeout on all paths, sweeper (5). |
| R25 | – "If time". |

## Commits
```
cc3a0e1 feat(holds): SET LOCAL lock_timeout (2.5 s) -> 503 HOST_BUSY            (Phase 4 follow-up)
74ff024 / a3fbad7 docs: lock_timeout + pool sizing (5.8), host edits take the host lock
b88d982 feat(core): transition table (single status guard) and HMAC manage tokens
7bac8b8 feat(core): writeTx - lock_timeout, one retry on 40P01/40001, then 503
ad58bfd feat(holds): release a hold (held -> expired) with the hold secret
5b69fb2 feat(confirm): confirm a hold with its secret; outbox row in the same txn
f316c6b feat(cancel): guest (token) and host (reason required) cancellation
225dee4 feat(reschedule): move a confirmed booking (same event type), no-op on retry
0ff1e83 feat(sweeper): per-host SKIP LOCKED hold sweeper + 24 h key purge, started with the server
abcbac9 test: R14 full clock skew, R20 full secrets at rest, R27, lock_timeout + retry on every path
add12b0 docs: release, confirm/reschedule/cancel details, writeTx retry policy, started bookings frozen
(+ this summary and AI_LOG)
```

## Open questions
1. **Validating the host time zone (Phase 6).** Strict `Intl.supportedValuesOf` membership rejects `Asia/Kolkata` and `UTC` on this runtime. I propose: **accept any zone that `Intl.DateTimeFormat` and Luxon both accept, and store the exact string the host chose.** The picker lists `supportedValuesOf` plus `UTC` and the common modern names. Is that OK, or do you want strict membership with that caveat documented?
2. **Audit events for sweeper expiries.** Should the sweeper also write one `expired` `booking_events` row per hold (an `INSERT … SELECT` in the same transaction, cheap), so the audit trail is complete? I'd add it in Phase 6 unless you say no.
3. **Phase 6 scope check:** routes for everything above, plus host auth (seeded login, session cookie), host CRUD under the host lock, security headers and log redaction (design §5.7), the `Idempotency-Replayed` and `Retry-After` headers, and errors mapped to the codes in §7. Anything to add or cut before I write the plan?
