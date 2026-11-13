import { appBaseUrl, normalizeEmail, optionMap, printPasswordLink } from '../lib/accounts.mjs';
import { issueLinkForEmail } from '../lib/auth.mjs';
import { cliMessage } from '../lib/cli.mjs';
import { closePool, withTransaction } from '../lib/db.mjs';
import { loadEnv } from '../lib/env.mjs';

loadEnv();

try {
  const options = optionMap(process.argv.slice(2));
  const email = normalizeEmail(options.email || process.env.SEED_EMAIL);
  appBaseUrl();
  const outcome = await withTransaction(client => issueLinkForEmail(client, email));
  if (!outcome) {
    console.error(`Não existe conta com o e-mail ${email}. Cadastre com npm run db:seed.`);
    process.exitCode = 1;
  } else {
    printPasswordLink(outcome.user, outcome.issued);
  }
} catch (error) {
  console.error(cliMessage(error));
  process.exitCode = 1;
} finally {
  await closePool();
}
