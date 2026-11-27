// Cadências de follow-up de leads (plano 5.1). SÓ funcionam com a função Vendas LIGADA;
// em treino ou desligada nada acontece (4.4.1: treino não dispara follow-up).
// Cada toque traz algo novo, passa pelo revisor e respeita 08h–21h e a pausa geral.
// Lead que respondeu reinicia a cadência a partir da última fala dele.
import { getDb } from '../memory/db';
import { sugerirEtapa } from '../integrations/crm';
import { sendMessage } from '../responder/send';
import { saveMessage, savePendingApproval } from '../memory/db';

import { criarMensagem } from '../ia';
import { getSetting, setSetting } from '../memory/db';
import { TEXTOS_PADRAO, ROTULO_ETAPA, ToqueTexto } from './followupTextos';

export interface ConfigFollowup { ativo: boolean; etapas: Record<string, boolean>; textos: Record<string, ToqueTexto[]>; diasConversa: number }

export function configFollowup(): ConfigFollowup {
  let c: Partial<ConfigFollowup> = {};
  try { c = JSON.parse(getSetting('followup_config') || '{}'); } catch { /* padrão */ }
  const etapas: Record<string, boolean> = {};
  Object.keys(TEXTOS_PADRAO).forEach(e => { etapas[e] = c.etapas ? !!c.etapas[e] : (e === '01' || e === '09'); });
  return { ativo: !!c.ativo, etapas, textos: Object.assign({}, TEXTOS_PADRAO, c.textos || {}), diasConversa: Number(c.diasConversa) || 30 };
}

export function salvarConfigFollowup(c: Partial<ConfigFollowup>, quem: string) {
  const atual = configFollowup();
  const nova = { ...atual, ...c, etapas: { ...atual.etapas, ...(c.etapas || {}) }, textos: { ...atual.textos, ...(c.textos || {}) } };
  setSetting('followup_config', JSON.stringify(nova));
  setSetting('followup_config_em', JSON.stringify({ em: Date.now(), quem }));
  return nova;
}

export { ROTULO_ETAPA, TEXTOS_PADRAO };

// Preenche as lacunas do texto pronto com fatos da conversa. Não muda o resto do texto.
async function preencher(texto: string, hist: Array<{ role: string; body: string }>, nome: string | null, produto: string | null) {
  if (!/\{(\w+)\}/.test(texto)) return { texto, faltou: [] as string[] };
  const pedido = `Texto pronto de follow-up (NÃO reescreva; só substitua as lacunas entre chaves):
"${texto}"

Lacunas: {nome} = primeiro nome do contato; {produto} = o assunto (ex.: Proagro, seguro da lavoura, revisão do financiamento, leilão da terra);
{documento} = o documento que falta (com artigo, ex.: "da cédula"); {ponto} = em que parte a conversa parou (ex.: "do valor que o banco pagou");
{data} = um fato verdadeiro com data (prazo ou leilão) DITO na conversa.
Nome conhecido: ${nome || 'desconhecido'} · Produto: ${produto || 'desconhecido'}

Conversa (mais recente no fim):
${hist.slice(-20).map(m => (m.role === 'client' ? 'Lead' : 'Escritório') + ': ' + m.body).join('\n')}

Se o nome não for conhecido, tire a lacuna de forma natural (ex.: "Oi, seu {nome}!" vira "Oi!").
Se outra lacuna não puder ser preenchida com algo DITO na conversa, deixe-a como está e liste em "faltou".
Responda SOMENTE um JSON: {"texto": "...", "faltou": ["documento", ...]}`;
  const r = await criarMensagem('rapido', { max_tokens: 500, messages: [{ role: 'user', content: pedido }] });
  const b = r.content[0];
  const j = JSON.parse(((b && b.type === 'text' ? b.text : '').match(/\{[\s\S]*\}/) || ['{}'])[0]);
  const final = String(j.texto || '').trim();
  const faltou: string[] = Array.isArray(j.faltou) ? j.faltou : [];
  if (!final || /\{\w+\}/.test(final)) faltou.push('lacuna sem preencher');
  return { texto: final || texto, faltou };
}

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
  const cfg = configFollowup();
  if (!cfg.ativo) return { enviados: 0, analisados: 0 };
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
    if (!cfg.etapas[lead.etapa]) continue;
    // Só quem conversou nos últimos N dias (padrão 30)
    if (Date.now() / 1000 - ultCliente.created_at > cfg.diasConversa * 86400) continue;
    const chaveCad = lead.etapa;
    let cad: ToqueTexto[] = cfg.textos[chaveCad] || [];
    if (lead.etapa === '12') cad = lead.proximoPrazo ? cad.slice(0, 1).map(t => ({ ...t, dia: Math.max(0, Math.round((Date.parse(lead.proximoPrazo + 'T08:00:00-03:00') / 1000 - ultCliente.created_at) / 86400)) })) : [];
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
      const sessao = db.prepare('SELECT name FROM sessions WHERE phone = ?').get(phone) as any;
      const nome = lead.nome || (sessao && /[a-z]/i.test(sessao.name || '') ? sessao.name : null);
      const p = await preencher(t.texto, hist, nome, null);
      const regra = 'Follow-up ' + (ROTULO_ETAPA[chaveCad] || chaveCad) + ' D' + t.dia;
      if (p.faltou.length) {
        savePendingApproval(phone, p.texto, JSON.stringify({ funcao: 'vendas', modo: 'follow-up', etapaAtual: lead.etapa, etapaSugerida: t.depois || null,
          regra: regra + ' — completar: ' + p.faltou.join(', '), mensagemCliente: ultCliente.body.slice(0, 300) }));
        db.prepare('INSERT INTO vendas_toques (phone, cadencia, indice, base, status) VALUES (?, ?, ?, ?, ?)').run(phone, chaveCad, feitos, base, 'aprovacao');
        continue;
      }
      const s = await sendMessage(phone, p.texto);
      db.prepare('INSERT INTO vendas_toques (phone, cadencia, indice, base, status) VALUES (?, ?, ?, ?, ?)').run(phone, chaveCad, feitos, base, s.status);
      if (s.status === 'enviado' || s.status === 'na_fila') {
        saveMessage(phone, 'iara', p.texto);
        enviados++;
        if (t.depois) await sugerirEtapa(phone, t.depois, { observacao: regra + ': sem resposta' });
      }
    } catch (err) { console.error('[cadencia]', phone, (err as Error).message); }
  }
  return { enviados, analisados: leads.length };
}
