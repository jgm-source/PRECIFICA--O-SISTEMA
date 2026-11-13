import { HttpError } from './http-error.mjs';
import { hashToken, newToken } from './passwords.mjs';

export function normalizeEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (value.length < 3 || value.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    throw new HttpError(400, 'Informe um e-mail válido.');
  }
  return value;
}

export function normalizeName(name) {
  const value = String(name || '').trim().replace(/\s+/g, ' ');
  if (value.length < 1 || value.length > 120) {
    throw new HttpError(400, 'Informe o nome com até 120 caracteres.');
  }
  return value;
}

export function assertRole(role) {
  if (role !== 'admin' && role !== 'user') {
    throw new HttpError(400, 'O papel precisa ser admin ou user.');
  }
  return role;
}

export function appBaseUrl() {
  const raw = process.env.APP_BASE_URL;
  if (!raw) throw new HttpError(500, 'Defina APP_BASE_URL com a URL pública do aplicativo, sem barra no final.');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(500, 'APP_BASE_URL inválida.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(500, 'APP_BASE_URL precisa começar com http:// ou https://.');
  }
  if (url.username || url.password) throw new HttpError(500, 'APP_BASE_URL não pode conter usuário ou senha.');
  if (url.search || url.hash) throw new HttpError(500, 'APP_BASE_URL não pode conter query ou fragmento.');
  return raw.replace(/\/+$/, '');
}

export function passwordLink(token) {
  return `${appBaseUrl()}/definir-senha?token=${encodeURIComponent(token)}`;
}

export function localUrlWarning(base) {
  const host = new URL(base).hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.includes('_')) {
    return 'AVISO: APP_BASE_URL parece local ou interno. A pessoa só abre o link se esse for o endereço público do aplicativo.';
  }
  return '';
}

export function passwordTokenTtlHours() {
  const value = process.env.PASSWORD_TOKEN_TTL_HOURS || '72';
  const hours = Number(value);
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
    throw new HttpError(500, 'PASSWORD_TOKEN_TTL_HOURS precisa ser um inteiro entre 1 e 720.');
  }
  return hours;
}

export function sessionTtlDays() {
  const value = process.env.SESSION_TTL_DAYS || '14';
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new HttpError(500, 'SESSION_TTL_DAYS precisa ser um inteiro entre 1 e 90.');
  }
  return days;
}

export function publicUser(row) {
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export async function insertPasswordToken(client, userId, purpose) {
  const token = newToken();
  const hours = passwordTokenTtlHours();
  await client.query(
    `update public.password_tokens
     set used_at = now()
     where user_id = $1 and used_at is null`,
    [userId]
  );
  const inserted = await client.query(
    `insert into public.password_tokens (user_id, token_hash, purpose, expires_at)
     values ($1, $2, $3, now() + ($4::int * interval '1 hour'))
     returning expires_at`,
    [userId, hashToken(token), purpose, hours]
  );
  return { token, expiresAt: inserted.rows[0].expires_at, url: passwordLink(token), hours, purpose };
}

export function optionMap(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      options[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options[body] = next;
      index += 1;
    } else {
      options[body] = 'true';
    }
  }
  return options;
}

export function printPasswordLink(user, issued) {
  const action = issued.purpose === 'reset' ? 'redefinição de senha' : 'criação de senha';
  const warning = localUrlWarning(appBaseUrl());
  console.log('');
  console.log(`Link de ${action} para ${user.name} <${user.email}> (papel ${user.role}).`);
  console.log(`A conta continua sem senha definida por este comando. O link expira em ${issued.hours} horas e só pode ser usado uma vez.`);
  console.log('O sistema não envia e-mail. Entregue este endereço por um canal seguro.');
  if (warning) console.log(warning);
  console.log('');
  console.log(issued.url);
  console.log('');
}
