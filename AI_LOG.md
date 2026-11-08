# AI_LOG

How AI was used to build Slotbook. The brief asks for key prompts, where the AI got things wrong, and what was changed by hand. Raw transcripts are optional; they are included below.

**Tool:** Claude Code (Claude Opus 5.5), in the terminal, working directly in this repo.

---

## Summary

### How I worked with it
1. **Design first, no code.** I gave the AI the brief PDF and asked for a design doc. I told it not to write code until I approved the design.
2. **Several review rounds.** I reviewed each version of `docs/design.md`, answered its open questions, and pushed back on specific flaws. It revised the doc each time, and each version was committed (v0.1 → v0.2 → v0.3).
3. **Small commits, never squashed.**
4. **Phased build with a review gate.** There are 9 phases. Before each one the AI writes a short plan and waits for my "go". After each one it writes `docs/phases/phase-N.md` (planned vs. actual, bugs, test counts, commits, open questions) and waits for my review.
5. **This log is updated on every message**, without me having to ask.

### Key prompts
- "check slotbook.pdf … create a design doc how you will create all the parts … once I give go ahead then only start coding"
- Stack and scope decisions: Fastify + React/Vite + **Kysely** (raw `sql` kept for constraints and locking), core first, a narrowed list of extensions, deployment later.
- Security and consistency review of v0.1, which fed into v0.2.
- Worker, clock, time-zone and scope review of v0.2, which fed into v0.3.

### Where the AI got things wrong (caught in review)
| # | AI's mistake | Version | Who caught it | Fix |
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
| 16 | Installed TypeScript "latest" (7.0), which has no JS compiler API, so typescript-eslint (`<6.1`) breaks. The plan's risk list missed it. | Phase 1 | AI (lint/typecheck) | Pinned `typescript@~6.0`. |
| 17 | Imported Kysely's `Migrator` from `kysely`. Kysely 0.29 moved it to `kysely/migration`. | Phase 1 | AI (tsc) | Fixed the import path. |
| 18 | Passed a numeric `trustProxy` to Fastify. The runtime accepts it but the types don't. | Phase 1 | AI (tsc) | Hop-count function `(addr, hop) => hop < n`, unit-tested. |
| 19 | The Phase 1 plan ordered the server commit before the DB layer it depends on. | Phase 1 | AI | Swapped the commit order. |
| 20 | The design doc's lock order left out the idempotency-key row and the occupancy rows, and didn't say which paths skip the IP lock. `trustProxy` was only "`trustProxy` in prod". | v0.3 | me (asked to confirm before Phase 4) | Global lock order + per-path table + deadlock argument. `TRUST_PROXY` = false / hop count, never `true`. |

### What I decided or changed by hand
- Stack: Kysely instead of plain SQL or Prisma.
- Scope: core first; then observability, E2E + CI and the load test only; daily cap only if the core is green; full rate limiting only if time; a minimal per-IP hold cap in the core.
- Deployment: Render + Supabase/Neon later on, using the direct DB connection, not a transaction pooler.
- Assumptions: slot step = duration. Buffers may fall outside the window. Min notice is checked at hold time only. Bookings keep their UTC times when the host changes time zone.
- `pnpm test` must start its own test DB.
- Git: small commits, never squashed, no co-author trailer.
- Process: 9 phases with plan → "go" → build → phase summary → review. The concurrency test must be written first and seen to fail (Phase 4). Fall-back duplicate slots must be labelled EDT/EST (Phase 8).
- AI_LOG must be kept up to date on every message.

---

## Appendix: raw transcript

User messages are verbatim, typos included. Assistant replies are the final message of each turn, lightly condensed. Tool calls (file writes, git commands) are summarised in *italics*.

### Session 1: design (2026-11-08)

---

#### Turn 1. User
> check @slotbook.pdf before you start coding check this and create a deisgn doc how you will create all the parts then we will have converstion on it and once i give go ahead then only start coding

*AI read the 5-page brief and wrote `DESIGN.md` (v0.1): stack, architecture, data model with an `occupancies` table, a booking engine (per-host row lock + exclusion/check constraints, idempotency keys, outbox), slot generation with DST, API, frontend pages, a 19-row reliability matrix, assumptions, ranked extensions, a delivery plan and open questions.*

#### Turn 1. Assistant
> The design doc is written to `/home/laptop/gen-ai/assignment/slotbook/DESIGN.md`. No code yet, as you asked.
>
> **How it prevents double booking (the heart of the design):**
> - Every hold/confirm/reschedule/cancel runs in **one Postgres transaction that locks the host row**, so bookings for one host are serialised.
> - **DB constraints are the backstop.** An `occupancies` table with a GiST **exclusion constraint** stops overlapping sessions (buffers included, across all event types). A `CHECK seats_taken <= capacity` handles group sessions, so even an app bug can't double-book.
> - **Postgres `now()` is the only clock**, and expired holds count as free immediately, without depending on a background job.
> - **Idempotency keys** are stored in the same transaction as the hold, so retries and double-clicks are safe.
> - A **transactional outbox** for notifications means no lost or phantom events.
> - The server re-validates every requested slot against the rules. The client is never trusted.
>
> The doc also covers the data model, a worked DST example, the API, 19 failure cases each with a named test, assumptions, ranked extensions and a commit-by-commit plan.
>
> **Questions for you (§13):**
> 1. Stack: Fastify + React/Vite + plain SQL OK, or Next.js / an ORM?
> 2. Which optional extensions? I suggest observability, E2E+CI, load test, daily cap/per-guest limit and abuse protection.
> 3. Live deployment: yes or no, and on which provider?
> 4. Login: seeded email + password, or magic link?
> 5. Are you OK with slot step = event duration and buffers outside the window?
> 6. Should I `git init` now, and is there a repo name?
>
> Once you've answered or adjusted, give me the go-ahead and I'll start with the scaffold.

---

#### Turn 2. User
> answer to the qustions
> 1. Stack: Fastify + React/Vite, but use Kysely instead of plain SQL or Prisma. Keep raw SQL (sql``) for constraints and locking.
> 2. Extensions: core first. Then only observability, E2E tests + CI, and the load test. Daily cap/per-guest limit only if the core is fully green. Keep a minimal active-hold cap per IP in the core; full rate limiting goes to "if time".
> 3. Live deployment: yes, but later on after the core is done. Use Render + [Supabase/Neon, whichever I decide later on]. Use the direct DB connection, not a transaction pooler, and seed the demo host.
> 4. Login: seeded email + password. No magic link.
> 5. Slot step = event duration: yes. Buffers may fall outside the availability window, but the meeting itself must fit inside it. Put both in Assumptions.
> 6. Git: yes, init now. Repo name: slotbook. First commit = this design doc as docs/design.md. Then small commits per step; never squash no coauthor as well.
>
> few questions/suggestion i have
> §5.2 stores the manage token in idempotency_keys.response_body, which contradicts R18. Redesign confirm so the plaintext token is never persisted.
> Holds return only hold_id, so anyone with the id can confirm. Add a hold secret that's required on confirm.
> Manage tokens sit in URL paths. Add Referrer-Policy: no-referrer and redact tokens from logs.
> In §5.1, a constraint error aborts the transaction, so the 409 can't be stored. Add a SAVEPOINT and decide whether failed responses are cached for the idempotency key.
> The slots read path uses seats_taken, so an expired but unswept hold shows as full. Make reads ignore expired holds without relying on the sweeper.
> Add an invariant test: seats_taken always equals the count of active bookings (confirmed, or held and not expired).
> A re-used occupancy at seats_taken = 0 keeps an old capacity and buffer. Refresh them on 0→1, or delete the row at 0.

*AI rewrote the doc as `docs/design.md` (v0.2), deleted `DESIGN.md`, ran `git init -b main`, and committed `2c8c12d docs: add design doc for Slotbook`.*

#### Turn 2. Assistant
> Your answers and all seven fixes are in the design (now v0.2), and the repo is set up. Commit `2c8c12d docs: add design doc for Slotbook` is the only commit so far. No co-author line. `slotbook.pdf` is not committed. No code yet.
>
> **What changed for each of your points:**
> 1. **Plaintext manage token:** both secrets (the new hold secret and the manage token) are now generated from the booking id and a server key, `APP_SECRET`. The DB stores only a hash of the manage token. Replays and the notification sender regenerate the token. This also fixes a second leak: a notification payload with the manage link would have stored the token too. Trade-off: a DB dump alone gives nothing usable, but the DB plus `APP_SECRET` does.
> 2. **Anyone with the hold id can confirm:** holds now return a `hold_secret`, and confirm requires it. A wrong secret gives 404. Confirming again with the same guest details within 15 minutes returns the same booking and token, with no second notification.
> 3. **Tokens in URLs:** global `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, booking paths logged as `/api/bookings/:token`, secret headers and fields hidden, and a test that no token reaches the logs. Extra, not requested: the manage link is `/manage#<token>`, because the fragment is never sent to the server. What's left: the hosting provider's own access logs still see the API path (known gap).
> 4. **409 can't be stored:** the seat claim runs inside a `SAVEPOINT`. Saved for a key: 201, 409, 422 `SLOT_NOT_OFFERED`. Not saved: 400, 422 key reused, 429, 5xx.
> 5. **Unswept expired holds show as full:** the slots read counts only confirmed bookings and unexpired holds. It no longer uses `seats_taken`.
> 6. **Invariant test:** a DB trigger keeps `seats_taken` up to date. The check runs after every integration test and after 500 random operations, and asserts the stored count, the live count after a sweep, and no overlaps.
> 7. **Stale reused row:** capacity, end time and buffers are refreshed when a session goes from 0 to 1 seats.
>
> **Two choices that weren't in your answers:** the seat counter is a DB trigger rather than app code, and the per-IP hold cap is 3 active holds, processed one at a time per IP, with 429 when exceeded.
>
> Say "go" if v0.2 looks right, and I'll start with the scaffold.

---

#### Turn 3. User
> Nice, v0.2 looks solid. A few more design changes before we write any code. Please update the design doc only, no code yet.
>
> Workers and clock: make the outbox dispatcher use FOR UPDATE SKIP LOCKED so it's safe with more than one instance, and note that delivery is at-least-once. R14 doesn't really test anything, since the client never sends its clock. Swap it for a test that skews the app server clock and shows nothing changes. Also, a retried reschedule to the same slot shouldn't send a second notification; it should do nothing.
>
> Time zones: generate host days from rangeFrom − 1 to rangeTo + 1 and filter by UTC instant, otherwise guest days that span two host days get cut off. A slot's end should be start instant + duration in real minutes, not wall-clock time. Make weekday ISO (1 = Mon) with a CHECK, and don't let overrides mix a day-off row with custom hours on the same date. For the DST test and the report example, use a NY host and a Berlin guest during Oct 25–Nov 1, 2026, when the gap is 5h instead of 6h.
>
> Scope: this has grown well past the 4–5h core. Give me a short cut list (core / if time / known gaps), drop the unused version column, keep only one status guard, and rank R1–R19. R17 goes to known gaps unless you can define it simply.
>
> Assumptions: min notice is checked at hold time only, and existing bookings keep their UTC times if the host changes time zone. Also plan for pnpm test to start the test DB itself, so it really is one command.
>
> Add a short v0.2 → v0.3 changelog at the top and commit the doc. Then stop and show me a summary of what changed. I'll review it before we start any code.

*AI rewrote `docs/design.md` as v0.3, checked the DST table against the system tzdata (`date` with `TZ=`), and committed `cb0c353 docs: design v0.3 - scope cut list, ranked reliability, TZ and worker fixes`.*

#### Turn 3. Assistant
> `docs/design.md` is updated to v0.3 and committed as `cb0c353`, with no co-author line. The changelog is at the top. No code yet.
>
> **About your numbering:** your R14 (client clock) and R17 only match the v0.1 numbers. I took R14 to be the client-clock skew test and R17 to be the crash-mid-transaction test. The new table has a column mapping each case to its old number.
>
> **Workers and clock**
> - Outbox dispatcher: claims up to 10 rows with `FOR UPDATE SKIP LOCKED` and a 60-second lease, and sends outside any transaction. Delivery is **at-least-once**, and receivers dedupe on `X-Notification-Id`. The dispatcher is now "if time"; in the core, the `notifications` table is the sink.
> - Sweeper: `SKIP LOCKED` on the host row, so it skips busy hosts and can never deadlock with a booking.
> - Clock test (R14): replaced. It moves the app server clock ±1 year and shows that slots, holds, expiry and confirm are unchanged. A lint rule bans reading the JS clock in service and slot code.
> - Reschedule retried to the same slot: pure no-op (R16).
>
> **Time zones**
> - Host days run from one day before `rangeFrom` to one day after `rangeTo`, filtered by UTC instant.
> - Slot end = start instant + duration in real minutes. On DST nights, a 01:00–04:00 window on spring-forward night is 2 real hours, and a 00:00–03:00 window on fall-back night is 4 real hours, offering both 01:00 EDT and 01:00 EST.
> - ISO weekday with a `CHECK`. Overrides are `off` or `custom`, enforced by a composite FK.
> - DST example: NY 09:00 shows in Berlin as 15:00 on Oct 23, 14:00 on Oct 26 (5h gap) and 15:00 on Nov 2. Checked against the system's tz data. Cross-day test: a Berlin guest's Tuesday includes the NY host's Monday-evening slots.
>
> **Scope**
> - Cut list (§11): core (about 4–5h, tests R1–R23); "if time", in order: dispatcher, extra tests, observability, E2E + CI, load test, deployment, daily cap, rate limiting; known gaps: token revocation, token in infra logs, overlapping windows checked only by the API, windows crossing midnight, notification ordering.
> - Dropped `manage_token_version` and the DB status-guard trigger. The guard is only in the service's `transition()` table. The seat-counter trigger stays.
> - 27 cases ranked by how bad × how likely. R1–R23 core, R24–R27 "if time".
> - Crash mid-transaction (R13) stays in core because it can be defined simply: a test-only failure just before `COMMIT`, then check for no partial state and that a same-key retry gives 201.
>
> **Assumptions and testing:** min notice is checked at hold and reschedule only. Bookings keep their UTC times when the host changes time zone. `pnpm test` starts its own Postgres (Testcontainers) unless `TEST_DATABASE_URL` is set.
>
> When you've reviewed it, say "go" and I'll start with the scaffold.

---

#### Turn 4. User
> also save all the conveestion we had in ai log.md file just like pdf asked to keep transipt of this chat

*AI created this `AI_LOG.md` (summary + transcript) and committed it.*

---

#### Turn 4. Assistant
> `AI_LOG.md` has the whole conversation, committed as `3110a10` (plus `de48e0a`, a note that my replies are lightly condensed). It has a summary (how we worked, key prompts, 15 design mistakes caught in review, your own decisions) and a raw-transcript appendix with your messages word for word. I'll append each new session. Say "go" when you've reviewed v0.3.

---

### Session 2: Phase 1 (scaffold)

#### Turn 5. User
> Go, with a way of working: we build in phases, and I review each one before the next.
>
> Phases:
> 1. Scaffold: pnpm, Fastify, Vite, Kysely, docker compose, migrations, and pnpm test starting its own DB
> 2. Schema, constraints, seat-counter trigger, seed
> 3. Slot engine (pure) + unit tests including DST
> 4. Holds + idempotency. Write the concurrency test first and let it fail, then implement
> 5. Confirm, cancel, reschedule, outbox, sweeper + their tests
> 6. API routes + auth
> 7. Host dashboard UI
> 8. Guest + manage UI (label duplicate fall-back slots with EDT/EST)
> 9. README, cleanup, gaps list
>
> Before each phase, write a short plan: what you'll build, how, which files, which tests (highest-ranked R cases first), and any risks. Then stop and wait for my "go".
>
> After each phase, write a summary to docs/phases/phase-N.md and show it to me:
> - what you planned vs. what you actually did
> - what worked and what didn't
> - bugs you found, including mistakes in your own code or in the design doc
> - test results (pass/fail counts)
> - the commits you made
> - anything that changed from the design, and open questions
> Then stop and wait for me.
>
> Rules: small commits inside each phase, no co-author line, never squash, all tests green before you end a phase. Also confirm the IP-lock → host-lock order and the trustProxy setting are in the design doc before Phase 4.

*AI checked the toolchain (Node 26, pnpm 12.18, Docker 29), grepped the design doc for the lock order and trustProxy, and saved the phase workflow to its memory.*

#### Turn 5. Assistant (Phase 1 plan, condensed)
> - **Pre-Phase-4 check:** both points are in the doc, but too vague. The lock order doesn't say which paths skip the IP lock, and trustProxy only says "`trustProxy` in prod". I'll add a `TRUST_PROXY` env var: `false` by default, `1` on Render, `true` rejected.
> - **What I'll build:** `docker compose up` (PG16 → migrate → seed stub → serve API + SPA). `pnpm dev` (API in watch mode + Vite with `/api` forwarded). `pnpm test` (Testcontainers, or `TEST_DATABASE_URL`).
> - **How:** a single ESM package, compiled with `tsc`, no bundler. A static Kysely migration list. Migration 0001 enables `btree_gist`. Env validated with zod. A `buildApp()` factory. Vitest unit and integration groups. ESLint clock rule from day one.
> - **Tests:** health against real PG, migrations idempotent, `btree_gist`, bad config fails fast. No R cases yet.
> - **8 planned commits.**
> - **Risks:** Node 26 vs Node 24 in Docker, pnpm 12 blocking build scripts, Testcontainers Ryuk on WSL2, the 60-connection pool for Phase 4.
> - **Questions:** gitignore the PDF? Postgres 16 / Node 24 OK?
>
> Waiting for your "go".

#### Turn 6. User
> go

*AI scaffolded the project. `pnpm add` installed TypeScript 7, which typescript-eslint can't use, so the AI pinned 6.0.3. It approved only esbuild's build script.*

#### Turn 6. User (sent mid-turn)
> keep on updating ai log dont wait for me to ask you on every msg update it

*AI saved this rule to memory, and this log is now updated as each message arrives. It continued Phase 1:*
- *config and DB layer. It fixed the Kysely 0.29 `kysely/migration` import.*
- *app and `/health`. It fixed the numeric-`trustProxy` typing with a hop-count function.*
- *web placeholder, Dockerfile and compose. A real `docker compose up` was verified: migrate → seed → `/health` 200, SPA served, restart idempotent. `pnpm dev` was verified through the Vite proxy.*
- *Vitest + Testcontainers: 23/23 pass, the same with `TEST_DATABASE_URL`, and from a fresh clone.*
- *design doc: explicit lock-order table and `TRUST_PROXY`.*
- *`docs/phases/phase-1.md` written.*

#### Turn 6. Assistant
> Phase 1 is done. Summary in `docs/phases/phase-1.md`: 23/23 tests, 7 commits plus a docs commit, 5 of my own bugs and 2 design-doc gaps found. Three open questions. Waiting for review before Phase 2.

---

<!-- Later sessions: append new turns below and add new rows to "Where the AI got things wrong". -->
