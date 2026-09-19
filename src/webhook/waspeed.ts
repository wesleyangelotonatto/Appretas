import { Router, Request, Response } from 'express';
import { handleIncomingMessage } from '../flow/orchestrator';

export const webhookRouter = Router();

// POST /webhook — recebe eventos do Waspeed (classic Wascript API)
webhookRouter.post('/', async (req: Request, res: Response) => {
  try {
    const payload = req.body;

    // Confirma recebimento imediatamente (Waspeed não espera processamento)
    res.json({ status: 'received' });

    // Filtra apenas mensagens recebidas (ignora ACK, status, etc.)
    if (!payload || payload.type !== 'message') return;

    const msg = payload.message || payload;
    const from: string = msg.from || msg.chatId || '';
    const body: string = msg.body || msg.text || '';
    const mediaUrl: string | undefined = msg.mediaUrl || msg.url || undefined;
    const messageType: string = msg.type || 'text';
    const isGroup: boolean = from.includes('@g.us') || from.includes('-');

    if (!from) return;

    // Grupos: verifica se está autorizado (gerenciado pelo painel)
    if (isGroup) {
      await handleGroupMessage(from, body, req.app.locals.io);
      return;
    }

    // Normaliza número (remove @c.us, @s.whatsapp.net, etc.)
    const phone = normalizePhone(from);

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
    // Novo grupo — pergunta ao Wesley via painel
    db.prepare('INSERT OR IGNORE INTO group_permissions (group_id, active) VALUES (?, 0)').run(groupId);
    io?.emit('new_group', { groupId, message: `Mensagem recebida no grupo ${groupId}. Incluir atendimento automatizado por IA?` });
  }
  // Se não autorizado, ignora silenciosamente
}

export function normalizePhone(raw: string): string {
  // Remove @c.us, @s.whatsapp.net, espaços, traços, parênteses, +
  let phone = raw.replace(/@.*/, '').replace(/[^0-9]/g, '');

  // Remove o 9º dígito para DDDs > 30 (padrão BR para DDDs fora de SP/RJ area)
  // ex: 554499XXXXXXX → 55449XXXXXXX quando DDD > 30
  if (phone.startsWith('55') && phone.length === 13) {
    const ddd = parseInt(phone.substring(2, 4));
    if (ddd > 30) {
      // Remove o nono dígito (posição 4 após o DDD)
      phone = phone.substring(0, 4) + phone.substring(5);
    }
  }

  return phone;
}
