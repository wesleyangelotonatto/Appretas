// Leitura dos dados de um card de audiência/prazo. A data pode estar no campo de
// vencimento, na descrição, num comentário da equipe ou num item de checklist —
// e nem sempre concordam entre si. Por isso aqui nada é decidido sozinho: as
// datas encontradas são devolvidas com a origem e o trecho de onde vieram, para
// que Wesley confirme qual vale antes de qualquer mensagem sair.

import { getCardComentarios, getCardChecklists } from '../integrations/trello';

export interface DataEncontrada {
  origem: 'vencimento' | 'descrição' | 'comentário' | 'checklist';
  dataIso: string;
  trecho: string;
}

const MESES: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, março: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

function iso(ano: number, mes: number, dia: number, hora = 0, min = 0): string | null {
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  const d = new Date(Date.UTC(ano, mes - 1, dia, hora + 3, min)); // -03 São Paulo
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function trechoAoRedor(texto: string, indice: number): string {
  return texto.slice(Math.max(0, indice - 60), indice + 90).replace(/\s+/g, ' ').trim();
}

// Datas em um texto livre, nos formatos que aparecem nos cards
export function extrairDatasDeTexto(texto: string, origem: DataEncontrada['origem']): DataEncontrada[] {
  const achadas: DataEncontrada[] = [];
  const t = texto || '';

  // 25/09/2026 e 25/09/26, com hora opcional
  const reNumerica = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[\s,]+(?:às?\s*)?(\d{1,2})[:h](\d{2}))?/gi;
  for (const m of t.matchAll(reNumerica)) {
    const ano = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
    const s = iso(ano, parseInt(m[2]), parseInt(m[1]), m[4] ? parseInt(m[4]) : 0, m[5] ? parseInt(m[5]) : 0);
    if (s) achadas.push({ origem, dataIso: s, trecho: trechoAoRedor(t, m.index ?? 0) });
  }

  // 25 de setembro de 2026 às 14:30
  const reExtenso = /(\d{1,2})\s+de\s+([a-zçã]+)\s+de\s+(\d{4})(?:\s*(?:às?|as)\s*(\d{1,2})[:h](\d{2}))?/gi;
  for (const m of t.matchAll(reExtenso)) {
    const mes = MESES[m[2].toLowerCase()];
    if (!mes) continue;
    const s = iso(parseInt(m[3]), mes, parseInt(m[1]), m[4] ? parseInt(m[4]) : 0, m[5] ? parseInt(m[5]) : 0);
    if (s) achadas.push({ origem, dataIso: s, trecho: trechoAoRedor(t, m.index ?? 0) });
  }

  return achadas;
}

export function extrairNumeroProcesso(texto: string): string | null {
  const t = String(texto || '');
  const cnj = t.match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/);
  if (cnj) return cnj[0];
  // Alguns cards escrevem o número sem pontuação (20 dígitos seguidos)
  const cru = t.match(/(?<!\d)\d{20}(?!\d)/);
  return cru ? cru[0] : null;
}

// Reúne tudo que o card tem a dizer sobre datas, dizendo de onde veio cada uma
export async function coletarDatasDoCard(card: any): Promise<DataEncontrada[]> {
  const todas: DataEncontrada[] = [];

  if (card.due) {
    todas.push({ origem: 'vencimento', dataIso: new Date(card.due).toISOString(), trecho: 'campo de vencimento do card' });
  }
  todas.push(...extrairDatasDeTexto(card.desc || '', 'descrição'));

  // Comentários e checklists costumam vir junto do card (ver getCardsFromList).
  // Só busca separado quando não vieram — uma requisição por card estourava o
  // limite do Trello e devolvia tudo vazio.
  const comentarios: string[] = Array.isArray(card.actions)
    ? card.actions.filter((a: any) => a?.type === 'commentCard').map((a: any) => String(a?.data?.text || ''))
    : await getCardComentarios(card.id || card.shortLink || '');

  const itensChecklist: string[] = Array.isArray(card.checklists)
    ? card.checklists.flatMap((cl: any) => (cl?.checkItems || []).map((it: any) => String(it?.name || '')))
    : await getCardChecklists(card.id || card.shortLink || '');

  for (const c of comentarios) if (c) todas.push(...extrairDatasDeTexto(c, 'comentário'));
  for (const i of itensChecklist) if (i) todas.push(...extrairDatasDeTexto(i, 'checklist'));

  // Ordena da mais próxima para a mais distante, sem descartar nenhuma
  return todas.sort((a, b) => a.dataIso.localeCompare(b.dataIso));
}
