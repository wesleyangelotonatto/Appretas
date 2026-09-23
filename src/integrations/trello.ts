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
  try {
    await axios.put(`${BASE}/cards/${cardId}`, { ...updates, ...auth() });
  } catch (err) {
    console.error('[trello] erro ao atualizar card:', err);
  }
}

export async function adicionarNotaCard(cardId: string, nota: string): Promise<void> {
  try {
    await axios.post(`${BASE}/cards/${cardId}/actions/comments`, {
      text: nota,
      ...auth(),
    });
  } catch (err) {
    console.error('[trello] erro ao adicionar nota no card:', err);
  }
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

// Telefone do cliente na descrição do card. A versão anterior exigia dígitos
// colados logo após a palavra "Telefone", então o formato usado nos cards reais
// — "Telefone (44) 99112-0462" — não casava, e TODO card de audiência e prazo
// era descartado por falta de telefone. Aceita parênteses, espaços e traços, e
// evita confundir com CPF e número de processo, que não têm esse formato.
// Depois do rótulo, pega o trecho inteiro de caracteres de telefone e só então
// conta os dígitos — recortar por um formato fixo truncava números com o código
// do país ("whatsapp 5544991120462" virava 5544991120).
const RE_TELEFONE_ROTULADO = /(?:telefone|fone|celular|whats?\s?app|tel)\.?\s*[:\-]?\s*([\d().\s\-]{9,25})/i;
const RE_TELEFONE_COM_DDD = /(\(\d{2}\)\s*9?\d{4}[\s.\-]?\d{4})/;
const RE_TELEFONE_COLADO = /((?:55)?\d{10,11})(?!\d)/;

export function extrairTelefoneDeTexto(texto: string): string | null {
  const t = texto || '';
  for (const re of [RE_TELEFONE_ROTULADO, RE_TELEFONE_COM_DDD, RE_TELEFONE_COLADO]) {
    const m = t.match(re);
    if (!m) continue;
    const so = m[1].replace(/[^0-9]/g, '');
    // Menos de 10 dígitos não é telefone com DDD; mais de 13 é outra coisa
    // (ou dois números grudados) — nesse caso tenta o padrão seguinte
    if (so.length >= 10 && so.length <= 13) return so;
  }
  return null;
}

export async function getCardsAudiencias(): Promise<any[]> {
  return getCardsFromList('audiência');
}

export async function getCardsPrazos(): Promise<any[]> {
  return getCardsFromList('prazo');
}

function semAcento(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

async function getCardsFromList(keyword: string): Promise<any[]> {
  try {
    const listsRes = await axios.get(`${BASE}/boards/${BOARD_OP()}/lists`, { params: auth() });
    const kw = semAcento(keyword);

    // Pegar a PRIMEIRA lista que contém a palavra escolhia a lista errada: no
    // quadro real, "SOLICITAÇÃO INICIAL e pedidos SEM PRAZO" vem antes de
    // "PRAZO (atos com prazo)" — ou seja, os avisos de prazo liam justamente a
    // lista de itens SEM prazo. Agora descarta as negativas ("sem prazo") e
    // prefere a lista cujo nome COMEÇA com a palavra. Sem acento, para casar
    // "audiencia" com "AUDIÊNCIAS".
    const candidatas = listsRes.data.filter((l: any) => {
      const nome = semAcento(String(l.name || ''));
      return nome.includes(kw) && !nome.includes(`sem ${kw}`);
    });
    const targetList = candidatas.find((l: any) => semAcento(String(l.name)).startsWith(kw)) || candidatas[0];

    if (!targetList) {
      console.warn(`[trello] nenhuma lista corresponde a "${keyword}" — nenhum aviso será enviado`);
      return [];
    }
    console.log(`[trello] lista "${keyword}" -> "${targetList.name}"`);

    const cardsRes = await axios.get(`${BASE}/lists/${targetList.id}/cards`, { params: auth() });
    return cardsRes.data;
  } catch (err) {
    console.error(`[trello] erro ao buscar lista ${keyword}:`, err);
    return [];
  }
}
