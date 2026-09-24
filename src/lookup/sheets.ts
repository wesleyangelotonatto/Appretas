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
  linhaCabecalho: number;
  colTelefone: number;
  colNome: number;          // "NOME PARA MENSAGEM" — como o cliente deve ser chamado
  colNomeCompleto: number;  // "NOME DO CLIENTE" — nome completo, para registro
  colProcesso: number;
  colAndamentos: number;
}

// A planilha começa com um banner mesclado ("SVZP ADVOGADOS — BASE DE PROCESSOS
// ATIVOS") e um subtítulo; o cabeçalho real é a 5ª linha. Assumir a primeira
// linha como cabeçalho fazia toda coluna ser dada como inexistente, e a busca
// devolvia vazio SEMPRE — por telefone e por processo. Aqui o cabeçalho é
// procurado: é a linha que tem, ao mesmo tempo, coluna de processo e de contato.
function acharLinhaCabecalho(rows: any[][]): number {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const linha = (rows[i] || []).map((c: any) => String(c || '').toLowerCase());
    const temProcesso = linha.some(c => c.includes('processo'));
    const temContato = linha.some(c =>
      c.includes('whatsapp') || c.includes('telefone') || c.includes('celular') || c.includes('fone'));
    if (temProcesso && temContato) return i;
  }
  return 0;
}

function acharColuna(headers: string[], ...termos: string[]): number {
  for (const termo of termos) {
    const i = headers.findIndex(h => h.includes(termo));
    if (i >= 0) return i;
  }
  return -1;
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

    const linhaCabecalho = acharLinhaCabecalho(rows);
    const headers = (rows[linhaCabecalho] || []).map((h: any) => String(h || '').toLowerCase().trim());

    const dados: Planilha = {
      rows,
      linhaCabecalho,
      colTelefone: acharColuna(headers, 'whatsapp', 'telefone', 'celular', 'fone'),
      // "NOME PARA MENSAGEM" é como o cliente deve ser tratado (ex.: "Dani"),
      // diferente do nome completo do cadastro — é esse que vai na mensagem
      colNome: acharColuna(headers, 'nome para mensagem', 'nome do cliente', 'nome', 'cliente'),
      colNomeCompleto: acharColuna(headers, 'nome do cliente', 'nome'),
      colProcesso: acharColuna(headers, 'processo'),
      colAndamentos: acharColuna(headers, 'andamentos'),
    };
    console.log(`[sheets] cabeçalho na linha ${linhaCabecalho + 1} | processo=${dados.colProcesso} nome=${dados.colNome} whatsapp=${dados.colTelefone}`);
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

  for (const row of planilha.rows.slice(planilha.linhaCabecalho + 1)) {
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
  const planilha = await carregarPlanilha();
  if (!planilha || planilha.colTelefone === -1) return null;

  const alvo = soDigitos(phone);
  for (const row of planilha.rows.slice(planilha.linhaCabecalho + 1)) {
    const celular = soDigitos(row[planilha.colTelefone]);
    if (!celular) continue;

    // Compara sufixo de 10 dígitos (DDD + número) para tolerar formatação diferente
    // (com/sem 55, com/sem o 9 extra) sem colidir entre DDDs diferentes — 8 dígitos
    // (sem DDD) já causou casos reais de atribuir cliente errado por coincidência
    if (celular === alvo || celular.endsWith(alvo.slice(-10)) || alvo.endsWith(celular.slice(-10))) {
      const processRaw = planilha.colProcesso >= 0 ? String(row[planilha.colProcesso] || '') : '';
      return {
        name: planilha.colNome >= 0 ? String(row[planilha.colNome] || '') : '',
        phone: celular,
        processes: processRaw.split(/[,;\n]+/).map(p => p.trim()).filter(Boolean),
        rawRow: row,
      };
    }
  }
  return null;
}
