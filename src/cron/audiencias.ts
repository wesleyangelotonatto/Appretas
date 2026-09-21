import { getCardsAudiencias, adicionarNotaCard } from '../integrations/trello';
import { sendMessage } from '../responder/send';
import { lookupSheets } from '../lookup/sheets';

// 3 ALERTAS:
// 1º: quando card é criado (disparado pelo orchestrator ao detectar novo card)
// 2º: sexta-feira — audiências da próxima semana
// 3º: véspera (dia anterior) da audiência

// Reduz uma data ao ano/mês/dia em São Paulo, fixado à meia-noite UTC — permite
// subtrair getTime() com segurança para obter diferença exata de dias em calendário
function toSaoPauloDateOnly(date: Date): Date {
  const spString = date.toLocaleString('en-US', { timeZone: process.env.TZ_APP || 'America/Sao_Paulo' });
  const sp = new Date(spString);
  return new Date(Date.UTC(sp.getFullYear(), sp.getMonth(), sp.getDate()));
}

export async function cronAudiencias(): Promise<void> {
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: process.env.TZ_APP || 'America/Sao_Paulo' }));
  const dayOfWeek = today.getDay(); // 5 = sexta
  const todayDateOnly = toSaoPauloDateOnly(new Date());

  const cards = await getCardsAudiencias();

  for (const card of cards) {
    try {
      // Extrai data da audiência da descrição do card
      const audienciaDate = extractDateFromCard(card);
      if (!audienciaDate) continue;

      const phone = extractPhoneFromCard(card);
      if (!phone) continue;

      const contact = await lookupSheets(phone);
      const clientName = contact?.name || 'cliente';

      // Diferença em dias de calendário (São Paulo), não em horas cruas — evita
      // desvio de fuso horário entre o epoch de "today" (já deslocado) e audienciaDate (UTC real)
      const daysUntil = Math.round((toSaoPauloDateOnly(audienciaDate).getTime() - todayDateOnly.getTime()) / 86400000);

      // 2º aviso: sexta-feira, audiências da próxima semana (7 dias)
      if (dayOfWeek === 5 && daysUntil > 0 && daysUntil <= 7) {
        const msg = formatAudienciaAlert(card, audienciaDate, clientName, 2);
        await sendMessage(phone, msg);
        await adicionarNotaCard(card.id, `[IARA] 2º aviso de audiência enviado ao cliente em ${new Date().toLocaleDateString('pt-BR')}`);
      }

      // 3º aviso: véspera (1 dia antes)
      if (daysUntil === 1) {
        const msg = formatAudienciaAlert(card, audienciaDate, clientName, 3);
        await sendMessage(phone, msg);
        await adicionarNotaCard(card.id, `[IARA] 3º aviso de audiência enviado ao cliente em ${new Date().toLocaleDateString('pt-BR')}`);
      }
    } catch (err) {
      console.error('[cron-audiencias] erro ao processar card:', card.id, err);
    }
  }
}

function formatAudienciaAlert(card: any, date: Date, clientName: string, alertNumber: number): string {
  const dateStr = date.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  const processInfo = extractProcessFromCard(card);

  if (alertNumber === 2) {
    return `Olá, tudo bem? Aqui é a Iara Secretária do Dr. Wesley. Estou passando para lembrar que na próxima semana tem uma audiência no fórum relacionada ao seu processo${processInfo ? ` (${processInfo})` : ''}, marcada para ${dateStr}. Vou verificar com o Doutor se é obrigatória sua participação e te informo. Qualquer dúvida, estou à disposição!`;
  }

  return `Olá, tudo bem? Aqui é a Iara Secretária do Dr. Wesley. Passando para lembrar que AMANHÃ tem audiência no fórum relacionada ao seu processo${processInfo ? ` (${processInfo})` : ''}. Data: ${dateStr}. Vou verificar com o Doutor se é obrigatória sua participação. Qualquer dúvida, estou à disposição!`;
}

function extractDateFromCard(card: any): Date | null {
  // Tenta extrair do due date do card
  if (card.due) {
    return new Date(card.due);
  }
  // Tenta extrair da descrição (formatos comuns: DD/MM/YYYY)
  const desc = card.desc || card.name || '';
  const dateMatch = desc.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dateMatch) {
    return new Date(`${dateMatch[3]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[1].padStart(2, '0')}`);
  }
  return null;
}

function extractPhoneFromCard(card: any): string | null {
  const desc = card.desc || '';
  const phoneMatch = desc.match(/(?:telefone|fone|celular|whatsapp)[:\s]+(\d+)/i) ||
    desc.match(/(55\d{10,11}|\d{10,11})/i);
  return phoneMatch ? phoneMatch[1].replace(/[^0-9]/g, '') : null;
}

function extractProcessFromCard(card: any): string | null {
  const combined = `${card.name} ${card.desc}`;
  const match = combined.match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/);
  return match ? match[0] : null;
}
