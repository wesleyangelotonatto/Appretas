import axios from 'axios';

const BASE = 'https://api.trello.com/1';
const KEY = () => process.env.TRELLO_API_KEY || '';
const TOKEN = () => process.env.TRELLO_API_TOKEN || '';
const BOARD_OP = () => process.env.TRELLO_BOARD_OPERACIONAL_ID || '';
const BOARD_VENDAS = () => process.env.TRELLO_BOARD_VENDAS_ID || '';

function auth() {
  return { key: KEY(), token: TOKEN() };
}

export async function buscarCardTrello(processoNumero: string): Promise<any | null> {
  try {
    const listsRes = await axios.get(`${BASE}/boards/${BOARD_OP()}/lists`, { params: auth() });
    for (const list of listsRes.data) {
      const cardsRes = await axios.get(`${BASE}/lists/${list.id}/cards`, { params: auth() });
      for (const card of cardsRes.data) {
        if (
          card.name?.includes(processoNumero) ||
          card.desc?.includes(processoNumero)
        ) {
          return card;
        }
      }
    }
    return null;
  } catch (err) {
    console.error('[trello] erro ao buscar card:', err);
    return null;
  }
}

// Busca um card pelo nome da parte e, se informado, da parte contrária (usado quando o cliente
// não sabe o número do processo, mas informa nome completo + contra quem é o processo)
export async function buscarCardPorNomes(nomeParte: string, nomeContraParte?: string): Promise<any | null> {
  try {
    const alvo1 = nomeParte.toLowerCase().trim();
    const alvo2 = nomeContraParte?.toLowerCase().trim();

    const listsRes = await axios.get(`${BASE}/boards/${BOARD_OP()}/lists`, { params: auth() });
    for (const list of listsRes.data) {
      const cardsRes = await axios.get(`${BASE}/lists/${list.id}/cards`, { params: auth() });
      for (const card of cardsRes.data) {
        const combined = `${card.name || ''} ${card.desc || ''}`.toLowerCase();
        const temParte1 = combined.includes(alvo1);
        const temParte2 = alvo2 ? combined.includes(alvo2) : true;
        if (temParte1 && temParte2) {
          return card;
        }
      }
    }
    return null;
  } catch (err) {
    console.error('[trello] erro ao buscar card por nomes:', err);
    return null;
  }
}

export async function atualizarCardTrello(cardId: string, updates: { name?: string; desc?: string; idList?: string }): Promise<void> {
  await axios.put(`${BASE}/cards/${cardId}`, { ...updates, ...auth() });
}

export async function adicionarNotaCard(cardId: string, nota: string): Promise<void> {
  await axios.post(`${BASE}/cards/${cardId}/actions/comments`, {
    text: nota,
    ...auth(),
  });
}

interface LeadData {
  name: string;
  phone: string;
  summary: string;
  type: string;
}

export async function criarCardLead(data: LeadData): Promise<string> {
  try {
    // Pega a primeira lista do board de Vendas
    const listsRes = await axios.get(`${BASE}/boards/${BOARD_VENDAS()}/lists`, { params: auth() });
    const firstList = listsRes.data[0];
    if (!firstList) throw new Error('Board Vendas sem listas');

    const desc = [
      `📱 Telefone: ${data.phone}`,
      `📋 Tipo: ${data.type}`,
      `💬 Resumo: ${data.summary}`,
      `🕒 Recebido: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
    ].join('\n');

    const res = await axios.post(`${BASE}/cards`, {
      name: data.name,
      desc,
      idList: firstList.id,
      ...auth(),
    });

    return res.data.id;
  } catch (err) {
    console.error('[trello] erro ao criar card lead:', err);
    return '';
  }
}

export async function getCardsAudiencias(): Promise<any[]> {
  return getCardsFromList('audiência');
}

export async function getCardsPrazos(): Promise<any[]> {
  return getCardsFromList('prazo');
}

async function getCardsFromList(keyword: string): Promise<any[]> {
  try {
    const listsRes = await axios.get(`${BASE}/boards/${BOARD_OP()}/lists`, { params: auth() });
    const targetList = listsRes.data.find((l: any) =>
      l.name.toLowerCase().includes(keyword)
    );
    if (!targetList) return [];

    const cardsRes = await axios.get(`${BASE}/lists/${targetList.id}/cards`, { params: auth() });
    return cardsRes.data;
  } catch (err) {
    console.error(`[trello] erro ao buscar lista ${keyword}:`, err);
    return [];
  }
}
