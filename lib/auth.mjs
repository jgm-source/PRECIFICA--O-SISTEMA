import { insertPasswordToken, normalizeEmail, publicUser, sessionTtlDays } from './accounts.mjs';
import { withTransaction, getPool } from './db.mjs';
import { HttpError } from './http-error.mjs';
import { readCookie, SESSION_COOKIE } from './cookies.mjs';
import { hashPassword, hashToken, hashTokenIfValid, newToken, verifyPassword } from './passwords.mjs';

const INVALID_LOGIN = 'E-mail ou senha incorretos.';
const INVALID_LINK = 'Este link é inválido ou expirou. Peça um novo link de definição de senha.';
let dummyHash;

async function dummyPasswordHash() {
  if (!dummyHash) dummyHash = await hashPassword(newToken());
  return dummyHash;
}

async function insertSession(client, userId) {
  const token = newToken();
  await client.query(
    `insert into public.sessions (user_id, token_hash, expires_at)
     values ($1, $2, now() + ($3::int * interval '1 day'))`,
    [userId, hashToken(token), sessionTtlDays()]
  );
  return token;
}

export async function getSessionUser(cookieHeader) {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  const tokenHash = token && hashTokenIfValid(token);
  if (!tokenHash) return null;
  const result = await getPool().query(
    `select u.id, u.email, u.name, u.role
     from public.sessions s
     join public.users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now()`,
    [tokenHash]
  );
  return result.rows[0] ? publicUser(result.rows[0]) : null;
}

export async function logout(cookieHeader) {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  const tokenHash = token && hashTokenIfValid(token);
  if (!tokenHash) return;
  await getPool().query('delete from public.sessions where token_hash = $1', [tokenHash]);
}

export async function login(email, password) {
  const normalized = normalizeEmail(email);
  if (typeof password !== 'string' || password.length < 1 || password.length > 200) {
    throw new HttpError(401, INVALID_LOGIN);
  }
  return withTransaction(async client => {
    const found = await client.query(
      'select id, email, name, role, password_hash from public.users where email = $1',
      [normalized]
    );
    const user = found.rows[0];
    const matches = await verifyPassword(password, user?.password_hash || await dummyPasswordHash());
    if (!user || !user.password_hash || !matches) {
      if (user && !user.password_hash) {
        throw new HttpError(401, 'Esta conta ainda não tem senha. Abra o link de criação de senha.');
      }
      throw new HttpError(401, INVALID_LOGIN);
    }
    await client.query('delete from public.sessions where expires_at <= now()');
    const sessionToken = await insertSession(client, user.id);
    return { user: publicUser(user), sessionToken };
  });
}

export async function inspectPasswordToken(rawToken) {
  const tokenHash = hashTokenIfValid(rawToken);
  if (!tokenHash) throw new HttpError(400, INVALID_LINK);
  const result = await getPool().query(
    `select u.email, u.name, t.purpose
     from public.password_tokens t
     join public.users u on u.id = t.user_id
     where t.token_hash = $1 and t.used_at is null and t.expires_at > now()`,
    [tokenHash]
  );
  if (!result.rows[0]) throw new HttpError(400, INVALID_LINK);
  return result.rows[0];
}

export async function setPassword(rawToken, password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    throw new HttpError(400, 'A senha precisa ter entre 8 e 200 caracteres.');
  }
  const tokenHash = hashTokenIfValid(rawToken);
  if (!tokenHash) throw new HttpError(400, INVALID_LINK);
  return withTransaction(async client => {
    const found = await client.query(
      `select t.user_id, u.email, u.name, u.role
       from public.password_tokens t
       join public.users u on u.id = t.user_id
       where t.token_hash = $1 and t.used_at is null and t.expires_at > now()
       for update`,
      [tokenHash]
    );
    const row = found.rows[0];
    if (!row) throw new HttpError(400, INVALID_LINK);
    const passwordHash = await hashPassword(password);
    await client.query(
      'update public.users set password_hash = $2, updated_at = now() where id = $1',
      [row.user_id, passwordHash]
    );
    await client.query(
      'update public.password_tokens set used_at = now() where user_id = $1 and used_at is null',
      [row.user_id]
    );
    await client.query('delete from public.sessions where user_id = $1', [row.user_id]);
    const sessionToken = await insertSession(client, row.user_id);
    return { user: publicUser(row), sessionToken };
  });
}

export async function issueLinkForEmail(client, email) {
  const normalized = normalizeEmail(email);
  const found = await client.query(
    `select id, email, name, role, password_hash is not null as has_password
     from public.users
     where email = $1
     for update`,
    [normalized]
  );
  const user = found.rows[0];
  if (!user) return null;
  const issued = await insertPasswordToken(client, user.id, user.has_password ? 'reset' : 'invite');
  return { user: publicUser(user), issued };
}
