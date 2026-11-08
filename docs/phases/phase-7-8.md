# Phases 7 + 8: Host dashboard, guest booking + manage pages

**Status:** done (one combined summary, as agreed). All checks green (3 consecutive full runs + a compose boot). Waiting for review before Phase 9.

## Planned vs. actual

| Planned (+ your changes) | Actual |
|---|---|
| Plain React + react-router + one CSS file | ✅ React 19, react-router 8 (one shared route table), one `styles.css` (~80 lines), no UI library. |
| API client | ✅ `ApiError`. A 503 is retried once after `Retry-After` with the **same Idempotency-Key**; a 4xx is never retried. |
| Host dashboard, **times in the host's zone with the zone shown** | ✅ Login, guarded layout, bookings (grouped by host-local day, `09:00–09:30 EST`), event types, availability, settings, notifications. |
| **Single availability form, one request, inline errors** | ✅ Rows are checked on the client and highlighted, then one `PUT`. A server rejection is shown, the server keeps the old data, and the form keeps the edits. |
| Guest page, **browser zone, no localStorage** | ✅ A switcher, 30 days of slots by local day, seats left for group events. |
| **Fall-back duplicates labelled EDT/EST** | ✅ `01:00 EDT` / `01:00 EST` via the server's `ambiguous` flag. Tested in the browser test against the real API. |
| **(your change) Hold the NEW slot first, then release the old one** | ✅ On a 409 the guest keeps the old hold and nothing is released. **Web test added, and mutation-checked:** a release-first version fails it (`expected 'expired' to be 'held'`). |
| **keepalive release on `pagehide`** | ✅ `fetch(..., { keepalive: true })`. Tested: dispatching `pagehide` leaves the hold expired on the server. |
| Countdown from the server offset | ✅ `expires_at − server_now` on `performance.now()`. A unit test shows a browser clock 10 minutes off changes nothing. |
| Manage page | ✅ View, reschedule (same picker), cancel with an optional reason, read-only once started or cancelled, `noindex`. |
| **Tests: jsdom + `app.inject`, Playwright later** | ✅ The new `web` Vitest project: Testing Library in jsdom, `fetch` routed into the **real Fastify app + real test Postgres**, with a cookie jar and Origin, as a same-origin browser would send. |

## What worked
- The UI tests run against the *real* stack, not mocks: login, cookies, the Origin check, the host lock, the constraints and idempotency are all exercised from the UI.
- **Your 409 case:** the guest holds slot A, another guest takes slot B, then the guest clicks B. The page says "that time was just taken" and "You still have … held", and A is still `held` in the database, with no release call.
- **The 503 path through the UI:** with the host lock held, saving availability makes the client retry once (`PUT` → 503, 503) and then show "busy". The server kept the old availability and the form kept the edit.
- **Fall-back labels in the real picker:** the next US fall-back night (computed from the DB clock) renders `00:00, 00:30, 01:00 EDT, 01:30 EDT, 01:00 EST, 01:30 EST, 02:00, 02:30`.
- **Production image:** all SPA routes (`/`, `/login`, `/dashboard`, `/dashboard/availability`, `/demo/intro-30`, `/demo/workshop`, `/manage`) serve the app shell. JS and CSS load with the right content types, and unknown `/api/*` routes still return a JSON 404.

## What didn't, and the bugs found
1. **An accessibility bug in my slot picker, found by the tests.** I had put `role="listitem"` directly on the day and time `<button>`s. That removes their button role, and a list item gets no accessible name from its content, so screen readers would have announced unnamed list items. All 7 guest tests failed on it. **Fix:** real `<ul aria-label>` → `<li>` → `<button>` lists, with `aria-pressed` on the selected day and time.
2. **A refetch loop I caught in self-review before running.** `SlotPicker` listed the parent's `onLoaded` callback as an effect dependency, so an inline callback would refetch slots on every render. It is now kept in a ref.
3. **A badly designed test of mine.** My first "server rejects availability" test typed an impossible date. jsdom sanitises an invalid `<input type="date">` to empty, so the *client* check fired and the server was never called. The test also had a rambling comment. **Rewritten** with a rejection only the server can make (calendar busy because the host lock is held), which also exercises the client's 503 retry.
4. **A Fastify deprecation warning, FSTDEP024** (`requestIdLogLabel`), spotted in test output. Fixed with `logController: new LogController({ requestIdLogLabel: 'request_id' })`. The R21 log test confirms `request_id` is still logged.
5. **Typecheck setup:** the web tests needed their own tsconfig (DOM + JSX + Bundler), and it had to include `test/global-setup.ts` so the `inject('databaseUrl')` typing resolves.
6. **Design consequence:** the guest page shows only the next 30 days from the *browser's* today, so a fall-back night only appears when it is within 30 days. The EDT/EST web test therefore moves only the browser's `Date` (`vi.setSystemTime`, `Date` only) while the server keeps the real DB clock.
7. **For transparency, two file deletions:**
   - I deleted `test/web/debug.test.tsx`, a throwaway file I had created minutes earlier to debug bug 1. It was untracked and never committed.
   - I also ran an unnecessary `rm -f` on a non-existent `src/web/App.tsx.bak`, which deleted nothing.

   Neither touched any data of yours. I mention them because of your destructive-commands rule.

## Test results
```
pnpm test → Test Files 47 passed (47) · Tests 395 passed (395) · 3 consecutive green runs
  unit        138
  integration 226
  web          31  host-dashboard 8 · guest-booking 7 · manage 6 · lib 9 · zone 1
typecheck (server, web, web tests) · lint · build → clean · docker compose up --build → SPA + API OK
```
Not done: a walk-through in a **real browser**. All UI verification here is jsdom against the real API, plus HTTP checks of the built image. A real browser run is the Playwright extension.

## Commits
```
196d92d feat(web): API client, time helpers, countdown, availability checks + web test project
97b51aa fix(http): use LogController for requestIdLogLabel (Fastify 5 deprecation FSTDEP024)
b3a6330 feat(web): shared components and stylesheet
ba760b3 feat(web): host dashboard (login, bookings, event types, availability, settings, notifications)
bf82a15 feat(web): guest booking and manage pages, route table
940cbb2 test(web): guest booking flow against the real API (jsdom + app.inject)
32e27ec test(web): host dashboard against the real API
1ffa3c3 test(web): manage page against the real API
1957799 docs: frontend section as built (host dashboard, guest booking + manage, API client, tests)
(+ this summary and AI_LOG)
```

## Changes from the design
- Design §8 has been rewritten as built.
- No API changes were needed. The UI uses exactly the Phase 6 routes.

## Open questions for Phase 9 (README, cleanup, gaps)
1. **README:** how to run (compose, `pnpm dev`, `pnpm test`), an API table (from design §7), a "60-second tour" of the UI, the test layout, and the starter template (none). Anything else you want in it?
2. **Known-gaps list:** I'd collect the gaps from design §11 and every phase summary into one section of the README, to be reused in the report. OK?
3. **Cleanup candidates:**
   - the `isCanonicalTimeZone` helper is now unused
   - `pnpm-workspace.yaml` denies a few native builds
   - the placeholder text in `index.html`

   Remove or keep as documented?
