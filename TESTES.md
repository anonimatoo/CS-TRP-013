# Testes do CS TRP 013

## Verificação do multi-lojista e das notificações

`npm run check`, `npm run build`, `npm test` e `npm run test:browser` verificam o checkout direto com PGlite, Chromium e respostas simuladas da Pagar.me e do SDK Stone.

A suíte cobre crédito parcelado, débito à vista, 3DS obrigatório, autenticação cancelada, aprovação, recusa, gateway desativado, débito sem confirmação comercial, reenvios concorrentes, conciliação após timeout, webhooks e histórico de pedidos anteriores. No navegador, confira também a ausência de dados de cartão no tráfego para o aplicativo e o parcelamento oculto no débito.

### Resultados executados em 26/11/2026

| Verificação | Resultado |
| --- | --- |
| `npm run check` e `npm run build` | Sintaxe, TypeScript e Vite aprovados. |
| `npm test` com Node.js 24.22.3 | 41 testes passaram. |
| `node --test` com Node.js 22.23.5 | 41 testes passaram. |
| PostgreSQL 16 local, com duas conexões ao worker concorrentes | 7 testes passaram na suíte multi-lojista e de notificações. |
| `npm run test:browser` | Chromium aprovado em 1448, 768, 390 e 320 px. |
| `vercel build` local, CLI 48.12.1 | Build Output API gerada, com função Node.js e configuração do cron. |
| `npm audit --omit=dev` | O registro não reportou vulnerabilidades nas dependências de produção. O lock usa `uuid 11.1.1` por override compatível com o uso de `v4` pelo ExcelJS. |

### Cobertura adicional

- Duas contas em ambientes independentes, validação de titularidade, chave cifrada, rejeição de credencial cruzada e preservação de pedidos pendentes durante a rotação.
- Migração desde a versão 002, conciliação dos pedidos identificados e isolamento dos pedidos, transações e eventos de titularidade desconhecida.
- Captura confirmada por resposta autenticada e webhook validado. Pagamento pendente, recusado, apenas autorizado, Sandbox e lojista sem autorização ficam fora da fila.
- XLSX lido de volta com ExcelJS. O teste verifica cabeçalhos, valores, taxas, líquido, totalizador, texto que se parece com fórmula e ausência de credenciais e dados sensíveis.
- Envio simulado, reprocessamento com espera progressiva, recuperação da fila, revogação, deduplicação sob concorrência, isolamento do download e bloqueio de reenvio quando a entrega anterior é incerta.
- No Chromium, cadastro e seleção de lojista, autorização e revogação de destinatário, histórico sem titularidade em modo de consulta e download do relatório.

### Reprodução

```powershell
npm ci
npm run check
npm run build
npm test
npx playwright install chromium
npm run test:browser
```

Para repetir o cenário multi-lojista com PostgreSQL nativo, use uma instância local e um banco vazio descartável. O fixture cria as estruturas e só aceita endereço de loopback.

```powershell
$env:CS013_TEST_POSTGRES_URL = 'postgresql://USUARIO_TESTE:SENHA_TESTE@127.0.0.1:5432/BANCO_TESTE_VAZIO'
node --test tests/multi-merchant.test.mjs
Remove-Item Env:CS013_TEST_POSTGRES_URL
```

### Arquivos

| Área | Arquivos |
| --- | --- |
| Migrações | `database/migrations/006_merchants.sql`, `database/migrations/007_financial_notifications.sql` |
| Lojistas e checkout | `server/merchants.mjs`, `server/app.mjs`, `server/gateway.mjs`, `server/payments.mjs`, `server/pagarme.mjs`, `server/cards.mjs`, `server/db.mjs`, `server/security.mjs` |
| Relatórios e fila | `server/reports.mjs`, `server/notifications.mjs`, `server/index.mjs`, `vercel.json` |
| Interface | `src/App.tsx`, `src/App.css`, páginas `Checkout`, `Dashboard`, `Gateway`, `Settings`, `Transactions` e `Notifications`, serviços `api` e `cards` |
| Testes | `tests/multi-merchant.test.mjs`, `tests/browser.mjs`, `tests/checkout.test.mjs`, `tests/fixture.mjs`, `tests/migration.test.mjs`, `tests/reconciliation.test.mjs`, `tests/vercel.test.mjs` |
| Operação | `.env.example`, `README.md`, `TESTES.md`, `package.json`, `package-lock.json` |

## Homologação oficial pendente

A homologação remota de Neon, Vercel e SMTP está pendente. Valide a conectividade SMTP da Vercel com o provedor e use somente destinatários de teste autorizados. Os testes automatizados usaram Pagar.me e SMTP simulados.

A execução requer um ambiente HTTPS com domínio cadastrado na Pagar.me, Neon de teste, PK e SK sandbox instaladas por meio seguro, acesso 3DS e habilitação de débito online confirmada para a conta. A autorização do débito precisa ser conferida com a Pagar.me e a adquirente. Confirme o formato aceito para o pedido tokenizado com 3DS no contrato da conta, especialmente para débito. A referência pública de débito traz exemplos de autenticadores diferentes do 3DS Stone. [Débito](https://docs.pagar.me/reference/cart%C3%A3o-de-d%C3%A9bito-2) · [Manual e cartões de teste 3DS](https://docs.pagar.me/docs/manual-integracao-3ds)

| Cenário | Verificação no sandbox oficial |
| --- | --- |
| Crédito | Pagar à vista e com parcelas autorizadas. Confirmar valor, parcelas e identificação no Neon. |
| Débito | Pagar à vista com cartão oficial da modalidade. Confirmar captura e modalidade no Neon. |
| 3DS | Testar aprovação sem interação e desafio do emissor com os cartões oficiais do manual. |
| Aprovação e recusa | Conferir o estado na interface e no painel da Pagar.me. Comparar código e motivo quando retornados. |
| Autenticação incompleta | Cancelar o desafio do emissor. Confirmar a ausência de cobrança e o registro do status. |
| Gateway desativado | Desativar gateway e confirmar bloqueio das novas compras na interface e na API. |
| Modalidade não autorizada | Remover a habilitação de débito e verificar o bloqueio na interface e na API. |
| Cobrança duplicada | Reenviar a mesma referência e conferir um único pedido no painel, inclusive após interrupção de rede. |

## Diagnóstico de cartão de débito V5

Na Central de Gateway, selecione o lojista e o ambiente e execute **Diagnóstico de cartão de débito**. O painel usa a Secret Key cadastrada para verificar as permissões observáveis de leitura de pedidos, webhooks e cobranças. O identificador da conta vem dos webhooks ou do vínculo registrado. Quando já consta no cadastro local da conta, o modelo Gateway ou PSP aparece com a indicação da origem. A API consultada não retorna uma lista de permissões comerciais, modelo de conta ou adquirentes habilitadas. [Listar pedidos](https://docs.pagar.me/reference/listar-pedidos) · [Listar webhooks](https://docs.pagar.me/reference/listar-webhooks) · [Listar cobranças](https://docs.pagar.me/reference/listar-cobra%C3%A7as)

O histórico amostra até 50 cobranças da primeira página. A adquirente é a informada pelo provedor na última transação de cada cobrança de débito. A modalidade histórica é identificada quando cobrança e transação coincidem com o registro de autenticação do checkout para a mesma conta, ambiente e lojista. A emissão de token 3DS Stone verifica o acesso ao início da autenticação. [Referência de débito](https://docs.pagar.me/reference/cart%C3%A3o-de-d%C3%A9bito-2) · [Manual 3DS](https://docs.pagar.me/docs/manual-integracao-3ds)

Para executar aprovação e recusa no simulador oficial, configure `PAGARME_DEBIT_SANDBOX_KEY` com uma Secret Key de um Sandbox autorizado em `.env.local` ou no ambiente seguro e rode:

```sh
npm run test:debit:sandbox
```

O comando cria até dois pedidos de teste usando exclusivamente os números publicados pelo simulador. Ele exibe cenário, HTTP, identificadores e resultado. O resultado dessas operações sem autenticação documenta o comportamento do simulador. Para validar autenticação ponta a ponta, use o fluxo 3DS e os cartões do manual, conforme a seção anterior. [Autenticação da API V5](https://docs.pagar.me/reference/autentica%C3%A7%C3%A3o-2) · [Simulador de cartão de débito](https://docs.pagar.me/docs/simulador-de-cart%C3%A3o-de-d%C3%A9bito)

### Verificação em 26/11/2026

| Comando | Resultado observado |
| --- | --- |
| `npm run check` | Sintaxe JavaScript e TypeScript aprovados. |
| `npm run build` | Build de produção Vite concluído, com 1.754 módulos processados. |
| `npm test` | 43 testes aprovados, zero falhas e zero ignorados. Inclui API Express com PGlite, integração simulada com a Pagar.me e SMTP, migrações, autorização comercial e isolamento entre lojistas. |
| `npm run test:browser` | Fluxos aprovados em Chromium, incluindo diagnóstico no painel, crédito, débito com 3DS simulado, multi-lojista e XLSX. |
| `npm run test:debit:sandbox` | Interrompido antes da primeira requisição por ausência de `PAGARME_DEBIT_SANDBOX_KEY`. A aprovação e a recusa foram exercitadas com transporte simulado na suíte automatizada. |
