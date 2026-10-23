import Anthropic from '@anthropic-ai/sdk';
import { io as getIo } from '../server';
import { acumularNaJanela, janelasVencidas, removerJanela, getSession, upsertSession, saveMessage, isBlacklisted, getContactInstruction, cancelFollowUpsOnReply, getSetting, getHistory, jaEnviouTipo, registrarTipoEnviado, getAusenciaNotice, marcarAusenciaPendente, reivindicarAusencia, liberarAusencia, houveRespostaDeWesley, wesleyFoiOUltimoAResponder, temHistoricoAnterior } from '../memory/db';
import { classifyContact, ClassificationType } from '../classifier/groq';
import { lookupSheets } from '../lookup/sheets';
import { lookupTrello } from '../lookup/trello';
import { draftResponse } from '../responder/claude';
import { sendMessage, createNote, sistemaPausado, modoCalibragem } from '../responder/send';
import { savePendingApproval } from '../memory/db';
import { consultarDjen } from '../integrations/djen';
import { buscarCardTrello, buscarCardPorNomes, criarCardLead } from '../integrations/trello';
import { saveDocument } from '../integrations/drive';
import {
  aplicarGlossario, SAUDACAO, MSG_INICIAL_COM_ASSUNTO, MSG_FORA_HORARIO, MSG_URGENCIA_AGUARDAR,
  MSG_PEDIR_ADVOGADO, MSG_RECUSA_SECRETARIA, MSG_AMIGO, JANELA_AUSENCIA, HORARIO_ATENDIMENTO,
  MSG_EMAIL, MSG_PIX,
  MSG_PEDIR_DADOS_PROCESSO, detectarGenero, detectarGeneroComIA, type Genero,
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
  /^blz[\s!.]*$/i,
  /^beleza[\s!.]*$/i,
  /^show[\s!.]*$/i,
  /^ótimo[\s!.]*$/i,
  /^maravilha[\s!.]*$/i,
  /^excelente[\s!.]*$/i,
  /^(tá\s+)?bom[\s!.]*$/i,
  /^👍[\s!.]*$/,
  /^✅[\s!.]*$/,
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

    // Calcula o tempo de espera ANTES de salvar a mensagem, pois houveTrocaHoje
    // consultaria a própria mensagem que acabou de chegar e sempre retornaria true.
    // Usa a sessão como proxy: sem sessão = primeiro contato absoluto (30 min);
    // com sessão = cliente conhecido, pode ter conversa ativa (60 min).
    const minutosEsperaJanela = session ? JANELA_MIN_EM_ANDAMENTO : JANELA_MIN_PRIMEIRO_HOJE;

    // 5. SEMPRE salva a mensagem do cliente e emite para o painel
    saveMessage(phone, 'client', textBody, mediaUrl);
    io?.emit('message', { phone, role: 'client', body: textBody, mediaUrl, timestamp: Date.now() });

    // Em calibragem, as duas travas abaixo não valem: nelas o motivo para não
    // redigir é "seria uma resposta desperdiçada". Em calibragem a resposta É o
    // produto — é ela que se quer ver e corrigir — e não há risco, porque nenhum
    // envio sai (a trava do envio é outra, em responder/send.ts).
    const calibrando = modoCalibragem();

    // 5c. Secretária pausada pelo painel: não gera rascunho nem sugestão. Antes a
    // pausa só bloqueava o envio, e a fila de aprovação continuava enchendo com
    // respostas que nunca seriam usadas. A mensagem do cliente segue sendo salva
    // e exibida normalmente, acima.
    if (sistemaPausado() && !calibrando) {
      console.log(`[orchestrator] secretária pausada — nenhum rascunho gerado para ${phone}`);
      return;
    }

    // 5b. Wesley está/esteve nessa conversa: se a última resposta do escritório foi
    // dele (não da Iara), a conversa é dele — a Iara não entra independente do tempo.
    // Só verifica por conversa (não global): Wesley respondendo outro contato não
    // impede a Iara de atender clientes diferentes em paralelo.
    if (!calibrando && (wesleyFoiOUltimoAResponder(phone) || houveRespostaDeWesley(MINUTOS_ATIVIDADE_WESLEY, phone))) {
      console.log(`[orchestrator] Wesley atendendo ${phone} — nenhum rascunho gerado`);
      io?.emit('session_update', { phone, status: 'atendimento_wesley' });
      return;
    }

    // Janela de agrupamento: o cliente costuma mandar varias mensagens e audios
    // seguidos. Responder cada uma vira uma enxurrada de mensagens iguais e um
    // atendimento robotico. Aqui a mensagem so e registrada; a resposta sai uma
    // vez so, depois de alguns minutos de silencio dele, lendo o bloco inteiro.
    agendarResposta(phone, textBody, io, waName, minutosEsperaJanela);

  } catch (err) {
    console.error('[orchestrator] erro ao processar mensagem:', err);
    msg.io?.emit('error', { phone, error: String(err) });
  }
}

// Minutos de silêncio conforme contexto da conversa:
// - Primeiro contato do dia (sem troca prévia hoje): 30 min — mais calmo, cliente pode ainda estar digitando
// - Conversa em andamento hoje: 60 min — Wesley pode já ter respondido, Iara espera mais antes de intervir
const JANELA_MIN_PRIMEIRO_HOJE = parseInt(process.env.MINUTOS_AGRUPAMENTO_NOVO || '') || 30;
const JANELA_MIN_EM_ANDAMENTO  = parseInt(process.env.MINUTOS_AGRUPAMENTO_ATIVO || '') || 60;

function agendarResposta(phone: string, texto: string, _io: any, waName?: string, minutosEspera?: number) {
  const mins = minutosEspera ?? JANELA_MIN_PRIMEIRO_HOJE;
  acumularNaJanela(phone, texto, waName, mins);
  console.log(`[orchestrator] mensagem de ${phone} guardada; resposta apos ${mins} min de silencio`);
}

// Verificacao periodica: responde as conversas em que o cliente ja parou de
// falar. Fica em banco justamente para o reinicio do processo nao perder nada —
// ao subir, a primeira passagem recolhe as janelas que venceram durante a queda.

// Guarda para evitar que dois ciclos do setInterval se sobreponham: se o
// processamento de um ciclo demorar mais de 60s (IA lenta, fila grande),
// o próximo disparo do setInterval encontraria as mesmas janelas ainda abertas
// e chamaria responderConversa duas vezes para o mesmo contato.
let _processandoJanelas = false;

// Controla telefones em processamento ativo para evitar duplicação
// mesmo dentro de um único ciclo (ex: duas janelas do mesmo phone por bug).
const _processandoPhones = new Set<string>();

export async function processarJanelasVencidas(): Promise<void> {
  if (_processandoJanelas) {
    console.log('[orchestrator] ciclo anterior ainda em execução — pulando');
    return;
  }
  _processandoJanelas = true;

  try {
    let vencidas;
    try {
      vencidas = janelasVencidas();
    } catch (err) {
      console.error('[orchestrator] erro ao ler janelas vencidas:', err);
      return;
    }
    if (!vencidas.length) return;

    for (const j of vencidas) {
      if (_processandoPhones.has(j.phone)) {
        console.log(`[orchestrator] ${j.phone} já em processamento — ignorando duplicata`);
        continue;
      }
      _processandoPhones.add(j.phone);
      // Remove ANTES de responder: se a redacao falhar, a janela nao fica presa
      // repetindo a cada minuto
      removerJanela(j.phone);
      console.log(`[orchestrator] janela fechada para ${j.phone}`);
      await responderConversa(j.phone, j.textos || '', getIo, j.wa_name || undefined)
        .catch(err => console.error('[orchestrator] erro ao responder conversa agrupada:', err))
        .finally(() => _processandoPhones.delete(j.phone));
    }
  } finally {
    _processandoJanelas = false;
  }
}

// Responde UMA vez o bloco de mensagens acumulado na janela
async function responderConversa(phone: string, textBody: string, io: any, waName?: string) {
  try {
    const session = getSession(phone);
    const calibrando = modoCalibragem();

    // Verifica se Wesley é o dono desta conversa antes de qualquer ação:
    // - Se sua última mensagem nessa conversa é mais recente que a da Iara → conversa é dele
    // - Se ele respondeu este contato há menos de MINUTOS_ATIVIDADE_WESLEY → está atendendo ele
    // Check por conversa (não global): Wesley em outra conversa não bloqueia outros atendimentos.
    if (!calibrando && (wesleyFoiOUltimoAResponder(phone) || houveRespostaDeWesley(MINUTOS_ATIVIDADE_WESLEY, phone))) {
      console.log(`[orchestrator] janela expirou mas Wesley é o dono de ${phone} — nenhuma ação`);
      return;
    }

    // Silêncio é resposta válida: quando o cliente está apenas relatando,
    // mandando documentos ou confirmando algo, responder só gera ruído.
    // Em calibragem o filtro é desativado: o objetivo é ver o rascunho de
    // TODAS as conversas — inclusive as que Wesley já respondeu — para poder
    // comparar, corrigir e treinar a IA sem que nada chegue ao cliente.
    if (!calibrando && !(await precisaDeResposta(phone, textBody))) {
      console.log(`[orchestrator] ${phone} não pede resposta — nenhuma mensagem gerada`);
      return;
    }

    // Encerramento antes de qualquer resposta — vale para novos e existentes:
    // "Ok, obrigada", "Tudo bem", "Até mais" etc. não pedem resposta
    if (!calibrando && isEncerramento(textBody)) {
      console.log(`[orchestrator] encerramento detectado antes da saudação — sem resposta para ${phone}: "${textBody}"`);
      return;
    }

    // 5a. Detecta gênero — prioridade: salvo no banco → texto → nome → IA → neutro
    const genero: Genero = await detectarGeneroComIA(phone, textBody, session?.name, session?.genero);

    // 5b-saudação. Saudação inaugural: APENAS para contatos que NUNCA falaram com o escritório.
    // Fica aqui (e não em handleIncomingMessage) para que a janela de agrupamento de 30 min
    // seja respeitada — o cliente pode estar digitando várias mensagens seguidas antes de parar.
    // upsertSession é chamado AQUI para que na próxima mensagem session já exista e
    // a saudação não seja enviada de novo.
    if (!session && temHistoricoAnterior(phone)) {
      upsertSession(phone, { name: waName || phone, status: 'ativo' });
    } else if (!session) {
      upsertSession(phone, { name: waName || phone, status: 'ativo' });
      // Tenta detectar o assunto: primeiro por regex (rápido), depois por IA se ambíguo.
      // Só pergunta ao cliente quando nenhuma das análises consegue identificar o tema.
      const assuntoDetectado = primeiraMessagemComAssunto(textBody) || await detectarAssuntoComIA(textBody);
      const saudacao = assuntoDetectado ? MSG_INICIAL_COM_ASSUNTO(genero) : SAUDACAO(genero);
      await deliverOrQueue(phone, saudacao, 'saudação inicial', io, waName);
      registrarTipoEnviado(phone, 'saudacao');
      return;
    }

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
    if (!isWithinBusinessHours() && !wesleyAtendendoAgora(phone)) {
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
      // Fora do horário: não gera resposta de IA além do aviso de ausência
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

    // 12b. E-mail e PIX: resposta fixa (não gerada por IA) para nunca inventar/errar o dado.
    // Apenas dispara quando a mensagem pede explicitamente o dado — mencionar a palavra "email"
    // num contexto jurídico/narrativo (ex: "foi direcionado para o email dele") não deve acionar.
    // Só dispara quando o cliente está claramente pedindo o dado do escritório.
    // Menções contextuais ("paguei via pix", "enviei e-mail para ele", "o processo
    // foi por e-mail") NÃO devem acionar — o verbo/pronome precisa indicar pedido
    // direto ao escritório ("qual o seu pix", "me passa o email de vocês", etc.)
    const pedidoPix = /\bpix\b/i.test(textBody) &&
      /(?:qual\s+[eéè\s]*(o\s+)?(?:seu|o\s+)?pix|me\s+pass[ae].*\bpix\b|\bpix\b.*me\s+pass[ae]|chave\s+pix|pix\s+d[oa]\s+(?:senhor|dr|doutor|escritório)|como\s+(?:faço\s+)?(?:o\s+)?pagamento|para\s+(?:fazer|realizar|efetuar)\s+(?:o\s+)?pagamento)/i.test(textBody);
    const pedidoEmail = !pedidoPix &&
      /e-?mail/i.test(textBody) &&
      /(?:qual\s+[eéè\s]*(o\s+)?(?:seu|o\s+)?e-?mail|me\s+pass[ae].*e-?mail|e-?mail.*me\s+pass[ae]|endere[cç]o\s+de\s+e-?mail|e-?mail\s+d[oa]\s+(?:senhor|dr|doutor|escritório)|qual\s+o\s+contato\s+(?:de\s+)?e-?mail|pode\s+me\s+(?:dar|pass[ae]|mand[ae]).*e-?mail|e-?mail.*(?:de\s+)?contato)/i.test(textBody);
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
    const generoFinal: Genero = await detectarGeneroComIA(phone, textBody, displayName, session?.genero);

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
            // Pedir "contra quem é o processo" no meio de uma conversa que já
            // trata de um caso conhecido soa como se ela não tivesse lido nada.
            // Só manda a frase fixa quando o caso ainda não está em pauta.
            if (await conversaJaTrataDeCaso(phone, textBody)) {
              console.log(`[orchestrator] ${phone} já trata de um caso conhecido — não pede os dados de novo`);
              context = JSON.stringify({
                contact, intent: classification.intent, customInstruction,
                observacao: 'A conversa já trata de um caso específico. NÃO peça de novo contra quem é o processo nem o número — responda ao que o cliente disse agora, usando o histórico.',
              });
              draft = await draftResponse('DESCONHECIDO', textBody, context, generoFinal, historicoConversa);
              break;
            }
            // Mensagem fixa (não gerada por IA) para garantir a frase obrigatória exata
            // Já pedimos esses dados a este contato há pouco: insistir a cada
            // mensagem é o que torna o atendimento repetitivo
            if (jaEnviouTipo(phone, 'pedido_dados_caso', 24)) {
              console.log(`[orchestrator] ${phone} — pedido de dados do caso já foi feito, não repete`);
              break;
            }
            draft = MSG_PEDIR_DADOS_PROCESSO(temNome);
            context = 'pedido_dados_processo';
            registrarTipoEnviado(phone, 'pedido_dados_caso');
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
          // Dizer "parece cunho pessoal" a cada mensagem do amigo é constrangedor
          if (jaEnviouTipo(phone, 'amigo_pessoal', 24)) {
            console.log(`[orchestrator] ${phone} — aviso de cunho pessoal já foi dado, não repete`);
            break;
          }
          draft = MSG_AMIGO;
          registrarTipoEnviado(phone, 'amigo_pessoal');
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
      // Re-checa Wesley logo antes de enviar: ele pode ter respondido enquanto a IA processava
      if (!modoCalibragem() && (wesleyFoiOUltimoAResponder(phone) || houveRespostaDeWesley(MINUTOS_ATIVIDADE_WESLEY, phone))) {
        console.log(`[orchestrator] rascunho pronto mas Wesley respondeu durante o processamento — descartando para ${phone}`);
        return;
      }
      await deliverOrQueue(phone, draft, context, io, contact?.name || session?.name);
    }

  } catch (err) {
    console.error('[orchestrator] erro ao responder conversa:', err);
    io?.emit('error', { phone, error: String(err) });
  }
}

async function deliverOrQueue(phone: string, draft: string, context: string, io: any, contactName?: string) {
  // Em calibragem a resposta nunca é enviada: vai sempre para a fila de revisão,
  // onde Wesley edita e o resultado é gravado no banco de treinamento
  const modoTreino = process.env.MODO_TREINO === 'true' || modoCalibragem();

  if (modoTreino) {
    const id = savePendingApproval(phone, draft, context);
    // Vai o nome junto: revisar um rascunho olhando só para o número não diz a
    // quem se está respondendo
    const sessao = getSession(phone);
    io?.emit('pending_approval', {
      id, phone, draft, context, timestamp: Date.now(),
      nome: contactName || sessao?.name || '',
      tipo_contato: sessao?.type || '',
    });
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
// A conversa já está tratando de um caso concreto? Usado antes de mandar a frase
// fixa que pede contra quem é o processo: se o caso já está em pauta — porque o
// cliente já disse, porque Wesley já respondeu sobre ele, ou porque a mensagem
// de agora dá seguimento ao que já foi falado — repetir o pedido soa como se ela
// não tivesse lido a conversa. Em caso de erro ou dúvida, devolve false e a
// frase fixa sai, que é o comportamento que Wesley pediu como padrão.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// O bloco de mensagens do cliente realmente pede uma resposta do escritório?
// Nem toda mensagem pede: relato, desabafo, envio de documento e confirmações
// ("ok", "obrigado") não precisam de retorno — responder a tudo é o que deixa o
// atendimento exaustivo. Em caso de erro, responde, para não deixar no vácuo.
async function precisaDeResposta(phone: string, texto: string): Promise<boolean> {
  const t = (texto || '').trim();
  if (!t) return false;

  // Encerramentos claros — sem IA
  if (isEncerramento(t)) return false;

  // Pergunta explícita — sem IA
  if (t.includes('?')) return true;

  // Assunto jurídico ou pedido direto — sem IA
  if (/(?:processo|prazo|audiência|audiencia|recurso|contrato|pagamento|honorário|honorario|andamento|novidade|notícia|noticia|liberação|liberacao|bloqueado|poderia|gostaria|preciso|quero\s+saber|necessito|solicito|urgente|advogado)/i.test(t)) return true;

  // Texto muito curto sem pergunta — provavelmente confirmação ou relato breve
  if (t.length < 20) return false;

  // Ambíguo — chama IA apenas para casos que não se encaixam nas regras acima
  try {
    const historico = getHistory(phone, 8)
      .map((m: any) => `${m.role === 'client' ? 'Cliente' : m.role === 'wesley' ? 'Dr. Wesley' : 'Iara'}: ${(m.body || '').slice(0, 300)}`)
      .join('\n');

    const prompt = `Atendimento de um escritório de advocacia no WhatsApp.

HISTÓRICO RECENTE:
${historico}

BLOCO DE MENSAGENS QUE O CLIENTE ACABOU DE ENVIAR:
"${t.slice(0, 1500)}"

O escritório precisa responder algo agora? Responda false quando for apenas relato, desabafo, envio de documentos sem pergunta, agradecimento, confirmação ("ok", "entendi", "combinado") ou quando a última fala da Iara já cobriu o assunto e o cliente não trouxe nada novo.

APENAS JSON: {"precisaResponder": true ou false}`;

    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [{ role: 'user', content: prompt }],
    });
    const b = r.content[0];
    const bruto = b && b.type === 'text' ? b.text : '{}';
    const m = bruto.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : bruto).precisaResponder !== false;
  } catch (err) {
    console.error('[orchestrator] falha ao avaliar se precisa responder:', err);
    return true;
  }
}

// Verifica via IA se o bloco de mensagens de um primeiro contato já deixa claro
// qual é o assunto — complementa a checagem por regex quando o texto é ambíguo.
// Em caso de erro retorna false (seguro: a saudação com pergunta é enviada).
async function detectarAssuntoComIA(texto: string): Promise<boolean> {
  const t = (texto || '').trim();
  if (!t || t.length < 15) return false;
  try {
    const prompt = `Um novo cliente entrou em contato com um escritório de advocacia pelo WhatsApp e enviou as seguintes mensagens:

"${t.slice(0, 1000)}"

O assunto já está claro o suficiente para o escritório entender o que o cliente precisa, sem precisar perguntar? Considere "claro" qualquer menção a: um problema jurídico, situação pessoal, pedido de orientação, nome de pessoa envolvida, valor, imóvel, processo, dívida, contrato, ou qualquer assunto concreto além de uma saudação simples.

APENAS JSON: {"assuntoClaro": true ou false}`;

    const r = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [{ role: 'user', content: prompt }],
    });
    const b = r.content[0];
    const bruto = b && b.type === 'text' ? b.text : '{}';
    const m = bruto.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : bruto).assuntoClaro === true;
  } catch (err) {
    console.error('[orchestrator] falha ao detectar assunto via IA:', err);
    return false;
  }
}

async function conversaJaTrataDeCaso(phone: string, mensagemAtual: string): Promise<boolean> {
  try {
    const historico = getHistory(phone, 10);
    // Sem histórico não há caso anterior possível
    if (!historico || historico.length < 2) return false;

    const linhas = historico
      .map((m: any) => `${m.role === 'client' ? 'Cliente' : m.role === 'wesley' ? 'Dr. Wesley' : 'Iara'}: ${(m.body || '').slice(0, 400)}`)
      .join('\n');

    const prompt = `Conversa de WhatsApp de um escritório de advocacia.

HISTÓRICO (mais antiga primeiro):
${linhas}

MENSAGEM DE AGORA, do cliente: "${(mensagemAtual || '').slice(0, 600)}"

Responda: esta conversa JÁ trata de um caso específico e identificado (um processo, contrato ou assunto concreto que já foi nomeado antes), de modo que perguntar agora "contra quem é o processo e qual o número" seria repetitivo e fora de contexto?

APENAS JSON: {"jaTrataDeCaso": true ou false}`;

    const resposta = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [{ role: 'user', content: prompt }],
    });
    const bloco = resposta.content[0];
    const bruto = bloco && bloco.type === 'text' ? bloco.text : '{}';
    const m = bruto.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : bruto).jaTrataDeCaso === true;
  } catch (err) {
    console.error('[orchestrator] falha ao verificar se a conversa já trata de um caso:', err);
    return false;
  }
}

// Quantos minutos de silêncio do Wesley para considerar que ele parou de atender
const MINUTOS_ATIVIDADE_WESLEY = parseInt(process.env.MINUTOS_ATIVIDADE_WESLEY || '') || 90;

// Interrompe o aviso de ausência quando Wesley está atendendo fora do horário:
// não faz sentido avisar que ele só responde em horário comercial enquanto ele
// Retorna true quando a primeira mensagem de um novo contato já traz contexto
// suficiente (assunto, pedido, situação) e não precisa ser questionado.
// Critério: texto com mais de 60 chars após remover saudações comuns, ou que
// contém pergunta clara ("poderia", "gostaria", "preciso", "quero saber" etc.)
function primeiraMessagemComAssunto(texto: string): boolean {
  // Remove saudação inicial de cada linha e analisa o bloco completo acumulado
  const limpo = texto
    .split('\n')
    .map(l => l.replace(/^(?:bom\s*dia|boa\s*tarde|boa\s*noite|olá|oi|tudo\s*bem|dr\.?)[?!.,\s]*/i, '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  // Texto longo após saudação = o cliente já explicou o caso
  if (limpo.length > 40) return true;
  // Palavras-chave que indicam assunto jurídico/pedido mesmo em texto curto
  return /(?:poderia|gostaria|preciso|quero\s+saber|necessito|solicito|novidade|notícia|andamento|liberação|bloqueado|pagamento|indenização|processo|contrato|audiência|prazo|recurso|notificação|advogado)/i.test(limpo);
}

// está ali respondendo. Vale tanto para a própria conversa quanto para o plantão
// em geral — ao assumir a fila, ele atende vários contatos seguidos.
function wesleyAtendendoAgora(phone: string): boolean {
  try {
    if (houveRespostaDeWesley(MINUTOS_ATIVIDADE_WESLEY, phone)) {
      console.log(`[ausencia] suprimido — Wesley já respondeu esta conversa há menos de ${MINUTOS_ATIVIDADE_WESLEY} min: ${phone}`);
      return true;
    }
    return false;
  } catch (err) {
    console.error('[ausencia] erro ao verificar atividade do Wesley:', err);
    return false;
  }
}

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
