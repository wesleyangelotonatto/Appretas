import axios from 'axios';
import { getDb } from '../memory/db';

const PJE_API = 'https://comunicaapi.pje.jus.br/api/v1/comunicacao';
const OAB_UF = () => process.env.OAB_UF || 'PR';
const OAB_NUMERO = () => process.env.OAB_NUMERO || '57417';
const CACHE_DIAS = () => parseInt(process.env.DJEN_CACHE_DIAS || '7');

export interface DjenResult {
  processoNumero: string;
  ultimoAndamento: string;
  dataAndamento: string;
  tribunal: string;
  fromCache: boolean;
}

export async function consultarDjen(processoNumero: string): Promise<DjenResult | null> {
  try {
    // Verifica cache no SQLite
    const db = getDb();
    const cached = db.prepare('SELECT * FROM djen_cache WHERE processo = ? AND updated_at > ?')
      .get(processoNumero, Math.floor(Date.now() / 1000) - CACHE_DIAS() * 86400) as any;

    if (cached) {
      return {
        processoNumero,
        ultimoAndamento: cached.andamento,
        dataAndamento: cached.data_andamento,
        tribunal: cached.tribunal,
        fromCache: true,
      };
    }

    // Consulta PJe Comunica API (sem autenticação)
    const res = await axios.get(PJE_API, {
      params: {
        numeroOab: `${OAB_UF()}${OAB_NUMERO()}`,
        numeroProcesso: processoNumero,
      },
      timeout: 15000,
    });

    const data = res.data;
    if (!data || !Array.isArray(data.items) || data.items.length === 0) return null;

    // Pega o andamento mais recente
    const items = data.items.sort((a: any, b: any) =>
      new Date(b.dataDisponibilizacao || b.data || 0).getTime() -
      new Date(a.dataDisponibilizacao || a.data || 0).getTime()
    );
    const latest = items[0];

    const result: DjenResult = {
      processoNumero,
      ultimoAndamento: latest.tipoComunicacao || latest.assunto || 'Movimentação registrada',
      dataAndamento: latest.dataDisponibilizacao || latest.data || new Date().toISOString(),
      tribunal: latest.siglaTribunal || latest.tribunal || 'Tribunal',
      fromCache: false,
    };

    // Salva no cache
    db.prepare(
      'INSERT OR REPLACE INTO djen_cache (processo, andamento, data_andamento, tribunal, updated_at) VALUES (?, ?, ?, ?, unixepoch())'
    ).run(processoNumero, result.ultimoAndamento, result.dataAndamento, result.tribunal);

    return result;
  } catch (err) {
    console.error('[djen] erro ao consultar:', err);
    return null;
  }
}

export function initDjenCache() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS djen_cache (
      processo TEXT PRIMARY KEY,
      andamento TEXT,
      data_andamento TEXT,
      tribunal TEXT,
      updated_at INTEGER
    );
  `);
}
