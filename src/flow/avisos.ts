// Monta os avisos de audiência e prazo para Wesley revisar. Nada é enviado aqui:
// cada aviso entra na fila de confirmação com TODAS as datas encontradas no card
// e a origem de cada uma, porque elas divergem com frequência (vencimento do card
// x comentário da equipe x item de checklist) e quem decide qual vale é ele.

import { getCardsAudiencias, getCardsPrazos } from '../integrations/trello';
import { carregarPlanilha, acharPorProcesso } from '../lookup/sheets';
import { coletarDatasDoCard, extrairNumeroProcesso, DataEncontrada } from './dadosCard';
import { salvarAvisoPendente } from '../memory/db';

const TZ = () => process.env.TZ_APP || 'America/Sao_Paulo';

export function formatarData(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { timeZone: TZ(), day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function formatarHora(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { timeZone: TZ(), hour: '2-digit', minute: '2-digit' });
}

export function montarMensagem(tipo: string, nome: string, dataIso: string, processo: string): string {
  const data = formatarData(dataIso);
  const hora = formatarHora(dataIso);
  const tratamento = nome ? `Olá, ${nome}!` : 'Olá!';

  if (tipo === 'audiencia') {
    // Meia-noite quase sempre significa que a hora não foi informada na fonte
    const quando = hora === '00:00' ? `o dia ${data}` : `o dia ${data}, às ${hora}`;
    return `${tratamento} Passando para lembrar que a audiência do seu processo está marcada para ${quando}. ` +
      `Qualquer dúvida sobre o que vai acontecer nela, pode me chamar aqui que eu explico.`;
  }

  return `${tratamento} Passando para avisar que temos um prazo a cumprir no seu processo (${processo}) até ${data}. ` +
    `Não é nada para se preocupar: é só para você saber que estamos cuidando e dando andamento. Fico à disposição.`;
}

export interface ResultadoVarredura {
  criados: number;
  semCliente: Array<{ card: string; processo: string }>;
  semData: Array<{ card: string }>;
}

export async function gerarAvisosParaConfirmacao(dias = 15): Promise<ResultadoVarredura> {
  const agora = Date.now();
  const limite = agora + dias * 86400000;
  const planilha = await carregarPlanilha();

  const res: ResultadoVarredura = { criados: 0, semCliente: [], semData: [] };

  for (const [tipo, buscar] of [['audiencia', getCardsAudiencias], ['prazo', getCardsPrazos]] as const) {
    const cards = await buscar();

    for (const card of cards) {
      const datas: DataEncontrada[] = await coletarDatasDoCard(card);
      const naJanela = datas.filter(d => {
        const t = new Date(d.dataIso).getTime();
        return t >= agora - 86400000 && t <= limite;
      });
      if (!naJanela.length) continue;

      const processo = extrairNumeroProcesso(`${card.name || ''} ${card.desc || ''}`);
      if (!processo) {
        res.semData.push({ card: String(card.name || '').slice(0, 90) });
        continue;
      }

      const cliente = acharPorProcesso(planilha, processo);
      if (!cliente || !cliente.phone) {
        res.semCliente.push({ card: String(card.name || '').slice(0, 90), processo });
        continue;
      }

      // Sugere a data mais próxima, mas todas vão para a tela — Wesley escolhe
      const sugerida = naJanela[0].dataIso;
      const criado = salvarAvisoPendente({
        tipo,
        cardId: String(card.id || ''),
        cardNome: String(card.name || '').slice(0, 200),
        processo,
        phone: cliente.phone,
        nome: cliente.name,
        datasJson: JSON.stringify(naJanela),
        mensagem: montarMensagem(tipo, cliente.name, sugerida, processo),
      });
      if (criado) res.criados++;
    }
  }

  return res;
}
