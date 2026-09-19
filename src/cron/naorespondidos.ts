import { getDb, saveMessage } from '../memory/db';
import { sendMessage } from '../responder/send';

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
  // Usa últimos dígitos do telefone + hora para variar de forma determinística
  const seed = (parseInt(phone.slice(-3)) + new Date().getHours()) % VARIACOES.length;
  return VARIACOES[seed](nome);
}

// Busca conversas onde a última mensagem é do cliente há mais de 6 horas
// e ainda não enviamos aviso de "não esquecemos" nas últimas 12 horas
export function getConversasSemResposta(): Array<{ phone: string; name: string | null; ultimo_cliente: number }> {
  const seiHorasAtras = Math.floor(Date.now() / 1000) - 6 * 3600;
  const dozeHorasAtras = Math.floor(Date.now() / 1000) - 12 * 3600;

  return getDb().prepare(`
    WITH ultimas AS (
      SELECT
        phone,
        MAX(created_at) AS ultima_msg,
        MAX(CASE WHEN role = 'client' THEN created_at ELSE 0 END) AS ultimo_cliente,
        MAX(CASE WHEN role IN ('iara','wesley') THEN created_at ELSE 0 END) AS ultima_resposta
      FROM messages
      GROUP BY phone
    ),
    aviso_recente AS (
      SELECT DISTINCT phone FROM messages
      WHERE role = 'iara'
        AND body LIKE '%não esquecemos%'
        AND created_at > ?
    )
    SELECT u.phone, s.name, u.ultimo_cliente
    FROM ultimas u
    LEFT JOIN sessions s ON s.phone = u.phone
    LEFT JOIN aviso_recente a ON a.phone = u.phone
    WHERE u.ultimo_cliente > 0
      AND u.ultimo_cliente < ?
      AND (u.ultima_resposta = 0 OR u.ultima_resposta < u.ultimo_cliente)
      AND a.phone IS NULL
  `).all(dozeHorasAtras, seiHorasAtras) as any[];
}

export async function cronNaoRespondidos(): Promise<void> {
  const conversas = getConversasSemResposta();

  for (const conv of conversas) {
    const primeiroNome = conv.name
      ? conv.name.split(' ')[0]
      : '';

    const mensagem = escolherVariacao(conv.phone, primeiroNome);

    try {
      await sendMessage(conv.phone, mensagem);
      saveMessage(conv.phone, 'iara', mensagem);
      console.log(`[cron-naorespondido] aviso enviado para ${conv.phone}`);
    } catch (err) {
      console.error(`[cron-naorespondido] erro ao enviar para ${conv.phone}:`, err);
    }
  }

  if (conversas.length === 0) {
    console.log('[cron-naorespondido] nenhuma conversa pendente');
  }
}
