import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import handler from '../api/router.mjs';

test('Vercel envia rotas aninhadas ao Express nos dois formatos de URL', async t => {
  process.env.DATABASE_URL = 'postgresql://127.0.0.1:1/test';
  process.env.APP_ORIGIN = 'https://checkout.example';
  process.env.ADMIN_PASSWORD = randomBytes(24).toString('base64url');
  process.env.SESSION_SECRET = randomBytes(32).toString('base64url');
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.WEBHOOK_SECRET = randomBytes(32).toString('base64url');
  const server = createServer(handler).listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const sessionRoutes = ['/api/admin/session','/api/router?__cs_path=admin%2Fsession'];
  for (const route of sessionRoutes) {
    const response = await fetch(base + route);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).message,'Entre com a senha administrativa.');
  }
  const wrongOrigin = await fetch(base + '/api/router?__cs_path=admin%2Flogin', {
    method:'POST',headers:{ 'Content-Type':'application/json', Origin:'https://fora.example' }, body:'{}'
  });
  assert.equal(wrongOrigin.status, 403);
  const invalidPath = await fetch(base + '/api/router?__cs_path=..%2Fadmin%2Fsession');
  assert.equal(invalidPath.status, 404);
});
