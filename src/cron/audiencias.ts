import { getCardsAudiencias, extrairTelefoneDeTexto } from '../integrations/trello';
import { sendMessage, anotarNoTrelloAoConfirmar } from '../responder/send';
import { lookupSheets, lookupSheetsPorProcesso } from '../lookup/sheets';

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

      let phone = extrairTelefoneDeTexto(card.desc || '');
      let clientName = 'cliente';

      if (phone) {
        const contact = await lookupSheets(phone);
        clientName = contact?.name || 'cliente';
      } else {
        // Sem telefone no card — tenta encontrar pelo número do processo na planilha
        const processo = extractProcessFromCard(card);
        if (!processo) {
          console.warn(`[cron-audiencias] card sem telefone e sem processo: "${card.name}"`);
          continue;
        }
        const contact = await lookupSheetsPorProcesso(processo);
        if (!contact?.phone) {
          console.warn(`[cron-audiencias] processo ${processo} não encontrado na planilha — card: "${card.name}"`);
          continue;
        }
        phone = contact.phone;
        clientName = contact.name || 'cliente';
        console.log(`[cron-audiencias] telefone via planilha para "${card.name}": ${phone} (${clientName})`);
      }

      // Diferença em dias de calendário (São Paulo), não em horas cruas — evita
      // desvio de fuso horário entre o epoch de "today" (já deslocado) e audienciaDate (UTC real)
      const daysUntil = Math.round((toSaoPauloDateOnly(audienciaDate).getTime() - todayDateOnly.getTime()) / 86400000);

      // Audiência na segunda-feira: a véspera cai no domingo, fora da janela de envio
      // (dias úteis). O aviso de véspera sai na sexta, dizendo "na segunda-feira".
      const segundaVistaDaSexta = dayOfWeek === 5 && daysUntil === 3;

      // 2º aviso: sexta-feira, audiências da próxima semana (7 dias)
      if (dayOfWeek === 5 && daysUntil > 0 && daysUntil <= 7 && !segundaVistaDaSexta) {
        const msg = formatAudienciaAlert(card, audienciaDate, clientName, 2);
        const resultado = await sendMessage(phone, msg, { rotulo: '2º aviso de audiência' });
        anotarNoTrelloAoConfirmar(phone, resultado, card.id, `[IARA] 2º aviso de audiência enviado ao cliente em ${new Date().toLocaleDateString('pt-BR')}`, '2º aviso de audiência');
      }

      // 3º aviso: véspera (1 dia antes) — ou sexta, para audiência de segunda
      if (daysUntil === 1 || segundaVistaDaSexta) {
        const msg = formatAudienciaAlert(card, audienciaDate, clientName, 3, segundaVistaDaSexta);
        const resultado = await sendMessage(phone, msg, { rotulo: '3º aviso de audiência' });
        anotarNoTrelloAoConfirmar(phone, resultado, card.id, `[IARA] 3º aviso de audiência enviado ao cliente em ${new Date().toLocaleDateString('pt-BR')}`, '3º aviso de audiência');
      }
    } catch (err) {
      console.error('[cron-audiencias] erro ao processar card:', card.id, err);
    }
  }
}

// Retorna o nome do card como label legível para o cliente.
// Remove o número do processo do nome se ele aparecer lá (o cliente não sabe o número).
function processLabel(card: any): string {
  const nome = (card.name || '').trim();
  // Retira número de processo no formato 0000000-00.0000.0.00.0000 do nome
  return nome.replace(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\s*[-–]?\s*/g, '').trim() || nome;
}

function formatAudienciaAlert(card: any, date: Date, clientName: string, alertNumber: number, naSegunda = false): string {
  const dateStr = date.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: process.env.TZ_APP || 'America/Sao_Paulo' });
  const label = processLabel(card);

  if (alertNumber === 2) {
    return `Olá, tudo bem? Aqui é a Iara Secretária do Dr. Wesley. Estou passando para lembrar que na próxima semana tem uma audiência no fórum relacionada ao processo ${label}, marcada para ${dateStr}. Vou verificar com o Doutor se é obrigatória sua participação e te informo. Qualquer dúvida, estou à disposição!`;
  }

  return `Olá, tudo bem? Aqui é a Iara Secretária do Dr. Wesley. Passando para lembrar que ${naSegunda ? 'NA SEGUNDA-FEIRA' : 'AMANHÃ'} tem audiência no fórum relacionada ao processo ${label}. Data: ${dateStr}. Vou verificar com o Doutor se é obrigatória sua participação. Qualquer dúvida, estou à disposição!`;
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
    // Meio-dia em São Paulo (15h UTC): "AAAA-MM-DD" puro vira meia-noite UTC, que em
    // São Paulo ainda é o dia anterior — o aviso saía um ou dois dias antes
    return new Date(Date.UTC(parseInt(dateMatch[3], 10), parseInt(dateMatch[2], 10) - 1, parseInt(dateMatch[1], 10), 15, 0, 0));
  }
  return null;
}


function extractProcessFromCard(card: any): string | null {
  const combined = `${card.name} ${card.desc}`;
  const match = combined.match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/);
  return match ? match[0] : null;
}
