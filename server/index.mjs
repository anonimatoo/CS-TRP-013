import { createApp } from './app.mjs';
import { createDatabase, makePool } from './db.mjs';
import { configFromEnv } from './security.mjs';

const config = configFromEnv();
const pool = makePool(process.env.DATABASE_URL);
const server = createApp({ db: createDatabase(pool), config }).listen(process.env.PORT || 3001, '127.0.0.1');
server.on('listening', () => console.log('API CS TRP 013 disponível na porta', server.address().port));
