import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { fixture, account, firstKey, liveKey, password, publicKey, secondKey, wrongKey } from './fixture.mjs';

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
  await modal.getByText('Aguardando tokenização', { exact: true }).waitFor();
  assert.equal(await modal.getByRole('button', { name: 'ATIVAR GATEWAY', exact: true }).isEnabled(), false);
  await secretField.fill(firstKey);
  await modal.getByText('Ambiente identificado: Sandbox.', { exact: true }).waitFor();
  assert.equal(await environment.inputValue(), 'test');
  assert.equal(await modal.getByLabel('Chave pública para tokenização').isVisible(), false);
  await modal.getByRole('button', { name: 'ADICIONAR CHAVE' }).click();
  await modal.getByText('Aguardando tokenização', { exact: true }).waitFor();
  assert.equal(await secretField.inputValue(), '');
  await modal.getByRole('button', { name: 'TESTAR CONEXÃO' }).click();
  await modal.locator('[role=status]').getByText('Pagar.me respondeu às consultas autenticadas de leitura.').waitFor();
  const activate = modal.getByRole('button', { name: 'ATIVAR GATEWAY', exact: true });
  assert.equal(await activate.isEnabled(), false);
  await modal.getByText('Configuração da tokenização', { exact: true }).click();
  await modal.getByLabel('Chave pública para tokenização').fill(publicKey);
  await modal.getByLabel('Identificador da conta Pagar.me').fill(account);
  await modal.getByRole('button', { name: 'SALVAR TOKENIZAÇÃO' }).click();
  await modal.getByText('Configuração de tokenização salva.').waitFor();
  await modal.getByText('Configuração da tokenização', { exact: true }).click();
  await activate.click();
  await modal.getByRole('checkbox', { name: /Confirmei as permissões/ }).check();
  await modal.getByRole('button', { name: 'Confirmar', exact: true }).click();
  await modal.getByText('Conectado e ativado').waitFor();
  await secretField.fill(wrongKey);
  await modal.getByRole('button', { name: 'SUBSTITUIR CHAVE SK' }).click();
  await modal.getByRole('alert').getByText(/Invalid API key/).waitFor();
  await modal.getByText('Conectado e ativado').waitFor();
  await secretField.fill(secondKey);
  await modal.getByRole('button', { name: 'SUBSTITUIR CHAVE SK' }).click();
  await modal.getByText(/Chave substituída/).waitFor();
  await modal.getByRole('button', { name: 'Configuração comercial' }).click();
  await modal.getByLabel('Valor da venda').fill('2.999,99');
  await modal.getByLabel('Máximo de parcelas').fill('6');
  await modal.getByRole('checkbox', { name: 'Produto disponível para venda' }).check();
  await modal.getByRole('button', { name: 'SALVAR CONFIGURAÇÃO' }).click();
  await modal.getByText('Configuração comercial salva.').waitFor();
  await modal.getByRole('button', { name: 'FECHAR', exact: true }).click();
  assert.equal(await page.getByLabel('Nome completo').inputValue(), 'COMPRADOR TESTE');

  await page.getByLabel('CPF').fill('52998224725');
  await page.getByLabel('E-mail').fill('comprador@example.com');
  await page.getByLabel('Celular com DDD').fill('11900000000');
  await page.getByLabel('CEP').fill('01001000');
  await page.getByText('Endereço consultado. Confira os dados.').waitFor();
  assert.equal(await page.getByLabel('Rua', { exact: false }).inputValue(), 'Praça da Sé');
  await page.getByPlaceholder('Nº').fill('1');

  const sandboxCard = '4000000000000010';
  let tokenCalls = 0;
  await page.route('https://api.pagar.me/core/v5/tokens?*', async route => {
    tokenCalls++;
    assert.equal(route.request().postDataJSON().card.number, sandboxCard);
    await route.fulfill({ json: { id: 'token_BrowserTest' }, headers: { 'Access-Control-Allow-Origin': app.origin } });
  });
  await page.getByLabel('Número do cartão').fill(sandboxCard);
  await page.getByLabel('Nome impresso no cartão').fill('Portador Teste');
  await page.getByLabel('Validade (MM/AA)').fill('1235');
  await page.getByLabel('CVV').fill('123');
  await page.getByRole('button', { name: 'FINALIZAR PAGAMENTO' }).click();
  await page.getByText('Pagamento aprovado', { exact: true }).waitFor();
  assert.equal(tokenCalls, 1);
  assert.equal(app.remote.chargePosts, 1);
  assert.ok(!ownRequests.some(body => body.includes(sandboxCard) || body.includes('"cvv"') || body.includes('"holder_name"')));
  if (process.env.BROWSER_SCREENSHOT_DIR) {
    await page.screenshot({ path: process.env.BROWSER_SCREENSHOT_DIR + '/desktop.png', fullPage: true });
  }
  await page.reload();
  await page.getByText('Pagamento aprovado', { exact: true }).waitFor();
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
  assert.equal(await page.getByRole('button', { name: 'FINALIZAR PAGAMENTO' }).isDisabled(), true);

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
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  console.log('Chromium: checkout, modal, autenticação, credenciais, pagamento simulado em fixture, ViaCEP, saída e responsividade (1448/768/390/320 px).');
} finally {
  await browser?.close();
  await app.close();
}
