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

    CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_follow_ups_scheduled ON follow_ups(scheduled_at, sent);
    CREATE INDEX IF NOT EXISTS idx_fup2_next ON follow_ups_v2(next_send_at, status);
  `);

  console.log('[db] banco inicializado:', DB_PATH);
}

export function getSession(phone: string) {
  return getDb().prepare('SELECT * FROM sessions WHERE phone = ?').get(phone) as any;
}

export function upsertSession(phone: string, data: Record<string, any>) {
  const existing = getSession(phone);
  if (existing) {
    const sets = Object.keys(data).map(k => `${k} = ?`).join(', ');
    getDb().prepare(`UPDATE sessions SET ${sets}, updated_at = unixepoch() WHERE phone = ?`)
      .run(...Object.values(data), phone);
  } else {
    getDb().prepare(
      `INSERT INTO sessions (phone, ${Object.keys(data).join(', ')}) VALUES (?, ${Object.keys(data).map(() => '?').join(', ')})`
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
