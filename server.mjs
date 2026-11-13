import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionTtlDays } from './lib/accounts.mjs';
import { getSessionUser, inspectPasswordToken, login, logout, setPassword } from './lib/auth.mjs';
import { cookieSecure, originAllowed, sessionCookie } from './lib/cookies.mjs';
import { loadEnv, rootDir } from './lib/env.mjs';
import { HttpError } from './lib/http-error.mjs';
import { isLimited, recordFailure } from './lib/rate-limit.mjs';
import { loadUserState, saveUserState } from './lib/state.mjs';

loadEnv();

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};
const spaRoutes = new Set(['/', '/definir-senha']);
const blocked = new Set(['node_modules', 'scripts', 'lib', 'db', 'test', '.git']);
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'"
};

function send(response, status, body, headers = {}, method = 'GET') {
  const head = { ...securityHeaders, ...headers };
  response.writeHead(status, head);
  response.end(method === 'HEAD' ? undefined : body);
}

function sendJson(response, status, payload, extraHeaders = {}, method = 'GET') {
  send(response, status, JSON.stringify(payload), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  }, method);
}

function publicError(error) {
  if (error instanceof HttpError || error.status) return error;
  const code = error.code;
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', '28P01', '3D000', '28000', '57P01', '53300'].includes(code)) {
    console.error('Falha de conexão com o banco:', code);
    return new HttpError(503, 'Não foi possível conectar ao banco de dados.');
  }
  if (code === '42P01' || code === '42883') {
    return new HttpError(503, 'O banco ainda não tem as tabelas. Execute npm run db:schema.');
  }
  console.error('Erro:', code || '', error.message);
  return new HttpError(500, 'Erro interno do servidor.');
}

function assertOrigin(request) {
  if (!originAllowed(request)) throw new HttpError(403, 'Origem não permitida.');
}

function clientKey(request) {
  return request.socket?.remoteAddress || 'local';
}

async function readJson(request) {
  const type = String(request.headers['content-type'] || '');
  if (!type.includes('application/json')) throw new HttpError(400, 'Envie os dados em JSON.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw new HttpError(413, 'Dados grandes demais.');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError(400, 'Dados inválidos.');
    return payload;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'JSON inválido.');
  }
}

function requireUser(user) {
  if (!user) throw new HttpError(401, 'Sua sessão expirou. Entre novamente.');
  return user;
}

async function handleApi(request, response, url) {
  const { method } = request;
  if (method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true }, {}, method);
    return;
  }
  if (method === 'GET' && url.pathname === '/api/session') {
    sendJson(response, 200, { user: await getSessionUser(request.headers.cookie) }, {}, method);
    return;
  }
  if (method === 'GET' && url.pathname === '/api/password-token') {
    const details = await inspectPasswordToken(url.searchParams.get('token'));
    sendJson(response, 200, { email: details.email, name: details.name, purpose: details.purpose }, {}, method);
    return;
  }
  if (method === 'GET' && url.pathname === '/api/state') {
    const user = requireUser(await getSessionUser(request.headers.cookie));
    sendJson(response, 200, await loadUserState(user.id), {}, method);
    return;
  }
  if (method === 'POST' && url.pathname === '/api/login') {
    assertOrigin(request);
    const body = await readJson(request);
    const email = String(body.email || '').trim().toLowerCase();
    const windowMs = 15 * 60 * 1000;
    if (isLimited(`login:${email}`, 10, windowMs) || isLimited(`login-ip:${clientKey(request)}`, 50, windowMs)) {
      throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
    }
    let result;
    try {
      result = await login(body.email, body.password);
    } catch (error) {
      if (error.status === 401) {
        recordFailure(`login:${email}`, windowMs);
        recordFailure(`login-ip:${clientKey(request)}`, windowMs);
      }
      throw error;
    }
    const secure = cookieSecure(request);
    sendJson(response, 200, { user: result.user }, {
      'Set-Cookie': sessionCookie(result.sessionToken, { maxAge: sessionTtlDays() * 86400, secure })
    }, method);
    return;
  }
  if (method === 'POST' && url.pathname === '/api/logout') {
    assertOrigin(request);
    await readJson(request);
    await logout(request.headers.cookie);
    sendJson(response, 200, { ok: true }, {
      'Set-Cookie': sessionCookie('', { maxAge: 0, secure: cookieSecure(request) })
    }, method);
    return;
  }
  if (method === 'POST' && url.pathname === '/api/password') {
    assertOrigin(request);
    if (isLimited(`password:${clientKey(request)}`, 20, 15 * 60 * 1000)) {
      throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
    }
    recordFailure(`password:${clientKey(request)}`, 15 * 60 * 1000);
    const body = await readJson(request);
    const result = await setPassword(body.token, body.password);
    sendJson(response, 200, { user: result.user }, {
      'Set-Cookie': sessionCookie(result.sessionToken, { maxAge: sessionTtlDays() * 86400, secure: cookieSecure(request) })
    }, method);
    return;
  }
  if (method === 'PUT' && url.pathname === '/api/state') {
    assertOrigin(request);
    const user = requireUser(await getSessionUser(request.headers.cookie));
    const body = await readJson(request);
    await saveUserState(user.id, body);
    sendJson(response, 200, { ok: true }, {}, method);
    return;
  }
  sendJson(response, 404, { error: 'Não encontrado.' }, {}, method);
}

function staticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relative = decoded.replace(/^\/+/, '');
  if (!relative) return join(rootDir, 'index.html');
  const file = resolve(rootDir, relative);
  if (file !== rootDir && !file.startsWith(rootDir + sep)) return null;
  const top = file.slice(rootDir.length + 1).split(sep)[0];
  if (blocked.has(top) || top.startsWith('.env')) return null;
  return file;
}

async function serveStatic(request, response, url) {
  const path = spaRoutes.has(url.pathname) ? join(rootDir, 'index.html') : staticPath(url.pathname);
  const extension = path ? extname(path) : '';
  if (!path || !types[extension]) {
    send(response, 404, 'Arquivo não encontrado', { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, request.method);
    return;
  }
  try {
    const body = await readFile(path);
    const headers = {
      'Content-Type': types[extension],
      'Cache-Control': path.endsWith(`${sep}service-worker.js`) ? 'public, max-age=0, must-revalidate' : 'no-store'
    };
    if (path.endsWith(`${sep}service-worker.js`)) headers['Service-Worker-Allowed'] = '/';
    send(response, 200, body, headers, request.method);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') {
      send(response, 404, 'Arquivo não encontrado', { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, request.method);
      return;
    }
    throw error;
  }
}

export async function handleRequest(request, response) {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    response.writeHead(302, { Location: url.pathname.replace(/\/+$/, '') + url.search });
    response.end();
    return;
  }
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, 'Método não permitido', { 'Content-Type': 'text/plain; charset=utf-8' }, request.method);
      return;
    }
    await serveStatic(request, response, url);
  } catch (error) {
    const publicFailure = publicError(error);
    if (!response.headersSent) sendJson(response, publicFailure.status || 500, { error: publicFailure.message }, {}, request.method);
  }
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  createServer((request, response) => {
    handleRequest(request, response).catch(error => {
      console.error(error.message);
      if (!response.headersSent) response.writeHead(500).end('Erro interno do servidor.');
    });
  }).listen(port, host, () => {
    console.log(`PreçoCerto ouvindo em ${host}:${port}`);
  });
}
