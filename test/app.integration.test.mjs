import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { test } from 'node:test';
import { closePool } from '../lib/db.mjs';
import { rootDir } from '../lib/env.mjs';
import { clearRateLimits } from '../lib/rate-limit.mjs';
import { applySchema } from '../lib/schema.mjs';
import { handleRequest } from '../server.mjs';

const hasDb = Boolean(process.env.DATABASE_URL);

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: rootDir,
    encoding: 'utf8',
    env: { ...process.env, APP_BASE_URL: 'http://127.0.0.1:3000', NODE_ENV: 'test' }
  });
}

function tokenFrom(output) {
  const match = output.match(/https?:\/\/\S+/);
  assert.ok(match, output);
  return new URL(match[0]).searchParams.get('token');
}

async function request(base, path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json, setCookie: response.headers.getSetCookie?.() || [] };
}

function sessionCookie(setCookie) {
  const raw = setCookie.find(value => value.startsWith('precocerto_session='));
  assert.ok(raw);
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Lax/);
  return raw.split(';')[0];
}

test('schema, senha por link e dados isolados por conta', { skip: hasDb ? false : 'DATABASE_URL não definida' }, async () => {
  clearRateLimits();
  await applySchema();
  await applySchema();
  const email = `celia.${randomUUID()}@example.com`;
  const otherEmail = `outra.${randomUUID()}@example.com`;
  const password = 'senha-segura-1';
  const replacement = 'senha-segura-2';
  const server = createServer((request, response) => handleRequest(request, response));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const first = run('scripts/seed-user.mjs', ['--name', 'Celia Teste', '--email', email]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /sem senha definida/);
    assert.doesNotMatch(first.stdout, /senha-segura/);
    const expiredToken = tokenFrom(first.stdout);
    const second = run('scripts/seed-user.mjs', ['--name', 'Celia Teste', '--email', email]);
    assert.equal(second.status, 0, second.stderr);
    const token = tokenFrom(second.stdout);
    assert.notEqual(token, expiredToken);

    const stale = await request(base, `/api/password-token?token=${encodeURIComponent(expiredToken)}`);
    assert.equal(stale.status, 400);
    const preview = await request(base, `/api/password-token?token=${encodeURIComponent(token)}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.json.email, email);
    assert.equal(preview.json.purpose, 'invite');

    const created = await request(base, '/api/password', { method: 'POST', body: { token, password } });
    assert.equal(created.status, 200);
    assert.equal(created.json.user.role, 'admin');
    assert.equal(created.json.user.name, 'Celia Teste');
    const cookie = sessionCookie(created.setCookie);
    const reused = await request(base, '/api/password', { method: 'POST', body: { token, password: replacement } });
    assert.equal(reused.status, 400);

    const stored = await db.query('select id, password_hash from public.users where email = $1', [email]);
    assert.match(stored.rows[0].password_hash, /^scrypt\$/);
    assert.notEqual(stored.rows[0].password_hash, password);
    const hashes = await db.query('select token_hash from public.password_tokens where user_id = $1', [stored.rows[0].id]);
    for (const row of hashes.rows) {
      assert.notEqual(row.token_hash, token);
      assert.notEqual(row.token_hash, expiredToken);
    }

    const wrong = await request(base, '/api/login', { method: 'POST', body: { email, password: 'senha-errada-1' } });
    assert.equal(wrong.status, 401);
    const logged = await request(base, '/api/login', { method: 'POST', body: { email, password } });
    assert.equal(logged.status, 200);
    const loginCookie = sessionCookie(logged.setCookie);

    const ingredientId = randomUUID();
    const productId = randomUUID();
    const snapshot = {
      ingredients: [
        { id: ingredientId, name: 'Açúcar', price: 10, unit: 'g', amount: 1000 },
        { id: randomUUID(), name: 'Farinha', price: 8, unit: 'g', amount: 1000 }
      ],
      products: [{ id: productId, name: 'Bolo', yield: 12, items: [{ ingredientId, amount: 200 }] }],
      production: [{ id: randomUUID(), productId, quantity: 3 }]
    };
    assert.equal((await request(base, '/api/state', { method: 'PUT', cookie: loginCookie, body: snapshot })).status, 200);
    const loaded = await request(base, '/api/state', { cookie: loginCookie });
    assert.deepEqual(loaded.json.ingredients.map(item => item.name), ['Açúcar', 'Farinha']);
    assert.equal(loaded.json.products[0].items[0].amount, 200);
    assert.equal(loaded.json.production[0].quantity, 3);

    const invalid = { ...snapshot, ingredients: [{ ...snapshot.ingredients[0], unit: 'kg' }] };
    assert.equal((await request(base, '/api/state', { method: 'PUT', cookie: loginCookie, body: invalid })).status, 400);
    const kept = await request(base, '/api/state', { cookie: loginCookie });
    assert.equal(kept.json.ingredients.length, 2);

    await assert.rejects(db.query(
      'select public.save_price_state($1::uuid, $2::jsonb)',
      [stored.rows[0].id, JSON.stringify({ ingredients: [{ id: randomUUID(), name: '', price: 1, unit: 'g', amount: 1 }], products: [], production: [] })]
    ));
    const afterRollback = await db.query('select count(*)::int as total from public.ingredients where user_id = $1', [stored.rows[0].id]);
    assert.equal(afterRollback.rows[0].total, 2);
    await applySchema();
    const afterSchema = await request(base, '/api/state', { cookie: loginCookie });
    assert.equal(afterSchema.json.products[0].name, 'Bolo');

    const other = run('scripts/seed-user.mjs', ['--name', 'Outra Pessoa', '--email', otherEmail, '--role', 'user']);
    assert.equal(other.status, 0, other.stderr);
    const otherToken = tokenFrom(other.stdout);
    const otherCreated = await request(base, '/api/password', { method: 'POST', body: { token: otherToken, password } });
    const otherCookie = sessionCookie(otherCreated.setCookie);
    const otherState = await request(base, '/api/state', { cookie: otherCookie });
    assert.deepEqual(otherState.json, { ingredients: [], products: [], production: [] });

    const reset = run('scripts/password-link.mjs', ['--email', email]);
    assert.equal(reset.status, 0, reset.stderr);
    assert.match(reset.stdout, /redefinição de senha/);
    const resetToken = tokenFrom(reset.stdout);
    assert.equal((await request(base, '/api/login', { method: 'POST', body: { email, password } })).status, 200);
    const changed = await request(base, '/api/password', { method: 'POST', body: { token: resetToken, password: replacement } });
    assert.equal(changed.status, 200);
    assert.equal((await request(base, '/api/state', { cookie: loginCookie })).status, 401);
    assert.equal((await request(base, '/api/login', { method: 'POST', body: { email, password } })).status, 401);
    const renewed = await request(base, '/api/login', { method: 'POST', body: { email, password: replacement } });
    assert.equal(renewed.status, 200);
    assert.equal((await request(base, '/api/state', { cookie: sessionCookie(renewed.setCookie) })).json.products[0].name, 'Bolo');

    const again = run('scripts/seed-user.mjs', ['--name', 'Celia Teste', '--email', email]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /já tem senha/);
    assert.doesNotMatch(again.stdout, /definir-senha/);
  } finally {
    await db.query('delete from public.users where email = any($1::text[])', [[email, otherEmail]]);
    await db.end();
    await new Promise(resolve => server.close(resolve));
    await closePool();
  }
});
