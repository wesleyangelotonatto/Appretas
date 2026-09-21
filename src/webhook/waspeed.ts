import { Router, Request, Response } from 'express';
import { handleIncomingMessage } from '../flow/orchestrator';
import { detectAppointment } from '../flow/appointmentDetector';

export const webhookRouter = Router();

// Número do agendador eletrônico — nunca tratado como cliente (normalizado, ver normalizePhone)
const AGENDADOR_PHONE = process.env.AGENDADOR_PHONE || '554488596158';

webhookRouter.post('/', async (req: Request, res: Response) => {
  try {
    const payload = req.body;

    res.json({ status: 'received' });

    if (!payload || payload.eventID !== 'messages') {
      console.log('[webhook] ignorado — eventID:', payload?.eventID);
      return;
    }

    const det = payload.eventDetails || {};
    const last = payload.lastMessage || {};

    const from: string = payload.number || det.from || '';
    const body: string = last.text || det.body || '';
    const mediaUrl: string | undefined = det.mediaUrl || det.url || undefined;
    const messageType: string = det.type || last.type || 'chat';
    const fromMe: boolean = !!(det.id?.fromMe || det.fromMe);
    const isGroup: boolean = from.includes('@g.us') || String(from).includes('-');
    const waName: string = String(payload.name || det.notifyName || '').trim();

    if (!from) return;

    // Ignora Status/Stories do WhatsApp — nunca é uma conversa real com um cliente,
    // mesmo quando tem texto (ex: legenda de um Status de terceiros)
    if (from === 'status' || from.startsWith('status@')) {
      console.log('[webhook] ignorado — Status/Story do WhatsApp:', from);
      return;
    }

    // Grupos: só registra silenciosamente para o painel decidir se ativa atendimento
    // (nunca processa/responde), sem poluir o log com o payload completo
    if (isGroup) {
      await handleGroupMessage(from, req.app.locals.io);
      return;
    }

    // O campo com o conteúdo em base64 varia conforme o tipo de mídia/versão do Waspeed;
    // tenta os nomes mais comuns e remove prefixo "data:...;base64," se presente
    let base64raw: string | undefined = det.base64 || det.data || det.file || det.media || last.base64 || undefined;
    if (base64raw?.startsWith('data:')) {
      base64raw = base64raw.split(',')[1];
    }
    const base64 = base64raw;

    const filename: string | undefined = det.filename || det.caption || undefined;
    const mimetype: string | undefined = det.mimetype || det.mimeType || undefined;

    console.log('[webhook] payload recebido:', JSON.stringify(payload).slice(0, 300));
    console.log('[webhook] from:', from, '| fromMe:', fromMe, '| isGroup:', isGroup, '| body:', body.slice(0, 80));
    if (messageType === 'audio' || messageType === 'ptt' || messageType === 'document' || messageType === 'image') {
      console.log('[webhook] mídia — type:', messageType, '| eventDetails keys:', Object.keys(det), '| base64 length:', base64?.length || 0, '| mimetype:', mimetype);
    }

    // Ignora eventos que não são mensagens reais (reações, confirmações de leitura, etc.)
    // — sem texto e sem mídia não há nada para processar
    const temConteudo = !!(body?.trim() || base64 || mediaUrl);
    if (!temConteudo) {
      console.log('[webhook] ignorado — evento sem conteúdo (não é mensagem real):', from);
      return;
    }

    const phone = normalizePhone(from);

    // Número do agendador eletrônico: nunca é tratado como cliente, só recebe a notificação
    // automática de compromisso (ver appointmentDetector.ts) — qualquer mensagem vinda dele é ignorada
    if (phone === AGENDADOR_PHONE) {
      console.log('[webhook] ignorado — mensagem do número agendador:', phone);
      return;
    }

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
      waName,
      base64,
      filename,
      mimetype,
      io: req.app.locals.io,
    });
  } catch (err) {
    console.error('[webhook] erro:', err);
  }
});

async function handleGroupMessage(groupId: string, io: any) {
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
