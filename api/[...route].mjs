import { createApp } from '../server/app.mjs';
import { createDatabase, makePool } from '../server/db.mjs';
import { configFromEnv } from '../server/security.mjs';

let app;
export default async function handler(req, res) {
  try {
    app ??= createApp({ db: createDatabase(makePool(process.env.DATABASE_URL)), config: configFromEnv() });
  } catch {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ message: 'Configuração do serviço indisponível.' }));
    return;
  }
  return app(req, res);
}
