#!/usr/bin/env bash
# pnpm e2e [playwright args…]
#
# Runs the Playwright guest-flow tests against the PRODUCTION Docker build, exactly what
# `docker compose up` starts, but as a separate compose project ("slotbook-e2e") on its own
# ports, so the dev stack and its volume (slotbook_pgdata) are never touched.
#
# Every run starts from an empty database and ends with `down -v` on the e2e project only
# (agreed in Phase 10). Set E2E_KEEP=1 to leave the stack running for debugging.
set -euo pipefail
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=slotbook-e2e
export APP_PORT="${E2E_APP_PORT:-3100}"
export DB_PORT="${E2E_DB_PORT:-5433}"
export APP_ORIGIN="http://localhost:${APP_PORT}"
export E2E_BASE_URL="${APP_ORIGIN}"
# A real random secret (not the public compose default, which would log the INSECURE warning).
APP_SECRET="$(node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))")"
export APP_SECRET

mkdir -p test-results
teardown() {
  local status=$?
  docker compose logs --no-color app > test-results/compose-app.log 2>&1 || true
  if [ "${E2E_KEEP:-}" = "1" ]; then
    echo "[e2e] E2E_KEEP=1: leaving ${COMPOSE_PROJECT_NAME} running on ${APP_ORIGIN}"
  else
    docker compose down -v --remove-orphans > /dev/null 2>&1 || true
  fi
  exit "$status"
}
trap teardown EXIT

# Never reuse a leftover e2e database (e.g. after a killed run): start from empty.
docker compose down -v --remove-orphans > /dev/null 2>&1 || true
docker compose up --build -d

echo "[e2e] waiting for ${APP_ORIGIN}/health"
for _ in $(seq 1 120); do
  if curl -sf "${APP_ORIGIN}/health" > /dev/null; then break; fi
  sleep 1
done
curl -sf "${APP_ORIGIN}/health" > /dev/null || { echo "[e2e] app did not become healthy"; exit 1; }

pnpm exec playwright test "$@"
