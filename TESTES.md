# Testes do CS TRP 013

Execução em 24/11/2026 com Node.js 24 em Linux. A documentação de instalação usa PowerShell. Nenhuma transação real foi enviada.

| Verificação | Resultado |
| --- | --- |
| `npm run check` | Sintaxe JavaScript e checagem TypeScript aprovadas. |
| `npm run build` | Build de produção do Vite concluída. |
| `npm test` | 12 testes aprovados. Validações, criptografia, sessões, limite de login, CSRF, persistência local, migrações repetíveis e preservação de tabela preexistente, ViaCEP, ciclo de credenciais, preços, concorrência, PSP, conciliação, captura, estorno, confirmação de webhook e encaminhamento no adaptador da Vercel. |
| `npm run test:browser` | Chromium aprovado em 1448, 768, 390 e 320 px. Verificou a abertura e a responsividade do modal, senha correta/incorreta, opção de exibir senha, todas as ações de credencial, continuidade do formulário, ViaCEP, tokenização interceptada e persistência da referência do pedido após recarregar. |
| Neon real | PostgreSQL 18 via WSS com certificado TLS verificado. Migração aplicada duas vezes no schema `cs_trp_013_v2`, com 11 tabelas e preservação das 21 tabelas preexistentes. Checkout HTTP 200, acesso administrativo anônimo HTTP 401 e sessão compartilhada entre duas instâncias Express com pools distintos, seguida de logout confirmado. |
| ViaCEP real | Consulta ao CEP 01001-000 retornou HTTP 200 e São Paulo/SP. |
| `npm audit` e `npm audit --omit=dev` | Zero vulnerabilidades reportadas pelo registro npm na execução. |
| `vercel.json` | Configuração validada e `vercel build` local aprovado no destino Preview. A saída incluiu o frontend estático e a função Node.js. O manifesto gerado foi verificado com cinco rotas, incluindo checkout, ViaCEP, endpoints administrativos aninhados e webhook. A implantação remota ainda está pendente. |
| Revisão de segurança do código | Verificados CSRF, origem, opções do cookie, AES-256-GCM, teste de acesso anônimo, SQL parametrizado, campos aceitos pela API e ausência de PAN, CVV e nome impresso no payload enviado ao backend. |

A suíte de integração executa as consultas e os comandos SQL em PostgreSQL via PGlite. O provedor de pagamentos é substituído por respostas controladas só na suíte. Os casos de aprovação, recusa, teste de conexão e webhook nessa suíte demonstram comportamento local da aplicação com as respostas esperadas.

## Pendências de homologação

1. Configurar `DATABASE_URL` como segredo na Vercel e testar a conexão usada pela função implantada. A migração do Neon do lojista já foi verificada por WSS. O teste em ambiente implantado ainda precisa confirmar o transporte TCP do driver `pg` e a persistência entre instâncias Vercel.
2. Configurar um projeto Vercel com HTTPS, domínio, segredos e origem. Verificar o roteamento da função e o carregamento da página pelo alias configurado.
3. Na Pagar.me, cadastrar o domínio e as credenciais oficiais de sandbox para a modalidade que o lojista utiliza. Confirmar a conta, os escopos de escrita, o pareamento da chave pública e os limites de valor/parcelamento. Verificar cadastro, teste, troca, falha de troca, ativação e remoção com as credenciais reais de sandbox.
4. Com cartões oficiais de sandbox, verificar tokenização, aprovação, recusa, autorização, captura, estorno, idempotência e callbacks entregues pela Pagar.me. Habilitar e homologar o fluxo 3DS Stone separadamente se o contrato exigir.
5. Validar procedimentos PCI DSS e LGPD no contexto do lojista e da operação. A auditoria npm e as verificações de código não substituem a avaliação de conformidade nem um teste independente da implantação.

A configuração fornecida mantém cobranças de produção desabilitadas. O processamento real depende de autorização e homologação.
