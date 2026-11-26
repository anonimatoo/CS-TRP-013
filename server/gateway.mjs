import { cardAvailability, publicKeyPattern, stoneToken } from './cards.mjs';
import { z } from 'zod';
import { pagarmeKeyEnvironment } from '../shared/validation.mjs';
import { audit, one } from './db.mjs';
import { HttpError, decrypt, encrypt } from './security.mjs';
import { hostedCheckoutName, ProviderError } from './pagarme.mjs';

export const environment = z.enum(['test','live']);
const accountId = z.string().trim().regex(/^acc_[A-Za-z0-9]{4,100}$/);
const keySchema = z.object({
  secret: z.string().trim().refine(value => pagarmeKeyEnvironment(value) !== null),
  publicKey: z.string().trim().regex(publicKeyPattern).optional()
}).strict();

const context = (env, account) => env + ':' + account;
export const gatewayRow = (db, env, lock = false) =>
  one(db, 'SELECT * FROM cs_trp_013_v2.gateway WHERE environment=$1' + (lock ? ' FOR UPDATE' : ''), [env]);
export const gatewaySecret = (config, row) => decrypt(config.encryptionKey, row.secret, context(row.environment, row.account));
export function makeGateway(db, config, pagarme, stoneFetch) {
  function activationBlock(environment) {
    if (environment !== 'live' || config.allowLive) return null;
    return config.production
      ? 'Pagamentos de produção estão bloqueados. Defina ALLOW_LIVE_PAYMENTS=true nas variáveis da implantação e publique uma nova versão.'
      : 'Pagamentos de produção estão bloqueados. Defina ALLOW_LIVE_PAYMENTS=true no .env.local e reinicie a aplicação.';
  }

  const meta = row => ({
    environment: row.environment, hasKey: Boolean(row.secret), enabled: row.enabled, connected: row.last_ok,
    testedAt: row.tested_at, updatedAt: row.updated_at, http: row.last_http, message: row.last_message,
    authenticated: row.last_authenticated ?? (row.last_ok ? true : row.last_http === 401 ? false : null),
    checkoutReadable: row.checkout_readable ?? (row.last_ok ? true : null),
    readError: row.last_error ?? null,
    debitApprovalConfigured: Boolean(config.debitApproval?.[row.environment]),
    checkoutCreationVerifiedAt: row.checkout_creation_verified_at ?? null,
    checkoutAttemptedAt: row.checkout_attempted_at ?? null,
    checkoutHttp: row.checkout_http ?? null,
    checkoutError: row.checkout_error ?? null,
    activationBlock: activationBlock(row.environment),
    publicKey: row.public_key, creditEnabled: row.credit_enabled, debitEnabled: row.debit_enabled,
    debitAuthorizationReference: row.debit_authorization_reference,
    creditRequires3ds: row.credit_requires_3ds, debitRequires3ds: row.debit_requires_3ds,
    available: cardAvailability(row, config)
  });

  async function probe(key, account, anchor) {
    const paths = ['/orders?size=1','/charges?size=1','/hooks?size=1'];
    const results = await Promise.allSettled(paths.map(path => pagarme(key, path)));
    const [orders, charges, hooks] = results.map(result => result.value);
    const authenticated = results.some(result => result.status === 'fulfilled') ? true :
      results.some(result => result.reason?.http === 401) ? false : null;
    const checkoutReadable = orders ? true : [401,403].includes(results[0].reason?.http) ? false : null;
    const checked = { authenticated, checkoutReadable };
    try {
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      for (const result of [orders, charges, hooks]) {
        if (!Array.isArray(result.data?.data)) throw new ProviderError(result.http, 'provider_invalid_json');
      }
      const observedAccount = accountId.safeParse(hooks.data.data[0]?.account?.id).data;
      if (observedAccount && account && observedAccount !== account) {
        throw new ProviderError(hooks.http, 'gateway_account_mismatch');
      }
      if (anchor?.provider_order) {
        const result = await pagarme(key, '/orders/' + anchor.provider_order);
        if (result.data?.id !== anchor.provider_order || result.data?.code !== anchor.id) {
          throw new ProviderError(result.http, 'gateway_account_mismatch');
        }
      } else if (anchor?.checkout_provider_id) {
        const result = await pagarme(key, '/paymentlinks/' + anchor.checkout_provider_id);
        if (result.data?.id !== anchor.checkout_provider_id || result.data?.name !== hostedCheckoutName(anchor.id)) {
          throw new ProviderError(result.http, 'gateway_account_mismatch');
        }
      } else if (anchor && (!observedAccount || observedAccount !== account)) {
        const pending = await pagarme(key, '/orders?size=2&code=' + anchor.id);
        if (!Array.isArray(pending.data?.data) || !pending.data.data.some(order => order?.code === anchor.id && order.amount === anchor.amount)) {
          throw new ProviderError(pending.http, 'gateway_account_unverified');
        }
      }
      return { ...checked, connected: true, account: observedAccount ?? account, http: orders.http, category: null,
        message: 'Pagar.me respondeu às consultas autenticadas de leitura.' };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      const messages = {
        provider_authentication: 'A Pagar.me recusou a autenticação da Secret Key.',
        provider_permission: 'A Secret Key não tem permissão para uma das consultas da Pagar.me.',
        gateway_account_mismatch: 'A conta ou a referência consultada diverge do histórico local.',
        gateway_account_unverified: 'A nova credencial ainda não comprova vínculo com o pedido em aberto.'
      };
      return { ...checked, connected: false, http: error.http, category: error.category,
        message: messages[error.category] ?? 'Não foi possível confirmar as consultas de leitura da Pagar.me.' };
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
    const { secret, publicKey } = input.data;
    if (publicKey && publicKey.startsWith('pk_test_') !== (env === 'test')) {
      throw new HttpError(422, 'Use a chave pública do mesmo ambiente e da mesma conta da SK.');
    }
    const secretEnvironment = pagarmeKeyEnvironment(secret);
    if (secretEnvironment !== env) {
      const label = secretEnvironment === 'test' ? 'Sandbox' : 'Produção';
      throw new HttpError(422, 'A Secret Key (SK) é de ' + label + '. Selecione esse ambiente para cadastrá-la.');
    }
    const history = await one(db, `SELECT account, provider_order, checkout_provider_id, id, amount FROM cs_trp_013_v2.orders
      WHERE environment=$1 AND status <> 'request_failed'
      ORDER BY (provider_order IS NOT NULL OR checkout_provider_id IS NOT NULL) DESC, created_at DESC LIMIT 1`, [env]);
    const knownAccount = (before.secret || history ? before.account : null) ?? history?.account;
    const checked = await probe(secret, knownAccount, history);
    if (!checked.connected) throw new HttpError(422, checked.message, { http: checked.http, category: checked.category });
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
        account=$2,secret=$3,public_key=$8,enabled=(enabled AND $8::text IS NOT NULL),debit_enabled=false,debit_authorization_reference=NULL,
        credit_requires_3ds=true,debit_requires_3ds=true,last_ok=true,last_http=$4,last_message=$5,
        last_authenticated=$6,checkout_readable=$7,last_error=NULL,
        checkout_creation_verified_at=NULL,checkout_attempted_at=NULL,checkout_http=NULL,checkout_error=NULL,
        tested_at=now(),updated_at=now(),version=version+1 WHERE environment=$1 RETURNING *`,
      [env, account, sealed, checked.http, checked.message, checked.authenticated, checked.checkoutReadable, publicKey ?? null]);
      await audit(client, 'gateway.' + action, { environment: env, account });
      return meta(row);
    });
  }

  async function test(env) {
    const before = await gatewayRow(db, env);
    if (!before.secret) throw new HttpError(409, 'Cadastre a chave antes de testar a conexão.');
    const checked = await probe(gatewaySecret(config, before), before.account);
    let threeDS = null;
    if (checked.connected) {
      try {
        await stoneToken(gatewaySecret(config, before), env, stoneFetch);
        threeDS = true;
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        threeDS = false;
      }
    }
    return db.tx(async client => {
      await checkVersion(client, before);
      const row = await one(client, `UPDATE cs_trp_013_v2.gateway SET
        last_ok=$2,last_http=$3,last_message=$4,last_error=$5,last_authenticated=$6,checkout_readable=$7,
        tested_at=now(),enabled=(enabled AND $2),version=version+1
        WHERE environment=$1 RETURNING *`,
      [env, checked.connected, checked.http, checked.message, checked.category, checked.authenticated, checked.checkoutReadable]);
      await audit(client, 'gateway.test', { environment: env, connected: checked.connected, http: checked.http });
      return { ...meta(row), threeDS };
    });
  }

  async function change(env, action, form) {
    const before = await gatewayRow(db, env);
    if (!before.secret) throw new HttpError(409, 'Nenhuma chave cadastrada.');
    if (action === 'activate') {
      const block = activationBlock(env);
      if (block) throw new HttpError(409, block);
      if (form?.confirmed !== true) throw new HttpError(422, 'Confirme a ativação das cobranças na Pagar.me.');
      if (!before.last_ok) throw new HttpError(409, 'Execute um teste de conexão bem-sucedido.');
      if (!before.public_key) throw new HttpError(409, 'Cadastre a chave pública para tokenizar cartões.');
      await pagarme(gatewaySecret(config, before), '/orders?size=1');
    }
    if (action === 'disconnect' && form?.confirmed !== true) throw new HttpError(422, 'Confirme a desconexão da chave.');
    return db.tx(async client => {
      await checkVersion(client, before);
      const row = action === 'disconnect'
        ? await one(client, `UPDATE cs_trp_013_v2.gateway SET
            secret=NULL,public_key=NULL,debit_enabled=false,debit_authorization_reference=NULL,
            credit_requires_3ds=true,debit_requires_3ds=true,last_ok=NULL,last_http=NULL,last_message=NULL,tested_at=NULL,
            last_error=NULL,last_authenticated=NULL,checkout_readable=NULL,
            checkout_creation_verified_at=NULL,checkout_attempted_at=NULL,checkout_http=NULL,checkout_error=NULL,
            enabled=false,updated_at=now(),version=version+1 WHERE environment=$1 RETURNING *`, [env])
        : await one(client, `UPDATE cs_trp_013_v2.gateway SET
            enabled=$2,updated_at=now(),version=version+1 WHERE environment=$1 RETURNING *`, [env, action === 'activate']);
      await audit(client, 'gateway.' + action, { environment: env, account: before.account });
      return meta(row);
    });
  }

  async function configure(env, form) {
    const parsed = z.object({
      publicKey: z.string().trim().regex(publicKeyPattern),
      creditEnabled: z.boolean(), debitEnabled: z.boolean(),
      debitAuthorizationReference: z.string().trim().max(120),
      creditRequires3ds: z.boolean(), debitRequires3ds: z.boolean()
    }).strict().safeParse(form);
    if (!parsed.success) throw new HttpError(422, 'Revise as configurações de cartão.');
    const input = parsed.data;
    const before = await gatewayRow(db, env);
    if (!before.secret || !before.last_ok) throw new HttpError(409, 'Conecte e teste a chave SK.');
    if (input.publicKey.startsWith('pk_test_') !== (env === 'test')) throw new HttpError(422, 'A chave pública pertence a outro ambiente.');
    if (input.debitEnabled && (!input.debitAuthorizationReference || input.debitAuthorizationReference !== config.debitApproval?.[env])) {
      throw new HttpError(422, 'Informe a referência da habilitação de débito confirmada pela Pagar.me e pela adquirente.');
    }
    const newCredit3ds = input.creditEnabled && input.creditRequires3ds && (!before.credit_enabled || !before.credit_requires_3ds);
    const newDebit3ds = input.debitEnabled && input.debitRequires3ds && (!before.debit_enabled || !before.debit_requires_3ds);
    if ((newCredit3ds || newDebit3ds) || (input.publicKey !== before.public_key &&
        ((input.creditEnabled && input.creditRequires3ds) || (input.debitEnabled && input.debitRequires3ds)))) {
      await stoneToken(gatewaySecret(config, before), env, stoneFetch);
    }
    return db.tx(async client => {
      await checkVersion(client, before);
      const row = await one(client, `UPDATE cs_trp_013_v2.gateway SET public_key=$2,credit_enabled=$3,
        debit_enabled=$4,debit_authorization_reference=$5,credit_requires_3ds=$6,debit_requires_3ds=$7,
        version=version+1,updated_at=now() WHERE environment=$1 RETURNING *`,
      [env, input.publicKey, input.creditEnabled, input.debitEnabled, input.debitAuthorizationReference || null,
        input.creditRequires3ds, input.debitRequires3ds]);
      await audit(client, 'gateway.cards', { environment: env, creditEnabled: input.creditEnabled, debitEnabled: input.debitEnabled });
      return meta(row);
    });
  }

  return { configure, get: async env => meta(await gatewayRow(db, env)), save, test, change };
}
