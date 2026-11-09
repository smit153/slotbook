#!/usr/bin/env bash
# pnpm loadtest: k6 (grafana/k6 Docker image) against the compose PRODUCTION build.
#
# Stack: docker-compose.yml + loadtest/compose.load.yml as the separate project "slotbook-load"
# (app :3200, db :5434). Postgres runs on tmpfs, so nothing is left on disk and no volume needs
# deleting; the dev stack and its volume are never touched.
#
# Runs (each followed by a read-only invariant check of the database, scripts/loadtest-verify.ts):
#   many-25 … many-N  many hosts at a constant arrival rate (iterations/s; 3 requests each)
#   busy-20, busy-50  one host, 20 / 50 virtual users racing for its next 10 free slots
#   mixed             busy (50 VUs) + many hosts at 25/s in the background
#   pool30-*          the heaviest "many" run and "mixed" again with DB_POOL_MAX=30 (default 10)
# Raw k6 summaries: loadtest/results/ (gitignored); table: loadtest/RESULTS.md (pnpm loadtest:report).
set -euo pipefail
cd "$(dirname "$0")/.."

K6_IMAGE="grafana/k6:2.3.0"
export COMPOSE_PROJECT_NAME=slotbook-load
export APP_PORT="${LOAD_APP_PORT:-3200}"
export DB_PORT="${LOAD_DB_PORT:-5434}"
APP_SECRET="$(node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))")"
export APP_SECRET
DURATION="${DURATION:-45s}"
RATES="${RATES:-25 50 100 200}"
HOSTS="${HOSTS:-200}"
COMPOSE=(docker compose -f docker-compose.yml -f loadtest/compose.load.yml)
DB_URL="postgres://slotbook:slotbook@localhost:${DB_PORT}/slotbook"
RESULTS="$PWD/loadtest/results/$(date -u +%Y%m%dT%H%M%SZ)" # one folder per run; the report reads the latest

mkdir -p "$RESULTS" && chmod 777 "$RESULTS" # the k6 container runs as a non-root user
teardown() { "${COMPOSE[@]}" down --remove-orphans > /dev/null 2>&1 || true; }
trap teardown EXIT

wait_healthy() {
  for _ in $(seq 1 120); do curl -sf "http://localhost:${APP_PORT}/health" > /dev/null && return 0; sleep 1; done
  echo "[loadtest] app did not become healthy"; return 1
}

run() { # run <name> KEY=VALUE…
  local name=$1; shift
  local envs=(-e "RUN_NAME=$name" -e "DURATION=$DURATION" -e "HOSTS=$HOSTS" -e "BASE_URL=http://app:3000")
  for kv in "$@"; do envs+=(-e "$kv"); done
  echo "[loadtest] ── $name ($*)"
  docker run --rm --network "${COMPOSE_PROJECT_NAME}_default" -v "$PWD/loadtest:/scripts:ro" -v "$RESULTS:/results" \
    "${envs[@]}" "$K6_IMAGE" run --quiet /scripts/booking.js || echo "[loadtest] k6 exited non-zero for $name (thresholds?)"
  DATABASE_URL="$DB_URL" pnpm -s exec tsx scripts/loadtest-verify.ts | tee "$RESULTS/$name.verify.json"
}

teardown
"${COMPOSE[@]}" up --build -d
wait_healthy
DATABASE_URL="$DB_URL" pnpm -s exec tsx scripts/loadtest-seed.ts "$HOSTS"
"${COMPOSE[@]}" exec -T db psql -U slotbook -d slotbook -tAc "SELECT 'postgres ' || current_setting('server_version') || ', max_connections ' || current_setting('max_connections')" | tee "$RESULTS/env.txt"

for r in $RATES; do run "many-$r" SCENARIO=many "RATE=$r"; done
run busy-20 SCENARIO=busy VUS=20
run busy-50 SCENARIO=busy VUS=50
run mixed SCENARIO=mixed VUS=50 RATE=25

# Pool sizing: same app, bigger pool.
top="${RATES##* }"
DB_POOL_MAX=30 "${COMPOSE[@]}" up -d app
wait_healthy
run "pool30-many-$top" SCENARIO=many "RATE=$top"
run pool30-mixed SCENARIO=mixed VUS=50 RATE=25

echo "[loadtest] done; results in ${RESULTS#$PWD/}"
