# Phase 1: Scaffold

**Status:** done. All checks green. Waiting for review before Phase 2.

## Planned vs. actual

| Planned | Actual |
|---|---|
| pnpm, TypeScript, ESLint with the clock rule | ✅ Done. **Changed:** TypeScript pinned to **6.0.3**, see bug #1. |
| Fastify app factory, config, `/health` | ✅ Done. `/health` returns 200 `{status:'ok',db:'ok'}` or 503 `{status:'error',db:'down'}`. |
| Kysely pool, static migrator, `btree_gist` migration, seed stub | ✅ Done. **Changed:** committed *before* the server, because `/health` needs the DB layer. |
| Vite React placeholder + API proxy | ✅ Done. The page calls `/health` through the proxy. |
| Dockerfile + compose (migrate → seed → serve) | ✅ Done. Node 24 LTS image, Postgres 16, DB healthcheck gate. |
| Vitest unit/integration + Testcontainers, `pnpm test` = one command | ✅ Done. `TEST_DATABASE_URL` override also verified. |
| Tests: smoke, migrations idempotent, `btree_gist`, bad config fails fast | ✅ Done. **Added:** `/health` 503 when the DB is down, a PG ≥ 15 check, `TRUST_PROXY` hop semantics including a spoofed-header case, and an ESLint clock-rule test. |
| Docs: explicit lock order + `TRUST_PROXY` | ✅ Done (`docs/design.md` §5.1 and §10 #11). |

### Pre-Phase-4 check (you asked for this)
- **Lock order** is now explicit in §5.1. It is a global order: idempotency key row → IP advisory lock → host row → booking rows → occupancy rows. A per-path table (hold, confirm, reschedule, cancel, sweeper) shows which locks each path takes, with five reasons it can't deadlock.
- **`TRUST_PROXY`** is in §10 #11 and enforced in `src/server/config.ts`:
  - default `false`: `X-Forwarded-For` is ignored
  - `1` on Render: one trusted proxy hop
  - `true`: rejected at startup

## What worked
- `docker compose up` on an empty volume: DB healthy → `[migrate] Success: 0001_extensions` → `[seed] done` → `/health` 200, SPA served on `/`, SPA fallback on `/dashboard`, JSON 404 on unknown `/api/*`.
- Restarting the app container logs `[migrate] already up to date`, so migrate and seed are idempotent.
- `pnpm dev`: Vite on :5173 forwards `/health` to the API on :3000, which reaches the Compose DB.
- `pnpm test` on a **fresh clone** (`pnpm i --frozen-lockfile && pnpm test`) passes, with Docker as the only requirement. The test container is removed after the run, and Testcontainers' Ryuk cleanup container exits by itself about 10s later.
- Testcontainers on WSL2 worked without the `RYUK_DISABLED` fallback I'd planned for.

## What didn't, and the bugs found
Mistakes in my own code and plan:
1. **TypeScript 7 is incompatible with typescript-eslint.** `pnpm add -D typescript` installed TS 7.0.2, which has no JS compiler API (`ts.createSourceFile` is undefined). typescript-eslint requires `>=4.8.4 <6.1.0`. Fix: pinned `typescript@~6.0`. The plan's risk list missed this.
2. **Wrong Kysely import path.** Kysely 0.29 moved `Migrator` and `Migration` to `kysely/migration`. Importing from `kysely` gave a deliberate `KyselyTypeError`. Fixed.
3. **Fastify's types reject a numeric `trustProxy`**, even though the runtime (proxy-addr) accepts one. Fix: `trustProxyOption()` turns the hop count into the equivalent `(addr, hop) => hop < n` function. Covered by a unit test.
4. **Commit order in the plan was wrong.** I planned the server before the DB layer, but `/health` needs the DB, so I swapped them.
5. **pnpm 12 blocks build scripts** (expected). Only `esbuild` is allowed. `cpu-features`, `ssh2` and `protobufjs`, which Testcontainers pulls in for optional native speed-ups, are explicitly denied. Tests pass without them.

Gaps in the design doc, fixed in `ebdf790`:
6. The lock order said "IP → host → booking". It left out that the **idempotency key row is effectively the first lock**, since a concurrent duplicate waits on it. It also didn't say which paths skip the IP lock, and it didn't mention occupancy rows, which the trigger locks.
7. `trustProxy` was described only as "`trustProxy` in prod". It had no value, no default, and no reason for rejecting `true`.

## Test results
```
pnpm test   → Test Files 4 passed (4) · Tests 23 passed (23) · ~15s (incl. container start)
  unit         18  (config 12, trust-proxy 3, lint clock rule 3)
  integration   5  (health 200, health 503, migrations idempotent, btree_gist, PG >= 15)
pnpm typecheck → clean      pnpm lint → clean
Same 23/23 with TEST_DATABASE_URL pointing at the compose Postgres.
```
No R cases yet. Phase 1 builds the setup they run on. R-case tests start in Phase 3 (R12) and Phase 4 (R1–R5).

## Commits
```
3ced779 chore: pnpm, TypeScript, ESLint with clock rule, gitignore
276a177 feat(db): env config, Kysely pool, static migrator, btree_gist migration, seed stub
ca53517 feat(server): Fastify app factory, /health with DB ping, SPA static serving
9096f73 feat(web): Vite React placeholder that pings /health, dev proxy to API
5e695e9 chore: Dockerfile and docker compose (migrate, seed, serve)
a8f6a57 test: Vitest unit/integration projects, Testcontainers global setup, smoke tests
ebdf790 docs: explicit lock order per path and TRUST_PROXY config
(+ this summary and the AI_LOG update)
```

## Changes from the design
- TypeScript 6.0.x, not "latest", until typescript-eslint supports TS 7.
- The migration list is static (`src/server/db/migrations/index.ts`) instead of Kysely's `FileMigrationProvider`.
- `int8` values are parsed as JS numbers process-wide (`pg.types`), so `count(*)` returns a number. Safe at our sizes.
- The test Postgres runs with `fsync=off`, `synchronous_commit=off` and `max_connections=200`. That's faster and doesn't affect locking or constraints, and it leaves room for the 60-connection concurrency test.

## Open questions
1. You didn't answer the three Phase 1 plan questions, so I went with my suggestions: `slotbook.pdf` is **gitignored**, **Postgres 16** everywhere, **Node 24** in Docker (Node 26 locally). Say if you want any of these changed.
2. The Compose DB is published on host port 5432 for `pnpm dev`. If you have a local Postgres on 5432, run `DB_PORT=5433 docker compose up` and update `.env`. Is that OK, or should the default be 5433?
3. Local state from my checks: a gitignored `.env` (copied from `.env.example`), a `slotbook_test` database in the Compose Postgres (used once to verify `TEST_DATABASE_URL`), and the Compose `db` container still running, with `app` stopped. Tell me if you want any of it cleaned up.
