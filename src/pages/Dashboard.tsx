import { useEffect, useState } from 'react';
import { api, merchantPath, brl, explain, type Environment } from '../services/api';
import { Loader } from '../components/UI';

interface Metrics {
  total: number; sales: number; approved: string; declined: number; pending: number; canceled: number;
}

export function Dashboard({ env, merchant }: { env: Environment; merchant: string }) {
  const [metrics, setMetrics] = useState<Metrics>();
  const [error, setError] = useState('');
  useEffect(() => {
    setMetrics(undefined);
    setError('');
    api<Metrics>(merchantPath('/admin/summary/' + env, merchant)).then(setMetrics).catch(failure => setError(explain(failure)));
  }, [env, merchant]);
  if (error) return <p className="notice error" role="alert">{error}</p>;
  if (!metrics) return <p><Loader /> Carregando indicadores</p>;
  return <div className="dashboard">
    {[['Vendas aprovadas', metrics.sales], ['Valor aprovado', brl(Number(metrics.approved))], ['Pedidos', metrics.total],
      ['Recusados', metrics.declined], ['Pendentes', metrics.pending], ['Cancelados ou estornados', metrics.canceled]]
      .map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
  </div>;
}
