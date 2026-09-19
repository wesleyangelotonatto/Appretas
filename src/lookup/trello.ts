import axios from 'axios';

const BASE = 'https://api.trello.com/1';
const KEY = () => process.env.TRELLO_API_KEY || '';
const TOKEN = () => process.env.TRELLO_API_TOKEN || '';
const BOARD_ID = () => process.env.TRELLO_BOARD_OPERACIONAL_ID || '';

function auth() {
  return { key: KEY(), token: TOKEN() };
}

export async function lookupTrello(phone: string): Promise<{ name: string; phone: string; processes: string[] } | null> {
  try {
    const normalizedPhone = phone.replace(/[^0-9]/g, '');

    const listsRes = await axios.get(`${BASE}/boards/${BOARD_ID()}/lists`, { params: auth() });
    const lists: any[] = listsRes.data;

    for (const list of lists) {
      const cardsRes = await axios.get(`${BASE}/lists/${list.id}/cards`, { params: auth() });
      const cards: any[] = cardsRes.data;

      for (const card of cards) {
        const desc = String(card.desc || '');
        const title = String(card.name || '');
        const combined = `${title} ${desc}`;

        // Procura pelo número de telefone nos campos do card
        const phoneInCard = combined.replace(/[^0-9]/g, '');
        if (
          phoneInCard.includes(normalizedPhone) ||
          normalizedPhone.includes(phoneInCard.slice(-8))
        ) {
          // Extrai nome do card (tenta descrição primeiro, depois título)
          const name = extractNameFromCard(title, desc);
          const processes = extractProcessNumbers(desc);
          return { name, phone: normalizedPhone, processes };
        }
      }
    }

    return null;
  } catch (err) {
    console.error('[trello-lookup] erro:', err);
    return null;
  }
}

function extractNameFromCard(title: string, desc?: string): string {
  // Tenta encontrar "Nome:", "Cliente:" ou "Parte:" na descrição do card
  if (desc) {
    const match = desc.match(/(?:nome|cliente|parte|requerente|autor)[:\s]+([^\n\r,]+)/i);
    if (match) return match[1].trim();
  }
  // Remove números de processo do título e retorna o restante
  const cleaned = title.replace(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/g, '').trim();
  // Se o título contém " X " (modelo "Parte A X Parte B"), pega só a primeira parte
  const xSplit = cleaned.split(/ x /i);
  return xSplit[0].trim() || title;
}

function extractProcessNumbers(text: string): string[] {
  // Formato CNJ: NNNNNNN-DD.AAAA.J.TT.OOOO
  const pattern = /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/g;
  return text.match(pattern) || [];
}
