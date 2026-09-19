import { io as getIo } from '../server';
import { getSession, upsertSession, saveMessage, isBlacklisted, getContactInstruction, cancelFollowUpsOnReply, getSetting } from '../memory/db';
import { classifyContact, ClassificationType } from '../classifier/groq';
import { lookupSheets } from '../lookup/sheets';
import { lookupTrello } from '../lookup/trello';
import { draftResponse } from '../responder/claude';
import { sendMessage, createNote } from '../responder/send';
import { savePendingApproval } from '../memory/db';
import { consultarDjen } from '../integrations/djen';
import { buscarCardTrello, criarCardLead } from '../integrations/trello';
import {
  aplicarGlossario, SAUDACAO, MSG_FORA_HORARIO, MSG_URGENCIA_AGUARDAR,
  MSG_PEDIR_ADVOGADO, MSG_RECUSA_SECRETARIA, MSG_AMIGO, HORARIO_ATENDIMENTO,
  detectarGenero, type Genero,
} from '../persona';
import { transcribeAudio } from '../classifier/groq';
import { detectAppointment } from './appointmentDetector';

interface IncomingMessage {
  phone: string;
  body: string;
  mediaUrl?: string;
  messageType?: string;
  io: any;
}

// Padrões de encerramento — não gera resposta se o cliente claramente encerrou
const ENCERRAMENTOS_RE = [
  /^ok[\s!.]*$/i,
  /^certo[\s!.]*$/i,
  /^entendido[\s!.]*$/i,
  /^combinado[\s!.]*$/i,
  /^perfeito[\s!.]*$/i,
  /^tudo\s*bem[\s!.]*$/i,
  /^tudo\s*(certo|ok|ótimo)[\s!.]*$/i,
  /^tá\s*(bem|bom|ótimo|certo|ok)[\s!.]*$/i,
  /^pode\s*ser[\s!.]*$/i,
  /^(muito\s+)?obrigad[oa][\s!.,]*$/i,
  /^(muito\s+)?obrigad[oa],?\s*(dr\.?\s*wesley|iara|doutor)?[\s!.]*$/i,
  /^valeu[\s!.]*$/i,
  /^até\s*(mais|logo|breve|amanhã|depois)[\s!.]*$/i,
  /^(um\s+)?abraço[\s!.]*$/i,
  /^boa\s*(noite|tarde|semana)[\s!.]*$/i,
  /^bom\s*(dia|fim\s*de\s*semana)[\s!.]*$/i,
  /^flw[\s!.]*$/i,
  /^👍[\s!.]*$/,
];

function isEncerramento(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return ENCERRAMENTOS_RE.some(re => re.test(t));
}

// Palavras-chave de reclamação para gerar alerta prioritário
const RECLAMACAO_KEYWORDS = [
  'insatisfeito', 'insatisfeita', 'insatisfação', 'reclamação', 'reclamar',
  'indignado', 'indignada', 'absurdo', 'inadmissível', 'vergonha',
  'não anda', 'não andou', 'parado', 'sem notícias', 'sem informação',
  'meses sem', 'abandonado', 'abandonaram', 'descaso', 'negligência',
  'vou processar', 'vou reclamar', 'oab', 'denúncia',
];

export async function handleIncomingMessage(msg: IncomingMessage): Promise<void> {
  const { phone, io } = msg;
  let { body, mediaUrl, messageType } = msg;

  try {
    // 1. Blacklist
    if (isBlacklisted(phone)) return;

    // 2. Cancela follow-ups com condição 'reply' ao receber resposta do cliente
    cancelFollowUpsOnReply(phone);

    // 3. Sessão existente
    const session = getSession(phone);

    if (session?.status === 'takeover') {
      saveMessage(phone, 'client', body);
      io?.emit('message', { phone, role: 'client', body, timestamp: Date.now(), takeover: true });
      return;
    }

    if (session?.status === 'pausado') return;

    // 4. Transcreve áudio se necessário (antes de salvar)
    let textBody = body;
    if (messageType === 'audio' || messageType === 'ptt') {
      if (mediaUrl) {
        textBody = await transcribeAudio(mediaUrl);
        io?.emit('transcription', { phone, original: mediaUrl, transcribed: textBody });
      } else {
        textBody = '[Áudio recebido — sem URL de mídia]';
      }
    }

    // 5. SEMPRE salva a mensagem do cliente e emite para o painel
    saveMessage(phone, 'client', textBody, mediaUrl);
    io?.emit('message', { phone, role: 'client', body: textBody, mediaUrl, timestamp: Date.now() });

    // 5a. Detecta gênero — pelo texto da mensagem e pelo nome já salvo na sessão
    const genero: Genero = detectarGenero(textBody, session?.name);

    // 6. Modo ausência (Wesley em férias / feriado)
    const ausenciaMsg = getSetting('ausencia_msg');
    if (ausenciaMsg) {
      await sendMessage(phone, ausenciaMsg);
      saveMessage(phone, 'iara', ausenciaMsg);
      io?.emit('message', { phone, role: 'iara', body: ausenciaMsg, timestamp: Date.now() });
      return;
    }

    // 7. Verifica horário de atendimento
    if (!isWithinBusinessHours()) {
      await sendMessage(phone, MSG_FORA_HORARIO);
      saveMessage(phone, 'iara', MSG_FORA_HORARIO);
      io?.emit('message', { phone, role: 'iara', body: MSG_FORA_HORARIO, timestamp: Date.now() });
      return;
    }

    // 8. Detecta urgência
    const urgencyKeywords = ['urgente', 'urgência', 'preso', 'presa', 'mandado', 'busca e apreensão', 'acidente', 'socorro', 'emergência'];
    const isUrgent = urgencyKeywords.some(k => textBody.toLowerCase().includes(k));
    if (isUrgent) {
      io?.emit('urgent_alert', { phone, body: textBody, timestamp: Date.now() });
      await sendMessage(phone, MSG_URGENCIA_AGUARDAR);
      saveMessage(phone, 'iara', MSG_URGENCIA_AGUARDAR);
      io?.emit('message', { phone, role: 'iara', body: MSG_URGENCIA_AGUARDAR, timestamp: Date.now() });
      return;
    }

    // 9. Detecta reclamação e alerta Wesley com prioridade
    const isReclamacao = RECLAMACAO_KEYWORDS.some(k => textBody.toLowerCase().includes(k));
    if (isReclamacao) {
      io?.emit('alert', {
        phone,
        type: 'RECLAMAÇÃO',
        message: `⚠️ Cliente insatisfeito: ${session?.name || phone} — "${textBody.slice(0, 80)}..."`,
        priority: 'high',
      });
    }

    // 10. Encerramento — cliente não está aguardando resposta
    if (isEncerramento(textBody)) {
      console.log(`[orchestrator] encerramento detectado — sem resposta para ${phone}: "${textBody}"`);
      return;
    }

    // 11. Lookup de identidade (antes das checagens que usam contact?.name)
    const sheetsContact = await lookupSheets(phone);
    const trelloContact = sheetsContact ? null : await lookupTrello(phone);
    const contact = sheetsContact || trelloContact;

    const customInstruction = getContactInstruction(phone);

    // 12. Detecta recusa à secretária / pedido para falar com advogado
    const recusaSecretaria = /(não\s+quero|recuso|não\s+aceito).*(secretár|robô|bot|ia\b|inteligência)/i.test(textBody);
    const pedidoAdvogado = /(falar|fala|quero|preciso|chama|passa).*(advogado|doutor|dr\.?|wesley)/i.test(textBody);

    if (recusaSecretaria || pedidoAdvogado) {
      const msgResposta = recusaSecretaria ? MSG_RECUSA_SECRETARIA(genero) : MSG_PEDIR_ADVOGADO;
      io?.emit('alert', {
        phone,
        type: 'pedido_advogado',
        message: `${contact?.name || phone} ${recusaSecretaria ? 'recusou a secretária e' : ''} pediu para falar com o Dr. Wesley`,
      });
      await deliverOrQueue(phone, msgResposta, 'pedido_advogado', io, contact?.name);
      return;
    }

    // 13. Classificação via Claude Haiku
    const classification = await classifyContact({
      phone,
      found: !!contact,
      name: contact?.name,
      processes: contact?.processes,
      messageText: textBody,
      customInstruction,
    });

    upsertSession(phone, {
      name: contact?.name || session?.name || 'Desconhecido',
      type: classification.type,
      status: 'ativo',
    });

    io?.emit('session_update', {
      phone,
      name: contact?.name || 'Desconhecido',
      type: classification.type,
      processes: contact?.processes,
      timestamp: Date.now(),
    });

    // Refina gênero com o nome obtido no lookup (mais preciso que só a sessão)
    const generoFinal: Genero = detectarGenero(textBody, contact?.name || session?.name);

    const isFirstMessage = !session;
    if (isFirstMessage && classification.type !== 'PROCESSO_ATIVO') {
      await deliverOrQueue(phone, SAUDACAO(generoFinal), 'saudação inicial', io, contact?.name || 'Desconhecido');
      return;
    }

    let draft = '';
    let context = '';

    switch (classification.type as ClassificationType) {
        case 'PROCESSO_ATIVO': {
          const djenData = contact?.processes?.length ? await consultarDjen(contact.processes[0]) : null;
          const trelloCard = contact?.processes?.length ? await buscarCardTrello(contact.processes[0]) : null;
          context = JSON.stringify({ contact, djen: djenData, trello: trelloCard, customInstruction });
          draft = await draftResponse(classification.type, textBody, context, generoFinal);
          break;
        }
        case 'NOVO_CASO_CLIENTE_ANTIGO': {
          context = JSON.stringify({ contact, intent: classification.intent, customInstruction });
          draft = await draftResponse(classification.type, textBody, context, generoFinal);
          await criarCardLead({ name: contact?.name || phone, phone, summary: classification.intent, type: 'NOVO_CASO_CLIENTE_ANTIGO' });
          io?.emit('alert', { phone, type: 'novo_caso', message: `Novo caso de cliente antigo: ${contact?.name || phone}` });
          break;
        }
        case 'LEAD_NOVO': {
          context = JSON.stringify({ phone, intent: classification.intent, customInstruction });
          draft = await draftResponse(classification.type, textBody, context, generoFinal);
          await criarCardLead({ name: phone, phone, summary: classification.intent, type: 'LEAD_NOVO' });
          io?.emit('alert', { phone, type: 'lead_novo', message: `Novo lead: ${phone} — ${classification.intent}` });
          break;
        }
        case 'AMIGO_PESSOAL': {
          draft = MSG_AMIGO;
          io?.emit('alert', { phone, type: 'amigo', message: `Mensagem pessoal de ${contact?.name || phone}`, priority: 'low' });
          break;
        }
        case 'NEGOCIO_PARTICULAR':
        case 'INSTITUCIONAL': {
          context = JSON.stringify({ contact, type: classification.type, intent: classification.intent, customInstruction });
          draft = await draftResponse(classification.type, textBody, context, generoFinal);
          const priority = classification.type === 'INSTITUCIONAL' ? 'high' : 'medium';
          io?.emit('alert', { phone, type: classification.type.toLowerCase(), message: `${classification.type}: ${contact?.name || phone}`, priority });
          break;
        }
        default: {
          draft = SAUDACAO(generoFinal);
          io?.emit('alert', { phone, type: 'desconhecido', message: `Contato desconhecido: ${phone}` });
        }
    }

    if (draft) {
      draft = aplicarGlossario(draft);
      await deliverOrQueue(phone, draft, context, io, contact?.name || session?.name);
    }

  } catch (err) {
    console.error('[orchestrator] erro ao processar mensagem:', err);
    msg.io?.emit('error', { phone, error: String(err) });
  }
}

async function deliverOrQueue(phone: string, draft: string, context: string, io: any, contactName?: string) {
  const modoTreino = process.env.MODO_TREINO === 'true';

  if (modoTreino) {
    const id = savePendingApproval(phone, draft, context);
    io?.emit('pending_approval', { id, phone, draft, context, timestamp: Date.now() });
    console.log(`[treino] resposta enfileirada para aprovação — ${phone}`);
  } else {
    await sendMessage(phone, draft);
    saveMessage(phone, 'iara', draft);
    io?.emit('message', { phone, role: 'iara', body: draft, timestamp: Date.now() });
    // Só detecta agendamento em mensagens realmente enviadas (não em rascunhos de treino)
    detectAppointment(phone, draft, contactName, io).catch(() => {});
  }
}

function isWithinBusinessHours(): boolean {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: process.env.TZ_APP || 'America/Sao_Paulo' }));
  const day = now.getDay();
  const hour = now.getHours();
  if (day === 0) return false;
  if (day === 6) return hour >= HORARIO_ATENDIMENTO.sabado.inicio && hour < HORARIO_ATENDIMENTO.sabado.fim;
  return hour >= HORARIO_ATENDIMENTO.semana.inicio && hour < HORARIO_ATENDIMENTO.semana.fim;
}
