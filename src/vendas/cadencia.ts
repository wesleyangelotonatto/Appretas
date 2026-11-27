// Cadências de follow-up de leads (plano 5.1). SÓ funcionam com a função Vendas LIGADA;
// em treino ou desligada nada acontece (4.4.1: treino não dispara follow-up).
// Cada toque traz algo novo, passa pelo revisor e respeita 08h–21h e a pausa geral.
// Lead que respondeu reinicia a cadência a partir da última fala dele.
import { getDb } from '../memory/db';
import { posicaoVendas, redigirVendas, revisar } from './vendas';
import { sugerirEtapa } from '../integrations/crm';
import { sendMessage } from '../responder/send';
import { saveMessage, savePendingApproval } from '../memory/db';

type Toque = { dia: number; instrucao: string; depois?: { etapa: string; obs: string } };

export const CADENCIAS: Record<string, Toque[]> = {
  padrao: [
    { dia: 1, instrucao: 'D1: retome o ponto em que a conversa parou, com uma pergunta simples.' },
    { dia: 3, instrucao: 'D3: traga uma informação nova útil para o caso dele (um prazo, um documento, um exemplo).' },
    { dia: 7, instrucao: 'D7: mude o formato — conte em poucas linhas um caso parecido (sem nomes) ou ofereça uma ligação curta com o Dr. Wesley.' },
    { dia: 14, instrucao: 'D14: lembre o que está em jogo com um fato verdadeiro (prazo, valor que ele mencionou). Sem pressão.' },
    { dia: 21, instrucao: 'D21: mensagem de encerramento — diga com gentileza que vai parar de incomodar e deixe a porta aberta.', depois: { etapa: '13', obs: 'Cadência de 21 dias encerrada sem resposta' } },
  ],
  '09': [
    { dia: 2, instrucao: 'Decidindo D2: check-in com uma pergunta de decisão (o que falta para ele decidir?).' },
    { dia: 5, instrucao: 'Decidindo D5: prova e segurança — ofereça casos parecidos (o Dr. Wesley envia) ou explique uma garantia (honorário no êxito, procuração com limite).' },
    { dia: 7, instrucao: 'Decidindo D7: convide para uma conversa rápida com o Dr. Wesley por ligação.', depois: { etapa: '04', obs: 'Decidindo sem resposta no D7: oferecer ligação' } },
    { dia: 14, instrucao: 'Decidindo D14: última condição ou urgência REAL (só fato verdadeiro).' },
    { dia: 21, instrucao: 'Decidindo D21: encerramento gentil, porta aberta.', depois: { etapa: '13', obs: 'Decidindo: 21 dias sem decisão' } },
  ],
  '08': [1, 3, 7].map(d => ({ dia: d, instrucao: `Proposta enviada D${d}: retome a proposta, tire uma dúvida provável, pergunte o que achou.` })),
  '10': [1, 3, 7].map(d => ({ dia: d, instrucao: `Contrato/procuração D${d}: lembre com gentileza de assinar e devolver; ofereça ajuda com a assinatura.` })),
  '04': [1, 3].map(d => ({ dia: d, instrucao: `Agendar D${d}: ofereça dois horários concretos para a conversa com o Dr. Wesley.` })),
  '05': [2, 4, 6, 8, 10, 12].map(d => ({ dia: d, instrucao: `Documentos D${d}: peça só o que ainda falta (veja a ficha), um de cada vez, explicando como conseguir.` })),
};

function tabela() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS vendas_toques (
    id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, cadencia TEXT NOT NULL, indice INTEGER NOT NULL,
    base INTEGER NOT NULL, status TEXT, enviado_em INTEGER DEFAULT (unixepoch()))`);
}

// Mesmo contato pode estar gravado com ou sem o 9 extra
function variantes(tel: string): string[] {
  const t = tel.replace(/\D/g, '');
  const v = new Set([t]);
  if (t.startsWith('55') && t.length === 13) v.add(t.slice(0, 4) + t.slice(5));
  if (t.startsWith('55') && t.length === 12) v.add(t.slice(0, 4) + '9' + t.slice(4));
  return [...v];
}

function horaSP(): number { return Number(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false })); }

export async function rodarCadencias(): Promise<{ enviados: number; analisados: number }> {
  if (posicaoVendas() !== 'ligada') return { enviados: 0, analisados: 0 };
  const h = horaSP();
  if (h < 8 || h >= 21) return { enviados: 0, analisados: 0 };
  tabela();
  const url = process.env.CRM_URL, chave = process.env.CRM_API_KEY;
  if (!url || !chave) return { enviados: 0, analisados: 0 };
  const r = await fetch(url.replace(/\/$/, '') + '/api/integracao/leads-ativos', { headers: { 'x-api-key': chave }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) return { enviados: 0, analisados: 0 };
  const { leads } = await r.json() as { leads: Array<{ tel: string; etapa: string; proximoPrazo: string | null; nome: string | null }> };
  const db = getDb();
  let enviados = 0;
  for (const lead of leads) {
    if (enviados >= 20) break; // no máximo 20 por rodada (proteção contra banimento, 5.4)
    const fones = variantes(lead.tel);
    const ph = fones.map(() => '?').join(',');
    const msgs = db.prepare(`SELECT phone, role, body, created_at FROM messages WHERE phone IN (${ph}) ORDER BY created_at`).all(...fones) as any[];
    if (!msgs.length) continue;
    const phone = msgs[msgs.length - 1].phone;
    const ultCliente = [...msgs].reverse().find(m => m.role === 'client');
    const ultimo = msgs[msgs.length - 1];
    if (!ultCliente || ultimo.role === 'client') continue; // lead falou por último: é resposta, não follow-up
    const chaveCad = lead.etapa === '01' ? 'padrao' : lead.etapa;
    // 12 Retornar em: um toque na data combinada
    const cad: Toque[] = lead.etapa === '12'
      ? (lead.proximoPrazo ? [{ dia: Math.max(0, Math.round((Date.parse(lead.proximoPrazo + 'T08:00:00-03:00') / 1000 - ultCliente.created_at) / 86400)), instrucao: 'Retorno combinado: retome na data que ele pediu, lembrando o que ficou combinado.' }] : [])
      : (CADENCIAS[chaveCad] || []);
    if (!cad.length) continue;
    const base = ultCliente.created_at;
    const feitos = (db.prepare('SELECT COUNT(*) n FROM vendas_toques WHERE phone = ? AND cadencia = ? AND base = ?').get(phone, chaveCad, base) as any).n;
    if (feitos >= cad.length) continue;
    // Intervalo mínimo de 20 h entre toques ao mesmo lead (inclui toque aguardando aprovação)
    const ultToque = (db.prepare('SELECT MAX(enviado_em) t FROM vendas_toques WHERE phone = ?').get(phone) as any).t;
    if (ultToque && Date.now() / 1000 - ultToque < 20 * 3600) continue;
    const t = cad[feitos];
    const dias = (Date.now() / 1000 - base) / 86400;
    if (dias < t.dia) continue;
    const hist = msgs.slice(-25).map(m => ({ role: m.role, body: m.body }));
    try {
      const rv0 = await redigirVendas(phone, ultCliente.body, hist, 'N', t.instrucao);
      const rv = rv0 ? await revisar(rv0, hist, lead.etapa) : null;
      if (!rv) continue;
      // Revisor não aprovou de primeira: o toque vai para a aprovação do Wesley em vez de sair
      if (!rv.revisao || !rv.revisao.ok || rv.revisao.reescrito) {
        savePendingApproval(phone, rv.mensagem, JSON.stringify({ funcao: 'vendas', modo: 'follow-up', produto: rv.produto, etapaAtual: lead.etapa,
          etapaSugerida: t.depois?.etapa || null, regra: 'Follow-up ' + chaveCad + ' D' + t.dia, revisao: rv.revisao || null, mensagemCliente: ultCliente.body.slice(0, 300) }));
        db.prepare('INSERT INTO vendas_toques (phone, cadencia, indice, base, status) VALUES (?, ?, ?, ?, ?)').run(phone, chaveCad, feitos, base, 'aprovacao');
        continue;
      }
      const s = await sendMessage(phone, rv.mensagem);
      db.prepare('INSERT INTO vendas_toques (phone, cadencia, indice, base, status) VALUES (?, ?, ?, ?, ?)').run(phone, chaveCad, feitos, base, s.status);
      if (s.status === 'enviado' || s.status === 'na_fila') {
        saveMessage(phone, 'iara', rv.mensagem);
        enviados++;
        if (t.depois) await sugerirEtapa(phone, t.depois.etapa, { observacao: t.depois.obs });
      }
    } catch (err) { console.error('[cadencia]', phone, (err as Error).message); }
  }
  return { enviados, analisados: leads.length };
}
