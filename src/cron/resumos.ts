import { getDb } from '../memory/db';
import { createNote } from '../responder/send';
import { saveConversationSummary } from '../integrations/drive';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Início do dia em São Paulo, como epoch real (Brasil é UTC-3 fixo, sem horário de
// verão desde 2019) — usar new Date().setHours() usaria o fuso do servidor (UTC no
// Railway), deslocando o corte em até 3h e cortando/perdendo mensagens do fim do dia
function inicioDiaSaoPaulo(): number {
  const spNow = new Date(new Date().toLocaleString('en-US', { timeZone: process.env.TZ_APP || 'America/Sao_Paulo' }));
  return Math.floor(Date.UTC(spNow.getFullYear(), spNow.getMonth(), spNow.getDate(), 3, 0, 0) / 1000);
}

// Retorna todos os phones que tiveram mensagens hoje
function getPhonesComConversaHoje(): Array<{ phone: string; name: string | null }> {
  const inicioDia = inicioDiaSaoPaulo();
  return getDb().prepare(`
    SELECT DISTINCT m.phone, s.name
    FROM messages m
    LEFT JOIN sessions s ON s.phone = m.phone
    WHERE m.created_at >= ?
      AND m.role IN ('client', 'iara', 'wesley')
    ORDER BY m.phone
  `).all(inicioDia) as any[];
}

// Retorna todas as mensagens do dia para um phone
function getMensagensHoje(phone: string): Array<{ role: string; body: string; media_url: string | null; created_at: number }> {
  const inicioDia = inicioDiaSaoPaulo();
  return getDb().prepare(`
    SELECT role, body, media_url, created_at
    FROM messages
    WHERE phone = ? AND created_at >= ?
    ORDER BY created_at
  `).all(phone, inicioDia) as any[];
}

function horaStr(epoch: number): string {
  return new Date(epoch * 1000).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
}

// Extrai nome do arquivo do body "[Documento recebido: nome.pdf]" ou da media_url
function nomeArquivo(body: string, mediaUrl: string | null): string {
  const match = body.match(/\[Documento recebido:\s*([^\]]+)\]/i);
  if (match) return match[1].trim();
  if (mediaUrl) return mediaUrl.split('/').pop()?.split('?')[0] || mediaUrl;
  return 'arquivo';
}

async function gerarResumo(name: string, phone: string, mensagens: Array<{ role: string; body: string; media_url: string | null; created_at: number }>): Promise<string> {
  // Separa áudios transcritos e documentos do cliente para listar à parte
  const audiosCliente = mensagens.filter(m =>
    m.role === 'client' && !m.body.startsWith('[Documento') && !m.body.startsWith('[Imagem') &&
    m.media_url === null && m.body.length > 40
  );
  const documentosCliente = mensagens.filter(m =>
    m.role === 'client' && (m.body.startsWith('[Documento') || m.body.startsWith('[Imagem') || (m.media_url !== null && !m.body.startsWith('[')))
  );
  const documentosEscritorio = mensagens.filter(m =>
    (m.role === 'iara' || m.role === 'wesley') && m.media_url !== null
  );

  const linhasArquivosCliente = documentosCliente.map(m =>
    `${nomeArquivo(m.body, m.media_url)} (${horaStr(m.created_at)})`
  );
  const linhasArquivosEscritorio = documentosEscritorio.map(m =>
    `${nomeArquivo(m.body, m.media_url)} (${horaStr(m.created_at)})`
  );

  // Transcrições de áudio viram linhas especiais no transcript
  const transcript = mensagens
    .filter(m => !(m.body.startsWith('[Documento') || m.body.startsWith('[Imagem')))
    .map(m => {
      const quem = m.role === 'client' ? (name || phone) : m.role === 'iara' ? 'Iara' : 'Dr. Wesley';
      return `${quem}: ${m.body}`;
    }).join('\n');

  const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const totalMensagens = mensagens.length;
  const doCliente = mensagens.filter(m => m.role === 'client').length;
  const doEscritorio = totalMensagens - doCliente;

  const arquivosClienteStr = linhasArquivosCliente.length
    ? linhasArquivosCliente.join(', ')
    : 'Nenhum';
  const arquivosEscritorioStr = linhasArquivosEscritorio.length
    ? linhasArquivosEscritorio.join(', ')
    : 'Nenhum';
  const audiosStr = audiosCliente.length
    ? `${audiosCliente.length} áudio(s) — transcrições incluídas na conversa acima`
    : 'Nenhum';

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `Você é o sistema de registro do escritório do Dr. Wesley Veiga (advogado).
Abaixo está a conversa do dia ${hoje} com o contato "${name || phone}" (${phone}).
Total de mensagens: ${totalMensagens} (${doCliente} do cliente, ${doEscritorio} do escritório).

CONVERSA (inclui transcrições de áudios):
${transcript}

Gere um resumo estruturado no seguinte formato exato (sem emojis, sem travessão, linguagem formal):

RESUMO — ${hoje} — ${name || phone}
Assunto principal: [tema central da conversa em uma linha]
Mensagens trocadas: [quantidade e síntese dos pontos levantados pelo cliente]
Ações do escritório: [o que a Iara ou o Dr. Wesley respondeu, comprometeu ou encaminhou]
Arquivos recebidos do cliente: ${arquivosClienteStr}
Arquivos enviados ao cliente: ${arquivosEscritorioStr}
Áudios recebidos: ${audiosStr === 'Nenhum' ? 'Nenhum' : '[descreva brevemente o assunto de cada áudio com base nas transcrições acima]'}
Pendências: [o que ficou em aberto, se houver; caso contrário escreva "Nenhuma"]
Próximos passos: [o que precisa ser feito a seguir, se identificado; caso contrário escreva "A definir"]
Tom da conversa: [ex.: urgente, informativo, agradecido, tenso, rotineiro]`,
    }],
  });

  const block = response.content[0];
  if (block && block.type === 'text') return block.text.trim();
  return [
    `RESUMO — ${hoje} — ${name || phone}`,
    `Assunto principal: conversa registrada.`,
    `Mensagens trocadas: ${totalMensagens} mensagens.`,
    `Ações do escritório: —`,
    `Arquivos recebidos do cliente: ${arquivosClienteStr}`,
    `Arquivos enviados ao cliente: ${arquivosEscritorioStr}`,
    `Áudios recebidos: ${audiosStr}`,
    `Pendências: A verificar`,
    `Próximos passos: A definir`,
    `Tom da conversa: —`,
  ].join('\n');
}

export async function cronResumosDiarios(): Promise<void> {
  const contatos = getPhonesComConversaHoje();
  if (!contatos.length) {
    console.log('[cron-resumos] nenhuma conversa hoje');
    return;
  }

  let salvos = 0;
  let erros = 0;

  for (const { phone, name } of contatos) {
    try {
      const mensagens = getMensagensHoje(phone);
      if (mensagens.length < 2) continue; // ignora conversas com só 1 mensagem

      const resumo = await gerarResumo(name || '', phone, mensagens);

      // 1. Nota no Waspeed (visível na conversa do cliente)
      await createNote(phone, resumo);

      // 2. Salvar no Drive na pasta do cliente
      await saveConversationSummary(phone, name || phone, resumo);

      console.log(`[cron-resumos] salvo para ${name || phone} (${phone})`);
      salvos++;
    } catch (err) {
      console.error(`[cron-resumos] erro para ${phone}:`, err);
      erros++;
    }
  }

  console.log(`[cron-resumos] ${salvos} resumo(s) salvo(s), ${erros} erro(s)`);
}
