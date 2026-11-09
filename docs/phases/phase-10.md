# Phase 10: Playwright + GitHub Actions CI (plus pre-push checks)

**Status:** done locally, all checks green. **CI has not run yet:** it needs a push, which waits for your go. Waiting for review before the k6 load-test plan.

## Pre-push checks (asked before this phase)

| Check | Result |
|---|---|
| Secret scan of the full history | gitleaks v8.21.2, then v8.30.1, over all refs: **1 finding, a false positive.** It is the made-up Idempotency-Key `'idem-key-SECRET-0123456789'` in `test/integration/api/logging.test.ts:26`, which the R21 test sends and then asserts never reaches the logs. Ignored by fingerprint in `.gitleaksignore`, with a comment saying why. Now "no leaks found" (96 commits). |
| `.env` / `slotbook.pdf` ever committed? | **No.** I listed every path in every commit (154 distinct paths). The only matches for env/pdf/key/secret patterns are `.env.example`, `src/server/auth/secrets.ts` and `test/unit/secrets.test.ts`. |
| Commit authors | All commits: author = committer = `smit sojitra <smitsojitra332003@gmail.com>` (from `~/.gitconfig`). 0 `Co-Authored-By` trailers. **Kept, as you decided.** |
| Unreachable objects | 4, my own `git stash` leftovers from a Phase 9 mutation check. A push never sends them. |
| Personal data in tracked files (checked again before suggesting a push) | Emails: only test fixtures, the lockfile, and the author email quoted once in AI_LOG. One local path (`/home/laptop/…`) appears in an early AI_LOG reply. Harmless; left as is unless you want it edited. |
| Remote | `origin = https://github.com/smit153/slotbook.git` added (your message). The repo is public and empty. **Nothing pushed.** |

## Planned vs. actual

| Planned (+ your changes) | Actual |
|---|---|
| **(yours)** widen both expiry windows to ~2 s | ✅ 600 ms → 2000 ms (confirm) and 1200 ms → 2000 ms (holds-clock). I also replaced fixed sleeps with "wait until a backend is blocked on a lock" in 3 tests. Mutation-checked: a stale clock still fails both. `test:concurrency` × 5: green. |
| **(yours)** loud warning when `APP_SECRET` is the compose default, plus the known-gap note | ✅ `!!! INSECURE: APP_SECRET is the PUBLIC default…` logged at `warn` with `security: true` when the app is built. Tests: a unit test of the rule; a test that the compose file and `.env.example` contain exactly that constant (no drift); an integration test that the warn line reaches the log. README known gap added. |
| Playwright, Chromium only, against the compose production build | ✅ `pnpm e2e` (`scripts/e2e.sh`): a separate compose project `slotbook-e2e` on :3100/:5433, a random `APP_SECRET` per run, waits for `/health`, and **`down -v` on that project at the start and end of every run** (agreed). Your `slotbook_pgdata` was checked after every batch and is untouched. |
| Tests 1–5 (guest flow, race, zones, wrong clock, leaving the page) | ✅ All in `e2e/guest.spec.ts`. |
| **(yours)** test 6 must not depend on test 1 | ✅ It books its own slot through the API, then checks the dashboard. **Verified: each of the 7 tests passes on its own, on a fresh stack and database.** |
| **(yours)** keyboard-only test | ✅ Tab/Enter/typing only, with no clicks and no programmatic focus: book → manage link → cancel. Every focused control must show a focus ring. |
| README: Accessibility partial | ✅ "keyboard flow tested, screen reader not". E2E/CI marked **Built**. Known gaps updated (Chromium only; screen reader not verified). |
| **(yours)** each action's current major, no deprecation warnings | ✅ Checked each action's latest release and its `action.yml` runtime: `actions/checkout@v7` (7.0.1), `actions/setup-node@v7` (7.1.0), `pnpm/action-setup@v6` (6.1.1), `actions/upload-artifact@v7` (7.0.2). **All on `node24`.** pnpm/action-setup's README mentions a newer `pnpm/setup`, but action-setup v6 still officially supports pnpm 12 with setup-node, so I kept the conventional pair. |
| **(yours)** gitleaks in CI via its Docker image | ✅ A step in the `test` job: `ghcr.io/gitleaks/gitleaks:v8.30.1` (latest), full history (`fetch-depth: 0`). |
| Two parallel jobs | ✅ `test` (secrets, typecheck, lint, build, `pnpm test`) and `e2e` (`pnpm e2e`, with the report, traces and compose log uploaded on failure). Runs on every push and pull request, `contents: read`, and a newer push cancels the run already going for the same branch. |
| Workflow validated | ✅ `actionlint` 1.7.12 (with shellcheck): 0 errors. **But a workflow is only really tested by GitHub running it** (see "Not done"). |

## What I found / what went wrong

1. **My first command to list every committed file was wrong.** `git ls-tree` takes one commit; the other hashes were read as *path filters*, so it silently checked one commit and matched nothing. I noticed because `.env.example` was missing from the output, and redid it per commit. The "never committed" result above comes from the corrected run.
2. **`pnpm/action-setup`'s README now recommends `pnpm/setup`.** I checked whether action-setup is deprecated: it isn't, and it states pnpm 12 support. Kept it.
3. **An e2e risk I designed around:** every request in the e2e run comes from one Docker-network IP, and the per-IP cap allows 3 active holds. So the tests run serially, and each test confirms or releases what it holds. The cap was not raised.
4. **All 7 e2e tests passed on the first run.** Because a first-time pass proves little, I **mutation-checked** two in a rebuilt image: with the countdown computed from the browser's clock, the clock test fails (`Held for` never matches); with the `pagehide` listener removed, the leaving-the-page test fails (the slot is never offered again). Both were restored before committing.
5. **zsh word splitting** broke a loop in my action-version lookup (empty results). I re-ran each lookup explicitly before relying on them.

## Test results
```
pnpm test (the CI "test" job's sequence: frozen install → typecheck → lint → build → test)
  → Test Files 48 passed (48) · Tests 405 passed (405) · 157 s total
  new: config (3 unit), startup warning in the log (1 integration)
pnpm e2e × 5 → 35/35 passed (40–58 s per run, including the image build)
each e2e test alone, fresh stack each → 7/7 passed
pnpm test:concurrency × 5 (after widening) → 5/5 green, ~43 s per run
typecheck (server, web, web tests, e2e) · lint · build · actionlint · gitleaks → clean
```

## Commits
```
fe8664a test: widen expiry-while-waiting windows to 2 s and wait for the lock waiter instead of fixed sleeps (CI reliability)
75a4124 docs: AI_LOG turn 22 (pre-push checks, Playwright + CI plan)
4031376 feat(security): loud startup warning when APP_SECRET is the public compose default
638e352 docs(readme): known gap: compose falls back to a public APP_SECRET
62bcfe5 chore(e2e): Playwright 1.64.1 (Chromium), pnpm e2e runs it against a separate compose project of the production build
465ec46 test(e2e): guest flow, same-slot race, browser time zones, wrong browser clock, release on leaving the page
fc0d3ba test(e2e): host login and booking list in the host zone (creates its own booking via the API)
5c315fc test(e2e): keyboard-only booking, manage link and cancel, with visible focus rings
aea4e6b ci: GitHub Actions with parallel test and e2e jobs, gitleaks scan of the full history
e761d09 docs(readme): e2e tests and CI; E2E/CI built, Accessibility partial; gaps updated
(+ this summary, a README timing line and AI_LOG)
```

## Not done
- **No CI run yet.** GitHub Actions only runs after a push. Everything the jobs do was run locally in the same order, but runner differences (Docker on `ubuntu-latest`, Testcontainers, browser dependencies, timing) only show on GitHub. When you say "push", I'll push `main` and report the first run: green/red, duration per job, and any warnings in the annotations.

## Changes from the design
- None to the booking design. New: the startup-warning hook in `buildApp`, a `packageManager` field (pnpm 12.18.0) in `package.json`, the e2e compose project, and `.gitleaksignore`.

## Open questions
1. **Push now?** `git push -u origin main` publishes all 103 commits. That starts the first CI run, which I'll watch and report on.
2. **The k6 phase** comes next: should I write its plan now, or after the first CI run is green?
