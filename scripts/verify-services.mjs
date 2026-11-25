import assert from 'node:assert/strict';
import { makePool } from '../server/db.mjs';

let ok = true;
try {
  const response = await fetch('https://viacep.com.br/ws/01001000/json/', { signal: AbortSignal.timeout(8000) });
  assert.equal(response.status, 200);
  const address = await response.json();
  assert.equal(address.uf, 'SP');
  assert.equal(address.localidade, 'São Paulo');
  console.log('ViaCEP real: HTTP 200, São Paulo/SP.');
} catch {
  ok = false;
  console.error('ViaCEP: consulta real falhou neste ambiente.');
}
if (process.env.DATABASE_URL) {
  const pool = makePool(process.env.DATABASE_URL);
  try {
    const result = await pool.query("SELECT current_setting('server_version') AS version");
    console.log('Neon/PostgreSQL: conexão estabelecida. Versão do servidor:', result.rows[0].version);
  } catch {
    ok = false;
    console.error('PostgreSQL: não foi possível conectar com a configuração fornecida.');
  } finally { await pool.end(); }
} else {
  ok = false;
  console.log('Neon pendente: DATABASE_URL não foi fornecida.');
}
process.exitCode = ok ? 0 : 1;
