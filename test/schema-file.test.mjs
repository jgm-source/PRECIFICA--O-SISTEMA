import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('a migration recria o domínio sem Supabase', async () => {
  const sql = await readFile(new URL('../db/migrations/001_init.sql', import.meta.url), 'utf8');
  for (const name of ['users', 'sessions', 'password_tokens', 'ingredients', 'products', 'product_ingredients', 'production_items', 'save_price_state', 'load_price_state']) {
    assert.match(sql, new RegExp(name));
  }
  assert.match(sql, /create table if not exists/i);
  assert.match(sql, /create or replace function/i);
  const executable = sql.replace(/--.*$/gm, '');
  assert.doesNotMatch(executable, /auth\.users|supabase|service_role|\banon\b/i);
  assert.match(sql, /password_hash text/);
});
