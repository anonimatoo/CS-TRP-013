import pgDriver from 'pg';
import { createDatabase } from '../server/db.mjs';
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
export const otherKey = 'sk_test_local_013_outro_lojista';
export const otherLiveKey = 'sk_local_013_outro_lojista';
export const otherAccount = 'acc_OtherMerchant013';

export async function fixture({ browser = false, port = 0, originOverride, allowLive = false, configOverrides = {}, mailTransport, postgresUrl } = {}) {
  if (postgresUrl && !['127.0.0.1','localhost','[::1]'].includes(new URL(postgresUrl).hostname)) {
    throw new Error('Use um PostgreSQL local descartável para os testes.');
  }
  const postgres = postgresUrl ? new pgDriver.Pool({ connectionString: postgresUrl, max: 8 }) : null;
  const pg = postgres ? null : new PGlite();
  const adapter = client => ({
    query: (sql, args) => !args && /^(CREATE SCHEMA|CREATE TABLE|ALTER TABLE)/.test(sql) && sql.includes(';')
      ? client.exec(sql) : client.query(sql, args)
  });
  const db = postgres ? createDatabase(postgres) : { ...adapter(pg), tx: fn => pg.transaction(tx => fn(adapter(tx))) };
  await db.query(`CREATE TABLE public.anterior(id integer);
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
    nextLinkFault: '', respondToCreation: null, linkCodes: new Map(),
    orderLookup: null, checkoutLookup: null, checkoutDetails: null, checkoutHost: 'payment-link.pagar.me',
    complete(code, status = 'paid') {
      const link = [...this.links.values()].find(value => this.linkCodes.get(value.id) === code);
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
    remote.calls.push({ hostname, route, key, method, body, idempotency: options.headers['Idempotency-Key'],
      userAgent: options.headers['User-Agent'], query: searchParams });
    if (key === wrongKey || remote.failing) return output({ message: 'Invalid API key' }, 401);
    if (![firstKey,secondKey,liveKey,otherKey,otherLiveKey].includes(key)) return output({ message: 'Invalid API key' }, 401);
    const merchant = [otherKey,otherLiveKey].includes(key) ? otherAccount : account;
    const belongs = order => (order?.fixtureAccount ?? (order ? account : null)) === merchant;
    if (route === '/orders' && method === 'GET' && searchParams.has('code') && remote.orderLookup) return remote.orderLookup(searchParams);
    if (route === '/orders' && method === 'GET') return output({ data: [...remote.orders.values()].filter(order => belongs(order) && (!searchParams.has('code') || order.code === searchParams.get('code'))) });
    if (route === '/orders' && method === 'POST') {
      const sequence = ++remote.sequence;
      const payment = body.payments[0];
      const card = payment[payment.payment_method];
      const amount = body.items[0].amount;
      const declined = card.card_token === 'token_declined';
      const manual = card.operation_type === 'auth_only';
      const pending = card.card_token === 'token_pending';
      const status = declined ? 'failed' : manual || pending ? 'pending' : 'paid';
      const order = { id: 'or_Direct' + sequence, code: body.code, amount, status, fixtureAccount: merchant, charges: [{
        id: 'ch_Direct' + sequence, amount, status, paid_amount: status === 'paid' ? amount : 0,
        payment_method: payment.payment_method, fee_amount: 99, net_amount: amount - 99, updated_at: new Date().toISOString(),
        last_transaction: { id: 'tran_Direct' + sequence, status: declined ? 'not_authorized' : manual ? 'authorized_pending_capture' : pending ? 'pending' : 'captured',
          card: { brand: 'Visa', number: '4000100511112003', cvv: '789' },
          ...(declined ? { acquirer_return_code: '0051', acquirer_message: 'Recusa do fixture local' } : {}) }
      }] };
      remote.orders.set(order.id, order);
      if (remote.orderTimeout) {
        remote.orderTimeout = false;
        throw new DOMException('Fixture timeout', 'TimeoutError');
      }
      return output(order, 201);
    }
    if (route === '/paymentlinks' && method === 'POST') {
      const fault = remote.nextLinkFault;
      remote.nextLinkFault = '';
      remote.linkPosts++;
      const id = 'pl_DemoCheckout' + ++remote.sequence;
      const amount = body.cart_settings.items[0].amount;
      const checkoutHost = key === liveKey ? 'payment-link.stone.com.br' : remote.checkoutHost;
      // Based on checkout-response and criar-link. The response example omits order_code.
      const link = {
        id, name: body.name, type: body.type,
        url: fault === 'invalid_url' ? 'https://payment-link.pagar.me.evil.example/' + id : 'https://' + checkoutHost + '/' + id,
        status: 'active', total_sessions: 0, total_paid_sessions: 0,
        max_sessions: body.max_sessions, max_paid_sessions: body.max_paid_sessions,
        created_at: new Date().toISOString().replace(/(\.\d+)Z$/, '$10000Z'),
        expires_in: body.expires_in, payment_settings: body.payment_settings,
        cart_settings: { items: body.cart_settings.items, items_total_cost: amount, shipping_cost: 0, shipping_total_cost: 0, total_cost: amount }
      };
      const persist = () => {
        remote.links.set(id, link);
        remote.linkCodes.set(id, body.order_code);
      };
      if (remote.respondToCreation) {
        const respond = remote.respondToCreation;
        remote.respondToCreation = null;
        return respond({ link, persist });
      }
      persist();
      if (fault === 'timeout') throw new DOMException('Fixture timeout after provider created the link', 'TimeoutError');
      return output(link, 201);
    }
    if (route === '/paymentlinks' && searchParams.has('name') && remote.checkoutLookup) return remote.checkoutLookup(searchParams);
    if (route === '/paymentlinks') return output({
      data: [...remote.links.values()].filter(link => !searchParams.has('name') || link.name === searchParams.get('name'))
    });
    if (route.startsWith('/paymentlinks/')) {
      const id = route.slice('/paymentlinks/'.length);
      if (remote.checkoutDetails) return remote.checkoutDetails(id);
      const link = remote.links.get(id);
      return link ? output(link) : output({},404);
    }
    if (route.startsWith('/orders/')) return belongs(remote.orders.get(route.slice(8))) ? output(remote.orders.get(route.slice(8))) : output({},404);
    if (route === '/hooks' && remote.diagnosticHooks && searchParams.get('size') === '10') return remote.diagnosticHooks(merchant);
    if (route === '/charges' && remote.diagnosticCharges && searchParams.has('page')) return remote.diagnosticCharges(merchant);
    if (route === '/hooks') return output({ data: [{ account: { id: merchant } }] });
    if (route.startsWith('/hooks/')) return remote.hooks.get(route.slice(7))?.account?.id === merchant ? output(remote.hooks.get(route.slice(7))) : output({},404);
    if (route.startsWith('/charges/')) {
      const [id, action] = route.slice(9).split('/');
      const charge = [...remote.orders.values()].filter(belongs).map(order => order.charges[0]).find(value => value.id === id);
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
    ENCRYPTION_KEY: Buffer.alloc(32, 17).toString('base64'), WEBHOOK_SECRET: hookSecret, APP_ORIGIN: originOverride ?? origin, ALLOW_LIVE_PAYMENTS: String(allowLive), PAGARME_DEBIT_APPROVAL_TEST: 'sandbox-approved-reference', ...configOverrides
  });
  const createFixtureApp = () => createApp({ db, config, pagarme, viaFetch, mailTransport,
    stoneFetch: async () => remote.diagnostic3dsHttp ? Response.json({}, { status: remote.diagnostic3dsHttp }) : Response.json({ tds_token: 'fixture-3ds-token' }) });
  let app = createFixtureApp();
  const restart = () => { app = createFixtureApp(); };
  const serve = (req, res, next) => app(req, res, next);
  if (browser) {
    host.use((req, res, next) => {
      if (req.path.startsWith('/api/')) return app(req,res,next);
      res.set('Content-Security-Policy', Object.entries(policy).map(([directive, values]) =>
        directive.replace(/[A-Z]/g, match => '-' + match.toLowerCase()) + ' ' + values.join(' ')).join('; '));
      next();
    });
    host.use(express.static(resolve('dist')));
  } else host.use(serve);

  return { remote, origin, db, restart, config, close: async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (postgres) await postgres.end();
    else await pg.close();
  } };
}
