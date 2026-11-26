# Testes do CS TRP 013

`npm run check`, `npm run build`, `npm test` e `npm run test:browser` verificam o checkout direto com PGlite, Chromium e respostas simuladas da Pagar.me e do SDK Stone.

A suíte cobre crédito parcelado, débito à vista, 3DS obrigatório, autenticação cancelada, aprovação, recusa, gateway desativado, débito sem confirmação comercial, reenvios concorrentes, conciliação após timeout, webhooks e histórico de pedidos anteriores. No navegador, confira também a ausência de dados de cartão no tráfego para o aplicativo e o parcelamento oculto no débito.

## Homologação oficial pendente

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
