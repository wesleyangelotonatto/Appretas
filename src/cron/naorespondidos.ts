import { getDb, saveMessage } from '../memory/db';
import { sendMessage } from '../responder/send';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Padrões de encerramento inequívoco — atalho rápido sem custo de API para os
// casos mais óbvios. Qualquer coisa fora dessa lista curta passa pela checagem
// semântica via IA abaixo, que é o que realmente decide.
const ENCERRAMENTOS_OBVIOS = [
  /^ok[\s!.]*$/i,
  /^certo[\s!.]*$/i,
  /^entendido[\s!.]*$/i,
  /^combinado[\s!.]*$/i,
  /^perfeito[\s!.]*$/i,
  /^👍[\s!.]*$/,
  /^(muito\s+)?obrigad[oa][\s!.,]*$/i,
  /^valeu[\s!.]*$/i,
];

// Decide, com apoio de IA, se a última mensagem do cliente realmente ainda
// aguarda uma resposta do escritório. Regras puramente por palavra-chave
// erram demais (ex.: "boa tarde" pode ser saudação de despedida OU abertura
// de uma pergunta) — por isso usamos o modelo para julgar com o contexto
// das últimas mensagens. Em caso de erro/indefinição, NÃO envia o aviso:
// um aviso a menos é preferível a incomodar um cliente que não está esperando nada
// (foi exatamente o erro relatado — o padrão antigo assumia o oposto).
async function precisaDeAviso(phone: string, ultimaMsgCliente: string): Promise<boolean> {
  const texto = (ultimaMsgCliente || '').trim().slice(0, 1000);
  if (!texto) return false; // mídia sem legenda → aguarda análise, mas isso é raro nesse fluxo
  if (ENCERRAMENTOS_OBVIOS.some(re => re.test(texto))) return false;

  try {
    const db = getDb();
    const historico = db.prepare(
      `SELECT role, body FROM messages WHERE phone = ? ORDER BY created_at DESC LIMIT 6`
    ).all(phone) as Array<{ role: string; body: string }>;
    // Trunca cada mensagem: uma única mensagem gigante no histórico já estourou o
    // limite do modelo ("prompt is too long: 258530 tokens") e derrubou a verificação
    const historicoFormatado = historico.reverse()
      .map(m => `${m.role === 'client' ? 'Cliente' : 'Escritório'}: ${(m.body || '').slice(0, 500)}`)
      .join('\n');

    const prompt = `Você avalia se uma conversa de WhatsApp de um escritório de advocacia está genuinamente aguardando resposta do escritório, ou se o cliente não está esperando nada (despedida, agradecimento isolado, confirmação sem pergunta, assunto encerrado, mensagem apenas informativa, etc.).

HISTÓRICO RECENTE (mais antiga primeiro):
${historicoFormatado}

A ÚLTIMA mensagem foi do cliente: "${texto}"

O escritório ainda deve uma resposta a essa mensagem? Responda APENAS com JSON: {"aguardando": true ou false}`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = response.content[0];
    const raw = block && block.type === 'text' ? block.text : '{}';
    const match = raw.match(/\{[\s\S]*\}/);
    const result = JSON.parse(match ? match[0] : raw);
    return result.aguardando !== false;
  } catch (err) {
    console.error('[cron-naorespondido] falha ao avaliar necessidade de aviso, não enviando por segurança:', err);
    return false;
  }
}

// Variações para não repetir sempre a mesma mensagem
const VARIACOES = [
  (nome: string) =>
    `Olá${nome ? ', ' + nome : ''}. Aqui é a Iara, secretária do Dr. Wesley. Gostaria de informar que sua mensagem foi recebida e não ficou sem atenção. O Dr. Wesley retornará assim que possível.`,

  (nome: string) =>
    `Olá${nome ? ', ' + nome : ''}. Passando para informar que sua mensagem está sendo tratada pelo Dr. Wesley. Em breve ele entrará em contato. Caso haja alguma urgência, por favor me avise que repasso imediatamente.`,

  (nome: string) =>
    `${nome ? nome + ', ' : ''}boa tarde. Aqui é a Iara, secretária do escritório. Quero garantir que sua mensagem foi recebida e está sendo verificada. O Dr. Wesley retornará em breve.`,

  (nome: string) =>
    `Olá${nome ? ', ' + nome : ''}. Informo que sua mensagem foi recebida e está sendo analisada pelo Dr. Wesley. Agradecemos a paciência e em breve teremos um retorno para o senhor${nome ? '' : 'a'}.`,

  (nome: string) =>
    `${nome ? nome + ', ' : ''}sua mensagem foi recebida e não ficou sem atenção. O Dr. Wesley está ciente e entrará em contato assim que possível. Obrigada pela compreensão.`,

  (nome: string) =>
    `Olá${nome ? ', ' + nome : ''}. Aqui é a Iara, do escritório do Dr. Wesley. Quero que saiba que sua mensagem está sendo tratada com a devida atenção. Em breve o Dr. Wesley ou eu retornaremos com uma resposta.`,
];

function escolherVariacao(phone: string, nome: string): string {
  // Usa últimos dígitos do telefone + hora para variar de forma determinística.
  // parseInt pode retornar NaN se phone não terminar em dígitos (ex: JID de grupo) —
  // nesse caso cai no índice 0 em vez de travar o cron inteiro para os demais contatos
  const parsed = parseInt(phone.slice(-3));
  const base = isNaN(parsed) ? 0 : parsed;
  const seed = (base + new Date().getHours()) % VARIACOES.length;
  return VARIACOES[seed](nome);
}

// Busca conversas onde a última mensagem é do cliente há mais de 6 horas
// e ainda não enviamos aviso de "não esquecemos" nas últimas 12 horas
export function getConversasSemResposta(): Array<{ phone: string; name: string | null; ultimo_cliente: number; ultima_msg_body: string }> {
  const seiHorasAtras = Math.floor(Date.now() / 1000) - 6 * 3600;
  const dozeHorasAtras = Math.floor(Date.now() / 1000) - 12 * 3600;

  return getDb().prepare(`
    WITH ultimas AS (
      SELECT
        phone,
        MAX(CASE WHEN role = 'client' THEN created_at ELSE 0 END) AS ultimo_cliente,
        MAX(CASE WHEN role IN ('iara','wesley') THEN created_at ELSE 0 END) AS ultima_resposta
      FROM messages
      GROUP BY phone
    ),
    -- created_at tem precisão de segundos: duas mensagens do cliente no mesmo
    -- segundo empatavam no MAX e o JOIN devolvia DUAS linhas para o mesmo
    -- telefone, fazendo o contato receber o aviso duplicado. O MAX(rowid)
    -- desempata e garante exatamente uma linha por telefone.
    ultima_msg_cliente AS (
      SELECT m.phone, m.body AS ultima_msg_body
      FROM messages m
      INNER JOIN (
        SELECT phone, MAX(rowid) AS rid
        FROM messages
        WHERE role = 'client'
          AND created_at = (
            SELECT MAX(created_at) FROM messages m2
            WHERE m2.phone = messages.phone AND m2.role = 'client'
          )
        GROUP BY phone
      ) t ON t.rid = m.rowid
    ),
    aviso_recente AS (
      SELECT DISTINCT phone FROM messages
      WHERE role = 'iara'
        AND body LIKE '%não ficou sem atenção%'
        AND created_at > ?
    )
    SELECT u.phone, s.name, u.ultimo_cliente, mc.ultima_msg_body
    FROM ultimas u
    LEFT JOIN sessions s ON s.phone = u.phone
    LEFT JOIN ultima_msg_cliente mc ON mc.phone = u.phone
    LEFT JOIN aviso_recente a ON a.phone = u.phone
    WHERE u.ultimo_cliente > 0
      AND u.ultimo_cliente < ?
      AND (u.ultima_resposta = 0 OR u.ultima_resposta < u.ultimo_cliente)
      AND a.phone IS NULL
  `).all(dozeHorasAtras, seiHorasAtras) as any[];
}

// Só envia seg-sex 07h-20h; fora disso, as conversas continuam elegíveis e são
// pegas automaticamente na próxima execução horária dentro da janela
function isWithinJanelaRetorno(): boolean {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: process.env.TZ_APP || 'America/Sao_Paulo' }));
  const dia = now.getDay();
  if (dia === 0 || dia === 6) return false;
  const hora = now.getHours();
  return hora >= 7 && hora < 20;
}

export async function cronNaoRespondidos(): Promise<void> {
  if (!isWithinJanelaRetorno()) {
    console.log('[cron-naorespondido] fora da janela (seg-sex 07h-20h), aguardando próxima execução');
    return;
  }

  const conversas = getConversasSemResposta();
  let enviados = 0;

  for (const conv of conversas) {
    // Ignora se a IA avaliar que o cliente não está de fato aguardando resposta
    const precisa = await precisaDeAviso(conv.phone, conv.ultima_msg_body || '');
    if (!precisa) {
      console.log(`[cron-naorespondido] ignorado (não aguarda resposta) — ${conv.phone}: "${conv.ultima_msg_body}"`);
      continue;
    }

    try {
      const primeiroNome = conv.name ? conv.name.split(' ')[0] : '';
      const mensagem = escolherVariacao(conv.phone, primeiroNome);
      await sendMessage(conv.phone, mensagem);
      saveMessage(conv.phone, 'iara', mensagem);
      console.log(`[cron-naorespondido] aviso enviado para ${conv.phone}`);
      enviados++;
    } catch (err) {
      console.error(`[cron-naorespondido] erro ao enviar para ${conv.phone}:`, err);
    }
  }

  console.log(`[cron-naorespondido] ${enviados} aviso(s) enviado(s), ${conversas.length - enviados} ignorado(s)`);
}
