# CS TRP 013 — Telegram Monitor

## Auditoria

Em 28/11/2026, o JavaScript servido em produção por `cs-trp-013.vercel.app` era idêntico ao build do commit `75f96b8`, ponta de `codex/cs-trp-013-checkout` no momento da auditoria. O SHA-256 de ambos era `d820408bf26eac9afbc2a163f5735ba699106f03e7c9bf1909baf783f16b7674`. A branch padrão do GitHub, `main`, continha apenas a inicialização do repositório. O acesso público permite verificar o artefato publicado, mas a configuração **Production Branch** deve ser conferida no painel autenticado da Vercel antes de qualquer publicação.

A implementação parte do commit `79202b9` da branch multi-lojista indicada. O checkout e a conciliação já registram o valor pago, a captura e a transação a partir de respostas autenticadas da Pagar.me V5. O webhook usa a URL secreta por lojista e ambiente, lê o evento pelo identificador com a SK da conta, compara conta e recurso e consulta o estado efetivo no gateway. O monitor usa esse mesmo estado confirmado, seja ele obtido no checkout, por webhook ou na conciliação. [Eventos da Pagar.me](https://docs.pagar.me/reference/eventos-de-webhook-1) · [Obter cobrança](https://docs.pagar.me/reference/obter-cobran%C3%A7a)

## Segurança e operação

- Apenas captura integral em produção entra na fila. O consumidor revalida o estado e exclui pedidos pendentes, autorizados sem captura, recusados, cancelados e estornados. A troca de SK preserva a confirmação já gravada e, para eventos futuros, usa a credencial atual vinculada à mesma conta.
- O consentimento é individual e vinculado ao chat por HMAC. Pagamentos confirmados antes da autorização ficam fora da fila. Uma revogação ou mudança do destino invalida envios pendentes vinculados à concessão anterior. O chat deve ter acesso restrito às pessoas autorizadas a receber os dados.
- O painel usa a sessão administrativa existente. Escritas exigem origem válida e CSRF. O histórico e os totais são filtrados pelo lojista selecionado. As credenciais são globais. A aplicação usa a dupla de variáveis da Vercel quando qualquer uma delas foi definida. Sem ambas, o painel pode configurar um par, armazenado em AES-256-GCM com a chave existente da aplicação. As respostas exibem somente a presença e a origem da configuração.
- O bot envia texto simples com nome comercial, valor pago, método, parcelas, identificador e data/hora do gateway em `America/Sao_Paulo`. Campos que o gateway omite aparecem como indisponíveis. O bot não recebe dados de comprador, cartão, SK ou respostas brutas. A mensagem de teste é fictícia.
- A fila Neon impede duplicação por pedido e por transação em cada lojista e ambiente. Uma execução reserva até um envio. Uma janela global serializa os envios e respeita `retry_after`. Rejeições temporárias explícitas e falhas de conexão anteriores ao envio têm até seis tentativas com espera crescente. Se houver timeout após possível aceitação, resposta ambígua ou encerramento do worker durante o envio, a fila sinaliza entrega incerta para conferência no chat. O método `sendMessage` não oferece chave de idempotência para garantir a deduplicação desse caso no Telegram. [Bot API](https://core.telegram.org/bots/api#sendmessage) · [Limites](https://core.telegram.org/bots/faq#broadcasting-to-users)
- A entrega acontece no cron protegido existente. O checkout não chama o Telegram, e falhas no processamento do monitor não impedem que o mesmo cron execute a fila SMTP. Pausar pelo painel mantém pedidos elegíveis acumulados durante a pausa. A capacidade desta versão é de um envio por execução do cron.

## Configuração e publicação após aprovação

1. Confira a branch de produção, o projeto, o domínio e o plano da Vercel. O cron existente roda a cada minuto e exige um plano que permita essa frequência. [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs/usage-and-pricing)
2. Em ambiente isolado, use um Neon de homologação, um bot/chat de teste e a Pagar.me Sandbox. Para exercitar a entrega completa sem cobranças reais, use os testes automatizados com respostas simuladas. Pagamentos Sandbox são excluídos do monitor por regra.
3. Antes de promover o código aprovado, aponte `DATABASE_URL` para o banco da implantação e aplique as migrações pendentes com `npm run db:migrate`. A migração 008 é aditiva. Confira o estado anterior e valide em uma cópia do banco ao promover uma instalação da branch antiga. Preserve o `ENCRYPTION_KEY` existente.
4. No projeto Vercel, configure `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID` numérico nas variáveis de ambiente. Configure `CRON_SECRET` com pelo menos 32 caracteres caso esteja ausente. Mantenha `TELEGRAM_NOTIFICATIONS_ENABLED=false` no primeiro deploy para a validação do painel.
5. Após revisão, promova o commit aprovado conforme a estratégia do projeto. A branch de implementação está com deploy automático desativado. Em **Telegram Monitor**, teste a conexão e envie a mensagem fictícia para o chat autorizado.
6. Configure `TELEGRAM_NOTIFICATIONS_ENABLED=true` na Vercel, publique a configuração aprovada e habilite as notificações no painel. Registre a autorização separadamente para cada lojista. Verifique o cron e o status do envio pelo painel. Para pausar, desative pelo painel. Ao mudar de chat, registre novamente a autorização para o novo destino.

## Arquivos

| Área | Arquivos |
| --- | --- |
| Migração | `database/migrations/008_telegram_monitor.sql` |
| Backend | `server/telegram.mjs`, `server/app.mjs`, `server/pagarme.mjs`, `server/payments.mjs`, `server/security.mjs` |
| Painel | `src/pages/TelegramMonitor.tsx`, `src/App.tsx` |
| Implantação | `vercel.json`, `.env.example` |
| Testes | `tests/telegram.test.mjs`, `tests/browser.mjs`, `tests/fixture.mjs`, `tests/migration.test.mjs`, `tests/vercel.test.mjs` |

O módulo usa as dependências existentes. O commit e a branch no GitHub permitem revisar a implementação antes de qualquer promoção.

## Resultados verificados em 28/11/2026

| Comando | Resultado |
| --- | --- |
| `npm test` | 45 testes aprovados, sem falhas ou testes ignorados. Inclui a migração 008 em PGlite, autenticação de webhooks, duplicação, pagamentos aprovados, recusados e pendentes, consentimento, isolamento, rotação de SK, credenciais inválidas, retentativas, falha de comunicação, controle administrativo, SMTP/XLSX e adaptação da rota da Vercel. |
| `npm run check` | Sintaxe JavaScript e TypeScript aprovados. |
| `npm run build` | Build de produção concluído, com 1.755 módulos processados pelo Vite. |
| `npm run test:browser` | Chromium aprovado. Inclui checkout, troca de lojista, XLSX, campos protegidos do Telegram Monitor e resoluções de 1448, 768, 390 e 320 px. |

Os testes usaram Pagar.me, 3DS, SMTP e Telegram simulados. Nenhuma cobrança real foi realizada. Permanecem pendentes a aprovação da publicação, a conferência da configuração do projeto Vercel, a migração no Neon da implantação e a validação com um bot/chat real autorizado.
