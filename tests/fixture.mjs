import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { createApp, policy } from '../server/app.mjs';
import { configFromEnv } from '../server/security.mjs';
import { makePagarme } from '../server/pagarme.mjs';
import { inspect, migrate } from '../scripts/db.mjs';

export const password = 'SenhaUnitaria-013!';
export const hookSecret = 'chave_de_teste_webhook_exclusivamente_local';
export const firstKey = 'sk_test_local_013_credencial_a';
export const secondKey = 'sk_test_local_013_credencial_b';
export const wrongKey = 'sk_test_recusada_credencial_x';
export const publicKey = 'pk_test_local_013_credencial_a';
export const account = 'acc_TestMerchant013';

export async function fixture({ browser = false, port = 0, originOverride } = {}) {
  const pg = new PGlite();
  const adapter = client => ({
    query: (sql, args) => !args && sql.startsWith('CREATE SCHEMA') && sql.includes(';')
      ? client.exec(sql) : client.query(sql, args)
  });
  const db = { ...adapter(pg), tx: fn => pg.transaction(tx => fn(adapter(tx))) };
  await pg.exec('CREATE TABLE public.anterior(id integer); INSERT INTO public.anterior VALUES(7);');
  await migrate(db);
  await migrate(db);
  if (!(await inspect(db)).some(row => row.table_name === 'anterior')) throw new Error('Tabela preexistente não preservada.');
  const remote = { calls: [], orders: new Map(), hooks: new Map(), chargePosts: 0, sequence: 0, failing: false };
  const output = (body, status = 200) => Response.json(body, { status });
  const pagarme = makePagarme(async (url, options) => {
    const { pathname, searchParams } = new URL(url);
    const route = pathname.replace('/core/v5', '');
    const { method } = options;
    const key = Buffer.from(options.headers.Authorization.slice(6), 'base64').toString().slice(0,-1);
    const body = options.body && JSON.parse(options.body);
    remote.calls.push({ route, key, method, body, idempotency: options.headers['Idempotency-Key'] });
    if (key === wrongKey || remote.failing) return output({ message: 'Invalid API key' }, 401);
    if (![firstKey,secondKey].includes(key)) return output({ message: 'Invalid API key' }, 401);
    if (route === '/orders' && method === 'GET') return output({ data: [...remote.orders.values()].filter(order => !searchParams.has('code') || order.code === searchParams.get('code')) });
    if (route === '/orders' && method === 'POST') {
      remote.chargePosts++;
      const seq = ++remote.sequence;
      const result = body.payments[0].credit_card.card_token;
      const declined = result === 'token_DeclinedTest';
      const uncertain = result === 'token_UncertainTest';
      const manual = body.payments[0].credit_card.operation_type === 'auth_only';
      const status = declined ? 'failed' : manual ? 'pending' : 'paid';
      const amount = body.items[0].amount;
      const order = {
        id: 'or_DemoOrder' + seq, code: body.code, amount, status, charges: [{
          id: 'ch_DemoCharge' + seq, amount, paid_amount: status === 'paid' ? amount : 0, status,
          updated_at: new Date().toISOString(),
          last_transaction: {
            id: 'tran_DemoTransaction' + seq,
            status: declined ? 'not_authorized' : manual ? 'authorized_pending_capture' : 'captured',
            ...(declined ? { acquirer_return_code: '0051', acquirer_message: 'Recusa do fixture local' } : {})
          }
        }]
      };
      remote.orders.set(order.id, order);
      if (uncertain) throw new Error('Fixture network failure');
      return output(order, 201);
    }
    if (route.startsWith('/orders/')) return remote.orders.has(route.slice(8)) ? output(remote.orders.get(route.slice(8))) : output({},404);
    if (route.startsWith('/hooks/')) return remote.hooks.has(route.slice(7)) ? output(remote.hooks.get(route.slice(7))) : output({},404);
    if (route.startsWith('/charges/')) {
      const [id, action] = route.slice(9).split('/');
      const charge = [...remote.orders.values()].map(order => order.charges[0]).find(value => value.id === id);
      if (!charge) return output({},404);
      if (method === 'GET') return output(charge);
      if (action === 'capture') Object.assign(charge, { status: 'paid', paid_amount: charge.amount, updated_at: new Date().toISOString(), last_transaction: { id: 'tran_ManualCapture', status: 'captured' } });
      if (method === 'DELETE') Object.assign(charge, { status: charge.status === 'paid' ? 'refunded' : 'canceled', updated_at: new Date().toISOString(), last_transaction: { id: 'tran_ManualCancel', status: 'voided' } });
      return output(charge);
    }
    if (route === '/customers' && method === 'POST') return output({ id: 'cus_DemoCustomer' }, 201);
    if (route === '/customers/cus_DemoCustomer/cards' && method === 'POST') return output({ id: 'card_DemoCard' }, 201);
    return output({ data: [] });
  });
  const viaFetch = async url => {
    if (url.includes('99999999')) return output({ erro: true });
    if (url.includes('11111111')) throw new Error('Fixture ViaCEP unavailable');
    return output({ logradouro: 'Praça da Sé', bairro: 'Sé', localidade: 'São Paulo', uf: 'SP' });
  };
  const host = express();
  const server = host.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const config = configFromEnv({
    ADMIN_PASSWORD: password, SESSION_SECRET: 'sessao_local_de_teste_exclusivamente_013',
    ENCRYPTION_KEY: Buffer.alloc(32, 17).toString('base64'), WEBHOOK_SECRET: hookSecret, APP_ORIGIN: originOverride ?? origin
  });
  const app = createApp({ db, config, pagarme, viaFetch });
  if (browser) {
    host.use((req, res, next) => {
      if (req.path.startsWith('/api/')) return app(req,res,next);
      res.set('Content-Security-Policy', Object.entries(policy).map(([directive, values]) =>
        directive.replace(/[A-Z]/g, match => '-' + match.toLowerCase()) + ' ' + values.join(' ')).join('; '));
      next();
    });
    host.use(express.static(resolve('dist')));
  } else host.use(app);

  return { remote, origin, db, close: async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await pg.close();
  } };
}
