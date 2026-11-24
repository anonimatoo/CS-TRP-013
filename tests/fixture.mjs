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
export const liveKey = 'sk_local_013_producao_a';
export const wrongKey = 'sk_test_recusada_credencial_x';
export const account = 'acc_TestMerchant013';

export async function fixture({ browser = false, port = 0, originOverride } = {}) {
  const pg = new PGlite();
  const adapter = client => ({
    query: (sql, args) => !args && sql.startsWith('CREATE SCHEMA') && sql.includes(';')
      ? client.exec(sql) : client.query(sql, args)
  });
  const db = { ...adapter(pg), tx: fn => pg.transaction(tx => fn(adapter(tx))) };
  await pg.exec(`CREATE TABLE public.anterior(id integer);
    INSERT INTO public.anterior VALUES(7);
    CREATE SCHEMA cs_trp_013;
    CREATE TABLE cs_trp_013.orders(id integer);
    INSERT INTO cs_trp_013.orders VALUES(8);`);
  await migrate(db);
  await migrate(db);
  const tables = await inspect(db);
  const legacy = await db.query('SELECT id FROM cs_trp_013.orders');
  if (!tables.some(row => row.table_schema === 'public' && row.table_name === 'anterior') ||
      legacy.rows.length !== 1 || legacy.rows[0].id !== 8) {
    throw new Error('Estrutura ou dados legados não preservados.');
  }
  const remote = {
    calls: [], orders: new Map(), links: new Map(), hooks: new Map(), linkPosts: 0, sequence: 0, failing: false,
    nextLinkFault: '',
    complete(code, status = 'paid') {
      const link = [...this.links.values()].find(value => value.order_code === code);
      if (!link || link.total_sessions !== 0) throw new Error('Checkout não está disponível para simular um pedido.');
      const seq = ++this.sequence;
      const amount = link.cart_settings.total_cost;
      link.total_sessions++;
      const order = {
        id: 'or_DemoOrder' + seq, code, amount, status, charges: [{
          id: 'ch_DemoCharge' + seq, amount, paid_amount: status === 'paid' ? amount : 0, status,
          updated_at: new Date().toISOString(),
          last_transaction: {
            id: 'tran_DemoTransaction' + seq,
            status: status === 'failed' ? 'not_authorized' : status === 'pending' ? 'authorized_pending_capture' : 'captured',
            ...(status === 'failed' ? { acquirer_return_code: '0051', acquirer_message: 'Recusa do fixture local' } : {})
          }
        }]
      };
      this.orders.set(order.id, order);
      return order;
    }
  };
  const output = (body, status = 200) => Response.json(body, { status });
  const pagarme = makePagarme(async (url, options) => {
    const { hostname, pathname, searchParams } = new URL(url);
    const route = pathname.replace('/core/v5', '');
    const { method } = options;
    const key = Buffer.from(options.headers.Authorization.slice(6), 'base64').toString().slice(0,-1);
    const body = options.body && JSON.parse(options.body);
    remote.calls.push({ hostname, route, key, method, body, idempotency: options.headers['Idempotency-Key'] });
    if (key === wrongKey || remote.failing) return output({ message: 'Invalid API key' }, 401);
    if (![firstKey,secondKey,liveKey].includes(key)) return output({ message: 'Invalid API key' }, 401);
    if (route === '/orders' && method === 'GET') return output({ data: [...remote.orders.values()].filter(order => !searchParams.has('code') || order.code === searchParams.get('code')) });
    if (route === '/paymentlinks' && method === 'POST') {
      const fault = remote.nextLinkFault;
      remote.nextLinkFault = '';
      remote.linkPosts++;
      const id = 'pl_DemoCheckout' + ++remote.sequence;
      const link = {
        ...body, id,
        url: fault === 'invalid_url' ? 'https://payment-link.pagar.me.evil.example/' + id : 'https://payment-link.pagar.me/' + id,
        status: 'active', total_sessions: 0, created_at: new Date().toISOString(),
        cart_settings: { ...body.cart_settings, total_cost: body.cart_settings.items[0].amount }
      };
      remote.links.set(id, link);
      if (fault === 'timeout') throw new Error('Fixture network failure');
      return output(link, 201);
    }
    if (route === '/paymentlinks') return output({
      data: [...remote.links.values()].filter(link => !searchParams.has('name') || link.name === searchParams.get('name'))
    });
    if (route.startsWith('/paymentlinks/')) {
      const link = remote.links.get(route.slice('/paymentlinks/'.length));
      return link ? output(link) : output({},404);
    }
    if (route.startsWith('/orders/')) return remote.orders.has(route.slice(8)) ? output(remote.orders.get(route.slice(8))) : output({},404);
    if (route === '/hooks') return output({ data: [...remote.hooks.values()] });
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
