# Testes do CS TRP 013

Execução de 24/11/2026. A integração de teste usa Express, PostgreSQL via PGlite e respostas controladas para as APIs da Pagar.me. Nenhuma transação real foi enviada.

| Verificação | Resultado |
| --- | --- |
| `npm ci` | 177 pacotes instalados. npm 11 sinalizou o script de instalação do esbuild. As compilações concluíram. |
| `npm run check` | Sintaxe JavaScript e checagem TypeScript aprovadas. |
| `npm run build` | Build do Vite concluída. |
| `npm test` | 59 testes aprovados em Linux com Node.js 24.22.3. |
| `node --test` | Os mesmos 59 testes passaram em Linux com Node.js 22.23.5. O npm usa a descoberta de testes do próprio Node. |
| `npm run test:browser` | Chromium aprovado. Cobriu cadastro e troca de SK, detecção de ambiente, ativação, recuperação do checkout, navegação na mesma aba, retorno à loja, aprovação, recusa, expiração da sessão administrativa e layout em 1448, 768, 390 e 320 px. |
| `npm audit` e `npm audit --omit=dev` | Zero vulnerabilidades reportadas pelo registro npm. |
| Instalação PowerShell | PowerShell 7.4.21 com Node.js 22.23.5 em Linux. Geração dos três segredos, preservação de `.env.local` e cópia do modelo conferidas. |
| `vercel build` | Build local no destino Preview. O artefato tem frontend estático, rewrite de API e função Express com runtime `nodejs24.x` e limite de 30 s. A CLI selecionou Node 24 com base em `engines`. |

## Regressões verificadas

- Criação com HTTP 200 e 201, URL nos domínios oficiais, resposta reduzida enriquecida por consulta ao ID e validade retornada pelo provedor.
- Preservação do HTTP em respostas com corpo inválido ou incompleto, com categorias distintas para ID, URL, referência, preço, parcelas e data.
- HTTP 400, 401, 403, 409, 429, 422, 500 e 503, redirecionamento de API, corpo fora de JSON, timeout antes ou após cabeçalhos, DNS, conexão e TLS.
- Reserva concorrente, recuperação de link e de pedido remoto, estado incerto sem reenvio, encerramento de link apenas com zero sessões e ausência de pedido, retorno e conciliação após webhook autenticado e deduplicado.
- Migração 003 sobre a versão 002 com checkout, preço e credencial cifrada existentes. Verificação do SSL do cliente PostgreSQL, sessão expirada, preservação de credenciais e ausência de dados de cartão e de respostas brutas nos dados públicos e diagnósticos.
- Aprovação, recusa, autorização, captura e estorno simulados. O guia de homologação deve ser seguido com as credenciais oficiais da conta para verificar o contrato efetivo.

## Evidência e próximos testes em ambiente oficial

O site existente respondeu à consulta de checkout e retornou o pedido relatado como `communication_error` em Produção, com HTTP e URL de pagamento ausentes. A versão anterior reproduzia esse registro tanto em falhas antes da resposta quanto ao rejeitar uma resposta HTTP 2xx. O primeiro envio ficou sem evidência suficiente para atribuição a uma causa externa específica.

1. Aplicar a migração 003 no Neon da prévia, com backup e comparação das colunas da 002. Verificar a conexão TCP com TLS pela função implantada. O teste anterior de Neon via WSS permanece documentado no histórico do PR.
2. Vincular e publicar a prévia de homologação da Vercel com HTTPS, segredos e origem própria. Conferir o alias, a rota `/api/checkout`, a autenticação administrativa e o retorno após o checkout.
3. Com SK autorizada de Sandbox instalada por mecanismo seguro, verificar leitura e criação de link, abertura do formulário oficial, aprovação e recusa com cartões de teste, webhooks, conciliação, captura e estorno conforme o contrato. Conferir os limites de valor e parcelamento e a habilitação de Links de Pagamento com a Pagar.me.
4. Em Produção, conciliar o pedido histórico pelo código e pelo nome do checkout, mantendo os dados locais até que haja confirmação do provedor.

A implantação remota da prévia, a migração no Neon remoto e a homologação oficial da Pagar.me ficaram pendentes por ausência de acesso ao projeto e às credenciais autorizadas neste ambiente. A publicação de produção depende da autorização do responsável.
