import { io as getIo } from '../server';
import { getSession, upsertSession, saveMessage, isBlacklisted, getContactInstruction } from '../memory/db';
import { classifyContact, ClassificationType } from '../classifier/groq';
import { lookupSheets } from '../lookup/sheets';
import { lookupTrello } from '../lookup/trello';
import { draftResponse } from '../responder/claude';
import { sendMessage, createNote } from '../responder/send';
import { savePendingApproval } from '../memory/db';
import { consultarDjen } from '../integrations/djen';
import { buscarCardTrello, criarCardLead } from '../integrations/trello';
import { aplicarGlossario, SAUDACAO, MSG_FORA_HORARIO, MSG_URGENCIA_AGUARDAR, HORARIO_ATENDIMENTO } from '../persona';
import { transcribeAudio } from '../classifier/groq';

interface IncomingMessage {
  phone: string;
  body: string;
  mediaUrl?: string;
  messageType?: string;
  io: any;
}

export async function handleIncomingMessage(msg: IncomingMessage): Promise<void> {
  const { phone, body, mediaUrl, messageType, io } = msg;

  try {
    // 1. Blacklist
    if (isBlacklisted(phone)) return;

    // 2. Verifica horário de atendimento
    if (!isWithinBusinessHours()) {
      await sendMessage(phone, MSG_FORA_HORARIO);
      saveMessage(phone, 'iara', MSG_FORA_HORARIO);
      io?.emit('message', { phone, role: 'iara', body: MSG_FORA_HORARIO, timestamp: Date.now() });
      return;
    }

    // 3. Sessão existente
    const session = getSession(phone);

    // Se em takeover, apenas notifica o painel
    if (session?.status === 'takeover') {
      saveMessage(phone, 'client', body);
      io?.emit('message', { phone, role: 'client', body, timestamp: Date.now(), takeover: true });
      return;
    }

    // Se pausado, ignora
    if (session?.status === 'pausado') return;

    // 4. Transcreve áudio se necessário
    let textBody = body;
    if (messageType === 'audio' || messageType === 'ptt') {
      if (mediaUrl) {
        textBody = await transcribeAudio(mediaUrl);
        io?.emit('transcription', { phone, original: mediaUrl, transcribed: textBody });
      } else {
        textBody = '[Áudio não transcrito — sem URL de mídia]';
      }
    }

    // 5. Detecta múltiplas mensagens rápidas (debounce simples)
    saveMessage(phone, 'client', textBody, mediaUrl);
    io?.emit('message', { phone, role: 'client', body: textBody, mediaUrl, timestamp: Date.now() });

    // 6. Detecta urgência pelo conteúdo
    const urgencyKeywords = ['urgente', 'urgência', 'preso', 'presa', 'mandado', 'busca e apreensão', 'acidente', 'socorro', 'emergência'];
    const isUrgent = urgencyKeywords.some(k => textBody.toLowerCase().includes(k));
    if (isUrgent) {
      io?.emit('urgent_alert', { phone, body: textBody, timestamp: Date.now() });
      await sendMessage(phone, MSG_URGENCIA_AGUARDAR);
      saveMessage(phone, 'iara', MSG_URGENCIA_AGUARDAR);
      io?.emit('message', { phone, role: 'iara', body: MSG_URGENCIA_AGUARDAR, timestamp: Date.now() });
      return;
    }

    // 7. Detecta pedido para falar com advogado
    const pedidoAdvogado = /(falar|fala|quero|preciso).*(advogado|doutor|dr|wesley)/i.test(textBody);

    // 8. Lookup de identidade
    const sheetsContact = await lookupSheets(phone);
    const trelloContact = sheetsContact ? null : await lookupTrello(phone);
    const contact = sheetsContact || trelloContact;

    // Instrução específica para este contato
    const customInstruction = getContactInstruction(phone);

    // 9. Classificação via Groq
    const classification = await classifyContact({
      phone,
      found: !!contact,
      name: contact?.name,
      processes: contact?.processes,
      messageText: textBody,
      customInstruction,
    });

    // Atualiza sessão
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

    // 10. Primeira mensagem do dia → saudação (se não tem sessão ativa)
    const isFirstMessage = !session;
    if (isFirstMessage && classification.type !== 'PROCESSO_ATIVO') {
      await deliverOrQueue(phone, SAUDACAO, 'saudação inicial', io);
      return;
    }

    // 11. Resposta por tipo
    let draft = '';
    let context = '';

    if (pedidoAdvogado) {
      draft = 'Vou comunicar ao Dr. Wesley sua solicitação. Ele retornará assim que possível.';
      io?.emit('alert', { phone, type: 'pedido_advogado', message: `${contact?.name || phone} pediu para falar com o Dr. Wesley` });
    } else {
      switch (classification.type as ClassificationType) {
        case 'PROCESSO_ATIVO': {
          const djenData = contact?.processes?.length
            ? await consultarDjen(contact.processes[0])
            : null;
          const trelloCard = contact?.processes?.length
            ? await buscarCardTrello(contact.processes[0])
            : null;

          context = JSON.stringify({ contact, djen: djenData, trello: trelloCard, customInstruction });
          draft = await draftResponse(classification.type, textBody, context);
          break;
        }

        case 'NOVO_CASO_CLIENTE_ANTIGO': {
          context = JSON.stringify({ contact, intent: classification.intent, customInstruction });
          draft = await draftResponse(classification.type, textBody, context);
          // Cria card no Trello Vendas e Leads
          await criarCardLead({
            name: contact?.name || phone,
            phone,
            summary: classification.intent,
            type: 'NOVO_CASO_CLIENTE_ANTIGO',
          });
          io?.emit('alert', { phone, type: 'novo_caso', message: `Novo caso de cliente antigo: ${contact?.name || phone}` });
          break;
        }

        case 'LEAD_NOVO': {
          context = JSON.stringify({ phone, intent: classification.intent, customInstruction });
          draft = await draftResponse(classification.type, textBody, context);
          await criarCardLead({
            name: phone,
            phone,
            summary: classification.intent,
            type: 'LEAD_NOVO',
          });
          io?.emit('alert', { phone, type: 'lead_novo', message: `Novo lead: ${phone} — ${classification.intent}` });
          break;
        }

        case 'AMIGO_PESSOAL': {
          draft = 'Oi! Aqui é a Iara Secretária do Doutor Wesley. Pelo que vi o assunto não é sobre questões jurídicas né rsrs, se eu estiver errada, me corrija. Wesley está em atendimento agora, mas vou repassar a mensagem pra ele pra te retornar.';
          io?.emit('alert', { phone, type: 'amigo', message: `Mensagem pessoal de ${contact?.name || phone}`, priority: 'low' });
          break;
        }

        case 'NEGOCIO_PARTICULAR':
        case 'INSTITUCIONAL': {
          context = JSON.stringify({ contact, type: classification.type, intent: classification.intent, customInstruction });
          draft = await draftResponse(classification.type, textBody, context);
          const priority = classification.type === 'INSTITUCIONAL' ? 'high' : 'medium';
          io?.emit('alert', { phone, type: classification.type.toLowerCase(), message: `${classification.type}: ${contact?.name || phone}`, priority });
          break;
        }

        default: {
          draft = SAUDACAO;
          io?.emit('alert', { phone, type: 'desconhecido', message: `Contato desconhecido: ${phone}` });
        }
      }
    }

    if (draft) {
      draft = aplicarGlossario(draft);
      await deliverOrQueue(phone, draft, context, io);
    }

  } catch (err) {
    console.error('[orchestrator] erro ao processar mensagem:', err);
    msg.io?.emit('error', { phone, error: String(err) });
  }
}

async function deliverOrQueue(phone: string, draft: string, context: string, io: any) {
  const modoTreino = process.env.MODO_TREINO === 'true';

  if (modoTreino) {
    // Enfileira para aprovação de Wesley no painel
    const id = savePendingApproval(phone, draft, context);
    io?.emit('pending_approval', { id, phone, draft, context, timestamp: Date.now() });
    console.log(`[treino] resposta enfileirada para aprovação — ${phone}`);
  } else {
    await sendMessage(phone, draft);
    saveMessage(phone, 'iara', draft);
    io?.emit('message', { phone, role: 'iara', body: draft, timestamp: Date.now() });
  }
}

function isWithinBusinessHours(): boolean {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: process.env.TZ_APP || 'America/Sao_Paulo' }));
  const day = now.getDay(); // 0=dom, 1=seg, ..., 6=sab
  const hour = now.getHours();

  if (day === 0) return false; // domingo: fechado
  if (day === 6) return hour >= HORARIO_ATENDIMENTO.sabado.inicio && hour < HORARIO_ATENDIMENTO.sabado.fim;
  return hour >= HORARIO_ATENDIMENTO.semana.inicio && hour < HORARIO_ATENDIMENTO.semana.fim;
}
