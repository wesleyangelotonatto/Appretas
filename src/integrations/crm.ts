// Leitura da ficha e da configuração do CRM (fonte única de etapas, números e
// motivos de perda). Usa a chave CRM_API_KEY. Configuração em cache por 1 h;
// ficha sempre lida na hora. Falha no CRM devolve null: a Iara segue sem ela.
const TTL_CONFIG = 60 * 60 * 1000;
let cacheConfig: { em: number; dados: unknown } | null = null;

async function getCRM<T>(caminho: string): Promise<T | null> {
  const url = process.env.CRM_URL, chave = process.env.CRM_API_KEY;
  if (!url || !chave) return null;
  try {
    const r = await fetch(url.replace(/\/$/, '') + caminho, { headers: { 'x-api-key': chave }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) { console.error(`[crm] ${caminho}: HTTP ${r.status}`); return null; }
    return (await r.json()) as T;
  } catch (err) {
    console.error(`[crm] ${caminho}:`, (err as Error).message);
    return null;
  }
}

export interface FichaCRM {
  tel: string; nome: string;
  etapa: { codigo: string; nome: string; dias: number | null; atrasado: boolean } | null;
  proximo: { passo: string | null; responsavel: string | null; prazo: string | null };
  origem: string | null; produto: string | null; etiquetas: string[];
  resultado: { resultado: string; motivo: string | null } | null;
  ligacoesENotas: Array<{ em: number; tipo: string; titulo: string; detalhe: string | null; autor: string | null }>;
  sugestoesPendentes: string[];
}

export function fichaDoCRM(phone: string): Promise<FichaCRM | null> {
  return getCRM<FichaCRM>('/api/integracao/ficha/' + encodeURIComponent(phone.replace(/\D/g, '')));
}

export async function configDoCRM(): Promise<Record<string, unknown> | null> {
  if (cacheConfig && Date.now() - cacheConfig.em < TTL_CONFIG) return cacheConfig.dados as Record<string, unknown>;
  const d = await getCRM<Record<string, unknown>>('/api/integracao/config');
  if (d) cacheConfig = { em: Date.now(), dados: d };
  return d ?? (cacheConfig?.dados as Record<string, unknown> | undefined) ?? null;
}

// Pede ao CRM para mover a etapa; nas etapas de decisão (02, 07, 11) o CRM
// transforma o pedido em sugestão para o Wesley aprovar.
export async function sugerirEtapa(phone: string, para: string, dados: Record<string, unknown> = {}) {
  const url = process.env.CRM_URL, chave = process.env.CRM_API_KEY;
  if (!url || !chave) return null;
  try {
    const r = await fetch(url.replace(/\/$/, '') + '/api/ficha/' + encodeURIComponent(phone.replace(/\D/g, '')) + '/etapa', {
      method: 'POST', headers: { 'x-api-key': chave, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...dados, para }), signal: AbortSignal.timeout(20000),
    });
    return await r.json();
  } catch (err) { console.error('[crm] sugerirEtapa:', (err as Error).message); return null; }
}
