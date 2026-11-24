# CS TRP 013

Checkout de cartão em português brasileiro para a venda de um PC Gamer. A página reúne os dados do comprador, o endereço de cobrança, as opções de parcelamento e o resumo do pedido. Ao finalizar, o comprador abre o checkout oficial da Pagar.me na mesma aba para digitar o cartão. No topo, **CONECTAR CHAVE SK — PAGAR.ME / STONE** abre o acesso administrativo.

O frontend usa React, TypeScript e Vite. O backend Express roda em Node.js e é empacotado como Vercel Function. O Neon armazena as configurações, os preços autorizados, as sessões e os registros de pagamento.

## Instalação no Windows 11

Use Node.js 22 ou 24 e Git no PowerShell. Execute cada comando por vez.

```powershell
git clone https://github.com/anonimatoo/CS-TRP-013.git
Set-Location CS-TRP-013
npm ci
powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup.ps1
notepad .env.local
```

Enquanto a implementação estiver em pull request, execute também `git switch codex/cs-trp-013-checkout` após entrar no diretório e antes de instalar.

Preencha `DATABASE_URL` com a conexão do Neon e `ADMIN_PASSWORD` com uma senha exclusiva e forte, de pelo menos 12 caracteres. O script gera os outros três segredos. Se houver um arquivo local, o script o preserva. A opção `-RefreshTemplate` copia a configuração atual e o modelo novo para `backups/` para comparação. Proteja essa pasta como um arquivo de credenciais.

```powershell
npm run db:inspect
npm run verify:services
npm run db:migrate
npm run dev
```

Confira o inventário antes de migrar. A migração usa o schema `cs_trp_013_v2` e tem controle de versão, checksum e trava transacional. O schema separado permite usar o mesmo banco de uma instalação legada, inclusive quando já existem as tabelas de `cs_trp_013`. A versão nova inicia com seu próprio produto, configurações e histórico. A migração 002 acrescenta os campos do checkout hospedado. A migração 003 acrescenta diagnósticos opcionais por pedido e credencial. Ambas preservam os pedidos existentes e as chaves cifradas. Se `cs_trp_013_v2` já existir com tabelas de outra aplicação, revise o mapeamento antes da primeira migração.

## Atualizar uma instalação existente

Na pasta já clonada, interrompa a instância local e guarde uma cópia segura de `.env.local`. Execute cada comando no PowerShell.

```powershell
git fetch origin
git switch codex/cs-trp-013-checkout
git pull --ff-only
npm ci
npm run db:migrate
npm run check
npm test
npm run dev
```

Confira se `DATABASE_URL` aponta para a base que você pretende atualizar. Ao voltar para uma versão anterior, mantenha a migração 003 e as colunas acrescentadas. No GitHub, use um novo commit de reversão caso seja necessário desfazer a correção na branch compartilhada.

Abra [http://localhost:5173](http://localhost:5173). O Vite encaminha `/api` para o Express na porta 3001. Para mudar a porta, ajuste também o proxy local em `vite.config.ts`. Em um domínio HTTPS configurado, o checkout envia à Pagar.me a URL de retorno com a referência do pedido. No localhost, use **Voltar** no navegador para consultar o pedido.

## Configuração pela interface

1. Abra **CONECTAR CHAVE SK — PAGAR.ME / STONE** e entre com a senha administrativa.
2. Informe a SK e use **ADICIONAR CHAVE** ou **SUBSTITUIR CHAVE SK**. A central identifica o ambiente pelo prefixo e mostra **Sandbox** para `sk_test_…` ou **Produção** para `sk_…`. O cadastro ou a troca pode ser feito separadamente da ativação das cobranças. O cadastro, o teste da conexão e a troca aceitam apenas a SK como dado de credencial.
3. Use **TESTAR CONEXÃO** para consultar pedidos, cobranças, webhooks e links de pagamento. A central mostra o resultado de autenticação, a permissão de leitura, o último HTTP e, quando houve uma criação validada com a chave atual, a data dessa criação. A ativação exige confirmação do administrador e uma leitura bem-sucedida. A escrita é comprovada pela criação de um link. Verifique a habilitação comercial de Links de Pagamento no painel ou com o suporte da Pagar.me, inclusive para captura manual, se aplicável. [Checkout oficial](https://docs.pagar.me/docs/checkout_pagarme_skill_order)
4. Em **Configuração comercial**, defina o preço em reais, o limite de parcelas, a disponibilidade do produto, o ambiente do checkout e o modo de captura. Configure `MIN_PRICE_CENTS` e `MAX_PRICE_CENTS` de acordo com os limites do seu contrato. O preço inicial fica sem valor, o backend aplica a versão vigente e o comprador vê o total e as parcelas.
5. Use **ATIVAR GATEWAY** para liberar pagamentos no ambiente escolhido. **DESATIVAR GATEWAY** bloqueia novas solicitações de compra; uma cobrança já enviada continua sob controle da Pagar.me. **DESCONECTAR CHAVE** apaga a credencial do aplicativo e requer reconexão para consultas remotas posteriores. O histórico local permanece disponível. Faça a revogação definitiva no painel Pagar.me após desconectar ou rotacionar.
6. Use **FECHAR** para voltar ao checkout mantendo o formulário preenchido na página. Use **SAIR** para revogar a sessão atual. A sessão também expira automaticamente após quatro horas.

Se a central mostrar **Produção bloqueada** no Windows, defina `ALLOW_LIVE_PAYMENTS=true` no `.env.local` e reinicie `npm run dev` quando estiver pronto para receber cobranças reais. Depois, ative o gateway de Produção. Em **Configuração comercial**, selecione **Produção** em **Ambiente do checkout**, confirme o preço e marque **Produto disponível para venda**.

Por ambiente, a aplicação associa pedidos à conta comercial. Uma credencial substituta precisa passar no teste e consultar um pedido de referência quando há histórico remoto. Se a Pagar.me recusar a credencial, a configuração anterior é preservada. A chave nova é usada nos pedidos seguintes sem reiniciar o processo. Alterar a conta comercial de um ambiente com histórico exige migração planejada.

## Vercel e Neon

Importe o repositório como projeto Vite na Vercel. Use a versão suportada do Node selecionada no projeto. O arquivo `vercel.json` define a build e encaminha as rotas de API, inclusive as aninhadas, à função Express. A branch `codex/cs-trp-013-checkout` tem deploy automático por Git desativado. Use a CLI da Vercel com o projeto de homologação para produzir uma prévia. Após homologação e autorização do responsável, publique a produção de forma explícita. [Deploy pela branch](https://vercel.com/docs/git)

| Variável | Configuração |
| --- | --- |
| `DATABASE_URL` | URL da conexão Neon com TLS. Use a URL com pool para execução serverless. O driver usa `sslmode=verify-full` e preserva os demais parâmetros do Neon. |
| `ADMIN_PASSWORD` | Senha administrativa única com pelo menos 12 caracteres. |
| `SESSION_SECRET` | Segredo de sessão com pelo menos 32 caracteres. |
| `ENCRYPTION_KEY` | Exatamente 32 bytes aleatórios codificados em Base64. Mantenha a mesma chave enquanto existirem credenciais armazenadas. |
| `WEBHOOK_SECRET` | Segredo aleatório de 32 a 128 caracteres seguros para URL. |
| `APP_ORIGIN` | Origem HTTPS exata, incluindo esquema e domínio. |
| `MIN_PRICE_CENTS`, `MAX_PRICE_CENTS` | Faixa de preço em centavos conforme o contrato. |
| `ALLOW_LIVE_PAYMENTS` | `false` durante a homologação. Use `true` após autorização para processamento real e validação no sandbox. |

Use contextos separados para Sandbox/Preview e Produção. Separe também as bases ou branches do Neon, as credenciais administrativas e os segredos. Execute a migração para a base correspondente antes de liberar o deploy. Proteja os aliases de prévia com dados de teste e configure `APP_ORIGIN` para o alias usado no navegador. A origem HTTPS é utilizada no endereço de retorno após o pagamento. [Vite na Vercel](https://vercel.com/docs/frameworks/frontend/vite)

Em um projeto de homologação vinculado à CLI, configure as variáveis de **Preview**, incluindo a origem HTTPS do alias a ser usado, um Neon de teste e `ALLOW_LIVE_PAYMENTS=false`. Execute os comandos individualmente.

```powershell
npx vercel link
npx vercel pull --yes --environment=preview
npx vercel env pull .env.vercel-preview.local --environment=preview
node --env-file=.env.vercel-preview.local scripts/db.mjs migrate
npx vercel build
npx vercel deploy --prebuilt
```

Para produção, depois da aprovação, confira a conta e o projeto vinculados, as variáveis de **Production**, o backup do Neon e a migração aplicada na base de produção. Use `npx vercel env pull .env.vercel-production.local --environment=production` e `node --env-file=.env.vercel-production.local scripts/db.mjs migrate` na janela autorizada. Faça a build e publique.

```powershell
npx vercel pull --yes --environment=production
npx vercel build --prod
npx vercel deploy --prebuilt --prod
```

Para rollback, interrompa novas criações se houver incidentes financeiros e verifique os pedidos em trânsito no painel da Pagar.me. Na Vercel, retorne ao deployment anterior validado pela opção **Instant Rollback**, ou use `npx vercel rollback $DeploymentAnterior` com a URL anterior armazenada nessa variável. Preserve a migração aditiva e os pedidos registrados após o deploy. A configuração administrativa e o estado financeiro vivem no Neon e na Pagar.me e precisam ser conferidos após o rollback.

No painel oficial da Pagar.me, cadastre a URL HTTPS `https://SEU_DOMINIO/api/hooks/pagarme/SEU_WEBHOOK_SECRET` e habilite os eventos relevantes de pedido e cobrança (pagamento, falha, etapa de antifraude, cancelamento e estorno). Trate a URL como segredo e restrinja o acesso a logs de proxy que incluam o caminho. O Express confirma cada evento na API autenticada `GET /hooks/{hook_id}`, consulta o pedido ou a cobrança de origem e deduplica o ID do evento. Retornos transitórios podem ser reenviados pelo provedor. [Webhooks](https://docs.pagar.me/reference/vis%C3%A3o-geral-sobre-webhooks) [Consultar webhook](https://docs.pagar.me/reference/obter-webhook)

## Pagamentos e conciliação

- **FINALIZAR PAGAMENTO** cria um checkout oficial de cartão com o preço aprovado pelo lojista e o parcelamento selecionado. Cada link recebe um prazo de até 30 minutos e aceita uma sessão de pagamento. O comprador digita o cartão na página da Pagar.me. [Checkout hospedado](https://docs.pagar.me/reference/checkout-response)
- Use **Transações** para consultar o provedor, capturar autorizações ou cancelar/estornar o valor integral. O painel e a página do pedido confirmam o pagamento quando a Pagar.me informa o estado do pedido ou da cobrança. A exportação CSV é limitada a 10.000 registros por ambiente. [Cobrança](https://docs.pagar.me/docs/cobran%C3%A7a)
- Se a criação ficar sem confirmação, abra **Transações**, selecione o ambiente e o pedido e use **Consultar provedor**. A aplicação procura o pedido pelo código e, na ausência de pedido, o link pelo nome ou ID. Confira o HTTP da criação e da conciliação, o motivo da falha, a URL registrada e as referências remotas. Na loja, **CONTINUAR NA PAGAR.ME** aparece quando a consulta recupera um link ativo, íntegro, válido e ainda sem sessão.
- A aplicação reserva o pedido no Neon antes do envio e usa a referência local em `Idempotency-Key`. Um pedido ambíguo permanece em conciliação se as consultas falharem ou não encontrarem uma referência. O sistema mantém o mesmo ID e evita um novo POST para a referência existente. A compra pode ser iniciada explicitamente pelo comprador após rejeição inequívoca, finalização financeira ou confirmação do encerramento do link sem sessões e sem pedido. Para investigar manualmente, procure no painel da Pagar.me pelo código local e pelo nome `CS TRP 013 <referência>`. Se as evidências forem inconclusivas, preserve o pedido e leve a referência e a categoria registrada ao suporte. [Idempotência](https://docs.pagar.me/docs/o-que-%C3%A9)
- A loja usa `POST /paymentlinks`, `GET /paymentlinks` e `GET /paymentlinks/{id}` para o checkout. A API de Links usa `sdx-api.pagar.me/core/v5` no Sandbox e `api.pagar.me/core/v5` em Produção. Consultas de pedidos, cobranças, webhooks, captura e estorno usam `api.pagar.me/core/v5` com a SK do ambiente correspondente. O parcelamento explícito fica em `installments`, conforme a referência, e a aplicação usa `is_building: false`. [Criar link](https://docs.pagar.me/reference/criar-link) [Buscar links](https://docs.pagar.me/reference/obter-links) [Autenticação V5](https://docs.pagar.me/reference/autentica%C3%A7%C3%A3o-2)

## Segurança e manutenção

A Secret Key é enviada do modal ao backend sob HTTPS e fica criptografada em AES-256-GCM, com IV aleatório e vínculo autenticado entre conta e ambiente. A API administrativa devolve o estado da integração. A sessão usa cookie HTTP-only com `SameSite=Strict`, `Secure` em produção e armazenamento no banco. As rotas de alteração verificam origem e CSRF. Senha e segredos ficam nas variáveis de ambiente. Evite prefixos `VITE_` para segredos.

O comprador fornece número, validade e CVV na página oficial da Pagar.me. A aplicação encaminha os dados de cadastro e cobrança preenchidos na loja para a Pagar.me ao criar o checkout. O banco local guarda as referências, o endereço do checkout e os estados do pedido, sem persistir CPF, endereço de cobrança ou dados de cartão. Avalie com a Pagar.me as obrigações PCI DSS e LGPD para o seu contrato e operação.

Mantenha as migrações em controle de versão, faça backups do Neon compatíveis com a retenção do negócio e mantenha os backups fora do GitHub. Para limpar sessões expiradas e contadores vencidos, execute periodicamente o comando abaixo. Trocar `SESSION_SECRET` invalida as sessões.

### Rotação de credenciais

1. Inventarie os segredos expostos, onde foram usados e quais implantações ainda os leem. Gere substitutos em um gerenciador de segredos. Trate backups e logs que possam conter credenciais como material restrito.
2. Substitua cada SK na central, usando nova chave da mesma conta e ambiente. Confira se a aplicação ainda consulta os pedidos existentes. Revogue a SK anterior no painel oficial assim que validar a troca. Coordene a remoção do webhook antigo com o cadastro do novo segredo e valide eventos e conciliação. Troque também a senha administrativa, `SESSION_SECRET` e a credencial Neon exposta nos respectivos provedores.
3. Para girar `ENCRYPTION_KEY`, agende uma janela que suspenda criações e alterações administrativas. Teste em uma cópia da base a recifragem de `gateway.secret` com os auxiliares AES-256-GCM existentes, preservando o contexto `ambiente:conta` de cada registro. Na base alvo, faça a recifragem em uma transação que trave os registros e valide a descriptografia com a chave nova antes do commit. Troque a variável de ambiente de todas as instâncias e confirme leitura e conciliação antes de reativar. Coordene webhooks durante a janela para poder reprocessar eventos, se necessário.
4. Planeje o rollback com as duas chaves sob custódia e com atualização coordenada dos ciphertexts e das instâncias. Preserve a chave anterior apenas pelo período em que os backups dependam dela. Em caso de exposição, mantenha as Secret Keys da Pagar.me revogadas mesmo com rollback da aplicação.

```powershell
node --env-file=.env.local scripts/maintenance.mjs
```

## Verificação

```powershell
npm run check
npm run build
npm test
npx playwright install chromium
npm run test:browser
npm audit
npm audit --omit=dev
```

Os testes automatizados usam PostgreSQL em WASM (PGlite), Express local e respostas controladas da Pagar.me. Nenhuma resposta desse ambiente é usada no aplicativo publicado. Para homologação real, use chaves Sandbox da conta e cartões oficiais do checkout. [Guia de Sandbox do checkout](https://docs.pagar.me/docs/checkout_pagarme_skill_order)

Consulte [TESTES.md](TESTES.md) para a execução registrada e as pendências de homologação.
