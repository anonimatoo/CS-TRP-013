import { debitApproval, stoneToken } from './cards.mjs';
import { gatewayRow, gatewaySecret } from './gateway.mjs';
import { ProviderError, providerId, readPayment } from './pagarme.mjs';
import { one } from './db.mjs';
import { productRow } from './payments.mjs';
import { HttpError } from './security.mjs';
import { pagarmeKeyEnvironment } from '../shared/validation.mjs';

const historyLimit = 50;

async function inspect(operation, validate = () => true) {
  try {
    const { http = null, data } = await operation();
    if (!validate(data)) throw new ProviderError(http, 'provider_invalid_json');
    return { permission: 'confirmed', http, category: null, data };
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    return {
      permission: [401, 403].includes(error.http) ? 'denied' : 'unknown',
      http: error.http, category: error.category
    };
  }
}

const list = (pagarme, key, path) => inspect(() => pagarme(key, path), body => Array.isArray(body?.data));
const publicCheck = ({ permission, http, category }) => ({ permission, http, category });

export function debitEvidence(charge) {
  const id = providerId(charge?.id, 'ch');
  if (charge?.payment_method !== 'debit_card' || !id) return null;
  const transaction = charge.last_transaction;
  const acquirer = transaction?.acquirer_name;
  const date = Date.parse(charge.created_at);
  // The documented transaction example may omit authentication, including on authenticated payments.
  // Missing fields cannot establish that a payment was Pinless.
  return {
    id, transactionId: providerId(transaction?.id, 'tran'),
    status: readPayment(charge).status,
    acquirer: typeof acquirer === 'string' && /^[A-Za-z][A-Za-z0-9 _.-]{0,49}$/.test(acquirer) ? acquirer : null,
    createdAt: Number.isFinite(date) ? new Date(date).toISOString() : null,
    mode: 'unknown'
  };
}

export async function diagnoseDebit({ db, config, pagarme, stoneFetch, merchant, env }) {
  const [row, product] = await Promise.all([gatewayRow(db, merchant, env), productRow(db, merchant)]);
  const approval = debitApproval(config, row);
  const mode = row.debit_requires_3ds ? 'authenticated' : 'pinless';
  const blocks = [];
  if (product.environment !== env) blocks.push('O checkout deste lojista está configurado para o outro ambiente.');
  if (!product.enabled) blocks.push('O checkout está desativado nas configurações comerciais.');
  if (!product.amount) blocks.push('Defina o preço do produto antes de habilitar o checkout.');
  if (!row.enabled) blocks.push('O gateway deste lojista está desativado para novas vendas.');
  if (env === 'live' && !config.allowLive) blocks.push('A implantação bloqueia pagamentos em produção pela configuração ALLOW_LIVE_PAYMENTS.');
  if (!row.public_key) blocks.push('Cadastre a chave pública da mesma conta e ambiente para tokenizar cartões no checkout.');
  if (!row.last_ok) blocks.push('O checkout exige um teste de conexão bem-sucedido na Central de Gateway.');
  if (!row.debit_enabled) blocks.push('A modalidade de débito está desativada nas configurações do lojista.');
  if (!approval) blocks.push('Falta a referência de autorização comercial emitida para este lojista e ambiente.');
  else if (row.debit_authorization_reference !== approval) blocks.push('A referência gravada nas modalidades precisa coincidir com a autorização comercial configurada no servidor.');

  const report = {
    merchantId: merchant, environment: env, credentialEnvironment: null, checkedAt: new Date(),
    account: { id: row.secret ? row.account : null, name: null, source: row.secret && row.account ? 'linked' : 'unknown', model: null },
    mode, commercialStatus: 'unknown', checks: {}, blocks,
    history: { state: 'unavailable', inspected: 0, limit: historyLimit, records: [] }
  };

  if (!row.secret) {
    blocks.push('Cadastre a Secret Key para consultar a conta, as permissões de leitura e o 3DS.');
    return report;
  }
  let key;
  try {
    key = gatewaySecret(config, row);
  } catch {
    blocks.push('A Secret Key cadastrada não pôde ser recuperada. Verifique a chave de criptografia da implantação.');
    return report;
  }
  report.credentialEnvironment = pagarmeKeyEnvironment(key);
  if (report.credentialEnvironment !== env) {
    blocks.push('O ambiente indicado pela Secret Key diverge do ambiente selecionado. Corrija o cadastro da credencial.');
    report.account = { id: null, name: null, source: 'unknown', model: null };
    return report;
  }

  const [orders, hooks, charges, threeDS] = await Promise.all([
    list(pagarme, key, '/orders?size=1'),
    list(pagarme, key, '/hooks?size=10'),
    list(pagarme, key, '/charges?page=1&size=' + historyLimit),
    inspect(async () => { await stoneToken(key, env, stoneFetch); return {}; })
  ]);
  report.checks = Object.fromEntries(Object.entries({ orders, hooks, charges, threeDS })
    .map(([name, check]) => [name, publicCheck(check)]));

  const stores = new Map();
  for (const event of hooks.data?.data ?? []) {
    const id = providerId(event?.account?.id, 'acc');
    const name = event?.account?.name;
    if (id) stores.set(id, typeof name === 'string' && name.length <= 160 ? name : stores.get(id) ?? null);
  }
  const [observed] = stores.keys();
  const linkedElsewhere = observed && !row.account && await one(db, `SELECT merchant_id FROM cs_trp_013_v2.gateway
    WHERE environment=$1 AND account=$2 AND merchant_id<>$3`, [env, observed, merchant]);
  if (stores.size > 1 || linkedElsewhere || (observed && row.account && observed !== row.account)) {
    report.account = { id: null, name: null, source: 'conflict', model: null };
    report.history.state = 'account_conflict';
    blocks.push('Os eventos retornaram uma conta divergente ou múltiplas contas. Resolva a titularidade antes de atribuir operações a este lojista.');
  } else {
    if (observed) report.account = { id: observed, name: stores.get(observed), source: 'webhook', model: null };
    if (report.account.id === row.account && ['gateway', 'psp'].includes(row.mode)) {
      report.account.model = row.mode === 'gateway' ? 'Gateway' : 'PSP';
      if (row.mode === 'psp') blocks.push('O cadastro local identifica uma conta PSP. A referência de débito V5 descreve essa modalidade para Gateway. Confirme o modelo da conta com a Pagar.me.');
    }
    if (!report.account.id) blocks.push('A API não retornou um identificador de conta nos eventos e o cadastro ainda não tem vínculo verificado. O histórico fica oculto até a identificação da conta.');
    if (charges.data && report.account.id) {
      const page = charges.data.data.slice(0, historyLimit);
      const records = [...new Map(page.map(debitEvidence).filter(Boolean).map(record => [record.id, record])).values()];
      const { rows } = records.length ? await db.query(`SELECT provider_charge, provider_transaction, authentication_status
        FROM cs_trp_013_v2.orders WHERE merchant_id=$1 AND environment=$2 AND account=$3
        AND payment_method='debit_card' AND provider_charge=ANY($4::text[])`,
      [merchant, env, report.account.id, records.map(record => record.id)]) : { rows: [] };
      const local = new Map(rows.map(order => [order.provider_charge, order]));
      for (const record of records) {
        const order = local.get(record.id);
        if (record.transactionId && order?.provider_transaction === record.transactionId) {
          if (order.authentication_status === 'Y') record.mode = 'authenticated';
          if (order.authentication_status === null) record.mode = 'pinless';
        }
      }
      report.history = { state: 'sample', inspected: page.length, limit: historyLimit, records };
    }
  }

  if (mode === 'authenticated' && threeDS.permission !== 'confirmed') {
    blocks.push('A emissão de token 3DS não foi confirmada. Consulte o resultado da verificação 3DS Stone antes de oferecer débito autenticado.');
  }
  const current = await gatewayRow(db, merchant, env);
  if (current.version !== row.version) throw new HttpError(409, 'As credenciais ou modalidades mudaram durante o diagnóstico. Execute a consulta novamente.');
  return report;
}
