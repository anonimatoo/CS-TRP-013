import { isIP } from 'node:net';
import { gatewayRow, gatewaySecret } from './gateway.mjs';
import { ProviderError } from './pagarme.mjs';

const addresses = [
  ['ipv4', 'https://api.ipify.org'],
  ['ipv6', 'https://api6.ipify.org']
];

export async function inspectConnectivity({ db, config, pagarme, ipFetch, merchant, env }) {
  const row = await gatewayRow(db, merchant, env);
  const network = Promise.all(addresses.map(async ([family, url]) => {
    try {
      const response = await ipFetch(url, { redirect: 'error', signal: AbortSignal.timeout(3000) });
      if (!response.ok) return [family, null];
      const ip = (await response.text()).trim();
      return [family, isIP(ip) === (family === 'ipv4' ? 4 : 6) ? ip : null];
    } catch { return [family, null]; }
  }));
  let key;
  let credential = 'missing';
  if (row.secret) {
    try { key = gatewaySecret(config, row); credential = 'configured'; }
    catch { credential = 'unreadable'; }
  }
  const routes = { orders: '/orders?size=1', charges: '/charges?size=1', hooks: '/hooks?size=1', links: '/paymentlinks?per_page=1' };
  const checks = key ? await Promise.all(Object.entries(routes).map(async ([name, path]) => {
    try {
      const { http } = await pagarme(key, path);
      return [name, { http, category: null }];
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      return [name, { http: error.http, category: error.category }];
    }
  })) : [];
  return { credential, configuredStaticIPs: config.staticEgressIPs ?? [], observed: Object.fromEntries(await network),
    checks: Object.fromEntries(checks) };
}
