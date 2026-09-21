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

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Você é o sistema de registro do escritório do Dr. Wesley Veiga.
Abaixo está a conversa do dia ${hoje} com o contato "${name || phone}" (${phone}).

CONVERSA:
${transcript}

Gere um resumo conciso em UMA frase de até 2 linhas, no formato:
"Resumo do dia ${hoje}: [nome] tratou sobre [assunto principal]. [situação/resultado se houver]"

Regras: sem emojis, sem travessão, linguagem formal e direta.`,
    }],
  });

  const block = response.content[0];
  return block && block.type === 'text' ? block.text.trim() : `Resumo do dia ${hoje}: conversa registrada com ${name || phone}.`;
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
