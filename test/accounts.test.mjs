import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localUrlWarning, optionMap, passwordLink } from '../lib/accounts.mjs';
import { originAllowed, readCookie, sessionCookie } from '../lib/cookies.mjs';
import { clearRateLimits, isLimited, recordFailure } from '../lib/rate-limit.mjs';

test('argumentos do cadastro aceitam espaço no nome', () => {
  assert.deepEqual(optionMap(['--name', 'Celia Matias', '--email=celiamatias46@gmail.com', '--role', 'admin']), {
    name: 'Celia Matias',
    email: 'celiamatias46@gmail.com',
    role: 'admin'
  });
});

test('link de senha usa a URL pública e avisa endereço local', () => {
  const previous = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = 'https://precocerto.exemplo.com/';
  try {
    assert.equal(passwordLink('abc_DEF-123'), 'https://precocerto.exemplo.com/definir-senha?token=abc_DEF-123');
    assert.match(localUrlWarning('http://127.0.0.1:3000'), /AVISO/);
    assert.equal(localUrlWarning('https://precocerto.exemplo.com'), '');
  } finally {
    if (previous === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous;
  }
});

test('cookie de sessão é httpOnly e o host da origem precisa bater', () => {
  const cookie = sessionCookie('token', { maxAge: 10, secure: true });
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal(readCookie(cookie, 'precocerto_session'), 'token');
  const allowed = originAllowed({ headers: { origin: 'https://app.exemplo.com', host: 'app.exemplo.com' } });
  const blocked = originAllowed({ headers: { origin: 'https://outro.exemplo', host: 'app.exemplo.com' } });
  assert.equal(allowed, true);
  assert.equal(blocked, false);
});

test('limite de tentativas não conta antes da falha', () => {
  clearRateLimits();
  assert.equal(isLimited('login:a@b.com', 2, 1000), false);
  recordFailure('login:a@b.com', 1000);
  assert.equal(isLimited('login:a@b.com', 2, 1000), false);
  recordFailure('login:a@b.com', 1000);
  assert.equal(isLimited('login:a@b.com', 2, 1000), true);
});
