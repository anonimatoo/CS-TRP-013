# CS TRP 013

Checkout de cartão em português brasileiro para a venda de um PC Gamer. A página reúne os dados do comprador, o endereço de cobrança, o formulário de cartão e o resumo do pedido. No topo, **CONECTAR CHAVE SK — PAGAR.ME / STONE** abre o acesso administrativo.

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

Preencha `DATABASE_URL` com a conexão do Neon e `ADMIN_PASSWORD` com uma senha exclusiva e forte, de pelo menos 12 caracteres. O script gera os outros três segredos. Se houver um arquivo local, o script o preserva. A opção `-RefreshTemplate` cria um backup em `backups/` antes de substituir o arquivo. Proteja essa pasta como um arquivo de credenciais.

```powershell
npm run db:inspect
npm run verify:services
npm run db:migrate
npm run dev
```

Confira o inventário antes de migrar. A migração usa o schema `cs_trp_013_v2` e tem controle de versão, checksum e trava transacional. O schema separado permite usar o mesmo banco de uma instalação legada, inclusive quando já existem as tabelas de `cs_trp_013`. A versão nova inicia com seu próprio produto, configurações e histórico. Se `cs_trp_013_v2` já existir com tabelas de outra aplicação, revise o mapeamento antes da primeira migração.

Abra [http://localhost:5173](http://localhost:5173). O Vite encaminha `/api` para o Express na porta 3001. Para mudar a porta, ajuste também o proxy local em `vite.config.ts`. Use o domínio HTTPS cadastrado na Pagar.me para testar a tokenização caso o provedor recuse a origem local. [Domínio na Pagar.me](https://docs.pagar.me/docs/configurando-a-dashboard-nuvemshop#configura%C3%A7%C3%A3o-de-dom%C3%ADnio)

## Configuração pela interface

1. Abra **CONECTAR CHAVE SK — PAGAR.ME / STONE** e entre com a senha administrativa.
2. Informe a SK e use **ADICIONAR CHAVE** ou **SUBSTITUIR CHAVE SK**. A central identifica o ambiente pelo prefixo e mostra **Sandbox** para `sk_test_…` ou **Produção** para `sk_…`. O cadastro ou a troca pode ser feito separadamente da ativação das cobranças. O cadastro, o teste da conexão e a troca aceitam apenas a SK como dado de credencial. A troca reutiliza a configuração de tokenização já salva.
3. Use **TESTAR CONEXÃO** para consultar pedidos, cobranças e webhooks. Se a configuração da conta for PSP, a central também consulta clientes. Guarde a PK, a modalidade Gateway ou PSP e o ID comercial em **Configuração da tokenização** ao configurar o checkout pela primeira vez. O ID pode vir preenchido quando o provedor o informa numa consulta de webhooks. A Pagar.me exige a PK para tokenizar o cartão diretamente no navegador. A central informa a data, o HTTP e o resultado do teste. Confirme as permissões de escrita e o vínculo das chaves no painel da Pagar.me antes de validar em sandbox. [Tokenização de cartão](https://docs.pagar.me/reference/criar-token-cart%C3%A3o-1)
4. Em **Configuração comercial**, defina o preço em reais, o limite de parcelas, a disponibilidade do produto, o ambiente do checkout e o modo de captura. Configure `MIN_PRICE_CENTS` e `MAX_PRICE_CENTS` de acordo com os limites do seu contrato. O preço inicial fica sem valor, o backend aplica a versão vigente e o comprador vê o total e as parcelas.
5. Use **ATIVAR GATEWAY** para liberar pagamentos no ambiente escolhido. **DESATIVAR GATEWAY** bloqueia novas solicitações de compra; uma cobrança já enviada continua sob controle da Pagar.me. **DESCONECTAR CHAVE** apaga a credencial do aplicativo e requer reconexão para consultas remotas posteriores. O histórico local permanece disponível. Faça a revogação definitiva no painel Pagar.me após desconectar ou rotacionar.
6. Use **FECHAR** para voltar ao checkout mantendo o formulário preenchido na página. Use **SAIR** para revogar a sessão atual. A sessão também expira automaticamente após quatro horas.

Por ambiente, a aplicação associa pedidos à conta comercial. Uma credencial substituta precisa passar no teste e consultar um pedido de referência quando há histórico remoto. Se a Pagar.me recusar a credencial, a configuração anterior é preservada. A chave nova é usada nos pedidos seguintes sem reiniciar o processo. Alterar a conta comercial de um ambiente com histórico exige migração planejada.

## Vercel e Neon

Importe o repositório como projeto Vite na Vercel. Use a versão suportada do Node selecionada no projeto. O arquivo `vercel.json` define a build e encaminha as rotas de API, inclusive as aninhadas, à função Express. Para uma prévia a partir de um projeto vinculado ao GitHub, use **Deployments → Create Deployment** e escolha a branch `codex/cs-trp-013-checkout` enquanto o PR estiver aberto. [Deploy pela branch](https://vercel.com/docs/git)

| Variável | Configuração |
| --- | --- |
| `DATABASE_URL` | URL da conexão Neon com TLS. Use a URL com pool para execução serverless e confirme `sslmode=verify-full`. |
| `ADMIN_PASSWORD` | Senha administrativa única com pelo menos 12 caracteres. |
| `SESSION_SECRET` | Segredo de sessão com pelo menos 32 caracteres. |
| `ENCRYPTION_KEY` | Exatamente 32 bytes aleatórios codificados em Base64. Mantenha a mesma chave enquanto existirem credenciais armazenadas. |
| `WEBHOOK_SECRET` | Segredo aleatório de 32 a 128 caracteres seguros para URL. |
| `APP_ORIGIN` | Origem HTTPS exata, incluindo esquema e domínio. |
| `MIN_PRICE_CENTS`, `MAX_PRICE_CENTS` | Faixa de preço em centavos conforme o contrato. |
| `ALLOW_LIVE_PAYMENTS` | `false` durante a homologação. Use `true` após autorização para processamento real e validação no sandbox. |

Use contextos separados para Sandbox/Preview e Produção. Separe também as bases ou branches do Neon, as credenciais administrativas e os segredos. Execute a migração para a base correspondente antes de liberar o deploy. Proteja os aliases de prévia com dados de teste e configure `APP_ORIGIN` para o alias usado no navegador. Cadastrar a origem na Pagar.me é obrigatório para tokenização. [Vite na Vercel](https://vercel.com/docs/frameworks/frontend/vite)

No painel oficial da Pagar.me, cadastre a URL HTTPS `https://SEU_DOMINIO/api/hooks/pagarme/SEU_WEBHOOK_SECRET` e habilite os eventos relevantes de pedido e cobrança (pagamento, falha, etapa de antifraude, cancelamento e estorno). Trate a URL como segredo e restrinja o acesso a logs de proxy que incluam o caminho. O Express confirma cada evento na API autenticada `GET /hooks/{hook_id}`, consulta o pedido ou a cobrança de origem e deduplica o ID do evento. Retornos transitórios podem ser reenviados pelo provedor. [Webhooks](https://docs.pagar.me/reference/vis%C3%A3o-geral-sobre-webhooks) [Consultar webhook](https://docs.pagar.me/reference/obter-webhook)

## Pagamentos e conciliação

- Em **Gateway**, o pedido usa a referência temporária `card_token` e envia o endereço de cobrança no payload. Em **PSP**, a aplicação cria ou atualiza o cliente, registra o cartão com o token junto à Pagar.me e envia a referência `card_id`. O cartão fica na carteira do provedor conforme as configurações da conta PSP. O aplicativo não mantém o identificador do cartão para uso futuro. [Tokenização](https://docs.pagar.me/reference/tokeniza%C3%A7%C3%A3o-1) [Criar pedido](https://docs.pagar.me/reference/criar-pedido-2) [Criar cartão](https://docs.pagar.me/reference/criar-cart%C3%A3o)
- Use **Transações** para consultar o provedor, capturar autorizações ou cancelar/estornar o valor integral. A exportação CSV é limitada a 10.000 registros por ambiente. O painel mostra códigos e motivos que o provedor efetivamente enviou e que passaram pelo filtro de dados sensíveis. [Cobrança](https://docs.pagar.me/docs/cobran%C3%A7a)
- Se houver falha de comunicação após o envio, pesquise a referência local no painel ou use **Consultar provedor**. A aplicação reserva o pedido antes de chamar a Pagar.me e usa a referência em `Idempotency-Key`. Ela não reenvia cobranças de resultado incerto. Se uma operação de captura ou estorno ficar sem confirmação, concilie no provedor antes de repetir qualquer ação financeira. [Idempotência](https://docs.pagar.me/docs/o-que-%C3%A9)
- O formato do cartão, a bandeira e o Luhn são validações de entrada. A confirmação exibida vem da Pagar.me. O provedor continua responsável pela adquirência e pelos controles de antifraude da conta. A integração 3DS Stone no navegador depende de habilitação e integração específicas. Se o contrato exigir 3DS, mantenha produção desativada até homologar esse fluxo com a Pagar.me. [Antifraude](https://docs.pagar.me/reference/vis%C3%A3o-geral-sobre-antifraude-1) [Manual de integração 3DS](https://docs.pagar.me/docs/manual-integracao-3ds)

## Segurança e manutenção

A Secret Key é enviada do modal ao backend sob HTTPS e fica criptografada em AES-256-GCM, com IV aleatório e vínculo autenticado entre conta e ambiente. A API devolve apenas os metadados da integração e a chave pública de tokenização. A sessão usa cookie HTTP-only com `SameSite=Strict`, `Secure` em produção e armazenamento no banco. As rotas de alteração verificam origem e CSRF. Senha e segredos ficam nas variáveis de ambiente. Evite prefixos `VITE_` para segredos.

O envio de PAN, validade, CVV e titular sai do navegador diretamente para a Pagar.me. A API de compra aceita campos do comprador e um token temporário. O banco local guarda as referências e os estados do pedido, sem persistir CPF, endereço, dados de cartão ou token. A página não inclui scripts de terceiros. Avalie com a Pagar.me as obrigações PCI DSS aplicáveis ao modelo de tokenização, mantenha o inventário e a integridade dos scripts da página e apresente o aviso de privacidade do lojista antes da entrada em produção. Configure no provedor a retenção dos dados de clientes, o atendimento a titulares e a exclusão conforme as obrigações LGPD aplicáveis. A aplicação não emite certificação de conformidade.

Mantenha as migrações em controle de versão, faça backups do Neon compatíveis com a retenção do negócio e mantenha os backups fora do GitHub. Para limpar sessões expiradas e contadores vencidos, execute periodicamente o comando abaixo. Trocar `SESSION_SECRET` invalida as sessões. Trocar `ENCRYPTION_KEY` exige desconectar e recadastrar as credenciais de cada ambiente, com janela de manutenção. Guarde a chave de criptografia de forma protegida pelo tempo de retenção dos backups correspondentes.

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
```

Os testes automatizados usam PostgreSQL em WASM (PGlite), Express local e respostas controladas da Pagar.me. Nenhuma resposta desse ambiente é usada no aplicativo publicado. Para homologação real, use chaves Sandbox da conta e cartões oficiais correspondentes à modalidade. [Simulador Gateway](https://docs.pagar.me/docs/simulador-de-cart%C3%A3o-de-cr%C3%A9dito) [Simulador PSP](https://docs.pagar.me/docs/simulador-psp)

Consulte [TESTES.md](TESTES.md) para a execução registrada e as pendências de homologação.
