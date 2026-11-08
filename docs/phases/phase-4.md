# Phase 4: Holds + idempotency

**Status:** done. All checks green (3 consecutive full runs). Waiting for review before Phase 5.

## Planned vs. actual

| Planned | Actual |
|---|---|
| HMAC hold secrets | ✅ `src/server/auth/secrets.ts`. The first version of the test was fragile, see bug #4. |
| **Concurrency test first, red against a naive service** | ✅ Commit `465c018`, labelled `[RED - intentional]`. The red output is below, and its message says the constraints already prevented the double booking. |
| `createHold`: host lock, rule re-validation, SAVEPOINT claim, error mapping | ✅ Commit `6badd46` turned the same test green unchanged. **Plus your fix:** the clock is read once *after* the locks (`lockedNow()` = `clock_timestamp()`). |
| Idempotency (claim, replay, hash) | ✅ The replay re-derives the secret and returns the **current** `server_now`. The hash normalises `start_at` to UTC. |
| Per-IP cap | ✅ Advisory lock taken **before** the host lock. IPv4-mapped IPv6 is normalised. |
| Validation, R8, R20, R23, mixed run | ✅ **Plus:** deactivation re-checked *under* the lock, and the snapshot kept when joining a group session. |
| (your request) Old hold expires while a new hold waits for the host lock → 201 | ✅ `holds-clock.test.ts`. **Mutation-checked:** with `T := now()` it fails with exactly the wrong 409 you described. |

## The red run (commit `465c018`, naive check-then-insert, no lock, no mapping)
```
× R1  50 parallel, cap 1      → 1 × 201 + 49 × 422 SLOT_NOT_OFFERED  (taken slot reported as "not offered")
× R2  15 parallel, cap 5      → 5 × 201 + 10 × unmapped 23514 occupancies_seats_within_capacity
× R3  20 parallel, 2 types    → 1 × 201 + 19 × unmapped 23P01/23514
× R3b buffer-only overlap     → 1 × 201 + 18 unmapped errors (+1 × 422)
✓ R4  raw inserts, no service → constraints alone: exactly the capacity
Tests 4 failed | 2 passed
```
Exactly 1 (or 5) holds were created in every case. **The database had already prevented the double booking.** The red shows that the service gave wrong answers: 422 instead of 409, and raw 23xxx errors.

## What worked
- **Green numbers:** R1 **1 × 201 / 49 × 409**, R2 **5 / 10**, R3 **1 / 19** (both shapes), with nothing else. No deadlocks or unmapped errors through the service.
- **Idempotency under contention:** 10 concurrent requests with one key give one hold, one `hold_id` and one `hold_secret`. Exactly one is not a replay.
- **R13:** a simulated crash before COMMIT leaves no booking, no seat and no key. A retry with the same key gets a fresh 201.
- **R22:** 10 parallel holds from one IP on 10 slots give exactly 3 × 201 and 7 × 429. The IP lock serialises them.
- **Deactivated while waiting:** if an event type is deactivated while a hold waits on the host lock, the hold gets 404 and nothing is stored for its key.

## What didn't, and the bugs found
1. **My plan wrongly called the stale `now()` "consistent".** You caught it. `now()` is the transaction *start*, so a hold waiting on the host lock swept with an old clock and returned a wrong 409, and Phase 5 confirm would have accepted holds that expired during the wait. **Fix:**
   - `lockedNow()` reads `clock_timestamp()` once after the locks, and that value is used for the sweep, `expires_at`, the IP-cap count and the engine's `now`. The loader takes `{ now }`.
   - Design §5.5 states the rule and §5.1 renumbers the hold steps.
   - Two tests cover it, both mutation-checked.
2. **A finding from R4, not a bug:** without the host lock, parallel claims on *different but overlapping* sessions **deadlock** (40P01) inside the exclusion check. Each waits on the other's uncommitted row. There's still exactly one winner, but my first version of the test took **29 s**. It had passed in the red run only because the connection pool was cold. **Fix:**
   - the test accepts 23P01 or 40P01 and asserts exactly one winner, using 10 inserts instead of 30
   - the test Postgres uses `deadlock_timeout=100ms`, so the test takes about 1 s
   - design §5.1 explains why the host lock is the primary guard
3. **A test helper broke on Sundays.** `nextMonday9()` used Luxon `set({ weekday: 1 })`, which moves *within the ISO week*. Today is Sunday in New York, so "next week's Monday" became **tomorrow**, and a 3-day-horizon test correctly got 201. The same helper in Phase 3's `slot-inputs.test.ts` had the same latent bug; it hadn't failed there only by luck of the weekday. **Fix:** it is now the first Monday at least 7 days ahead, and a unit test checks every weekday.
4. **A hold-secret test passed only by luck.** It changed the *last* base64url character, which carries only 4 data bits, so the decoded bytes can be identical. **Fix:** it now tampers a middle character.
5. **A bogus test that I deleted before committing.** My first "service never deadlocks" test multiplied the slot offset by `* 0`, so every request targeted the same slot and the test couldn't exercise overlapping sessions. R3 already covers that race through the service; its `other: []` assertion would catch any deadlock.
6. **`now()` was hard-coded in the slot loader.** Fixed as part of #1: the loader takes an optional `now`, and the read path still uses its snapshot's `now()`.

## Test results
```
pnpm test → Test Files 26 passed (26) · Tests 245 passed (245) · ~40 s · 3 consecutive green runs
  unit        126  (+ secrets 4, scenario-helper 7)
  integration 119  holds-concurrency 6 · holds-idempotency 10 · holds-validation 13
                   holds-ip-cap 6 · holds-clock 2 · (earlier phases 82)
typecheck, lint, db:types --verify → clean
```
| R | Status after Phase 4 |
|---|---|
| R1, R2, R3 | ✅ Through the service, in parallel, with exact counts. |
| R4 | ✅ Parallel, with the lock bypassed. Constraints alone hold, with deadlock victims allowed. |
| R5 | ✅ Sequential, a lost response, 10 concurrent with one key, and an offset-equivalent instant. |
| R8 | ✅ 422 through the service for 7 tampered shapes. Malformed input gets 400. A taken slot gets 409, never 422. |
| R11 | ✅ The invariant runs after every hold test. |
| R13 | ✅ A crash before COMMIT leaves nothing, and a same-key retry gets 201. |
| R18 | ✅ |
| R19 | ✅ A stored 409 stays 409 after the slot frees. A stored 422 replays. |
| R20 | ✅ For holds: the secret appears in no table's text, and the stored body has only `end_at, expires_at, hold_id, start_at`. |
| R22 | ✅ Including the parallel case and the IPv4-mapped form. |
| R23 | ✅ Through the service. |
| New | ✅ Stale-clock test, `expires_at` = lock time + 5 min. |

## Commits
```
d637078 docs: write paths read the clock once after acquiring locks
9a5d6a1 feat(auth): HMAC-derived hold secrets
08780a7 test(auth): tamper a middle char of the hold secret, not the last
465c018 test(holds): R1-R4 concurrency against a naive hold service [RED - intentional]
6badd46 feat(holds): createHold with host lock, locked clock, rule re-validation, savepoint claim
49c32db feat(holds): idempotency keys - claim, replay, canonical request hash
f1abb1f feat(holds): per-IP active-hold cap (R22)
6584637 fix(test): nextMonday9 returned tomorrow when run on a Sunday
af3c138 test(holds): R8 via the service, deactivation under the lock, R23, mixed run
47bff37 docs: hold response shape, replay semantics, R4 deadlock finding, IP normalisation
(+ this summary and AI_LOG)
```

## Changes from the design (all in `docs/design.md`)
- **The clock is read after the locks** (your fix): `T := clock_timestamp()`, and the hold steps are renumbered.
- **Re-validation checks the host's rules only**, so "is it free" is the constraints' decision and a taken slot is 409, never 422. Design §5.1 step 6 already said this.
- Hold response adds `start_at` and `end_at`. Replays carry the current `server_now`. 404 is not cached.
- The R4 deadlock finding explains why the host lock is the primary guard.
- IPv4-mapped IPv6 is normalised.
- Test Postgres runs with `deadlock_timeout=100ms`. That's test-only.

## Open questions
1. **Event-type edits and the host lock.** A hold re-reads the event type under the host lock. In Phase 6, host-side edits (capacity, duration, deactivation) should take the same host lock, so a hold never sees a half-applied edit. I'll do that unless you prefer otherwise.
2. **Pool sizing.** Every hold waiting on a host lock holds a pooled connection. With `DB_POOL_MAX = 10`, a burst of more than 10 holds for one host makes other hosts' requests wait for a connection. Options: a larger pool, or a per-host in-process queue in front of the transaction. I'd document it and measure in the load test. Is that OK?
