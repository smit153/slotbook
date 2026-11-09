// k6 load test of the booking path: GET slots → POST hold → POST confirm.
// Run through scripts/loadtest.sh (grafana/k6 in Docker against the compose production build).
//
// SCENARIO (env):
//   many   – constant arrival RATE iterations/s, each on a random one of HOSTS hosts and a random
//            day in the next 30, then a random free slot that day (little contention).
//   busy   – VUS virtual users loop on ONE host and race for the first 10 free slots
//            (heavy contention on one host lock: lots of 409, maybe 503).
//   mixed  – both at once: "busy" with VUS users AND "many" at RATE/s; the "many" requests are
//            tagged flow=background so their latency shows whether one hot host slows the others.
//
// Status classes (counted separately):
//   ok (200/201), conflict (409 = someone else got the slot: expected under contention),
//   busy (503 HOST_BUSY / TRY_AGAIN: the designed fail-fast), expired (410), limited (429),
//   real_errors (anything else, incl. 5xx and network errors). Threshold: real_errors == 0.
import http from 'k6/http';
import exec from 'k6/execution';
import { Counter, Rate } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://app:3000';
const SCENARIO = __ENV.SCENARIO || 'many';
const DURATION = __ENV.DURATION || '45s';
const RATE = Number(__ENV.RATE || 50);
const VUS = Number(__ENV.VUS || 20);
const HOSTS = Number(__ENV.HOSTS || 200);

const okCount = new Counter('status_ok');
const conflict = new Counter('status_409');
const busy503 = new Counter('status_503');
const expired410 = new Counter('status_410');
const limited429 = new Counter('status_429');
const realErrors = new Counter('real_errors');
const realErrorRate = new Rate('real_error_rate');
const confirmed = new Counter('bookings_confirmed');

const manyScenario = (tags) => ({
  executor: 'constant-arrival-rate', exec: 'many', rate: RATE, timeUnit: '1s', duration: DURATION,
  preAllocatedVUs: Math.max(50, RATE), maxVUs: Math.max(400, RATE * 4), tags,
});
const busyScenario = (tags) => ({ executor: 'constant-vus', exec: 'busy', vus: VUS, duration: DURATION, tags });

const scenarios = {
  many: { many: manyScenario({ flow: 'many' }) },
  busy: { busy: busyScenario({ flow: 'busy' }) },
  mixed: { busy: busyScenario({ flow: 'busy' }), background: manyScenario({ flow: 'background' }) },
}[SCENARIO];
if (!scenarios) throw new Error(`unknown SCENARIO ${SCENARIO}`);

// (The tag is "flow", not "group": "group" is a reserved k6 system tag and gets overwritten.)
// Per-endpoint and per-flow latency sub-metrics only show in the summary if a threshold names
// them; these thresholds are deliberately loose (reporting, not pass/fail), except real errors.
const thresholds = { real_errors: ['count==0'] };
for (const name of ['slots', 'hold', 'confirm']) {
  thresholds[`http_req_duration{name:${name}}`] = ['p(95)<60000'];
  for (const g of ['many', 'busy', 'background']) thresholds[`http_req_duration{name:${name},flow:${g}}`] = ['p(95)<60000'];
}
for (const g of ['many', 'busy', 'background']) thresholds[`iterations{flow:${g}}`] = ['count>=0'];

export const options = {
  scenarios,
  thresholds,
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  discardResponseBodies: false,
};

/** One fake client IP per VU: the app runs with TRUST_PROXY=1 and takes it from X-Forwarded-For. */
function clientIp() {
  const n = exec.vu.idInTest;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

function classify(res) {
  const s = res.status;
  if (s === 200 || s === 201) okCount.add(1);
  else if (s === 409) conflict.add(1);
  else if (s === 503) busy503.add(1);
  else if (s === 410) expired410.add(1);
  else if (s === 429) limited429.add(1);
  else {
    realErrors.add(1); realErrorRate.add(1);
    // status 0 = no HTTP response (network error, k6 timeout, or a request cut off when the run stops)
    console.error(`real error: ${res.request.method} ${res.url} → ${s} error_code=${res.error_code} ${res.error || String(res.body).slice(0, 200)}`);
    return;
  }
  realErrorRate.add(0);
}

const iso = (ms) => new Date(ms).toISOString();

function slotsFor(host, fromMs, toMs, headers) {
  const res = http.get(`${BASE}/api/hosts/${host}/events/call/slots?from=${iso(fromMs)}&to=${iso(toMs)}&tz=UTC`, { headers, tags: { name: 'slots' } });
  classify(res);
  return res.status === 200 ? res.json('slots') : [];
}

function holdAndConfirm(host, slot, headers) {
  const key = `k6-${exec.vu.idInTest}-${exec.scenario.iterationInTest}-${Date.now()}`;
  const hold = http.post(`${BASE}/api/holds`, JSON.stringify({ host, slug: 'call', start_at: slot.start_at }), {
    headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': key }, tags: { name: 'hold' },
  });
  classify(hold);
  if (hold.status !== 201) return;
  const { hold_id, hold_secret } = hold.json();
  const conf = http.post(`${BASE}/api/holds/${hold_id}/confirm`, JSON.stringify({
    hold_secret, name: `k6 guest ${exec.vu.idInTest}`, email: `vu${exec.vu.idInTest}@loadtest.test`, tz: 'UTC',
  }), { headers: { ...headers, 'Content-Type': 'application/json' }, tags: { name: 'confirm' } });
  classify(conf);
  if (conf.status === 200) confirmed.add(1);
}

export function many() {
  const headers = { 'X-Forwarded-For': clientIp() };
  const host = `load-${String(1 + Math.floor(Math.random() * HOSTS)).padStart(3, '0')}`;
  const day = Date.now() + Math.floor(Math.random() * 30) * 86_400_000;
  const slots = slotsFor(host, day, day + 86_400_000, headers);
  if (slots.length === 0) return;
  holdAndConfirm(host, slots[Math.floor(Math.random() * slots.length)], headers);
}

// Busy users look at one day at a time and move on to the next day once it is full, so the
// race is always for the host's next ~10 free slots (the host has 365 days of 24/7 slots).
let busyDay = 0;
export function busy() {
  const headers = { 'X-Forwarded-For': clientIp() };
  const from = Date.now() + busyDay * 86_400_000;
  const slots = slotsFor('load-busy', from, from + 86_400_000, headers);
  if (slots.length === 0) { busyDay += 1; return; }
  holdAndConfirm('load-busy', slots[Math.floor(Math.random() * Math.min(10, slots.length))], headers);
}

export function handleSummary(data) {
  const out = `/results/${__ENV.RUN_NAME || SCENARIO}.json`;
  return { [out]: JSON.stringify(data, null, 1), stdout: `[k6] summary written to ${out}\n` };
}
