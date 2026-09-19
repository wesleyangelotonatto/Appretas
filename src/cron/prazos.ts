import { getCardsPrazos, adicionarNotaCard } from '../integrations/trello';
import { sendMessage } from '../responder/send';
import { lookupSheets } from '../lookup/sheets';

// Prazos: verifica lista PRAZOS no Trello todos os dias úteis às 08h
// Envia aviso ao cliente no dia do prazo

export async function cronPrazos(): Promise<void> {
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: process.env.TZ_APP || 'America/Sao_Paulo' }));

  const cards = await getCardsPrazos();

  for (const card of cards) {
    try {
      const prazoDate = extractDueDateFromCard(card);
      if (!prazoDate) continue;

      // Verifica se o prazo é hoje
      const isToday =
        prazoDate.getDate() === today.getDate() &&
        prazoDate.getMonth() === today.getMonth() &&
        prazoDate.getFullYear() === today.getFullYear();

      if (!isToday) continue;

      const phone = extractPhoneFromCard(card);
      if (!phone) continue;

      const contact = await lookupSheets(phone);
      const processInfo = extractProcessFromCard(card) || card.name;

      const msg = `Olá, tudo bem? Aqui é a Iara Secretária do Dr. Wesley. Somente passando pra te avisar que na data de hoje nós vamos cumprir um prazo aqui no seu processo (${processInfo}). Não é nada pra se preocupar. É só pra te mostrar que estamos cuidando do processo e dando andamento nele. Obrigado, qualquer dúvida fico à disposição.`;

      await sendMessage(phone, msg);
      await adicionarNotaCard(card.id, `[IARA] Aviso de prazo enviado ao cliente em ${today.toLocaleDateString('pt-BR')}`);

      console.log(`[cron-prazos] aviso enviado para ${contact?.name || phone}`);
    } catch (err) {
      console.error('[cron-prazos] erro ao processar card:', card.id, err);
    }
  }
}

function extractDueDateFromCard(card: any): Date | null {
  if (card.due) return new Date(card.due);

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
