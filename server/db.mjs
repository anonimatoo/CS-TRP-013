import pg from 'pg';

export function makePool(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL não configurada.');
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL inválida.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) {
    throw new Error('DATABASE_URL inválida.');
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('A validação de certificados TLS precisa estar ativa.');
  }
  // Enforce certificate and hostname verification, including older Neon URLs.
  url.searchParams.set('sslmode', 'verify-full');
  return new pg.Pool({
    connectionString: url.href, enableChannelBinding: true, max: 4, connectionTimeoutMillis: 4500, idleTimeoutMillis: 10000
  });
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

export async function audit(db, action, details = {}, merchantId = null) {
  await db.query('INSERT INTO cs_trp_013_v2.audit (action,details,merchant_id) VALUES ($1,$2,$3)', [action, JSON.stringify(details), merchantId]);
}
