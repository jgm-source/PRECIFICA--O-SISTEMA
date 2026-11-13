import { appBaseUrl, assertRole, insertPasswordToken, normalizeEmail, normalizeName, optionMap, printPasswordLink } from '../lib/accounts.mjs';
import { cliMessage } from '../lib/cli.mjs';
import { closePool, withTransaction } from '../lib/db.mjs';
import { loadEnv } from '../lib/env.mjs';

loadEnv();

try {
  const options = optionMap(process.argv.slice(2));
  const name = normalizeName(options.name || process.env.SEED_NAME);
  const email = normalizeEmail(options.email || process.env.SEED_EMAIL);
  const role = assertRole(options.role || 'admin');
  appBaseUrl();

  const outcome = await withTransaction(async client => {
    const existing = await client.query(
      'select id, email, name, role, password_hash from public.users where email = $1 for update',
      [email]
    );
    let user = existing.rows[0];
    if (!user) {
      const inserted = await client.query(
        `insert into public.users (email, name, role)
         values ($1, $2, $3)
         returning id, email, name, role, password_hash`,
        [email, name, role]
      );
      user = inserted.rows[0];
    } else if (user.password_hash) {
      return { alreadyHasPassword: true, email };
    } else if (user.name !== name) {
      await client.query('update public.users set name = $2, updated_at = now() where id = $1', [user.id, name]);
      user.name = name;
    }
    const issued = await insertPasswordToken(client, user.id, 'invite');
    return { user, issued };
  });

  if (outcome.alreadyHasPassword) {
    console.log(`A conta ${outcome.email} já existe e já tem senha. A senha não foi alterada.`);
    console.log(`Para gerar um novo link, execute:\nnpm run password-link -- --email "${outcome.email}"`);
  } else {
    printPasswordLink(outcome.user, outcome.issued);
  }
} catch (error) {
  console.error(cliMessage(error));
  process.exitCode = 1;
} finally {
  await closePool();
}
