export const digits = (value) => String(value ?? '').replace(/\D/g, '');
export const states = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');

export function validCpf(value) {
  const cpf = digits(value);
  if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;
  return [9, 10].every(length => {
    let sum = 0;
    for (let index = 0; index < length; index++) sum += Number(cpf[index]) * (length + 1 - index);
    return ((sum * 10) % 11) % 10 === Number(cpf[length]);
  });
}

export function parseBrl(value) {
  const normalized = String(value ?? '').trim().replace(/^R\$\s*/, '');
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.replaceAll('.', '').split(',');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(amount) ? amount : null;
}

export function pagarmeKeyEnvironment(value) {
  const key = String(value ?? '').trim();
  const prefix = 'sk_';
  if (!key.startsWith(prefix)) return null;
  if (!/^(?:test_)?[A-Za-z0-9_-]{8,128}$/.test(key.slice(prefix.length))) return null;
  return key.startsWith(prefix + 'test_') ? 'test' : 'live';
}
