# Phase 13: Waitlist

**Status:** done. CI green on `fe205c6` (test job 1m54s, e2e job 1m32s). Design first (`eae7444`, design §13), then built test-first.

## Planned vs. actual

| Your requirement | Actual |
|---|---|
| Design addendum first, committed | ✅ Design §13 (`eae7444`), before any code. |
| A freed seat → the next guest's time-limited hold in the **same transaction** | ✅ **An offer is an ordinary held booking** linked to its entry (`bookings.waitlist_entry_id`, `client_ip = NULL`), so the seat trigger, the exclusion/capacity constraints, expiry and confirm all apply unchanged. One shared step, `handOffFreeSeats(trx, host, T)`, runs under the host lock in **every** path that frees or claims a seat: hold, confirm, release, cancel, reschedule, sweeper, waitlist join/leave/read-repair. |
| What frees a seat, atomically under the host lock | ✅ Cancel, reschedule away, an expired hold or offer (whichever write sweeps it first), release, leaving with an offer. **Design corrected:** a capacity edit does *not* free a seat in an existing session (see "What I found"). |
| Offer duration; a lapsed offer passes on in the same transaction as its expiry; sweeper only an optimisation | ✅ **15 min**, capped at the slot start. The handoff first sweeps, then marks offers whose booking is `expired` as `lapsed`, then hands their seats on, all in one transaction. **W2 and W3 prove "same transaction"**: the lapse's `resolved_at` equals the new offer's `offered_at`, which is the transaction's post-lock clock T. The read path reserves seats for waiting guests (`public_free = capacity − live − waiting`), so a lazily expired offer never looks free. A status read does read-repair, so the next guest learns of their offer without waiting for the sweeper. |
| Private waitlist link, HMAC token, never stored | ✅ `/waitlist#<id>.<token>`, token = HMAC(`APP_SECRET`, `waitlist:v1:` + id). It's sent in a `Waitlist-Token` **header** (not the path, avoiding the manage link's known gap) and redacted from logs; a test checks the captured logs never contain it. A `waitlist.offered` outbox row is written in the offer transaction (no token in it). |
| Slot API shows full slots with a "join waitlist" action | ✅ Opt-in `include_full=1`: full slots come with `seats_left: 0` and `waitlist: {open, waiting}`. The default response is unchanged, so k6, existing clients and the reschedule picker are unaffected. |
| Rules: FIFO, one entry per email per slot, cap, no offers inside min notice, offers outside the per-IP cap, one offer per freed seat in group sessions | ✅ FIFO by `seq`. Partial unique index (case-insensitive email) → 409 `ALREADY_WAITLISTED`. Cap **10 waiting per slot** → 409 `WAITLIST_FULL`. Inside min notice (or slot no longer offered, or event type inactive) → no offer, and the waiting entries become `closed`. Offers carry no `client_ip`. Group sessions: `min(free seats, waiting)` offers. **Added:** at most 3 active entries per IP (429 `WAITLIST_LIMIT`), and joining a free slot → 409 `SLOT_AVAILABLE`. |
| Schema, lock order, invariant | ✅ Migration `0004_waitlist`: append-only entries, shape CHECKs, `offered_at`/`resolved_at`. Lock order: key → per-IP waitlist lock → host → bookings → sessions → entries. The after-every-test invariant now also checks **offer consistency** (offered ⇔ exactly one held linked booking, …) and the **handoff invariant** (no free stored seat while someone waits, unless the slot can't be offered). Two meta-tests prove both checks can fail. |
| Race tests | ✅ **W1** a cancel racing 20 public holds → 0 public 201s, the waitlisted guest offered. **W2** an offer lapsing to the next guest inside a public hold's transaction (the public hold gets 409). **W3** claim after expiry → 410 `OFFER_EXPIRED`, the next guest offered in that transaction. **W4a** two holds expiring in one sweep → two offers. **W4b** two concurrent cancels → two offers. |
| Playwright test for the waitlist flow | ✅ `e2e/waitlist.spec.ts`: seat booked via the API → second guest joins from the booking page → first guest cancels → second guest sees "A seat is yours", a 15:00 countdown, confirms, booked. Plus a jsdom web test of the same flow. |

## What I found / what went wrong
1. **Design flaw: "a host edit that raises capacity" frees a seat.** It doesn't. A session keeps its capacity *snapshot* while seats are taken (the refresh-on-zero rule from Phase 2), so raising an event type's capacity only affects empty or new sessions. Design §13.2 is corrected (struck through, with the reason); host edits don't call the handoff.
2. **W1 passes even with the cancel path's handoff removed.** The hold path also runs the handoff before any public claim, so the race is protected twice. Mutation checks:
   - cancel handoff removed → **W4b** fails, since it has no public writes;
   - hold-path handoff removed → **W2** fails (the public hold gets the lapsed seat).

   So each path is pinned by some test, and W1 is the end-to-end property.
3. **A bug in my own idempotency test:** the helper gave every call a new name, so the "replay" was a different body, and the server's 422 was right. The test now pins the name.
4. **A circular import avoided:** the handoff needs nothing from the hold/confirm services, but the waitlist service needs them. The handoff lives in `waitlist-handoff.ts`, imported by every write path.
5. **Lock note:** the join takes a *separate* per-IP advisory lock namespace (`pg_advisory_xact_lock(2, …)`), so joining a waitlist and holding a slot from the same IP don't serialise on each other's lock.

## Results
```
pnpm test → 54 files, 455 tests passed (new: waitlist 20, waitlist-http 3, web waitlist 1; rate-limits +4 routes)
waitlist tests (waitlist + waitlist-http, 23 tests) × 10 → 10/10 green, no flakes
pnpm e2e  → 8/8 (new: waitlist)
CI → green on fe205c6
```

## Commits
```
eae7444 docs(design): §13 waitlist addendum
5455463 test(waitlist): race tests W1–W4 and rule tests, written first (red: no implementation yet)
6480f27 feat(waitlist): migration 0004
cce25a3 feat(waitlist): HMAC-derived waitlist token (never stored) and join schema
ff9b178 feat(waitlist): hand freed seats to the next waitlisted guest in the freeing transaction (every write path); join, status with read-repair, claim, leave
4fe3670 feat(slots): waitlisted guests own the next free seats on the read path; ?include_full=1
63abd56 test: the after-every-test invariant covers waitlist offers and the handoff (with meta-tests)
8ca1bc3 feat(waitlist): HTTP routes with per-IP limits; token only in a header, redacted
601b81e feat(web): full times show 'join waitlist'; /waitlist page
d65e29d test(web): waitlist flow against the real API
3f42b55 test(e2e): waitlist flow in a real browser
fe205c6 docs: waitlist built (README); design §13.2 corrected
(+ this summary and AI_LOG)
```
Note: `5455463` (tests before the implementation) and `ff9b178` (whose new meta-tests need `63abd56`) are deliberately red locally; they were never pushed on their own, so CI only saw green heads.

## Changes from the design
- §13.2: capacity edits removed from "what frees a seat" (corrected, with the reason).
- Added beyond the addendum's table: nothing new; `WAITLIST_LIMIT` and `SLOT_AVAILABLE` were already in §13.3.
