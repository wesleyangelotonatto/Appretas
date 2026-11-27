import { Router, Request, Response } from 'express';
import { parseCommand } from '../responder/claude';
import { sendMessage, sendFile, sistemaPausado, modoCalibragem, reenviarAgora } from '../responder/send';
import {
  saveMessage, upsertSession, getHistory, scheduleFollowUp,
  setContactInstruction, addBlacklist, getPendingApprovals, deletePendingApproval, deleteAllPendingApprovals,
  createFollowUpV2, getFollowUpsForPhone, updateFollowUpV2Status,
  getSetting, setSetting, saveCorrection, savePendingApproval as _savePendingApproval,
  getActiveConversations, getRecentCorrections, getCorrectionsComContato, getGroups, setGroupActive,
  salvarTreinamento, listarTreinamento, contarTreinamento,
  listarAvisosPendentes, getAvisoPendente, marcarAvisoEnviado, marcarAvisoDescartado, descartarTodosAvisos, atualizarContatoAviso, atualizarDadosAviso,
  salvarContatoProcesso, listarContatosProcesso,
  listarEnviosFila, contarEnviosPerdidos, getEnvioFila, reagendarTodosEnviosPerdidos, descartarEnvio, listarConfirmacoes,
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
    // Descarte de rascunho de Vendas conta no placar, com o motivo
    const orig = getPendingApprovals().find((a: any) => a.id === id);
    const ctx = lerContextoVendas(orig?.context);
    if (orig && ctx) salvarTreinamento({ phone: orig.phone, tipo: 'vendas_descartado', contexto: JSON.stringify({ ...ctx, motivoDescarte: String(req.body.motivo || '').slice(0, 300) || null }), textoOriginal: orig.draft, textoFinal: '' });
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

    // Rascunho da função Vendas: registra no placar e, aprovado, a etapa sugerida passa a valer
    // (no CRM; etapas de decisão 02/07/11 viram sugestão para o Wesley aprovar lá)
    const ctxV = lerContextoVendas(original?.context);
    if (original && ctxV) {
      salvarTreinamento({ phone, tipo: 'vendas', contexto: original.context, textoOriginal: original.draft, textoFinal: draft });
      // "Enviar provas" (4.14): a Iara só oferece; aceito pelo lead, vira tarefa do Wesley (1 dia útil)
      if (ctxV.provasAceitas) {
        import('../integrations/crm').then(({ registrarNaFicha }) => registrarNaFicha(phone, { tipo: 'tarefa', tarefa: {
          tipo: 'enviar_provas', titulo: 'Enviar provas ao lead', prazoDiasUteis: 1,
          detalhe: 'O lead aceitou receber decisões de casos parecidos e/ou contato de clientes. Produto: ' + (ctxV.produto || '?') + '. Pedido: "' + String(ctxV.mensagemCliente || '').slice(0, 300) + '"' } }))
          .catch(err => console.error('[vendas] tarefa provas:', err));
      }
      if (ctxV.etapaSugerida && ctxV.etapaSugerida !== ctxV.etapaAtual) {
        import('../integrations/crm').then(({ sugerirEtapa }) => sugerirEtapa(phone, ctxV.etapaSugerida, { observacao: 'Sugerido pela Iara (Vendas) ao aprovar o rascunho' + (ctxV.proximoPasso ? ': ' + ctxV.proximoPasso : '') }))
          .catch(err => console.error('[vendas] etapa sugerida:', err));
      }
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
    // Manual: refaz os resumos e o relatório do dia anterior (mesma rotina das 06h)
    const { cronDiarioManha } = await import('../cron/resumos');
    cronDiarioManha().catch(err => console.error('[resumos] erro:', err));
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

// ─── Avisos de audiência e prazo: confirmação antes de enviar ─────────────────

// POST /command/avisos/gerar — varre as listas e enfileira para revisão
commandRouter.post('/avisos/gerar', async (req: Request, res: Response) => {
  try {
    const { gerarAvisosParaConfirmacao } = await import('../flow/avisos');
    const dias = parseInt(String(req.body?.dias || '')) || 15;
    const r = await gerarAvisosParaConfirmacao(dias);
    req.app.locals.io?.emit('avisos_update', {});
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

commandRouter.get('/avisos', (_req, res) => {
  res.json(listarAvisosPendentes().map(a => ({ ...a, datas: JSON.parse(a.datas_json || '[]') })));
});

// POST /command/avisos/:id/aprovar — só aqui a mensagem sai, com a data que
// Wesley confirmou e o texto que ele deixou
commandRouter.post('/avisos/:id/aprovar', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  const { dataIso, mensagem } = req.body || {};
  try {
    const aviso = getAvisoPendente(id);
    if (!aviso || aviso.status !== 'pendente') return res.status(404).json({ error: 'Aviso não está pendente' });
    const texto = String(mensagem || aviso.mensagem || '').trim();
    if (!texto) return res.status(400).json({ error: 'Mensagem vazia' });

    // Nos processos fora da planilha o telefone chega vazio: sem ele não há
    // para quem enviar, e mandar para um número em branco seria pior que falhar
    const destino = String(req.body?.phone || aviso.phone || '').replace(/[^0-9]/g, '');
    if (destino.length < 10) {
      return res.status(400).json({ error: 'Informe o telefone do cliente (DDD + número) antes de enviar' });
    }
    if (destino !== aviso.phone || req.body?.nome) {
      atualizarContatoAviso(id, String(req.body?.nome || aviso.nome || ''), destino);
    }
    // Aprender o contato vale também ao aprovar, não só ao clicar em salvar
    salvarContatoProcesso({
      processo: aviso.processo, cardId: aviso.card_id,
      nome: String(req.body?.nome || aviso.nome || ''), phone: destino,
      partes: String(req.body?.partes || ''), juizo: String(req.body?.juizo || ''),
      posicao: String(req.body?.posicao || ''),
    });

    await sendMessage(destino, texto);
    marcarAvisoEnviado(id, String(dataIso || ''), texto);

    // Em calibragem o envio é interceptado e guardado no banco de treinamento,
    // então nada chega ao cliente e o histórico real não recebe a mensagem
    if (!modoCalibragem()) {
      saveMessage(destino, 'iara', texto);
      req.app.locals.io?.emit('message', { phone: destino, role: 'iara', body: texto, timestamp: Date.now() });
    }
    req.app.locals.io?.emit('avisos_update', {});
    res.json({ ok: true, calibragem: modoCalibragem() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /command/avisos/:id/contato — salva nome e telefone corrigidos na tela
commandRouter.post('/avisos/:id/contato', (req: Request, res: Response) => {
  const { nome, phone, mensagem, partes, juizo, posicao } = req.body || {};
  const limpo = String(phone || '').replace(/[^0-9]/g, '');
  if (limpo && (limpo.length < 10 || limpo.length > 13)) {
    return res.status(400).json({ error: 'Telefone deve ter DDD + número (10 a 13 dígitos)' });
  }
  const id = parseInt(req.params.id);
  atualizarContatoAviso(id, String(nome || ''), limpo, mensagem);
  // Guarda por processo: na próxima varredura o contato já vem preenchido
  const aviso = getAvisoPendente(id);
  if (aviso) {
    atualizarDadosAviso(id, { partes: String(partes || ''), juizo: String(juizo || ''), posicao: String(posicao || '') });
    salvarContatoProcesso({
      processo: aviso.processo, cardId: aviso.card_id,
      nome: String(nome || ''), phone: limpo,
      partes: String(partes || ''), juizo: String(juizo || ''), posicao: String(posicao || ''),
    });
  }
  req.app.locals.io?.emit('avisos_update', {});
  res.json({ ok: true, phone: limpo });
});

// POST /command/avisos/:id/refazer — reescreve a mensagem no servidor, com a
// data e os dados escolhidos. O painel tinha uma cópia do modelo em JavaScript,
// que ficou para trás quando o texto mudou: agora existe um modelo só.
commandRouter.post('/avisos/:id/refazer', async (req: Request, res: Response) => {
  try {
    const aviso = getAvisoPendente(parseInt(req.params.id));
    if (!aviso) return res.status(404).json({ error: 'Aviso não encontrado' });
    const { montarMensagem } = await import('../flow/avisos');
    const { dataIso, nome, partes, juizo } = req.body || {};
    const mensagem = montarMensagem(
      aviso.tipo,
      String(nome || aviso.nome || ''),
      String(dataIso || aviso.data_escolhida || ''),
      aviso.processo,
      { partes: String(partes ?? aviso.partes ?? ''), juizo: String(juizo ?? aviso.juizo ?? ''), momento: aviso.momento },
    );
    res.json({ ok: true, mensagem });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

commandRouter.post('/avisos/descartar-todos', (req: Request, res: Response) => {
  const removidos = descartarTodosAvisos();
  req.app.locals.io?.emit('avisos_update', {});
  console.log(`[avisos] ${removidos} aviso(s) descartado(s) de uma vez`);
  res.json({ ok: true, removidos });
});

commandRouter.post('/avisos/:id/descartar', (req: Request, res: Response) => {
  marcarAvisoDescartado(parseInt(req.params.id));
  req.app.locals.io?.emit('avisos_update', {});
  res.json({ ok: true });
});

// GET /command/contatos-processo — o que já foi aprendido na tela de avisos
commandRouter.get('/contatos-processo', (_req, res) => {
  res.json(listarContatosProcesso());
});

// GET /command/diagnostico-cards — percorre as listas de audiências e prazos e
// mostra, para cada card, o caminho inteiro: número do processo, datas achadas
// (e de onde vieram) e o cliente localizado na planilha pelo número do processo.
// Só lê; não envia nada.
commandRouter.get('/diagnostico-cards', async (req, res) => {
  try {
    const { getCardsAudiencias, getCardsPrazos } = await import('../integrations/trello');
    const { coletarDatasDoCard, extrairNumeroProcesso } = await import('../flow/dadosCard');
    const { carregarPlanilha, acharPorProcesso } = await import('../lookup/sheets');

    const dias = parseInt(String(req.query.dias || '')) || 15;
    const agora = Date.now();
    const limite = agora + dias * 86400000;
    const planilha = await carregarPlanilha(); // uma vez só, não por card

    const saida: any = { janelaDias: dias };
    for (const [rotulo, buscar] of [['audiencias', getCardsAudiencias], ['prazos', getCardsPrazos]] as const) {
      const cards = await buscar();
      // Comentários e checklists de cada card em paralelo — sequencial estourava o tempo
      const analisados = await Promise.all(cards.map(async (card: any) => {
        const processo = extrairNumeroProcesso(`${card.name || ''} ${card.desc || ''}`);
        const datas = await coletarDatasDoCard(card);
        return { card, processo, datas };
      }));

      const naJanela = analisados
        .map(a => {
          const futuras = a.datas.filter(d => {
            const t = new Date(d.dataIso).getTime();
            return t >= agora - 86400000 && t <= limite;
          });
          return { ...a, futuras };
        })
        .filter(a => a.futuras.length > 0)
        .sort((a, b) => a.futuras[0].dataIso.localeCompare(b.futuras[0].dataIso));

      saida[rotulo] = {
        totalNaLista: cards.length,
        naJanela: naJanela.length,
        cards: naJanela.map(a => {
          const cliente = a.processo ? acharPorProcesso(planilha, a.processo) : null;
          return {
            card: String(a.card.name || '').slice(0, 95),
            processo: a.processo || '(nenhum número encontrado)',
            datas: a.futuras.map(d => ({ origem: d.origem, data: d.dataIso, trecho: d.trecho.slice(0, 120) })),
            outrasDatas: a.datas.filter(d => !a.futuras.includes(d)).map(d => ({ origem: d.origem, data: d.dataIso })),
            cliente: cliente ? { nome: cliente.name, telefone: cliente.phone } : '(não localizado na planilha)',
          };
        }),
      };
    }
    res.json(saida);
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
  res.json(getCorrectionsComContato(50));
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
      await sendMessage(params.phone, params.message);
      saveMessage(params.phone, 'iara', params.message);
      io?.emit('message', { phone: params.phone, role: 'iara', body: params.message, timestamp: Date.now() });
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

// ─── Envios perdidos ─────────────────────────────────────────────────────────

// Teste dos modelos em produção: classifica e redige uma resposta de exemplo,
// sem enviar nada a ninguém. Usado para conferir os modelos depois de uma troca.
commandRouter.post('/teste-ia', async (_req, res) => {
  const { classifyContact } = await import('../classifier/groq');
  const { draftResponse, parseCommand } = await import('../responder/claude');
  const { modeloDa } = await import('../ia');
  const msg = 'Boa tarde, tive o Proagro negado na safra de soja e queria saber se vocês podem me ajudar';
  const t0 = Date.now();
  try {
    const classificacao = await classifyContact({ phone: '0000000000000', found: false, messageText: msg });
    const t1 = Date.now();
    const resposta = await draftResponse(classificacao.type, msg, '(teste automático, sem dados do sistema)', 'M', []);
    const t2 = Date.now();
    const comando = await parseCommand('Responda: ok, vou verificar', '{"activePhone":"0000000000000"}');
    res.json({ modelos: { rapido: modeloDa('rapido'), resposta: modeloDa('resposta') }, classificacao, ms_classificacao: t1 - t0, resposta, ms_resposta: t2 - t1, comando });
  } catch (err: any) {
    res.status(500).json({ erro: String(err?.message || err) });
  }
});

// Backup manual e estado do vigia (botões no painel)
commandRouter.post('/backup', async (_req, res) => {
  const { executarBackup } = await import('../cron/backup');
  res.json(await executarBackup());
});
commandRouter.post('/monitor', async (_req, res) => {
  const { executarMonitor } = await import('../cron/monitor');
  res.json(await executarMonitor());
});

// Custo estimado de IA por dia, função e modelo (últimos 30 dias)
commandRouter.get('/crm-ficha/:phone', async (req, res) => {
  const { fichaDoCRM } = await import('../integrations/crm');
  const f = await fichaDoCRM(req.params.phone);
  res.status(f ? 200 : 502).json(f ?? { erro: 'CRM não respondeu' });
});

commandRouter.get('/buscar', async (req, res) => {
  const { buscarConversas } = await import('../memory/busca');
  const q = String(req.query.q || '');
  const dia = (s: unknown, fim: boolean) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? Date.parse(String(s) + (fim ? 'T23:59:59-03:00' : 'T00:00:00-03:00')) : undefined;
  try {
    res.json(buscarConversas(q, { phone: req.query.phone ? String(req.query.phone) : undefined, desde: dia(req.query.de, false), ate: dia(req.query.ate, true), limite: Number(req.query.limite) || 30 }));
  } catch (err) { res.status(400).json({ erro: 'Busca inválida: ' + (err as Error).message }); }
});

function lerContextoVendas(ctx?: string | null): any {
  try { const j = JSON.parse(ctx || ''); return j && j.funcao === 'vendas' ? j : null; } catch { return null; }
}

// Função Vendas: posição (desligada / treino / ligada) e placar do treino
commandRouter.get('/vendas', async (_req, res) => {
  const { posicaoVendas } = await import('../vendas/vendas');
  const { getSetting } = await import('../memory/db');
  res.json({ posicao: posicaoVendas(), desde: JSON.parse(getSetting('funcao_vendas_desde') || 'null') });
});
commandRouter.post('/vendas', async (req, res) => {
  const p = String(req.body?.posicao || '');
  if (!['desligada', 'treino', 'ligada'].includes(p)) return res.status(400).json({ erro: 'posição inválida' });
  const { definirPosicaoVendas } = await import('../vendas/vendas');
  definirPosicaoVendas(p as any, (req as any).usuario?.login || 'painel');
  res.json({ ok: true, posicao: p });
});
commandRouter.post('/vendas/reprocessar', async (req, res) => {
  const { reprocessarConversas } = await import('../vendas/vendas');
  const limite = Math.min(30, Math.max(1, Number(req.body?.limite) || 10));
  res.json(await reprocessarConversas(limite));
});
commandRouter.post('/vendas/comparacoes/limpar', async (_req, res) => {
  const { limparComparacoes } = await import('../vendas/vendas');
  res.json({ removidas: limparComparacoes() });
});
commandRouter.get('/vendas/comparacoes', async (_req, res) => {
  const { listarComparacoes } = await import('../vendas/vendas');
  res.json({ comparacoes: listarComparacoes(100) });
});
// Follow-up automático de leads: liga/desliga, etapas e textos prontos
commandRouter.get('/followup', async (_req, res) => {
  const { configFollowup, ROTULO_ETAPA, TEXTOS_PADRAO } = await import('../vendas/cadencia');
  const { getSetting, getDb } = await import('../memory/db');
  let ultimos: any[] = [];
  try { ultimos = getDb().prepare('SELECT phone, cadencia, indice, status, enviado_em FROM vendas_toques ORDER BY enviado_em DESC LIMIT 30').all(); } catch { /* sem toques */ }
  res.json({ config: configFollowup(), rotulos: ROTULO_ETAPA, padrao: TEXTOS_PADRAO, alterado: JSON.parse(getSetting('followup_config_em') || 'null'), ultimos });
});
commandRouter.post('/followup', async (req, res) => {
  const { salvarConfigFollowup, TEXTOS_PADRAO } = await import('../vendas/cadencia');
  const b = req.body || {};
  const c: any = {};
  if (typeof b.ativo === 'boolean') c.ativo = b.ativo;
  if (b.etapas && typeof b.etapas === 'object') c.etapas = Object.fromEntries(Object.keys(TEXTOS_PADRAO).map(e => [e, !!b.etapas[e]]));
  if (b.diasConversa) c.diasConversa = Math.max(1, Math.min(180, Number(b.diasConversa) || 30));
  if (b.textos && typeof b.textos === 'object') {
    c.textos = {};
    for (const e of Object.keys(b.textos)) {
      if (!TEXTOS_PADRAO[e] || !Array.isArray(b.textos[e])) continue;
      c.textos[e] = b.textos[e].map((t: any, i: number) => ({ dia: Math.max(0, Number(t.dia) || TEXTOS_PADRAO[e][i]?.dia || 1), texto: String(t.texto || '').slice(0, 1000), depois: TEXTOS_PADRAO[e][i]?.depois }))
        .filter((t: any) => t.texto.trim());
    }
  }
  if (b.restaurarTextos === true) c.textos = TEXTOS_PADRAO;
  res.json({ ok: true, config: salvarConfigFollowup(c, (req as any).usuario?.login || 'painel') });
});

commandRouter.get('/vendas/placar', async (_req, res) => {
  const { getDb } = await import('../memory/db');
  const linhas = getDb().prepare("SELECT tipo, contexto, texto_original, texto_final FROM treinamento WHERE tipo IN ('vendas','vendas_descartado')").all() as any[];
  const grupos: Record<string, { produto: string; etapa: string; total: number; semEdicao: number; editados: number; descartados: number }> = {};
  for (const l of linhas) {
    let c: any = {}; try { c = JSON.parse(l.contexto || '{}'); } catch { /* */ }
    const k = (c.produto || 'sem produto') + '|' + (c.etapaAtual || '—');
    const g = grupos[k] ||= { produto: c.produto || 'sem produto', etapa: c.etapaAtual || '—', total: 0, semEdicao: 0, editados: 0, descartados: 0 };
    g.total++;
    if (l.tipo === 'vendas_descartado') g.descartados++;
    else if ((l.texto_original || '').trim() === (l.texto_final || '').trim()) g.semEdicao++;
    else g.editados++;
  }
  const lista = Object.values(grupos).map(g => ({ ...g, taxaSemEdicao: g.total ? Math.round(g.semEdicao / g.total * 100) : 0 }));
  const tot = lista.reduce((a, g) => ({ total: a.total + g.total, semEdicao: a.semEdicao + g.semEdicao }), { total: 0, semEdicao: 0 });
  res.json({ referencia: '90% sem edição em 50 rascunhos do produto', total: tot.total, taxaSemEdicao: tot.total ? Math.round(tot.semEdicao / tot.total * 100) : 0, porProdutoEtapa: lista });
});

commandRouter.get('/custo-ia', async (_req, res) => {
  const { usoIAPorDia } = await import('../memory/db');
  const { custoEstimado, modeloDa } = await import('../ia');
  const linhas = usoIAPorDia(30).map(l => ({ ...l, custoUSD: Number(custoEstimado(l.modelo, l.entrada, l.saida, l.cache_leitura, l.cache_escrita).toFixed(4)) }));
  res.json({ modelos: { rapido: modeloDa('rapido'), resposta: modeloDa('resposta') }, totalUSD: Number(linhas.reduce((t, l) => t + l.custoUSD, 0).toFixed(2)), linhas });
});

commandRouter.get('/envios-perdidos', (_req, res) => {
  res.json({
    perdidos: listarEnviosFila(['falhou']),
    naFila: listarEnviosFila(['pendente']),
    semConfirmacao: listarConfirmacoes(['sem_confirmacao', 'erro_trello'], 50),
    total: contarEnviosPerdidos() + listarConfirmacoes(['sem_confirmacao', 'erro_trello'], 1000).length,
  });
});

commandRouter.post('/envios-perdidos/reenviar-todos', (_req, res) => {
  // Devolve todos à fila; a verificação periódica reenvia com intervalo entre eles
  res.json({ ok: true, reagendados: reagendarTodosEnviosPerdidos() });
});

commandRouter.post('/envios-perdidos/:id/reenviar', async (req: Request, res: Response) => {
  const envio = getEnvioFila(Number(req.params.id));
  if (!envio || envio.status !== 'falhou') return res.status(404).json({ error: 'envio não encontrado' });
  if (sistemaPausado() || modoCalibragem()) return res.status(409).json({ error: 'secretária pausada ou em calibragem' });
  const ok = await reenviarAgora(envio);
  res.json({ ok });
});

commandRouter.post('/envios-perdidos/:id/descartar', (req: Request, res: Response) => {
  res.json({ ok: descartarEnvio(Number(req.params.id)) });
});
