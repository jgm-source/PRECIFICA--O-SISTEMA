import { cliMessage } from '../lib/cli.mjs';
import { loadEnv } from '../lib/env.mjs';
import { applySchema } from '../lib/schema.mjs';

loadEnv();

try {
  const files = await applySchema();
  console.log(`Schema aplicado (${files.join(', ')}).`);
} catch (error) {
  console.error(cliMessage(error));
  process.exitCode = 1;
}
