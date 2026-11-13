import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, hashToken, newToken, verifyPassword } from '../lib/passwords.mjs';

test('senha fica em scrypt e a conferência distingue a senha certa', async () => {
  const password = 'senha-segura';
  const stored = await hashPassword(password);
  assert.match(stored, /^scrypt\$16384\$8\$1\$/);
  assert.equal(stored.includes(password), false);
  assert.equal(await verifyPassword(password, stored), true);
  assert.equal(await verifyPassword('outra-senha-xx', stored), false);
  assert.equal(await verifyPassword(password, 'texto-puro'), false);
});

test('token de sessão não é o valor guardado', () => {
  const token = newToken();
  const stored = hashToken(token);
  assert.notEqual(stored, token);
  assert.match(stored, /^[a-f0-9]{64}$/);
});
