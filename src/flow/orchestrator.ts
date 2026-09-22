import { io as getIo } from '../server';
import { getSession, upsertSession, saveMessage, isBlacklisted, getContactInstruction, cancelFollowUpsOnReply, getSetting, getHistory, getAusenciaNotice, marcarAusenciaPendente, reivindicarAusencia, liberarAusencia } from '../memory/db';
import { classifyContact, ClassificationType } from '../classifier/groq';
import { lookupSheets } from '../lookup/sheets';
import { lookupTrello } from '../lookup/trello';
import { draftResponse } from '../responder/claude';
import { sendMessage, createNote } from '../responder/send';
import { savePendingApproval } from '../memory/db';
import { consultarDjen } from '../integrations/djen';
import { buscarCardTrello, buscarCardPorNomes, criarCardLead } from '../integrations/trello';
import { saveDocument } from '../integrations/drive';
import {
  aplicarGlossario, SAUDACAO, MSG_FORA_HORARIO, MSG_URGENCIA_AGUARDAR,
  MSG_PEDIR_ADVOGADO, MSG_RECUSA_SECRETARIA, MSG_AMIGO, JANELA_AUSENCIA, HORARIO_ATENDIMENTO,
  MSG_EMAIL, MSG_PIX,
  MSG_PEDIR_DADOS_PROCESSO, detectarGenero, type Genero,
} from '../persona';
import { transcribeAudio } from '../classifier/groq';
import { detectAppointment } from './appointmentDetector';

interface IncomingMessage {
  phone: string;
  body: string;
  mediaUrl?: string;
  messageType?: string;
  waName?: string;
  base64?: string;
  filename?: string;
  mimetype?: string;
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

const CASE_TITLE_KEYWORDS = /processo|requerimento|apresentação|espólio|execução|embargos|ação\b|mandado|recurso|apelação|inventário|cumprimento de sentença|habilitação/i;

function isLikelyPersonName(name: string): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (trimmed.length > 60) return false;
  if (CASE_TITLE_KEYWORDS.test(trimmed)) return false;
  if (trimmed.includes(' - ') || trimmed.includes(' x ')) return false;
  if (/\d{4,}/.test(trimmed)) return false; // números longos (processo, CPF etc.)
  return true;
}

const NOME_PATTERNS = [
  /(?:meu\s+nome\s+é|me\s+chamo|sou\s+(?:o|a)\s|nome\s*[:\s]|parte\s*[:\s]|requerente\s*[:\s]|autor\s*[:\s])\s*([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)+)/i,
];
// Cobre tanto processo ("contra fulano", "réu é fulano") quanto contrato ("contrato com fulano")
const CONTRA_PARTE_PATTERNS = [
  /contra\s+(?:o\s+|a\s+)?([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)+)/i,
  /(?:réu|requerido|ré|requerida|parte\s+contrária|outra\s+parte)\s*(?:é|:)?\s*([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)+)/i,
  /contrato\s+com\s+(?:o\s+|a\s+)?([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)+)/i,
];
const PROCESSO_PATTERN = /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/;

function extrairDadosProcesso(phone: string, mensagemAtual: string): { nome: string; contraParte: string; numero: string } {
  const historico = getHistory(phone, 30)
    .filter((m: any) => m.role === 'client')
    .map((m: any) => m.body)
    .join('\n');
  const textoCompleto = `${historico}\n${mensagemAtual}`;

  let nome = '';
  for (const re of NOME_PATTERNS) {
    const m = textoCompleto.match(re);
    if (m) { nome = m[1].trim(); break; }
  }

  let contraParte = '';
  for (const re of CONTRA_PARTE_PATTERNS) {
    const m = textoCompleto.match(re);
    if (m) { contraParte = m[1].trim(); break; }
  }

  const numero = textoCompleto.match(PROCESSO_PATTERN)?.[0] || '';

  return { nome, contraParte, numero };
}

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
  const { phone, io, waName, base64, filename, mimetype } = msg;
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

    // 4. Transcreve áudio se necessário (antes de salvar). O Waspeed envia o áudio em
    // base64 (não como URL), então isso é priorizado sobre mediaUrl.
    let textBody = body;
    if (messageType === 'audio' || messageType === 'ptt') {
      if (base64) {
        const primeirosBytes = Buffer.from(base64.slice(0, 40), 'base64').toString('hex');
        console.log(`[orchestrator] áudio base64 recebido, tamanho: ${base64.length}, primeiros bytes (hex): ${primeirosBytes}`);
      }
      if (base64 || mediaUrl) {
        textBody = await transcribeAudio(mediaUrl, base64);
        io?.emit('transcription', { phone, original: mediaUrl || '[base64]', transcribed: textBody });
        console.log(`[orchestrator] áudio transcrito para ${phone}: "${textBody.slice(0, 100)}"`);
      } else {
        textBody = '[Áudio recebido — sem conteúdo disponível]';
      }
    }

    // 4b. Documento/imagem: o Waspeed envia o arquivo em base64 (não como URL).
    // Salva no Drive na pasta do cliente e usa o link do Drive como mídia exibida no painel.
    if (messageType === 'document' || messageType === 'image') {
      const nomeArquivo = filename || `${messageType === 'image' ? 'imagem' : 'documento'}_${Date.now()}`;
      if (base64) {
        try {
          const buffer = Buffer.from(base64, 'base64');
          const nomeCliente = getSession(phone)?.name || waName || phone;
          const driveLink = await saveDocument(phone, nomeCliente, nomeArquivo, buffer, mimetype || 'application/octet-stream');
          mediaUrl = driveLink || mediaUrl;
          textBody = body || `[Documento recebido: ${nomeArquivo}]`;
          console.log(`[orchestrator] documento salvo no Drive para ${phone}: ${nomeArquivo} -> ${driveLink || '(sem link retornado)'}`);
        } catch (err) {
          console.error('[orchestrator] erro ao salvar documento no Drive:', err);
          textBody = body || `[Documento recebido: ${nomeArquivo} — falha ao salvar no Drive]`;
        }
      } else {
        textBody = body || `[Documento recebido: ${nomeArquivo} — sem conteúdo]`;
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

    // 7. Aviso de ausência: só quando REALMENTE fora do horário comercial (08:30-17h, seg-sex).
    // No máximo 1x por dia por contato. Entre 22h-7h (fora da janela de ausência) fica
    // pendente e é entregue automaticamente quando ela reabrir às 7h (cron ausencia.ts).
    if (!isWithinBusinessHours()) {
      const hojeStr = new Date().toLocaleDateString('sv-SE', { timeZone: process.env.TZ_APP || 'America/Sao_Paulo' });
      const avisoAusencia = getAusenciaNotice(phone);
      if (avisoAusencia?.sent_date !== hojeStr) {
        if (isWithinAusenciaWindow()) {
          // Reivindica ANTES de enviar: se outra mensagem do mesmo contato estiver
          // sendo processada ao mesmo tempo, só uma delas ganha o direito de enviar
          if (reivindicarAusencia(phone, hojeStr)) {
            try {
              await sendMessage(phone, MSG_FORA_HORARIO);
              saveMessage(phone, 'iara', MSG_FORA_HORARIO);
              io?.emit('message', { phone, role: 'iara', body: MSG_FORA_HORARIO, timestamp: Date.now() });
            } catch (err) {
              liberarAusencia(phone);
              throw err;
            }
          }
        } else {
          marcarAusenciaPendente(phone);
        }
      }
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

    // 12b. E-mail e PIX: resposta fixa (não gerada por IA) para nunca inventar/errar o dado
    const pedidoPix = /\bpix\b/i.test(textBody);
    const pedidoEmail = !pedidoPix && /e-?mail/i.test(textBody);
    if (pedidoPix || pedidoEmail) {
      await deliverOrQueue(phone, pedidoPix ? MSG_PIX : MSG_EMAIL, pedidoPix ? 'pedido_pix' : 'pedido_email', io, contact?.name);
      return;
    }

    // Histórico da conversa (últimos 30 dias), usado tanto na classificação quanto na resposta,
    // para não perder o contexto do que já foi dito
    const historicoConversa = getHistory(phone, 30).map((m: any) => ({ role: m.role, body: m.body }));

    // 13. Classificação via Claude Haiku
    const classification = await classifyContact({
      phone,
      found: !!contact,
      name: contact?.name,
      processes: contact?.processes,
      messageText: textBody,
      customInstruction,
      historico: historicoConversa,
    });

    // Nome de exibição no painel: replica o que aparece no WhatsApp.
    // Prioridade: nome do WhatsApp (fresco a cada mensagem, é o que o cliente vê salvo/pushname) >
    // nome de sessão já validado anteriormente > nome de lookup (Trello/Sheets) só se parecer nome de pessoa >
    // número do telefone (nunca o título de um card do Trello)
    const lookupName = (contact as any)?.displayName || contact?.name || '';
    const candidatos = [waName, session?.name, lookupName];
    const displayName = candidatos.find(n => isLikelyPersonName(n || '')) || phone;

    upsertSession(phone, {
      name: displayName,
      type: classification.type,
      status: 'ativo',
    });

    io?.emit('session_update', {
      phone,
      name: displayName,
      type: classification.type,
      processes: contact?.processes,
      timestamp: Date.now(),
    });

    // Refina gênero com o nome obtido no lookup (mais preciso que só a sessão)
    const generoFinal: Genero = detectarGenero(textBody, displayName);

    // Saudação uma vez por dia (primeiro contato do dia). session.updated_at é um epoch
    // REAL (unixepoch() do SQLite), então o corte de "hoje" precisa ser um epoch real
    // também — não dá para comparar com um Date "fingindo" ser local em outro fuso
    // (Railway roda em UTC; Brasil é UTC-3 fixo, sem horário de verão desde 2019)
    const spNow = new Date(new Date().toLocaleString('en-US', { timeZone: process.env.TZ_APP || 'America/Sao_Paulo' }));
    const hoje = Math.floor(Date.UTC(spNow.getFullYear(), spNow.getMonth(), spNow.getDate(), 3, 0, 0) / 1000);
    const isFirstMessageToday = !session || !session.updated_at || session.updated_at < hoje;
    if (isFirstMessageToday) {
      await deliverOrQueue(phone, SAUDACAO(generoFinal), 'saudação inicial', io, displayName);
      if (!session) return; // primeiro contato absoluto: aguarda resposta antes de continuar
    }

    let draft = '';
    let context = '';

    switch (classification.type as ClassificationType) {
        case 'PROCESSO_ATIVO': {
          // Extrai dados mencionados em toda a conversa (não só na mensagem atual) para localizar o processo
          const dadosProcesso = extrairDadosProcesso(phone, textBody);
          const nomeMencionado = dadosProcesso.nome;
          const contraParteMencionada = dadosProcesso.contraParte;
          const processoMencionado = dadosProcesso.numero;

          const temNome = !!(contact?.name || nomeMencionado);
          const temContraParte = !!contraParteMencionada;
          const temProcesso = contact?.processes?.length || processoMencionado;
          const temDadosSuficientes = temProcesso || (temNome && temContraParte);

          if (!temDadosSuficientes) {
            // Mensagem fixa (não gerada por IA) para garantir a frase obrigatória exata
            draft = MSG_PEDIR_DADOS_PROCESSO(temNome);
            context = 'pedido_dados_processo';
            break;
          }

          let numBusca = processoMencionado || contact?.processes?.[0] || '';
          let trelloCard = numBusca ? await buscarCardTrello(numBusca) : null;

          // Sem número: tenta localizar o caso pelo nome da parte + parte contrária
          if (!trelloCard && temNome && temContraParte) {
            trelloCard = await buscarCardPorNomes(contact?.name || nomeMencionado, contraParteMencionada);
            if (trelloCard) {
              numBusca = (String(trelloCard.name || '') + ' ' + String(trelloCard.desc || '')).match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/)?.[0] || '';
            }
          }

          const djenData = numBusca ? await consultarDjen(numBusca) : null;
          context = JSON.stringify({ contact, djen: djenData, trello: trelloCard, nomeMencionado, contraParteMencionada, customInstruction });
          draft = await draftResponse(classification.type, textBody, context, generoFinal, historicoConversa);
          break;
        }
        case 'NOVO_CASO_CLIENTE_ANTIGO': {
          // Se o cliente mencionou nome da parte e da parte contrária, tenta localizar um caso
          // parecido no Trello (pode já existir e ainda não estar vinculado a este telefone)
          const dadosCaso = extrairDadosProcesso(phone, textBody);
          const nomeCasoMencionado = dadosCaso.nome || contact?.name || '';
          const contraParteCaso = dadosCaso.contraParte;
          let casoEncontrado = null;
          let djenCaso = null;
          if (nomeCasoMencionado && contraParteCaso) {
            casoEncontrado = await buscarCardPorNomes(nomeCasoMencionado, contraParteCaso);
            if (casoEncontrado) {
              const numCaso = (String(casoEncontrado.name || '') + ' ' + String(casoEncontrado.desc || '')).match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/)?.[0] || '';
              if (numCaso) djenCaso = await consultarDjen(numCaso);
            }
          }
          context = JSON.stringify({ contact, intent: classification.intent, trello: casoEncontrado, djen: djenCaso, customInstruction });
          draft = await draftResponse(classification.type, textBody, context, generoFinal, historicoConversa);
          await criarCardLead({ name: contact?.name || phone, phone, summary: classification.intent, type: 'NOVO_CASO_CLIENTE_ANTIGO' });
          io?.emit('alert', { phone, type: 'novo_caso', message: `Novo caso de cliente antigo: ${contact?.name || phone}` });
          break;
        }
        case 'LEAD_NOVO': {
          context = JSON.stringify({ phone, intent: classification.intent, customInstruction });
          draft = await draftResponse(classification.type, textBody, context, generoFinal, historicoConversa);
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
          draft = await draftResponse(classification.type, textBody, context, generoFinal, historicoConversa);
          const priority = classification.type === 'INSTITUCIONAL' ? 'high' : 'medium';
          io?.emit('alert', { phone, type: classification.type.toLowerCase(), message: `${classification.type}: ${contact?.name || phone}`, priority });
          break;
        }
        default: {
          // DESCONHECIDO: cobrança de prazo, reclamação de demora, agradecimento etc.
          // Nunca reenviar a saudação aqui — usa a IA com o histórico para responder com contexto.
          if (session) {
            context = JSON.stringify({ contact, intent: classification.intent, customInstruction });
            draft = await draftResponse('DESCONHECIDO', textBody, context, generoFinal, historicoConversa);
          } else {
            draft = SAUDACAO(generoFinal);
          }
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

// Horário comercial real: seg-sex, 08:30-17:00 — define QUANDO o aviso de ausência é necessário
function isWithinBusinessHours(): boolean {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: process.env.TZ_APP || 'America/Sao_Paulo' }));
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const totalMinutes = now.getHours() * 60 + now.getMinutes();
  const inicio = HORARIO_ATENDIMENTO.semana.inicio * 60 + HORARIO_ATENDIMENTO.semana.inicioMinuto;
  const fim = HORARIO_ATENDIMENTO.semana.fim * 60;
  return totalMinutes >= inicio && totalMinutes < fim;
}

// Janela de silêncio: 07h-22h, todos os dias — define QUANDO é permitido efetivamente
// transmitir o aviso de ausência (evita mandar mensagem de madrugada)
function isWithinAusenciaWindow(): boolean {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: process.env.TZ_APP || 'America/Sao_Paulo' }));
  const hora = now.getHours();
  return hora >= JANELA_AUSENCIA.inicio && hora < JANELA_AUSENCIA.fim;
}
