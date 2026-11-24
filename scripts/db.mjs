import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, makePool } from '../server/db.mjs';

export async function inspect(db) {
  const { rows } = await db.query(`SELECT table_schema,table_name FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type='BASE TABLE'
    ORDER BY table_schema,table_name`);
  return rows;
}

export async function migrate(db) {
  const directory = new URL('../database/migrations/', import.meta.url);
  const files = (await readdir(directory)).filter(name => /^\d+_.*\.sql$/.test(name)).sort();
  await db.tx(async client => {
    await client.query("SELECT pg_advisory_xact_lock(1967013)");
    await client.query('CREATE SCHEMA IF NOT EXISTS cs_trp_013');
    await client.query(`CREATE TABLE IF NOT EXISTS cs_trp_013.migrations
      (filename text PRIMARY KEY, digest text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const file of files) {
      const sql = await readFile(new URL(file, directory), 'utf8');
      const digest = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
      const { rows: [prior] } = await client.query('SELECT digest FROM cs_trp_013.migrations WHERE filename=$1', [file]);
      if (prior && prior.digest !== digest) throw new Error('Migration anteriormente aplicada foi modificada: ' + file);
      if (prior) continue;
      await client.query(sql);
      await client.query('INSERT INTO cs_trp_013.migrations(filename,digest) VALUES($1,$2)', [file, digest]);
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pool = makePool(process.env.DATABASE_URL);
  const db = createDatabase(pool);
  try {
    if (!['inspect','migrate'].includes(process.argv[2])) throw new Error('Use inspect ou migrate.');
    console.table(await inspect(db));
    if (process.argv[2] === 'migrate') {
      await migrate(db);
      console.log('Migrations aplicadas no schema cs_trp_013.');
    }
  } finally {
    await pool.end();
  }
}
