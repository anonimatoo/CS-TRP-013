import { createDatabase, makePool } from '../server/db.mjs';

const pool = makePool(process.env.DATABASE_URL);
const db = createDatabase(pool);
try {
  const counts = await db.tx(async client => {
    const sessions = await client.query('DELETE FROM cs_trp_013.sessions WHERE expires_at <= now()');
    const limits = await client.query('DELETE FROM cs_trp_013.rate_limits WHERE window_end <= now()');
    return { expiredSessions: sessions.rowCount, expiredLimits: limits.rowCount };
  });
  console.log('Registros transitórios excluídos.', counts);
} finally { await pool.end(); }
