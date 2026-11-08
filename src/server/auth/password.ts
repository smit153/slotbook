import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with Node's built-in scrypt (no native addon to build).
 * Stored format: scrypt$<log2N>$<r>$<p>$<salt b64>$<hash b64>
 *
 * Parameters: N = 2^15, r = 8, p = 3 — one of OWASP's equivalent scrypt minimums
 * (N=2^17,p=1 ≈ N=2^16,p=2 ≈ N=2^15,p=3). It uses 32 MiB per lane instead of 128 MiB,
 * which suits small instances. Parameters travel with each hash, so they can be
 * raised later without breaking existing hashes.
 */
const LOG2_N = 15;
const R = 8;
const P = 3;
const KEYLEN = 32;
const SALT_BYTES = 16;

// Bounds for parameters read back from the DB, so a corrupted/hostile row can't make
// verify() allocate gigabytes.
const MAX_LOG2_N = 17;
const MAX_R = 16;
const MAX_P = 4;

/** scrypt needs ~128·N·r bytes; Node's default 32 MiB cap is too tight for N=2^15,r=8. */
function maxmemFor(n: number, r: number): number {
  return 128 * n * r * 2;
}

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const n = 2 ** LOG2_N;
  const key = await scrypt(password, salt, KEYLEN, { N: n, r: R, p: P, maxmem: maxmemFor(n, R) });
  return ['scrypt', LOG2_N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Constant-time check. Returns false (never throws) for a wrong password or a malformed hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, log2nRaw, rRaw, pRaw, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const log2n = Number(log2nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (![log2n, r, p].every(Number.isInteger)) return false;
  if (log2n < 10 || log2n > MAX_LOG2_N || r < 1 || r > MAX_R || p < 1 || p > MAX_P) return false;

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  if (salt.length < 8 || expected.length < 16) return false;

  const n = 2 ** log2n;
  const actual = await scrypt(password, salt, expected.length, { N: n, r, p, maxmem: maxmemFor(n, r) });
  return timingSafeEqual(actual, expected);
}
