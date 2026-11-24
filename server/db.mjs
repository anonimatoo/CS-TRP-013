import pg from 'pg';

export function makePool(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL não configurada.');
  return new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 4500, idleTimeoutMillis: 10000 });
}

export function createDatabase(pool) {
  return {
    query: (sql, args) => pool.query(sql, args),
    async tx(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
  };
}

export async function one(db, sql, args) {
  return (await db.query(sql, args)).rows[0];
}

export async function audit(db, action, details = {}) {
  await db.query('INSERT INTO cs_trp_013.audit (action,details) VALUES ($1,$2)', [action, JSON.stringify(details)]);
}
