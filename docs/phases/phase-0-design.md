# Phase 0: Design (v0.1 → v0.3)

**Status:** done. Design approved on 2026-11-08, then Phase 1 started.

Moved here from `AI_LOG.md`, which is now a plain transcript. This is the design-phase record of what the AI got right and wrong. Build phases have their own `phase-N.md`.

## What went well
- From the start, v0.1 put correctness in Postgres rather than in app code: a per-host row lock, plus an `occupancies` table with an exclusion constraint for overlaps and a `CHECK` for capacity. Reviews refined the details of this approach but never replaced it.
- A transactional outbox, Postgres `now()` as the only clock, and server-side re-validation of every requested slot were in v0.1 and survived every review.
- While fixing the plaintext-token issue (#1 below), the AI found a second leak of the same kind on its own: notification payloads that held the manage link (#2).
- The DST table in v0.3 was checked against the system's time-zone data (`TZ=… date`) before it was committed.

## What the AI got wrong (caught in review)
| # | Mistake | Version | Caught by | Fix |
|---|---|---|---|---|
| 1 | Confirm idempotency stored the **plaintext manage token** in `idempotency_keys.response_body`, which contradicted its own "tokens stored hashed" claim (R18). | v0.1 | me | All secrets are HMAC-derived from `APP_SECRET` + booking id. Only hashes are stored, and replays re-derive. |
| 2 | Notification payloads would also have held the manage link, so the same leak existed in the outbox. | v0.1 | AI, while fixing #1 | The dispatcher derives the link when it sends. |
| 3 | A hold was protected only by its id, so **anyone with the id could confirm it**. | v0.1 | me | A `hold_secret` is required on confirm. A wrong secret gives 404. |
| 4 | Manage tokens in URL paths could leak via the Referer header and logs. | v0.1 | me | `Referrer-Policy: no-referrer`, log redaction, and the manage link uses the URL fragment (`/manage#token`). |
| 5 | After a constraint error the transaction is aborted, so the **409 could not be stored** for the idempotency key. | v0.1 | me | `SAVEPOINT` around the seat claim, plus an explicit policy for which outcomes are cached. |
| 6 | The slots read path used `seats_taken`, so an **expired but unswept hold showed as full**. | v0.1 | me | The read path counts live seats from bookings. |
| 7 | There was no invariant test for `seats_taken`. | v0.1 | me | Trigger-maintained counter + stored/live invariant check after every test. |
| 8 | A reused occupancy row at 0 seats kept a **stale capacity and stale buffers**. | v0.1 | me | Refresh-on-zero upsert. |
| 9 | The "client clock skew" test **tested nothing**, because the client never sends its clock. | v0.2 | me | Replaced by an app-server clock skew test, plus a lint rule banning the JS clock in service code. |
| 10 | Slot generation iterated host days in the range only, so **guest days spanning two host days could be cut off**. | v0.2 | me | Host days padded by ±1 and filtered by UTC instant. |
| 11 | Slot end used wall-clock arithmetic, which is wrong across DST. | v0.2 | me | End = start instant + duration in real minutes. |
| 12 | Weekday numbering was unspecified, and **date overrides could mix a day off with custom hours**. | v0.2 | me | ISO weekday with a `CHECK`. Composite FK so windows only attach to `custom` overrides. |
| 13 | A retried reschedule to the same slot would have sent a second notification, and the dispatcher wasn't safe with multiple instances. | v0.2 | me | Pure no-op reschedule. `FOR UPDATE SKIP LOCKED` + lease, with at-least-once delivery. |
| 14 | **Scope creep.** The design had grown well past the 4–5h core: an unused `manage_token_version` column, two status guards, and 25 unranked reliability cases. | v0.2 | me | A cut list (core / if time / known gaps), the column and the second guard dropped, and the cases ranked. |
| 15 | The DST example used a NY host and an India guest. That misses the more interesting week when Europe and the US switch on different dates. | v0.1–v0.2 | me | NY host and Berlin guest, Oct 23 – Nov 2 2026, when the gap is 5h instead of 6h. |

## Decided by the user, not the AI
- Stack: Kysely instead of plain SQL or Prisma.
- Scope: core first; then observability, E2E + CI and the load test only; daily cap only if the core is green; full rate limiting only if time; a minimal per-IP hold cap in the core.
- Deployment: Render + Supabase/Neon later on, using the direct DB connection, not a transaction pooler.
- Assumptions: slot step = duration. Buffers may fall outside the window. Min notice is checked at hold time only. Bookings keep their UTC times when the host changes time zone.
- `pnpm test` must start its own test DB.
- Git: small commits, never squashed, no co-author trailer.
- Process: 9 phases with plan → "go" → build → phase summary → review. The concurrency test must be written first and seen to fail (Phase 4). Fall-back duplicate slots must be labelled EDT/EST (Phase 8).
- AI_LOG must be kept up to date on every message.
