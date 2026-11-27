// Busca da Iara (FTS5, ignora acentos): mensagens, lições (correções do Wesley)
// e resumos diários. Índices criados uma vez, com carga inicial e gatilhos.
import { getDb } from './db';

const INDICES: Array<{ fts: string; tabela: string; colunas: string[] }> = [
  { fts: 'messages_fts', tabela: 'messages', colunas: ['body'] },
  { fts: 'corrections_fts', tabela: 'corrections', colunas: ['original', 'corrected', 'context'] },
  { fts: 'resumos_fts', tabela: 'resumos_diarios', colunas: ['resumo'] },
];

export function criarIndicesBusca(): void {
  const db = getDb();
  for (const { fts, tabela, colunas } of INDICES) {
    const existe = db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(fts);
    if (existe) continue;
    const cols = colunas.join(', ');
    const novos = colunas.map(c => 'new.' + c).join(', ');
    const velhos = colunas.map(c => 'old.' + c).join(', ');
    db.transaction(() => {
      db.exec(`
        CREATE VIRTUAL TABLE ${fts} USING fts5(${cols}, content='${tabela}', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
        CREATE TRIGGER ${fts}_ins AFTER INSERT ON ${tabela} BEGIN INSERT INTO ${fts}(rowid, ${cols}) VALUES (new.id, ${novos}); END;
        CREATE TRIGGER ${fts}_del AFTER DELETE ON ${tabela} BEGIN INSERT INTO ${fts}(${fts}, rowid, ${cols}) VALUES ('delete', old.id, ${velhos}); END;
        CREATE TRIGGER ${fts}_upd AFTER UPDATE ON ${tabela} BEGIN
          INSERT INTO ${fts}(${fts}, rowid, ${cols}) VALUES ('delete', old.id, ${velhos});
          INSERT INTO ${fts}(rowid, ${cols}) VALUES (new.id, ${novos});
        END;
        INSERT INTO ${fts}(${fts}) VALUES ('rebuild');`);
    })();
    console.log(`[busca] índice ${fts} criado`);
  }
}

// Palavras viram prefixos; trechos entre aspas, frase exata; nada vira operador
export function consultaFts(termo: string): string {
  const partes: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(termo || '')) !== null) {
    if (m[1]) { const f = m[1].replace(/["*]/g, ' ').trim(); if (f) partes.push(`"${f}"`); }
    else { const p = m[2].replace(/[^\p{L}\p{N}]/gu, ''); if (p.length >= 2) partes.push(`"${p}"*`); }
  }
  return partes.join(' AND ');
}

export interface FiltrosBusca { phone?: string; desde?: number; ate?: number; limite?: number }

export function buscarConversas(termo: string, f: FiltrosBusca = {}) {
  const q = consultaFts(termo);
  if (!q) return { mensagens: [], licoes: [], resumos: [] };
  const db = getDb();
  const lim = Math.max(1, Math.min(200, f.limite || 30));
  const fone = f.phone ? f.phone.replace(/\D/g, '') : null;
  const cond = (alias: string, col: string) => [
    fone ? `${alias}.phone LIKE '%' || @fone || '%'` : '',
    f.desde ? `${alias}.${col} >= @desde` : '', f.ate ? `${alias}.${col} <= @ate` : '',
  ].filter(Boolean).map(c => ' AND ' + c).join('');
  const par = { q, lim, fone, desde: f.desde ? Math.floor(f.desde / 1000) : null, ate: f.ate ? Math.floor(f.ate / 1000) : null };
  return {
    mensagens: db.prepare(`SELECT m.id, m.phone, m.role, m.created_at, snippet(messages_fts, 0, '[', ']', '…', 16) trecho
      FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid WHERE messages_fts MATCH @q${cond('m', 'created_at')}
      ORDER BY m.created_at DESC LIMIT @lim`).all(par),
    licoes: db.prepare(`SELECT c.id, c.phone, c.created_at, c.corrected, snippet(corrections_fts, -1, '[', ']', '…', 16) trecho
      FROM corrections_fts JOIN corrections c ON c.id = corrections_fts.rowid WHERE corrections_fts MATCH @q${cond('c', 'created_at')}
      ORDER BY c.created_at DESC LIMIT @lim`).all(par),
    resumos: db.prepare(`SELECT r.id, r.phone, r.name, r.data_str, snippet(resumos_fts, 0, '[', ']', '…', 16) trecho
      FROM resumos_fts JOIN resumos_diarios r ON r.id = resumos_fts.rowid WHERE resumos_fts MATCH @q${cond('r', 'created_at')}
      ORDER BY r.created_at DESC LIMIT @lim`).all(par),
  };
}
