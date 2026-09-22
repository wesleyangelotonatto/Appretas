import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DATABASE_URL || './data/iara.db';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) throw new Error('Banco não inicializado');
  return _db;
}

export async function initDb(): Promise<void> {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      phone TEXT PRIMARY KEY,
      name TEXT,
      type TEXT,
      status TEXT DEFAULT 'ativo',
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      role TEXT NOT NULL,
      body TEXT NOT NULL,
      media_url TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS pending_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      draft TEXT NOT NULL,
      context TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS follow_ups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      message TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL,
      sent INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS follow_ups_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      message TEXT NOT NULL,
      next_send_at INTEGER NOT NULL,
      recurrence_days INTEGER DEFAULT 0,
      stop_condition TEXT DEFAULT 'manual',
      stop_date INTEGER,
      status TEXT DEFAULT 'ativo',
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS blacklist (
      phone TEXT PRIMARY KEY,
      reason TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS contact_instructions (
      phone TEXT PRIMARY KEY,
      instruction TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS group_permissions (
      group_id TEXT PRIMARY KEY,
      group_name TEXT,
      active INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      original TEXT NOT NULL,
      corrected TEXT NOT NULL,
      context TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    -- Controle do aviso de ausência: sent_date (YYYY-MM-DD) impede reenvio no mesmo dia;
    -- pending=1 marca contato que mandou mensagem fora da janela 07h-22h, aguardando a próxima abertura
    CREATE TABLE IF NOT EXISTS ausencia_notices (
      phone TEXT PRIMARY KEY,
      sent_date TEXT,
      pending INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_follow_ups_scheduled ON follow_ups(scheduled_at, sent);
    CREATE INDEX IF NOT EXISTS idx_fup2_next ON follow_ups_v2(next_send_at, status);
  `);

  limparNomesContaminados();
  console.log('[db] banco inicializado:', DB_PATH);
}

// Corrige sessões salvas antes da correção do lookup do Trello, que armazenaram
// o título do card (ex: "REQUERIMENTO... ESPÓLIO DE...") como nome do contato.
// Reseta para o telefone; o nome correto do WhatsApp será aplicado na próxima mensagem.
function limparNomesContaminados() {
  const TITULO_CASO_RE = /processo|requerimento|apresenta[cç][aã]o|esp[oó]lio|execu[cç][aã]o|embargos|a[cç][aã]o\b|mandado|recurso|apela[cç][aã]o|invent[aá]rio|cumprimento de senten[cç]a|habilita[cç][aã]o| - | x /i;
  const sessions = getDb().prepare('SELECT phone, name FROM sessions').all() as Array<{ phone: string; name: string | null }>;
  let corrigidos = 0;
  for (const s of sessions) {
    if (s.name && (TITULO_CASO_RE.test(s.name) || /\d{4,}/.test(s.name) || s.name.length > 60)) {
      getDb().prepare('UPDATE sessions SET name = ? WHERE phone = ?').run(s.phone, s.phone);
      corrigidos++;
    }
  }
  if (corrigidos > 0) console.log(`[db] ${corrigidos} nome(s) de contato contaminado(s) por título de caso foram corrigidos`);
}

export function getSession(phone: string) {
  return getDb().prepare('SELECT * FROM sessions WHERE phone = ?').get(phone) as any;
}

// Colunas que upsertSession pode escrever — protege contra injeção via nomes de coluna
// caso algum chamador futuro derive as chaves de dados externos (payload de webhook, etc.)
const SESSION_COLUNAS_PERMITIDAS = new Set(['name', 'type', 'status']);

export function upsertSession(phone: string, data: Record<string, any>) {
  const chaves = Object.keys(data);
  const chavesInvalidas = chaves.filter(k => !SESSION_COLUNAS_PERMITIDAS.has(k));
  if (chavesInvalidas.length > 0) {
    throw new Error(`upsertSession: coluna(s) não permitida(s): ${chavesInvalidas.join(', ')}`);
  }

  const existing = getSession(phone);
  if (existing) {
    const sets = chaves.map(k => `${k} = ?`).join(', ');
    getDb().prepare(`UPDATE sessions SET ${sets}, updated_at = unixepoch() WHERE phone = ?`)
      .run(...Object.values(data), phone);
  } else {
    getDb().prepare(
      `INSERT INTO sessions (phone, ${chaves.join(', ')}) VALUES (?, ${chaves.map(() => '?').join(', ')})`
    ).run(phone, ...Object.values(data));
  }
}

export function saveMessage(phone: string, role: 'client' | 'iara' | 'wesley', body: string, mediaUrl?: string) {
  getDb().prepare('INSERT INTO messages (phone, role, body, media_url) VALUES (?, ?, ?, ?)')
    .run(phone, role, body, mediaUrl || null);
}

export function getHistory(phone: string, days = 90) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  return getDb().prepare('SELECT * FROM messages WHERE phone = ? AND created_at > ? ORDER BY created_at').all(phone, since) as any[];
}

// Lista sessões ativas dos últimos N dias, com o histórico de mensagens de cada uma,
// para reconstruir o painel após um refresh (F5) sem perder conversas em andamento
export function getActiveConversations(days = 7) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const sessions = getDb().prepare('SELECT * FROM sessions WHERE updated_at > ? ORDER BY updated_at DESC').all(since) as any[];
  return sessions.map(s => ({
    ...s,
    messages: getDb().prepare('SELECT role, body, media_url as mediaUrl, created_at as timestamp FROM messages WHERE phone = ? AND created_at > ? ORDER BY created_at')
      .all(s.phone, since) as any[],
  }));
}

export function savePendingApproval(phone: string, draft: string, context: string) {
  return (getDb().prepare('INSERT INTO pending_approvals (phone, draft, context) VALUES (?, ?, ?)')
    .run(phone, draft, context)).lastInsertRowid;
}

export function getPendingApprovals() {
  return getDb().prepare('SELECT * FROM pending_approvals ORDER BY created_at').all() as any[];
}

export function deletePendingApproval(id: number) {
  getDb().prepare('DELETE FROM pending_approvals WHERE id = ?').run(id);
}

export function saveCorrection(phone: string, original: string, corrected: string, context?: string) {
  getDb().prepare('INSERT INTO corrections (phone, original, corrected, context) VALUES (?, ?, ?, ?)')
    .run(phone, original, corrected, context || null);
}

export function getRecentCorrections(limit = 20): Array<{ original: string; corrected: string }> {
  return getDb().prepare('SELECT original, corrected FROM corrections ORDER BY created_at DESC LIMIT ?')
    .all(limit) as any[];
}

export function getAusenciaNotice(phone: string): { phone: string; sent_date: string | null; pending: number } | undefined {
  return getDb().prepare('SELECT * FROM ausencia_notices WHERE phone = ?').get(phone) as any;
}

// Wesley respondeu alguém há pouco? Se ele está atendendo agora, dizer ao cliente
// que ele só retorna em horário comercial contradiz o que o cliente está vendo.
// Sem telefone: qualquer contato (ele assumiu o atendimento). Com telefone:
// apenas aquela conversa. Só conta fala digitada por ele — o eco das mensagens
// da própria Iara é descartado na entrada do webhook.
export function houveRespostaDeWesley(minutos: number, phone?: string): boolean {
  const limite = Math.floor(Date.now() / 1000) - minutos * 60;
  const row = phone
    ? getDb().prepare(`SELECT 1 FROM messages WHERE role = 'wesley' AND created_at > ? AND phone = ? LIMIT 1`).get(limite, phone)
    : getDb().prepare(`SELECT 1 FROM messages WHERE role = 'wesley' AND created_at > ? LIMIT 1`).get(limite);
  return !!row;
}

// Reivindica o aviso de ausência do dia de forma ATÔMICA: retorna true só para a
// primeira chamada do dia para esse telefone. Duas mensagens do mesmo contato
// chegando juntas (ex.: duas fotos no mesmo segundo) passavam as duas pela
// verificação getAusenciaNotice() antes de qualquer uma gravar — o cliente recebia
// o aviso duplicado. Aqui a checagem e a gravação acontecem numa única instrução.
export function reivindicarAusencia(phone: string, dataHoje: string): boolean {
  const r = getDb().prepare(`
    INSERT INTO ausencia_notices (phone, sent_date, pending) VALUES (?, ?, 0)
    ON CONFLICT(phone) DO UPDATE SET sent_date = excluded.sent_date, pending = 0
      WHERE ausencia_notices.sent_date IS NOT excluded.sent_date
  `).run(phone, dataHoje);
  return r.changes > 0;
}

// Devolve a reivindicação quando o envio falha, para que uma próxima mensagem
// do contato possa tentar de novo em vez de ficar o dia todo sem aviso
export function liberarAusencia(phone: string) {
  getDb().prepare('UPDATE ausencia_notices SET sent_date = NULL WHERE phone = ?').run(phone);
}

export function marcarAusenciaEnviada(phone: string, dataHoje: string) {
  getDb().prepare(`
    INSERT INTO ausencia_notices (phone, sent_date, pending) VALUES (?, ?, 0)
    ON CONFLICT(phone) DO UPDATE SET sent_date = excluded.sent_date, pending = 0
  `).run(phone, dataHoje);
}

export function marcarAusenciaPendente(phone: string) {
  getDb().prepare(`
    INSERT INTO ausencia_notices (phone, sent_date, pending) VALUES (?, NULL, 1)
    ON CONFLICT(phone) DO UPDATE SET pending = 1
  `).run(phone);
}

export function getAusenciasPendentes(): string[] {
  return (getDb().prepare('SELECT phone FROM ausencia_notices WHERE pending = 1').all() as any[])
    .map(r => r.phone);
}

// ─── Grupos do WhatsApp: quais têm atendimento por IA ativado ───────────────────

export function upsertGroupSeen(groupId: string, groupName: string) {
  getDb().prepare(`
    INSERT INTO group_permissions (group_id, group_name, active) VALUES (?, ?, 0)
    ON CONFLICT(group_id) DO UPDATE SET group_name = excluded.group_name
  `).run(groupId, groupName || groupId);
}

export function getGroups(): Array<{ group_id: string; group_name: string; active: number; created_at: number }> {
  return getDb().prepare('SELECT * FROM group_permissions ORDER BY created_at DESC').all() as any[];
}

export function isGroupActive(groupId: string): boolean {
  const row = getDb().prepare('SELECT active FROM group_permissions WHERE group_id = ?').get(groupId) as any;
  return !!row?.active;
}

export function setGroupActive(groupId: string, active: boolean) {
  getDb().prepare('UPDATE group_permissions SET active = ? WHERE group_id = ?').run(active ? 1 : 0, groupId);
}

export function isBlacklisted(phone: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM blacklist WHERE phone = ?').get(phone);
}

export function addBlacklist(phone: string, reason: string) {
  getDb().prepare('INSERT OR REPLACE INTO blacklist (phone, reason) VALUES (?, ?)').run(phone, reason);
}

export function getContactInstruction(phone: string): string | null {
  const row = getDb().prepare('SELECT instruction FROM contact_instructions WHERE phone = ?').get(phone) as any;
  return row?.instruction || null;
}

export function setContactInstruction(phone: string, instruction: string) {
  getDb().prepare('INSERT OR REPLACE INTO contact_instructions (phone, instruction, updated_at) VALUES (?, ?, unixepoch())')
    .run(phone, instruction);
}

export function scheduleFollowUp(phone: string, message: string, scheduledAt: Date) {
  getDb().prepare('INSERT INTO follow_ups (phone, message, scheduled_at) VALUES (?, ?, ?)')
    .run(phone, message, Math.floor(scheduledAt.getTime() / 1000));
}

export function getDueFollowUps() {
  const now = Math.floor(Date.now() / 1000);
  return getDb().prepare('SELECT * FROM follow_ups WHERE scheduled_at <= ? AND sent = 0').all(now) as any[];
}

export function markFollowUpSent(id: number) {
  getDb().prepare('UPDATE follow_ups SET sent = 1 WHERE id = ?').run(id);
}

// ─── Follow-ups v2 (com recorrência e condições de parada) ───────────────────

export interface FollowUpV2 {
  id: number;
  phone: string;
  message: string;
  next_send_at: number;
  recurrence_days: number;
  stop_condition: 'date' | 'reply' | 'document' | 'manual';
  stop_date: number | null;
  status: 'ativo' | 'pausado' | 'concluido';
  created_at: number;
}

export function createFollowUpV2(params: {
  phone: string;
  message: string;
  nextSendAt: Date;
  recurrenceDays: number;
  stopCondition: FollowUpV2['stop_condition'];
  stopDate?: Date;
}): number {
  const r = getDb().prepare(`
    INSERT INTO follow_ups_v2 (phone, message, next_send_at, recurrence_days, stop_condition, stop_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    params.phone,
    params.message,
    Math.floor(params.nextSendAt.getTime() / 1000),
    params.recurrenceDays,
    params.stopCondition,
    params.stopDate ? Math.floor(params.stopDate.getTime() / 1000) : null
  );
  return r.lastInsertRowid as number;
}

export function getDueFollowUpsV2(): FollowUpV2[] {
  const now = Math.floor(Date.now() / 1000);
  return getDb().prepare(`
    SELECT * FROM follow_ups_v2
    WHERE status = 'ativo' AND next_send_at <= ?
  `).all(now) as FollowUpV2[];
}

export function getFollowUpsForPhone(phone: string): FollowUpV2[] {
  return getDb().prepare('SELECT * FROM follow_ups_v2 WHERE phone = ? ORDER BY created_at DESC').all(phone) as FollowUpV2[];
}

export function rescheduleFollowUpV2(id: number, nextSendAt: Date) {
  getDb().prepare('UPDATE follow_ups_v2 SET next_send_at = ? WHERE id = ?')
    .run(Math.floor(nextSendAt.getTime() / 1000), id);
}

export function updateFollowUpV2Status(id: number, status: FollowUpV2['status']) {
  getDb().prepare('UPDATE follow_ups_v2 SET status = ? WHERE id = ?').run(status, id);
}

export function cancelFollowUpsOnReply(phone: string) {
  getDb().prepare(`UPDATE follow_ups_v2 SET status = 'concluido' WHERE phone = ? AND status = 'ativo' AND stop_condition = 'reply'`)
    .run(phone);
}

export function purgeOldMessages(days = 90) {
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  getDb().prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff);
}

// ─── Settings (modo ausência, etc.) ──────────────────────────────────────────

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
  return row?.value || null;
}

export function setSetting(key: string, value: string | null) {
  if (value === null) {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
  } else {
    getDb().prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())')
      .run(key, value);
  }
}
