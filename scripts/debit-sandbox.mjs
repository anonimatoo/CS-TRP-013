import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { makePagarme, providerId, readPayment } from '../server/pagarme.mjs';
import { pagarmeKeyEnvironment } from '../shared/validation.mjs';

// Exclusively synthetic PANs published in the official Pagar.me debit simulator.
const scenarios = [
  { name: 'aprovação', number: '4000000000000010', expected: ['paid', 'captured'] },
  { name: 'recusa', number: '4000000000000028', expected: ['declined'] }
];

export async function runDebitSandbox(key, pagarme = makePagarme(), report = () => {}) {
  if (pagarmeKeyEnvironment(key) !== 'test' || !key.startsWith('sk_test_') || key.trim() !== key) {
    throw new Error('Defina PAGARME_DEBIT_SANDBOX_KEY com uma Secret Key sk_test_ do Sandbox autorizado.');
  }
  const results = [];
  for (const { name, number, expected } of scenarios) {
    const code = 'cs013-debit-sandbox-' + randomUUID();
    const address = { line_1: '1, Praça da Sé, Sé', zip_code: '01001000', city: 'São Paulo', state: 'SP', country: 'BR' };
    const { http, data } = await pagarme(key, '/orders', {
      method: 'POST', idempotency: code,
      body: {
        code, items: [{ code: 'cs013-sandbox', description: 'Teste Sandbox de débito', amount: 1000, quantity: 1 }],
        customer: {
          name: 'Cliente Sandbox', email: 'cs013-pagarme-sandbox@example.com', type: 'individual', document: '52998224725',
          address, phones: { mobile_phone: { country_code: '55', area_code: '11', number: '900000000' } }
        },
        payments: [{ payment_method: 'debit_card', debit_card: { card: {
          number, holder_name: 'CLIENTE SANDBOX', exp_month: 12, exp_year: (new Date().getUTCFullYear() + 3) % 100,
          cvv: '123', billing_address: address
        } } }]
      }
    });
    const charge = data?.charges?.[0];
    const orderId = providerId(data?.id, 'or');
    const chargeId = providerId(charge?.id, 'ch');
    assert.ok(orderId && chargeId && charge.payment_method === 'debit_card',
      'O simulador não retornou um pedido com cobrança de débito identificável.');
    const { status } = readPayment(charge);
    const result = { scenario: name, http, orderId, chargeId, status };
    report(result);
    assert.ok(expected.includes(status), 'Resultado divergente no cenário de ' + name + '.');
    results.push(result);
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runDebitSandbox(process.env.PAGARME_DEBIT_SANDBOX_KEY, undefined, result => console.log(JSON.stringify(result)));
  } catch (error) {
    console.error(error.message, error.http ?? '', error.category ?? '');
    process.exitCode = 1;
  }
}
