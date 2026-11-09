# Phase 9: README, cleanup, known gaps, flake check

**Status:** done. All checks green. Waiting for review before the Playwright + CI phase.

## Planned vs. actual

| Planned (+ your changes) | Actual |
|---|---|
| README: run, tests, API, 60-second tour | ✅ `README.md`. Every tour step was followed from a **clean clone** (`docker compose up --build`, then the guest and host flows over HTTP). |
| **(yours)** seeded login, env var table, concurrency-only command, assumptions, built extensions, "no starter template" line | ✅ All in. The env table is guarded by a new unit test (below). |
| **(yours)** extensions under the **brief's names**: Abuse protection (partial), Observability (partial) | ✅ A table with every extension from the brief: two partial, Accessibility "not claimed", E2E/CI and load test "next", the rest not built. |
| One Known gaps list; design §11 links to it | ✅ README "Known gaps" (not built / security trade-offs / operations), with deployment added. Design §11 now only links there. |
| Remove `isCanonicalTimeZone` | ✅ Removed. The module comment now says why strict `supportedValuesOf` is not used. |
| Replace the `index.html` placeholder | ✅ Description, `<noscript>`, an inline SVG icon. (Correction from my plan: the Phase 1 placeholder page was already gone; the shell was bare.) |
| pnpm native-build config only if needed | ✅ **Needed**, but changed: see "What I found". |
| **(yours)** 20× loop of the concurrency + clock files, including confirm/cancel/reschedule races | ✅ `pnpm test:concurrency`, 12 files / 86 tests. **20/20 green, no flakes.** See "Flake check". |
| **(yours)** how long `pnpm test` takes | ✅ See "Timing". |
| **(yours)** remove the scratch clone and its volume | ✅ Removed the clone's containers, network, volume (`slotbook-clone_pgdata`) and its locally built image. Your dev volume `slotbook_pgdata` was checked by name first and is untouched. |

## What I found

1. **`/favicon.ico` returned the app's HTML with a 200** (any missing file did, e.g. a stale `/assets/x.js` after a deploy). A browser would get HTML where it expects an icon or a script. **Fix:** the SPA fallback now skips paths whose last segment contains a dot, and those get the JSON 404. Safe because host and event slugs are `[a-z0-9-]` (DB CHECK + API schema). The page also has an inline icon now, so browsers don't ask for `/favicon.ico` at all. **There was no test of the SPA fallback before**; there is now (page routes → shell, real asset → served with its JS type, missing files → 404). Mutation-checked: with the old handler the 404 test fails.
2. **The pnpm build config is needed, but `esbuild: true` was not.** In a scratch copy without the file, `pnpm install --frozen-lockfile` **fails** on pnpm 12 (`ERR_PNPM_IGNORED_BUILDS: cpu-features, esbuild, protobufjs, ssh2`). With `esbuild: false`, `tsx` still runs (the binary comes from the optional `@esbuild/linux-x64` package), and the Docker image builds the server and SPA. So all four are now **denied**, and the file explains why it must exist. No third-party install script runs any more.
3. **A wrong expectation in my new SPA test:** I asserted `text/javascript`; @fastify/static sends `application/javascript`. The test now accepts either. The server was right.
4. **A wrong statement in my Phase 7+8 questions** ("placeholder text in `index.html`"), corrected in the plan before any work.

## Flake check (before CI)

`pnpm test:concurrency` = 12 files where requests race or real time matters (holds-concurrency, holds-idempotency, holds-ip-cap, holds-clock, holds-lock-timeout, write-tx, **confirm, cancel, reschedule**, sweeper, cross-cutting, api/guest-http). Each run started its own fresh Postgres container. No retries are configured.

**Result: 20 of 20 runs green, 86 tests per run = 1,720 test executions, 0 failures, 0 retries.** Run times 36–41 s.

The slowest tests (max / median over 20 runs). All are far below the 30 s test timeout:

| Test | max | median |
|---|---|---|
| R1: 50 parallel holds for the last seat | 3.19 s | 2.24 s |
| the default lock_timeout is 2.5 s (it waits for it on purpose) | 2.63 s | 2.58 s |
| 80-hold burst with the default lock_timeout | 2.33 s | 1.90 s |
| R1 over HTTP, 20 parallel requests | 1.83 s | 1.15 s |
| old hold expires while a new hold waits for the lock | 1.54 s | 1.47 s |
| **hold expires WHILE confirm waits on the lock** (your named test) | 0.82 s | 0.80 s, 20/20 passed, min 0.75 s |

Honest caveats:
- During most of the loop I was also working on the machine (editing `app.ts`/`config.ts`, unit and HTTP test runs, a Docker image build and a compose stack). Those edits don't touch any locking or booking code, and the extra load makes timing races *more* likely, not less, but the runs were not on an idle machine.
- **Residual risk, not a flake seen:** the "expires WHILE confirm waits" test gives the hold a 600 ms life and asserts, after a 100 ms sleep, that it has not expired yet (so the test can't pass vacuously). A stall of more than ~500 ms at that moment would fail it loudly. Locally the test takes 0.76–0.82 s. The holds-clock equivalent uses 1200 ms. For slower CI runners I'd suggest widening both (cost: ~1 s per run). Not changed in this phase.

## Timing

Machine: Intel Core 5 210H, 12 threads, 11 GiB RAM, Docker 29.9 on WSL2, Node 26.13, pnpm 12.18. The machine was idle apart from the run.

| | wall clock |
|---|---|
| `pnpm test`, run 1 / 2 / 3 | **126 s / 144 s / 126 s** (401 tests) |
| unit project alone | 4 s |
| integration project alone | 96 s |
| web project alone | 31 s |
| one container start + migrate + the smoke file | 6.5 s |
| `pnpm test:concurrency` | 36–41 s |

Integration dominates. Its files run one at a time because they share one database, and many tests wait on purpose (lock timeouts, expiry windows).

## Test results
```
pnpm test → Test Files 48 passed (48) · Tests 401 passed (401) · 3 consecutive green runs
  new: readme-env (4, unit), SPA serving (2, integration)
pnpm test:concurrency × 20 → 20/20 green, 0 failures
typecheck · lint · build → clean
clean clone → docker compose up --build → migrate, seed, /health OK; the README tour works over HTTP:
  slots (Berlin) · hold 201 · same slot 409 · confirm → /manage# · manage GET · demo login · host sees 1 booking
  · /favicon.ico 404 · page has the icon and <noscript>
```

## Commits
```
5214ed5 test: pnpm test:concurrency runs the race, lock and clock test files
1b512ed chore: remove the unused isCanonicalTimeZone helper
6c88c9b chore(pnpm): deny every dependency install script, with a comment on why the list must exist
5a0d5ac fix(http): a missing file (/favicon.ico, stale asset) is a 404, not the SPA shell; finish index.html
682f51e docs: README (run, tests, API, tour, configuration, assumptions, extensions, known gaps)
09d80d3 test: README configuration table must list every env var the code reads
85ac353 docs(design): known gaps now live only in the README
9d3406c docs(readme): measured test durations
(+ this summary and AI_LOG)
```

Also checked, nothing changed: no TODO/FIXME left in the code. A scan for exports nothing imports found only types and constants used inside their own module, so I left them.

## Changes from the design
- Design §11's known-gaps list is replaced by a link to the README section (single source).
- `pnpm-workspace.yaml` now denies every install script (was: esbuild allowed).
- The SPA fallback no longer answers file-like paths.

## Open questions for the next phase (Playwright + GitHub Actions CI)
1. **Timing windows on CI runners.** Widen the two "expires while waiting for the lock" windows (600 ms → ~2 s for confirm, 1200 ms → ~2 s for holds) before CI, or first see whether GitHub's runners need it?
2. **CI layout:** one workflow on every push. Job 1: install, typecheck, lint, build, `pnpm test` (Testcontainers works on `ubuntu-latest`, which has Docker). Job 2: Playwright against `docker compose up --build`. Two jobs in parallel, or one sequential job?
3. **The GitHub repo** doesn't exist yet. Will you create it and add the remote, or should I (`gh repo create`, public, as the brief asks)? Pushing is outward-facing, so I won't do it without your word.
