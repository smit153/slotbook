import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/server/auth/password.js';

const S = '$'; // field separator of the stored format
const stored = (...parts: Array<string | number>) => parts.join(S);
const SALT = Buffer.from('saltsaltsaltsalt').toString('base64');
const HASH = Buffer.from('hashhashhashhashhashhashhashhash').toString('base64');

describe('password hashing (scrypt)', () => {
  it('round-trips and rejects a wrong password', async () => {
    const h = await hashPassword('demo1234');
    expect(await verifyPassword('demo1234', h)).toBe(true);
    expect(await verifyPassword('demo1235', h)).toBe(false);
    expect(await verifyPassword('', h)).toBe(false);
  });

  it('uses OWASP-equivalent parameters (N=2^15, r=8, p=3) and a fresh salt each time', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
    expect(a.split(S).slice(0, 4)).toEqual(['scrypt', '15', '8', '3']);
  });

  it('normalises Unicode (NFKC) so visually identical passwords match', async () => {
    const h = await hashPassword('café'); // é precomposed
    expect(await verifyPassword('café', h)).toBe(true); // e + combining accent
  });

  it.each([
    ['empty', ''],
    ['wrong scheme', stored('bcrypt', 15, 8, 3, SALT, HASH)],
    ['too few parts', stored('scrypt', 15, 8, 3, SALT)],
    ['non-numeric params', stored('scrypt', 'x', 8, 3, SALT, HASH)],
    ['N too large (DoS guard)', stored('scrypt', 30, 8, 1, SALT, HASH)],
    ['p too large', stored('scrypt', 15, 8, 64, SALT, HASH)],
    ['tiny salt', stored('scrypt', 15, 8, 3, Buffer.from('a').toString('base64'), HASH)],
  ])('returns false (no throw) for a malformed stored hash: %s', async (_label, s) => {
    await expect(verifyPassword('demo1234', s)).resolves.toBe(false);
  });

  it('verifies a hash made with older parameters — params travel with each hash', async () => {
    const salt = randomBytes(16);
    const key = scryptSync('legacy', salt, 32, { N: 2 ** 14, r: 8, p: 1 });
    expect(await verifyPassword('legacy', stored('scrypt', 14, 8, 1, salt.toString('base64'), key.toString('base64')))).toBe(true);
  });
});
