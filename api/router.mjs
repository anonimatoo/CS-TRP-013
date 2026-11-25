import { createApp } from '../server/app.mjs';
import { createDatabase, makePool } from '../server/db.mjs';
import { configFromEnv } from '../server/security.mjs';

let app;

function restoreApiPath(req) {
  const request = new URL(req.url, 'http://localhost');
  if (request.pathname !== '/api/router') return;
  const path = request.searchParams.get('__cs_path');
  if (!path || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(path)) return;
  request.searchParams.delete('__cs_path');
  req.url = '/api/' + path + request.search;
}
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
  restoreApiPath(req);
  return app(req, res);
}
