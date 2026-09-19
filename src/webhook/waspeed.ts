import { Router, Request, Response } from 'express';
import { handleIncomingMessage } from '../flow/orchestrator';
import { detectAppointment } from '../flow/appointmentDetector';

export const webhookRouter = Router();

webhookRouter.post('/', async (req: Request, res: Response) => {
  try {
    const payload = req.body;

    res.json({ status: 'received' });

    console.log('[webhook] payload recebido:', JSON.stringify(payload).slice(0, 300));

    if (!payload || payload.type !== 'message') {
      console.log('[webhook] ignorado — type:', payload?.type);
      return;
    }

    const msg = payload.message || payload;
    const from: string = msg.from || msg.chatId || '';
    const body: string = msg.body || msg.text || '';
    const mediaUrl: string | undefined = msg.mediaUrl || msg.url || undefined;
    const messageType: string = msg.type || 'text';
    const fromMe: boolean = !!(msg.fromMe || msg.id?.fromMe);
    const isGroup: boolean = from.includes('@g.us') || from.includes('-');

    console.log('[webhook] from:', from, '| fromMe:', fromMe, '| isGroup:', isGroup, '| body:', body.slice(0, 80));

    if (!from) return;

    if (isGroup) {
      await handleGroupMessage(from, body, req.app.locals.io);
      return;
    }

    const phone = normalizePhone(from);

    // Mensagens enviadas por Wesley: detecta agendamentos e não processa pelo pipeline
    if (fromMe) {
      const { getSession } = await import('../memory/db');
      const session = getSession(phone);
      detectAppointment(phone, body, session?.name, req.app.locals.io).catch(() => {});
      return;
    }

    await handleIncomingMessage({
      phone,
      body,
      mediaUrl,
      messageType,
      io: req.app.locals.io,
    });
  } catch (err) {
    console.error('[webhook] erro:', err);
  }
});

async function handleGroupMessage(groupId: string, _body: string, io: any) {
  const { getDb } = await import('../memory/db');
  const db = getDb();
  const existing = db.prepare('SELECT * FROM group_permissions WHERE group_id = ?').get(groupId);
  if (!existing) {
    db.prepare('INSERT OR IGNORE INTO group_permissions (group_id, active) VALUES (?, 0)').run(groupId);
    io?.emit('new_group', { groupId, message: `Mensagem recebida no grupo ${groupId}. Incluir atendimento automatizado por IA?` });
  }
}

export function normalizePhone(raw: string): string {
  let phone = raw.replace(/@.*/, '').replace(/[^0-9]/g, '');

  if (phone.startsWith('55') && phone.length === 13) {
    const ddd = parseInt(phone.substring(2, 4));
    if (ddd > 30) {
      phone = phone.substring(0, 4) + phone.substring(5);
    }
  }

  return phone;
}
