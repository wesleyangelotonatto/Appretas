import { getCardsPrazos, adicionarNotaCard, extrairTelefoneDeTexto } from '../integrations/trello';
import { sendMessage } from '../responder/send';
import { lookupSheets, lookupSheetsPorProcesso } from '../lookup/sheets';

// Prazos: verifica lista PRAZOS no Trello todos os dias úteis às 08h
// Envia aviso ao cliente no dia do prazo

export async function cronPrazos(): Promise<void> {
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: process.env.TZ_APP || 'America/Sao_Paulo' }));

  const cards = await getCardsPrazos();

  for (const card of cards) {
    try {
      const prazoDateRaw = extractDueDateFromCard(card);
      if (!prazoDateRaw) continue;
      // Normaliza para o fuso de São Paulo antes de comparar — sem isso, comparar
      // getDate()/getMonth() de um Date com getters locais do servidor (UTC no Railway)
      // contra "today" (já em São Paulo) pode acusar prazo errado perto da meia-noite
      const prazoDate = new Date(prazoDateRaw.toLocaleString('en-US', { timeZone: process.env.TZ_APP || 'America/Sao_Paulo' }));

      // Verifica se o prazo é hoje
      const isToday =
        prazoDate.getDate() === today.getDate() &&
        prazoDate.getMonth() === today.getMonth() &&
        prazoDate.getFullYear() === today.getFullYear();

      if (!isToday) continue;

      let phone = extrairTelefoneDeTexto(card.desc || '');
      let clientName = '';
      // Usa o nome do card como label legível (partes + tipo de ação).
      // Remove número de processo se vier embutido no nome — o cliente não sabe o número.
      const processInfo = (card.name || '').replace(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\s*[-–]?\s*/g, '').trim() || card.name;

      if (phone) {
        const contact = await lookupSheets(phone);
        clientName = contact?.name || '';
      } else {
        // Sem telefone no card — tenta encontrar pelo número do processo na planilha
        const processo = extractProcessFromCard(card);
        if (!processo) {
          console.warn(`[cron-prazos] card sem telefone e sem processo: "${card.name}"`);
          continue;
        }
        const contact = await lookupSheetsPorProcesso(processo);
        if (!contact?.phone) {
          console.warn(`[cron-prazos] processo ${processo} não encontrado na planilha — card: "${card.name}"`);
          continue;
        }
        phone = contact.phone;
        clientName = contact.name || '';
        console.log(`[cron-prazos] telefone via planilha para "${card.name}": ${phone} (${clientName})`);
      }

      const msg = `Olá, tudo bem? Aqui é a Iara Secretária do Dr. Wesley. Somente passando pra te avisar que na data de hoje nós vamos cumprir um prazo aqui no seu processo (${processInfo}). Não é nada pra se preocupar. É só pra te mostrar que estamos cuidando do processo e dando andamento nele. Obrigado, qualquer dúvida fico à disposição.`;

      await sendMessage(phone, msg);
      await adicionarNotaCard(card.id, `[IARA] Aviso de prazo enviado ao cliente em ${today.toLocaleDateString('pt-BR')}`);

      console.log(`[cron-prazos] aviso enviado para ${clientName || phone}`);
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


function extractProcessFromCard(card: any): string | null {
  const combined = `${card.name} ${card.desc}`;
  const match = combined.match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/);
  return match ? match[0] : null;
}
