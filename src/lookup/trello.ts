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
          // Extrai nome do título do card (geralmente "Nome da Parte")
          const name = extractNameFromCard(title);
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

function extractNameFromCard(title: string): string {
  // Remove números de processo e termos comuns, pega o nome
  return title.replace(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/g, '').trim() || title;
}

function extractProcessNumbers(text: string): string[] {
  // Formato CNJ: NNNNNNN-DD.AAAA.J.TT.OOOO
  const pattern = /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/g;
  return text.match(pattern) || [];
}
