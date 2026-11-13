import pg from 'pg';
import { loadEnv } from './env.mjs';
import { HttpError } from './http-error.mjs';

loadEnv();

let pool;

export function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new HttpError(503, 'O servidor não está configurado para acessar o banco.');
  }
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000
    });
    pool.on('error', error => {
      console.error('Erro no pool do Postgres:', error.message);
    });
  }
  return pool;
}

export async function closePool() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}

export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    try {
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (error) {
      try { await client.query('rollback'); } catch { /* a conexão já pode ter caído */ }
      throw error;
    }
  } finally {
    client.release();
  }
}
