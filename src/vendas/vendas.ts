// Função Vendas (plano 4.4 e 4.14). Três posições: desligada / treino / ligada.
// Em TREINO (padrão) a Iara conduz o funil, mas nada é enviado ao lead: cada
// resposta vira rascunho para o Wesley aprovar, editar ou descartar, com a etapa,
// o POP e a regra usada. Sem efeitos colaterais (não muda etiqueta, não dispara
// follow-up, não anota no Trello): ela só SUGERE etapa e próximo passo.
import { criarMensagem } from '../ia';
import { buildSystemPrompt, aplicarGlossario } from '../persona';
import { getSetting, setSetting, getRecentCorrections, getDb } from '../memory/db';
import { fichaDoCRM, configDoCRM, FichaCRM } from '../integrations/crm';
import { PRINCIPIO, CONEXAO, QUEMFALA, OBJECOES, COMPORTAMENTO, COMANDO, COMUM } from './textosPlano';
import type { Genero } from '../persona';

export type PosicaoVendas = 'desligada' | 'treino' | 'ligada';

export function posicaoVendas(): PosicaoVendas {
  const v = getSetting('funcao_vendas');
  return v === 'desligada' || v === 'ligada' ? v : 'treino';
}

export function definirPosicaoVendas(p: PosicaoVendas, quem: string) {
  setSetting('funcao_vendas', p);
  setSetting('funcao_vendas_desde', JSON.stringify({ em: Date.now(), quem }));
}

const ETAPAS_VENDAS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '12', '13'];

// É da função Vendas: etiqueta ADS, etapa 01–13 (exceto 11) ou lead novo (4.4)
export function ehDaFuncaoVendas(ficha: FichaCRM | null, tipoClassificacao?: string): boolean {
  if (ficha?.etapa && ETAPAS_VENDAS.includes(ficha.etapa.codigo)) return true;
  if (ficha?.origem && /^ADS/i.test(ficha.origem)) return true;
  if (ficha?.etiquetas?.some(e => /^ADS\s/i.test(e))) return true;
  return tipoClassificacao === 'LEAD_NOVO' && !(ficha?.etapa?.codigo === '11');
}

interface Produto { id: string; nome: string; origem?: string; textoCompleto?: string; ativo?: boolean }

// Produto da conversa: o da ficha; senão, pela origem do anúncio ou pelas palavras
function escolherProduto(ficha: FichaCRM | null, produtos: Produto[], texto: string): Produto | null {
  const ativos = produtos.filter(p => p.ativo !== false);
  if (ficha?.produto) return ativos.find(p => p.id === ficha.produto) || null;
  const t = texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const regras: Array<[RegExp, string]> = [
    [/leil[a]o|edital|arremat/, 'defesa_de_imovel_rural_em_leilao'],
    [/revis|juros|cedula|renegocia/, 'revisao_de_cedulas_rurais'],
    [/proagro.*(demor|espera|ainda nao|sem resposta)|(demor|espera).*proagro/, 'proagro_demorando'],
    [/proagro/, 'proagro_negado'],
    [/maquina|trator|colheitadeira|plantadeira|pulverizador/, 'seguro_de_maquinas'],
    [/seguro|seguradora/, 'seguro_agricola_de_lavoura'],
  ];
  for (const [re, id] of regras) if (re.test(t)) { const p = ativos.find(x => x.id === id); if (p) return p; }
  return null;
}

export interface RascunhoVendas {
  mensagem: string;
  etapaSugerida: string | null;
  proximoPasso: string | null;
  regra: string | null;
  produto: string | null;
  incompleto: boolean;
}

function resumoFicha(f: FichaCRM | null): string {
  if (!f) return '(sem ficha no CRM)';
  const notas = (f.ligacoesENotas || []).slice(0, 6).map(n =>
    `- ${new Date(n.em).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} ${n.titulo}${n.detalhe ? ': ' + n.detalhe.slice(0, 300) : ''}`).join('\n');
  return [
    `Etapa: ${f.etapa ? `${f.etapa.nome} (há ${f.etapa.dias ?? '?'} dia(s)${f.etapa.atrasado ? ', parado além do prazo' : ''})` : 'sem etapa'}`,
    `Origem: ${f.origem || '-'}`,
    `Próximo passo combinado: ${f.proximo?.passo || '-'}${f.proximo?.prazo ? ' até ' + f.proximo.prazo : ''}`,
    `Etiquetas: ${(f.etiquetas || []).join(', ') || '-'}`,
    notas ? `Ligações e notas do escritório (leia antes de responder):\n${notas}` : '',
  ].filter(Boolean).join('\n');
}

export async function redigirVendas(phone: string, mensagemCliente: string, historico: Array<{ role: string; body: string }>, genero: Genero = 'N'): Promise<RascunhoVendas | null> {
  const [ficha, cfg] = await Promise.all([fichaDoCRM(phone), configDoCRM()]);
  const produtos = ((cfg as any)?.produtos?.produtos || []) as Produto[];
  const textoConversa = historico.map(m => m.body).join(' ') + ' ' + mensagemCliente;
  const produto = escolherProduto(ficha, produtos, textoConversa);

  // Parte fixa (em cache por 1 h): persona + comando de Vendas + regras + POP do produto
  const system = [
    buildSystemPrompt(genero),
    '\n\n=== FUNÇÃO VENDAS (siga estas orientações nesta conversa) ===\n',
    COMANDO, PRINCIPIO, CONEXAO, QUEMFALA, COMPORTAMENTO, OBJECOES, COMUM,
    produto ? `\n\n=== POP DO PRODUTO: ${produto.nome} ===\n${produto.textoCompleto || ''}` :
      '\n\n=== PRODUTO AINDA NÃO IDENTIFICADO ===\nDescubra com uma pergunta simples qual é a situação (Proagro, seguro, dívida do financiamento, leilão da terra) antes de seguir o roteiro.',
  ].join('\n');

  const correcoes = getRecentCorrections(10);
  const hist = historico.length
    ? historico.map(m => `${m.role === 'client' ? 'Cliente' : m.role === 'iara' ? 'Iara' : 'Dr. Wesley'}: ${m.body}`).join('\n')
    : '(primeira mensagem)';

  const pedido = `FICHA DO LEAD NO CRM:
${resumoFicha(ficha)}

HISTÓRICO DA CONVERSA:
${hist}

ÚLTIMA MENSAGEM DO LEAD:
"${mensagemCliente}"
${correcoes.length ? `\nCORREÇÕES RECENTES DO DR. WESLEY (prefira o estilo corrigido):\n${correcoes.map((c, i) => `${i + 1}. Original: "${c.original.slice(0, 400)}" → Corrigido: "${c.corrected.slice(0, 400)}"`).join('\n')}\n` : ''}
Redija a PRÓXIMA mensagem da Iara para este lead, seguindo a função Vendas e o POP.
Responda SOMENTE com um JSON, sem markdown:
{"mensagem": "texto para o WhatsApp, curto, uma ideia por vez",
 "etapa_sugerida": "código de 2 dígitos da etapa do funil que a conversa deve ter depois desta mensagem, ou null se continua",
 "proximo_passo": "o próximo passo combinado ou a combinar, em poucas palavras",
 "regra": "qual parte do roteiro você usou (ex.: 'POP Proagro negado, pergunta 3', 'objeção OB-A', 'pergunta de conexão')"}`;

  const r = await criarMensagem('resposta', { max_tokens: 900, system, cacheSystem: true, messages: [{ role: 'user', content: pedido }] });
  const bloco = r.content[0];
  const texto = bloco && bloco.type === 'text' ? bloco.text : '';
  const incompleto = r.stop_reason !== 'end_turn' && r.stop_reason !== 'stop_sequence';
  let j: any = null;
  try { j = JSON.parse((texto.match(/\{[\s\S]*\}/) || [texto])[0]); } catch { /* usa o texto puro */ }
  const mensagem = aplicarGlossario(String(j?.mensagem || texto || '').trim());
  if (!mensagem) return null;
  const etapa = j?.etapa_sugerida && /^\d{2}$/.test(String(j.etapa_sugerida)) ? String(j.etapa_sugerida) : null;
  return {
    mensagem, etapaSugerida: etapa, proximoPasso: j?.proximo_passo || null, regra: j?.regra || null,
    produto: produto?.nome || null, incompleto: incompleto || !j,
  };
}

// ===== Treino sobre conversas reais passadas (4.4.1) =====
// Para cada conversa de lead recente, pega um momento em que o lead falou e o
// escritório respondeu, gera o que a Iara diria ali e guarda os dois lado a lado.
// Nada é enviado. Função não essencial: respeita o teto diário de IA.
function garantirTabela() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS vendas_comparacao (
    id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL, nome TEXT, mensagem_cliente TEXT,
    resposta_real TEXT, quem_respondeu TEXT, rascunho_iara TEXT, produto TEXT, regra TEXT,
    etapa_sugerida TEXT, momento INTEGER, criado_em INTEGER DEFAULT (unixepoch()))`);
}

export async function reprocessarConversas(limite = 10, dias = 60): Promise<{ gerados: number; pulados: number; erros: number }> {
  garantirTabela();
  const { tetoEstourado } = await import('../ia');
  const db = getDb();
  const desde = Math.floor(Date.now() / 1000) - dias * 86400;
  const sessoes = db.prepare(`SELECT phone, name FROM sessions WHERE type = 'LEAD_NOVO' AND phone NOT IN (SELECT phone FROM vendas_comparacao)
    AND phone IN (SELECT phone FROM messages WHERE created_at > ?) LIMIT ?`).all(desde, limite * 3) as any[];
  let gerados = 0, pulados = 0, erros = 0;
  for (const s of sessoes) {
    if (gerados >= limite) break;
    if (await tetoEstourado()) break;
    const msgs = db.prepare('SELECT role, body, created_at FROM messages WHERE phone = ? ORDER BY created_at').all(s.phone) as any[];
    // Último ponto em que o lead falou e alguém do escritório respondeu em seguida
    let idx = -1;
    for (let i = msgs.length - 2; i >= 0; i--) if (msgs[i].role === 'client' && msgs[i + 1].role !== 'client') { idx = i; break; }
    if (idx < 0) { pulados++; continue; }
    try {
      const hist = msgs.slice(Math.max(0, idx - 20), idx).map(m => ({ role: m.role, body: m.body }));
      const rv = await redigirVendas(s.phone, msgs[idx].body, hist);
      if (!rv) { erros++; continue; }
      db.prepare(`INSERT INTO vendas_comparacao (phone, nome, mensagem_cliente, resposta_real, quem_respondeu, rascunho_iara, produto, regra, etapa_sugerida, momento)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(s.phone, s.name, msgs[idx].body, msgs[idx + 1].body, msgs[idx + 1].role === 'iara' ? 'Iara' : 'Dr. Wesley',
        rv.mensagem, rv.produto, rv.regra, rv.etapaSugerida, msgs[idx].created_at);
      gerados++;
    } catch (err) { erros++; console.error('[vendas] reprocessar', s.phone, (err as Error).message); }
  }
  return { gerados, pulados, erros };
}

export function listarComparacoes(limite = 50) {
  garantirTabela();
  return getDb().prepare('SELECT * FROM vendas_comparacao ORDER BY criado_em DESC LIMIT ?').all(limite);
}
