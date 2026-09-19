import { getDb, saveMessage } from '../memory/db';
import { sendMessage } from '../responder/send';

// Variações para não repetir sempre a mesma mensagem
const VARIACOES = [
  (nome: string) =>
    `Olá${nome ? ', ' + nome : ''}! 😊 Passando rapidinho pra te avisar que não esquecemos de você. O Dr. Wesley está verificando sua mensagem e em breve vai te dar um retorno.`,

  (nome: string) =>
    `Oi${nome ? ' ' + nome : ''}! Aqui é a Iara, secretária do Dr. Wesley. Queria te tranquilizar: sua mensagem foi recebida e está sendo tratada com atenção. Assim que possível a gente volta com uma resposta! 🙏`,

  (nome: string) =>
    `${nome ? nome + ', v' : 'V'}ocê está em boa mãos! 💙 Só passando pra avisar que o Dr. Wesley está ciente da sua mensagem e vai te responder em breve. Qualquer urgência, pode me falar que eu repasso imediatamente.`,

  (nome: string) =>
    `Olá${nome ? ', ' + nome : ''}! Iara aqui. Quero que saiba que sua mensagem não ficou sem atenção — o Dr. Wesley já está a par e retornará assim que possível. Obrigada pela paciência! 😊`,

  (nome: string) =>
    `Oi${nome ? ' ' + nome : ''}! 👋 Passando para te avisar que recebemos sua mensagem e não esquecemos de você. O Wesley vai te dar um retorno em breve. Se surgir alguma urgência, é só me chamar aqui!`,

  (nome: string) =>
    `${nome ? nome + ', ' : ''}quero te garantir que sua mensagem está sendo cuidada com carinho! 💙 O Dr. Wesley vai entrar em contato assim que possível. Obrigada por aguardar com paciência.`,
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
