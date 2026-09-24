import { google } from 'googleapis';

const SHEETS_ID = process.env.GOOGLE_SHEETS_ID || '';

function getAuth() {
  return new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    undefined,
    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets.readonly']
  );
}

export interface ContactInfo {
  name: string;
  phone: string;
  processes: string[];
  rawRow: any[];
}

// Só os dígitos do número de processo: a planilha e o card podem escrever o
// mesmo processo com ou sem pontuação (0007404-96.2026.8.16.0058 x 00074049620268160058)
function soDigitos(s: string): string {
  return String(s || '').replace(/[^0-9]/g, '');
}

export interface Planilha {
  rows: any[][];
  colTelefone: number;
  colNome: number;
  colProcesso: number;
}

// Carrega a planilha uma vez e guarda por alguns minutos. Sem isso, um lote de
// 25 cards baixava a planilha inteira 25 vezes e a consulta estourava o tempo.
let cache: { em: number; dados: Planilha | null } = { em: 0, dados: null };
const CACHE_MS = 5 * 60 * 1000;

export async function carregarPlanilha(forcar = false): Promise<Planilha | null> {
  if (!forcar && cache.dados && Date.now() - cache.em < CACHE_MS) return cache.dados;
  try {
    const sheets = google.sheets({ version: 'v4', auth: getAuth() });
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEETS_ID, range: 'A:Z' });
    const rows = res.data.values || [];
    if (rows.length < 2) return null;

    const headers = rows[0].map((h: string) => h?.toLowerCase().trim());
    const dados: Planilha = {
      rows,
      colTelefone: headers.findIndex((h: string) =>
        h.includes('telefone') || h.includes('fone') || h.includes('celular') || h.includes('whatsapp')),
      colNome: headers.findIndex((h: string) => h.includes('nome') || h.includes('cliente')),
      colProcesso: headers.findIndex((h: string) =>
        h.includes('processo') || h.includes('número') || h.includes('numero')),
    };
    cache = { em: Date.now(), dados };
    return dados;
  } catch (err) {
    console.error('[sheets] erro ao carregar planilha:', err);
    return null;
  }
}

// Acha o cliente pelo NÚMERO DO PROCESSO, que é a chave do cadastro. Os avisos
// de audiência e prazo nascem de um card de processo, então partir do processo
// é mais confiável do que depender de o telefone estar escrito no card.
export function acharPorProcesso(planilha: Planilha | null, numeroProcesso: string): ContactInfo | null {
  const alvo = soDigitos(numeroProcesso);
  if (!planilha || planilha.colProcesso === -1 || alvo.length < 15) return null;

  for (const row of planilha.rows.slice(1)) {
    const celula = soDigitos(row[planilha.colProcesso]);
    if (!celula) continue;
    // A célula pode conter mais de um processo; compara por conter o alvo
    if (celula === alvo || celula.includes(alvo)) {
      const processRaw = String(row[planilha.colProcesso] || '');
      return {
        name: planilha.colNome >= 0 ? String(row[planilha.colNome] || '') : '',
        phone: planilha.colTelefone >= 0 ? soDigitos(row[planilha.colTelefone]) : '',
        processes: processRaw.split(/[,;\n]+/).map(p => p.trim()).filter(Boolean),
        rawRow: row,
      };
    }
  }
  return null;
}

export async function lookupSheetsPorProcesso(numeroProcesso: string): Promise<ContactInfo | null> {
  return acharPorProcesso(await carregarPlanilha(), numeroProcesso);
}

export async function lookupSheets(phone: string): Promise<ContactInfo | null> {
  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEETS_ID,
      range: 'A:Z',
    });

    const rows = res.data.values || [];
    if (rows.length < 2) return null;

    const headers = rows[0].map((h: string) => h?.toLowerCase().trim());
    const phoneColIndex = headers.findIndex((h: string) =>
      h.includes('telefone') || h.includes('fone') || h.includes('celular') || h.includes('whatsapp')
    );
    const nameColIndex = headers.findIndex((h: string) =>
      h.includes('nome') || h.includes('cliente')
    );
    const processColIndex = headers.findIndex((h: string) =>
      h.includes('processo') || h.includes('número') || h.includes('numero')
    );

    if (phoneColIndex === -1) return null;

    // Normaliza o número de busca para comparação
    const normalizedSearch = phone.replace(/[^0-9]/g, '');

    for (const row of rows.slice(1)) {
      const cellPhone = String(row[phoneColIndex] || '').replace(/[^0-9]/g, '');
      if (!cellPhone) continue;

      // Compara sufixo de 10 dígitos (DDD + número) para tolerar formatação diferente
      // (com/sem 55, com/sem o 9 extra) sem colidir entre DDDs diferentes — 8 dígitos
      // (sem DDD) já causou casos reais de atribuir cliente errado por coincidência
      if (
        cellPhone === normalizedSearch ||
        cellPhone.endsWith(normalizedSearch.slice(-10)) ||
        normalizedSearch.endsWith(cellPhone.slice(-10))
      ) {
        const name = nameColIndex >= 0 ? String(row[nameColIndex] || '') : 'Desconhecido';
        const processRaw = processColIndex >= 0 ? String(row[processColIndex] || '') : '';
        const processes = processRaw ? processRaw.split(/[,;\n]+/).map(p => p.trim()).filter(Boolean) : [];

        return { name, phone: cellPhone, processes, rawRow: row };
      }
    }

    return null;
  } catch (err) {
    console.error('[sheets] erro no lookup:', err);
    return null;
  }
}
