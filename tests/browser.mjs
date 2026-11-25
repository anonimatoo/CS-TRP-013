import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { fixture, firstKey, liveKey, password, secondKey, wrongKey } from './fixture.mjs';

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
  await modal.getByRole('button', { name: 'ATIVAR GATEWAY', exact: true }).click();
  await modal.getByRole('checkbox', { name: /Confirmei que a Secret Key/ }).check();
  await modal.getByRole('button', { name: 'Confirmar', exact: true }).click();
  await modal.getByText('Conectado e ativado').waitFor();
  await secretField.fill(wrongKey);
  await modal.getByRole('button', { name: 'SUBSTITUIR CHAVE SK' }).click();
  await modal.getByRole('alert').getByText(/recusou a autenticação/).waitFor();
  await modal.getByText('Conectado e ativado').waitFor();
  await secretField.fill(secondKey);
  await modal.getByRole('button', { name: 'SUBSTITUIR CHAVE SK' }).click();
  await modal.getByText(/Chave substituída/).waitFor();
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

  assert.equal(await page.getByLabel('Número do cartão').count(), 0);
  const stoneCheckout = 'https://payment-link.stone.com.br/**';
  app.remote.checkoutHost = 'payment-link.stone.com.br';
  await page.route(stoneCheckout, async route => {
    const id = new URL(route.request().url()).pathname.slice(1);
    const link = app.remote.links.get(id);
    assert.ok(link);
    await route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<h1>Pagar.me (provedor de teste)</h1><a href="' + app.origin + '/?pedido=' + app.remote.linkCodes.get(link.id) + '">Voltar à loja</a>'
    });
  });
  const finalizePayment = page.getByRole('button', { name: 'FINALIZAR PAGAMENTO' });
  await finalizePayment.click();
  await page.waitForURL(stoneCheckout);
  await page.getByRole('heading', { name: 'Pagar.me (provedor de teste)' }).waitFor();
  assert.equal(page.context().pages().length, 1);
  assert.equal(app.remote.linkPosts, 1);
  const link = [...app.remote.links.values()][0];
  await page.getByRole('link', { name: 'Voltar à loja' }).click();
  const continuePayment = page.getByRole('link', { name: 'CONTINUAR NA PAGAR.ME' });
  await continuePayment.waitFor();
  assert.equal(await finalizePayment.count(), 0);
  await continuePayment.click();
  await page.waitForURL(stoneCheckout);
  assert.equal(app.remote.linkPosts, 1);
  app.remote.complete(app.remote.linkCodes.get(link.id));
  await app.db.query('UPDATE cs_trp_013_v2.orders SET checkout_synced_at=NULL WHERE id=$1', [app.remote.linkCodes.get(link.id)]);
  await page.getByRole('link', { name: 'Voltar à loja' }).click();
  await page.getByText('Pagamento aprovado', { exact: true }).waitFor();
  assert.ok(!ownRequests.some(body => body.includes('"token"') || body.includes('"cvv"') || body.includes('"holder_name"')));
  if (process.env.BROWSER_SCREENSHOT_DIR) {
    await page.screenshot({ path: process.env.BROWSER_SCREENSHOT_DIR + '/desktop.png', fullPage: true });
  }
  await page.reload();
  await page.getByText('Pagamento aprovado', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Nova compra' }).click();
  assert.equal(await finalizePayment.isEnabled(), true);
  await fillBuyer();
  app.remote.respondToCreation = ({ link, persist }) => {
    persist();
    return Response.json({ ...link, url: 'http://payment-link.stone.com.br/' + link.id }, { status: 201 });
  };
  app.remote.orderLookup = () => Response.json({ data: null });
  app.remote.checkoutDetails = () => Response.json({}, { status: 503 });
  await finalizePayment.click();
  await page.getByText('Falha ao confirmar o checkout', { exact: true }).waitFor();
  await page.getByText('Conciliação pendente com a Pagar.me.').waitFor();
  const pendingReference = new URL(page.url()).searchParams.get('pedido');
  assert.ok(pendingReference);
  assert.equal(await continuePayment.count(), 0);
  app.remote.checkoutDetails = null;
  await app.db.query('UPDATE cs_trp_013_v2.orders SET checkout_synced_at=NULL WHERE id=$1', [pendingReference]);
  await continuePayment.click();
  await page.waitForURL(stoneCheckout);
  assert.equal(app.remote.linkPosts, 2);
  assert.equal(page.context().pages().length, 1);
  app.remote.orderLookup = null;
  app.remote.complete(pendingReference, 'failed');
  await app.db.query('UPDATE cs_trp_013_v2.orders SET checkout_synced_at=NULL WHERE id=$1', [pendingReference]);
  await page.getByRole('link', { name: 'Voltar à loja' }).click();
  await page.getByText('Pagamento recusado', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Nova compra' }).click();


  await page.getByRole('button', { name: /CONECTAR CHAVE SK/ }).click();
  await modal.getByRole('button', { name: 'DESATIVAR GATEWAY' }).click();
  await modal.getByText(/Gateway desativado. A consulta/).waitFor();
  await modal.getByRole('button', { name: 'DESCONECTAR CHAVE' }).click();
  await modal.getByRole('checkbox', { name: /Confirmo a remoção/ }).check();
  await modal.getByRole('button', { name: 'Confirmar', exact: true }).click();
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
  console.log('Chromium: checkout, modal, autenticação, credenciais, redirecionamento na mesma aba e pagamento simulado, ViaCEP, saída e responsividade (1448/768/390/320 px).');
} finally {
  await browser?.close();
  await app.close();
}
