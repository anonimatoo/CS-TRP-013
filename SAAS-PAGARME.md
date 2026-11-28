# CS-TRP-013 — SaaS de links Pagar.me V5

## Arquitetura e escopo

- O cadastro cria um lojista e sua conta de acesso no mesmo commit PostgreSQL. O e-mail normalizado serve como identificador de login. A senha tem salt aleatório e hash scrypt. A sessão usa cookie HttpOnly e SameSite, com Secure em produção, expiração, verificação de origem e proteção CSRF.
- O servidor obtém o lojista da sessão. A seleção de outro lojista, as configurações SMTP e Telegram globais e a consolidação de relatórios são restritas à operação da plataforma. As sessões antigas do operador preservam seu papel. O cadastro novo cria uma loja nova. A titularidade de lojas antigas não é transferida pelo cadastro público.
- As SKs usam AES-256-GCM vinculado ao lojista, ambiente e conta. O backend usa a chave correspondente nas consultas, criação e conciliação. A conta precisa ser confirmada por evidência consultada com a própria SK. O link usa a conta da chave, sem split ou destinatário aceito do navegador. O checkout da Pagar.me coleta os dados do cartão fora da aplicação. [Autenticação](https://docs.pagar.me/reference/autentica%C3%A7%C3%A3o-2) · [Criar link](https://docs.pagar.me/reference/criar-link)
- Cada link aceita um pagamento de cartão de crédito e tem validade de até 30 minutos. A URL pública do pedido redireciona para um checkout HTTPS validado. Um link pendente ou ambíguo é conciliado por consultas oficiais sem repetir o POST de criação. A migração `009_saas_accounts.sql` acrescenta contas e sessões individuais e permite preços independentes nos pedidos hospedados. Os preços e pedidos anteriores são preservados.
- O diagnóstico faz consultas de leitura a pedidos, cobranças, webhooks e links. Se o provedor informar explicitamente bloqueio por IP, o painel o diferencia de 401 ou 403 genéricos, timeout e indisponibilidade. A leitura dos links continua distinta da permissão para criá-los. [IP Allowlist](https://docs.pagar.me/docs/ip-allowlist) · [Listar links](https://docs.pagar.me/reference/obter-links)

## Instalação no Windows 11 ou Linux

Use Git, Node.js 22 ou 24 e um banco PostgreSQL/Neon reservado à implantação. No PowerShell:

```powershell
git clone --branch codex/cs-trp-013-checkout https://github.com/anonimatoo/CS-TRP-013.git
Set-Location CS-TRP-013
npm ci
Copy-Item .env.example .env.local
```

Preencha `.env.local` com `DATABASE_URL`, `APP_ORIGIN`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `ENCRYPTION_KEY` e `WEBHOOK_SECRET`. Em bancos existentes, preserve os segredos para reabrir as credenciais cifradas. Use `APP_ORIGIN=http://localhost:5173` para desenvolvimento local. Deixe `ALLOW_LIVE_PAYMENTS=false` para homologação.

```powershell
npm run db:migrate
npm run dev
```

Na Central de Configuração, escolha **Cadastrar lojista** e entre com a conta individual. Em Gateway, selecione Sandbox, cadastre a SK autorizada, confirme o vínculo da conta e ative o gateway. Se a listagem não trouxer o ID da conta, use em **Conectividade com a Pagar.me** a referência de um webhook existente da própria conta. O backend valida o evento com a SK cadastrada. Se a conta ainda não tiver eventos, use a configuração oficial de webhooks da Pagar.me. Um evento não financeiro como `customer.created` pode gerar evidência sem realizar cobrança. [Eventos de webhook](https://docs.pagar.me/reference/eventos-de-webhook-1)

Em **Links de pagamento**, informe o valor, a descrição e o número de parcelas. Compartilhe a URL gerada. Se o resultado pedir conciliação, use **Consultar status** para recuperar o link pelo registro já criado. Desconectar a SK interrompe novas criações no sistema. Um link já criado continua sujeito à validade e ao estado na Pagar.me.

## Publicação na Vercel e conectividade

1. Valide a migração em uma cópia do Neon. Aplique as migrações pendentes ao banco de destino antes de promover o código. Preserve as configurações existentes de SMTP, Telegram e do cron, caso usadas.
2. Configure as variáveis secretas na Vercel, incluindo `APP_ORIGIN` com o domínio HTTPS final. O deploy automático da branch de checkout está desativado. Faça uma publicação controlada após homologação.
3. Para acesso de clientes IPv6-only, use domínio próprio com uma borda IPv4/IPv6, por exemplo um registro proxied da Cloudflare, com TLS completo e origem Vercel configurada para o mesmo domínio. A Vercel documenta que sua entrada direta não oferece IPv6. Valide DNS e as duas conexões no domínio final. A aplicação usa o IP do visitante para limitação de frequência, sem lista de IPs de comerciantes. Verifique também a disponibilidade IPv6 do domínio hospedado pela Pagar.me se o comprador usar acesso exclusivamente IPv6. [IPv6 na Vercel](https://vercel.com/docs/domains/troubleshooting) · [IPv6 na Cloudflare](https://developers.cloudflare.com/network/ipv6-compatibility/)
4. Quando a conta Pagar.me exigir saída fixa, habilite **Connectivity → Static IPs** nas configurações do projeto Vercel, ou use infraestrutura de saída estática equivalente. Registre os IPs provisionados em `PAGARME_STATIC_EGRESS_IPS`, separados por vírgulas, e inclua os IPs exigidos na allowlist da conta Pagar.me. A variável documenta os IPs e não muda a rota de rede. O diagnóstico consulta ipify no servidor, sem SK. O IP observado nessa consulta não prova qual endereço a Pagar.me viu. Confirme o IP efetivo com o provedor antes de ativar operações. [Vercel Static IPs](https://vercel.com/changelog/static-ips-are-now-available-for-more-secure-connectivity) · [IP Allowlist Pagar.me](https://docs.pagar.me/docs/ip-allowlist)
5. Homologue consultas, cadastro, webhooks, checkout e relatórios em Sandbox. Ative produção somente após a confirmação comercial e técnica da conta.

Para checar a entrada em uma máquina com as duas redes, use `curl.exe -4 https://SEU_DOMINIO/api/checkout` e `curl.exe -6 https://SEU_DOMINIO/api/checkout` no Windows, ou `curl -4` e `curl -6` no Linux.

## Verificação executada em 28/11/2026

| Escopo | Resultado |
| --- | --- |
| `npm test` no commit original `75f96b8` | 68 testes aprovados, sem falhas ou ignorados. Inclui o conjunto original de diagnóstico e recuperação do checkout hospedado. |
| `npm test` nesta atualização | 47 testes aprovados, sem falhas ou ignorados. O total parte da suíte da versão multi-lojista preservada e inclui os testes SaaS adicionados. |
| `npm run check` e `npm run build` | Aprovados. Build Vite com 1.757 módulos. |
| `npm run test:browser` | Aprovado em Chromium, incluindo cadastro individual, painel de links e regressões de checkout, débito, Telegram e XLSX. |
| Rede e gateway | Conexões locais reais em IPv4 e IPv6. Pagar.me V5, resposta IP Allowlist, IP observado, SMTP e Telegram simulados. Nenhuma cobrança real. |

A suíte nova cobre troca e desconexão da SK, validação de titularidade por evento, bloqueio cruzado de credenciais, pedidos e relatórios, idempotência, recuperação de link após timeout e respostas HTTP 401, 403 e 503. A execução no domínio Vercel de produção, a borda IPv6, o IP fixo real e a migração no Neon de produção dependem da configuração e da homologação da implantação.
