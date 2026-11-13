import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { rootDir } from './env.mjs';
import { HttpError } from './http-error.mjs';

export async function applySchema() {
  if (!process.env.DATABASE_URL) throw new HttpError(500, 'Defina DATABASE_URL.');
  const dir = join(rootDir, 'db', 'migrations');
  const files = (await readdir(dir)).filter(name => name.endsWith('.sql')).sort();
  if (!files.length) throw new HttpError(500, 'Nenhuma migration encontrada em db/migrations.');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    for (const file of files) {
      const sql = await readFile(join(dir, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('commit');
      } catch (error) {
        try { await client.query('rollback'); } catch { /* ignora falha ao desfazer */ }
        const wrapped = new Error(`${file}: ${error.message}`);
        wrapped.code = error.code;
        throw wrapped;
      }
    }
  } finally {
    await client.end();
  }
  return files;
}
