import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import Database from 'better-sqlite3';
import { getDb } from '../memory/db';

// Backup diário do banco da Iara (SQLite):
// 1. cópia consistente com a API de backup do SQLite (segura com o banco em uso);
// 2. teste de restauração: abre a cópia, roda integrity_check e confere as tabelas;
// 3. compacta, guarda os últimos 7 no volume e envia ao Drive (pasta "_Backups Iara").
// Qualquer falha vira alerta no painel e no log — backup que não restaura não conta.

const DB_PATH = process.env.DATABASE_URL || './data/iara.db';
const DIR_BACKUP = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
const MANTER_LOCAL = 7;

export interface ResultadoBackup { ok: boolean; arquivo?: string; tamanho?: number; tabelas?: number; mensagens?: number; erro?: string; drive?: boolean }

function alertar(mensagem: string) {
  import('../server').then(({ io }) => io?.emit('alerta', { tipo: 'backup', mensagem })).catch(() => {});
}

export async function executarBackup(enviarParaDrive = true): Promise<ResultadoBackup> {
  const dataStr = new Date().toLocaleDateString('sv-SE', { timeZone: process.env.TZ_APP || 'America/Sao_Paulo' });
  fs.mkdirSync(DIR_BACKUP, { recursive: true });
  const copia = path.join(DIR_BACKUP, `iara-${dataStr}.db`);
  const gz = `${copia}.gz`;
  try {
    await getDb().backup(copia);

    // Teste de restauração
    const teste = new Database(copia, { readonly: true });
    const integridade = (teste.pragma('integrity_check', { simple: true }) as string);
    const tabelas = (teste.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get() as any).n as number;
    const mensagens = (teste.prepare('SELECT COUNT(*) AS n FROM messages').get() as any).n as number;
    teste.close();
    if (integridade !== 'ok' || tabelas < 5) throw new Error(`teste de restauração falhou (integridade: ${integridade}, tabelas: ${tabelas})`);

    fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(copia)));
    fs.unlinkSync(copia);
    const tamanho = fs.statSync(gz).size;

    // Mantém só os últimos backups locais
    const locais = fs.readdirSync(DIR_BACKUP).filter(f => /^iara-.*\.db\.gz$/.test(f)).sort().reverse();
    for (const f of locais.slice(MANTER_LOCAL)) fs.unlinkSync(path.join(DIR_BACKUP, f));

    let drive = false;
    if (enviarParaDrive && process.env.DRIVE_FOLDER_ID && process.env.GOOGLE_OAUTH_REFRESH_TOKEN) {
      try {
        const { enviarBackupDrive } = await import('../integrations/drive');
        await enviarBackupDrive(path.basename(gz), gz);
        drive = true;
      } catch (err) {
        console.error('[backup] cópia local ok, mas falhou o envio ao Drive:', err);
        alertar('Backup da Iara feito no servidor, mas não foi enviado ao Drive.');
      }
    }
    console.log(`[backup] ok — ${path.basename(gz)} (${Math.round(tamanho / 1024)} KB, ${tabelas} tabelas, ${mensagens} mensagens, Drive: ${drive ? 'sim' : 'não'})`);
    return { ok: true, arquivo: path.basename(gz), tamanho, tabelas, mensagens, drive };
  } catch (err: any) {
    try { if (fs.existsSync(copia)) fs.unlinkSync(copia); } catch { /* ignora */ }
    console.error('[backup] FALHOU:', err);
    alertar(`Backup da Iara falhou: ${err?.message || err}`);
    return { ok: false, erro: String(err?.message || err) };
  }
}
