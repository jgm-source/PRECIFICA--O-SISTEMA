import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { rootDir } from '../lib/env.mjs';

function run(script, args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: rootDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      APP_BASE_URL: 'https://precocerto.exemplo.com',
      DATABASE_URL: 'postgres://postgres:local-only@127.0.0.1:1/criadordigital',
      ...env
    }
  });
}

test('o cadastro recusa e-mail inválido sem definir senha', () => {
  const result = run('scripts/seed-user.mjs', ['--name', 'Celia Matias', '--email', 'invalido']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /e-mail válido/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /local-only/);
});

test('o cadastro exige a URL pública', () => {
  const result = run('scripts/seed-user.mjs', ['--name', 'Celia Matias', '--email', 'celiamatias46@gmail.com'], { APP_BASE_URL: '' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /APP_BASE_URL/);
});

test('o link de senha exige um e-mail', () => {
  const result = run('scripts/password-link.mjs', []);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /e-mail válido/);
});
