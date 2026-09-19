import { Router, Request, Response } from 'express';
import { parseCommand } from '../responder/claude';
import { sendMessage } from '../responder/send';
import { saveMessage, upsertSession, getHistory, scheduleFollowUp, setContactInstruction, addBlacklist, getPendingApprovals, deletePendingApproval } from '../memory/db';
import { criarCardLead, buscarCardTrello, adicionarNotaCard } from '../integrations/trello';
import { consultarDjen } from '../integrations/djen';
import { saveConversationSummary } from '../integrations/drive';

export const commandRouter = Router();

// POST /command — recebe comandos do painel
commandRouter.post('/', async (req: Request, res: Response) => {
  const { text, context } = req.body;
  if (!text) return res.status(400).json({ error: 'Comando vazio' });

  try {
    const parsed = await parseCommand(text, context || '{}');
    const result = await executeCommand(parsed, req.app.locals.io);
    res.json({ parsed, result });
  } catch (err) {
    console.error('[command] erro:', err);
    res.status(500).json({ error: String(err) });
  }
});

// POST /command/approve/:id — aprova resposta pendente (modo treino)
commandRouter.post('/approve/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { draft, phone } = req.body;

  try {
    await sendMessage(phone, draft);
    saveMessage(phone, 'iara', draft);
    deletePendingApproval(id);

    req.app.locals.io?.emit('approval_sent', { id, phone, draft });
    req.app.locals.io?.emit('message', { phone, role: 'iara', body: draft, timestamp: Date.now() });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /command/pending — lista aprovações pendentes (modo treino)
commandRouter.get('/pending', (_req, res) => {
  res.json(getPendingApprovals());
});

// POST /command/takeover — Wesley assume conversa
commandRouter.post('/takeover', (req, res) => {
  const { phone } = req.body;
  upsertSession(phone, { status: 'takeover' });
  req.app.locals.io?.emit('session_update', { phone, status: 'takeover' });
  res.json({ ok: true });
});

// POST /command/handback — devolve conversa à IA
commandRouter.post('/handback', (req, res) => {
  const { phone } = req.body;
  upsertSession(phone, { status: 'ativo' });
  req.app.locals.io?.emit('session_update', { phone, status: 'ativo' });
  res.json({ ok: true });
});

// POST /command/send — envia mensagem direta de Wesley
commandRouter.post('/send', async (req, res) => {
  const { phone, message } = req.body;
  try {
    await sendMessage(phone, message);
    saveMessage(phone, 'wesley', message);
    req.app.locals.io?.emit('message', { phone, role: 'wesley', body: message, timestamp: Date.now() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

async function executeCommand(parsed: any, io: any): Promise<any> {
  const { action, params } = parsed;

  switch (action) {
    case 'send_message':
      await sendMessage(params.phone, params.message);
      saveMessage(params.phone, 'wesley', params.message);
      io?.emit('message', { phone: params.phone, role: 'wesley', body: params.message, timestamp: Date.now() });
      return { sent: true };

    case 'update_trello': {
      const card = await buscarCardTrello(params.cardName);
      if (card && params.note) await adicionarNotaCard(card.id, params.note);
      return { updated: !!card };
    }

    case 'create_lead':
      await criarCardLead({ name: params.name, phone: params.phone, summary: params.summary, type: 'LEAD_MANUAL' });
      return { created: true };

    case 'search_process': {
      const djen = await consultarDjen(params.query);
      return { result: djen };
    }

    case 'pause_contact':
      upsertSession(params.phone, { status: 'pausado' });
      io?.emit('session_update', { phone: params.phone, status: 'pausado' });
      return { paused: true };

    case 'resume_contact':
      upsertSession(params.phone, { status: 'ativo' });
      io?.emit('session_update', { phone: params.phone, status: 'ativo' });
      return { resumed: true };

    case 'set_instruction':
      setContactInstruction(params.phone, params.instruction);
      return { set: true };

    case 'schedule_followup': {
      const scheduledAt = new Date();
      scheduledAt.setDate(scheduledAt.getDate() + (params.days || 3));
      scheduleFollowUp(params.phone, params.message, scheduledAt);
      return { scheduled: scheduledAt.toLocaleDateString('pt-BR') };
    }

    case 'day_summary': {
      const today = Math.floor(Date.now() / 1000) - 86400;
      return { message: 'Resumo disponível no painel' };
    }

    default:
      return { unknown: true };
  }
}
