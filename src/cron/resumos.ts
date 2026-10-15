import { getDb, salvarResumoDiario, getResumosDoDia } from '../memory/db';
import { createNote, sendMessage } from '../responder/send';
import { saveConversationSummary } from '../integrations/drive';
import Anthropic from '@anthropic-ai/sdk';

const PHONE_WESLEY = process.env.PHONE_WESLEY || '5544999110862';

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

function hojeStr(): string {
  const sp = new Date(new Date().toLocaleString('en-US', { timeZone: process.env.TZ_APP || 'America/Sao_Paulo' }));
  return `${sp.getFullYear()}-${String(sp.getMonth() + 1).padStart(2, '0')}-${String(sp.getDate()).padStart(2, '0')}`;
}

export async function cronResumosDiarios(): Promise<void> {
  const contatos = getPhonesComConversaHoje();
  if (!contatos.length) {
    console.log('[cron-resumos] nenhuma conversa hoje');
    return;
  }

  const dataHoje = hojeStr();
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

      // 3. Salvar no banco para consulta pelo painel
      salvarResumoDiario(phone, name || phone, dataHoje, resumo);

      console.log(`[cron-resumos] salvo para ${name || phone} (${phone})`);
      salvos++;
    } catch (err) {
      console.error(`[cron-resumos] erro para ${phone}:`, err);
      erros++;
    }
  }

  console.log(`[cron-resumos] ${salvos} resumo(s) salvo(s), ${erros} erro(s)`);
}

type UltimaResposta = 'wesley' | 'iara' | 'cliente';

// Retorna quem enviou a última mensagem hoje nessa conversa
function ultimaRespostaHoje(phone: string, inicioDia: number): UltimaResposta {
  const ultima = getDb().prepare(
    `SELECT role FROM messages WHERE phone = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`
  ).get(phone, inicioDia) as { role: string } | undefined;
  if (!ultima) return 'cliente';
  if (ultima.role === 'wesley') return 'wesley';
  if (ultima.role === 'iara') return 'iara';
  return 'cliente';
}

// Horário da última mensagem de cada remetente hoje (retorna string HH:MM ou null)
function horarioUltima(phone: string, inicioDia: number, role: string): string | null {
  const row = getDb().prepare(
    `SELECT created_at FROM messages WHERE phone = ? AND role = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`
  ).get(phone, role, inicioDia) as { created_at: number } | undefined;
  if (!row) return null;
  return new Date(row.created_at * 1000).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
}

// Envia às 21h um resumo consolidado do dia para o número do Dr. Wesley
export async function cronRelatorioWesley(): Promise<void> {
  const dataHoje = hojeStr();
  const resumos = getResumosDoDia(dataHoje);
  if (!resumos.length) {
    console.log('[cron-relatorio] nenhum resumo disponível para hoje');
    return;
  }

  const inicio = inicioDiaSaoPaulo();
  const [dia, mes, ano] = dataHoje.split('-').reverse();

  // Agrupa por quem enviou a última mensagem
  const grupoCliente: string[] = [];   // cliente aguardando — provável não lida
  const grupoIara: string[] = [];      // Iara respondeu por último
  const grupoWesley: string[] = [];    // Dr. Wesley respondeu por último

  resumos.forEach((r) => {
    const assunto = r.resumo.match(/Assunto principal:\s*(.+)/i)?.[1]?.trim() || '—';
    const pendencia = r.resumo.match(/Pendências:\s*(.+)/i)?.[1]?.trim() || '';
    const pendStr = pendencia && pendencia.toLowerCase() !== 'nenhuma' ? ` | ${pendencia}` : '';

    const hWesley = horarioUltima(r.phone, inicio, 'wesley');
    const hIara   = horarioUltima(r.phone, inicio, 'iara');
    const hCliente = horarioUltima(r.phone, inicio, 'client');

    const parteHorarios = [
      hWesley  ? `Sr. Wesley ${hWesley}`  : null,
      hIara    ? `Iara ${hIara}`           : null,
      hCliente ? `Cliente ${hCliente}`     : null,
    ].filter(Boolean).join(' | ');

    const linha = `${r.name || r.phone} — ${assunto}${pendStr}\n   (${parteHorarios})`;

    const ultimo = ultimaRespostaHoje(r.phone, inicio);
    if (ultimo === 'cliente') grupoCliente.push(linha);
    else if (ultimo === 'iara') grupoIara.push(linha);
    else grupoWesley.push(linha);
  });

  const partes: string[] = [
    `RELATÓRIO DO DIA — ${dia}/${mes}/${ano}`,
    `${resumos.length} conversa(s) registrada(s)`,
    '',
  ];

  if (grupoCliente.length) {
    partes.push(`🔴 ÚLTIMA MSG: CLIENTE — provável não lida (${grupoCliente.length}):`);
    grupoCliente.forEach((l, i) => partes.push(`${i + 1}. ${l}`));
    partes.push('');
  }

  if (grupoIara.length) {
    partes.push(`🟡 ÚLTIMA MSG: IARA — aguardando retorno do cliente (${grupoIara.length}):`);
    grupoIara.forEach((l, i) => partes.push(`${i + 1}. ${l}`));
    partes.push('');
  }

  if (grupoWesley.length) {
    partes.push(`🟢 ÚLTIMA MSG: SR. WESLEY — conversa encerrada pelo senhor (${grupoWesley.length}):`);
    grupoWesley.forEach((l, i) => partes.push(`${i + 1}. ${l}`));
    partes.push('');
  }

  partes.push('Resumos detalhados disponíveis no painel.');

  const texto = partes.join('\n');

  try {
    await sendMessage(PHONE_WESLEY, texto, { assinar: false });
    console.log(`[cron-relatorio] relatório enviado — ${grupoCliente.length} p/ Wesley, ${grupoIara.length} p/ retorno cliente, ${grupoWesley.length} encerradas`);
  } catch (err) {
    console.error('[cron-relatorio] erro ao enviar relatório:', err);
  }
}
