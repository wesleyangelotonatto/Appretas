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
function getMensagensHoje(phone: string): Array<{ role: string; body: string; created_at: number }> {
  const inicioDia = inicioDiaSaoPaulo();
  return getDb().prepare(`
    SELECT role, body, created_at
    FROM messages
    WHERE phone = ? AND created_at >= ?
    ORDER BY created_at
  `).all(phone, inicioDia) as any[];
}

async function gerarResumo(name: string, phone: string, mensagens: Array<{ role: string; body: string }>): Promise<string> {
  const transcript = mensagens.map(m => {
    const quem = m.role === 'client' ? (name || phone) : m.role === 'iara' ? 'Iara' : 'Dr. Wesley';
    return `${quem}: ${m.body}`;
  }).join('\n');

  const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const totalMensagens = mensagens.length;
  const doCliente = mensagens.filter(m => m.role === 'client').length;
  const doEscritorio = totalMensagens - doCliente;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 700,
    messages: [{
      role: 'user',
      content: `Você é o sistema de registro do escritório do Dr. Wesley Veiga (advogado).
Abaixo está a conversa do dia ${hoje} com o contato "${name || phone}" (${phone}).
Total de mensagens: ${totalMensagens} (${doCliente} do cliente, ${doEscritorio} do escritório).

CONVERSA:
${transcript}

Gere um resumo estruturado no seguinte formato exato (sem emojis, sem travessão, linguagem formal):

RESUMO — ${hoje} — ${name || phone}
Assunto principal: [tema central da conversa em uma linha]
Mensagens trocadas: [quantidade e síntese dos pontos levantados pelo cliente]
Ações do escritório: [o que a Iara ou o Dr. Wesley respondeu, comprometeu ou encaminhou]
Pendências: [o que ficou em aberto, se houver; caso contrário escreva "Nenhuma"]
Próximos passos: [o que precisa ser feito a seguir, se identificado; caso contrário escreva "A definir"]
Tom da conversa: [ex.: urgente, informativo, agradecido, tenso, rotineiro]`,
    }],
  });

  const block = response.content[0];
  return block && block.type === 'text' ? block.text.trim() : `RESUMO — ${hoje} — ${name || phone}\nAssunto principal: conversa registrada.\nMensagens trocadas: ${totalMensagens} mensagens.\nAções do escritório: —\nPendências: A verificar\nPróximos passos: A definir\nTom da conversa: —`;
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
