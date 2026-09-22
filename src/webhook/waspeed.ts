import { Router, Request, Response } from 'express';
import { handleIncomingMessage } from '../flow/orchestrator';
import { detectAppointment } from '../flow/appointmentDetector';

export const webhookRouter = Router();

// Número do agendador eletrônico — nunca tratado como cliente (normalizado, ver normalizePhone)
const AGENDADOR_PHONE = process.env.AGENDADOR_PHONE || '554488596158';

// Tipos que representam uma mensagem escrita/gravada por uma pessoa. Qualquer
// outro tipo vindo do WhatsApp é aviso de sistema e não deve virar atendimento.
const TIPOS_DE_MENSAGEM_REAL = new Set([
  'chat', 'text', 'image', 'video', 'audio', 'ptt',
  'document', 'sticker', 'location', 'vcard', 'multi_vcard',
]);

// Uma legenda de foto é curta; um texto longo formado só por caracteres de base64
// é o arquivo, não algo que alguém digitou.
function descartarConteudoBinario(texto: string): string {
  if (texto.length > 300 && /^[A-Za-z0-9+/=\s]+$/.test(texto)) return '';
  return texto;
}

// Processamento serializado por contato: duas mensagens do mesmo cliente chegando
// juntas (ex.: duas fotos seguidas) rodavam em paralelo e duplicavam avisos e
// rascunhos. Cada telefone agora tem uma fila própria; contatos diferentes
// continuam sendo atendidos em paralelo normalmente.
const filasPorContato = new Map<string, Promise<void>>();

function enfileirarPorContato(phone: string, tarefa: () => Promise<void>): Promise<void> {
  const anterior = filasPorContato.get(phone) || Promise.resolve();
  const atual = anterior.then(tarefa, tarefa).catch(err => {
    console.error('[webhook] erro ao processar mensagem de', phone, err);
  });
  filasPorContato.set(phone, atual);
  atual.finally(() => {
    if (filasPorContato.get(phone) === atual) filasPorContato.delete(phone);
  });
  return atual;
}

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

    // O Waspeed entrega o mesmo evento mais de uma vez. Sem esta trava, cada
    // entrega repetida virava um atendimento novo e o cliente recebia a mesma
    // resposta duas vezes. Descarta tudo que já tenha sido processado antes.
    const eventId: string = det.id?._serialized || det.id?.id || '';
    if (eventId) {
      const { registrarEventoNovo } = await import('../memory/db');
      if (!registrarEventoNovo(eventId)) {
        console.log('[webhook] ignorado — evento repetido pelo Waspeed:', eventId);
        return;
      }
    }

    const from: string = payload.number || det.from || '';
    // Em mídia, o Waspeed coloca o arquivo inteiro em base64 no campo body. Sem esse
    // filtro o blob era gravado no histórico como se fosse o texto da mensagem: inchava
    // o banco, aparecia no painel e estourava o limite de tokens das chamadas de IA
    // ("prompt is too long: 258530 tokens"), derrubando resumos e verificações.
    const body: string = descartarConteudoBinario(last.text || det.body || '');
    const mediaUrl: string | undefined = det.mediaUrl || det.url || undefined;
    const messageType: string = det.type || last.type || 'chat';
    const fromMe: boolean = !!(det.id?.fromMe || det.fromMe);
    const isGroup: boolean = from.includes('@g.us') || String(from).includes('-');
    const waName: string = String(payload.name || det.notifyName || '').trim();

    if (!from) return;

    // Só processa tipos que são mensagem de verdade. O WhatsApp manda pelo mesmo
    // eventID vários avisos de sistema — troca de código de segurança
    // (e2e_notification), entrada/saída de grupo, registro de chamada, mensagem
    // apagada — e alguns vêm com um identificador interno no campo body (ex.:
    // "79281371742286@lid"), o que os fazia passar pela checagem de conteúdo e
    // serem tratados como se o cliente tivesse escrito algo. Lista branca é o
    // caminho seguro: tipo desconhecido não vira conversa.
    if (!TIPOS_DE_MENSAGEM_REAL.has(messageType)) {
      console.log('[webhook] ignorado — evento de sistema, não é mensagem:', messageType, '|', from);
      return;
    }

    // Ignora Status/Stories do WhatsApp — nunca é uma conversa real com um cliente,
    // mesmo quando tem texto (ex: legenda de um Status de terceiros)
    if (from === 'status' || from.startsWith('status@')) {
      console.log('[webhook] ignorado — Status/Story do WhatsApp:', from);
      return;
    }

    // Grupos: só respondem se o Wesley ativou explicitamente pelo painel (Grupos).
    // Por padrão só registra silenciosamente, sem processar nem poluir o log.
    if (isGroup) {
      const { upsertGroupSeen, isGroupActive } = await import('../memory/db');
      upsertGroupSeen(from, waName);

      if (!isGroupActive(from)) {
        await handleGroupMessage(from, req.app.locals.io);
        return;
      }

      if (fromMe) return; // não reage às próprias mensagens do Wesley no grupo

      // Grupo ativado: processa a mensagem normalmente, usando o ID do grupo como "telefone"
      let base64rawGrupo: string | undefined = det.base64 || det.data || det.file || det.media || last.base64 || undefined;
      if (base64rawGrupo?.startsWith('data:')) base64rawGrupo = base64rawGrupo.split(',')[1];
      const temConteudoGrupo = !!(body?.trim() || base64rawGrupo || mediaUrl);
      if (!temConteudoGrupo) return;

      console.log('[webhook] mensagem em grupo ATIVADO:', from, '| body:', body.slice(0, 80));
      await enfileirarPorContato(from, () => handleIncomingMessage({
        phone: from,
        body,
        mediaUrl,
        messageType,
        waName,
        base64: base64rawGrupo,
        filename: det.filename || det.caption || undefined,
        mimetype: det.mimetype || det.mimeType || undefined,
        io: req.app.locals.io,
      }));
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

    // Mensagens enviadas por Wesley diretamente pelo WhatsApp (fora do painel): registra
    // como resposta do staff (para o cron de "não respondidos" saber que já foi respondido)
    // e detecta agendamentos, mas não processa pelo pipeline de IA
    if (fromMe) {
      const { getSession, saveMessage } = await import('../memory/db');
      const { isEcoDeEnvioProprio } = await import('../responder/send');
      const session = getSession(phone);
      // O WhatsApp devolve como "fromMe" também as mensagens que a própria Iara
      // enviou. Gravá-las como fala do Wesley duplicaria o histórico e faria o
      // sistema acreditar que o cliente já foi atendido por uma pessoa.
      if (body?.trim() && !isEcoDeEnvioProprio(phone, body)) {
        saveMessage(phone, 'wesley', body);
        req.app.locals.io?.emit('message', { phone, role: 'wesley', body, timestamp: Date.now() });
      }
      detectAppointment(phone, body, session?.name, req.app.locals.io).catch(() => {});
      return;
    }

    await enfileirarPorContato(phone, () => handleIncomingMessage({
      phone,
      body,
      mediaUrl,
      messageType,
      waName,
      base64,
      filename,
      mimetype,
      io: req.app.locals.io,
    }));
  } catch (err) {
    console.error('[webhook] erro:', err);
  }
});

// Grupo ainda não ativado: só emite alerta na primeira vez que o painel o vê
const gruposAlertados = new Set<string>();
async function handleGroupMessage(groupId: string, io: any) {
  if (gruposAlertados.has(groupId)) return;
  gruposAlertados.add(groupId);
  io?.emit('new_group', { groupId, message: `Novo grupo detectado. Ative pelo painel (Grupos) se quiser que a Iara responda aqui.` });
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
