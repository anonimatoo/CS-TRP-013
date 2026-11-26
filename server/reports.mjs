import ExcelJS from 'exceljs';

export const methodName = method => ({ credit_card: 'Cartão de crédito', debit_card: 'Cartão de débito' })[method] ?? '—';
export const money = cents => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
const dateTime = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'medium' });

export function financialRow(row, merchantName) {
  return {
    merchant: merchantName, merchantId: row.merchant_id, account: row.account, order: row.id,
    transaction: row.provider_transaction, confirmedAt: row.confirmed_at, product: row.product_name,
    gross: row.amount, method: row.payment_method, brand: row.card_brand,
    installments: row.installments, fee: row.fee_amount, net: row.net_amount,
    status: row.status, environment: row.environment
  };
}

const statusNames = { paid: 'Pago', captured: 'Pagamento capturado', declined: 'Recusado',
  pending: 'Pendente', authorized: 'Autorizado', refunded: 'Estornado', canceled: 'Cancelado',
  processing: 'Em processamento', review: 'Em análise', communication_error: 'Aguardando conciliação',
  request_failed: 'Solicitação rejeitada', authentication_incomplete: 'Autenticação incompleta',
  expired: 'Expirado', chargedback: 'Contestado' };

const brlFormat = '"R$" #,##0.00;-"R$" #,##0.00';

export async function workbook(rows, now = new Date()) {
  const book = new ExcelJS.Workbook();
  book.creator = 'CS TRP 013';
  book.created = now;
  const sheet = book.addWorksheet('Relatório financeiro', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = [
    ['Lojista', 28], ['UUID do lojista', 39], ['Conta Pagar.me', 23], ['Pedido', 39], ['Transação', 28],
    ['Confirmação (Brasília)', 24], ['Produto', 30], ['Valor bruto', 16], ['Modalidade', 22], ['Bandeira', 16],
    ['Parcelas', 11], ['Taxas', 16], ['Valor líquido', 16], ['Status financeiro', 23], ['Ambiente', 15],
    ['Relatório gerado (Brasília)', 28]
  ].map(([header, width]) => ({ header, width }));
  for (const row of rows) {
    // ExcelJS serializes strings as text. Untrusted values never become formula objects.
    sheet.addRow([row.merchant, row.merchantId, row.account, row.order, row.transaction,
      row.confirmedAt ? dateTime.format(new Date(row.confirmedAt)) : null, row.product, row.gross / 100,
      methodName(row.method), row.brand, row.installments, row.fee == null ? null : row.fee / 100,
      row.net == null ? null : row.net / 100, row.status === 'paid' && row.confirmedAt ? 'Pagamento capturado' : statusNames[row.status] ?? row.status,
      row.environment === 'live' ? 'Produção' : 'Sandbox', dateTime.format(now)]);
  }
  for (const col of [8, 12, 13]) sheet.getColumn(col).numFmt = brlFormat;
  const header = sheet.getRow(1);
  header.height = 26;
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF163255' } };
  sheet.autoFilter = 'A1:P' + Math.max(1, rows.length + 1);
  const totals = sheet.addRow(['Totais informados']);
  totals.font = { bold: true };
  for (const [column, field] of [[8,'gross'],[12,'fee'],[13,'net']]) {
    const values = rows.map(row => row[field]).filter(value => value != null);
    if (values.length) totals.getCell(column).value = values.reduce((sum, value) => sum + value, 0) / 100;
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

export function captureMessage(row, recipient, messageId, attachment, now = new Date()) {
  const value = money(row.gross);
  const stamp = dateTime.format(new Date(row.confirmedAt));
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(now);
  return {
    to: recipient, messageId,
    subject: 'CS TRP 013 — Pagamento confirmado — ' + value,
    text: [
      'Pagamento confirmado com sucesso.', '', 'Lojista: ' + row.merchant, 'Pedido: ' + row.order,
      'Valor: ' + value, 'Modalidade: ' + methodName(row.method), 'Parcelas: ' + row.installments,
      'Status: Pagamento capturado', 'Data e horário: ' + stamp, '',
      'O relatório financeiro da operação encontra-se no arquivo Excel anexado.', '',
      'CS TRP 013 — Central de Relatórios Financeiros.'
    ].join('\n'),
    attachments: [{ filename: 'CS-TRP-013_PAGAMENTO_' + day + '_' + row.transaction + '.xlsx', content: attachment }]
  };
}
