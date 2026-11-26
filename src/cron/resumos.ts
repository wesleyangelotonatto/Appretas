import { criarMensagem } from '../ia';
import { getDb, salvarResumoDiario, getResumosDoDia } from '../memory/db';
import { createNote, sendMessage } from '../responder/send';
import { saveConversationSummary } from '../integrations/drive';

const PHONE_WESLEY = process.env.PHONE_WESLEY || '5544999110862';

// Alerta no painel sem criar import circular com o servidor
function alertarPainel(tipo: string, mensagem: string) {
  import('../server').then(({ io }) => io?.emit('alerta', { tipo, mensagem })).catch(() => {});
}


// Início do dia em São Paulo, como epoch real (Brasil é UTC-3 fixo, sem horário de
// verão desde 2019) — usar new Date().setHours() usaria o fuso do servidor (UTC no
// Railway), deslocando o corte em até 3h e cortando/perdendo mensagens do fim do dia
function inicioDiaSaoPaulo(): number {
  const spNow = new Date(new Date().toLocaleString('en-US', { timeZone: process.env.TZ_APP || 'America/Sao_Paulo' }));
  return Math.floor(Date.UTC(spNow.getFullYear(), spNow.getMonth(), spNow.getDate(), 3, 0, 0) / 1000);
}

// Um dia do calendário de São Paulo como intervalo [inicio, fim) em epoch (segundos)
export interface PeriodoDia { dataStr: string; inicio: number; fim: number; rotulo: string }

// Dia anterior ao de hoje em São Paulo. Resumos e relatório rodam às 06h cobrindo
// o dia que terminou — assim nada do fim da noite fica de fora.
export function diaAnteriorSaoPaulo(): PeriodoDia {
  const inicioHoje = inicioDiaSaoPaulo();
  const inicio = inicioHoje - 86400;
  const d = new Date((inicio - 3 * 3600) * 1000); // meia-noite SP expressa em UTC
  const dataStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const rotulo = `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
  return { dataStr, inicio, fim: inicioHoje, rotulo };
}

// Retorna todos os phones que tiveram mensagens no período
function getPhonesComConversa(p: PeriodoDia): Array<{ phone: string; name: string | null }> {
  return getDb().prepare(`
    SELECT DISTINCT m.phone, s.name
    FROM messages m
    LEFT JOIN sessions s ON s.phone = m.phone
    WHERE m.created_at >= ? AND m.created_at < ?
      AND m.role IN ('client', 'iara', 'wesley')
    ORDER BY m.phone
  `).all(p.inicio, p.fim) as any[];
}

// Retorna todas as mensagens do período para um phone
function getMensagensPeriodo(phone: string, p: PeriodoDia): Array<{ role: string; body: string; media_url: string | null; created_at: number }> {
  return getDb().prepare(`
    SELECT role, body, media_url, created_at
    FROM messages
    WHERE phone = ? AND created_at >= ? AND created_at < ?
    ORDER BY created_at
  `).all(phone, p.inicio, p.fim) as any[];
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

async function gerarResumo(name: string, phone: string, rotuloDia: string, mensagens: Array<{ role: string; body: string; media_url: string | null; created_at: number }>): Promise<string> {
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

  const hoje = rotuloDia;
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

  const response = await criarMensagem('resposta', {
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

// Mantido para chamadas manuais pelo painel
function hojeStr(): string {
  const sp = new Date(new Date().toLocaleString('en-US', { timeZone: process.env.TZ_APP || 'America/Sao_Paulo' }));
  return `${sp.getFullYear()}-${String(sp.getMonth() + 1).padStart(2, '0')}-${String(sp.getDate()).padStart(2, '0')}`;
}

export async function cronResumosDiarios(periodo: PeriodoDia = diaAnteriorSaoPaulo()): Promise<number> {
  const contatos = getPhonesComConversa(periodo);
  if (!contatos.length) {
    console.log(`[cron-resumos] nenhuma conversa em ${periodo.rotulo}`);
    return 0;
  }

  const dataHoje = periodo.dataStr;
  let salvos = 0;
  let erros = 0;

  for (const { phone, name } of contatos) {
    try {
      const mensagens = getMensagensPeriodo(phone, periodo);
      if (mensagens.length < 2) continue; // ignora conversas com só 1 mensagem

      const resumo = await gerarResumo(name || '', phone, periodo.rotulo, mensagens);

      // 1. Nota no Waspeed (visível na conversa do cliente)
      await createNote(phone, resumo);

      // 2. Salvar no Drive na pasta do cliente
      await saveConversationSummary(phone, name || phone, resumo, periodo.dataStr);

      // 3. Salvar no banco para consulta pelo painel
      salvarResumoDiario(phone, name || phone, dataHoje, resumo);

      console.log(`[cron-resumos] salvo para ${name || phone} (${phone})`);
      salvos++;
    } catch (err) {
      console.error(`[cron-resumos] erro para ${phone}:`, err);
      erros++;
    }
  }

  console.log(`[cron-resumos] ${periodo.rotulo}: ${salvos} resumo(s) salvo(s), ${erros} erro(s)`);
  return salvos;
}

type UltimaResposta = 'wesley' | 'iara' | 'cliente';

// Retorna quem enviou a última mensagem hoje nessa conversa
function ultimaRespostaDoDia(phone: string, p: PeriodoDia): UltimaResposta {
  const ultima = getDb().prepare(
    `SELECT role FROM messages WHERE phone = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT 1`
  ).get(phone, p.inicio, p.fim) as { role: string } | undefined;
  if (!ultima) return 'cliente';
  if (ultima.role === 'wesley') return 'wesley';
  if (ultima.role === 'iara') return 'iara';
  return 'cliente';
}

// Horário da última mensagem de cada remetente hoje (retorna string HH:MM ou null)
function horarioUltima(phone: string, p: PeriodoDia, role: string): string | null {
  const row = getDb().prepare(
    `SELECT created_at FROM messages WHERE phone = ? AND role = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT 1`
  ).get(phone, role, p.inicio, p.fim) as { created_at: number } | undefined;
  if (!row) return null;
  return new Date(row.created_at * 1000).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
}

// Relatório do dia anterior para o número do Dr. Wesley, enviado às 06h logo depois dos resumos
export async function cronRelatorioWesley(periodo: PeriodoDia = diaAnteriorSaoPaulo()): Promise<void> {
  const resumos = getResumosDoDia(periodo.dataStr);
  if (!resumos.length) {
    console.log(`[cron-relatorio] nenhum resumo de ${periodo.rotulo} — relatório não enviado`);
    return;
  }

  // Agrupa por quem enviou a última mensagem
  const grupoCliente: string[] = [];   // cliente aguardando — provável não lida
  const grupoIara: string[] = [];      // Iara respondeu por último
  const grupoWesley: string[] = [];    // Dr. Wesley respondeu por último

  resumos.forEach((r) => {
    const assunto = r.resumo.match(/Assunto principal:\s*(.+)/i)?.[1]?.trim() || '—';
    const pendencia = r.resumo.match(/Pendências:\s*(.+)/i)?.[1]?.trim() || '';
    const pendStr = pendencia && pendencia.toLowerCase() !== 'nenhuma' ? ` | ${pendencia}` : '';

    const hWesley = horarioUltima(r.phone, periodo, 'wesley');
    const hIara   = horarioUltima(r.phone, periodo, 'iara');
    const hCliente = horarioUltima(r.phone, periodo, 'client');

    const parteHorarios = [
      hWesley  ? `Sr. Wesley ${hWesley}`  : null,
      hIara    ? `Iara ${hIara}`           : null,
      hCliente ? `Cliente ${hCliente}`     : null,
    ].filter(Boolean).join(' | ');

    const linha = `${r.name || r.phone} — ${assunto}${pendStr}\n   (${parteHorarios})`;

    const ultimo = ultimaRespostaDoDia(r.phone, periodo);
    if (ultimo === 'cliente') grupoCliente.push(linha);
    else if (ultimo === 'iara') grupoIara.push(linha);
    else grupoWesley.push(linha);
  });

  const partes: string[] = [
    `RELATÓRIO DO DIA — ${periodo.rotulo}`,
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
    const r = await sendMessage(PHONE_WESLEY, texto, { assinar: false, rotulo: 'relatório diário' });
    if (r.status === 'enviado' || r.status === 'na_fila') {
      console.log(`[cron-relatorio] relatório ${r.status} — ${grupoCliente.length} p/ Wesley, ${grupoIara.length} p/ retorno cliente, ${grupoWesley.length} encerradas`);
    } else {
      // Pausa geral ou calibragem bloqueiam o envio: avisa no painel em vez de fingir que saiu
      console.error(`[cron-relatorio] relatório NÃO enviado (${r.status})`);
      alertarPainel('relatorio_nao_enviado', `Relatório diário não enviado (${r.status}). Veja em Resumos no painel.`);
    }
  } catch (err) {
    console.error('[cron-relatorio] erro ao enviar relatório:', err);
    alertarPainel('relatorio_erro', 'Falha ao enviar o relatório diário.');
  }
}

// Rotina das 06h: resumos do dia anterior e, em seguida, o relatório (ordem garantida)
export async function cronDiarioManha(): Promise<void> {
  const periodo = diaAnteriorSaoPaulo();
  try { await cronResumosDiarios(periodo); }
  catch (err) { console.error('[cron-manha] erro nos resumos:', err); }
  await cronRelatorioWesley(periodo);
}
