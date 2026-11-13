import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { rootDir } from '../lib/env.mjs';

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, files);
    else if (path.endsWith('.mjs') || path.endsWith('.js')) files.push(path);
  }
  return files;
}

for (const file of walk(rootDir)) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const test = spawnSync(process.execPath, ['--test'], { cwd: rootDir, stdio: 'inherit' });
process.exit(test.status ?? 1);
