import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK = 8;
const SCRYPT_PARALLEL = 1;
const KEY_LENGTH = 64;

export function newToken() {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function hashTokenIfValid(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
  return hashToken(token);
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LENGTH, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK,
    parallelization: SCRYPT_PARALLEL,
    maxmem: 128 * 1024 * 1024
  });
  return [
    'scrypt',
    SCRYPT_COST,
    SCRYPT_BLOCK,
    SCRYPT_PARALLEL,
    salt.toString('base64url'),
    Buffer.from(hash).toString('base64url')
  ].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelization = Number(parts[3]);
  if (!Number.isInteger(cost) || cost < 16384 || cost > 131072) return false;
  if (!Number.isInteger(blockSize) || blockSize < 1 || blockSize > 8) return false;
  if (!Number.isInteger(parallelization) || parallelization < 1 || parallelization > 4) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64url');
    expected = Buffer.from(parts[5], 'base64url');
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;
  const actual = Buffer.from(await scryptAsync(password, salt, expected.length, {
    cost,
    blockSize,
    parallelization,
    maxmem: 128 * 1024 * 1024
  }));
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
