import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const directory of ['api','scripts','server','shared','tests']) {
  const root = new URL('../' + directory + '/', import.meta.url);
  for (const file of await readdir(root)) {
    if (!file.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(file,root))], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
console.log('Sintaxe JavaScript verificada.');
