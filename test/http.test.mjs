import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { handleRequest } from '../server.mjs';

async function listen() {
  const server = createServer((request, response) => handleRequest(request, response));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('a tela de login substitui o Supabase e não publica arquivos internos', async () => {
  const { server, base } = await listen();
  try {
    const home = await fetch(`${base}/`);
    const html = await home.text();
    assert.equal(home.status, 200);
    assert.match(html, /Esqueci minha senha/);
    assert.match(html, /Defina sua senha/);
    assert.doesNotMatch(html, /supabase/i);
    assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);

    const passwordPage = await fetch(`${base}/definir-senha`);
    assert.match(await passwordPage.text(), /boot\.js/);
    const redirected = await fetch(`${base}/definir-senha/?token=abc`, { redirect: 'manual' });
    assert.equal(redirected.status, 302);
    assert.equal(redirected.headers.get('location'), '/definir-senha?token=abc');

    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/config`)).status, 404);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    assert.equal((await fetch(`${base}/lib/auth.mjs`)).status, 404);
    assert.equal((await fetch(`${base}/db/migrations/001_init.sql`)).status, 404);

    const forbidden = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ email: 'a@b.com', password: 'senha-segura' })
    });
    assert.equal(forbidden.status, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
