import { z } from 'zod';
import { pagarmeKeyEnvironment } from '../shared/validation.mjs';
import { audit, one } from './db.mjs';
import { HttpError, decrypt, encrypt } from './security.mjs';
import { hostedCheckoutName, ProviderError } from './pagarme.mjs';

export const environment = z.enum(['test','live']);
const accountId = z.string().trim().regex(/^acc_[A-Za-z0-9]{4,100}$/);
const keySchema = z.object({
  secret: z.string().trim().refine(value => pagarmeKeyEnvironment(value) !== null)
}).strict();

const context = (env, account) => env + ':' + account;
export const gatewayRow = (db, env, lock = false) =>
  one(db, 'SELECT * FROM cs_trp_013_v2.gateway WHERE environment=$1' + (lock ? ' FOR UPDATE' : ''), [env]);
export const gatewaySecret = (config, row) => decrypt(config.encryptionKey, row.secret, context(row.environment, row.account));
const meta = row => ({
  environment: row.environment, hasKey: Boolean(row.secret), enabled: row.enabled, connected: row.last_ok,
  testedAt: row.tested_at, updatedAt: row.updated_at, http: row.last_http, message: row.last_message
});

export function makeGateway(db, config, pagarme) {
  async function probe(key, account, anchor) {
    let response;
    let observedAccount;
    try {
      for (const path of ['/orders?size=1','/charges?size=1','/hooks?size=1', '/paymentlinks?per_page=1']) {
        response = await pagarme(key, path, { hosted: true });
        if (path === '/hooks?size=1') {
          observedAccount = accountId.safeParse(response.data?.data?.[0]?.account?.id).data;
          if (observedAccount && account && observedAccount !== account) {
            return { connected: false, http: response.http, message: 'A conta do webhook retornado diverge do identificador informado.' };
          }
        }
      }
      if (anchor?.provider_order) {
        const result = await pagarme(key, '/orders/' + anchor.provider_order, { hosted: anchor.hosted_checkout });
        if (result.data?.id !== anchor.provider_order || result.data?.code !== anchor.id) {
          return { connected: false, http: result.http, message: 'O pedido de referência não pertence à credencial fornecida.' };
        }
      }
      if (anchor?.checkout_provider_id) {
        const result = await pagarme(key, '/paymentlinks/' + anchor.checkout_provider_id);
        if (result.data?.id !== anchor.checkout_provider_id || result.data?.name !== hostedCheckoutName(anchor.id)) {
          return { connected: false, http: result.http, message: 'O checkout de referência não pertence à credencial fornecida.' };
        }
      }
      return { connected: true, account: observedAccount ?? account, http: response.http, message: response.data?.message === 'OK'
        ? 'OK' : 'Pagar.me respondeu às consultas autenticadas de leitura.' };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      return { connected: false, http: error.http, message: error.providerMessage ??
        (error.http ? 'A consulta à Pagar.me retornou HTTP ' + error.http + '.' : 'A Pagar.me não respondeu à consulta.') };
    }
  }

  async function checkVersion(client, before) {
    const row = await gatewayRow(client, before.environment, true);
    if (row.version !== before.version) throw new HttpError(409, 'A configuração mudou. Reabra a central e tente novamente.');
    return row;
  }

  async function save(env, action, form) {
    const input = keySchema.safeParse(form);
    if (!input.success) throw new HttpError(422, 'Informe uma Secret Key (SK) válida.');
    const before = await gatewayRow(db, env);
    if (Boolean(before.secret) !== (action === 'replace')) {
      throw new HttpError(409, before.secret ? 'Use Substituir chave SK.' : 'Use Adicionar chave.');
    }
    const { secret } = input.data;
    const secretEnvironment = pagarmeKeyEnvironment(secret);
    if (secretEnvironment !== env) {
      const label = secretEnvironment === 'test' ? 'Sandbox' : 'Produção';
      throw new HttpError(422, 'A Secret Key (SK) é de ' + label + '. Selecione esse ambiente para cadastrá-la.');
    }
    const history = await one(db, `SELECT account, provider_order, checkout_provider_id, hosted_checkout, id FROM cs_trp_013_v2.orders
      WHERE environment=$1 AND status <> 'request_failed'
      ORDER BY (provider_order IS NOT NULL OR checkout_provider_id IS NOT NULL) DESC, created_at DESC LIMIT 1`, [env]);
    const knownAccount = (before.secret || history ? before.account : null) ?? history?.account;
    if (history && !history.provider_order && !history.checkout_provider_id) {
      const pending = await pagarme(secret, '/orders?size=2&code=' + history.id, { hosted: history.hosted_checkout }).catch(() => null);
      if (!pending?.data?.data?.some(order => order.code === history.id)) {
        throw new HttpError(409, 'Concilie o pedido em aberto antes de trocar a configuração.');
      }
    }
    const checked = await probe(secret, knownAccount, history);
    if (!checked.connected) throw new HttpError(422, checked.message, { http: checked.http });
    const account = checked.account ?? null;
    const sealed = encrypt(config.encryptionKey, secret, context(env, account));
    return db.tx(async client => {
      await checkVersion(client, before);
      const currentHistory = await one(client, `SELECT id, account FROM cs_trp_013_v2.orders
        WHERE environment=$1 AND status <> 'request_failed' ORDER BY created_at DESC LIMIT 1`, [env]);
      if ((!history && currentHistory) || (currentHistory?.account && currentHistory.account !== account)) {
        throw new HttpError(409, 'Um pedido foi registrado durante a validação. Tente novamente.');
      }
      const row = await one(client, `UPDATE cs_trp_013_v2.gateway SET
        account=$2,secret=$3,last_ok=true,last_http=$4,last_message=$5,
        tested_at=now(),updated_at=now(),version=version+1 WHERE environment=$1 RETURNING *`,
      [env, account, sealed, checked.http, checked.message]);
      await audit(client, 'gateway.' + action, { environment: env, account });
      return meta(row);
    });
  }

  async function test(env) {
    const before = await gatewayRow(db, env);
    if (!before.secret) throw new HttpError(409, 'Cadastre a chave antes de testar a conexão.');
    const checked = await probe(gatewaySecret(config, before), before.account);
    return db.tx(async client => {
      await checkVersion(client, before);
      const row = await one(client, `UPDATE cs_trp_013_v2.gateway SET
        last_ok=$2,last_http=$3,last_message=$4,tested_at=now(),enabled=(enabled AND $2),version=version+1
        WHERE environment=$1 RETURNING *`, [env, checked.connected, checked.http, checked.message]);
      await audit(client, 'gateway.test', { environment: env, connected: checked.connected, http: checked.http });
      return meta(row);
    });
  }

  async function change(env, action, form) {
    const before = await gatewayRow(db, env);
    if (!before.secret) throw new HttpError(409, 'Nenhuma chave cadastrada.');
    if (action === 'activate') {
      if (env === 'live' && !config.allowLive) throw new HttpError(409, 'Pagamentos de produção estão bloqueados neste deploy.');
      if (form?.confirmed !== true) throw new HttpError(422, 'Confirme que a credencial pode criar links de pagamento na Pagar.me.');
      if (!before.last_ok) throw new HttpError(409, 'Execute um teste de conexão bem-sucedido.');
      await pagarme(gatewaySecret(config, before), '/paymentlinks?per_page=1');
    }
    if (action === 'disconnect' && form?.confirmed !== true) throw new HttpError(422, 'Confirme a desconexão da chave.');
    return db.tx(async client => {
      await checkVersion(client, before);
      const row = action === 'disconnect'
        ? await one(client, `UPDATE cs_trp_013_v2.gateway SET
            secret=NULL,public_key=NULL,last_ok=NULL,last_http=NULL,last_message=NULL,tested_at=NULL,
            enabled=false,updated_at=now(),version=version+1 WHERE environment=$1 RETURNING *`, [env])
        : await one(client, `UPDATE cs_trp_013_v2.gateway SET
            enabled=$2,updated_at=now(),version=version+1 WHERE environment=$1 RETURNING *`, [env, action === 'activate']);
      await audit(client, 'gateway.' + action, { environment: env, account: before.account });
      return meta(row);
    });
  }

  return { get: async env => meta(await gatewayRow(db, env)), save, test, change };
}
