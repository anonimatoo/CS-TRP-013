# CS TRP 013

Checkout de cartão em português brasileiro para a venda de um PC Gamer. A página reúne os dados do comprador, o endereço de cobrança, as opções de parcelamento e o resumo do pedido. O comprador preenche o cartão no próprio checkout e escolhe crédito à vista ou parcelado, ou débito à vista. No topo, **CONECTAR CHAVE SK — PAGAR.ME / STONE** abre o acesso administrativo.

O frontend usa React, TypeScript e Vite. O backend Express roda em Node.js e é empacotado como Vercel Function. O Neon armazena as configurações, os preços autorizados, as sessões, os registros de pagamento e a fila de notificações.

## Instalação no Windows 11

Use Node.js 22 ou 24 e Git no PowerShell do Windows 11. Execute cada comando por vez.

```powershell
git clone https://github.com/anonimatoo/CS-TRP-013.git
Set-Location CS-TRP-013
npm ci
powershell -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\setup.ps1
notepad .env.local
```

Enquanto a implementação estiver em pull request, execute também `git switch codex/cs-trp-013-multi-lojista` após entrar no diretório e antes de instalar.

Preencha `DATABASE_URL` com a conexão do Neon e `ADMIN_PASSWORD` com uma senha exclusiva e forte, de pelo menos 12 caracteres. O script gera os outros três segredos. Se houver um arquivo local, o script o preserva. A opção `-RefreshTemplate` copia a configuração atual e o modelo novo para `backups/` para comparação. Proteja essa pasta como um arquivo de credenciais.

```powershell
npm run db:inspect
npm run verify:services
npm run db:migrate
npm run dev
```

Confira o inventário antes de migrar. A migração usa o schema `cs_trp_013_v2` e tem controle de versão, checksum e trava transacional. O schema separado permite usar o mesmo banco de uma instalação legada, inclusive quando já existem as tabelas de `cs_trp_013`. A versão nova inicia com seu próprio produto, configurações e histórico. A migração 002 acrescenta os campos do checkout hospedado. A migração 003 acrescenta diagnósticos por pedido e credencial. A migração 004 acrescenta os metadados técnicos da recuperação. A migração 005 acrescenta as modalidades e os dados de autorização e autenticação. A 006 vincula os dados ao respectivo lojista e a 007 adiciona relatórios e fila de e-mails. As migrações preservam os pedidos existentes e as chaves cifradas. Se `cs_trp_013_v2` já existir com tabelas de outra aplicação, revise o mapeamento antes da primeira migração.

## Atualizar uma instalação existente

Na pasta já clonada, interrompa a instância local e guarde uma cópia segura de `.env.local`. Execute cada comando no PowerShell.

```powershell
git fetch origin
git switch codex/cs-trp-013-multi-lojista
git pull --ff-only
npm ci
npm run db:migrate
npm run check
npm test
npm run dev
```

Confira se `DATABASE_URL` aponta para a base que você pretende atualizar. Depois da migração 006, use somente versões que consultem e alterem dados por lojista. Uma versão anterior consulta os registros sem esse filtro. Interrompa novas cobranças em uma contingência e preserve a base pós-migração para conciliar as transações efetuadas.

Abra [http://localhost:5173](http://localhost:5173). O Vite encaminha `/api` para o Express na porta 3001. Para mudar a porta, ajuste também o proxy local em `vite.config.ts`. Para testar com a Pagar.me, registre o domínio HTTPS da prévia no painel do provedor.

## Configuração pela interface

1. Abra **CONECTAR CHAVE SK — PAGAR.ME / STONE** e entre com a senha administrativa. Selecione um lojista ou cadastre um nome comercial em **Adicionar lojista**. Em **Abrir checkout deste lojista**, obtenha a URL pública que inclui `?lojista=<UUID>`. A raiz continua servindo o lojista original.
2. Informe a SK e use **ADICIONAR CHAVE** ou **SUBSTITUIR CHAVE SK**. A central identifica o ambiente pelo prefixo e mostra **Sandbox** para `sk_test_…` ou **Produção** para `sk_…`. O cadastro ou a troca pode ser feito separadamente da ativação das cobranças. O cadastro, o teste da conexão e a troca aceitam apenas a SK como dado de credencial.
3. Use **TESTAR CONEXÃO** para verificar a leitura de pedidos, cobranças, webhooks e o acesso ao 3DS. Em **Modalidades e autenticação**, cadastre a PK da mesma conta e ambiente da SK e configure o crédito e a exigência de 3DS conforme a configuração comercial confirmada pela Pagar.me. Registre o domínio no painel Pagar.me para tokenização. A troca da SK pelo painel exige recadastrar a PK e revisar as modalidades.
   - Antes de habilitar débito, obtenha a confirmação da Pagar.me e da adquirente para a conta Gateway e para o ambiente em uso. Registre a referência confirmada em `PAGARME_DEBIT_APPROVAL_TEST` ou `PAGARME_DEBIT_APPROVAL_LIVE`, depois informe a mesma referência no painel. Para novos lojistas, use o JSON `PAGARME_MERCHANT_DEBIT_APPROVALS`, indexado pelo UUID do lojista e pelo ambiente `test` ou `live`. O teste de conexão confirma acesso técnico e a referência documenta a confirmação comercial, que precisa ser obtida fora da aplicação. Mantenha 3DS ativo quando exigido pelo contrato. Desative essa opção para débito somente se a Pagar.me e a adquirente autorizarem débito pinless para a operação. [Débito Pagar.me](https://docs.pagar.me/docs/cart%C3%A3o-de-d%C3%A9bito) · [Manual 3DS](https://docs.pagar.me/docs/manual-integracao-3ds)
4. Em **Configuração comercial**, defina o preço em reais, o limite de parcelas, a disponibilidade do produto, o ambiente do checkout e o modo de captura. Configure `MIN_PRICE_CENTS` e `MAX_PRICE_CENTS` de acordo com os limites do seu contrato. O preço inicial fica sem valor, o backend aplica a versão vigente e o comprador vê o total e as parcelas.
5. Use **ATIVAR GATEWAY** para liberar pagamentos no ambiente escolhido. **DESATIVAR GATEWAY** bloqueia novas solicitações de compra; uma cobrança já enviada continua sob controle da Pagar.me. **DESCONECTAR CHAVE** apaga a credencial do aplicativo e requer reconexão para consultas remotas posteriores. O histórico local permanece disponível. Faça a revogação definitiva no painel Pagar.me após desconectar ou rotacionar.
6. Use **FECHAR** para voltar ao checkout mantendo o formulário preenchido na página. Use **SAIR** para revogar a sessão atual. A sessão também expira automaticamente após quatro horas.

Se a central mostrar **Produção bloqueada** no Windows, defina `ALLOW_LIVE_PAYMENTS=true` no `.env.local` e reinicie `npm run dev` quando estiver pronto para receber cobranças reais. Depois, ative o gateway de Produção. Em **Configuração comercial**, selecione **Produção** em **Ambiente do checkout**, confirme o preço e marque **Produto disponível para venda**.

Cada lojista possui um UUID, catálogo, gateway Sandbox e gateway Produção. O administrador central seleciona a conta no painel. Listagens e operações usam o UUID selecionado. O administrador é da plataforma e tem acesso aos lojistas cadastrados. O projeto não cria logins individuais de lojista.

A aplicação identifica a conta Pagar.me por consultas autenticadas e preserva evidências de titularidade durante a rotação. Se já houver histórico remoto, testa a credencial substituta contra esse histórico. Uma credencial duplicada ou de outra conta é recusada. A SK fica cifrada e vinculada ao lojista, ambiente e conta. Consulte **Gateway → Conta Pagar.me** para verificar o identificador observado.

Na migração 006, pedidos antigos com conta verificável e igual à conta do gateway no mesmo ambiente ficam no **Lojista original**. Os demais pedidos, suas transações, ações e eventos permanecem no **Histórico sem titularidade verificada**. O administrador pode consultar e exportar esse histórico. Pagamento, conciliação remota e substituição de titularidade ficam bloqueados nesse escopo. Para regularizar, levante as evidências da Pagar.me, confira conta, ambiente, cobrança e pedido, e faça a vinculação por uma migração específica revisada. Preserve os dados de origem e as operações que entraram depois da migração.

## Vercel e Neon

Importe o repositório como projeto Vite na Vercel. Use a versão suportada do Node selecionada no projeto. O arquivo `vercel.json` define a build e encaminha as rotas de API, inclusive as aninhadas, à função Express. A branch `codex/cs-trp-013-multi-lojista` tem deploy automático por Git desativado. Use a CLI da Vercel com o projeto de homologação para produzir uma prévia. Após homologação e autorização do responsável, publique a produção de forma explícita. [Deploy pela branch](https://vercel.com/docs/git)

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

Use contextos separados para Sandbox/Preview e Produção. Separe também as bases ou branches do Neon, as credenciais administrativas e os segredos. Execute a migração para a base correspondente antes de liberar o deploy. Proteja os aliases de prévia com dados de teste e configure `APP_ORIGIN` para o alias usado no navegador. A origem HTTPS é usada na autenticação 3DS. [Vite na Vercel](https://vercel.com/docs/frameworks/frontend/vite)

Em um projeto de homologação vinculado à CLI, configure as variáveis de **Preview**, incluindo a origem HTTPS do alias a ser usado, um Neon de teste e `ALLOW_LIVE_PAYMENTS=false`. Execute os comandos individualmente.

```powershell
npx vercel link
npx vercel pull --yes --environment=preview
npx vercel env pull .env.vercel-preview.local --environment=preview
node --env-file=.env.vercel-preview.local scripts/db.mjs migrate
npx vercel build
npx vercel deploy --prebuilt
```

Para produção, depois da aprovação, confira a conta e o projeto vinculados, as variáveis de **Production** e o backup do Neon. Se estiver atualizando a partir de uma versão anterior à 006, suspenda o tráfego para a versão antiga e o processamento de pagamentos e eventos durante a janela. Aplique as migrações, publique a versão multi-lojista e só então retome o tráfego e os webhooks. Use `npx vercel env pull .env.vercel-production.local --environment=production` e `node --env-file=.env.vercel-production.local scripts/db.mjs migrate` na janela autorizada. Faça a build e publique.

```powershell
npx vercel pull --yes --environment=production
npx vercel build --prod
npx vercel deploy --prebuilt --prod
```

Para regressões após a migração 006, pause novas compras e verifique pedidos em trânsito no painel da Pagar.me. Só use **Instant Rollback** para um deployment compatível com a migração 006 e com as tabelas atuais. Para uma versão anterior à 006, restaure o backup em uma branch separada do Neon e trate a reconciliação dos registros posteriores antes de servir tráfego.

Em **Gateway**, selecione o lojista e o ambiente e copie a **URL privada do webhook** para o painel da Pagar.me. Habilite os eventos de pedido e cobrança. A URL contém um segredo derivado para aquele lojista e ambiente. Preserve a URL anterior para o lojista original durante a transição e proteja os caminhos dos webhooks nos logs do proxy. O Express valida o evento via `GET /hooks/{hook_id}` e confirma o estado diretamente no pedido ou na cobrança. [Webhooks](https://docs.pagar.me/reference/vis%C3%A3o-geral-sobre-webhooks) · [Consultar webhook](https://docs.pagar.me/reference/obter-webhook)

## Pagamentos e conciliação

- O navegador tokeniza o cartão diretamente na Pagar.me. O servidor envia `POST /orders` com `credit_card` ou `debit_card`. Quando configurado, o SDK oficial Stone abre o desafio do emissor e devolve a referência de autenticação para o pedido. [Tokenização](https://docs.pagar.me/reference/criar-token-cart%C3%A3o-1) · [Manual 3DS](https://docs.pagar.me/docs/manual-integracao-3ds)
- A aplicação reserva o pedido no Neon antes de enviá-lo e usa a referência local em `Idempotency-Key`. Uma resposta incerta mantém a referência em conciliação, sem um novo POST. Consulte **Transações → Consultar provedor** para reconciliar por referência, verificar recusa, capturar crédito quando autorizado ou estornar. Links antigos continuam disponíveis para conciliação e retomada quando ainda válidos.
- O histórico e a exportação CSV mostram modalidade, valor autorizado, referências da Pagar.me, status do pagamento, status retornado pelo SDK de autenticação e código ou motivo de recusa quando disponíveis. A exportação está limitada a 10.000 registros por ambiente.

## Relatórios e notificações

Em **Relatórios e Notificações**, selecione o lojista, cadastre até cinco destinatários e confirme que o titular autorizou o compartilhamento. Marque **Enviar após captura** para ativar o envio automático desse lojista. O endereço de `EMAIL_REPORT_RECIPIENT` é somente uma sugestão no painel. Use endereço de homologação autorizado ao acionar **Enviar teste fictício**. Esse teste envia apenas uma mensagem de teste, sem anexos ou informações financeiras.

O envio automático ocorre para uma confirmação nova de captura integral em Produção, após consulta autenticada à Pagar.me. A confirmação e a criação da fila são gravadas na mesma transação PostgreSQL. A fila persiste após reinicializações e a troca de SK ou PK. Revogar a autorização ou remover o destinatário bloqueia o envio de itens ainda pendentes. E-mails já aceitos pelo SMTP não podem ser revogados pelo aplicativo.

O worker faz novas tentativas com espera progressiva quando o SMTP rejeita temporariamente a mensagem ou a conexão é recusada. Cada notificação de captura tem uma chave única por lojista, ambiente, transação e destinatário. Se houver interrupção no ponto em que o SMTP pode já ter aceitado a mensagem, o histórico registra **entrega incerta** e exige confirmação de não entrega junto ao SMTP antes do reenvio. O status **Enviada** significa que o SMTP aceitou a mensagem.

O histórico permite baixar o XLSX de cada notificação. O relatório geral pode ser baixado por lojista com filtros de ambiente, período, data, modalidade e status. O consolidado inclui somente lojistas que autorizaram compartilhamento. Os períodos diário, semanal e mensal usam o horário de Brasília e os limites do calendário. Taxas e líquido aparecem quando retornados pela Pagar.me. Relatórios não incluem dados de cartão além da bandeira, nem credenciais. [ExcelJS](https://github.com/exceljs/exceljs)

### SMTP e agendamento

| Variável | Uso |
| --- | --- |
| `SMTP_HOST`, `SMTP_PORT` | Host e porta do provedor autorizado. Para AWS SES, use o endpoint da região e porta 587 para STARTTLS. |
| `SMTP_SECURE` | Use `false` para STARTTLS obrigatório e `true` para TLS desde a conexão, normalmente porta 465. |
| `SMTP_USER`, `SMTP_PASSWORD` | Credenciais do provedor SMTP. O administrador também pode configurar uma substituição cifrada pelo painel. |
| `EMAIL_FROM` | Endereço de remetente verificado no provedor. |
| `EMAIL_REPORT_RECIPIENT` | Endereço opcional sugerido no painel. |
| `EMAIL_REPORT_ENABLED`, `EMAIL_REPORT_ON_CAPTURE` | Ambos devem ser `true` para enfileirar e processar notificações de captura. |
| `CRON_SECRET` | Segredo aleatório de pelo menos 32 caracteres. O agendador envia `Authorization: Bearer <segredo>`. |

A aplicação local executa a fila a cada 30 segundos com `npm run dev`. Na Vercel, o arquivo `vercel.json` ativa uma execução por minuto em Produção, frequência que requer Pro ou Enterprise. Use um agendador HTTPS autenticado para outros ambientes. Em um projeto Hobby, retire a entrada `crons` da configuração de publicação e use esse agendador para chamar `GET /api/jobs/notifications` a cada minuto. O agendador deve manter o segredo fora da URL, e o servidor precisa acessar o SMTP autorizado. [Vercel Cron](https://vercel.com/docs/cron-jobs/usage-and-pricing) · [Segurança do cron](https://vercel.com/docs/cron-jobs/manage-cron-jobs) · [Nodemailer](https://nodemailer.com/smtp) · [AWS SES SMTP](https://docs.aws.amazon.com/ses/latest/dg/send-email-smtp.html)

## Segurança e manutenção

A Secret Key é enviada do modal ao backend sob HTTPS e fica criptografada em AES-256-GCM, com IV aleatório e vínculo autenticado entre conta e ambiente. A API administrativa devolve o estado da integração. A sessão usa cookie HTTP-only com `SameSite=Strict`, `Secure` em produção e armazenamento no banco. As rotas de alteração verificam origem e CSRF. Senha e segredos ficam nas variáveis de ambiente. Evite prefixos `VITE_` para segredos.

O navegador envia número, validade e CVV diretamente para a tokenização oficial da Pagar.me. Quando necessário, o SDK Stone recebe os dados exigidos para 3DS e o banco coleta a confirmação do comprador na janela do emissor. O backend recebe o token do cartão e a referência transitória do 3DS. O Neon guarda o resultado e as referências financeiras, sem receber credenciais bancárias, PAN completo, CVV ou conteúdo do desafio.

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
