import { z } from 'zod';
import { audit, one } from './db.mjs';
import { HttpError, decrypt, encrypt } from './security.mjs';
import { ProviderError } from './pagarme.mjs';

export const environment = z.enum(['test','live']);
const accountId = z.string().trim().regex(/^acc_[A-Za-z0-9]{4,100}$/);
const checkoutSchema = z.object({
  publicKey: z.string().trim().regex(/^pk_(?:test_)?[A-Za-z0-9_-]{8,128}$/),
  account: accountId,
  mode: z.enum(['gateway','psp'])
}).strict();
const keySchema = checkoutSchema.partial().extend({
  secret: z.string().trim().regex(/^sk_(?:test_)?[A-Za-z0-9_-]{8,128}$/)
});

const context = (env, account) => env + ':' + account;
export const gatewayRow = (db, env, lock = false) =>
  one(db, 'SELECT * FROM cs_trp_013_v2.gateway WHERE environment=$1' + (lock ? ' FOR UPDATE' : ''), [env]);
export const gatewaySecret = (config, row) => decrypt(config.encryptionKey, row.secret, context(row.environment, row.account));
export const checkoutConfigured = row => Boolean(row.public_key && row.account && row.mode);
const meta = row => ({
  environment: row.environment, account: row.account, mode: row.mode, publicKey: row.public_key,
  hasKey: Boolean(row.secret), checkoutConfigured: checkoutConfigured(row), enabled: row.enabled, connected: row.last_ok,
  testedAt: row.tested_at, updatedAt: row.updated_at, http: row.last_http, message: row.last_message
});

export function makeGateway(db, config, pagarme) {
  async function probe(key, mode, account, anchor) {
    let response;
    let observedAccount;
    try {
      for (const path of ['/orders?size=1','/charges?size=1','/hooks?size=1', ...(mode === 'psp' ? ['/customers?size=1'] : [])]) {
        response = await pagarme(key, path);
        if (path === '/hooks?size=1') {
          observedAccount = accountId.safeParse(response.data?.data?.[0]?.account?.id).data;
          if (observedAccount && account && observedAccount !== account) {
            return { connected: false, http: response.http, message: 'A conta do webhook retornado diverge do identificador informado.' };
          }
        }
      }
      if (anchor) {
        const result = await pagarme(key, '/orders/' + anchor.provider_order);
        if (result.data?.id !== anchor.provider_order || result.data?.code !== anchor.id) {
          return { connected: false, http: result.http, message: 'O pedido de referência não pertence à credencial fornecida.' };
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
    const configuring = action === 'configure';
    const input = (configuring ? checkoutSchema : keySchema).safeParse(form);
    if (!input.success) throw new HttpError(422, configuring
      ? 'Verifique a chave pública, a conta e a modalidade da tokenização.'
      : 'Informe uma Secret Key (SK) válida.');
    const before = await gatewayRow(db, env);
    if (configuring && !before.secret) throw new HttpError(409, 'Cadastre a Secret Key antes de configurar a tokenização.');
    if (!configuring && Boolean(before.secret) !== (action === 'replace')) {
      throw new HttpError(409, before.secret ? 'Use Substituir chave SK.' : 'Use Adicionar chave.');
    }
    const test = env === 'test';
    const secret = configuring ? gatewaySecret(config, before) : input.data.secret;
    if (secret.startsWith('sk_test_') !== test ||
        (input.data.publicKey && input.data.publicKey.startsWith('pk_test_') !== test)) {
      throw new HttpError(422, 'A chave deve pertencer ao ambiente selecionado.');
    }
    const history = await one(db, `SELECT account, provider_order, id, status FROM cs_trp_013_v2.orders
      WHERE environment=$1 ORDER BY (provider_order IS NOT NULL) DESC, (status <> 'request_failed') DESC, created_at DESC LIMIT 1`, [env]);
    const knownAccount = input.data.account ?? (before.secret ? before.account : history?.account ?? null);
    const publicKey = input.data.publicKey ?? before.public_key;
    const mode = input.data.mode ?? (before.secret || history ? before.mode : null);
    if (history && history.account !== knownAccount) throw new HttpError(409, 'Este ambiente possui pedidos associados a outra conta comercial.');
    if (history && !history.provider_order && history.status !== 'request_failed') {
      const pending = await pagarme(secret, '/orders?size=1&code=' + history.id).catch(() => null);
      if (!pending?.data?.data?.some(order => order.code === history.id)) {
        throw new HttpError(409, 'Concilie o pedido em aberto antes de trocar a configuração.');
      }
    }
    const checked = await probe(secret, mode, knownAccount, history?.provider_order ? history : null);
    if (!checked.connected) throw new HttpError(422, checked.message, { http: checked.http });
    const account = checked.account ?? null;
    const sealed = encrypt(config.encryptionKey, secret, context(env, account));
    const sameCheckout = publicKey === before.public_key && account === before.account && mode === before.mode;
    return db.tx(async client => {
      await checkVersion(client, before);
      const currentHistory = await one(client, 'SELECT account FROM cs_trp_013_v2.orders WHERE environment=$1 LIMIT 1', [env]);
      if ((!history && currentHistory) || (currentHistory && currentHistory.account !== account)) {
        throw new HttpError(409, 'Um pedido foi registrado durante a validação. Tente novamente.');
      }
      const row = await one(client, `UPDATE cs_trp_013_v2.gateway SET
        account=$2,mode=$3,public_key=$4,secret=$5,last_ok=true,last_http=$6,last_message=$7,
        enabled=(enabled AND $8),tested_at=now(),updated_at=now(),version=version+1 WHERE environment=$1 RETURNING *`,
      [env, account, mode, publicKey, sealed, checked.http, checked.message, sameCheckout]);
      await audit(client, 'gateway.' + action, { environment: env, account, mode });
      return meta(row);
    });
  }

  async function test(env) {
    const before = await gatewayRow(db, env);
    if (!before.secret) throw new HttpError(409, 'Cadastre a chave antes de testar a conexão.');
    const checked = await probe(gatewaySecret(config, before), before.mode, before.account);
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
      if (!checkoutConfigured(before)) throw new HttpError(409, 'Complete a configuração da tokenização para liberar pagamentos.');
      if (form?.confirmed !== true) throw new HttpError(422, 'Confirme no painel Pagar.me as permissões de escrita e a chave pública da conta.');
      if (!before.last_ok) throw new HttpError(409, 'Execute um teste de conexão bem-sucedido.');
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
