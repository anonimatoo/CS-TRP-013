import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { fixture, firstKey, liveKey, otherKey, password, secondKey, wrongKey } from './fixture.mjs';

const app = await fixture({ browser: true });
let browser;
try {
  const chromiumPath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({ executablePath: chromiumPath, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1448, height: 1086 } });
  const errors = [];
  const ownRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().startsWith(app.origin) && request.postData()) ownRequests.push(request.postData()); });
  await page.goto(app.origin);
  await page.getByRole('heading', { name: 'PC Gamer' }).waitFor();
  assert.equal(await page.locator('.product-card img').evaluate(img => img.complete && img.naturalWidth > 0), true);
  await page.getByLabel('Nome completo').fill('Comprador Teste');
  await page.getByRole('button', { name: /CONECTAR CHAVE SK/ }).click();
  const modal = page.getByRole('dialog');
  const passwordInput = modal.getByLabel('Senha administrativa');
  await passwordInput.waitFor();
  assert.equal(await passwordInput.getAttribute('type'), 'password');
  await modal.getByRole('button', { name: 'Mostrar senha' }).click();
  assert.equal(await passwordInput.getAttribute('type'), 'text');
  await modal.getByRole('button', { name: 'Ocultar senha' }).click();
  await passwordInput.fill('incorreta');
  await modal.getByRole('button', { name: 'ENTRAR' }).click();
  await modal.getByText('Senha administrativa incorreta.').waitFor();
  await passwordInput.fill(password);
  await modal.getByRole('button', { name: 'ENTRAR' }).click();
  await modal.getByRole('heading', { name: 'CENTRAL DE CONFIGURAÇÃO PAGAR.ME / STONE' }).waitFor();
  await modal.getByText('Chave não cadastrada').waitFor();
  const secretField = modal.getByLabel('Nova Secret Key (SK)');
  assert.equal(await secretField.getAttribute('type'), 'password');
  const environment = modal.getByRole('combobox', { name: 'Ambiente', exact: true });
  assert.equal(await environment.inputValue(), 'test');
  await secretField.fill(liveKey);
  await modal.getByText('Ambiente identificado: Produção.', { exact: true }).waitFor();
  assert.equal(await environment.inputValue(), 'live');
  assert.equal(await secretField.inputValue(), liveKey);
  assert.equal(await secretField.evaluate(field => field === document.activeElement), true);
  await modal.getByRole('button', { name: 'ADICIONAR CHAVE' }).click();
  await modal.getByText('Produção bloqueada', { exact: true }).waitFor();
  await modal.getByText(/Defina ALLOW_LIVE_PAYMENTS=true no .env.local/).waitFor();
  await modal.getByText(/O checkout usa/).waitFor();
  assert.equal(await modal.getByRole('button', { name: 'ATIVAR GATEWAY', exact: true }).isEnabled(), false);
  await secretField.fill(firstKey);
  await modal.getByText('Ambiente identificado: Sandbox.', { exact: true }).waitFor();
  assert.equal(await environment.inputValue(), 'test');
  assert.equal(await modal.getByLabel('Chave pública para tokenização').isVisible(), false);
  await modal.getByRole('button', { name: 'ADICIONAR CHAVE' }).click();
  await modal.getByText('Secret Key cadastrada e validada.', { exact: true }).waitFor();
  assert.equal(await secretField.inputValue(), '');
  await modal.getByRole('button', { name: 'TESTAR CONEXÃO' }).click();
  await modal.locator('[role=status]').getByText('Pagar.me respondeu às consultas autenticadas de leitura.').waitFor();
  assert.equal(await modal.getByLabel('Identificador da conta Pagar.me').count(), 0);
  async function configureCards() {
    await modal.getByLabel('Chave pública (PK) da conta').fill('pk_test_fixture123');
    await modal.getByRole('checkbox', { name: 'Ativar cartão de débito' }).check();
    await modal.getByLabel('Referência da habilitação do débito pela Pagar.me e adquirente').fill('sandbox-approved-reference');
    await modal.getByRole('button', { name: 'Salvar modalidades' }).click();
    await modal.getByText('Configurações de cartão salvas.').waitFor();
    await modal.getByRole('button', { name: 'ATIVAR GATEWAY', exact: true }).click();
    await modal.getByRole('checkbox', { name: /Confirmei que a conta/ }).check();
    await modal.getByRole('button', { name: 'Confirmar', exact: true }).click();
    await modal.getByText('Conectado e ativado').waitFor();
  }
  await configureCards();
  await secretField.fill(wrongKey);
  await modal.getByRole('button', { name: 'SUBSTITUIR CHAVE SK' }).click();
  await modal.getByRole('alert').getByText(/recusou a autenticação/).waitFor();
  await modal.getByText('Conectado e ativado').waitFor();
  await secretField.fill(secondKey);
  await modal.getByRole('button', { name: 'SUBSTITUIR CHAVE SK' }).click();
  await modal.getByText(/Chave substituída/).waitFor();
  await configureCards();
  await modal.getByRole('button', { name: 'Abrir configuração comercial', exact: true }).click();
  await modal.getByLabel('Valor da venda').fill('2.999,99');
  await modal.getByLabel('Máximo de parcelas').fill('6');
  await modal.getByRole('checkbox', { name: 'Produto disponível para venda' }).check();
  await modal.getByRole('button', { name: 'SALVAR CONFIGURAÇÃO' }).click();
  await modal.getByText('Configuração comercial salva.').waitFor();
  await modal.getByRole('button', { name: 'FECHAR', exact: true }).click();
  assert.equal(await page.getByLabel('Nome completo').inputValue(), 'COMPRADOR TESTE');

  async function fillBuyer() {
    await page.getByLabel('Nome completo').fill('Comprador Teste');
    await page.getByLabel('CPF').fill('52998224725');
    await page.getByLabel('E-mail').fill('comprador@example.com');
    await page.getByLabel('Celular com DDD').fill('11900000000');
    await page.getByLabel('CEP').fill('01001000');
    await page.getByText('Endereço consultado. Confira os dados.').waitFor();
    assert.equal(await page.getByLabel('Rua', { exact: false }).inputValue(), 'Praça da Sé');
    await page.getByPlaceholder('Nº').fill('1');
  }
  await fillBuyer();

  let token = 'token_approved';
  const sdkStatus = 'Y';
  await page.route('https://api.pagar.me/core/v5/tokens?*', route => route.fulfill({
    json: { id: token }, headers: { 'Access-Control-Allow-Origin': '*' }
  }));
  await page.route('https://3ds-nx-js.stone.com.br/test/v2/3ds2.min.js', route => route.fulfill({
    contentType: 'text/javascript',
    body: 'window.TDS = { init: async () => [{ trans_status: ' + JSON.stringify(sdkStatus) +
      ', tds_server_trans_id: "baa4cf29-7389-4db9-bf87-c16d1647fed8" }] }'
  }));
  async function fillCard() {
    await page.getByLabel('Número do cartão').fill('4000100511112003');
    await page.getByLabel('Nome impresso no cartão').fill('COMPRADOR TESTE');
    await page.getByLabel('Mês (MM)').fill('12');
    await page.getByLabel('Ano (AAAA)').fill(String(new Date().getFullYear() + 2));
    await page.getByLabel('Código de segurança do cartão (CVV)').fill('123');
  }
  const finalizePayment = page.getByRole('button', { name: 'FINALIZAR PAGAMENTO' });
  await page.getByLabel('Parcelamento').selectOption('3');
  await fillCard();
  await finalizePayment.click();
  await page.getByText('Pagamento aprovado', { exact: true }).waitFor();
  assert.equal(app.remote.linkPosts, 0);
  assert.equal(app.remote.calls.find(call => call.method === 'POST' && call.route === '/orders').body.payments[0].credit_card.installments, 3);
  assert.ok(!ownRequests.some(body => body.includes('4000100511112003') || body.includes('"cvv"') || body.includes('"holder_name"')));
  await page.reload();
  await page.getByText('Pagamento aprovado', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Nova compra' }).click();
  await fillBuyer();
  await page.getByRole('radio', { name: 'Cartão de débito' }).check();
  assert.equal(await page.getByLabel('Parcelamento').count(), 0);
  await page.getByText('À vista · R$ 2.999,99', { exact: true }).waitFor();
  await fillCard();
  token = 'token_declined';
  await finalizePayment.click();
  await page.getByText('Pagamento recusado', { exact: true }).waitFor();
  assert.equal(app.remote.calls.findLast(call => call.method === 'POST' && call.route === '/orders').body.payments[0].payment_method, 'debit_card');
  await page.getByRole('button', { name: 'Nova compra' }).click();

  await page.getByRole('button', { name: /CONECTAR CHAVE SK/ }).click();
  await modal.getByRole('button', { name: 'DESATIVAR GATEWAY' }).click();
  await modal.getByText(/Gateway desativado. A consulta/).waitFor();
  await modal.getByRole('button', { name: 'DESCONECTAR CHAVE' }).click();
  await modal.getByRole('checkbox', { name: /Confirmo a remoção/ }).check();
  await modal.getByRole('button', { name: 'Confirmar', exact: true }).click();
  await modal.getByText('Chave não cadastrada').waitFor();
  const originalMerchant = await modal.getByRole('combobox', { name: 'Lojista', exact: true }).inputValue();
  await modal.getByLabel('Nome do novo lojista').fill('Loja Praia');
  await modal.getByRole('button', { name: 'Adicionar lojista' }).click();
  const merchantPicker = modal.getByRole('combobox', { name: 'Lojista', exact: true });
  await merchantPicker.locator('option', { hasText: 'Loja Praia' }).waitFor({ state: 'attached' });
  const secondMerchant = await merchantPicker.locator('option', { hasText: 'Loja Praia' }).getAttribute('value');
  assert.ok(secondMerchant && originalMerchant !== secondMerchant);
  await secretField.fill(otherKey);
  await modal.getByRole('button', { name: 'ADICIONAR CHAVE' }).click();
  await modal.getByText('acc_OtherMerchant013', { exact: true }).waitFor();
  await modal.getByRole('button', { name: 'Relatórios e Notificações' }).click();
  await modal.getByLabel('Destinatários autorizados').fill('relatorios@example.test');
  await modal.getByRole('checkbox', { name: 'Autorizar compartilhamento deste lojista' }).check();
  await modal.getByRole('checkbox', { name: /Confirmo que o lojista autorizou/ }).check();
  await modal.getByRole('button', { name: 'Salvar compartilhamento' }).click();
  await modal.getByText('Compartilhamento atualizado.').waitFor();
  const reportDownloaded = page.waitForEvent('download');
  await modal.getByRole('link', { name: 'Baixar XLSX' }).click();
  assert.match((await reportDownloaded).suggestedFilename(), /\.xlsx$/);
  await modal.getByRole('checkbox', { name: 'Autorizar compartilhamento deste lojista' }).uncheck();
  await modal.getByRole('button', { name: 'Salvar compartilhamento' }).click();
  await modal.getByText('Compartilhamento atualizado.').waitFor();

  await merchantPicker.selectOption({ label: 'Histórico sem titularidade verificada' });
  await modal.getByText(/Histórico preservado para consulta/).waitFor();
  assert.equal(await modal.getByRole('button', { name: 'Gateway', exact: true }).count(), 0);
  await merchantPicker.selectOption(originalMerchant);
  await modal.getByText('Chave não cadastrada').waitFor();
  await modal.getByRole('button', { name: 'SAIR' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await finalizePayment.isDisabled(), true);

  for (const width of [1448, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 890 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  await page.getByRole('button', { name: /CONECTAR CHAVE SK/ }).click();
  await passwordInput.waitFor();
  await passwordInput.fill(password);
  await modal.getByRole('button', { name: 'ENTRAR' }).click();
  await modal.getByText('Chave não cadastrada').waitFor();
  assert.equal(await modal.evaluate(element => element.scrollWidth > element.clientWidth), false);
  if (process.env.BROWSER_SCREENSHOT_DIR) {
    await page.screenshot({ path: process.env.BROWSER_SCREENSHOT_DIR + '/mobile.png', fullPage: true });
  }
  await app.db.query("UPDATE cs_trp_013_v2.sessions SET expires_at=now()-interval '1 second'");
  await modal.getByRole('button', { name: 'Transações', exact: true }).click();
  await passwordInput.waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  console.log('Chromium: checkout, modal, autenticação, credenciais, crédito, débito e autenticação simulada, ViaCEP, troca de lojista, autorização, download XLSX, saída e responsividade (1448/768/390/320 px).');
} finally {
  await browser?.close();
  await app.close();
}
