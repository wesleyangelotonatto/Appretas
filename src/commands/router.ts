import { Router, Request, Response } from 'express';
import { parseCommand } from '../responder/claude';
import { sendMessage, sendFile, sistemaPausado, modoCalibragem } from '../responder/send';
import {
  saveMessage, upsertSession, getHistory, scheduleFollowUp,
  setContactInstruction, addBlacklist, getPendingApprovals, deletePendingApproval, deleteAllPendingApprovals,
  createFollowUpV2, getFollowUpsForPhone, updateFollowUpV2Status,
  getSetting, setSetting, saveCorrection, savePendingApproval as _savePendingApproval,
  getActiveConversations, getRecentCorrections, getGroups, setGroupActive,
  salvarTreinamento, listarTreinamento, contarTreinamento,
} from '../memory/db';
import { criarCardLead, buscarCardTrello, adicionarNotaCard } from '../integrations/trello';
import { consultarDjen } from '../integrations/djen';

export const commandRouter = Router();

// POST /command — recebe comandos do painel
commandRouter.post('/', async (req: Request, res: Response) => {
  const { text, context } = req.body;
  if (!text) return res.status(400).json({ error: 'Comando vazio' });

  try {
    const parsed = await parseCommand(text, context || '{}');

    // Fallback: se a ação é enviar mensagem mas o telefone não veio identificado,
    // usa a conversa ativa no painel (activePhone) como alvo
    if (parsed.action === 'send_message' && !parsed.params?.phone) {
      try {
        const ctx = JSON.parse(context || '{}');
        if (ctx.activePhone) parsed.params = { ...parsed.params, phone: ctx.activePhone };
      } catch {}
    }

    const result = await executeCommand(parsed, req.app.locals.io);

    // Log real: comando dado + confirmação de que foi de fato enviado/executado
    const sentOk = parsed.action === 'send_message' ? !!result?.sent : true;
    req.app.locals.io?.emit('command_log', {
      command: text,
      response: sentOk ? (parsed.response || 'Executado') : 'Falha: telefone não identificado, mensagem não enviada',
      ok: sentOk,
      timestamp: Date.now(),
    });

    res.json({ parsed, result });
  } catch (err) {
    console.error('[command] erro:', err);
    req.app.locals.io?.emit('command_log', { command: text, response: `Erro: ${String(err)}`, ok: false, timestamp: Date.now() });
    res.status(500).json({ error: String(err) });
  }
});

// POST /command/approve/:id — aprova resposta pendente (modo treino)
commandRouter.post('/approve/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { draft, phone } = req.body;

  if (draft === '__DISCARD__') {
    deletePendingApproval(id);
    return res.json({ ok: true, discarded: true });
  }

  try {
    // Detecta se houve edição e salva para treinamento
    const approvals = getPendingApprovals();
    const original = approvals.find((a: any) => a.id === id);
    if (original && original.draft !== draft) {
      saveCorrection(phone, original.draft, draft, original.context);
      console.log(`[correction] salva para ${phone} — original: "${original.draft.slice(0, 60)}..." → editado: "${draft.slice(0, 60)}..."`);
    }

    // Em calibragem, aprovar NÃO envia: guarda no banco de treinamento o que a IA
    // redigiu e o que ficou depois da sua edição. Nada chega ao cliente, e o
    // histórico real da conversa não recebe uma resposta que nunca existiu.
    if (modoCalibragem()) {
      salvarTreinamento({
        phone,
        tipo: 'rascunho',
        contexto: original?.context || null,
        textoOriginal: original?.draft || draft,
        textoFinal: draft,
      });
      deletePendingApproval(id);
      req.app.locals.io?.emit('approval_sent', { id, phone, draft, calibragem: true });
      req.app.locals.io?.emit('command_log', { command: `[Calibragem] ${phone}`, response: 'Resposta guardada para treinamento — nada foi enviado', ok: true, timestamp: Date.now() });
      console.log(`[calibragem] resposta de ${phone} guardada para treinamento — NÃO enviada`);
      return res.json({ ok: true, calibragem: true });
    }

    await sendMessage(phone, draft);
    saveMessage(phone, 'iara', draft);
    deletePendingApproval(id);

    req.app.locals.io?.emit('approval_sent', { id, phone, draft });
    req.app.locals.io?.emit('message', { phone, role: 'iara', body: draft, timestamp: Date.now() });
    req.app.locals.io?.emit('command_log', { command: `[Aprovação] ${phone}`, response: draft, ok: true, timestamp: Date.now() });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /command/resumos — dispara resumos diários manualmente
commandRouter.post('/resumos', async (_req, res) => {
  try {
    const { cronResumosDiarios } = await import('../cron/resumos');
    cronResumosDiarios().catch(err => console.error('[resumos] erro:', err));
    res.json({ ok: true, message: 'Geração de resumos iniciada' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /command/naorespondidos — dispara sob demanda os avisos de "não esquecemos".
// O envio automático está desligado; este endpoint existe para usar a função
// deliberadamente, quando Wesley quiser, em vez de ela rodar sozinha toda hora.
commandRouter.post('/naorespondidos', async (_req, res) => {
  try {
    const { cronNaoRespondidos } = await import('../cron/naorespondidos');
    cronNaoRespondidos().catch(err => console.error('[naorespondidos] erro:', err));
    res.json({ ok: true, message: 'Verificação de conversas sem resposta iniciada' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /command/pending/descartar-todos — limpa a fila inteira de rascunhos
commandRouter.post('/pending/descartar-todos', (req, res) => {
  try {
    const removidos = deleteAllPendingApprovals();
    req.app.locals.io?.emit('approvals_cleared', { removidos });
    console.log(`[treino] ${removidos} rascunho(s) descartado(s) de uma vez`);
    res.json({ ok: true, removidos });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /command/pending — lista aprovações pendentes (modo treino)
commandRouter.get('/pending', (_req, res) => {
  res.json(getPendingApprovals());
});

// GET /command/conversations — reconstrói o estado do painel após refresh (F5)
commandRouter.get('/conversations', (_req, res) => {
  res.json(getActiveConversations(7));
});

// GET /command/corrections — lista correções salvas para treinamento (edições antes de aprovar)
commandRouter.get('/corrections', (_req, res) => {
  res.json(getRecentCorrections(50));
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
    await sendMessage(phone, message, { assinar: false });
    // Em calibragem a mensagem não saiu (ficou registrada no banco de treinamento),
    // então não entra no histórico real como se o cliente a tivesse recebido
    if (modoCalibragem()) {
      return res.json({ ok: true, calibragem: true, aviso: 'Modo calibragem: nada foi enviado ao cliente' });
    }
    saveMessage(phone, 'wesley', message);
    req.app.locals.io?.emit('message', { phone, role: 'wesley', body: message, timestamp: Date.now() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /command/send-document — envia documento ao contato
commandRouter.post('/send-document', async (req: Request, res: Response) => {
  const { phone, url, caption } = req.body;
  if (!phone || !url) return res.status(400).json({ error: 'Informe phone e url' });

  try {
    await sendFile(phone, url, caption || '');
    saveMessage(phone, 'iara', `[Documento enviado] ${caption || url}`);
    req.app.locals.io?.emit('message', {
      phone, role: 'iara',
      body: `📎 Documento: ${caption || url}`,
      timestamp: Date.now()
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Follow-ups v2 ────────────────────────────────────────────────────────────

// POST /command/followup — cria follow-up
commandRouter.post('/followup', (req: Request, res: Response) => {
  const { phone, message, startDate, recurrenceDays, stopCondition, stopDate } = req.body;
  if (!phone || !message || !startDate) return res.status(400).json({ error: 'Informe phone, message e startDate' });

  const id = createFollowUpV2({
    phone,
    message,
    nextSendAt: new Date(startDate),
    recurrenceDays: recurrenceDays || 0,
    stopCondition: stopCondition || 'manual',
    stopDate: stopDate ? new Date(stopDate) : undefined,
  });

  req.app.locals.io?.emit('followup_created', { id, phone, message, recurrenceDays, stopCondition });
  console.log(`[followup] criado id=${id} para ${phone}`);
  res.json({ ok: true, id });
});

// GET /command/followup/:phone — lista follow-ups de um contato
commandRouter.get('/followup/:phone', (req: Request, res: Response) => {
  res.json(getFollowUpsForPhone(req.params.phone));
});

// POST /command/followup/:id/cancel — encerra follow-up
commandRouter.post('/followup/:id/cancel', (req: Request, res: Response) => {
  updateFollowUpV2Status(parseInt(req.params.id), 'concluido');
  req.app.locals.io?.emit('followup_updated', { id: req.params.id, status: 'concluido' });
  res.json({ ok: true });
});

// POST /command/followup/:id/pause — pausa ou retoma follow-up
commandRouter.post('/followup/:id/pause', (req: Request, res: Response) => {
  const { status } = req.body; // 'pausado' ou 'ativo'
  updateFollowUpV2Status(parseInt(req.params.id), status || 'pausado');
  req.app.locals.io?.emit('followup_updated', { id: req.params.id, status });
  res.json({ ok: true });
});

// ─── Modo Ausência ────────────────────────────────────────────────────────────

// GET /command/ausencia — retorna estado atual
commandRouter.get('/ausencia', (_req, res) => {
  const msg = getSetting('ausencia_msg');
  res.json({ ativo: !!msg, mensagem: msg || '' });
});

// POST /command/ausencia — ativa modo ausência com mensagem personalizada
commandRouter.post('/ausencia', (req: Request, res: Response) => {
  const { mensagem } = req.body;
  if (!mensagem) return res.status(400).json({ error: 'Informe a mensagem de ausência' });
  setSetting('ausencia_msg', mensagem);
  req.app.locals.io?.emit('ausencia_update', { ativo: true, mensagem });
  console.log('[ausencia] modo ausência ATIVADO');
  res.json({ ok: true, mensagem });
});

// DELETE /command/ausencia — desativa modo ausência
commandRouter.delete('/ausencia', (req: Request, res: Response) => {
  setSetting('ausencia_msg', null);
  req.app.locals.io?.emit('ausencia_update', { ativo: false });
  console.log('[ausencia] modo ausência DESATIVADO');
  res.json({ ok: true });
});

// ─── Modo calibragem: treinar sem que nada chegue ao cliente ───────────────────
// Recebe, interpreta e redige normalmente; toda resposta vai para o banco de
// treinamento em vez do WhatsApp. Resumos, notas e Drive seguem funcionando.

commandRouter.get('/calibragem', (_req, res) => {
  res.json({ ativo: modoCalibragem(), ...contarTreinamento() });
});

commandRouter.post('/calibragem/ativar', (req: Request, res: Response) => {
  setSetting('modo_calibragem', '1');
  req.app.locals.io?.emit('calibragem_update', { ativo: true });
  console.log('[calibragem] LIGADA — nenhuma mensagem será enviada a clientes');
  res.json({ ok: true, ativo: true });
});

commandRouter.post('/calibragem/desativar', (req: Request, res: Response) => {
  setSetting('modo_calibragem', '0');
  req.app.locals.io?.emit('calibragem_update', { ativo: false });
  console.log('[calibragem] DESLIGADA — envios normais retomados');
  res.json({ ok: true, ativo: false });
});

// GET /command/treinamento — registros de calibração (também em CSV, ?formato=csv)
commandRouter.get('/treinamento', (req: Request, res: Response) => {
  const registros = listarTreinamento(parseInt(String(req.query.limit || '')) || 200);
  if (req.query.formato === 'csv') {
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const linhas = [
      'data,telefone,tipo,editado,contexto,texto_original,texto_final',
      ...registros.map(r => [
        new Date(r.created_at * 1000).toLocaleString('pt-BR', { timeZone: process.env.TZ_APP || 'America/Sao_Paulo' }),
        r.phone, r.tipo, r.editado ? 'sim' : 'nao', r.contexto, r.texto_original, r.texto_final,
      ].map(esc).join(',')),
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="calibragem-iara.csv"');
    return res.send('﻿' + linhas.join('\n'));
  }
  res.json({ ...contarTreinamento(), registros });
});

// ─── Ativar/Desativar a secretária (Iara) ──────────────────────────────────────
// Enquanto pausada, nenhuma mensagem sai para o WhatsApp (webhook, crons e painel
// continuam recebendo e processando normalmente, só o envio real é bloqueado)

// GET /command/secretaria — retorna se a secretária está ativa
commandRouter.get('/secretaria', (_req, res) => {
  res.json({ ativa: !sistemaPausado() });
});

// POST /command/secretaria/pausar — desativa a secretária
commandRouter.post('/secretaria/pausar', (req: Request, res: Response) => {
  setSetting('sistema_pausado', '1');
  req.app.locals.io?.emit('secretaria_update', { ativa: false });
  console.log('[secretaria] PAUSADA pelo painel');
  res.json({ ok: true, ativa: false });
});

// POST /command/secretaria/ativar — reativa a secretária
commandRouter.post('/secretaria/ativar', (req: Request, res: Response) => {
  setSetting('sistema_pausado', '0');
  req.app.locals.io?.emit('secretaria_update', { ativa: true });
  console.log('[secretaria] REATIVADA pelo painel');
  res.json({ ok: true, ativa: true });
});

// ─── Grupos: quais têm atendimento por IA ativado ──────────────────────────────

// GET /command/groups — lista grupos já vistos e se estão ativos
commandRouter.get('/groups', (_req, res) => {
  res.json(getGroups());
});

// POST /command/groups/:groupId/activate — Iara passa a responder neste grupo
commandRouter.post('/groups/:groupId/activate', (req: Request, res: Response) => {
  setGroupActive(req.params.groupId, true);
  req.app.locals.io?.emit('group_update', { groupId: req.params.groupId, active: true });
  console.log('[groups] ativado:', req.params.groupId);
  res.json({ ok: true });
});

// POST /command/groups/:groupId/deactivate — Iara para de responder neste grupo
commandRouter.post('/groups/:groupId/deactivate', (req: Request, res: Response) => {
  setGroupActive(req.params.groupId, false);
  req.app.locals.io?.emit('group_update', { groupId: req.params.groupId, active: false });
  console.log('[groups] desativado:', req.params.groupId);
  res.json({ ok: true });
});

async function executeCommand(parsed: any, io: any): Promise<any> {
  const { action, params } = parsed;

  switch (action) {
    case 'send_message':
      await sendMessage(params.phone, params.message, { assinar: false });
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

    default:
      return { unknown: true };
  }
}
