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
      type TEXT,          -- PROCESSO_ATIVO | NOVO_CASO | LEAD_NOVO | NEGOCIO | AMIGO | INSTITUCIONAL | DESCONHECIDO
      status TEXT DEFAULT 'ativo', -- ativo | takeover | pausado | encerrado
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      role TEXT NOT NULL,  -- client | iara | wesley
      body TEXT NOT NULL,  -- criptografado em prod: Base64(AES)
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

    CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_follow_ups_scheduled ON follow_ups(scheduled_at, sent);
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

export function purgeOldMessages(days = 90) {
  const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
  getDb().prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff);
}
