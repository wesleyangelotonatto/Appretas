import { getDb, saveMessage } from '../memory/db';
import { sendMessage } from '../responder/send';

// Padrões de encerramento inequívoco — lista CONSERVADORA.
// Na dúvida, NÃO filtra: é melhor enviar um aviso a mais do que deixar
// o cliente sem retorno. Somente frases que claramente encerram a conversa.
const ENCERRAMENTOS = [
  // Confirmações isoladas sem contexto pendente
  /^ok[\s!.]*$/i,
  /^certo[\s!.]*$/i,
  /^entendido[\s!.]*$/i,
  /^combinado[\s!.]*$/i,
  /^perfeito[\s!.]*$/i,
  /^tudo\s*bem[\s!.]*$/i,
  /^tá\s*(bem|bom|ótimo|certo|ok)[\s!.]*$/i,
  /^tudo\s*(certo|ok|ótimo|bem)[\s!.]*$/i,
  /^pode\s*ser[\s!.]*$/i,
  /^flw[\s!.]*$/i,
  /^👍[\s!.]*$/,
  // Agradecimento SEM pedido junto (âncora no início da frase curta)
  /^(muito\s+)?obrigad[oa][\s!.,]*$/i,
  /^(muito\s+)?obrigad[oa],?\s*(dr\.?\s*wesley|iara|doutor)?[\s!.]*$/i,
  /^valeu[\s!.]*$/i,
  // Despedidas
  /^até\s*(mais|logo|breve|amanhã|segunda|depois)[\s!.]*$/i,
  /^(um\s+)?abraço[\s!.]*$/i,
  /^boa\s*(noite|tarde|semana)[\s!.]*$/i,
  /^bom\s*(dia|fim\s*de\s*semana)[\s!.]*$/i,
];

// Retorna true SOMENTE se a mensagem claramente encerra a conversa.
// Mensagem vazia (mídia/documento sem legenda) → NÃO é encerramento,
// o cliente enviou algo para análise e está aguardando retorno.
function pareceEncerramento(body: string): boolean {
  const texto = body.trim();
  if (!texto) return false; // mídia sem legenda → aguarda análise
  return ENCERRAMENTOS.some(re => re.test(texto));
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
    ultima_msg_cliente AS (
      SELECT m.phone, m.body AS ultima_msg_body
      FROM messages m
      INNER JOIN (
        SELECT phone, MAX(created_at) AS ts
        FROM messages
        WHERE role = 'client'
        GROUP BY phone
      ) t ON t.phone = m.phone AND t.ts = m.created_at AND m.role = 'client'
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
    // Ignora se a última mensagem do cliente parece encerramento de conversa
    if (pareceEncerramento(conv.ultima_msg_body || '')) {
      console.log(`[cron-naorespondido] ignorado (encerramento) — ${conv.phone}: "${conv.ultima_msg_body}"`);
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
